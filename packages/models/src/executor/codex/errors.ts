/**
 * Codex upstream error classification.
 *
 * Go source: internal/runtime/executor/codex_executor_terminal.go (newCodexStatusErrWithCooling,
 * classifyCodexStatusError, codexStatusErrorClassification, isCodexModelCapacityError, isCodexUsageLimitError,
 * parseCodexRetryAfter, codexTerminalFailureBody/Status/Err, codexTerminalStreamErrShouldHandle and the
 * incomplete-stream errors).
 */
import {
  asInt,
  asString,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { statusText } from "../../http/status.ts";
import { ExecutionError } from "../errors.ts";
import {
  annotateImageGenerationError,
  statusFromErrorTypeAndCode,
} from "../../http/upstream-error.ts";

export const CODEX_INCOMPLETE_STREAM_MESSAGE =
  "stream error: stream disconnected before completion: stream closed before response.completed";

export const CODEX_EMPTY_INCOMPLETE_STREAM_MESSAGE =
  "stream error: upstream terminated with incomplete empty response (0 tokens)";

/** 408: the stream ended before `response.completed` (request scoped). */
export const codexIncompleteStreamError = (): ExecutionError =>
  new ExecutionError({
    status: 408,
    message: CODEX_INCOMPLETE_STREAM_MESSAGE,
    requestScoped: true,
  });

/** 502: `response.incomplete` without any output (request scoped). */
export const codexEmptyIncompleteStreamError = (): ExecutionError =>
  new ExecutionError({
    status: 502,
    message: CODEX_EMPTY_INCOMPLETE_STREAM_MESSAGE,
    requestScoped: true,
  });

/** 502 for an upstream that closed without sending anything. */
export const codexClosedBeforeFirstPayloadError = (): ExecutionError =>
  new ExecutionError({ status: 502, message: "upstream stream closed before first payload" });

const str = (body: Json | undefined, path: string): string => asString(get(body, path)).trim();

/** `isCodexModelCapacityError`. */
export const isCodexModelCapacityError = (bodyText: string): boolean => {
  if (bodyText === "") return false;
  const parsed = tryParseJson(bodyText);

  for (const candidate of [
    asString(get(parsed, "error.message")),
    asString(get(parsed, "message")),
    bodyText,
  ]) {
    const lower = candidate.trim().toLowerCase();

    if (lower === "") continue;

    if (
      lower.includes("model is at capacity") ||
      lower.includes("model_at_capacity") ||
      lower.includes("model_is_at_capacity") ||
      (lower.includes("model") && lower.includes("at capacity"))
    ) {
      return true;
    }
  }

  return false;
};

/** `isCodexUsageLimitError`: `error.type` (or `type`) is `usage_limit_reached`. */
export const isCodexUsageLimitError = (bodyText: string): boolean => {
  if (bodyText === "") return false;
  const parsed = tryParseJson(bodyText);

  return [get(parsed, "error.type"), get(parsed, "type")].some(
    (candidate) => asString(candidate).trim().toLowerCase() === "usage_limit_reached",
  );
};

/** `parseCodexRetryAfter`: `resets_at`/`resets_in_seconds` of a 429 `usage_limit_reached` body, in ms. */
export const parseCodexRetryAfterMs = (
  status: number,
  bodyText: string,
  nowMs: number,
): number | undefined => {
  if (status !== 429 || bodyText === "") return undefined;
  const parsed = tryParseJson(bodyText);

  for (const quota of [get(parsed, "error"), parsed]) {
    if (asString(get(quota, "type")).trim().toLowerCase() !== "usage_limit_reached") continue;
    const resetsAt = asInt(get(quota, "resets_at"));

    if (resetsAt > 0 && resetsAt * 1000 > nowMs) return resetsAt * 1000 - nowMs;
    const resetsIn = asInt(get(quota, "resets_in_seconds"));

    if (resetsIn > 0) return resetsIn * 1000;
  }

  return undefined;
};

interface Classification {
  readonly code: string;
  readonly type: string;
}

/** `codexStatusErrorClassification`. */
export const codexStatusErrorClassification = (
  status: number,
  bodyText: string,
): Classification | undefined => {
  const parsed = tryParseJson(bodyText);
  let errorMessage = str(parsed, "error.message").toLowerCase();

  if (errorMessage === "") errorMessage = str(parsed, "message").toLowerCase();
  const lower = bodyText.trim().toLowerCase();
  const upstreamCode = str(parsed, "error.code").toLowerCase();
  const upstreamType = str(parsed, "error.type").toLowerCase();
  const isInvalidRequest = upstreamType === "" || upstreamType === "invalid_request_error";

  if (
    status === 413 ||
    upstreamCode === "context_length_exceeded" ||
    upstreamCode === "context_too_large" ||
    (isInvalidRequest &&
      (errorMessage.includes("context length") ||
        errorMessage.includes("context_length") ||
        errorMessage.includes("maximum context") ||
        errorMessage.includes("too many tokens")))
  ) {
    return { code: "context_too_large", type: "invalid_request_error" };
  }

  if (
    lower.includes("invalid signature in thinking block") ||
    lower.includes("invalid_encrypted_content")
  ) {
    return { code: "thinking_signature_invalid", type: "invalid_request_error" };
  }

  if (
    upstreamCode === "previous_response_not_found" ||
    lower.includes("previous_response_not_found") ||
    (lower.includes("previous_response_id") && lower.includes("not found"))
  ) {
    return { code: "previous_response_not_found", type: "invalid_request_error" };
  }

  if (
    status === 401 ||
    upstreamType === "authentication_error" ||
    upstreamCode === "invalid_api_key" ||
    lower.includes("invalid or expired token") ||
    lower.includes("refresh_token_reused")
  ) {
    return { code: "auth_unavailable", type: "authentication_error" };
  }

  return undefined;
};

/** `classifyCodexStatusError`: well-known failures are rewritten to `{"error":{message,type,code}}`. */
export const classifyCodexStatusError = (status: number, bodyText: string): string => {
  const classification = codexStatusErrorClassification(status, bodyText);

  if (classification === undefined) return bodyText;
  const parsed = tryParseJson(bodyText);
  let message = asString(get(parsed, "error.message"));

  if (message === "") message = asString(get(parsed, "message"));

  if (message === "") message = bodyText.trim();

  if (message === "") message = statusText(status);

  return JSON.stringify({
    error: { message, type: classification.type, code: classification.code },
  });
};

/** `newCodexStatusErrWithCooling`. `headers` are the upstream response headers (exposed with passthrough-headers). */
export const newCodexStatusError = (
  status: number,
  bodyText: string,
  options: {
    readonly modelLevelCooling: boolean;
    readonly nowMs: number;
    readonly headers?: Record<string, string>;
  },
): ExecutionError => {
  let code = status;
  const isUsageLimit = isCodexUsageLimitError(bodyText);
  const credentialScoped = isUsageLimit && !options.modelLevelCooling;

  if (isCodexModelCapacityError(bodyText) || isUsageLimit) code = 429;
  const body = classifyCodexStatusError(code, bodyText);
  const retryAfterMs = parseCodexRetryAfterMs(code, body, options.nowMs);

  return new ExecutionError({
    status: code,
    message: body,
    ...(credentialScoped ? { credentialScoped: true } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Terminal failures delivered inside the stream
// ---------------------------------------------------------------------------------------------------------------

const terminalErrorBody = (event: Json | undefined, path: string): JsonObject | undefined => {
  const errorResult = get(event, path);

  if (errorResult === undefined) return undefined;
  let body: Json = { error: {} };

  if (typeof errorResult === "object" && errorResult !== null) {
    body = set(body, "error", errorResult);
  } else {
    const message = asString(errorResult).trim();

    if (message !== "") body = set(body, "error.message", message);
  }

  if (str(body, "error.message") === "") {
    const message = str(event, "response.error.message");

    if (message !== "") body = set(body, "error.message", message);
  }

  if (str(body, "error.message") === "") {
    const code = str(body, "error.code");

    if (code !== "") body = set(body, "error.message", code);
  }

  if (str(body, "error.message") === "") {
    const type = str(body, "error.type");

    if (type !== "") body = set(body, "error.message", type);
  }

  const annotated = annotateImageGenerationError(get(body, "error"));

  if (annotated !== undefined) body = set(body, "error.message", annotated);

  return isJsonObject(body) ? body : undefined;
};

const terminalTopLevelErrorBody = (event: Json | undefined): JsonObject | undefined => {
  const message = str(event, "message");
  const code = str(event, "code");
  const type = str(event, "error_type");
  const param = str(event, "param");

  if (message === "" && code === "" && type === "" && param === "") return undefined;
  let body: Json = { error: {} };

  if (message !== "") body = set(body, "error.message", message);

  if (code !== "") body = set(body, "error.code", code);

  if (type !== "") body = set(body, "error.type", type);

  if (param !== "") body = set(body, "error.param", param);

  if (str(body, "error.message") === "") {
    if (code !== "") body = set(body, "error.message", code);
    else if (type !== "") body = set(body, "error.message", type);
  }

  return isJsonObject(body) ? body : undefined;
};

/** `codexTerminalFailureBody`: the normalised body of an `error` / `response.failed` event. */
export const codexTerminalFailureBody = (event: Json | undefined): JsonObject | undefined => {
  let body: JsonObject | undefined;

  switch (asString(get(event, "type"))) {
    case "error":
      body = terminalErrorBody(event, "error") ?? terminalTopLevelErrorBody(event);
      break;
    case "response.failed":
      body = terminalErrorBody(event, "response.error") ?? terminalErrorBody(event, "error");
      break;
    default:
      return undefined;
  }

  body ??= { error: { message: "upstream stream failed without error details" } };
  const sequence = get(event, "sequence_number");

  if (sequence !== undefined) set(body, "sequence_number", asInt(sequence));

  return body;
};

/** `codexTerminalFailureStatus`. */
const terminalFailureStatus = (body: Json): number => {
  for (const path of ["error.status_code", "error.status"]) {
    const status = asInt(get(body, path));

    if (status >= 400 && status <= 599) return status;
  }

  const type = str(body, "error.type").toLowerCase();
  const code = str(body, "error.code").toLowerCase();

  return statusFromErrorTypeAndCode(type, code);
};

const errorIsContextLength = (body: Json): boolean => {
  const code = str(body, "error.code").toLowerCase();
  const message = str(body, "error.message").toLowerCase();

  return (
    code === "context_length_exceeded" ||
    code === "context_too_large" ||
    message.includes("context window") ||
    message.includes("context length") ||
    message.includes("too many tokens")
  );
};

const streamErrShouldHandle = (body: Json): boolean => {
  if (errorIsContextLength(body)) return true;
  const text = JSON.stringify(body);

  if (isCodexUsageLimitError(text) || isCodexModelCapacityError(text)) return true;

  return codexStatusErrorClassification(400, text)?.code === "thinking_signature_invalid";
};

export interface CodexTerminalFailure {
  readonly error: ExecutionError;
  /** The normalised failure body. */
  readonly body: string;
}

/** `codexTerminalFailureErrWithCooling`: the error for an `error`/`response.failed` event, if it is one. */
export const codexTerminalFailure = (
  event: Json | undefined,
  options: { readonly modelLevelCooling: boolean; readonly nowMs: number },
): CodexTerminalFailure | undefined => {
  const body = codexTerminalFailureBody(event);

  if (body === undefined) return undefined;
  const text = JSON.stringify(body);
  const status = streamErrShouldHandle(body) ? 400 : terminalFailureStatus(body);

  return { error: newCodexStatusError(status, text, options), body: text };
};

/** True when the failure body asks to clear the reasoning replay cache. */
export const isThinkingSignatureInvalid = (status: number, bodyText: string): boolean =>
  codexStatusErrorClassification(status, bodyText)?.code === "thinking_signature_invalid";

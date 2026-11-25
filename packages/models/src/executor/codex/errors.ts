/**
 * Codex upstream error classification.
 *
 * Go source: internal/runtime/executor/codex_executor_terminal.go (newCodexStatusErrWithCooling,
 * classifyCodexStatusError, codexStatusErrorClassification, isCodexModelCapacityError, isCodexUsageLimitError,
 * parseCodexRetryAfter, codexTerminalFailureBody/Status/Err, codexTerminalStreamErrShouldHandle and the
 * incomplete-stream errors; isCodexTurnRateLimitError, codexErrorCodeOf and isCodexTransientCapacityError of
 * CLIProxyAPI 9a35fa12).
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
import { ErrorCode } from "../../credentials/cooldown/classify.ts";
import { ExecutionError } from "../errors.ts";
import { parseRetryAfterMs } from "../helps/retry-after.ts";
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

/** The trimmed string at each of `paths` (the layouts the Codex upstream uses; blank when absent). */
const trimmedValuesAt = (parsed: Json | undefined, paths: readonly string[]): string[] =>
  paths.map((path) => str(parsed, path));

/**
 * `isCodexTurnRateLimitError`: the per-turn admission rejection (the upstream is at capacity for this turn while the
 * credential quota is not exhausted). The stable signal is the `turn_rate_limit_exceeded` code; with no code at all, a
 * `rate_limit_error` whose message says "at capacity" is accepted. A generic `rate_limit_exceeded` is not.
 */
export const isCodexTurnRateLimitError = (bodyText: string): boolean => {
  if (bodyText === "") return false;
  const parsed = tryParseJson(bodyText);

  const codes = trimmedValuesAt(parsed, ["error.code", "code", "body.error.code"]).filter(
    (c) => c !== "",
  );

  if (codes.some((code) => code.toLowerCase() === "turn_rate_limit_exceeded")) return true;

  if (codes.length > 0) return false;

  const rateLimitTyped = trimmedValuesAt(parsed, ["error.type", "type", "body.error.type"]).some(
    (type) => type.toLowerCase() === "rate_limit_error",
  );

  if (!rateLimitTyped) return false;

  return trimmedValuesAt(parsed, ["error.message", "message", "body.error.message"]).some(
    (message) => message.toLowerCase().includes("at capacity"),
  );
};

/**
 * `isCodexTransientCapacityError`: every capacity rejection that is transient and model scoped (the model-at-capacity
 * wording and the per-turn admission rejection). An explicit other error code keeps its handling.
 */
export const isCodexTransientCapacityError = (bodyText: string): boolean => {
  const code = trimmedValuesAt(tryParseJson(bodyText), [
    "error.code",
    "code",
    "body.error.code",
  ]).find((candidate) => candidate !== "");

  if (
    code !== undefined &&
    !["turn_rate_limit_exceeded", "model_at_capacity", "model_is_at_capacity"].includes(
      code.toLowerCase(),
    )
  ) {
    return false;
  }

  return isCodexModelCapacityError(bodyText) || isCodexTurnRateLimitError(bodyText);
};

/** `isCodexUsageLimitError`: `error.type` (or `type`, `body.error.type`) is `usage_limit_reached`. */
export const isCodexUsageLimitError = (bodyText: string): boolean => {
  if (bodyText === "") return false;
  const parsed = tryParseJson(bodyText);

  return [get(parsed, "error.type"), get(parsed, "type"), get(parsed, "body.error.type")].some(
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

  for (const quota of [get(parsed, "error"), parsed, get(parsed, "body.error")]) {
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

/** `shouldParseCodexRetryAfterHeader`: the statuses whose `Retry-After` header is a cooldown hint. */
export const shouldParseCodexRetryAfterHeader = (status: number): boolean =>
  status === 429 ||
  status === 408 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504 ||
  (status >= 520 && status <= 526);

const ERROR_HEADER_PATHS = [
  "headers",
  "body.headers",
  "error.headers",
  "body.error.headers",
  "response.error.headers",
] as const;

/**
 * `parseCodexWebsocketErrorHeaders`: the headers an error event carries, lowercased. The outer objects win (Go
 * 5a373ede): a name seen once shadows every nested value, even when its own value is blank or not a scalar.
 */
export const codexErrorEventHeaders = (
  event: Json | undefined,
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  const seen = new Set<string>();

  for (const path of ERROR_HEADER_PATHS) {
    const headers = get(event, path);

    if (!isJsonObject(headers)) continue;

    for (const [key, value] of Object.entries(headers)) {
      const name = key.trim().toLowerCase();

      if (name === "" || seen.has(name)) continue;
      seen.add(name);

      if (typeof value === "string" && value.trim() !== "") out[name] = value.trim();
      else if (typeof value === "number" || typeof value === "boolean") out[name] = String(value);
    }
  }

  return Object.keys(out).length === 0 ? undefined : out;
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
  const transientCapacity = !isUsageLimit && isCodexTransientCapacityError(bodyText);

  if (transientCapacity || isUsageLimit) code = 429;
  const body = classifyCodexStatusError(code, bodyText);

  // A usage_limit_reached body reset describes quota recovery and wins over the generic header; other 429s and the
  // recoverable transient statuses honour the upstream `Retry-After` so capacity rejections cool until their real
  // deadline (Go 7dd360d9).
  const retryAfterMs =
    parseCodexRetryAfterMs(code, body, options.nowMs) ??
    (shouldParseCodexRetryAfterHeader(code)
      ? parseRetryAfterMs(options.headers?.["retry-after"] ?? null, options.nowMs)
      : undefined);

  return new ExecutionError({
    status: code,
    message: body,
    ...(transientCapacity ? { code: ErrorCode.transientRateLimit } : {}),
    ...(credentialScoped ? { credentialScoped: true } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Terminal failures delivered inside the stream
// ---------------------------------------------------------------------------------------------------------------

/**
 * `CodexResponseEventType` (Go 20df0c25): the event's `type`, or `error` for an untyped envelope that carries an error
 * (`error`, `body.error` or `response.error` as an object or a non-blank string, or a top-level `code` and `message`).
 * An explicit type stays authoritative, so output and metadata events are never mistaken for failures.
 */
export const codexResponseEventType = (event: Json | undefined): string => {
  const type = asString(get(event, "type")).trim();

  if (type !== "" || !isJsonObject(event)) return type;

  for (const path of ["error", "body.error", "response.error"]) {
    const node = get(event, path);

    if (isJsonObject(node) || (typeof node === "string" && node.trim() !== "")) return "error";
  }

  return str(event, "code") !== "" && str(event, "message") !== "" ? "error" : "";
};

/** `codexPolicyFallbackMessage` (Go 1f76e479): the message of a policy block that names only its code. */
export const codexPolicyFallbackMessage = (code: string): string => {
  switch (code.trim().toLowerCase()) {
    case "bio_policy":
      return "This content was flagged for possible biological risk.";
    case "cyber_policy":
    case "cyber_policy_violation":
      return "This request has been flagged for possible cybersecurity risk.";
    case "misalignment_policy_violation":
      return "This request was blocked due to a misalignment policy violation.";
    case "invalid_prompt":
      return "Invalid request.";
    default:
      return code;
  }
};

const terminalErrorBody = (event: Json | undefined, path: string): JsonObject | undefined => {
  const errorResult = get(event, path);

  if (errorResult === undefined || errorResult === null) return undefined;
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

    if (code !== "") body = set(body, "error.message", codexPolicyFallbackMessage(code));
  }

  if (str(body, "error.message") === "") {
    const type = str(body, "error.type");

    if (type !== "") body = set(body, "error.message", type);
  }

  const annotated = annotateImageGenerationError(get(body, "error"));

  if (annotated !== undefined) body = set(body, "error.message", annotated);

  return isJsonObject(body) ? body : undefined;
};

/** `codexTerminalTopLevelErrorBody`: an error built from the event's top-level `message`/`code`/`error_type`/`param`. */
export const codexTopLevelErrorBody = (event: Json | undefined): JsonObject | undefined => {
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
    if (code !== "") body = set(body, "error.message", codexPolicyFallbackMessage(code));
    else if (type !== "") body = set(body, "error.message", type);
  }

  return isJsonObject(body) ? body : undefined;
};

/**
 * `codexTerminalFailureBody`: the normalised body of an `error` / `response.failed` event (an untyped error envelope
 * counts as `error`). The event's own HTTP status, when it carries one, is kept as `status` (Go 80e8350c).
 */
export const codexTerminalFailureBody = (event: Json | undefined): JsonObject | undefined => {
  const eventType = codexResponseEventType(event);
  let paths: readonly string[];

  switch (eventType) {
    case "error":
      paths = ["error", "body.error", "response.error"];
      break;
    case "response.failed":
      paths = ["response.error", "error", "body.error"];
      break;
    default:
      return undefined;
  }

  let body: JsonObject | undefined;

  for (const path of paths) {
    body = terminalErrorBody(event, path);

    if (body !== undefined) break;
  }

  if (body === undefined && eventType === "error") body = codexTopLevelErrorBody(event);
  body ??= { error: { message: "upstream stream failed without error details" } };

  for (const path of ["status_code", "status", "body.status_code", "body.status"]) {
    const status = asInt(get(event, path));

    if (status >= 400 && status <= 599) {
      set(body, "status", status);
      break;
    }
  }

  const sequence = get(event, "sequence_number");

  if (sequence !== undefined) set(body, "sequence_number", asInt(sequence));

  return body;
};

/** `codexTerminalFailureStatus`. */
export const codexTerminalFailureStatus = (body: Json): number => {
  for (const path of ["error.status_code", "error.status", "status_code", "status"]) {
    const status = asInt(get(body, path));

    if (status >= 400 && status <= 599) return status;
  }

  const type = str(body, "error.type").toLowerCase();
  const code = str(body, "error.code").toLowerCase();

  return statusFromErrorTypeAndCode(type, code);
};

export const codexErrorIsContextLength = (body: Json): boolean => {
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
  if (codexErrorIsContextLength(body)) return true;
  const text = JSON.stringify(body);

  if (isCodexUsageLimitError(text) || isCodexTransientCapacityError(text)) return true;

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
  const status = streamErrShouldHandle(body) ? 400 : codexTerminalFailureStatus(body);
  // The event's own headers (Retry-After on an overload) travel with the error (Go 7dd360d9, deacbf21).
  const headers = codexErrorEventHeaders(event);

  return {
    error: newCodexStatusError(status, text, {
      ...options,
      ...(headers !== undefined ? { headers } : {}),
    }),
    body: text,
  };
};

/** True when the failure body asks to clear the reasoning replay cache. */
export const isThinkingSignatureInvalid = (status: number, bodyText: string): boolean =>
  codexStatusErrorClassification(status, bodyText)?.code === "thinking_signature_invalid";

/**
 * xAI upstream error classification.
 *
 * Go source: internal/runtime/executor/xai_executor_response.go (xaiStatusErr, isXAIBadCredentialsBody,
 * xaiFreeUsageExhaustedCooldown), xai_executor_speech.go (xaiSpeechStatusErr, xaiSpeechModelUnavailable).
 *
 *  - 403 with a "bad credentials" body is an invalidated OAuth access token: remapped to 401 so the conductor's
 *    refresh-once-and-retry path runs instead of a payment cooldown (the upstream body is kept).
 *  - 429 with `free-usage-exhausted` / "included free usage" carries a 24 h cooldown hint.
 *  - Speech 404s that do not say the model is unavailable (e.g. an unknown voice id) are request-scoped.
 *  - A non-stream answer's terminal `error`/`response.failed` event (or a raw JSON error body) is an upstream error with
 *    a status mapped from its type and code (`xaiTerminalFailureErr`, Go 949b43b3; policy blocks are 400s, Go
 *    1f76e479); an empty or unclosed 2xx stream is a request-scoped 502.
 */
import {
  asString,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { isPolicyBlockCode } from "../../http/upstream-error.ts";
import { ExecutionError, withErrorFields } from "../errors.ts";

/** `xaiFreeUsageExhaustedCooldown`: the rolling free-tier window advertised by the chat proxy. */
export const XAI_FREE_USAGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** `isXAIBadCredentialsBody`. */
export const isBadCredentialsBody = (body: string): boolean => {
  const parsed = tryParseJson(body);

  for (const path of ["code", "error.code", "body.error.code"]) {
    if (asString(get(parsed, path)).toLowerCase().includes("bad-credentials")) return true;
  }

  for (const path of ["error", "error.message", "message", "body.error", "body.error.message"]) {
    if (asString(get(parsed, path)).toLowerCase().includes("access token could not be validated"))
      return true;
  }

  const raw = body.toLowerCase();

  return raw.includes("bad-credentials") || raw.includes("access token could not be validated");
};

/** `xaiStatusErr`. `headers` are the upstream response headers (exposed with `passthrough-headers`). */
export const xaiStatusError = (
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): ExecutionError => {
  const extra = headers === undefined ? {} : { headers: { ...headers } };

  if (body === "") return new ExecutionError({ status, message: body, ...extra });

  if (status === 403 && isBadCredentialsBody(body))
    return new ExecutionError({ status: 401, message: body, ...extra });

  if (status !== 429) return new ExecutionError({ status, message: body, ...extra });
  const parsed = tryParseJson(body);
  let code = asString(get(parsed, "code")).toLowerCase();

  if (code === "") code = asString(get(parsed, "error.code")).toLowerCase();
  let message = asString(get(parsed, "error.message")).toLowerCase();

  if (message === "") message = asString(get(parsed, "error")).toLowerCase();

  if (message === "") message = body.toLowerCase();

  const exhausted =
    code.includes("free-usage-exhausted") ||
    message.includes("free-usage-exhausted") ||
    message.includes("included free usage");

  return new ExecutionError({
    status,
    message: body,
    ...(exhausted ? { retryAfterMs: XAI_FREE_USAGE_COOLDOWN_MS } : {}),
    ...extra,
  });
};

const SPEECH_MODEL_UNAVAILABLE = [
  "model_not_found",
  "model_not_supported",
  "model is not supported",
  "model is unsupported",
  "model not supported",
  "unsupported model",
  "model is not available",
  "model not available",
  "model is unavailable",
  "model unavailable",
  "not available for your plan",
  "not available for your account",
];

const mentionsUnavailableModel = (text: string): boolean => {
  const lower = text.toLowerCase();

  return SPEECH_MODEL_UNAVAILABLE.some((pattern) => lower.includes(pattern));
};

/** `xaiSpeechModelUnavailable`: the body says the speech model itself is missing or unsupported. */
export const speechModelUnavailable = (body: string): boolean => {
  const parsed: Json | undefined = tryParseJson(body);

  if (parsed === undefined) return mentionsUnavailableModel(body);

  return [
    "code",
    "error.code",
    "type",
    "error.type",
    "error",
    "error.message",
    "message",
    "detail",
  ].some((path) => mentionsUnavailableModel(asString(get(parsed, path))));
};

/** `xaiSpeechStatusErr`. */
export const xaiSpeechStatusError = (
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): ExecutionError => {
  const error = xaiStatusError(status, body, headers);

  if (error.status === 404 && !speechModelUnavailable(body))
    return withErrorFields(error, { requestScoped: true });

  return error;
};

export const XAI_EMPTY_STREAM_MESSAGE = "xai stream error: empty upstream stream";

export const XAI_INCOMPLETE_STREAM_MESSAGE =
  "xai stream error: stream closed before response.completed or response.incomplete";

/** `newXAIEmptyStreamError` / `newXAIIncompleteStreamError`: a 2xx stream without a terminal event is the request's. */
export const xaiUnclosedStreamError = (empty: boolean): ExecutionError =>
  new ExecutionError({
    status: 502,
    message: empty ? XAI_EMPTY_STREAM_MESSAGE : XAI_INCOMPLETE_STREAM_MESSAGE,
    requestScoped: true,
  });

const trimmedAt = (value: Json | undefined, path: string): string =>
  asString(get(value, path)).trim();

/** The first non-empty trimmed string of `paths`. */
const firstAt = (value: Json | undefined, paths: ReadonlyArray<string>): string => {
  for (const path of paths) {
    const found = trimmedAt(value, path);

    if (found !== "") return found;
  }

  return "";
};

/** `xaiTerminalErrorDoc`: the `{error}` body of the error at `path`, `undefined` when it says nothing. */
const terminalErrorDoc = (event: Json, path: string): JsonObject | undefined => {
  const found = get(event, path);

  if (found === undefined || found === null) return undefined;
  const error: JsonObject = {};
  let hasField = false;

  if (isJsonObject(found)) {
    if (Object.keys(found).length > 0) {
      Object.assign(error, found);
      hasField = true;
    }
  } else if (!Array.isArray(found)) {
    const message = asString(found).trim();

    if (message !== "") {
      error["message"] = message;
      hasField = true;
    }
  }

  const fill = (field: string, paths: ReadonlyArray<string>): void => {
    if (trimmedAt(error, field) !== "") return;
    const value = firstAt(event, paths);

    if (value === "") return;
    error[field] = value;
    hasField = true;
  };

  fill("code", ["response.error.code", "code", "body.error.code"]);
  fill("type", ["response.error.type", "error_type", "body.error.type"]);
  fill("param", ["response.error.param", "param", "body.error.param"]);
  fill("message", ["response.error.message", "message", "body.error.message"]);

  if (trimmedAt(error, "message") === "") {
    const fallback = trimmedAt(error, "code") || trimmedAt(error, "type");

    if (fallback !== "") {
      error["message"] = fallback;
      hasField = true;
    }
  }

  return hasField ? { error } : undefined;
};

/** `xaiTerminalTopLevelErrorDoc`: a flat `{message, code, error_type, param}` error. */
const topLevelErrorDoc = (event: Json): JsonObject | undefined => {
  const message = trimmedAt(event, "message");
  const code = trimmedAt(event, "code");
  const type = trimmedAt(event, "error_type");
  const param = trimmedAt(event, "param");

  if (message === "" && code === "" && type === "" && param === "") return undefined;

  const error: JsonObject = { message: message || code || type };

  if (code !== "") error["code"] = code;

  if (type !== "") error["type"] = type;

  if (param !== "") error["param"] = param;

  return { error };
};

/** `xaiTerminalFailureDoc`: the error body of a terminal failure event, `undefined` for any other event. */
const terminalFailureDoc = (eventName: string, data: string): JsonObject | undefined => {
  const trimmed = data.trim();

  if (trimmed === "") return undefined;
  const event = tryParseJson(trimmed);

  if (event === undefined)
    return eventName.trim().toLowerCase() === "error" ? { error: { message: trimmed } } : undefined;
  let type = trimmedAt(event, "type");

  if (type === "") {
    const name = eventName.trim();
    const error = get(event, "error");

    if (name === "error" || name === "response.failed") type = name;
    else if (
      error !== undefined &&
      error !== null &&
      get(event, "output") === undefined &&
      (isJsonObject(error) || Array.isArray(error) || asString(error).trim() !== "")
    )
      type = "error";
  }

  let doc: JsonObject | undefined;

  if (type === "error")
    doc =
      terminalErrorDoc(event, "error") ??
      terminalErrorDoc(event, "body.error") ??
      topLevelErrorDoc(event);
  else if (type === "response.failed")
    doc = terminalErrorDoc(event, "response.error") ?? terminalErrorDoc(event, "error");
  else return undefined;

  doc ??= { error: { message: "upstream stream failed without error details" } };
  const seq = get(event, "sequence_number");

  // SAFETY: `typeof` tells a JSON number from the other JSON kinds (Go `Type == ojson.Number`).
  if (typeof seq === "number") doc["sequence_number"] = Math.trunc(seq);

  return doc;
};

/** An HTTP error status (400..599) read from a JSON number or numeric string. */
const httpStatusOf = (value: Json | undefined): number | undefined => {
  // SAFETY: `typeof` tells a JSON number from the other JSON kinds (Go `Type == ojson.Number`).
  const status = typeof value === "number" ? Math.trunc(value) : Number(asString(value).trim());

  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
};

const STATUS_PATHS = [
  "status",
  "status_code",
  "error.status",
  "error.status_code",
  "response.error.status",
  "response.error.status_code",
  "body.status",
  "body.error.status",
];

/** `xaiTerminalFailureStatus`: an explicit status, else one mapped from the error's type, code and message. */
const terminalFailureStatus = (event: Json | undefined, doc: JsonObject): number => {
  for (const path of STATUS_PATHS) {
    const value = get(event, path);

    if (value === undefined || value === null || isJsonObject(value) || Array.isArray(value))
      continue;
    const status = httpStatusOf(value);

    if (status !== undefined) return status;
  }

  const type = trimmedAt(doc, "error.type").toLowerCase();
  const code = trimmedAt(doc, "error.code").toLowerCase();
  const message = trimmedAt(doc, "error.message").toLowerCase();
  const codeStatus = code === "" ? undefined : httpStatusOf(code);

  if (codeStatus !== undefined) return codeStatus;

  if (
    type === "authentication_error" ||
    code === "invalid_api_key" ||
    code === "unauthorized" ||
    code.startsWith("unauthenticated") ||
    code.includes("bad-credentials") ||
    message.includes("access token could not be validated")
  )
    return 401;

  if (
    type === "permission_error" ||
    ["forbidden", "permission_denied", "permission-denied"].includes(code) ||
    code.startsWith("permission_denied:") ||
    code.startsWith("permission-denied:")
  )
    return 403;

  if (type === "not_found_error" || code === "not_found" || code === "model_not_found") return 404;

  if (
    type === "rate_limit_error" ||
    code === "rate_limit_exceeded" ||
    code === "rate_limit" ||
    ["free-usage-exhausted", "resource_exhausted", "resource-exhausted"].some((part) =>
      code.includes(part),
    ) ||
    message.includes("free-usage-exhausted") ||
    message.includes("included free usage")
  )
    return 429;

  if (
    isPolicyBlockCode(code) ||
    [
      "invalid_request_error",
      "invalid_request",
      "bad_request_error",
      "image_generation_user_error",
    ].includes(type) ||
    [
      "invalid_value",
      "invalid_request_error",
      "invalid_argument",
      "invalid-argument",
      "context_length_exceeded",
      "context_too_large",
    ].includes(code)
  )
    return 400;

  if (
    type === "service_unavailable_error" ||
    code === "server_is_overloaded" ||
    code === "service_unavailable"
  )
    return 503;

  return 502;
};

/**
 * `xaiTerminalFailureErr`: a terminal `error`/`response.failed` event (named by its `type` or the SSE `event:` name, or
 * a typeless object with an `error` and no `output`) as an upstream error; `undefined` for any other event.
 */
export const xaiTerminalFailureError = (
  eventName: string,
  data: string,
): ExecutionError | undefined => {
  const doc = terminalFailureDoc(eventName, data);

  if (doc === undefined) return undefined;

  return xaiStatusError(terminalFailureStatus(tryParseJson(data.trim()), doc), JSON.stringify(doc));
};

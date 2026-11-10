/**
 * Error bodies per client protocol.
 *
 * Go source: sdk/api/handlers/handlers.go (BuildErrorResponseBodyWithError, ErrorResponse),
 * sdk/api/handlers/claude/code_handlers.go (toClaudeError, claudeErrorDetailFromText, claudeErrorTypeFromStatus),
 * internal/clienterror/client_error.go (IsClaudeThreadNotFound), sdk/api/handlers/openai_responses_stream_error.go
 * (BuildOpenAIResponsesStreamErrorChunk, BuildOpenAIResponsesStreamFailedChunk).
 *
 * Gemini and Interactions handlers reuse the OpenAI-shaped body.
 */
import {
  compactJson,
  isValidJson,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";
import { statusText } from "./status.ts";
import { formatDurationSeconds } from "../credentials/selection/failures.ts";

type JsonRecord = JsonObject;

const parseObject = (text: string): JsonRecord | undefined => {
  try {
    const value: Json = JSON.parse(text);

    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const asRecord = (value: Json | undefined): JsonRecord | undefined =>
  isJsonObject(value) ? value : undefined;

const nonBlank = (value: Json | undefined): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

// --- OpenAI-compatible ------------------------------------------------------------------------------------------

export interface OpenAIErrorOptions {
  /** The upstream OAuth credential is permanently invalid (`coreauth.IsTerminalAuthError`). */
  readonly terminalAuth?: boolean;
}

interface OpenAIErrorClass {
  readonly type: string;
  readonly code?: string;
}

const openAIErrorClass = (status: number): OpenAIErrorClass => {
  switch (status) {
    case 401:
      return { type: "authentication_error", code: "invalid_api_key" };
    case 403:
      return { type: "permission_error", code: "insufficient_quota" };
    case 429:
      return { type: "rate_limit_error", code: "rate_limit_exceeded" };
    case 404:
      return { type: "invalid_request_error", code: "model_not_found" };
    case 408:
      return { type: "server_error", code: "request_timeout" };
    default:
      return status >= 500
        ? { type: "server_error", code: "internal_server_error" }
        : { type: "invalid_request_error" };
  }
};

/**
 * `BuildErrorResponseBodyWithError`: JSON error text (e.g. an upstream error body) is passed through compacted;
 * plain text is wrapped as `{"error":{"message","type","code"}}` with type/code derived from the status.
 */
export const openAIErrorBody = (
  status: number,
  text: string,
  options: OpenAIErrorOptions = {},
): string => {
  const effectiveStatus = status <= 0 ? 500 : status;
  const errText = text.trim() === "" ? statusText(effectiveStatus) : text;
  const trimmed = errText.trim();

  if (options.terminalAuth === true) {
    let message = errText;
    const parsed = trimmed !== "" ? parseObject(trimmed) : undefined;

    if (parsed !== undefined) {
      const direct = nonBlank(parsed["message"]);
      const nested = nonBlank(asRecord(parsed["error"])?.["message"]);
      message = direct ?? nested ?? message;
    }

    return JSON.stringify({
      error: {
        message,
        type: "authentication_error",
        code: "upstream_authentication_required",
        retryable: false,
      },
    });
  }

  if (trimmed !== "" && isValidJson(trimmed)) return compactJson(trimmed);

  const { type, code } = openAIErrorClass(effectiveStatus);

  return JSON.stringify({
    error: { message: errText, type, ...(code !== undefined ? { code } : {}) },
  });
};

/** Handler-level body read/parse failure: `400 {"error":{"message":"Invalid request: <err>","type":"invalid_request_error"}}`. */
export const invalidRequestBody = (message: string): string =>
  JSON.stringify({
    error: { message: `Invalid request: ${message}`, type: "invalid_request_error" },
  });

// --- Claude -------------------------------------------------------------------------------------------------------

export const claudeErrorTypeFromStatus = (status: number): string => {
  switch (status) {
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 408:
    case 504:
      return "timeout_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
};

export interface ClaudeErrorDetail {
  readonly type: string;
  readonly message: string;
}

/** `claudeErrorDetailFromText`: JSON error text may override the derived type and message. */
export const claudeErrorDetailFromText = (status: number, text: string): ClaudeErrorDetail => {
  let message = text.trim() === "" ? statusText(status) : text.trim();
  let type = claudeErrorTypeFromStatus(status);
  const payload = parseObject(message);

  if (payload !== undefined) {
    const error = asRecord(payload["error"]);

    if (error !== undefined) {
      const t = nonBlank(error["type"]);

      if (t !== undefined) type = t.trim();
      const m = nonBlank(error["message"]) ?? nonBlank(error["code"]);

      if (m !== undefined) message = m.trim();
    } else {
      const t = nonBlank(payload["type"]);

      if (t !== undefined && t.trim() !== "error") type = t.trim();
      const m = nonBlank(payload["message"]);

      if (m !== undefined) message = m.trim();
    }
  }

  return { type, message };
};

/** `clienterror.IsClaudeThreadNotFound`. */
export const isClaudeThreadNotFound = (status: number, text: string): boolean => {
  if (status !== 404) return false;
  const body = text.trim();

  if (body === "") return false;

  if (isValidJson(body)) {
    const error = asRecord(parseObject(body)?.["error"]);
    const message = typeof error?.["message"] === "string" ? error["message"].toLowerCase() : "";

    return (
      typeof error?.["type"] === "string" &&
      error["type"].trim().toLowerCase() === "not_found_error" &&
      message.includes("thread state") &&
      message.includes("previous_message_id")
    );
  }

  const lower = body.toLowerCase();

  return lower.includes("thread state") && lower.includes("previous_message_id");
};

/**
 * `toClaudeError`'s Retry-After for a model-cooldown 429: the trusted `Retry-After` of the cooldown error (Go reads it
 * from the safe headers), `undefined` for every other error.
 */
export const claudeCooldownRetryAfter = (error: {
  readonly status: number;
  readonly code?: string | undefined;
  readonly safeHeaders?: Readonly<Record<string, string>> | undefined;
}): string | undefined =>
  error.status === 429 && error.code === "model_cooldown"
    ? (error.safeHeaders?.["retry-after"] ?? error.safeHeaders?.["Retry-After"])
    : undefined;

/** `reset after <Go duration>` for a positive whole-second Retry-After; huge values keep the raw seconds. */
const resetAfterHint = (retryAfter: string): string => {
  if (!/^[+]?\d+$/.test(retryAfter)) return "";
  const seconds = BigInt(retryAfter);

  if (seconds <= 0n) return "";

  return ` (reset after ${
    seconds <= 9223372036n ? formatDurationSeconds(Number(seconds)) : `${retryAfter}s`
  })`;
};

/**
 * Claude Messages error body: `{"type":"error","error":{"type","message"[,"details":{"error_code"}]}}`.
 * `cooldownRetryAfter` (from `claudeCooldownRetryAfter`) appends ` (reset after Ns)` to a model-cooldown message.
 */
export const claudeErrorBody = (
  status: number,
  text: string,
  cooldownRetryAfter?: string,
): string => {
  const effectiveStatus = status <= 0 ? 500 : status;
  const errText = text.trim() === "" ? statusText(effectiveStatus) : text;
  let detail = claudeErrorDetailFromText(effectiveStatus, errText);

  if (cooldownRetryAfter !== undefined && effectiveStatus === 429)
    detail = { ...detail, message: detail.message + resetAfterHint(cooldownRetryAfter) };

  return JSON.stringify({
    type: "error",
    error: {
      type: detail.type,
      message: detail.message,
      ...(isClaudeThreadNotFound(effectiveStatus, errText)
        ? { details: { error_code: "thread_not_found" } }
        : {}),
    },
  });
};

// --- OpenAI Responses (streaming) -------------------------------------------------------------------------------

interface ResponsesErrorClass {
  readonly code: string;
  readonly type: string;
}

const responsesErrorClass = (status: number): ResponsesErrorClass => {
  switch (status) {
    case 401:
      return { code: "invalid_api_key", type: "invalid_request_error" };
    case 403:
      return { code: "insufficient_quota", type: "invalid_request_error" };
    case 429:
      return { code: "rate_limit_exceeded", type: "invalid_request_error" };
    case 404:
      return { code: "model_not_found", type: "invalid_request_error" };
    case 408:
      return { code: "request_timeout", type: "server_error" };
    default:
      if (status >= 500) return { code: "internal_server_error", type: "server_error" };

      if (status >= 400) return { code: "invalid_request_error", type: "invalid_request_error" };

      return { code: "unknown_error", type: "invalid_request_error" };
  }
};

const responsesErrorDetail = (
  status: number,
  errText: string,
  initialCode: string,
  initialMessage: string,
) => {
  let code = initialCode;
  let message = initialMessage;
  const trimmed = errText.trim();
  const payload = trimmed !== "" ? parseObject(trimmed) : undefined;

  if (payload !== undefined) {
    const error = asRecord(payload["error"]);

    if (error !== undefined) return error;
    const responseError = asRecord(asRecord(payload["response"])?.["error"]);

    if (responseError !== undefined) return responseError;
    const m = nonBlank(payload["message"]);

    if (m !== undefined) message = m.trim();
    const c = payload["code"];

    if (c !== undefined && c !== null)
      code =
        typeof c === "string" && c.trim() !== ""
          ? c.trim()
          : (typeof c === "object" ? JSON.stringify(c) : String(c)).trim();
  }

  const detail: JsonObject = { type: responsesErrorClass(status).type, code, message, param: null };

  if (payload !== undefined) {
    const t = nonBlank(payload["type"]);

    if (t !== undefined && t.trim() !== "error") detail["type"] = t.trim();

    if (Object.hasOwn(payload, "param")) detail["param"] = payload["param"] ?? null;
  }

  return detail;
};

const responsesErrorParts = (status: number, errText: string, sequenceNumber: number) => {
  const effectiveStatus = status <= 0 ? 500 : status;
  let sequence = Math.max(sequenceNumber, 0);
  const message = errText.trim() === "" ? statusText(effectiveStatus) : errText.trim();
  const payload = errText.trim() !== "" ? parseObject(errText.trim()) : undefined;
  const seq = payload?.["sequence_number"];

  if (typeof seq === "number" && Number.isFinite(seq)) sequence = Math.trunc(seq);
  const code = responsesErrorClass(effectiveStatus).code;

  return { sequence, error: responsesErrorDetail(effectiveStatus, errText, code, message) };
};

/** `BuildOpenAIResponsesStreamErrorChunk`: `{"type":"error","error":{...},"sequence_number":N}`. */
export const responsesStreamErrorChunk = (
  status: number,
  errText: string,
  sequenceNumber: number,
): string => {
  const { sequence, error } = responsesErrorParts(status, errText, sequenceNumber);

  return `{"type":"error","error":${JSON.stringify(error)},"sequence_number":${sequence}}`;
};

/** `BuildOpenAIResponsesStreamFailedChunk`: `{"type":"response.failed","sequence_number":N,"response":{...}}`. */
export const responsesStreamFailedChunk = (
  status: number,
  errText: string,
  sequenceNumber: number,
): string => {
  const { sequence, error } = responsesErrorParts(status, errText, sequenceNumber);

  return `{"type":"response.failed","sequence_number":${sequence},"response":{"status":"failed","error":${JSON.stringify(error)}}}`;
};

/**
 * Retry delays of Google API 429 responses (Gemini, Vertex, Antigravity).
 *
 * Go source: internal/runtime/executor/helps/json_retry_helpers.go (`ParseGoogleRetryAfter`, `ParseRetryDelay`,
 * `parseGoogleStructuredRetryDelay`, `parsePositiveRetryAfterHeader`, `parseGoogleMessageRetryDelay`; Go ed1c23f9).
 * The hint comes from the google.rpc `RetryInfo.retryDelay` detail, else `ErrorInfo.metadata.quotaResetDelay`, else
 * (for the cooldown) the `Retry-After` header, else a duration in the message (`after 30s`, `retry in 1m30s`). The
 * body may be an error object or an array whose first element is one.
 */
import { asString, get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { parseGoDuration } from "../../config/accessors.ts";
import { parseRetryAfterMs } from "./retry-after.ts";

const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";

/** The google.rpc `ErrorInfo` detail type (its `reason` and `metadata.quotaResetDelay`). */
export const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";

const MESSAGE_RETRY_DURATION =
  /\b(?:after|retry\s+in)\s+(\d+(?:\.\d+)?(?:h|ms|m|s)(?:\d+(?:\.\d+)?(?:ms|m|s))*)\b/gi;

const validDelay = (delay: number | undefined, allowZero: boolean): delay is number =>
  delay !== undefined && (allowZero ? delay >= 0 : delay > 0);

const structuredRetryDelayMs = (root: Json | undefined, allowZero: boolean): number | undefined => {
  let details = get(root, "error.details");

  if (!isJsonArray(details)) details = get(root, "0.error.details");

  if (!isJsonArray(details)) return undefined;

  for (const [type, path] of [
    [RETRY_INFO, "retryDelay"],
    [ERROR_INFO, "metadata.quotaResetDelay"],
  ] as const) {
    for (const detail of details) {
      if (asString(get(detail, "@type")) !== type) continue;
      const raw = asString(get(detail, path)).trim();

      if (raw === "") continue;
      const delay = parseGoDuration(raw.toLowerCase());

      if (validDelay(delay, allowZero)) return delay;
    }
  }

  return undefined;
};

const messageRetryDelayMs = (root: Json | undefined, allowZero: boolean): number | undefined => {
  let message = asString(get(root, "error.message")).trim();

  if (message === "") message = asString(get(root, "0.error.message")).trim();

  if (message === "") return undefined;

  for (const match of message.matchAll(MESSAGE_RETRY_DURATION)) {
    const delay = match[1] === undefined ? undefined : parseGoDuration(match[1].toLowerCase());

    if (validDelay(delay, allowZero)) return delay;
  }

  return undefined;
};

/**
 * `ParseGoogleRetryAfter`: the positive cooldown hint in milliseconds of a Google 429 (structured details, then the
 * `Retry-After` header, then the message); `undefined` for other statuses or without a positive hint.
 */
export const parseGoogleRetryAfterMs = (
  status: number,
  headers: Headers,
  body: string,
  now: number,
): number | undefined => {
  if (status !== 429) return undefined;
  const root = body === "" ? undefined : tryParseJson(body);
  const structured = structuredRetryDelayMs(root, false);

  if (structured !== undefined) return structured;
  const header = parseRetryAfterMs(headers.get("retry-after"), now);

  if (validDelay(header, false)) return header;

  return messageRetryDelayMs(root, false);
};

/**
 * `ParseRetryDelay`: the retry delay in milliseconds of a Google 429 body (structured details, then the message),
 * keeping an explicit zero delay, which Antigravity's 429 decisions read as "retry now".
 */
export const parseGoogleRetryDelayMs = (body: string): number | undefined => {
  if (body === "") return undefined;
  const root = tryParseJson(body);

  return structuredRetryDelayMs(root, true) ?? messageRetryDelayMs(root, true);
};

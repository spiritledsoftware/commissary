/**
 * Antigravity upstream error handling: retry-delay parsing and the 429 decision table.
 *
 * Go source: internal/runtime/executor/helps/json_retry_helpers.go (`ParseRetryDelay`),
 * internal/runtime/executor/antigravity_executor_credits.go (`decideAntigravity429`, `newAntigravityStatusErr`,
 * `antigravityHasExplicitCreditsBalanceExhaustedReason`).
 */
import { asString, get, isJsonArray, tryParseJson } from "@commissary/json";
import { ExecutionError, headersRecord } from "../errors.ts";

export const INSTANT_RETRY_THRESHOLD_MS = 3_000;

export const SHORT_QUOTA_COOLDOWN_THRESHOLD_MS = 5 * 60_000;

const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";

const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";

const UNIT_MS = new Map([
  ["ns", 1e-6],
  ["us", 1e-3],
  ["µs", 1e-3],
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
]);

/** Go `time.ParseDuration` for the unit set Google emits (`3.500s`, `1h2m3s`, `300ms`); `undefined` when invalid. */
export const parseGoDuration = (text: string): number | undefined => {
  const value = text.trim();

  if (value === "" || value === "0") return value === "0" ? 0 : undefined;

  let rest = value;
  let sign = 1;

  if (rest[0] === "-" || rest[0] === "+") {
    if (rest[0] === "-") sign = -1;
    rest = rest.slice(1);
  }

  if (rest === "") return undefined;
  let total = 0;

  while (rest !== "") {
    const match = /^(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/.exec(rest);

    if (match === null) return undefined;
    const [, amount, unit] = match;
    const factor = unit === undefined ? undefined : UNIT_MS.get(unit);

    if (amount === undefined || factor === undefined) return undefined;
    total += Number.parseFloat(amount) * factor;
    rest = rest.slice(match[0].length);
  }

  return sign * total;
};

/** `ParseRetryDelay`: the retry delay in milliseconds of a Google API 429 body. */
export const parseRetryDelayMs = (body: string): number | undefined => {
  const root = tryParseJson(body);
  const details = get(root, "error.details");

  if (isJsonArray(details)) {
    for (const detail of details) {
      if (asString(get(detail, "@type")) !== RETRY_INFO) continue;
      const retryDelay = asString(get(detail, "retryDelay"));

      if (retryDelay === "") continue;

      return parseGoDuration(retryDelay);
    }

    for (const detail of details) {
      if (asString(get(detail, "@type")) !== ERROR_INFO) continue;
      const quotaResetDelay = asString(get(detail, "metadata.quotaResetDelay"));

      if (quotaResetDelay === "") continue;
      const parsed = parseGoDuration(quotaResetDelay);

      if (parsed !== undefined) return parsed;
    }
  }

  const message = asString(get(root, "error.message"));

  if (message !== "") {
    const seconds = /after\s+(\d+)s\.?/.exec(message);

    if (seconds?.[1] !== undefined) return Number.parseInt(seconds[1], 10) * 1000;
    const human = /after\s+((?:\d+h)?(?:\d+m)?(?:\d+s)?)\.?/.exec(message.toLowerCase());

    if (human !== null && human[1] !== undefined && human[1] !== "") {
      const parsed = parseGoDuration(human[1]);

      if (parsed !== undefined && parsed > 0) return parsed;
    }
  }

  return undefined;
};

export type Antigravity429Kind =
  | "soft_retry"
  | "instant_retry_same_auth"
  | "short_cooldown_switch_auth"
  | "full_quota_exhausted";

export interface Antigravity429Decision {
  readonly kind: Antigravity429Kind;
  readonly retryAfterMs?: number;
  readonly reason: string;
}

/** `decideAntigravity429`. */
export const decideAntigravity429 = (body: string): Antigravity429Decision => {
  if (body === "") return { kind: "soft_retry", reason: "" };
  const retryAfterMs = parseRetryDelayMs(body);

  const withDelay = (kind: Antigravity429Kind, reason: string): Antigravity429Decision =>
    retryAfterMs === undefined ? { kind, reason } : { kind, retryAfterMs, reason };

  const root = tryParseJson(body);

  if (asString(get(root, "error.status")).trim().toUpperCase() !== "RESOURCE_EXHAUSTED")
    return withDelay("soft_retry", "");
  let reason = "";
  const details = get(root, "error.details");

  if (isJsonArray(details)) {
    for (const detail of details) {
      if (asString(get(detail, "@type")) !== ERROR_INFO) continue;
      reason = asString(get(detail, "reason")).trim();
      const upper = reason.toUpperCase();

      if (upper === "QUOTA_EXHAUSTED" || upper === "INSUFFICIENT_G1_CREDITS_BALANCE")
        return withDelay("full_quota_exhausted", reason);

      if (upper === "RATE_LIMIT_EXCEEDED") {
        if (retryAfterMs === undefined) return withDelay("soft_retry", reason);

        if (retryAfterMs < INSTANT_RETRY_THRESHOLD_MS)
          return withDelay("instant_retry_same_auth", reason);

        if (retryAfterMs < SHORT_QUOTA_COOLDOWN_THRESHOLD_MS)
          return withDelay("short_cooldown_switch_auth", reason);

        return withDelay("full_quota_exhausted", reason);
      }
    }
  }

  const lower = body.toLowerCase();

  if (lower.includes("quota_exhausted") || lower.includes("quota exhausted")) {
    return withDelay("full_quota_exhausted", "quota_exhausted");
  }

  return withDelay("soft_retry", reason);
};

/** `antigravityHasExplicitCreditsBalanceExhaustedReason`. */
export const hasExplicitCreditsBalanceExhaustedReason = (body: string): boolean => {
  const details = get(tryParseJson(body), "error.details");

  if (!isJsonArray(details)) return false;

  return details.some(
    (detail) =>
      asString(get(detail, "@type")) === ERROR_INFO &&
      asString(get(detail, "reason")).trim().toUpperCase() === "INSUFFICIENT_G1_CREDITS_BALANCE",
  );
};

/** `newAntigravityStatusErr`: the upstream body verbatim; a 429 carries its retry delay. */
export const antigravityStatusError = (
  status: number,
  body: string,
  headers: Headers,
): ExecutionError => {
  const retryAfterMs = status === 429 ? parseRetryDelayMs(body) : undefined;

  return new ExecutionError({
    status,
    message: body,
    headers: headersRecord(headers),
    ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { retryAfterMs } : {}),
    // A rejected credential is credential-scoped: the conductor refreshes it or rotates.
    ...(status === 401 ? { credentialScoped: true } : {}),
  });
};

/** Whether a 400 body points at a rejected thought signature (`clearAntigravityReasoningReplayOnInvalidSignature`). */
export const isInvalidSignatureBody = (status: number, body: string): boolean => {
  if (status !== 400) return false;
  const lower = body.toLowerCase();

  return (
    lower.includes("thoughtsignature") ||
    lower.includes("thought_signature") ||
    lower.includes("signature")
  );
};

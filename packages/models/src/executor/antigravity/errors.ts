/**
 * Antigravity upstream error handling: the 429 decision table, on the retry delays of `helps/google-retry.ts`.
 *
 * Go source: internal/runtime/executor/antigravity_executor_credits.go (`decideAntigravity429WithHeaders`,
 * `newAntigravityStatusErrWithHeaders`,
 * `antigravityHasExplicitCreditsBalanceExhaustedReason`).
 */
import { asString, get, isJsonArray, tryParseJson } from "@commissary/json";
import { ExecutionError, headersRecord } from "../errors.ts";
import { ERROR_INFO, parseGoogleRetryDelayWithHeadersMs } from "../helps/google-retry.ts";

export const INSTANT_RETRY_THRESHOLD_MS = 3_000;

export const SHORT_QUOTA_COOLDOWN_THRESHOLD_MS = 5 * 60_000;

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

/**
 * The 429 decision table: the retry delay comes from the body, else the `Retry-After` header (CLIProxyAPI 84b838e1; a
 * mid-stream error frame has no headers). `now` is the caller's clock reading, for an HTTP-date header.
 */
export const decideAntigravity429 = (
  body: string,
  headers: Headers | undefined,
  now: number,
): Antigravity429Decision => {
  const retryAfterMs = parseGoogleRetryDelayWithHeadersMs(headers, body, now);

  if (body === "")
    return retryAfterMs === undefined
      ? { kind: "soft_retry", reason: "" }
      : { kind: "soft_retry", retryAfterMs, reason: "" };

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

/**
 * `newAntigravityStatusErrWithHeaders`: the upstream body verbatim; a 429 or a 503 capacity error carries its retry
 * delay, from the body or the `Retry-After` header (CLIProxyAPI 84b838e1, ae3d80f7).
 */
export const antigravityStatusError = (
  status: number,
  body: string,
  headers: Headers,
  now: number,
): ExecutionError => {
  const retryAfterMs =
    status === 429 || status === 503
      ? parseGoogleRetryDelayWithHeadersMs(headers, body, now)
      : undefined;

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

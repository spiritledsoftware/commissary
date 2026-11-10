/**
 * Devin account-wide usage quota exhaustion.
 *
 * Go source: internal/runtime/executor/helps/devin_quota.go (`DevinUsageQuotaExhaustionPeriod`, `DevinQuotaRetryAfter`),
 * internal/runtime/executor/devin_executor.go (`devinQuotaScopedStatusError`). A 429 that says the daily or weekly usage
 * quota is exhausted covers every model of the account: it is credential-scoped, and when the credential's status
 * refresh (`credentials/devin-status.ts`) observed the window's reset time, the retry waits for it.
 */
import { ExecutionError, withErrorFields } from "../errors.ts";

export type DevinQuotaPeriod = "daily" | "weekly";

/**
 * A reset further away than this is implausible for a daily or weekly window (a weekly window plus slack covers a
 * just-rolled-over observation) and must not pin the credential.
 */
const QUOTA_RESET_MAX_DELAY_MS = 8 * 24 * 3_600_000;

/**
 * Whether an upstream error message explicitly says the account-wide daily or weekly usage quota is exhausted. The
 * match is narrow on purpose: the period word, "quota" and "exhausted" must all appear, so monthly ACU messages, generic
 * rate limits and transient capacity errors stay on the short per-model backoff. A message naming both periods is
 * weekly, the longer window.
 */
export const devinUsageQuotaExhaustionPeriod = (message: string): DevinQuotaPeriod | undefined => {
  const lower = message.toLowerCase();

  if (!lower.includes("quota") || !lower.includes("exhausted")) return undefined;

  if (lower.includes("weekly")) return "weekly";

  if (lower.includes("daily")) return "daily";

  return undefined;
};

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The delay until an observed quota reset time (`Quota.Signals`, RFC 3339), or `undefined` unless it parses and lies
 * strictly in the future within a plausible daily or weekly horizon.
 */
export const devinQuotaRetryAfterMs = (
  resetAtSignal: string,
  nowMs: number,
): number | undefined => {
  const text = resetAtSignal.trim();

  if (!RFC3339.test(text)) return undefined;
  const resetAt = Date.parse(text);

  if (Number.isNaN(resetAt)) return undefined;
  const delay = resetAt - nowMs;

  return delay <= 0 || delay > QUOTA_RESET_MAX_DELAY_MS ? undefined : delay;
};

/**
 * `devinQuotaScopedStatusError`: upgrades a 429 whose message reports daily or weekly quota exhaustion to credential
 * scope, with the delay taken from the matching observed reset signal. An explicit Retry-After already on the error is
 * kept; transient capacity and generic rate-limit 429s stay model-scoped.
 */
export const devinQuotaScopedError = (
  error: ExecutionError,
  signals: Readonly<Record<string, string>> | undefined,
  nowMs: number,
): ExecutionError => {
  if (error.status !== 429) return error;
  const period = devinUsageQuotaExhaustionPeriod(error.message);

  if (period === undefined) return error;

  const retryAfterMs =
    error.retryAfterMs ??
    devinQuotaRetryAfterMs(signals?.[`${period}_quota_reset_at`] ?? "", nowMs);

  return withErrorFields(error, {
    credentialScoped: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
};

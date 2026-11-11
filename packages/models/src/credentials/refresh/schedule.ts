/**
 * Refresh scheduling math.
 *
 * Go source: sdk/cliproxy/auth/auto_refresh_loop.go (`nextRefreshCheckAt`), conductor_refresh.go (`shouldRefresh`,
 * `authPreferredInterval`, `authLastRefreshTimestamp`, `authHasRefreshCredential`, `ExpirationTime`),
 * sdk/auth/refresh_registry.go + `RefreshLead` of each authenticator. Docs: credentials.md §9.1.
 * Pure functions of (now, credential, state): the DO alarm takes the minimum of `nextRefreshCheckAt` over all
 * credentials, which replaces the Go min-heap.
 */
import type { Json, JsonObject } from "@commissary/json";
import { accessTokenOf, expirationFromMetadata, parseJwtExp, parseTimeValue } from "../expiry.ts";
import type { CredentialState } from "../model.ts";
import { hasUnauthorizedFailure } from "../selection/availability.ts";

const MINUTE = 60_000;

const HOUR = 3_600_000;

/** Provider refresh leads. Providers absent here (devin, meta, kimi.com, vertex, ...) are never auto-refreshed. */
const REFRESH_LEADS_MS = new Map<string, number>([
  // 96 h (CLIProxyAPI feb63984): the upstream invalidates tokens it has not seen refreshed for about a week.
  ["codex", 96 * HOUR],
  ["claude", 4 * HOUR],
  ["antigravity", 30 * MINUTE],
  ["xai", 5 * MINUTE],
  ["kimi", 5 * MINUTE],
  ["kimi-ai", 5 * MINUTE],
  ["kimi.ai", 5 * MINUTE],
]);

/** Request-time guard of the Antigravity executor (`antigravityRequestTokenSafetyWindow`). */
export const ANTIGRAVITY_REQUEST_SAFETY_MS = 5 * MINUTE;

/** `ProviderRefreshLead`: keyed by the auth `type` (not the executor key: `kimi.com` has no lead). */
export const refreshLeadMs = (provider: string): number | undefined =>
  REFRESH_LEADS_MS.get(provider.trim().toLowerCase());

export interface RefreshSubject {
  readonly provider: string;
  readonly metadata: Readonly<JsonObject>;
  readonly attributes: Readonly<Record<string, string>>;
}

/** `authHasRefreshCredential`: a refresh token, or a Meta DCA token. */
export const hasRefreshCredential = (
  subject: Pick<RefreshSubject, "provider" | "metadata">,
): boolean => {
  const text = (key: string): string => {
    const value = subject.metadata[key];

    return typeof value === "string" ? value.trim() : "";
  };

  if (text("refresh_token") !== "" || text("refreshToken") !== "") return true;

  return subject.provider.trim().toLowerCase() === "meta" && text("dca_token") !== "";
};

/** `Auth.ExpirationTime`: a rejected token counts as expired at epoch 0, a JWT `exp` outranks metadata. */
export const expirationTime = (
  metadata: Readonly<JsonObject>,
  rejectedAccessToken?: string,
): number | undefined => {
  const token = accessTokenOf(metadata);

  if (
    token !== "" &&
    rejectedAccessToken !== undefined &&
    rejectedAccessToken !== "" &&
    rejectedAccessToken === token
  ) {
    return 0;
  }

  if (token !== "") {
    const exp = parseJwtExp(token);

    if (exp !== undefined) return exp;
  }

  return expirationFromMetadata(metadata);
};

const INTERVAL_KEYS = [
  "refresh_interval_seconds",
  "refreshIntervalSeconds",
  "refresh_interval",
  "refreshInterval",
] as const;

const INTERVAL_UNIT_MS = new Map<string, number>([
  ["ms", 1],
  ["s", 1000],
  ["m", MINUTE],
  ["h", HOUR],
]);

const intervalMs = (raw: Json | undefined): number => {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 0;

  if (typeof raw !== "string") return 0;
  const text = raw.trim();

  if (text === "") return 0;

  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  // Go `time.ParseDuration` subset: sequences of <number><unit>.
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = 0;

  for (const part of text.matchAll(pattern)) {
    matched += part[0].length;
    total += Number(part[1]) * (INTERVAL_UNIT_MS.get(part[2] ?? "") ?? 0);
  }

  return matched === text.length ? total : 0;
};

/** `authPreferredInterval`: a per-credential `refresh_interval*` wins over the provider lead. */
export const preferredIntervalMs = (subject: RefreshSubject): number => {
  for (const key of INTERVAL_KEYS) {
    const value = intervalMs(subject.metadata[key]);

    if (value > 0) return value;
  }

  for (const key of INTERVAL_KEYS) {
    const value = intervalMs(subject.attributes[key]);

    if (value > 0) return value;
  }

  return 0;
};

/** `authLastRefreshTimestamp`. */
export const lastRefreshAt = (subject: RefreshSubject): number | undefined => {
  for (const key of ["last_refresh", "lastRefresh", "last_refreshed_at", "lastRefreshedAt"]) {
    const parsed = parseTimeValue(subject.metadata[key]);

    if (parsed !== undefined) return parsed;
  }

  for (const key of ["last_refresh", "lastRefresh", "last_refreshed_at", "lastRefreshedAt"]) {
    const parsed = parseTimeValue(subject.attributes[key]);

    if (parsed !== undefined) return parsed;
  }

  return undefined;
};

/** Failures after which scheduling stops until the credential changes (terminal 401, disabled + invalid_grant). */
export const isTerminalRefreshState = (state: CredentialState, disabled: boolean): boolean => {
  if (hasUnauthorizedFailure(state)) return true;
  const error = state.lastError;

  if (error === undefined) return false;
  const isDisabled = disabled || state.status === "disabled";

  return (
    isDisabled &&
    ((error.code ?? "").toLowerCase().includes("invalid_grant") ||
      error.message.toLowerCase().includes("invalid_grant"))
  );
};

/**
 * `shouldRefresh`: is the credential due at `now`? (Back-off, terminal states and refresh-less credentials excluded.)
 */
export const shouldRefresh = (
  now: number,
  subject: RefreshSubject & { readonly disabled: boolean },
  state: CredentialState,
): boolean => {
  if (!hasRefreshCredential(subject) || isTerminalRefreshState(state, subject.disabled))
    return false;

  if (state.nextRefreshAfter !== 0 && now < state.nextRefreshAfter) return false;

  const last = lastRefreshAt(subject);
  const expiry = expirationTime(subject.metadata, state.rejectedAccessToken);
  const interval = preferredIntervalMs(subject);

  if (interval > 0) {
    if (expiry !== undefined && (expiry <= now || expiry - now <= interval)) return true;

    if (last === undefined) return true;

    return now - last >= interval;
  }

  const lead = refreshLeadMs(subject.provider);

  if (lead === undefined) return false;

  if (expiry !== undefined) return expiry - now <= lead;

  if (last !== undefined) return now - last >= lead;

  return true;
};

/**
 * `nextRefreshCheckAt`: when the credential should be looked at next (epoch ms; `<= now` means due now), or
 * `undefined` when it is never scheduled (no lead, no refresh credential, terminal failure).
 */
export const nextRefreshCheckAt = (
  now: number,
  subject: RefreshSubject & { readonly disabled: boolean },
  state: CredentialState,
): number | undefined => {
  if (!hasRefreshCredential(subject) || isTerminalRefreshState(state, subject.disabled))
    return undefined;

  if (state.nextRefreshAfter !== 0 && now < state.nextRefreshAfter) return state.nextRefreshAfter;

  const last = lastRefreshAt(subject);
  const expiry = expirationTime(subject.metadata, state.rejectedAccessToken);
  const interval = preferredIntervalMs(subject);

  if (interval > 0) {
    const candidates: number[] = [];

    if (expiry !== undefined) {
      if (expiry <= now || expiry - now <= interval) return now;
      candidates.push(expiry - interval);
    }

    if (last === undefined) return now;
    candidates.push(last + interval);
    const next = Math.min(...candidates);

    return next <= now ? now : next;
  }

  const lead = refreshLeadMs(subject.provider);

  if (lead === undefined) return undefined;
  const base = expiry !== undefined ? expiry - lead : last !== undefined ? last + lead : now;

  return base <= now ? now : base;
};

/** `invalidGrantBackoffDuration`: 1 min doubling per consecutive failure, capped at 30 min. */
export const invalidGrantBackoffMs = (failures: number): number => {
  if (failures <= 1) return MINUTE;

  return Math.min(30 * MINUTE, MINUTE * 2 ** Math.min(failures - 1, 10));
};

export const REFRESH_FAILURE_BACKOFF_MS = 5 * MINUTE;

/** `refreshIneffectiveBackoff`: a refresh that leaves the credential due again is not retried for 30 s. */
export const REFRESH_INEFFECTIVE_BACKOFF_MS = 30_000;

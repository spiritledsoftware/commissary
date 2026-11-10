/**
 * Passive quota signals: a bounded snapshot of rate-limit response headers.
 *
 * Go source: sdk/cliproxy/auth/quota_signals.go (ObserveResponseHeadersForProvider, collectQuotaSignals,
 * quotaSignalRetentionRank). Docs: credentials.md §8.5. Only the management UI reads the snapshot; selection never does.
 */
import type { QuotaState } from "../model.ts";

const MAX_HEADERS = 64;

const MAX_VALUE_LENGTH = 512;

/** `ProviderSupportsQuotaObservation`. */
export const providerSupportsQuotaObservation = (provider: string): boolean =>
  ["claude", "codex", "devin"].includes(provider.trim().toLowerCase());

const CODEX_MARKERS = [
  "-allowed",
  "-limit-reached",
  "-limit-name",
  "-used-percent",
  "-window-minutes",
  "-reset-after-seconds",
  "-reset-at",
  "-over-secondary-limit-percent",
];

const isSignalHeader = (provider: string, name: string): boolean => {
  if (name === "retry-after") return provider === "claude" || provider === "codex";

  if (name.startsWith("anthropic-ratelimit-unified-")) return provider === "claude";

  if (name.startsWith("x-ratelimit-")) return provider === "codex";

  if (!name.startsWith("x-codex-") || provider !== "codex") return false;

  if (
    name === "x-codex-active-limit" ||
    name === "x-codex-plan-type" ||
    name.startsWith("x-codex-credits-")
  )
    return true;

  return CODEX_MARKERS.some((marker) => name.includes(marker));
};

const retentionRank = (name: string): number => {
  if (name === "retry-after" || name.startsWith("anthropic-ratelimit-unified-")) return 0;

  if (
    name === "x-codex-plan-type" ||
    name === "x-codex-active-limit" ||
    name.startsWith("x-codex-credits-")
  )
    return 1;

  if (
    name === "x-codex-allowed" ||
    name === "x-codex-limit-reached" ||
    name.startsWith("x-codex-primary-") ||
    name.startsWith("x-codex-secondary-")
  ) {
    return 2;
  }

  if (name.startsWith("x-codex-code-review-")) return 3;

  if (name.startsWith("x-codex-additional-")) return 5;

  if (name.startsWith("x-codex-")) return 4;

  return 6;
};

/** `http.CanonicalHeaderKey` for lower-case header names (`anthropic-ratelimit-x` -> `Anthropic-Ratelimit-X`). */
export const canonicalName = (name: string): string =>
  name
    .split("-")
    .map((part) => (part === "" ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join("-");

const validValue = (value: string): boolean => {
  if (value === "" || value.length > MAX_VALUE_LENGTH) return false;

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) return false;
  }

  return true;
};

/** The bounded snapshot of one response (`collectQuotaSignals`); `undefined` when no header qualifies. */
export const collectQuotaSignals = (
  provider: string,
  headers: Readonly<Record<string, string>>,
): Record<string, string> | undefined => {
  const values = new Map<string, string>();

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const lowerName = rawName.trim().toLowerCase();

    if (!isSignalHeader(provider, lowerName)) continue;
    const value = rawValue.trim();

    if (!validValue(value)) continue;
    values.set(canonicalName(lowerName), value);
  }

  if (values.size === 0) return undefined;

  const names = [...values.keys()]
    .toSorted((a, b) => {
      const rank = retentionRank(a.toLowerCase()) - retentionRank(b.toLowerCase());

      if (rank !== 0) return rank;

      return a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, MAX_HEADERS);

  return Object.fromEntries(names.map((name) => [name, values.get(name) ?? ""]));
};

/**
 * `ObserveResponseHeadersForProvider`: replaces the snapshot when the response carries signals, clears it for
 * providers that do not support observation, and leaves it untouched otherwise. Cooldown fields are never touched.
 * Mutates `quota`; returns whether anything changed.
 */
export const observeResponseHeaders = (
  quota: { -readonly [K in keyof QuotaState]: QuotaState[K] },
  provider: string,
  headers: Readonly<Record<string, string>> | undefined,
  now: number,
): boolean => {
  if (!providerSupportsQuotaObservation(provider)) {
    if (quota.signals === undefined && quota.observedAt === undefined) return false;
    delete quota.signals;
    delete quota.observedAt;

    return true;
  }

  const next =
    headers === undefined ? undefined : collectQuotaSignals(provider.trim().toLowerCase(), headers);

  if (next === undefined) return false;
  quota.signals = next;
  quota.observedAt = now;

  return true;
};

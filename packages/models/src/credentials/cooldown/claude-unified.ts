/**
 * Claude's unified (subscription) rate-limit headers on a local cooldown 429.
 *
 * Go source: sdk/cliproxy/auth/quota_signals.go (rejectedClaudeSignalsForCooldown), sdk/cliproxy/auth/selector.go
 * (modelCooldownError.Headers, appendClaudeUnifiedHeaders, claudeUnifiedWindowName, rejectedClaudeUnifiedWindows,
 * isClaudeOverageOnlyHeaders, fallbackClaudeWindowForClaim, inferClaudeRepresentativeClaim,
 * hasRejectedClaudeUnifiedSignals, claudeSignalsFromEvaluatedQuota, claudeUnifiedCooldownForAuth: cb70eacf).
 *
 * A Claude 429 that rejected a unified quota window keeps the rejected `anthropic-ratelimit-unified-*` headers with the
 * cooldown it recorded (`QuotaState.cooldownSignals`), so later passive observations cannot overwrite them. When every
 * credential of a Claude model is cooling down on such a quota, the local `model_cooldown` 429 carries the
 * `Anthropic-Ratelimit-Unified-*` headers Claude Code reads, aligned with its `Retry-After`. Commissary keeps no
 * per-model shadow of a credential-wide quota (Go `credentialQuotaShadow`), so those cases read the live state.
 */
import type { CredentialState, ModelState, QuotaState } from "../model.ts";
import { canonicalModelLookupKey } from "../selection/model-name.ts";
import { canonicalName, collectQuotaSignals } from "./quota-signals.ts";

const PREFIX = "anthropic-ratelimit-unified-";

const isRejected = (value: string | undefined): boolean =>
  (value ?? "").trim().toLowerCase() === "rejected";

/** `claudeUnifiedWindowName`: `anthropic-ratelimit-unified-<window>-status` -> `<window>` (not `overage`). */
const windowName = (header: string): string | undefined => {
  const lower = header.trim().toLowerCase();

  if (!lower.startsWith(PREFIX) || !lower.endsWith("-status")) return undefined;
  const window = lower.slice(PREFIX.length, -"-status".length);

  return window === "" || window === "overage" ? undefined : window;
};

/** `hasRejectedClaudeUnifiedSignals`. */
export const hasRejectedUnifiedSignals = (
  signals: Readonly<Record<string, string>> | undefined,
): boolean => {
  if (signals === undefined) return false;

  return Object.entries(signals).some(
    ([name, value]) =>
      isRejected(value) &&
      (name.toLowerCase() === `${PREFIX}status` || windowName(name) !== undefined),
  );
};

/** `rejectedClaudeSignalsForCooldown`: the bounded signal snapshot of a Claude response that rejected a window. */
export const rejectedSignalsForCooldown = (
  provider: string,
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined => {
  if (provider.trim().toLowerCase() !== "claude" || headers === undefined) return undefined;
  const signals = collectQuotaSignals("claude", headers);

  return hasRejectedUnifiedSignals(signals) ? signals : undefined;
};

/** `claudeSignalsFromEvaluatedQuota`: the retained cooldown signals, else (when never evaluated) the passive ones. */
const signalsFromQuota = (quota: QuotaState): ClaudeCooldown => {
  if (hasRejectedUnifiedSignals(quota.cooldownSignals))
    return { claude: true, signals: quota.cooldownSignals };

  if (quota.cooldownEvaluated === true) return NOT_CLAUDE;

  if (hasRejectedUnifiedSignals(quota.signals)) return { claude: true, signals: quota.signals };

  return NOT_CLAUDE;
};

/** Whether a cooling credential counts as a Claude unified-quota cooldown, and the rejected headers it recorded. */
export interface ClaudeCooldown {
  readonly claude: boolean;
  readonly signals?: Readonly<Record<string, string>> | undefined;
}

const NOT_CLAUDE: ClaudeCooldown = { claude: false };

const isCloudflare = (quota: QuotaState): boolean =>
  (quota.reason ?? "").trim().toLowerCase() === "cloudflare challenge";

/** A quota cooldown that still runs and whose deadline is not outlived by a later retry deadline. */
const quotaCooling = (quota: QuotaState, nextRetryAfter: number, now: number): boolean =>
  quota.exceeded &&
  quota.nextRecoverAt > now &&
  nextRetryAfter <= quota.nextRecoverAt &&
  !isCloudflare(quota);

const modelStateOf = (state: CredentialState, model: string): ModelState | undefined => {
  const key = canonicalModelLookupKey(model);

  return Object.entries(state.modelStates).find(
    ([name]) => canonicalModelLookupKey(name) === key,
  )?.[1];
};

/** `claudeUnifiedCooldownForAuth`. */
export const claudeUnifiedCooldown = (
  provider: string,
  state: CredentialState,
  model: string,
  now: number,
): ClaudeCooldown => {
  if (provider.trim().toLowerCase() !== "claude") return NOT_CLAUDE;
  const quota = state.quota;

  if (quota.exceeded && quota.reason === "credential_quota" && quota.nextRecoverAt > now) {
    const modelState = model === "" ? undefined : modelStateOf(state, model);

    // A model deadline past the credential quota is another cooldown (Go reads it from the model's quota shadow).
    if (modelState !== undefined && modelState.nextRetryAfter > quota.nextRecoverAt)
      return NOT_CLAUDE;
    const own = signalsFromQuota(quota);

    if (own.claude) return own;

    if (modelState !== undefined && modelState.quota.nextRecoverAt >= quota.nextRecoverAt) {
      const fromModel = signalsFromQuota(modelState.quota);

      if (fromModel.claude) return fromModel;
    }

    return { claude: true };
  }

  const states = Object.entries(state.modelStates);

  if (states.length > 0) {
    if (model === "") {
      if (!state.unavailable) return NOT_CLAUDE;
      let earliest: { readonly at: number; readonly cooldown: ClaudeCooldown } | undefined;

      for (const [, modelState] of states.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (
          modelState.quota.reason === "credential_quota" ||
          !quotaCooling(modelState.quota, modelState.nextRetryAfter, now)
        )
          return NOT_CLAUDE;
        const cooldown = signalsFromQuota(modelState.quota);

        if (!cooldown.claude) return NOT_CLAUDE;

        if (earliest === undefined || modelState.quota.nextRecoverAt < earliest.at)
          earliest = { at: modelState.quota.nextRecoverAt, cooldown };
      }

      return earliest?.cooldown ?? NOT_CLAUDE;
    }

    const modelState = modelStateOf(state, model);

    if (
      modelState === undefined ||
      modelState.quota.reason === "credential_quota" ||
      !quotaCooling(modelState.quota, modelState.nextRetryAfter, now)
    )
      return NOT_CLAUDE;

    return signalsFromQuota(modelState.quota);
  }

  if (!quotaCooling(quota, state.nextRetryAfter, now)) return NOT_CLAUDE;

  return signalsFromQuota(quota);
};

const header = (headers: Map<string, string>, name: string): string =>
  (headers.get(canonicalName(name.toLowerCase())) ?? "").trim();

const isAllowedStatus = (status: string): boolean => {
  const lower = status.trim().toLowerCase();

  return lower === "allowed" || lower === "allowed_warning";
};

const belowCap = (raw: string): boolean => {
  if (raw.trim() === "") return false;
  const value = Number(raw.trim());

  return Number.isFinite(value) && value >= 0 && value < 1;
};

const windowHeader = (window: string, field: string): string =>
  canonicalName(`${PREFIX}${window}-${field}`.toLowerCase());

/** `rejectedClaudeUnifiedWindows`, sorted. */
const rejectedWindows = (headers: Map<string, string>): string[] =>
  [...headers]
    .flatMap(([name, value]) => {
      const window = windowName(name);

      return window !== undefined && isRejected(value) ? [window] : [];
    })
    .toSorted();

/** `isClaudeOverageOnlyHeaders`. */
const isOverageOnly = (headers: Map<string, string>): boolean => {
  const overageRejected =
    isRejected(header(headers, `${PREFIX}overage-status`)) ||
    header(headers, `${PREFIX}overage-disabled-reason`) !== "";

  if (!overageRejected) return false;
  const status5h = header(headers, `${PREFIX}5h-status`);
  const status7d = header(headers, `${PREFIX}7d-status`);
  const allowed5h = isAllowedStatus(status5h);
  const allowed7d = isAllowedStatus(status7d);

  if (allowed5h && allowed7d) return true;

  if (allowed7d && status5h === "") {
    const utilization = header(headers, `${PREFIX}5h-utilization`);

    if (utilization === "" || belowCap(utilization)) return true;
  }

  return allowed5h && status7d === "" && belowCap(header(headers, `${PREFIX}7d-utilization`));
};

const FIVE_HOURS_MS = 5 * 60 * 60_000;

/** `fallbackClaudeWindowForClaim`. */
const fallbackWindow = (headers: Map<string, string>, claim: string, resetMs: number): string => {
  if (claim === "seven_day_overage_included") return "7d_oi";

  if (claim.startsWith("seven_day_")) return `7d_${claim.slice("seven_day_".length)}`;

  if (claim === "seven_day") return "7d";

  if (claim === "five_hour") return "5h";

  if (claim !== "") return "";
  const allowed5h = isAllowedStatus(header(headers, `${PREFIX}5h-status`));
  const allowed7d = isAllowedStatus(header(headers, `${PREFIX}7d-status`));

  if (allowed5h && allowed7d) return "";

  if (allowed5h) return "7d";

  if (allowed7d) return "5h";

  return resetMs > FIVE_HOURS_MS ? "7d" : "5h";
};

/** `inferClaudeRepresentativeClaim`. */
const inferClaim = (
  headers: Map<string, string>,
  windows: ReadonlyArray<string>,
  resetMs: number,
): string => {
  if (windows.includes("7d_oi")) return "seven_day_overage_included";
  const family = windows.find((window) => window.startsWith("7d_") && window !== "7d_oi");

  if (family !== undefined) return `seven_day_${family.slice(3)}`;

  if (windows.includes("7d")) return "seven_day";

  if (windows.includes("5h")) return "five_hour";
  const other = windows.find((window) => !window.startsWith("7d") && window !== "5h");

  if (other !== undefined) return other;

  if (
    isRejected(header(headers, `${PREFIX}overage-status`)) ||
    header(headers, `${PREFIX}overage-disabled-reason`) !== ""
  )
    return "overage";
  const allowed5h = isAllowedStatus(header(headers, `${PREFIX}5h-status`));
  const allowed7d = isAllowedStatus(header(headers, `${PREFIX}7d-status`));

  if (allowed5h && allowed7d) return "";

  if (allowed5h) return "seven_day";

  if (allowed7d) return "five_hour";

  return resetMs > FIVE_HOURS_MS ? "seven_day" : "five_hour";
};

/**
 * `appendClaudeUnifiedHeaders`: the `Anthropic-Ratelimit-Unified-*` headers of a local Claude cooldown that resets in
 * `resetSeconds`, built from the rejected signals it recorded (or a five-hour / seven-day guess without them).
 */
export const claudeUnifiedCooldownHeaders = (
  signals: Readonly<Record<string, string>> | undefined,
  resetSeconds: number,
  now: number,
): Record<string, string> => {
  if (resetSeconds <= 0) return {};
  const resetMs = resetSeconds * 1000;
  const reset = String(Math.floor(now / 1000) + resetSeconds);
  const headers = new Map<string, string>();

  const set = (name: string, value: string): void => {
    headers.set(canonicalName(name.toLowerCase()), value);
  };

  if (hasRejectedUnifiedSignals(signals)) {
    for (const [name, value] of Object.entries(signals ?? {})) {
      if (name.trim().toLowerCase().startsWith(PREFIX)) set(name.trim(), value);
    }

    set(`${PREFIX}status`, "rejected");
    set(`${PREFIX}reset`, reset);
    const windows = rejectedWindows(headers);
    let claim = header(headers, `${PREFIX}representative-claim`).toLowerCase();

    if (windows.length === 0 && claim === "" && isOverageOnly(headers)) {
      claim = "overage";
      set(`${PREFIX}representative-claim`, claim);
    }

    if (windows.length === 0 && claim !== "overage") {
      const window = fallbackWindow(headers, claim, resetMs);

      if (window !== "" && header(headers, windowHeader(window, "status")) === "") {
        set(windowHeader(window, "status"), "rejected");
        windows.push(window);
      }
    }

    if (windows.length === 1) {
      set(windowHeader(windows[0] ?? "", "reset"), reset);
    } else if (windows.length > 1) {
      let latest: { readonly name: string; readonly epoch: number } | undefined;

      for (const window of windows) {
        const name = windowHeader(window, "reset");
        const raw = header(headers, name);

        if (raw === "") {
          set(name, reset);
          continue;
        }

        const epoch = Number.parseInt(raw, 10);

        if (Number.isFinite(epoch) && (latest === undefined || epoch >= latest.epoch))
          latest = { name, epoch };
      }

      if (latest !== undefined) set(latest.name, reset);
    }

    if (claim === "") {
      const inferred = inferClaim(headers, windows, resetMs);

      if (inferred !== "") set(`${PREFIX}representative-claim`, inferred);
    }

    if (header(headers, `${PREFIX}overage-status`) === "")
      set(`${PREFIX}overage-status`, "rejected");

    return Object.fromEntries(headers);
  }

  const claim = resetMs > FIVE_HOURS_MS ? "seven_day" : "five_hour";
  const window = claim === "five_hour" ? "5h" : "7d";
  set(`${PREFIX}status`, "rejected");
  set(`${PREFIX}reset`, reset);
  set(`${PREFIX}representative-claim`, claim);
  set(`${PREFIX}overage-status`, "rejected");
  set(windowHeader(window, "status"), "rejected");
  set(windowHeader(window, "reset"), reset);

  return Object.fromEntries(headers);
};

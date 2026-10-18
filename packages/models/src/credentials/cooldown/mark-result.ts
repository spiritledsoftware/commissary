/**
 * Result handling: the cooldown / quota state machine behind `ControlPlane.report`.
 *
 * Go source: sdk/cliproxy/auth/conductor_cooldown.go (MarkResult, applyAuthFailureState, updateAggregatedAvailability,
 * quotaCooldownAfterFailure, nextQuotaCooldown, recoverableFailureRetryAfterWithHint), quota_signals.go.
 * Docs: credentials.md §8.1-8.2.
 *
 * Pure: `markResult` takes the previous {@link CredentialState}, the clock and the settings and returns the next
 * state. All times are epoch milliseconds, `0` = unset (Go zero time).
 */
import type { Json } from "@commissary/json";
import type {
  Credential,
  CredentialError,
  CredentialState,
  ModelState,
  QuotaState,
} from "../model.ts";
import { redactSecrets } from "../redact.ts";
import { canonicalModelKey } from "../selection/model-name.ts";
import { hasUnauthorizedFailure } from "../selection/availability.ts";
import type { ReportResult } from "../selection/types.ts";
import {
  type ClassifiableError,
  ErrorCode,
  isCloudflareChallengeError,
  isInvalidGrantError,
  isModelSupportError,
  shouldSkipCredentialCooldown,
} from "./classify.ts";
import { observeResponseHeaders } from "./quota-signals.ts";
import { recordRecentRequest } from "./recent-requests.ts";

export const QUOTA_BACKOFF_BASE_MS = 1000;

export const QUOTA_BACKOFF_MAX_MS = 30 * 60_000;

/** `minQuotaCooldownFloor`: minimum cooldown when upstream gives a `Retry-After`. */
export const MIN_QUOTA_COOLDOWN_MS = 10_000;

export const TRANSIENT_ERROR_COOLDOWN_MS = 60_000;

const HARD_COOLDOWN_MS = 30 * 60_000;

const NOT_FOUND_COOLDOWN_MS = 12 * 60 * 60_000;

export interface CooldownSettings {
  /** `routing.cooldown.disable-cooling`. */
  readonly disableCooling: boolean;
  /** `routing.cooldown.transient-error-cooldown-seconds`: 0 = 60 s, negative disables, positive = seconds. */
  readonly transientErrorCooldownSeconds: number;
}

export const DEFAULT_COOLDOWN_SETTINGS: CooldownSettings = {
  disableCooling: false,
  transientErrorCooldownSeconds: 0,
};

type DeepMutable<T> =
  T extends ReadonlyArray<infer U>
    ? Array<DeepMutable<U>>
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;

type Draft = DeepMutable<CredentialState>;

type DraftModel = DeepMutable<ModelState>;

type DraftQuota = DeepMutable<QuotaState>;

// SAFETY: Draft is the deep-mutable view of CredentialState and structuredClone keeps the shape of plain data.
const cloneState = (state: CredentialState): Draft => structuredClone(state) as Draft;

/** Stored copy of an error: secrets redacted, message truncated (upstream bodies can be large). */
const cloneError = (error: CredentialError): CredentialError => ({
  ...error,
  message: redactSecrets(error.message),
});

// --- quota ladder ---------------------------------------------------------------------------------------------------

/** `nextQuotaCooldown`: `1s << level` capped at 30 min; the level only advances below the cap. */
export const nextQuotaCooldown = (
  previousLevel: number,
  disableCooling: boolean,
): readonly [number, number] => {
  const level = Math.max(0, previousLevel);

  if (disableCooling) return [0, level];
  const cooldown = QUOTA_BACKOFF_BASE_MS * 2 ** Math.min(level, 40);

  if (cooldown >= QUOTA_BACKOFF_MAX_MS) return [QUOTA_BACKOFF_MAX_MS, level];

  return [cooldown, level + 1];
};

/**
 * `quotaCooldownAfterFailure`: a failure inside a still-open quota window reuses it (a burst of concurrent 429s
 * advances the ladder once per window); otherwise a new window opens.
 */
export const quotaCooldownAfterFailure = (
  quota: Pick<QuotaState, "nextRecoverAt" | "backoffLevel">,
  now: number,
): readonly [number, number] => {
  if (quota.nextRecoverAt > now) return [quota.nextRecoverAt, quota.backoffLevel];
  const [cooldown, level] = nextQuotaCooldown(quota.backoffLevel, false);

  return [cooldown > 0 ? now + cooldown : 0, level];
};

const nextCloudflareCooldown = (
  level: number,
  disableCooling: boolean,
  now: number,
): readonly [number, number] => {
  if (disableCooling) return [0, level];
  const [cooldown, nextLevel] = nextQuotaCooldown(level, disableCooling);
  const effective = Math.max(cooldown, 10_000);

  return [now + effective, nextLevel];
};

/** `recoverableFailureRetryAfterWithHint`. */
export const recoverableRetryAfter = (
  now: number,
  retryAfterMs: number | undefined,
  disableCooling: boolean,
  transientSeconds: number,
): number => {
  if (disableCooling) return 0;

  if (transientSeconds < 0) return 0;

  if (retryAfterMs !== undefined && retryAfterMs > 0) return now + retryAfterMs;

  return now + (transientSeconds === 0 ? TRANSIENT_ERROR_COOLDOWN_MS : transientSeconds * 1000);
};

// --- settings -------------------------------------------------------------------------------------------------------

const parseBoolAny = (value: Json | undefined): boolean | undefined => {
  if (typeof value === "boolean") return value;

  if (typeof value === "number") return value !== 0;

  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "1":
      case "t":
      case "true":
        return true;
      case "0":
      case "f":
      case "false":
        return false;
      default:
        return undefined;
    }
  }

  return undefined;
};

/** The credential's own `disable_cooling` (legacy `disable-cooling`), when it sets one. */
export const coolingOverride = (metadata: Credential["metadata"]): boolean | undefined => {
  for (const key of ["disable_cooling", "disable-cooling"]) {
    const parsed = parseBoolAny(metadata[key]);

    if (parsed !== undefined) return parsed;
  }

  return undefined;
};

/** `quotaCooldownDisabledForAuthWithConfig`: per-credential metadata override, then the global switch. */
export const coolingDisabledFor = (
  credential: Pick<Credential, "metadata">,
  settings: CooldownSettings,
): boolean => coolingOverride(credential.metadata) ?? settings.disableCooling;

// --- state helpers --------------------------------------------------------------------------------------------------

const applyCooldownFields = (
  target: DraftQuota,
  fields: Pick<QuotaState, "exceeded" | "nextRecoverAt" | "backoffLevel"> & { reason?: string },
): void => {
  target.exceeded = fields.exceeded;

  if (fields.reason === undefined || fields.reason === "") delete target.reason;
  else target.reason = fields.reason;
  target.nextRecoverAt = fields.nextRecoverAt;
  target.backoffLevel = fields.backoffLevel;
};

const ensureModelState = (state: Draft, model: string): DraftModel => {
  const existing = state.modelStates[model];

  if (existing !== undefined) return existing;

  const created: DraftModel = {
    status: "active",
    unavailable: false,
    nextRetryAfter: 0,
    quota: { exceeded: false, nextRecoverAt: 0, backoffLevel: 0 },
    updatedAt: 0,
  };

  state.modelStates[model] = created;

  return created;
};

const resetModelState = (model: DraftModel, now: number): void => {
  model.unavailable = false;
  model.status = "active";
  delete model.statusMessage;
  model.nextRetryAfter = 0;
  delete model.lastError;
  applyCooldownFields(model.quota, { exceeded: false, nextRecoverAt: 0, backoffLevel: 0 });
  model.updatedAt = now;
};

const hasModelError = (state: Draft, now: number): boolean =>
  Object.values(state.modelStates).some(
    (model) =>
      model.lastError !== undefined ||
      (model.status === "error" &&
        model.unavailable &&
        (model.nextRetryAfter === 0 || model.nextRetryAfter > now)),
  );

const clearAggregatedAvailability = (state: Draft): void => {
  state.unavailable = false;
  state.nextRetryAfter = 0;
  applyCooldownFields(state.quota, { exceeded: false, nextRecoverAt: 0, backoffLevel: 0 });
};

/** `updateAggregatedAvailability`: derives the credential-level flags from the model states. */
export const updateAggregatedAvailability = (state: Draft, now: number): void => {
  if (hasUnauthorizedFailure(state)) {
    state.unavailable = true;

    return;
  }

  if (
    state.quota.exceeded &&
    state.quota.reason === "credential_quota" &&
    state.quota.nextRecoverAt > now
  ) {
    state.unavailable = true;

    return;
  }

  const models = Object.values(state.modelStates);

  if (models.length === 0) {
    clearAggregatedAvailability(state);

    return;
  }

  let allUnavailable = true;
  let earliestRetry = 0;
  let quotaExceeded = false;
  let quotaRecover = 0;
  let maxBackoff = 0;

  for (const model of models) {
    let unavailable = false;

    if (model.status === "disabled") {
      unavailable = true;
    } else if (model.unavailable) {
      if (model.nextRetryAfter === 0) {
        unavailable = false;
      } else if (model.nextRetryAfter > now) {
        unavailable = true;

        if (earliestRetry === 0 || model.nextRetryAfter < earliestRetry)
          earliestRetry = model.nextRetryAfter;
      } else {
        model.unavailable = false;
        model.nextRetryAfter = 0;
      }
    }

    if (!unavailable) allUnavailable = false;

    if (model.quota.exceeded) {
      quotaExceeded = true;

      if (
        quotaRecover === 0 ||
        (model.quota.nextRecoverAt !== 0 && model.quota.nextRecoverAt < quotaRecover)
      ) {
        quotaRecover = model.quota.nextRecoverAt;
      }

      if (model.quota.backoffLevel > maxBackoff) maxBackoff = model.quota.backoffLevel;
    }
  }

  state.unavailable = allUnavailable;
  state.nextRetryAfter = allUnavailable ? earliestRetry : 0;

  if (quotaExceeded) {
    state.quota.exceeded = true;
    state.quota.reason = "quota";

    if (state.quota.nextRecoverAt > quotaRecover) quotaRecover = state.quota.nextRecoverAt;
    state.quota.nextRecoverAt = quotaRecover;
    state.quota.backoffLevel = maxBackoff;
  } else if (state.quota.exceeded && state.quota.nextRecoverAt > now) {
    // Retain an active credential-level quota cooldown.
  } else {
    applyCooldownFields(state.quota, { exceeded: false, nextRecoverAt: 0, backoffLevel: 0 });
  }
};

const clearStateOnSuccess = (state: Draft, now: number): void => {
  if (hasUnauthorizedFailure(state)) {
    state.unavailable = true;

    return;
  }

  state.unavailable = false;
  state.status = "active";
  delete state.statusMessage;
  applyCooldownFields(state.quota, { exceeded: false, nextRecoverAt: 0, backoffLevel: 0 });
  delete state.lastError;
  state.nextRetryAfter = 0;
  state.updatedAt = now;
};

// --- failure with a credential-level result -------------------------------------------------------------------------

/** `applyAuthFailureState`: the failure table at credential level (no model key). */
const applyCredentialFailure = (
  state: Draft,
  error: CredentialError | undefined,
  classified: ClassifiableError,
  retryAfterMs: number | undefined,
  now: number,
  disableCooling: boolean,
  settings: CooldownSettings,
): void => {
  const previous = state.nextRetryAfter;

  if (shouldSkipCredentialCooldown(classified)) return;
  state.unavailable = true;
  state.status = "error";
  state.updatedAt = now;

  if (error !== undefined) {
    state.lastError = cloneError(error);

    if (error.message !== "") state.statusMessage = redactSecrets(error.message);
  }

  const status = classified.status;

  if (isCloudflareChallengeError(classified)) {
    state.statusMessage = "cloudflare challenge";
    const [next, level] = nextCloudflareCooldown(state.quota.backoffLevel, disableCooling, now);
    applyCooldownFields(state.quota, {
      exceeded: true,
      reason: "cloudflare challenge",
      nextRecoverAt: next,
      backoffLevel: level,
    });
    state.nextRetryAfter = next;
  } else if (isInvalidGrantError(classified)) {
    state.statusMessage = "invalid_grant";
    state.nextRetryAfter = disableCooling ? 0 : now + HARD_COOLDOWN_MS;
  } else {
    switch (status) {
      case 401:
        state.statusMessage = "unauthorized";
        state.nextRetryAfter = disableCooling ? 0 : now + HARD_COOLDOWN_MS;
        break;
      case 402:
      case 403:
        state.statusMessage = "payment_required";
        state.nextRetryAfter = disableCooling ? 0 : now + HARD_COOLDOWN_MS;
        break;
      case 404:
        state.statusMessage = "not_found";
        state.nextRetryAfter = disableCooling
          ? 0
          : retryAfterMs !== undefined && retryAfterMs > 0
            ? now + retryAfterMs
            : now + NOT_FOUND_COOLDOWN_MS;
        break;
      case 429: {
        state.statusMessage = "quota exhausted";
        state.quota.exceeded = true;
        state.quota.reason = "quota";
        let next = 0;

        if (!disableCooling) {
          if (retryAfterMs !== undefined) {
            next = now + Math.max(retryAfterMs, MIN_QUOTA_COOLDOWN_MS);
          } else {
            const [after, level] = quotaCooldownAfterFailure(state.quota, now);
            next = after;
            state.quota.backoffLevel = level;
          }

          if (state.quota.exceeded && state.quota.nextRecoverAt > next)
            next = state.quota.nextRecoverAt;
        }

        state.quota.nextRecoverAt = next;
        state.nextRetryAfter = next;
        break;
      }

      case 408:
      case 500:
      case 502:
      case 503:
      case 504:
      case 520:
      case 521:
      case 522:
      case 523:
      case 524:
      case 525:
      case 526:
      // Not in Go: TypeSafe answers 529 Overloaded where others answer 503 (ADR 0032).
      case 529:
        state.statusMessage = "transient upstream error";
        state.nextRetryAfter = recoverableRetryAfter(
          now,
          retryAfterMs,
          disableCooling,
          settings.transientErrorCooldownSeconds,
        );
        state.unavailable = state.nextRetryAfter !== 0;
        break;
      default:
        if ((state.statusMessage ?? "") === "") state.statusMessage = "request failed";
        state.nextRetryAfter = recoverableRetryAfter(
          now,
          undefined,
          disableCooling,
          settings.transientErrorCooldownSeconds,
        );
        state.unavailable = state.nextRetryAfter !== 0;
        break;
    }
  }

  if (state.nextRetryAfter !== 0 && previous > state.nextRetryAfter && previous > now)
    state.nextRetryAfter = previous;

  if (error?.code === ErrorCode.forceCooldown && state.nextRetryAfter === 0) {
    state.nextRetryAfter = now + TRANSIENT_ERROR_COOLDOWN_MS;
    state.unavailable = true;
  }

  if (disableCooling && state.nextRetryAfter === 0 && state.quota.nextRecoverAt === 0) {
    state.unavailable = false;
    state.quota.exceeded = false;
  }
};

// --- MarkResult -----------------------------------------------------------------------------------------------------

export interface MarkInput {
  readonly credential: Pick<Credential, "provider" | "metadata">;
  readonly state: CredentialState;
  readonly now: number;
  /** Cooldown state key (`canonicalModelKey`-normalised inside); empty = credential level. */
  readonly model: string;
  readonly result: ReportResult;
  readonly settings: CooldownSettings;
}

/** The error of a failed result as the Go `*Error` (request-scoped marker folded into the code). */
export const resultError = (result: ReportResult): CredentialError | undefined => {
  if (result.success) return undefined;
  const source = result.error;
  const httpStatus = source?.httpStatus ?? result.httpStatus;

  const code =
    result.requestScoped === true && source?.code !== ErrorCode.forceCooldown
      ? ErrorCode.requestScoped
      : source?.code;

  return {
    message:
      source?.message ?? (httpStatus === undefined ? "request failed" : `HTTP ${httpStatus}`),
    retryable: source?.retryable ?? false,
    ...(code === undefined ? {} : { code }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
};

export const classifiable = (error: CredentialError): ClassifiableError => ({
  status: error.httpStatus ?? 0,
  message: error.message,
  ...(error.code === undefined ? {} : { code: error.code }),
});

/** `MarkResult` for one attempt. Returns the new state (the input is not modified). */
export const markResult = (input: MarkInput): CredentialState => {
  const { now, result, settings } = input;
  const state = cloneState(input.state);
  const modelKey = canonicalModelKey(input.model);
  const error = resultError(result);
  const wasTerminalUnauthorized = hasUnauthorizedFailure(state);
  const retryAfterMs = result.retryAfterMs;

  let modelState: DraftModel | undefined =
    modelKey === "" ? undefined : state.modelStates[modelKey];

  state.recentRequests = recordRecentRequest(state.recentRequests, now, result.success);

  if (result.success) state.success += 1;
  else state.failed += 1;

  if (result.availabilityNeutral === true) {
    state.updatedAt = now;

    return state;
  }

  if (result.success) {
    if (wasTerminalUnauthorized) {
      if (modelKey !== "") {
        modelState = ensureModelState(state, modelKey);
        resetModelState(modelState, now);
      }
    } else if (state.quota.reason === "credential_quota" && state.quota.nextRecoverAt > now) {
      // Retain the active credential-scoped cooldown.
    } else if (modelKey !== "") {
      modelState = ensureModelState(state, modelKey);
      resetModelState(modelState, now);
      updateAggregatedAvailability(state, now);

      if (!hasModelError(state, now)) {
        delete state.lastError;
        delete state.statusMessage;
        state.status = "active";
      }
    } else {
      clearStateOnSuccess(state, now);
    }
  } else if (error !== undefined) {
    const failure = error;
    const classified = classifiable(failure);
    const forced = failure.code === ErrorCode.forceCooldown;
    const disableCooling = forced ? false : coolingDisabledFor(input.credential, settings);

    if (modelKey !== "") {
      if (!shouldSkipCredentialCooldown(classified)) {
        modelState = ensureModelState(state, modelKey);
        const model = modelState;
        model.unavailable = true;
        model.status = "error";
        model.updatedAt = now;
        const previousRetryAfter = model.nextRetryAfter;
        model.lastError = cloneError(failure);
        model.statusMessage = redactSecrets(failure.message);

        if (!wasTerminalUnauthorized) {
          state.lastError = cloneError(failure);
          state.statusMessage = redactSecrets(failure.message);
        }

        const status = classified.status;

        if (isModelSupportError(classified)) {
          if (disableCooling) model.nextRetryAfter = 0;
          else if (retryAfterMs !== undefined && retryAfterMs > 0)
            model.nextRetryAfter = now + retryAfterMs;
          else model.nextRetryAfter = now + NOT_FOUND_COOLDOWN_MS;
        } else if (isCloudflareChallengeError(classified)) {
          const [next, level] = nextCloudflareCooldown(
            model.quota.backoffLevel,
            disableCooling,
            now,
          );

          model.nextRetryAfter = next;
          model.statusMessage = "cloudflare challenge";

          if (state.lastError !== undefined && !wasTerminalUnauthorized)
            state.statusMessage = "cloudflare challenge";
          applyCooldownFields(model.quota, {
            exceeded: true,
            reason: "cloudflare challenge",
            nextRecoverAt: next,
            backoffLevel: level,
          });
        } else if (isInvalidGrantError(classified)) {
          model.nextRetryAfter = disableCooling ? 0 : now + HARD_COOLDOWN_MS;
        } else {
          switch (status) {
            case 401:
            case 402:
            case 403:
              model.nextRetryAfter = disableCooling ? 0 : now + HARD_COOLDOWN_MS;
              break;
            case 404:
              model.nextRetryAfter = disableCooling
                ? 0
                : retryAfterMs !== undefined && retryAfterMs > 0
                  ? now + retryAfterMs
                  : now + NOT_FOUND_COOLDOWN_MS;
              break;
            case 429:
              applyQuotaFailure(
                state,
                model,
                result,
                retryAfterMs,
                now,
                disableCooling,
                wasTerminalUnauthorized,
              );
              break;
            case 408:
            case 500:
            case 502:
            case 503:
            case 504:
            case 520:
            case 521:
            case 522:
            case 523:
            case 524:
            case 525:
            case 526:
            case 529:
              model.nextRetryAfter = recoverableRetryAfter(
                now,
                retryAfterMs,
                disableCooling,
                settings.transientErrorCooldownSeconds,
              );
              model.unavailable = model.nextRetryAfter !== 0;
              break;
            default:
              model.nextRetryAfter = recoverableRetryAfter(
                now,
                undefined,
                disableCooling,
                settings.transientErrorCooldownSeconds,
              );
              model.unavailable = model.nextRetryAfter !== 0;
              break;
          }
        }

        if (disableCooling && model.nextRetryAfter === 0 && model.quota.nextRecoverAt === 0) {
          model.unavailable = false;
          model.quota.exceeded = false;
        }

        if (failure.code === ErrorCode.forceCooldown && model.nextRetryAfter === 0) {
          model.nextRetryAfter = now + TRANSIENT_ERROR_COOLDOWN_MS;
          model.unavailable = true;
        }

        // A later failure only extends a live cooldown; a deliberate zero write (cooling disabled) still clears it.
        if (
          model.nextRetryAfter !== 0 &&
          previousRetryAfter > model.nextRetryAfter &&
          previousRetryAfter > now
        ) {
          model.nextRetryAfter = previousRetryAfter;
        }

        state.status = "error";
        updateAggregatedAvailability(state, now);
      }
    } else if (!wasTerminalUnauthorized) {
      applyCredentialFailure(
        state,
        failure,
        classified,
        retryAfterMs,
        now,
        disableCooling,
        settings,
      );
    }
  }

  if (wasTerminalUnauthorized) {
    state.unavailable = true;
    state.status = "error";
    state.nextRefreshAfter = 0;
    state.nextRetryAfter = 0;
  }

  state.updatedAt = now;

  if (result.skipQuotaObservation !== true) {
    observeResponseHeaders(state.quota, input.credential.provider, result.headers, now);

    if (modelState !== undefined)
      observeResponseHeaders(modelState.quota, input.credential.provider, result.headers, now);
  }

  return state;
};

/** The 429 row, including credential-wide propagation for credential-scoped limits. */
const applyQuotaFailure = (
  state: Draft,
  model: DraftModel,
  result: ReportResult,
  retryAfterMs: number | undefined,
  now: number,
  disableCooling: boolean,
  wasTerminalUnauthorized: boolean,
): void => {
  const credentialScope = result.credentialScoped === true;
  const authQuotaActive = state.quota.exceeded && state.quota.reason === "credential_quota";
  let next = 0;
  let credentialNext = 0;
  let backoffLevel = model.quota.backoffLevel;

  if (credentialScope) backoffLevel = authQuotaActive ? state.quota.backoffLevel : 0;

  if (!disableCooling) {
    if (retryAfterMs !== undefined) {
      next = now + Math.max(retryAfterMs, MIN_QUOTA_COOLDOWN_MS);
    } else {
      let forFailure: Pick<QuotaState, "nextRecoverAt" | "backoffLevel"> = model.quota;

      if (credentialScope) {
        forFailure = authQuotaActive ? state.quota : { nextRecoverAt: 0, backoffLevel: 0 };
      }

      [next, backoffLevel] = quotaCooldownAfterFailure(forFailure, now);
    }

    credentialNext = next;

    if (model.quota.exceeded && model.quota.nextRecoverAt > next) next = model.quota.nextRecoverAt;
  }

  model.nextRetryAfter = next;
  applyCooldownFields(model.quota, {
    exceeded: true,
    reason: "quota",
    nextRecoverAt: next,
    backoffLevel,
  });

  if (!credentialScope || disableCooling) return;

  for (const other of Object.values(state.modelStates)) {
    if (other === model) continue;
    other.unavailable = true;
    other.status = "error";

    const otherQuotaNext =
      other.quota.exceeded && other.quota.nextRecoverAt > credentialNext
        ? other.quota.nextRecoverAt
        : credentialNext;

    // Propagation only extends a sibling's still-live deadline; it never shortens one.
    const otherRetryAfter =
      other.nextRetryAfter !== 0 && other.nextRetryAfter > otherQuotaNext
        ? other.nextRetryAfter
        : otherQuotaNext;

    other.nextRetryAfter = otherRetryAfter;
    applyCooldownFields(other.quota, {
      exceeded: true,
      reason: "credential_quota",
      nextRecoverAt: otherQuotaNext,
      backoffLevel,
    });
  }

  if (!wasTerminalUnauthorized) {
    state.unavailable = true;
    let authNext = credentialNext;

    if (authQuotaActive && state.quota.nextRecoverAt > authNext)
      authNext = state.quota.nextRecoverAt;
    state.quota.exceeded = true;
    state.quota.reason = "credential_quota";
    state.quota.nextRecoverAt = authNext;
    state.quota.backoffLevel = backoffLevel;
    state.nextRetryAfter = authNext;
  }
};

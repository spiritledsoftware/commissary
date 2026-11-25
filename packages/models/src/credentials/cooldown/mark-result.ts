/**
 * Result handling: the cooldown / quota state machine behind `ControlPlane.report`.
 *
 * Go source: sdk/cliproxy/auth/conductor_cooldown.go (MarkResult, applyAuthFailureState, updateAggregatedAvailability,
 * quotaCooldownAfterFailure, nextQuotaCooldown, recoverableFailureRetryAfterWithHint, existingModelState, ensureModelState,
 * isModelStateActiveCooldown, isAuthActiveCooldown, the execution-sequence guard of CLIProxyAPI 35af74f9, the retained
 * Claude cooldown signals of cb70eacf), quota_signals.go.
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
import {
  canonicalModelKey,
  canonicalModelLookupKey,
  findModelStateKey,
} from "../selection/model-name.ts";
import { hasUnauthorizedFailure } from "../selection/availability.ts";
import type { ReportResult } from "../selection/types.ts";
import {
  type ClassifiableError,
  ErrorCode,
  isCloudflareChallengeError,
  isCreditBalanceTooLow,
  isInvalidGrantError,
  isModelSupportError,
  isTosViolationResult,
  shouldSkipCredentialCooldown,
} from "./classify.ts";
import { rejectedSignalsForCooldown } from "./claude-unified.ts";
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

/** A transient capacity 429 that is not credential scoped (`isTransientRateLimitError`). */
const isTransientRateLimit = (
  error: { readonly code?: string | undefined } | undefined,
  status: number,
  result: Pick<ReportResult, "credentialScoped">,
): boolean =>
  error?.code === ErrorCode.transientRateLimit &&
  status === 429 &&
  result.credentialScoped !== true;

/**
 * `transientRateLimitRetryAfter`: the model-scoped cooldown of a transient capacity 429. An explicit zero hint means the
 * upstream accepts an immediate retry; only a missing hint falls back to the transient default. A live quota deadline
 * is never shortened.
 */
const transientRateLimitRetryAfter = (
  now: number,
  retryAfterMs: number | undefined,
  disableCooling: boolean,
  settings: CooldownSettings,
  quota: Pick<QuotaState, "exceeded" | "nextRecoverAt">,
): number => {
  let next =
    retryAfterMs === 0
      ? 0
      : recoverableRetryAfter(
          now,
          retryAfterMs,
          disableCooling,
          settings.transientErrorCooldownSeconds,
        );

  if (next !== 0 && quota.exceeded && quota.nextRecoverAt > next) next = quota.nextRecoverAt;

  if (next === 0 && quota.exceeded && quota.nextRecoverAt > now) next = quota.nextRecoverAt;

  return next;
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

/** `applyCooldownFields`: a recorded cooldown is evaluated, with the Claude signals it carries (none by default). */
const applyCooldownFields = (
  target: DraftQuota,
  fields: Pick<QuotaState, "exceeded" | "nextRecoverAt" | "backoffLevel"> & {
    reason?: string;
    cooldownSignals?: Readonly<Record<string, string>> | undefined;
  },
): void => {
  target.exceeded = fields.exceeded;

  if (fields.reason === undefined || fields.reason === "") delete target.reason;
  else target.reason = fields.reason;
  target.nextRecoverAt = fields.nextRecoverAt;
  target.backoffLevel = fields.backoffLevel;
  setCooldownSignals(target, fields.cooldownSignals);

  if (fields.exceeded) target.cooldownEvaluated = true;
  else delete target.cooldownEvaluated;
};

const setCooldownSignals = (
  target: DraftQuota,
  signals: Readonly<Record<string, string>> | undefined,
): void => {
  if (signals === undefined || Object.keys(signals).length === 0) delete target.cooldownSignals;
  else target.cooldownSignals = { ...signals };
};

/**
 * The Claude signals of a 429 cooldown (cb70eacf): a kept earlier window keeps its signals; otherwise the response's
 * rejected unified headers, else the earlier window's when the deadline did not move.
 */
const cooldownSignalsFor = (
  kept: boolean,
  previous: {
    readonly active: boolean;
    readonly recoverAt: number;
    readonly signals?: Readonly<Record<string, string>> | undefined;
  },
  next: number,
  provider: string,
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (kept) return previous.signals;

  return (
    rejectedSignalsForCooldown(provider, headers) ??
    (previous.active && previous.recoverAt === next ? previous.signals : undefined)
  );
};

const ensureModelState = (state: Draft, model: string): DraftModel => {
  // Any spelling of the model shares one state, which keeps the casing it was first stored under.
  const existing = state.modelStates[findModelStateKey(state.modelStates, model) ?? model];

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
  delete model.forcedUntil;
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
  delete state.forcedUntil;
  applyCooldownFields(state.quota, { exceeded: false, nextRecoverAt: 0, backoffLevel: 0 });
};

/**
 * `updateAggregatedAvailability`: derives the credential-level flags from the model states. A live credential-level
 * forced cooldown holds whatever the models say (Go `effectiveAuthForceUntil`, CLIProxyAPI 9d7d012b).
 */
export const updateAggregatedAvailability = (state: Draft, now: number): void => {
  const forcedUntil = state.forcedUntil ?? 0;
  aggregateAvailability(state, now);

  if (forcedUntil > now) {
    state.forcedUntil = forcedUntil;
    state.unavailable = true;
    state.nextRetryAfter = Math.max(state.nextRetryAfter, forcedUntil);
  }
};

const aggregateAvailability = (state: Draft, now: number): void => {
  // A disabled credential stays unavailable whatever its models say (CLIProxyAPI 29de31a8).
  if (state.status === "disabled") {
    state.unavailable = true;

    return;
  }

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
  if (state.status === "disabled" || hasUnauthorizedFailure(state)) {
    state.unavailable = true;

    return;
  }

  state.unavailable = false;
  state.status = "active";
  delete state.statusMessage;
  applyCooldownFields(state.quota, { exceeded: false, nextRecoverAt: 0, backoffLevel: 0 });
  delete state.lastError;
  state.nextRetryAfter = 0;
  delete state.forcedUntil;
  state.updatedAt = now;
};

/** A forced cooldown recorded before `forcedUntil` existed: its error and its live deadline. */
const seededForcedUntil = (
  holder: {
    readonly nextRetryAfter: number;
    readonly forcedUntil?: number;
    readonly lastError?: CredentialError;
  },
  now: number,
): number | undefined =>
  holder.forcedUntil === undefined &&
  holder.lastError?.code === ErrorCode.forceCooldown &&
  holder.nextRetryAfter > now
    ? holder.nextRetryAfter
    : undefined;

/**
 * Seeds `forcedUntil` of a stored state (Go `seedInitialForceCooldownDeadlines`, CLIProxyAPI 9d7d012b): a live cooldown
 * whose last error is `force_cooldown` but that was recorded without the deadline (before it was persisted) is forced
 * until its `nextRetryAfter`, at credential and model level. Returns the same object when nothing changes.
 */
export const seedForcedCooldowns = (state: CredentialState, now: number): CredentialState => {
  const own = seededForcedUntil(state, now);

  const models = Object.entries(state.modelStates).flatMap(([key, model]) => {
    const until = seededForcedUntil(model, now);

    return until === undefined ? [] : [[key, { ...model, forcedUntil: until }] as const];
  });

  if (own === undefined && models.length === 0) return state;

  return {
    ...state,
    ...(own === undefined ? {} : { forcedUntil: own }),
    modelStates: { ...state.modelStates, ...Object.fromEntries(models) },
  };
};

/**
 * The last step of a failure: a forced failure records its deadline (`forcedUntil`), and a live forced deadline holds
 * against whatever the failure wrote (a shorter cooldown, or none because cooling is disabled) (CLIProxyAPI 9d7d012b).
 */
const holdForcedCooldown = (
  holder: { nextRetryAfter: number; unavailable: boolean; forcedUntil?: number },
  forced: boolean,
  now: number,
): void => {
  if (forced) holder.forcedUntil = Math.max(holder.forcedUntil ?? 0, holder.nextRetryAfter);
  const until = holder.forcedUntil ?? 0;

  if (until <= now) {
    delete holder.forcedUntil;

    return;
  }

  holder.nextRetryAfter = Math.max(holder.nextRetryAfter, until);
  holder.unavailable = true;
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
  credentialScoped: boolean,
  provider: string,
  headers: Readonly<Record<string, string>> | undefined,
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

  if (isTransientRateLimit(error, status, { credentialScoped })) {
    // Without a model key a transient capacity rejection degrades to an auth-level transient cooldown, never quota.
    state.nextRetryAfter = transientRateLimitRetryAfter(
      now,
      retryAfterMs,
      disableCooling,
      settings,
      state.quota,
    );
    state.unavailable = state.nextRetryAfter !== 0;
  } else if (isCloudflareChallengeError(classified)) {
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
  } else if (isCreditBalanceTooLow(status, classified.message)) {
    state.statusMessage = "payment_required";
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
        const prior = {
          active: state.quota.exceeded && state.quota.nextRecoverAt > now,
          recoverAt: state.quota.nextRecoverAt,
          signals: state.quota.cooldownSignals,
        };

        const kept =
          !disableCooling &&
          prior.active &&
          (retryAfterMs === undefined ||
            prior.recoverAt > now + Math.max(retryAfterMs, MIN_QUOTA_COOLDOWN_MS));

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

        if (!disableCooling) {
          state.quota.cooldownEvaluated = true;
          setCooldownSignals(
            state.quota,
            cooldownSignalsFor(kept, prior, state.quota.nextRecoverAt, provider, headers),
          );
        }

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

  holdForcedCooldown(state, error?.code === ErrorCode.forceCooldown, now);
};

// --- MarkResult -----------------------------------------------------------------------------------------------------

/**
 * The dispatch watermarks of the cooldowns on one credential (CLIProxyAPI 35af74f9, `cooldownRecordedSeq`): the
 * pool's dispatch counter when the cooldown was recorded. Runtime only, so a restart forgets them and a restored
 * cooldown is clearable by any success. Models are keyed by `canonicalModelLookupKey`; `0` / absent = none recorded.
 */
export interface CooldownMarks {
  readonly credential: number;
  readonly models: ReadonlyMap<string, number>;
}

/** `isModelStateActiveCooldown`. */
export const modelCooldownActive = (
  model: Pick<ModelState, "status" | "nextRetryAfter" | "quota">,
  now: number,
): boolean =>
  model.status === "disabled" ||
  model.nextRetryAfter > now ||
  model.quota.nextRecoverAt > now ||
  (model.quota.exceeded && model.quota.nextRecoverAt === 0);

/** `isAuthActiveCooldown`: a live cooldown recorded at credential level. */
export const credentialCooldownActive = (state: CredentialState, now: number): boolean =>
  state.status !== "disabled" &&
  (state.nextRetryAfter > now ||
    state.quota.nextRecoverAt > now ||
    (state.quota.exceeded && state.quota.nextRecoverAt === 0));

export interface MarkInput {
  readonly credential: Pick<Credential, "provider" | "metadata"> & {
    /** The credential file carries `disabled: true`. */
    readonly disabled?: boolean;
  };
  readonly state: CredentialState;
  readonly now: number;
  /** Cooldown state key (`canonicalModelKey`-normalised inside); empty = credential level. */
  readonly model: string;
  readonly result: ReportResult;
  readonly settings: CooldownSettings;
  /**
   * The attempt's dispatch order against the cooldowns recorded so far: a success dispatched at or before a live
   * cooldown's watermark predates it and cannot clear it. Absent / `seq` 0: unknown (exempt).
   */
  readonly dispatch?:
    | { readonly seq: number; readonly marks: CooldownMarks | undefined }
    | undefined;
}

/** What a result cooled: the pool stamps these with its dispatch counter. Models are as given (not case-folded). */
export interface CooledKeys {
  readonly credential: boolean;
  readonly models: ReadonlyArray<string>;
}

export interface MarkOutcome {
  readonly state: CredentialState;
  readonly cooled: CooledKeys;
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
/**
 * Go `credentialRetryAfter`: a credential-scoped failure other than a quota 429 locks the whole credential out of the
 * credits round until its own deadline (CLIProxyAPI 8860264b). A later deadline only extends it.
 */
const recordCredentialRetry = (
  state: Draft,
  until: number,
  disableCooling: boolean,
  now: number,
): void => {
  if (disableCooling || until <= now) return;

  if (until > (state.credentialRetryAfter ?? 0)) state.credentialRetryAfter = until;
};

export const markResult = (input: MarkInput): CredentialState => markResultDetailed(input).state;

/** {@link markResult} plus the keys the result put into a cooldown. */
export const markResultDetailed = (input: MarkInput): MarkOutcome => {
  const { now, result, settings } = input;
  const cooledModels: string[] = [];
  let cooledCredential = false;
  const state = cloneState(input.state);
  const modelKey = canonicalModelKey(input.model);
  const error = resultError(result);
  const wasTerminalUnauthorized = hasUnauthorizedFailure(state);
  const retryAfterMs = result.retryAfterMs;

  let modelState: DraftModel | undefined =
    modelKey === ""
      ? undefined
      : state.modelStates[findModelStateKey(state.modelStates, modelKey) ?? modelKey];

  state.recentRequests = recordRecentRequest(state.recentRequests, now, result.success);

  if (result.success) state.success += 1;
  else state.failed += 1;

  if (result.availabilityNeutral === true) {
    state.updatedAt = now;

    return { state, cooled: { credential: false, models: [] } };
  }

  // A success dispatched before a cooldown was recorded says nothing about recovery: it must not clear that cooldown.
  const sequence = input.dispatch?.seq ?? 0;
  const marks = input.dispatch?.marks;

  const retainedCooldown =
    sequence > 0 &&
    marks !== undefined &&
    !wasTerminalUnauthorized &&
    (modelKey === ""
      ? credentialCooldownActive(state, now) && marks.credential > 0 && sequence <= marks.credential
      : modelState !== undefined &&
        modelCooldownActive(modelState, now) &&
        sequence <= (marks.models.get(canonicalModelLookupKey(modelKey)) ?? 0));

  if (result.success) {
    // A success ends a credential-scoped lockout (Go clears `credentialRetryAfter` with the cooldowns).
    if (!wasTerminalUnauthorized && state.status !== "disabled") delete state.credentialRetryAfter;

    if (input.credential.disabled === true || state.status === "disabled") {
      // A late success of an attempt still in flight on a disabled credential resets no state (CLIProxyAPI 29de31a8).
      // A `disabled` status (a terminal refresh failure) stays unavailable. A credential disabled only by its file
      // is blocked by the flag and keeps its state as it was: enabling it again resets nothing, so flagging it
      // unavailable here would strand it.
      if (state.status === "disabled") state.unavailable = true;
    } else if (wasTerminalUnauthorized) {
      if (modelKey !== "") {
        modelState = ensureModelState(state, modelKey);
        resetModelState(modelState, now);
      }
    } else if (state.quota.reason === "credential_quota" && state.quota.nextRecoverAt > now) {
      // Retain the active credential-scoped cooldown.
    } else if (retainedCooldown) {
      // Retain a cooldown recorded after this attempt was dispatched.
    } else if (modelKey !== "") {
      modelState = ensureModelState(state, modelKey);
      resetModelState(modelState, now);
      updateAggregatedAvailability(state, now);

      if (!hasModelError(state, now) && !((state.forcedUntil ?? 0) > now)) {
        delete state.lastError;
        delete state.statusMessage;
        state.status = "active";
      }
    } else {
      clearStateOnSuccess(state, now);
    }
  } else if (
    error !== undefined &&
    (input.credential.disabled === true || state.status === "disabled")
  ) {
    // A disabled credential (operator action, terminal refresh failure or TOS_VIOLATION) stays as it is until it is
    // enabled again: a late failure neither overwrites its state nor arms a cooldown (CLIProxyAPI 5a351d95).
  } else if (error !== undefined && isTosViolationResult(error)) {
    // A terminal TOS_VIOLATION disables the credential whatever its status and cooling setting (CLIProxyAPI 5a351d95,
    // 14cc6ad1); the pool also sets the file flag and stores the appeal details. No cooldown: nothing to wait for.
    applyTosViolation(state, error, modelKey, now);
    modelState = modelKey === "" ? undefined : ensureModelState(state, modelKey);
  } else if (error !== undefined) {
    const failure = error;
    const classified = classifiable(failure);
    const forced = failure.code === ErrorCode.forceCooldown;
    const disableCooling = forced ? false : coolingDisabledFor(input.credential, settings);

    if (modelKey !== "") {
      if (!shouldSkipCredentialCooldown(classified)) {
        cooledModels.push(modelKey);
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
        } else if (isTransientRateLimit(failure, status, result)) {
          // Transient per-turn capacity rejection: cool only the reporting model until the provider hint. No quota
          // state is written and the quota backoff never moves; a still-live genuine quota deadline keeps blocking.
          model.nextRetryAfter = transientRateLimitRetryAfter(
            now,
            retryAfterMs,
            disableCooling,
            settings,
            model.quota,
          );
          model.unavailable = model.nextRetryAfter !== 0;
        } else if (
          isInvalidGrantError(classified) ||
          isCreditBalanceTooLow(status, classified.message)
        ) {
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
                input.credential.provider,
              );

              // A credential-scoped 429 cools every model of the credential at once.
              if (result.credentialScoped === true && !disableCooling) {
                cooledCredential = true;
                cooledModels.push(...Object.keys(state.modelStates));
              }

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

        // A later failure only extends a live cooldown; a deliberate zero write (cooling disabled) still clears it,
        // except an explicit forced cooldown, which outlasts it.
        if (
          model.nextRetryAfter !== 0 &&
          previousRetryAfter > model.nextRetryAfter &&
          previousRetryAfter > now
        ) {
          model.nextRetryAfter = previousRetryAfter;
        }

        holdForcedCooldown(model, forced, now);

        if (result.credentialScoped === true && status !== 429 && !wasTerminalUnauthorized)
          recordCredentialRetry(state, model.nextRetryAfter, disableCooling, now);

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
        result.credentialScoped === true,
        input.credential.provider,
        result.headers,
      );
      cooledCredential = !shouldSkipCredentialCooldown(classified);

      if (result.credentialScoped === true && classified.status !== 429)
        recordCredentialRetry(state, state.nextRetryAfter, disableCooling, now);
    }
  }

  // A credential a TOS_VIOLATION (or an operator) disabled keeps its disabled status.
  if (wasTerminalUnauthorized && state.status !== "disabled") {
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

  return { state, cooled: { credential: cooledCredential, models: cooledModels } };
};

/** The terminal state of a TOS_VIOLATION: the credential and the reporting model are disabled without a deadline. */
const applyTosViolation = (
  state: Draft,
  failure: CredentialError,
  modelKey: string,
  now: number,
): void => {
  if (modelKey !== "") {
    const model = ensureModelState(state, modelKey);
    model.unavailable = true;
    model.status = "disabled";
    model.statusMessage = ErrorCode.tosViolation;
    model.nextRetryAfter = 0;
    model.lastError = cloneError(failure);
    model.updatedAt = now;
  }

  state.lastError = cloneError(failure);
  state.statusMessage = ErrorCode.tosViolation;
  state.status = "disabled";
  state.unavailable = true;
  state.nextRetryAfter = 0;
  state.updatedAt = now;
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
  provider: string,
): void => {
  const credentialScope = result.credentialScoped === true;
  const authQuotaActive = state.quota.exceeded && state.quota.reason === "credential_quota";

  const priorModel = {
    active: model.quota.exceeded && model.quota.nextRecoverAt > now,
    recoverAt: model.quota.nextRecoverAt,
    signals: model.quota.cooldownSignals,
  };

  const priorCredential = {
    active: authQuotaActive && state.quota.nextRecoverAt > now,
    recoverAt: state.quota.nextRecoverAt,
    signals: state.quota.cooldownSignals,
  };

  let keptModelWindow = false;
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

    if (
      priorModel.active &&
      (priorModel.recoverAt > next || (!credentialScope && retryAfterMs === undefined))
    ) {
      next = priorModel.recoverAt;
      keptModelWindow = true;
    } else if (model.quota.exceeded && model.quota.nextRecoverAt > next) {
      next = model.quota.nextRecoverAt;
    }
  }

  model.nextRetryAfter = next;
  applyCooldownFields(model.quota, {
    exceeded: true,
    reason: "quota",
    nextRecoverAt: next,
    backoffLevel,
    cooldownSignals: disableCooling
      ? undefined
      : cooldownSignalsFor(keptModelWindow, priorModel, next, provider, result.headers),
  });

  if (!credentialScope || disableCooling) return;

  const credentialSignals = cooldownSignalsFor(
    priorCredential.active &&
      (priorCredential.recoverAt > credentialNext || retryAfterMs === undefined),
    priorCredential,
    credentialNext,
    provider,
    result.headers,
  );

  for (const other of Object.values(state.modelStates)) {
    if (other === model) continue;
    other.unavailable = true;
    other.status = "error";

    const keepsOwn = other.quota.exceeded && other.quota.nextRecoverAt > credentialNext;
    const otherQuotaNext = keepsOwn ? other.quota.nextRecoverAt : credentialNext;

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
      cooldownSignals: keepsOwn ? other.quota.cooldownSignals : credentialSignals,
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
    setCooldownSignals(state.quota, credentialSignals);
    state.quota.cooldownEvaluated = true;
  }
};

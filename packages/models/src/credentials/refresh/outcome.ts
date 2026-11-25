/**
 * State transitions after a refresh attempt (pure).
 *
 * Go source: sdk/cliproxy/auth/conductor_refresh.go (`refreshAuthForRequestAtEpoch` failure and success branches),
 * metadata_merge.go (`MergeRefreshedAuth` status/error recovery), conductor_refresh.go (`clearUnauthorizedModelStates`).
 * Docs: credentials.md §9.2 (failure table) and §11.
 */
import type { CredentialError, CredentialState, ModelState } from "../model.ts";
import { hasUnauthorizedFailure } from "../selection/availability.ts";
import {
  isInvalidGrant,
  isRefreshTokenExpired,
  isUnauthorized,
  REFRESH_TOKEN_EXPIRED,
} from "./error.ts";
import {
  invalidGrantBackoffMs,
  REFRESH_FAILURE_BACKOFF_MS,
  REFRESH_INEFFECTIVE_BACKOFF_MS,
} from "./schedule.ts";

export type ScheduleEffect = "reschedule" | "unschedule" | "none";

export interface FailureInput {
  readonly now: number;
  readonly message: string;
  readonly status?: number | undefined;
  /** The credential file carries `disabled: true`. */
  readonly disabled: boolean;
  /** Access token still usable (non-empty and unexpired, rejected tokens count as expired). */
  readonly hasValidAccessToken: boolean;
  /** Upstream rejected exactly the access token that is still stored. */
  readonly accessTokenRejected: boolean;
  /** Manual `ForceRefreshAuth`: ignores terminal-unauthorized gating. */
  readonly force: boolean;
  /** Expiry of the stored access token (epoch ms), used to cap the retry time. */
  readonly tokenExpiry?: number | undefined;
}

const refreshLastError = (input: FailureInput): CredentialError => {
  const unauthorized = isUnauthorized(input);
  const status = input.status ?? (unauthorized ? 401 : undefined);

  return {
    message: input.message,
    retryable: false,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(status === 401 ? { code: "unauthorized" } : {}),
  };
};

const UNAUTHORIZED_ERROR = (message: string): CredentialError => ({
  code: "unauthorized",
  message,
  retryable: false,
  httpStatus: 401,
});

export interface RefreshFailureOutcome {
  readonly state: CredentialState;
  readonly schedule: ScheduleEffect;
}

/** Failure branch of `refreshAuthForRequestAtEpoch`. Returns the new state and what to do with the alarm schedule. */
export const applyRefreshFailure = (
  state: CredentialState,
  input: FailureInput,
): RefreshFailureOutcome => {
  const { now } = input;
  const unauthorized = isUnauthorized(input);
  const invalidGrant = isInvalidGrant(input);
  const base: CredentialState = { ...state, updatedAt: now };

  if (hasUnauthorizedFailure(state)) {
    if (!input.force) return { state, schedule: "none" };

    const next: CredentialState = {
      ...base,
      unavailable: true,
      status: "error",
      nextRefreshAfter: 0,
      nextRetryAfter: 0,
      ...(unauthorized || invalidGrant
        ? {
            lastError: UNAUTHORIZED_ERROR(input.message),
            statusMessage: "unauthorized (refresh token invalid)",
          }
        : {}),
    };

    return { state: next, schedule: "unschedule" };
  }

  const failed: CredentialState = { ...base, lastError: refreshLastError(input) };
  const isDisabled = input.disabled || state.status === "disabled";

  if (isDisabled && invalidGrant) {
    return {
      state: {
        ...failed,
        unavailable: true,
        status: "disabled",
        nextRefreshAfter: 0,
        refreshFailures: 0,
        statusMessage: "disabled (invalid grant)",
      },
      schedule: "unschedule",
    };
  }

  if (isDisabled) {
    return {
      state: {
        ...failed,
        unavailable: true,
        status: "disabled",
        nextRefreshAfter: now + REFRESH_FAILURE_BACKOFF_MS,
        statusMessage: failed.statusMessage ?? "disabled",
      },
      schedule: "reschedule",
    };
  }

  if (isRefreshTokenExpired(input.message)) {
    // Terminal (0bfb3d01): stop refreshing until a new login. A still valid access token keeps serving; without one the
    // credential is unauthorized like a rejected token with an invalid grant.
    const expired: CredentialError = {
      code: REFRESH_TOKEN_EXPIRED,
      message: input.message,
      retryable: false,
      ...(input.status === undefined ? {} : { httpStatus: input.status }),
    };

    if (input.hasValidAccessToken && !input.accessTokenRejected) {
      return {
        state: {
          ...failed,
          lastError: expired,
          nextRefreshAfter: 0,
          refreshFailures: 0,
          statusMessage: "refresh token expired (sign in again)",
        },
        schedule: "unschedule",
      };
    }

    return {
      state: {
        ...failed,
        unavailable: true,
        status: "error",
        nextRefreshAfter: 0,
        nextRetryAfter: 0,
        refreshFailures: 0,
        lastError: { ...expired, httpStatus: 401 },
        statusMessage: "unauthorized (refresh token expired)",
      },
      schedule: "unschedule",
    };
  }

  if (input.accessTokenRejected && invalidGrant) {
    // Neither token can recover without a new login: stop selecting the credential until its tokens change.
    return {
      state: {
        ...failed,
        unavailable: true,
        status: "error",
        nextRefreshAfter: 0,
        nextRetryAfter: 0,
        refreshFailures: 0,
        lastError: UNAUTHORIZED_ERROR(input.message),
        statusMessage: "unauthorized (refresh token invalid)",
      },
      schedule: "unschedule",
    };
  }

  if (!input.hasValidAccessToken || input.accessTokenRejected) {
    const unavailable: CredentialState = { ...failed, unavailable: true, status: "error" };

    if (unauthorized) {
      return {
        state: {
          ...unavailable,
          nextRefreshAfter: 0,
          nextRetryAfter: 0,
          refreshFailures: 0,
          statusMessage: "unauthorized",
        },
        schedule: "none",
      };
    }

    if (invalidGrant) {
      const failures = state.refreshFailures + 1;

      return {
        state: {
          ...unavailable,
          refreshFailures: failures,
          nextRefreshAfter: now + invalidGrantBackoffMs(failures),
          statusMessage: "invalid grant (retrying)",
        },
        schedule: "reschedule",
      };
    }

    return {
      state: {
        ...unavailable,
        refreshFailures: 0,
        nextRefreshAfter: now + REFRESH_FAILURE_BACKOFF_MS,
        statusMessage: "token expired",
      },
      schedule: "reschedule",
    };
  }

  // The access token is still valid: keep serving it and retry later (never later than its expiry).
  let nextRetry = now + REFRESH_FAILURE_BACKOFF_MS;
  let failures = 0;

  if (invalidGrant) {
    failures = state.refreshFailures + 1;
    nextRetry = now + invalidGrantBackoffMs(failures);
  }

  if (input.tokenExpiry !== undefined && input.tokenExpiry > 0 && nextRetry > input.tokenExpiry) {
    nextRetry = input.tokenExpiry;
  }

  return {
    state: { ...failed, refreshFailures: failures, nextRefreshAfter: nextRetry },
    schedule: "reschedule",
  };
};

const isUnauthorizedModelError = (
  error: CredentialError | undefined,
  statusMessage: string | undefined,
): boolean =>
  error?.httpStatus === 401 ||
  error?.code?.toLowerCase() === "unauthorized" ||
  (error?.message ?? "").toLowerCase().includes("status 401") ||
  (statusMessage ?? "").toLowerCase().includes("unauthorized");

/** `clearUnauthorizedModelStates`: model cooldowns caused by the stale token are lifted by a successful refresh. */
export const clearUnauthorizedModelStates = (
  state: CredentialState,
  now: number,
): CredentialState => {
  const modelStates: Record<string, ModelState> = {};
  let changed = false;

  for (const [model, modelState] of Object.entries(state.modelStates)) {
    if (!isUnauthorizedModelError(modelState.lastError, modelState.statusMessage)) {
      modelStates[model] = modelState;
      continue;
    }

    changed = true;

    if (
      modelState.quota.exceeded &&
      (modelState.quota.nextRecoverAt === 0 || modelState.quota.nextRecoverAt > now)
    ) {
      const { lastError: _dropped, ...rest } = modelState;
      modelStates[model] = {
        ...rest,
        updatedAt: now,
        ...((modelState.statusMessage ?? "").toLowerCase().includes("unauthorized") &&
        modelState.quota.reason !== undefined
          ? { statusMessage: modelState.quota.reason }
          : {}),
      };
    }
    // Otherwise the state is reset: an absent entry is a healthy model.
  }

  return changed ? { ...state, modelStates } : state;
};

/**
 * Success branch plus the status/error part of `MergeRefreshedAuth`: `current` is the state at commit time, `base`
 * the state the refresh started from. A cooldown, quota or error that appeared while the refresh was running is kept.
 */
export const applyRefreshSuccess = (
  base: CredentialState,
  current: CredentialState,
  now: number,
  stillDue: boolean,
  disabled: boolean,
): CredentialState => {
  // A status of "disabled" only sticks while the credential file is still disabled (user re-enabled it meanwhile).
  const currentStatus = current.status === "disabled" && !disabled ? "active" : current.status;
  const cleared = clearUnauthorizedModelStates(current, now);

  const {
    rejectedAccessToken: _rejected,
    lastError: _lastError,
    statusMessage: _message,
    ...rest
  } = cleared;

  const next: CredentialState = {
    ...rest,
    refreshFailures: 0,
    nextRefreshAfter: stillDue ? now + REFRESH_INEFFECTIVE_BACKOFF_MS : 0,
    updatedAt: now,
    unavailable: false,
    status: currentStatus === "error" || currentStatus === "unknown" ? "active" : currentStatus,
  };

  const hasNewConcurrentError =
    current.lastError !== undefined &&
    current.lastError.message !== "" &&
    current.lastError.message !== base.lastError?.message;

  const keepCredentialQuota =
    current.quota.exceeded &&
    current.quota.reason === "credential_quota" &&
    current.quota.nextRecoverAt > now;

  const keepCooldown = current.unavailable && current.nextRetryAfter > now;

  if (hasNewConcurrentError) {
    return {
      ...next,
      ...(current.lastError === undefined ? {} : { lastError: current.lastError }),
      status: currentStatus,
      unavailable: current.unavailable,
      ...(current.statusMessage === undefined ? {} : { statusMessage: current.statusMessage }),
    };
  }

  if (keepCredentialQuota || keepCooldown) {
    return {
      ...next,
      status: currentStatus,
      unavailable: current.unavailable,
      ...(current.statusMessage === undefined ? {} : { statusMessage: current.statusMessage }),
    };
  }

  return next;
};

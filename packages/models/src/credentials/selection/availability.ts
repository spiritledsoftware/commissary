/**
 * Availability filter: is a credential selectable for a model right now?
 *
 * Go source: sdk/cliproxy/auth/selector.go (`isAuthBlockedForModel`, `availabilityBlock`, `collectAvailableByPriority`)
 * and conductor_cooldown.go (`hasUnauthorizedAuthFailure`). Docs: credentials.md §6.2.
 * Pure: the clock is a parameter and nothing is mutated, so expired cooldowns need no cleanup ("lazy expiry").
 */
import { accessTokenExpiry } from "../expiry.ts";
import type { Credential, CredentialState } from "../model.ts";
import { canonicalModelLookupKey } from "./model-name.ts";

export type BlockReason = "none" | "disabled" | "cooldown" | "other";

export interface Block {
  readonly blocked: boolean;
  readonly reason: BlockReason;
  /** Epoch ms at which the block ends; `0` when unknown. */
  readonly next: number;
}

const FREE: Block = { blocked: false, reason: "none", next: 0 };

/** `availabilityBlock`: a flag with a future deadline blocks until then; a flag with only past deadlines is free. */
export const availabilityBlock = (
  unavailable: boolean,
  quotaExceeded: boolean,
  nextRetryAfter: number,
  nextRecoverAt: number,
  now: number,
): Block => {
  if (!unavailable && !quotaExceeded) return FREE;
  const hasRecoveryTime = nextRetryAfter !== 0 || nextRecoverAt !== 0;
  let next = 0;

  for (const candidate of [nextRetryAfter, nextRecoverAt]) {
    if (candidate > now && (next === 0 || candidate > next)) next = candidate;
  }

  if (next !== 0) return { blocked: true, reason: quotaExceeded ? "cooldown" : "other", next };

  if (hasRecoveryTime) return FREE;

  return { blocked: true, reason: "other", next: 0 };
};

/** Terminal 401: unavailable, status error, nothing scheduled, last error 401/`unauthorized`. */
export const hasUnauthorizedFailure = (state: CredentialState): boolean => {
  const error = state.lastError;

  if (error === undefined) return false;

  return (
    state.unavailable &&
    state.status === "error" &&
    state.nextRefreshAfter === 0 &&
    state.nextRetryAfter === 0 &&
    (error.httpStatus === 401 || error.code?.toLowerCase() === "unauthorized")
  );
};

/** `isAuthBlockedForModel`. `model` is the selection model (prefix stripped, alias resolved); empty = credential level. */
export const isBlockedForModel = (
  credential: Credential,
  state: CredentialState,
  model: string,
  now: number,
): Block => {
  if (credential.disabled || state.status === "disabled")
    return { blocked: true, reason: "disabled", next: 0 };

  if (hasUnauthorizedFailure(state)) return { blocked: true, reason: "other", next: 0 };
  const expiry = accessTokenExpiry(credential.metadata, state.rejectedAccessToken);

  if (expiry !== undefined && expiry <= now) return { blocked: true, reason: "other", next: 0 };
  const quota = state.quota;

  if (quota.exceeded && quota.reason === "credential_quota" && quota.nextRecoverAt > now) {
    return { blocked: true, reason: "cooldown", next: quota.nextRecoverAt };
  }

  const states = Object.entries(state.modelStates);

  if (model !== "") {
    if (states.length === 0) {
      return availabilityBlock(
        state.unavailable,
        quota.exceeded,
        state.nextRetryAfter,
        quota.nextRecoverAt,
        now,
      );
    }

    const key = canonicalModelLookupKey(model);
    let matched = false;
    let result: Block = FREE;

    for (const [stateModel, modelState] of states) {
      if (canonicalModelLookupKey(stateModel) !== key) continue;
      matched = true;

      if (modelState.status === "disabled") return { blocked: true, reason: "disabled", next: 0 };

      const block = availabilityBlock(
        modelState.unavailable,
        modelState.quota.exceeded,
        modelState.nextRetryAfter,
        modelState.quota.nextRecoverAt,
        now,
      );

      if (!block.blocked) continue;

      if (block.next === 0) return block;

      if (
        !result.blocked ||
        block.next > result.next ||
        (block.next === result.next && block.reason === "cooldown")
      ) {
        result = block;
      }
    }

    // Models without a matching state stay schedulable.
    return matched ? result : FREE;
  }

  // No model: per-model quota aggregates must not block the whole credential unless it is unavailable as a whole.
  const quotaExceeded =
    states.length > 0 && quota.reason !== "credential_quota" && !state.unavailable
      ? false
      : quota.exceeded;

  return availabilityBlock(
    state.unavailable,
    quotaExceeded,
    state.nextRetryAfter,
    quota.nextRecoverAt,
    now,
  );
};

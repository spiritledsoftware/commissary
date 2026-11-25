/**
 * Cooldown reset for the management API.
 *
 * Go source: sdk/cliproxy/auth/conductor_cooldown.go (`ResetQuota`, `clearCooldownStateForAuth`, `resetModelState`).
 * Clears the credential-level and per-model retry/quota timers and, unless the credential failed terminally with
 * HTTP 401 (needs a new login) or is disabled, the last error. A disabled credential keeps its status and stays
 * unavailable. Counters and refresh bookkeeping are kept.
 */
import { type CredentialState, emptyQuota } from "./model.ts";

export interface CooldownReset {
  readonly state: CredentialState;
  /** Model keys whose state was cleared (Go `models`). */
  readonly models: ReadonlyArray<string>;
}

const terminalUnauthorized = (state: CredentialState): boolean =>
  state.lastError?.httpStatus === 401;

export const resetCooldownState = (state: CredentialState, now: number): CooldownReset => {
  const models = Object.keys(state.modelStates).filter((key) => key.trim() !== "");
  // A disabled credential stays disabled and unavailable: only its timers are cleared (CLIProxyAPI 29de31a8).
  const disabled = state.status === "disabled";
  const keepError = disabled || terminalUnauthorized(state);
  const { lastError, statusMessage, ...rest } = state;

  return {
    models,
    state: {
      ...rest,
      ...(keepError && lastError !== undefined ? { lastError } : {}),
      ...(keepError && statusMessage !== undefined ? { statusMessage } : {}),
      status: keepError ? state.status : "active",
      unavailable: disabled,
      nextRetryAfter: 0,
      quota: emptyQuota(),
      modelStates: {},
      updatedAt: now,
    },
  };
};

/**
 * Refresh failures and their classification.
 *
 * Go source: sdk/cliproxy/auth/conductor_cooldown.go (`isUnauthorizedError`, `isInvalidGrantError`,
 * `refreshErrorFromError`). Classification is text based like Go: executors wrap upstream bodies into messages
 * ("token refresh failed with status 400: {"error":"invalid_grant"}").
 */
import { Data } from "effect";

export class RefreshError extends Data.TaggedError("RefreshError")<{
  readonly message: string;
  /** Upstream HTTP status; absent for transport and decoding failures. */
  readonly status?: number;
  /** Whether replaying the same refresh token is safe (Claude: only HTTP >= 500). */
  readonly retryable?: boolean;
  /** The upstream asked to wait this long (Claude 429): the refresh token is blocked for that time. */
  readonly blockMs?: number;
}> {}

export interface RefreshErrorInit {
  readonly message: string;
  readonly status?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly blockMs?: number | undefined;
}

/** Builds a {@link RefreshError} dropping undefined fields (`exactOptionalPropertyTypes`). */
export const refreshError = (init: RefreshErrorInit): RefreshError =>
  new RefreshError({
    message: init.message,
    ...(init.status === undefined ? {} : { status: init.status }),
    ...(init.retryable === undefined ? {} : { retryable: init.retryable }),
    ...(init.blockMs === undefined ? {} : { blockMs: init.blockMs }),
  });

/** `isUnauthorizedError`: HTTP 401, or "status 401" / "401 unauthorized" in the message. */
export const isUnauthorized = (error: {
  readonly message: string;
  readonly status?: number | undefined;
}): boolean => {
  if (error.status === 401) return true;
  const raw = error.message.toLowerCase();

  return raw.includes("status 401") || raw.includes("401 unauthorized");
};

/** `isInvalidGrantError`: "invalid_grant" in the message and the status is 0 (unknown), 400 or 401. */
export const isInvalidGrant = (error: {
  readonly message: string;
  readonly status?: number | undefined;
}): boolean => {
  if (!error.message.toLowerCase().includes("invalid_grant")) return false;
  const status = error.status ?? 0;

  return status === 0 || status === 400 || status === 401;
};

/**
 * An expired refresh token (`isTerminalRefreshGrantMessage`, `terminalRefreshErrorCode`): Anthropic answers
 * `{"error":"invalid_grant","error_description":"Refresh token expired"}` (CLIProxyAPI 0bfb3d01). Only a new login
 * recovers it.
 */
export const isRefreshTokenExpired = (message: string): boolean => {
  const lower = message.toLowerCase();

  return lower.includes("refresh token expired") || lower.includes("refresh_token_expired");
};

/** `lastError.code` of a refresh that failed on an expired refresh token. */
export const REFRESH_TOKEN_EXPIRED = "refresh_token_expired";

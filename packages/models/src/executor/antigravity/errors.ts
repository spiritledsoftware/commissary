/**
 * Antigravity upstream error handling: the 429 decision table, on the retry delays of `helps/google-retry.ts`.
 *
 * Go source: internal/runtime/executor/antigravity_executor_credits.go (`decideAntigravity429WithHeaders`,
 * `newAntigravityStatusErrWithHeaders`, `antigravityHasExplicitCreditsBalanceExhaustedReason`,
 * `parseAntigravityTOSViolation`, `redactTOSAppealURL`).
 */
import { asInt, asString, get, isJsonArray, tryParseJson } from "@commissary/json";
import {
  ErrorCode,
  isValidationRequiredError,
  type TosAppealMetadata,
} from "../../credentials/cooldown/classify.ts";
import { ExecutionError, headersRecord } from "../errors.ts";
import { ERROR_INFO, parseGoogleRetryDelayWithHeadersMs } from "../helps/google-retry.ts";

export const INSTANT_RETRY_THRESHOLD_MS = 3_000;

export const SHORT_QUOTA_COOLDOWN_THRESHOLD_MS = 5 * 60_000;

export type Antigravity429Kind =
  | "soft_retry"
  | "instant_retry_same_auth"
  | "short_cooldown_switch_auth"
  | "full_quota_exhausted";

export interface Antigravity429Decision {
  readonly kind: Antigravity429Kind;
  readonly retryAfterMs?: number;
  readonly reason: string;
}

/**
 * The 429 decision table: the retry delay comes from the body, else the `Retry-After` header (CLIProxyAPI 84b838e1; a
 * mid-stream error frame has no headers). `now` is the caller's clock reading, for an HTTP-date header.
 */
export const decideAntigravity429 = (
  body: string,
  headers: Headers | undefined,
  now: number,
): Antigravity429Decision => {
  const retryAfterMs = parseGoogleRetryDelayWithHeadersMs(headers, body, now);

  if (body === "")
    return retryAfterMs === undefined
      ? { kind: "soft_retry", reason: "" }
      : { kind: "soft_retry", retryAfterMs, reason: "" };

  const withDelay = (kind: Antigravity429Kind, reason: string): Antigravity429Decision =>
    retryAfterMs === undefined ? { kind, reason } : { kind, retryAfterMs, reason };

  const root = tryParseJson(body);

  if (asString(get(root, "error.status")).trim().toUpperCase() !== "RESOURCE_EXHAUSTED")
    return withDelay("soft_retry", "");
  let reason = "";
  const details = get(root, "error.details");

  if (isJsonArray(details)) {
    for (const detail of details) {
      if (asString(get(detail, "@type")) !== ERROR_INFO) continue;
      reason = asString(get(detail, "reason")).trim();
      const upper = reason.toUpperCase();

      if (upper === "QUOTA_EXHAUSTED" || upper === "INSUFFICIENT_G1_CREDITS_BALANCE")
        return withDelay("full_quota_exhausted", reason);

      if (upper === "RATE_LIMIT_EXCEEDED") {
        if (retryAfterMs === undefined) return withDelay("soft_retry", reason);

        if (retryAfterMs < INSTANT_RETRY_THRESHOLD_MS)
          return withDelay("instant_retry_same_auth", reason);

        if (retryAfterMs < SHORT_QUOTA_COOLDOWN_THRESHOLD_MS)
          return withDelay("short_cooldown_switch_auth", reason);

        return withDelay("full_quota_exhausted", reason);
      }
    }
  }

  const lower = body.toLowerCase();

  if (lower.includes("quota_exhausted") || lower.includes("quota exhausted")) {
    return withDelay("full_quota_exhausted", "quota_exhausted");
  }

  return withDelay("soft_retry", reason);
};

/** `antigravityHasExplicitCreditsBalanceExhaustedReason`. */
export const hasExplicitCreditsBalanceExhaustedReason = (body: string): boolean => {
  const details = get(tryParseJson(body), "error.details");

  if (!isJsonArray(details)) return false;

  return details.some(
    (detail) =>
      asString(get(detail, "@type")) === ERROR_INFO &&
      asString(get(detail, "reason")).trim().toUpperCase() === "INSUFFICIENT_G1_CREDITS_BALANCE",
  );
};

/** A TOS_VIOLATION's appeal details (`antigravityTOSViolation`). */
export interface TosViolation {
  readonly appealUrl: string;
  readonly appealUrlText: string;
}

/**
 * `parseAntigravityTOSViolation` (CLIProxyAPI 5a351d95): a 403 `PERMISSION_DENIED` (or gRPC code 7) whose
 * `error.details` carry an ErrorInfo with reason `TOS_VIOLATION`; `undefined` for any other body.
 */
export const parseTosViolation = (body: string): TosViolation | undefined => {
  if (body === "") return undefined;
  const root = tryParseJson(body);
  const code = asInt(get(root, "error.code"));
  const status = asString(get(root, "error.status")).trim().toUpperCase();
  const httpForbidden = code === 403 && status === "PERMISSION_DENIED";
  const grpcDenied = code === 7 && (status === "" || status === "PERMISSION_DENIED");

  if (!httpForbidden && !grpcDenied) return undefined;
  const details = get(root, "error.details");

  if (!isJsonArray(details)) return undefined;

  for (const detail of details) {
    if (asString(get(detail, "@type")) !== ERROR_INFO) continue;

    if (asString(get(detail, "reason")).trim().toUpperCase() !== "TOS_VIOLATION") continue;

    return {
      appealUrl: asString(get(detail, "metadata.appeal_url")).trim(),
      appealUrlText: asString(get(detail, "metadata.appeal_url_link_text")).trim(),
    };
  }

  return undefined;
};

/** `redactTOSAppealURL`: an appeal URL without its query and fragment, for logs (the record keeps the full URL). */
export const redactTosAppealUrl = (raw: string): string => {
  const trimmed = raw.trim();
  const cut = trimmed.search(/[?#]/);

  return cut >= 0 ? trimmed.slice(0, cut) : trimmed;
};

/** The credential metadata a TOS_VIOLATION writes (Go `Error.Metadata`); empty values are left out. */
export const tosAppealMetadata = (violation: TosViolation): TosAppealMetadata => {
  const metadata: TosAppealMetadata = {};

  if (violation.appealUrl !== "") metadata.tos_appeal_url = violation.appealUrl;

  if (violation.appealUrlText !== "") metadata.tos_appeal_url_text = violation.appealUrlText;

  return metadata;
};

/**
 * `newAntigravityStatusErrWithHeaders`: the upstream body verbatim; a 429 or a 503 capacity error carries its retry
 * delay, from the body or the `Retry-After` header (CLIProxyAPI 84b838e1, ae3d80f7). A 401 is credential-scoped; so is
 * a 403 TOS_VIOLATION, which also carries the `tos_violation` code and its appeal details (CLIProxyAPI 5a351d95), and a
 * 403 VALIDATION_REQUIRED challenge (CLIProxyAPI d3e4db8b).
 */
export const antigravityStatusError = (
  status: number,
  body: string,
  headers: Headers,
  now: number,
): ExecutionError => {
  const retryAfterMs =
    status === 429 || status === 503
      ? parseGoogleRetryDelayWithHeadersMs(headers, body, now)
      : undefined;

  const violation = status === 403 ? parseTosViolation(body) : undefined;

  const validation =
    status === 403 &&
    violation === undefined &&
    isValidationRequiredError({ status, message: body });

  return new ExecutionError({
    status,
    message: body,
    headers: headersRecord(headers),
    ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { retryAfterMs } : {}),
    // A rejected credential is credential-scoped: the conductor refreshes it or rotates.
    ...(status === 401 || violation !== undefined || validation ? { credentialScoped: true } : {}),
    ...(violation === undefined
      ? {}
      : { code: ErrorCode.tosViolation, credentialMetadata: tosAppealMetadata(violation) }),
  });
};

/** Whether a 400 body points at a rejected thought signature (`clearAntigravityReasoningReplayOnInvalidSignature`). */
export const isInvalidSignatureBody = (status: number, body: string): boolean => {
  if (status !== 400) return false;
  const lower = body.toLowerCase();

  return (
    lower.includes("thoughtsignature") ||
    lower.includes("thought_signature") ||
    lower.includes("signature")
  );
};

/** What {@link prepareProjectIdError} reads of a failed discovery (`oauth/flows/antigravity.ts` `ProjectDiscoveryError`). */
export interface ProjectDiscoveryFailure {
  readonly message: string;
  readonly status: number;
  readonly retryAfterMs?: number | undefined;
  readonly body: string;
  readonly notFound: boolean;
}

/**
 * `prepareAntigravityProjectIDError` (CLIProxyAPI 2f57a5a6, 204be8b9): a credential without `project_id` whose discovery
 * failed. An upstream answer keeps its status, `Retry-After` (else a 429 body's delay) and TOS_VIOLATION details and is
 * credential-scoped; a discovery without a project is a credential-scoped 503; a failure without an answer is a
 * transient transport error (503 for the client) that cools nothing.
 */
export const prepareProjectIdError = (
  failure: ProjectDiscoveryFailure | undefined,
  now: number,
): ExecutionError => {
  const base = "antigravity auth missing project_id";

  if (failure === undefined)
    return new ExecutionError({ status: 503, message: base, credentialScoped: true });
  const message = `${base}: ${failure.message}`;

  if (failure.notFound) return new ExecutionError({ status: 503, message, credentialScoped: true });

  if (failure.status === 0)
    return new ExecutionError({ status: 503, message, code: ErrorCode.transientTransport });

  const retryAfterMs =
    failure.retryAfterMs ??
    (failure.status === 429 && failure.body !== ""
      ? parseGoogleRetryDelayWithHeadersMs(undefined, failure.body, now)
      : undefined);

  const violation = failure.status === 403 ? parseTosViolation(failure.body) : undefined;

  return new ExecutionError({
    status: failure.status,
    message,
    credentialScoped: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(retryAfterMs === undefined
      ? {}
      : { safeHeaders: { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } }),
    ...(violation === undefined
      ? {}
      : { code: ErrorCode.tosViolation, credentialMetadata: tosAppealMetadata(violation) }),
  });
};

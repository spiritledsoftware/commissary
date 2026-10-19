/**
 * Worker-side error classification for the execution retry loop and the `report` payload.
 *
 * Go source: sdk/cliproxy/auth/conductor_cooldown.go (resultErrorFromError, isRequestInvalidError,
 * isResponsesCompactAvailabilityNeutralError, isResponsesCompactRequestFaultError),
 * sdk/cliproxy/auth/conductor_request_scoped_errors.go (extractRequestScopedErrorRules, matchRequestScopedErrorAction,
 * applyRequestScopedActionToResult). Docs: credentials.md §7, §8.3-8.4. The pure classifiers live in
 * `credentials/cooldown/classify.ts` (shared with the ControlPlane); this module adapts `ExecutionError`.
 */
import { isJsonArray, isJsonObject, type Json } from "@commissary/json";
import type { Config, RequestScopedErrorRule } from "../config/schema.ts";
import {
  type ClassifiableError,
  ErrorCode,
  isCloudflareChallengeError,
  isConnectionLifecycleError,
  isExplicitModelNotFound,
  isInvalidGrantError,
  isProviderSpecificRequestError,
  isRequestFault,
  isRequestInvalidError,
  isRequestRetryRoundError,
  isTransientTransportError,
} from "../credentials/cooldown/classify.ts";
import type { ReportResult } from "../credentials/selection/types.ts";
import { type ExecutionError, headersRecord } from "./errors.ts";
import type { CredentialSnapshot } from "./picker.ts";

/** Largest error text sent to the ControlPlane (upstream bodies can be huge). */
const MAX_REPORTED_MESSAGE = 8192;

/**
 * Executors report failures without an HTTP answer (`fetch` rejected, aborted) with these codes; their `status` is
 * only a client-facing 5xx and must not be mistaken for an upstream status.
 */
const upstreamStatus = (error: ExecutionError): number =>
  error.code === ErrorCode.transientTransport ||
  error.code === ErrorCode.connectionLifecycle ||
  error.code === "empty_stream"
    ? 0
    : error.status;

/** The error as the shared classifiers see it. */
export const classifiable = (error: ExecutionError): ClassifiableError => ({
  status: upstreamStatus(error),
  message: error.message,
  code:
    error.requestScoped === true && error.code !== ErrorCode.forceCooldown
      ? ErrorCode.requestScoped
      : error.code,
});

/** `isRequestInvalidError`: neither rotate credentials nor penalise them. */
export const isRequestInvalid = (error: ExecutionError): boolean =>
  isRequestInvalidError(classifiable(error));

/** An upstream 400/422 another provider may accept (issue #185): the request fails over to a credential of another provider. */
export const isProviderSpecificRequest = (error: ExecutionError): boolean =>
  isProviderSpecificRequestError(classifiable(error));

/** `isRequestRetryRoundError`: status 403/408/429/500/502/503/504 or a transient transport failure. */
export const isRetryRoundError = (error: ExecutionError): boolean =>
  isRequestRetryRoundError(classifiable(error));

export const isTransientTransport = (error: ExecutionError): boolean =>
  isTransientTransportError(classifiable(error));

// --- request-scoped error rules -------------------------------------------------------------------------------------

export type RequestScopedAction =
  | "stop"
  | "stop-and-cooldown"
  | "continue"
  | "continue-and-cooldown";

const ACTIONS: ReadonlySet<string> = new Set([
  "stop",
  "stop-and-cooldown",
  "continue",
  "continue-and-cooldown",
]);

const isAction = (action: string): action is RequestScopedAction => ACTIONS.has(action);

const metadataRules = (value: Json | undefined): RequestScopedErrorRule[] => {
  if (!isJsonArray(value)) return [];

  // SAFETY: rules in credential metadata are written by `credentials/synthesize.ts` or the auth file as
  // `RequestScopedErrorRule` objects; non-object items are dropped by the filter.
  return value.filter(isJsonObject);
};

/**
 * Rules of one credential: its own metadata (provider keys synthesise `request_scoped_errors` there, auth files may
 * carry them), then `oauth.request-scoped-errors[provider]` for OAuth credentials.
 */
export const requestScopedRules = (
  config: Config,
  credential: CredentialSnapshot,
): RequestScopedErrorRule[] => {
  const own = metadataRules(
    credential.metadata["request_scoped_errors"] ?? credential.metadata["request-scoped-errors"],
  );

  if (own.length > 0) return own;

  if (credential.kind !== "oauth") return [];

  return [
    ...(config.oauth["request-scoped-errors"][credential.provider.trim().toLowerCase()] ?? []),
  ];
};

/** `matchRequestScopedErrorAction`: the first rule whose status and body pattern match decides. */
export const matchRequestScopedAction = (
  rules: ReadonlyArray<RequestScopedErrorRule>,
  error: ExecutionError,
): RequestScopedAction | undefined => {
  const status = error.status;
  const body = error.message;

  for (const rule of rules) {
    const ruleStatus = rule.status ?? 0;

    if (ruleStatus <= 0 || ruleStatus !== status) continue;
    const substrings = rule.match ?? [];
    const patterns = rule["match-regexr"] ?? [];

    if (substrings.length === 0 && patterns.length === 0) continue;
    let matched = substrings.some((text) => text !== "" && body.includes(text));

    if (!matched) {
      matched = patterns.some((pattern) => {
        if (pattern === "") return false;

        try {
          return new RegExp(pattern).test(body);
        } catch {
          return false;
        }
      });
    }

    if (!matched) continue;
    const action = (rule.action ?? "").trim().toLowerCase();

    if (isAction(action)) return action;
  }

  return undefined;
};

export const isStopAction = (action: RequestScopedAction | undefined): boolean =>
  action === "stop" || action === "stop-and-cooldown";

// --- report ---------------------------------------------------------------------------------------------------------

export interface ReportContext {
  readonly provider: string;
  /** Cooldown state model when it differs from the lease model (pooled alias attempts). */
  readonly stateModel?: string;
  readonly action?: RequestScopedAction | undefined;
  /** `alt === "responses/compact"`. */
  readonly compact?: boolean;
  /** Token counting: no passive quota snapshot; a generic endpoint 404 does not suspend the model. */
  readonly countTokens?: boolean;
  /** Response headers of the attempt (success) — sent for providers that expose quota signals. */
  readonly headers?: Headers | undefined;
}

const SIGNAL_PROVIDERS = new Set(["claude", "codex", "devin"]);

const headerRecord = (
  headers: Headers | Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined => {
  if (headers === undefined) return undefined;
  const out = headers instanceof Headers ? headersRecord(headers) : Object.assign({}, headers);

  return Object.keys(out).length === 0 ? undefined : out;
};

const withProviderHeaders = (
  provider: string,
  headers: Headers | Readonly<Record<string, string>> | undefined,
): Pick<ReportResult, "headers"> => {
  if (!SIGNAL_PROVIDERS.has(provider.trim().toLowerCase())) return {};
  const record = headerRecord(headers);

  return record === undefined ? {} : { headers: record };
};

export const successReport = (context: ReportContext): ReportResult => ({
  success: true,
  ...(context.stateModel === undefined ? {} : { model: context.stateModel }),
  ...(context.countTokens === true ? { skipQuotaObservation: true } : {}),
  ...withProviderHeaders(context.provider, context.headers),
});

/** `resultErrorFromError`: the code a failed attempt is reported with. */
const resultCode = (error: ExecutionError, classified: ClassifiableError): string | undefined => {
  if (isExplicitModelNotFound(classified)) return ErrorCode.modelNotFound;

  if (isRequestInvalidError(classified)) return ErrorCode.requestScoped;

  if (isConnectionLifecycleError(classified)) return ErrorCode.connectionLifecycle;

  if (isTransientTransportError(classified)) return ErrorCode.transientTransport;

  return error.code;
};

/** Whether a `responses/compact` failure leaves availability untouched (`isResponsesCompactAvailabilityNeutralError`). */
const compactNeutral = (
  error: ExecutionError,
  classified: ClassifiableError,
  code: string | undefined,
): boolean => {
  if (code === ErrorCode.forceCooldown) return false;

  if (
    error.credentialScoped === true ||
    isCloudflareChallengeError(classified) ||
    isInvalidGrantError(classified)
  ) {
    return false;
  }

  return ![401, 402, 403, 429].includes(classified.status);
};

/** Builds the `report` payload of a failed attempt (request-scoped actions, compact neutrality, signals). */
export const failureReport = (error: ExecutionError, context: ReportContext): ReportResult => {
  const classified = classifiable(error);
  let code = resultCode(error, classified);

  if (context.action === "stop" || context.action === "continue") code = ErrorCode.requestScoped;
  else if (context.action === "stop-and-cooldown" || context.action === "continue-and-cooldown")
    code = ErrorCode.forceCooldown;
  const status = classified.status;

  const neutral =
    (context.compact === true && compactNeutral(error, classified, code)) ||
    // `isCountTokensEndpointNotFoundError`: upstreams without a count_tokens route answer a generic 404.
    (context.countTokens === true &&
      classified.status === 404 &&
      !isExplicitModelNotFound(classified) &&
      code !== ErrorCode.forceCooldown);

  return {
    success: false,
    ...(status > 0 ? { httpStatus: status } : {}),
    error: {
      message: error.message.slice(0, MAX_REPORTED_MESSAGE),
      retryable: false,
      ...(code === undefined ? {} : { code }),
      ...(status > 0 ? { httpStatus: status } : {}),
    },
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.credentialScoped === true ? { credentialScoped: true } : {}),
    ...(context.stateModel === undefined ? {} : { model: context.stateModel }),
    ...(context.countTokens === true ? { skipQuotaObservation: true } : {}),
    ...(neutral ? { availabilityNeutral: true } : {}),
    ...withProviderHeaders(context.provider, error.headers),
  };
};

/** `isResponsesCompactRequestFaultError`: compact requests fail fast on request faults. */
export const isCompactRequestFault = (error: ExecutionError, alt: string): boolean => {
  if (alt !== "responses/compact") return false;
  const classified = classifiable(error);

  if (
    error.credentialScoped === true ||
    isCloudflareChallengeError(classified) ||
    isInvalidGrantError(classified)
  ) {
    return false;
  }

  if (isRequestFault(classified.status, error.message)) return true;

  return [400, 404, 405, 409, 413, 422, 501].includes(classified.status);
};

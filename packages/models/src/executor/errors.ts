/**
 * The error contract between executors, the credential conductor and the handlers.
 *
 * Go source: internal/runtime/executor/openai_compat_executor.go (statusErr), sdk/cliproxy/executor/types.go
 * (StatusError, RequestScopedError), sdk/cliproxy/auth/errors.go (Error{Code,HTTPStatus}), internal/clienterror
 * (HTTPStatusFromError), sdk/api/handlers/handlers_execution.go (executionErrorMessage). The optional Go interfaces
 * (`StatusCode()`, `RetryAfter()`, `IsCredentialScoped()`, `IsRequestScoped()`, `DirectResponse()`, `Headers()`)
 * become plain fields.
 */
import { Schema } from "effect";
import type { OutboundRefused } from "@commissary/core";

export class ExecutionError extends Schema.TaggedError<ExecutionError>()("ExecutionError", {
  /** HTTP status for the client (Go `StatusCode()`; 500 when unknown, 499 when the client went away). */
  status: Schema.Number,
  /**
   * Error text. For upstream HTTP errors this is the upstream body verbatim (JSON error bodies are passed through to
   * OpenAI-style clients); otherwise a human-readable message. Never contains credentials.
   */
  message: Schema.String,
  /** Conductor/selection code (`auth_not_found`, `auth_unavailable`, `provider_not_found`, `model_not_found`, ...). */
  code: Schema.optional(Schema.String),
  /** Upstream cooldown hint in milliseconds (Go `RetryAfter()`). */
  retryAfterMs: Schema.optional(Schema.Number),
  /** The failure is tied to the credential (e.g. quota exhausted): cool the credential down. */
  credentialScoped: Schema.optional(Schema.Boolean),
  /** The failure is caused by the request itself (4xx): do not penalise the credential, do not retry. */
  requestScoped: Schema.optional(Schema.Boolean),
  /** The upstream OAuth credential is permanently invalid (`coreauth.IsTerminalAuthError`). */
  terminalAuth: Schema.optional(Schema.Boolean),
  /** Forward `message` verbatim as the response body with `headers` (Go `DirectResponse()`). */
  direct: Schema.optional(Schema.Boolean),
  /** Upstream response headers (`Headers()`); exposed to clients only with `passthrough-headers`. */
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Safe headers for the client regardless of passthrough (e.g. `Retry-After` of cooldown errors). */
  safeHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Convenience constructor for plain status errors (Go `statusErr{code, msg}`). */
export const statusError = (status: number, message: string): ExecutionError =>
  new ExecutionError({ status, message });

/**
 * An attempt the outbound guard refused (ADR 0044: the credential's `base_url`, or a redirect from it, is not a public
 * HTTPS address): `400` with the guard's message, so there is no cooldown and the request moves on to another provider
 * as after an upstream 400; a misconfigured provider does not hide the others.
 */
export const outboundRefusedError = (refused: OutboundRefused): ExecutionError =>
  new ExecutionError({
    status: 400,
    code: "outbound_refused",
    message: refused.message,
    cause: refused,
  });

/** A request-scoped 501 for an operation the provider does not support (no cooldown, no failover). */
export const notImplemented = (message: string): ExecutionError =>
  new ExecutionError({ status: 501, message, requestScoped: true });

/** Plain record of response headers (lower-case names). */
export const headersRecord = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

/** Copy of `error` with some fields replaced (an `Error` subclass does not survive object spread). */
export const withErrorFields = (
  error: ExecutionError,
  fields: Partial<{
    status: number;
    message: string;
    code: string;
    retryAfterMs: number;
    credentialScoped: boolean;
    requestScoped: boolean;
    terminalAuth: boolean;
    direct: boolean;
    headers: Record<string, string>;
    safeHeaders: Record<string, string>;
  }>,
): ExecutionError =>
  new ExecutionError({
    status: error.status,
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.credentialScoped === undefined ? {} : { credentialScoped: error.credentialScoped }),
    ...(error.requestScoped === undefined ? {} : { requestScoped: error.requestScoped }),
    ...(error.terminalAuth === undefined ? {} : { terminalAuth: error.terminalAuth }),
    ...(error.direct === undefined ? {} : { direct: error.direct }),
    ...(error.headers === undefined ? {} : { headers: error.headers }),
    ...(error.safeHeaders === undefined ? {} : { safeHeaders: error.safeHeaders }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
    ...fields,
  });

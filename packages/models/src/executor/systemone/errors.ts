/**
 * Upstream error classification of the System One providers (ADR 0032). Workers addition, no Go counterpart.
 *
 * The body stays the error's message (the handler turns it into TypeSafe's shape, `handlers/respond.ts`); the status
 * decides the cooldown:
 * - 401 (a rejected key) and 402 (SubQ: no credits left) are credential-scoped: the key cools down, the next one is
 *   tried. TypeSafe answers a missing key with 403 "Must supply an API key", credential-scoped too ({@link
 *   typeSafeUpstreamError}).
 * - 429 and 5xx, TypeSafe's 529 Overloaded included (the conductor treats it as a 503), are transient; their
 *   `Retry-After` (or `retry-after-ms`) is the cooldown hint.
 * - Everything else is the request's fault (validation) and handled as for any provider.
 */
import { ExecutionError, headersRecord } from "../errors.ts";
import { parseRetryAfterMs } from "../helps/retry-after.ts";

/** One non-2xx answer of a System One upstream. */
export interface SystemOneErrorInput {
  readonly status: number;
  readonly body: string;
  readonly headers: Headers;
  readonly nowMs: number;
}

/** `retry-after-ms`, else `Retry-After` (seconds or an HTTP date). */
const retryAfterOf = (headers: Headers, nowMs: number): number | undefined => {
  const ms = Number((headers.get("retry-after-ms") ?? "").trim());

  return Number.isFinite(ms) && ms > 0 ? ms : parseRetryAfterMs(headers.get("retry-after"), nowMs);
};

/** The classification every System One provider shares. */
export const systemOneUpstreamError = (input: SystemOneErrorInput): ExecutionError => {
  const { status, body, headers } = input;
  const base = { status, message: body, headers: headersRecord(headers) };

  if (status === 401 || status === 402)
    return new ExecutionError({ ...base, credentialScoped: true });

  if (status === 429 || status >= 500) {
    const retryAfterMs = retryAfterOf(headers, input.nowMs);

    return new ExecutionError({ ...base, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }

  return new ExecutionError(base);
};

/** TypeSafe: a missing key answers 403 "Must supply an API key!" instead of 401. */
export const typeSafeUpstreamError = (input: SystemOneErrorInput): ExecutionError =>
  input.status === 403 && input.body.toLowerCase().includes("must supply an api key")
    ? new ExecutionError({
        status: input.status,
        message: input.body,
        headers: headersRecord(input.headers),
        credentialScoped: true,
      })
    : systemOneUpstreamError(input);

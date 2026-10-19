/**
 * Upstream error classification of the OpenCode Zen/Go gateways.
 *
 * Deliberate deviation from Go (no OpenCode provider there; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode
 * Go"). The gateway reports several failures that concern one model, not the key:
 *  - 400 `ModelProtocolUnsupported` (the model is served on another endpoint: a catalog or `protocol` mistake),
 *  - 400 "Model is unavailable." (the gateway does not serve the model),
 *  - 403 "Model access is disabled" (Zen: the model is switched off for the workspace),
 *  - 403 `FreeTierError` (Zen free models only work from OpenCode's own client, or a client cloaked as it, ADR 0033),
 *  - 400 "Free models may train on request data. Allow free endpoints in your workspace's Privacy settings" (Zen:
 *    the key's workspace does not allow free models).
 * They become model-not-found errors (`code: model_not_found`) with a cooldown hint: the conductor cools only that
 * model of the credential (`isModelSupportError`) and tries the next credential instead of failing the request as a
 * client fault or cooling the whole key. On OpenCode Go a subscription usage limit reached (`GoUsageLimitError`, or a
 * 402/403/429 whose message starts "5-hour/Weekly/Monthly usage limit reached", `usage-limit.ts`) is checked first and
 * becomes a credential-scoped 429 cooling the whole key until the window resets (the status is normalised to 429 so the
 * cooldown is the quota row of `mark-result.ts`, not the auth/payment one). Other statuses keep the usual handling:
 * 401 (bad key) and 402 (no balance) are credential-scoped, a Go 429 is credential-scoped while a Zen 429 stays
 * model-level, `Retry-After` (seconds or an HTTP date) is honoured on 429 and 5xx answers.
 */
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { ExecutionError, headersRecord } from "../errors.ts";
import { openAICompatRetryAfterMs, parseRetryAfterMs } from "../helps/retry-after.ts";
import { OPENCODE_GO, type OpenCodeProvider } from "./providers.ts";
import { openCodeUsageLimit } from "./usage-limit.ts";

/** Cooldown of a model the gateway does not serve for this key (unavailable, disabled, free tier, free endpoints). */
export const OPENCODE_MODEL_COOLDOWN_MS = 30 * 60_000;

/** Cooldown after `ModelProtocolUnsupported`: short, a `protocol` fix in the config should take effect soon. */
export const OPENCODE_PROTOCOL_COOLDOWN_MS = 5 * 60_000;

export type OpenCodeModelFault =
  | "protocol"
  | "unavailable"
  | "disabled"
  | "free-tier"
  | "free-endpoints";

/** Logged when a Zen workspace refuses free models (`free-endpoints`). */
export const FREE_ENDPOINTS_HINT =
  "OpenCode Zen refused a free model: allow free endpoints in the key's workspace Privacy settings (free models may train on request data)";

const lower = (value: Json | undefined): string => asString(value).trim().toLowerCase();

/** The model-scoped failure an error body reports, if any. */
export const openCodeModelFault = (
  status: number,
  body: string,
): OpenCodeModelFault | undefined => {
  if (status !== 400 && status !== 403 && status !== 404) return undefined;
  const parsed = tryParseJson(body.trim());
  const type = parsed === undefined ? "" : lower(get(parsed, "error.type"));

  const message =
    parsed === undefined
      ? body.trim().toLowerCase()
      : lower(get(parsed, "error.message")) || lower(get(parsed, "message"));

  if (type === "modelprotocolunsupported" || message.includes("does not support this protocol"))
    return "protocol";

  if (type === "freetiererror") return "free-tier";

  if (message.includes("free models may train on request data")) return "free-endpoints";

  if (message.includes("model access is disabled")) return "disabled";

  if (message.includes("model is unavailable")) return "unavailable";

  return undefined;
};

/** A non-2xx gateway answer as an `ExecutionError` (the body is passed through verbatim). */
export const openCodeUpstreamError = (input: {
  readonly provider: OpenCodeProvider;
  readonly status: number;
  readonly body: string;
  readonly headers: Headers;
  readonly nowMs: number;
}): ExecutionError => {
  const { status, body, headers } = input;
  const base = { status, message: body, headers: headersRecord(headers) };

  const limit =
    input.provider === OPENCODE_GO
      ? openCodeUsageLimit(status, body, headers, input.nowMs)
      : undefined;

  if (limit !== undefined) {
    return new ExecutionError({
      ...base,
      status: 429,
      credentialScoped: true,
      retryAfterMs: limit.retryAfterMs,
    });
  }

  const fault = openCodeModelFault(status, body);

  if (fault !== undefined) {
    return new ExecutionError({
      ...base,
      code: "model_not_found",
      retryAfterMs:
        fault === "protocol" ? OPENCODE_PROTOCOL_COOLDOWN_MS : OPENCODE_MODEL_COOLDOWN_MS,
    });
  }

  if (status === 401 || status === 402)
    return new ExecutionError({ ...base, credentialScoped: true });

  if (status === 429) {
    const retryAfterMs = openAICompatRetryAfterMs(status, headers, body, input.nowMs);

    return new ExecutionError({
      ...base,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(input.provider === OPENCODE_GO ? { credentialScoped: true } : {}),
    });
  }

  const retryAfterMs =
    status >= 500 ? parseRetryAfterMs(headers.get("retry-after"), input.nowMs) : undefined;

  return new ExecutionError({ ...base, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
};

/**
 * An error raised by a delegated engine (the Gemini executor) re-classified with the gateway rules. Only upstream
 * answers (errors carrying response headers) are touched; local failures keep their flags.
 */
export const reclassifyOpenCodeError = (
  provider: OpenCodeProvider,
  error: ExecutionError,
  nowMs: number,
): ExecutionError =>
  error.headers === undefined || error.requestScoped === true || error.code !== undefined
    ? error
    : openCodeUpstreamError({
        provider,
        status: error.status,
        body: error.message,
        headers: new Headers(error.headers),
        nowMs,
      });

/**
 * Responses stream `error` / `response.failed` events (the upstream answered 200 and failed mid-stream): the status
 * from `error.code`/`response.error.code` when it is an HTTP status, else 502, classified like an HTTP answer.
 */
export const openCodeStreamEventError =
  (provider: OpenCodeProvider) =>
  (event: Json | undefined, payload: string, nowMs: number): ExecutionError | undefined => {
    const type = lower(get(event, "type"));

    if (type !== "error" && type !== "response.failed") return undefined;

    const code = [
      get(event, "error.code"),
      get(event, "response.error.code"),
      get(event, "status"),
    ].find((value) => typeof value === "number" && value >= 400 && value <= 599);

    return openCodeUpstreamError({
      provider,
      status: typeof code === "number" ? code : 502,
      body: payload,
      headers: new Headers(),
      nowMs,
    });
  };

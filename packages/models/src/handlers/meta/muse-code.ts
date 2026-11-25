/**
 * `GET /muse-code/config`, `POST /muse-code/search`, `POST /muse-code/browser_open`: the Muse Code CLI's auxiliary
 * endpoints, relayed to the origin of a Meta credential.
 *
 * Go source: internal/client/musecode/relay.go (`Handle`, `forwardWithCredential`, `selectMetaAuthExcluding`,
 * `originFromAuth`, `sanitizeQuery`, `relayRequestHeaders`, `writeRelayResponseHeaders`, `markHTTPResponseFailure`),
 * internal/runtime/executor/meta_executor.go (`PrepareRequest`: bearer token, client identity, custom headers).
 * A credential is picked through any Meta model the caller can use (sorted), excluding those already tried; its result
 * is reported without a model, credential-scoped. The body (<= 16 MiB) is forwarded unchanged with an allowlist of
 * client headers (plus `X-Tbh-*` / `X-Meta-Ai-*`), the query without `key`/`auth_token`, and the upstream status, body
 * and an allowlist of its headers come back. A 401 refreshes the credential once; a request-scoped rule whose action
 * continues moves on to the next credential, up to `max-retry-credentials`.
 *
 * The upstream's `Retry-After` sets the cooldown (`parseRetryAfterHeader`); an invalid base URL or an oversized upstream
 * answer is a 502 that marks nothing. Like alpha search, the request counts against free usage once it is served.
 *
 * Not ported: Go's `/muse-code/models` catalog (`models.go`), and the `credentialRetryAfter` refinement of Go's cooldowns.
 */
import { Clock, Effect, Result } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { CurrentOrg, routeServices } from "@commissary/core";
import { AccessPrincipal } from "@commissary/auth";
import { ExecutionError, safeRetryAfter, withErrorFields } from "../../executor/errors.ts";
import {
  failureReport,
  matchRequestScopedAction,
  requestScopedRules,
  successReport,
} from "../../executor/classify.ts";
import { applyCustomHeaders } from "../../executor/helps/custom-headers.ts";
import { withCredentialRefresh } from "../../executor/helps/credential-refresh.ts";
import { metaCreds } from "../../executor/meta/credentials.ts";
import { metaIdentityHeaders } from "../../executor/meta/identity.ts";
import { CredentialPicker, type PickResult } from "../../executor/picker.ts";
import type { ExecutionContext } from "../../executor/types.ts";
import { UsageReporter } from "../../usage/reporter.ts";
import { ModelProviders } from "../model-providers.ts";
import { type ClientApiServices, currentConfig } from "../request.ts";
import { planLimitError } from "../metering.ts";
import { countRequest, uncountRequest } from "@commissary/billing/api";
import { parseRetryAfterMs } from "../../executor/helps/retry-after.ts";

const MAX_BODY_BYTES = 16 << 20;

/** `allowedEndpoints`: path -> method. */
const ENDPOINTS = [
  ["/muse-code/config", "GET"],
  ["/muse-code/search", "POST"],
  ["/muse-code/browser_open", "POST"],
] as const;

const methodOf = (path: string) => ENDPOINTS.find(([endpoint]) => endpoint === path)?.[1];

/** `allowedRequestHeaders`; `X-Tbh-*` and `X-Meta-Ai-*` pass too. */
const REQUEST_HEADERS = ["accept", "content-type", "traceparent", "if-none-match"];

/** `allowedResponseHeaders`. */
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified", "retry-after"];

/** `shouldMarkCredentialFailure`: the statuses that count against the credential. */
const CREDENTIAL_FAILURES = new Set([401, 402, 403, 429]);

const errorJson = (status: number, message: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.text(JSON.stringify({ error: message }), {
    status,
    contentType: "application/json",
    headers,
  });

interface Relayed {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

const relayedResponse = (relayed: Relayed) => {
  const headers: Record<string, string> = {};

  for (const name of RESPONSE_HEADERS) {
    const value = relayed.headers[name];

    if (value !== undefined) headers[name] = value;
  }

  return HttpServerResponse.uint8Array(relayed.bytes, { status: relayed.status, headers });
};

/** `originFromAuth`: scheme and host of the credential's base URL. */
const originOf = (baseUrl: string): string | undefined => {
  try {
    const url = new URL(baseUrl);

    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== ""
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
};

/** `sanitizeQuery`: the query without `key` and `auth_token`. */
const sanitizeQuery = (search: string): string => {
  const params = new URLSearchParams(search);
  params.delete("key");
  params.delete("auth_token");

  return params.toString();
};

/** `relayRequestHeaders`. */
const relayRequestHeaders = (client: Headers): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();

  for (const [name, value] of client) {
    if (
      REQUEST_HEADERS.includes(name) ||
      name.startsWith("x-tbh-") ||
      name.startsWith("x-meta-ai-")
    )
      out.set(name, value);
  }

  return out;
};

/**
 * `MetaExecutor.PrepareRequest` on the relayed headers: bearer token, the Muse client identity (its session ids only
 * when the client sent none), then the credential's custom headers.
 */
const upstreamHeaders = (
  context: ExecutionContext,
  relayed: ReadonlyMap<string, string>,
  clientHeaders: Headers,
  nowMs: number,
) => {
  const { token } = metaCreds(context.credential);
  const headers = new Map(relayed);
  const clientSession = (relayed.get("x-tbh-session-id") ?? "").trim() !== "";

  for (const [name, value] of Object.entries(metaIdentityHeaders("", nowMs))) {
    const session = name !== "user-agent" && name !== "x-client-id";

    if (!session || !clientSession) headers.set(name, value);
  }

  if (token.trim() !== "") headers.set("authorization", `Bearer ${token}`);

  return applyCustomHeaders(
    Object.fromEntries(headers),
    context.credential,
    clientHeaders,
    undefined,
  );
};

/** A relay fault that is not the credential's (Go returns these without marking a result): never reported. */
const RELAY_FAULT = "muse_code_relay_fault";

const relayFault = (message: string) =>
  new ExecutionError({ status: 502, code: RELAY_FAULT, message });

const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname;

  if (methodOf(path) !== request.method) return HttpServerResponse.empty({ status: 404 });
  const identity = yield* AccessPrincipal;
  const org = yield* CurrentOrg;
  const configResult = yield* Effect.result(currentConfig);

  if (Result.isFailure(configResult))
    return errorJson(configResult.failure.status, configResult.failure.message);
  const config = configResult.success;
  // `readLimitedBody`: the raw bytes, forwarded unchanged.
  const read = yield* Effect.result(request.arrayBuffer);

  if (Result.isFailure(read)) return errorJson(400, "Failed to read Muse Code request");
  const body = new Uint8Array(read.success);

  if (body.length > MAX_BODY_BYTES) return errorJson(413, "muse code: body exceeds 16 MiB limit");

  const providers = yield* ModelProviders;

  const modelsResult = yield* Effect.result(
    providers.modelsOfProvider?.("meta") ?? Effect.succeed([]),
  );

  if (Result.isFailure(modelsResult))
    return errorJson(modelsResult.failure.status, modelsResult.failure.message);
  const models = modelsResult.success;

  // Like alpha search: the request counts against free usage once it starts being served, and a Free org over its
  // limit is refused first.
  const counted = yield* Effect.result(countRequest);

  if (Result.isFailure(counted)) {
    const refused = planLimitError(counted.failure);

    // The refusal's message is the whole JSON error body (`PlanLimitReached.body`).
    return HttpServerResponse.text(refused.message, {
      status: refused.status,
      contentType: "application/json",
      headers: refused.safeHeaders ?? {},
    });
  }

  const picker = yield* CredentialPicker;
  const client = yield* HttpClient.HttpClient;
  const clientHeaders = new Headers(request.headers);
  const relayedHeaders = relayRequestHeaders(clientHeaders);
  const query = sanitizeQuery(url.search);
  const maxCredentials = Math.max(0, config.routing.retry["max-retry-credentials"]);
  const tried: string[] = [];
  let last: { readonly relayed: Relayed } | { readonly error: ExecutionError } | undefined;

  const noCredential = new ExecutionError({
    status: 503,
    code: "auth_not_found",
    message: "no available Meta credential",
  });

  /** `selectMetaAuthExcluding`: the first Meta model that yields a credential not tried yet. */
  const pick = Effect.gen(function* () {
    let firstError: ExecutionError | undefined;

    for (const model of models) {
      const picked = yield* Effect.result(
        picker.pick({
          providers: ["meta"],
          model,
          callerScope: identity.callerScope,
          ...(identity.memberId === undefined ? {} : { memberId: identity.memberId }),
          ...(identity.principal.kind === "key" ? { apiKeyId: identity.principal.keyId } : {}),
          excludedIds: tried,
        }),
      );

      if (Result.isSuccess(picked)) return picked.success;

      if (firstError === undefined || picked.failure.code !== "auth_not_found")
        firstError = picked.failure;
    }

    return yield* firstError ?? noCredential;
  });

  /**
   * One credential: forward, refreshing once after a 401 (`forwardWithCredential`). The 401 fails the attempt so the
   * refresh helper can repeat it; the upstream answer it carries is kept in `unauthorized`.
   */
  const forward = (picked: PickResult, requestedAt: number) => {
    let unauthorized: Relayed | undefined;

    const usage = new UsageReporter({
      requestId: crypto.randomUUID(),
      provider: "meta",
      executorType: "meta",
      model: "",
      alias: "",
      endpoint: `${request.method} ${path}`,
      principalId: identity.principalId,
      orgId: org,
      ...(identity.memberId === undefined ? {} : { memberId: identity.memberId }),
      ...(picked.credential.private === true ? { private: true } : {}),
      authId: picked.credential.id,
      authType: picked.credential.kind,
      source: picked.credential.label ?? picked.credential.id,
      stream: false,
      serviceTier: "auto",
      requestedAt,
    });

    const attempt = (current: ExecutionContext) =>
      Effect.gen(function* () {
        unauthorized = undefined;
        const origin = originOf(metaCreds(current.credential).baseUrl);

        if (origin === undefined) return yield* relayFault("muse code: invalid Meta base_url");

        const target = `${origin}${path}${query === "" ? "" : `?${query}`}`;

        const headers = upstreamHeaders(
          current,
          relayedHeaders,
          clientHeaders,
          yield* Clock.currentTimeMillis,
        );

        const httpRequest =
          request.method === "GET"
            ? HttpClientRequest.get(target).pipe(HttpClientRequest.setHeaders(headers))
            : HttpClientRequest.post(target).pipe(
                HttpClientRequest.bodyUint8Array(body, headers["content-type"]),
                HttpClientRequest.setHeaders(headers),
              );

        const response = yield* client.execute(httpRequest).pipe(
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.mapError(
            () =>
              new ExecutionError({
                status: 502,
                code: "transient_transport",
                message: "upstream request failed",
              }),
          ),
        );

        const buffer = yield* response.arrayBuffer.pipe(
          Effect.mapError(
            () =>
              new ExecutionError({
                status: 502,
                code: "transient_transport",
                message: "Failed to read Meta response",
              }),
          ),
        );

        if (buffer.byteLength > MAX_BODY_BYTES)
          return yield* relayFault("Meta response body exceeds 16 MiB limit");

        const relayed: Relayed = {
          status: response.status,
          headers: { ...response.headers },
          bytes: new Uint8Array(buffer),
        };

        if (response.status === 401) {
          unauthorized = relayed;

          return yield* new ExecutionError({
            status: 401,
            message: new TextDecoder().decode(relayed.bytes),
            headers: relayed.headers,
          });
        }

        return relayed;
      });

    // A 401 the refresh did not cure is an upstream answer like any other: relayed as it came.
    return withCredentialRefresh({ credential: picked.credential, config, usage }, attempt).pipe(
      Effect.catch((error) =>
        error.status === 401 && unauthorized !== undefined
          ? Effect.succeed({ relayed: unauthorized, error })
          : Effect.fail(error),
      ),
      Effect.map((outcome) => ("bytes" in outcome ? { relayed: outcome } : outcome)),
    );
  };

  for (let attempt = 0; maxCredentials === 0 || attempt < maxCredentials; attempt++) {
    const picked = yield* Effect.result(pick);

    if (Result.isFailure(picked)) {
      if (last !== undefined) break;
      const failure = picked.failure;
      // No credential was picked, so no upstream attempt was made: the request did no work and is not counted.
      yield* uncountRequest(counted.success);
      const retryAfter = safeRetryAfter(failure);

      return errorJson(
        failure.status > 0 ? failure.status : 503,
        failure.message,
        retryAfter !== undefined ? { "retry-after": retryAfter } : {},
      );
    }

    tried.push(picked.success.credential.id);
    const rules = requestScopedRules(config, picked.success.credential);

    // Results are the credential's, not a model's: reported without a model (Go `CredentialScope`, no model).
    const report = (error: ExecutionError | undefined) => {
      const action = error === undefined ? undefined : matchRequestScopedAction(rules, error);
      const context = { provider: "meta", stateModel: "", action };
      const forced = action === "stop-and-cooldown" || action === "continue-and-cooldown";

      if (error === undefined)
        return Effect.as(picker.report(picked.success.lease, successReport(context)), action);

      // `markHTTPResponseFailure`: only credential failures (and forced cooldowns) count against the credential.
      if (
        error.status > 0 &&
        error.status < 500 &&
        !CREDENTIAL_FAILURES.has(error.status) &&
        !forced
      )
        return Effect.succeed(action);

      return Effect.as(
        picker.report(
          picked.success.lease,
          failureReport(withErrorFields(error, { credentialScoped: true }), context),
        ),
        action,
      );
    };

    const outcome = yield* Effect.result(forward(picked.success, yield* Clock.currentTimeMillis));

    if (Result.isFailure(outcome)) {
      const error = outcome.failure;

      // Not the credential's fault: answered without a report (and so without a cooldown).
      if (error.code === RELAY_FAULT) return errorJson(error.status, error.message);
      const action = yield* report(error);

      if (action === "continue" || action === "continue-and-cooldown") {
        last = { error };
        continue;
      }

      return errorJson(error.status > 0 ? error.status : 502, error.message);
    }

    const { relayed } = outcome.success;
    const now = yield* Clock.currentTimeMillis;
    // `parseRetryAfterHeader`: the upstream's Retry-After sets the cooldown.
    const retryAfterMs = parseRetryAfterMs(relayed.headers["retry-after"] ?? null, now);

    const failure =
      relayed.status < 400
        ? undefined
        : "error" in outcome.success
          ? outcome.success.error
          : new ExecutionError({
              status: relayed.status,
              message: new TextDecoder().decode(relayed.bytes),
            });

    const action = yield* report(
      failure === undefined || retryAfterMs === undefined
        ? failure
        : withErrorFields(failure, { retryAfterMs }),
    );

    if (action === "continue" || action === "continue-and-cooldown") {
      last = { relayed };
      continue;
    }

    return relayedResponse(relayed);
  }

  if (last === undefined) return errorJson(503, "Meta auth unavailable");

  return "relayed" in last
    ? relayedResponse(last.relayed)
    : errorJson(last.error.status > 0 ? last.error.status : 502, last.error.message);
});

/** Route layer; requires the {@link ClientApiServices} and `AccessPrincipal`. */
export const MuseCodeRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* routeServices<ClientApiServices>();

    for (const [path, method] of ENDPOINTS) {
      yield* router.add(method, path, Effect.provide(handle, services));
    }
  }),
);

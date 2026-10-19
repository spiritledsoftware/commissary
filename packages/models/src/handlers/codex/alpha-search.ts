/**
 * `POST /v1/alpha/search` and `POST /backend-api/codex/alpha/search`: Codex alpha search passthrough.
 *
 * Go source: internal/api/server_routes.go (codexAlphaSearch, sanitizeCodexAlphaSearchBody,
 * rewriteCodexAlphaSearchModel), sdk/cliproxy/auth/credential_policy.go. The request body (<= 16 MiB) is forwarded
 * without translation after dropping `prompt_cache_key`/`prompt_cache_retention`; the upstream status, content type
 * and body come back unchanged. OAuth credentials call the ChatGPT backend, provider keys need `alpha-search` enabled and
 * a base URL.
 */
import { Clock, Effect, Result } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { routeServices, CurrentOrg } from "@commissary/core";
import { AccessPrincipal } from "@commissary/auth";
import { CODEX_DEFAULT_BASE_URL, codexCreds } from "../../executor/codex/headers.ts";
import { ExecutionError } from "../../executor/errors.ts";
import { applyCustomHeaders } from "../../executor/helps/custom-headers.ts";
import { failureReport, successReport } from "../../executor/classify.ts";
import { withCredentialRefresh } from "../../executor/helps/credential-refresh.ts";
import { CredentialPicker, type CredentialSnapshot } from "../../executor/picker.ts";
import type { ExecutionContext } from "../../executor/types.ts";
import { UsageReporter } from "../../usage/reporter.ts";
import { allowsCodexAlphaSearch, withCredentialPolicy } from "../../executor/policy-picker.ts";
import { asString, get, isJsonObject, type Json, tryParseJson } from "@commissary/json";
import { countRequest } from "@commissary/billing/api";
import { planLimitError, uncountedWhenRefused } from "../metering.ts";
import { currentConfig, type ClientApiServices, readRequestBody } from "../request.ts";

const MAX_BODY_BYTES = 16 << 20;

const errorJson = (status: number, message: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.text(JSON.stringify({ error: message }), {
    status,
    contentType: "application/json",
    headers,
  });

/** `sanitizeCodexAlphaSearchBody`. */
const sanitizeBody = (text: string, json: Json | undefined): string => {
  if (!isJsonObject(json)) return text;
  const payload = { ...json };
  let removed = false;

  for (const field of ["prompt_cache_key", "prompt_cache_retention"]) {
    if (field in payload) {
      delete payload[field];
      removed = true;
    }
  }

  return removed ? JSON.stringify(payload) : text;
};

const upstreamHeaders = (
  credential: CredentialSnapshot,
  clientHeaders: Headers,
  sessionId: string | undefined,
): Record<string, string> => {
  const headers = new Map([
    ["content-type", "application/json"],
    ["accept", "application/json"],
    ["originator", "codex_cli_rs"],
  ]);

  for (const name of ["version", "user-agent", "session_id", "x-client-request-id"]) {
    const value = (clientHeaders.get(name) ?? "").trim();

    if (value !== "") headers.set(name, value);
  }

  const accountId = credential.metadata["account_id"];

  if (typeof accountId === "string" && accountId.trim() !== "")
    headers.set("chatgpt-account-id", accountId);
  const { providerKey } = codexCreds(credential);

  if (providerKey.trim() !== "") headers.set("authorization", `Bearer ${providerKey}`);

  return applyCustomHeaders(Object.fromEntries(headers), credential, clientHeaders, sessionId);
};

const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const identity = yield* AccessPrincipal;
  const org = yield* CurrentOrg;
  const configResult = yield* Effect.result(currentConfig);

  if (Result.isFailure(configResult))
    return errorJson(configResult.failure.status, configResult.failure.message);
  const config = configResult.success;

  const read = yield* Effect.result(readRequestBody(request));

  if (Result.isFailure(read))
    return errorJson(read.failure.status, "Failed to read search request");

  if (read.success.text.length > MAX_BODY_BYTES)
    return errorJson(413, "Failed to read search request");
  const routing = read.success.json;
  const sessionId = asString(get(routing, "id")).trim();
  const model = asString(get(routing, "model")).trim();
  const upstreamBody = sanitizeBody(read.success.text, routing);

  // The request counts against free usage once it starts being served, and a Free org over its limit is refused first.
  const counted = yield* Effect.result(countRequest);

  if (Result.isFailure(counted)) {
    const refused = planLimitError(counted.failure);

    return errorJson(refused.status, refused.message, refused.safeHeaders ?? {});
  }

  const base = yield* CredentialPicker;
  const picker = withCredentialPolicy(base, allowsCodexAlphaSearch, "Codex auth unavailable");

  const picked = yield* Effect.result(
    picker.pick({
      providers: ["codex"],
      model,
      callerScope: identity.callerScope,
      ...(identity.memberId === undefined ? {} : { memberId: identity.memberId }),
      ...(identity.principal.kind === "key" ? { apiKeyId: identity.principal.keyId } : {}),
      ...(sessionId !== "" ? { session: { id: sessionId } } : {}),
    }),
  );

  if (Result.isFailure(picked)) {
    const failure = picked.failure;
    yield* uncountedWhenRefused(counted.success, failure);
    const retryAfter = failure.safeHeaders?.["retry-after"] ?? failure.safeHeaders?.["Retry-After"];

    return errorJson(
      failure.status > 0 ? failure.status : 503,
      failure.message,
      retryAfter !== undefined ? { "retry-after": retryAfter } : {},
    );
  }

  const { credential, lease, route } = picked.success;
  const reportContext = { provider: "codex" };
  const fail = (error: ExecutionError) => picker.report(lease, failureReport(error, reportContext));

  const usage = new UsageReporter({
    requestId: crypto.randomUUID(),
    provider: "codex",
    executorType: "codex",
    model,
    alias: model,
    endpoint: "POST /v1/alpha/search",
    principalId: identity.principalId,
    orgId: org,
    ...(identity.memberId === undefined ? {} : { memberId: identity.memberId }),
    ...(credential.private === true ? { private: true } : {}),
    authId: credential.id,
    authType: credential.kind,
    source: credential.label ?? credential.id,
    stream: false,
    serviceTier: "auto",
    requestedAt: yield* Clock.currentTimeMillis,
  });

  const client = yield* HttpClient.HttpClient;
  const clientHeaders = new Headers(request.headers);

  // One attempt against `current`: a 401 fails (so the refresh helper can repeat it), everything else is answered
  // as the upstream sent it.
  const attempt = (current: ExecutionContext) =>
    Effect.gen(function* () {
      const target = current.credential;
      let url = `${CODEX_DEFAULT_BASE_URL}/alpha/search`;
      let body = upstreamBody;

      if (target.kind === "apikey") {
        const baseUrl = (target.attributes["base_url"] ?? "").trim();

        if (baseUrl === "") {
          return yield* new ExecutionError({
            status: 503,
            code: "request_scoped",
            message: "Codex Alpha Search API key base URL unavailable",
            requestScoped: true,
          });
        }

        url = `${baseUrl.replace(/\/+$/, "")}/alpha/search`;
        // Provider-key search reuses the credential-aware model resolution of the pick (prefixes, `oauth.model-alias`,
        // Provider-key aliases) so routing names are not forwarded (`ResolveExecutionModel` + rewriteCodexAlphaSearchModel).
        const upstreamModel = (route.upstreamModels[0] ?? "").trim();
        const parsed = tryParseJson(upstreamBody);

        if (
          upstreamModel !== "" &&
          isJsonObject(parsed) &&
          "model" in parsed &&
          parsed.model !== upstreamModel
        ) {
          body = JSON.stringify({ ...parsed, model: upstreamModel });
        }
      }

      const httpRequest = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyText(body, "application/json"),
        HttpClientRequest.setHeaders(upstreamHeaders(target, clientHeaders, sessionId)),
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

      const bytes = yield* response.arrayBuffer.pipe(
        Effect.orElseSucceed(() => new ArrayBuffer(0)),
      );

      const contentType = response.headers["content-type"];

      if (response.status === 401) {
        return yield* new ExecutionError({
          status: 401,
          message: new TextDecoder().decode(bytes),
          ...(contentType !== undefined ? { headers: { "content-type": contentType } } : {}),
        });
      }

      return { status: response.status, bytes, contentType };
    });

  const outcome = yield* Effect.result(
    withCredentialRefresh({ credential, config, usage }, attempt),
  );

  if (Result.isFailure(outcome)) {
    const error = outcome.failure;
    yield* fail(error);

    if (error.status === 401) {
      const contentType = error.headers?.["content-type"];

      return HttpServerResponse.text(error.message, {
        status: 401,
        ...(contentType !== undefined ? { contentType } : {}),
      });
    }

    return errorJson(error.status, error.message);
  }

  const result = outcome.success;
  yield* picker.report(
    lease,
    result.status >= 200 && result.status < 300
      ? successReport(reportContext)
      : failureReport(
          new ExecutionError({
            status: result.status,
            message: `alpha search failed (${result.status})`,
          }),
          reportContext,
        ),
  );

  return HttpServerResponse.uint8Array(new Uint8Array(result.bytes), {
    status: result.status,
    ...(result.contentType !== undefined ? { contentType: result.contentType } : {}),
  });
});

/** Route layer; requires the {@link ClientApiServices} and `AccessPrincipal`. */
export const AlphaSearchRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* routeServices<ClientApiServices>();
    yield* router.add("POST", "/v1/alpha/search", Effect.provide(handle, services));
    yield* router.add("POST", "/backend-api/codex/alpha/search", Effect.provide(handle, services));
  }),
);

/**
 * The hub API's routes (ADR 0052), which the API Worker mounts behind its hub gate (a management key acting as its
 * issuer, `@commissary/auth`'s `authenticateManagementKey`). The three routes of Go's management API that allowance
 * readers such as T3 Code poll (internal/api/handlers/management/auth_files.go, api_tools.go, quota.go), answered in
 * Go's shapes where they read them:
 *
 * - `GET /v0/management/auth-files`: `{ files }`, the accounts the key's issuer manages in full (`accounts.ts`);
 * - `POST /v0/management/api-call`: `{ status_code, body }` of one of the fixed relayed calls (`calls.ts`, `relay.ts`);
 * - `POST /v0/management/reset-quota`: `{ status, auth_index, models }`, as `POST /v9/management/routing/cooldown/reset`.
 *
 * Each relayed call leaves one log line (who, which account, which entry, the provider's status), never a body or a
 * token; nothing is stored. Every answer is JSON.
 */
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpRouter,
  type HttpServerRequest,
  type HttpServerResponse,
} from "effect/http";
import { AccessPrincipal, currentViewer } from "@commissary/auth";
import {
  type CurrentOrg,
  handled,
  HUB_API_PREFIX,
  jsonReply,
  OutboundHttpClientLive,
  replyError,
} from "@commissary/core";
import { type Json } from "@commissary/json";
import { bodyObject } from "@commissary/state";
import { text } from "../quota/account-ids.ts";
import { type ModelsEnv, modelsControlPlane } from "../env.ts";
import { CALL_NOT_ALLOWED, matchHubCall } from "./calls.ts";
import { relayHubCall } from "./relay.ts";

const AUTH_NOT_FOUND = "auth not found";

/** The `auth_index` of a JSON body; 400 without one. */
const authIndexOf = (body: Readonly<Record<string, Json>>) => {
  const authIndex = text(body.auth_index);

  return authIndex === ""
    ? Effect.fail(replyError(400, "auth_index is required"))
    : Effect.succeed(authIndex);
};

const listAuthFiles = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  const files = yield* modelsControlPlane("listHubAccounts", (stub) =>
    stub.models().listHubAccounts(viewer),
  );

  return jsonReply(200, { files });
});

const apiCall = Effect.gen(function* () {
  const body = yield* bodyObject;
  const authIndex = yield* authIndexOf(body);
  // `header` is accepted and never read: Commissary builds every header itself.
  const matched = matchHubCall(text(body.method), text(body.url), body.data);

  if (!matched.ok) return yield* replyError(400, matched.error);
  const { call } = matched;
  const viewer = yield* currentViewer;

  const target = yield* modelsControlPlane("hubCallTarget", (stub) =>
    stub
      .models()
      .hubCallTarget(authIndex, call.entry.provider, viewer, call.entry.body === "project"),
  );

  if (!target.ok)
    switch (target.error) {
      case "not_found":
        return yield* replyError(404, AUTH_NOT_FOUND);
      case "wrong_provider":
        return yield* replyError(400, CALL_NOT_ALLOWED);
      case "unavailable":
        return yield* replyError(503, "token unavailable", { message: target.message });
    }

  const identity = yield* AccessPrincipal;

  const answer = yield* relayHubCall(call, target.target).pipe(
    Effect.tapError((failure) =>
      Effect.logWarning("relayed call failed").pipe(
        Effect.annotateLogs({
          principal: identity.principalId,
          auth_index: authIndex,
          call: call.entry.id,
          failure: failure.message,
        }),
      ),
    ),
    Effect.mapError((failure) =>
      replyError(502, "upstream request failed", { message: failure.message }),
    ),
  );

  yield* Effect.logInfo("relayed call sent").pipe(
    Effect.annotateLogs({
      principal: identity.principalId,
      auth_index: authIndex,
      call: call.entry.id,
      status: answer.status,
    }),
  );

  return jsonReply(200, { status_code: answer.status, body: answer.text });
});

const resetQuota = Effect.gen(function* () {
  const authIndex = yield* authIndexOf(yield* bodyObject);
  const viewer = yield* currentViewer;

  const result = yield* modelsControlPlane("resetHubCooldown", (stub) =>
    stub.models().resetHubCooldown(authIndex, viewer),
  );

  if (!result.ok) return yield* replyError(404, AUTH_NOT_FOUND);

  return jsonReply(200, { status: "ok", auth_index: result.authIndex, models: result.models });
});

/** The hub API's routes; needs an `HttpClient` for the relayed calls ({@link HubApiLayer} gives the guarded one). */
export const HubRoutes = HttpRouter.addAll(
  Effect.gen(function* () {
    // Bound once per isolate instead of leaking into the request context.
    const client = yield* HttpClient.HttpClient;

    const bound = <
      R extends
        | AccessPrincipal
        | HttpClient.HttpClient
        | ModelsEnv
        | CurrentOrg
        | HttpServerRequest.HttpServerRequest,
    >(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
    ) => Effect.provideService(handler, HttpClient.HttpClient, client);

    return [
      HttpRouter.route("GET", `${HUB_API_PREFIX}/auth-files`, handled(listAuthFiles)),
      HttpRouter.route("POST", `${HUB_API_PREFIX}/api-call`, bound(handled(apiCall))),
      HttpRouter.route("POST", `${HUB_API_PREFIX}/reset-quota`, handled(resetQuota)),
    ];
  }),
);

/**
 * The hub API's routes with the global `fetch` behind the outbound guard. Handlers read `AccessPrincipal` and
 * `CurrentOrg`: the Worker wraps the layer with its hub gate.
 */
export const HubApiLayer = HubRoutes.pipe(Layer.provide(OutboundHttpClientLive));

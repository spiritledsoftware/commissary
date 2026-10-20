/**
 * `GET /v1/models[/{id}]`, `GET /v1beta/models[/{model}]`.
 *
 * Go source: internal/api/server_routes.go (routes at :66-67 and :131-134, `unifiedModelsHandler`). Authentication is
 * the Access gate (`withAccess` on the layer in `http/app.ts`).
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type AccessIdentity, AccessPrincipal } from "@commissary/auth";
import { buildCodexClientModels, supportsApplyPatchProviders } from "./codex-client-models.ts";
import {
  respondGeminiDetail,
  respondGeminiList,
  respondModels,
  type ModelsReply,
} from "./models-api.ts";
import { callerView, runModelFilter } from "./caller-view.ts";
import { ModelRegistry, type RegistrySnapshot } from "./service.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const toResponse = (reply: ModelsReply) =>
  HttpServerResponse.text(reply.body, { status: reply.status, contentType: JSON_CONTENT_TYPE });

/** `handlers.ErrorResponse` (struct key order). */
const registryUnavailable = HttpServerResponse.text(
  '{"error":{"message":"Model registry unavailable","type":"server_error"}}',
  { status: 500, contentType: JSON_CONTENT_TYPE },
);

/** Path after `prefix`, percent-decoded like Go's `URL.Path`; `undefined` when the path is exactly the prefix. */
const remainder = (pathname: string, prefix: string): string | undefined => {
  if (pathname === prefix) return undefined;
  const rest = pathname.slice(prefix.length + 1);

  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
};

type Registry = ModelRegistry["Service"];

/** The models the caller may name: an agent run's list is its definition's model alone (#227). */
const callerModels = (snapshot: RegistrySnapshot, identity: AccessIdentity) => {
  const only = runModelFilter(identity);
  const models = snapshot.availableModels();

  return only === undefined ? models : models.filter((model) => only(model.id));
};

const v1Models = (registry: Registry) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.originalUrl, "http://localhost");
    const identity = yield* AccessPrincipal;
    const snapshot = callerView(yield* registry.snapshot, identity);

    const reply = respondModels(
      callerModels(snapshot, identity),
      {
        userAgent: request.headers["user-agent"] ?? "",
        anthropicVersion: request.headers["anthropic-version"] ?? "",
        clientVersion: url.searchParams.get("client_version") ?? undefined,
      },
      {
        disableCloaking: snapshot.config.upstream.claude["disable-cloaking-model-list"],
        codexClient: (models, clientVersion) =>
          buildCodexClientModels({
            catalog: snapshot.catalogs.codexClient,
            models,
            providersForModel: snapshot.providersForModel,
            lookupModelInfo: (modelId, provider = "") =>
              snapshot.lookupModelInfo(modelId, provider),
            webSearchCapability: snapshot.responsesWebSearchCapability,
            ...(snapshot.config.client.codex["enable-apply-patch"]
              ? {
                  applyPatchCapability: (modelId: string) =>
                    supportsApplyPatchProviders(snapshot.providersForModel(modelId)),
                }
              : {}),
            optimizeMultiAgentV2: snapshot.config.client.codex["optimize-multi-agent-v2"],
            clientVersion,
          }),
      },
      remainder(url.pathname, "/v1/models"),
    );

    return toResponse(reply);
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(`GET /v1/models failed: ${error._tag}: ${error.message}`).pipe(
        Effect.as(registryUnavailable),
      ),
    ),
  );

const v1betaModels = (registry: Registry) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.originalUrl, "http://localhost");
    const identity = yield* AccessPrincipal;
    const models = callerModels(callerView(yield* registry.snapshot, identity), identity);
    const action = remainder(url.pathname, "/v1beta/models");

    return toResponse(
      action === undefined ? respondGeminiList(models) : respondGeminiDetail(models, action),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(`GET /v1beta/models failed: ${error._tag}: ${error.message}`).pipe(
        Effect.as(registryUnavailable),
      ),
    ),
  );

// A `/*` route also answers its bare prefix (`/v1/models`), so one route per family covers list and detail.
export const ModelRoutes = HttpRouter.addAll(
  Effect.gen(function* () {
    const registry = yield* ModelRegistry;

    return [
      HttpRouter.route("GET", "/v1/models/*", v1Models(registry)),
      HttpRouter.route("GET", "/v1beta/models/*", v1betaModels(registry)),
    ];
  }),
);

/**
 * Models' management API routes (`/v9/management/*`): the app Worker's `management/routes.ts` mounts them next to its
 * own (#134 "The area package convention"). Authorization is the app Worker's Access gate and role table, which takes
 * Models' entries from `access-rules.ts`.
 *
 * Go source: internal/api/server_management_v8.go (route table). OAuth login (`/oauth/*`) is in `oauth-routes.ts`;
 * the batch account actions (`/credentials/batch`) in `credentials-batch.ts`; usage (`/observability/usage/*`) is in
 * `usage-routes.ts`; the per-model routing view (`/routing/models`) in `routing-models.ts` and its channel rule edits
 * (`/model-rules/*`) in `model-rules-routes.ts`; the Settings page (`/settings`) and the config import
 * (`/settings/import`) in `settings-routes.ts`; Claude reset grants (`/credentials/reset-grants`) in
 * `reset-grant-routes.ts`; the model catalog's status and on-demand refresh (`/models/catalog`) in `catalog-routes.ts`.
 */
import { Effect, Layer } from "effect";
import {
  type HttpClient,
  HttpRouter,
  type HttpServerRequest,
  type HttpServerResponse,
} from "effect/http";
import type { AccessPrincipal, AuthConfig } from "@commissary/auth";
import { type CurrentOrg, OutboundHttpClientLive, routeServices } from "@commissary/core";
import type { StateEnv } from "@commissary/state";
import type { ModelsEnv } from "../env.ts";
import { CatalogStore } from "../registry/catalog-store.ts";
import { ModelRegistryLive } from "../registry/live.ts";
import type { ModelRegistry } from "../registry/service.ts";
import { catalogRefreshHandler, catalogStatusHandler } from "./catalog-routes.ts";
import { credentialsBatchHandler } from "./credentials-batch.ts";
import { credentialModelsHandler, credentialRoutes } from "./credentials-routes.ts";
import { grantRoutes, myModelsHandler } from "./grant-routes.ts";
import { modelRuleRoutes } from "./model-rules-routes.ts";
import { oauthRoutes } from "./oauth-routes.ts";
import { priceRoutes } from "./price-routes.ts";
import { providerKeyProbeHandler, providerKeysRoutes } from "./provider-keys-routes.ts";
import { quotaCheckHandler, quotaSweepHandler } from "./quota-routes.ts";
import { claimResetGrantHandler, resetGrantsHandler } from "./reset-grant-routes.ts";
import { routingModelsHandler } from "./routing-models.ts";
import { settingsRoutes } from "./settings-routes.ts";
import { spendRoutes } from "./spend-routes.ts";
import { usageRoutes } from "./usage-routes.ts";

const BASE = "/v9/management";

/** Models' management routes; needs `ModelRegistry`, the `CatalogStore` and an `HttpClient`. */
export const ManagementRoutes = HttpRouter.addAll(
  Effect.gen(function* () {
    // Handlers run per request: bind the isolate-wide services once instead of leaking them into the request context.
    const services = yield* routeServices<ModelRegistry | HttpClient.HttpClient | CatalogStore>();

    const bound = <
      R extends
        | AccessPrincipal
        | ModelRegistry
        | HttpClient.HttpClient
        | CatalogStore
        | ModelsEnv
        | StateEnv
        | AuthConfig
        | CurrentOrg
        | HttpServerRequest.HttpServerRequest,
    >(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
    ) => Effect.provide(handler, services);

    return [
      ...modelRuleRoutes,
      ...providerKeysRoutes,
      ...settingsRoutes,
      ...credentialRoutes,
      ...usageRoutes,
      ...oauthRoutes,
      ...priceRoutes,
      ...grantRoutes,
      ...spendRoutes,
      HttpRouter.route("GET", `${BASE}/credentials/models`, bound(credentialModelsHandler)),
      HttpRouter.route("POST", `${BASE}/credentials/batch`, credentialsBatchHandler),
      HttpRouter.route("POST", `${BASE}/credentials/quota`, bound(quotaCheckHandler)),
      HttpRouter.route("POST", `${BASE}/credentials/quota/all`, bound(quotaSweepHandler)),
      HttpRouter.route("GET", `${BASE}/credentials/reset-grants`, bound(resetGrantsHandler)),
      HttpRouter.route(
        "POST",
        `${BASE}/credentials/reset-grants/claim`,
        bound(claimResetGrantHandler),
      ),
      HttpRouter.route("POST", `${BASE}/provider-keys/probe`, bound(providerKeyProbeHandler)),
      HttpRouter.route("GET", `${BASE}/routing/models`, bound(routingModelsHandler)),
      HttpRouter.route("GET", `${BASE}/models/mine`, bound(myModelsHandler)),
      HttpRouter.route("GET", `${BASE}/models/catalog`, bound(catalogStatusHandler)),
      HttpRouter.route("POST", `${BASE}/models/catalog/refresh`, bound(catalogRefreshHandler)),
    ];
  }),
);

/**
 * The services of {@link ManagementRoutes} in production: the ControlPlane-backed model registry and the global `fetch`
 * behind the outbound guard (a probe or quota check reaches a provider's `base_url`, ADR 0044).
 */
export const ManagementServicesLive = Layer.mergeAll(
  ModelRegistryLive,
  OutboundHttpClientLive,
  CatalogStore.layer,
);

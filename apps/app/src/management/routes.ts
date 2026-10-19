/**
 * Management API routes (`/v9/management/*`), the control panel (`apps/web`, at `/`) and the old panel's address
 * (`/management.html`, a redirect to `/`): the Worker's org-wide routes and each area's, listed explicitly (#134 "The
 * area package convention"; Models' are `models/management/routes.ts`).
 *
 * Go source: internal/api/server_management_v8.go (route table). Authorization is the Access admin gate
 * (`zones.ts`: the whole `/v9/management` prefix, the panel paths and `/management.html`), which replaces the
 * Go management key, IP ban and `allow-remote` logic. Routes that are not ported: plugins, Home, the file-log routes,
 * `GET /server/latest-version`, the static `routing/model-definitions/:channel` catalog, `GET /oauth/callback` and
 * `GET /observability/usage/api-keys` (all four only fed the upstream panel; the control panel reads
 * `routing/models`, `credentials/models`, `POST /oauth/callback` and `provider-keys`), the deprecated `/v0/management`
 * tree, `POST /requests/api-call` (the upstream panel's token-substituting upstream probe; quota and key checks and
 * Claude reset grants run server-side, so tokens never leave the Worker), and the upstream panel page itself (Go serves it at
 * `/management.html`; here that path redirects to `/`). The upstream panel's `X-CPA-Version` and
 * `X-CPA-Support-Plugin` response headers are not sent. The org's members, teams and service tokens (`/members`,
 * `/membership`, `/teams`, `/service-tokens`) are in `member-routes.ts`; Commissary Cloud's per-org single sign-on
 * (`/sso*`) in `sso-routes.ts`; Commissary Cloud's billing (`/billing`) is `@commissary/billing`'s.
 */
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { LEGACY_PANEL_PATH } from "./zones.ts";
import {
  ManagementRoutes as ModelsManagementRoutes,
  ManagementServicesLive as ModelsManagementServicesLive,
} from "@commissary/models/management";
import { BillingRoutes } from "@commissary/billing/management";
import { memberRoutes } from "./member-routes.ts";
import { orgRoutes } from "./org-routes.ts";
import { peopleRoutes } from "./people-routes.ts";
import { managementKeyRoutes } from "./management-key-routes.ts";
import { ssoRoutes } from "./sso-routes.ts";
import { apiKeyRoutes } from "./api-key-routes.ts";
import {
  LEGACY_PANEL_REDIRECT,
  PANEL_PAGE_PATHS,
  webPanelAsset,
  webPanelPage,
} from "./web-panel.ts";

/** The Worker's own management routes and the panel. */
const OrgWideRoutes = HttpRouter.addAll([
  ...orgRoutes,
  ...peopleRoutes,
  ...memberRoutes,
  ...apiKeyRoutes,
  ...managementKeyRoutes,
  ...ssoRoutes,
  HttpRouter.route("GET", LEGACY_PANEL_PATH, LEGACY_PANEL_REDIRECT),
  ...PANEL_PAGE_PATHS.map((path) => HttpRouter.route("GET", path, webPanelPage)),
  HttpRouter.route("GET", "/assets/*", webPanelAsset),
]);

/**
 * All management routes: the Worker's own and each area's (Models', Billing's). Models' need `ModelRegistry`, the
 * `CatalogStore` and an `HttpClient`.
 */
export const ManagementRoutes = Layer.mergeAll(
  OrgWideRoutes,
  ModelsManagementRoutes,
  BillingRoutes,
);

/** Production wiring: each area's services. Wrap with `withAccess(...)`. */
export const ManagementRoutesLive = ManagementRoutes.pipe(
  Layer.provide(ModelsManagementServicesLive),
);

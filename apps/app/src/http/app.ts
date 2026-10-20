import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AccessLayer, withAccess } from "../access/layer.ts";
import { orgAddressing } from "../management/org-address.ts";
import { HostedRoutes } from "../hosted/routes.ts";
import { McpOAuthServerRoutes } from "../hosted/mcp-oauth.ts";
import { ManagementRoutesLive } from "../management/routes.ts";
import { BillingWebhookRoutes } from "@commissary/billing/management";
import { WorkersLoggerLayer } from "@commissary/core";
import { TraceLayer } from "@commissary/models/api";
import { OAuthCallbackRoutes } from "@commissary/models/management";
import { ProtectedResourceMetadataRoutes } from "@commissary/tools/management";
import { AppMcpRoutes } from "./mcp.ts";
import { RootRoutes } from "./routes.ts";

/**
 * All routes and global middleware of the app Worker: the panel, its sign-in, the management API and, on a self-hosted
 * Commissary, the MCP endpoint behind Access (ADR 0045). The client API is the API Worker's (apps/api, ADR 0030). Route
 * layers whose handlers use `AccessPrincipal` are wrapped with `withAccess(...)` (src/access/layer.ts); the management
 * zone is authenticated by `AccessLayer` regardless.
 */
export const AppLayer = Layer.mergeAll(
  RootRoutes,
  OAuthCallbackRoutes,
  // Sign-in of Commissary Cloud (ADR 0026); unknown paths on a self-hosted one.
  HostedRoutes,
  // Polar's webhooks (Commissary Cloud with Polar's settings, #237): public, the signature is the credential.
  BillingWebhookRoutes,
  // Commissary Cloud's OAuth server for MCP clients (#200): its public endpoints, and the MCP endpoint's metadata on a
  // stage with one host; unknown paths elsewhere.
  McpOAuthServerRoutes,
  ProtectedResourceMetadataRoutes,
  AccessLayer,
  withAccess(ManagementRoutesLive),
  // The MCP endpoint behind Access, for MCP clients Access signs in (ADR 0045); the Access gate refuses it on
  // Commissary Cloud, whose MCP clients use the API host's.
  withAccess(AppMcpRoutes),
  // Request trace id header and structured request logs (packages/models/src/observability).
  TraceLayer,
  WorkersLoggerLayer,
);

/**
 * Creates the Web `Request` handler. Per-request services (the env views, `WorkerExecutionContext`) are supplied as
 * the second argument of `handler`; see `requestContext` in `worker-env.ts`.
 */
export const makeWebHandler = () =>
  HttpRouter.toWebHandler(AppLayer, { disableLogger: true, middleware: orgAddressing });

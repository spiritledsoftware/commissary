import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { WorkersLoggerLayer } from "@commissary/core";
import { ClientApiLayer as ModelsClientApi, TraceLayer } from "@commissary/models/api";
import {
  ClientApiLayer as ToolsClientApi,
  ProtectedResourceMetadataRoutes,
} from "@commissary/tools/api";
import { behindGate, GateLayer } from "./gate.ts";
import { RootRoutes } from "./routes.ts";

/**
 * All routes and global middleware of the API Worker (ADR 0030): `/healthz` and the client API of each area it mounts,
 * listed here explicitly (Models' model routes, Tools' MCP endpoint), behind CORS and the client gate (`gate.ts`).
 */
export const ApiLayer = Layer.mergeAll(
  RootRoutes,
  // Public: the MCP endpoint's OAuth metadata on Commissary Cloud (#200), unknown elsewhere.
  ProtectedResourceMetadataRoutes,
  GateLayer,
  behindGate(Layer.mergeAll(ModelsClientApi, ToolsClientApi)),
  // Request trace id header and structured request logs (packages/models/src/observability).
  TraceLayer,
  WorkersLoggerLayer,
);

/**
 * Creates the Web `Request` handler. Per-request services (the env views, `WorkerExecutionContext`) are supplied as
 * the second argument of `handler`; see `requestContext` in `worker-env.ts`.
 */
export const makeWebHandler = () => HttpRouter.toWebHandler(ApiLayer, { disableLogger: true });

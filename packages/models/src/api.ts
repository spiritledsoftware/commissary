/**
 * `@commissary/models/api`, Models' entry for the API Worker (#134 "The area package convention"): its client API
 * routes, the hub API's routes (ADR 0052), its cron tasks and its view of `env`. The apps import Models only through this entry, `./management` and
 * `./state` (the lint rule `boundaries/models-imports`).
 */
import { Layer } from "effect";
import { ClientApiLayer as ProtocolRoutes } from "./handlers/layer.ts";
import { ModelRoutesLive } from "./registry/live.ts";

export { type ModelsBindings, ModelsEnv } from "./env.ts";

export { HubApiLayer } from "./hub/routes.ts";

export { TraceLayer } from "./observability/trace.ts";

export { scheduledTasks, ScheduledTaskLayer } from "./scheduled-tasks.ts";

/**
 * The client API routes with their production services: the protocol handlers (OpenAI, Responses, Claude, Gemini, …)
 * and the model listings. Handlers read `AccessPrincipal`: the Worker wraps the layer with its Access gate.
 */
export const ClientApiLayer = Layer.mergeAll(ProtocolRoutes, ModelRoutesLive);

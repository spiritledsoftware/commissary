/**
 * The state Worker (ADR 0030, #128): it defines the Durable Objects `ControlPlane`, `SessionState` and `Platform`, and
 * the other Workers bind them by script name (alchemy.run.ts); and `BrowserSession`, one per browser session of the
 * browser toolkit (#213), which only its own ControlPlane reaches. It also defines the sandbox toolkit's
 * `SandboxSession` objects (#222), which only its ControlPlane reaches, and exports the two entrypoints their Dynamic
 * Workers reach over `ctx.exports`: `SandboxEgress`, the sandbox's one egress point, and `WorkspaceServiceProxy`, their
 * files. It has no routes, no domain and no workers.dev URL.
 * Deploying a Worker restarts the Durable Objects it defines; this one changes only when their code does, so a client
 * API or panel change no longer restarts them.
 *
 * The classes live in the packages; this entry only composes the ControlPlane with the areas' parts and exports them.
 * Its `env` (src/env.d.ts) is what the classes read: `@commissary/state`'s `StateObjectEnv` and each part's view.
 */
export { ControlPlane } from "./control-plane.ts";

// `SessionState` holds the replay/continuity caches; the Responses WebSocket keeps its state in the Worker invocation
// that accepted the socket, not there (see docs/ARCHITECTURE.md).
export { Platform, SessionState } from "@commissary/state";

export {
  BrowserSession,
  SandboxEgress,
  SandboxSession,
  WorkspaceServiceProxy,
} from "@commissary/tools/state";

export default {
  fetch: () => new Response("the state Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;

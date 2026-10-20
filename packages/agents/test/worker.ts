// The test Worker's entry (vitest.config.ts): a test-only ControlPlane, `@commissary/state`'s org-wide base composed
// with the Agents part the way a Worker composes it (`composeControlPlane`), the Platform registry and SessionState, on
// real SQLite storage. Agents' tests depend on no other area and on no app.
import { composeControlPlane } from "@commissary/state";
import { AgentsPart } from "../src/state.ts";

export { Platform, SessionState } from "@commissary/state";

export class ControlPlane extends composeControlPlane({
  agents: (ctx, _env, core) => new AgentsPart(ctx, core),
}) {}

export default {
  fetch: () => new Response("Agents' test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;

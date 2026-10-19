// The test Worker's entry (vitest.config.ts, project `tools`): a test-only ControlPlane, `@commissary/state`'s org-wide
// base composed with the Tools part the way a Worker composes it (`composeControlPlane`), the Platform registry and
// SessionState, on real SQLite storage. Tools' tests depend on no other area and on no app.
import { composeControlPlane } from "@commissary/state";
import { ToolsPart } from "../src/state.ts";

export { Platform, SessionState } from "@commissary/state";

export class ControlPlane extends composeControlPlane({
  tools: (ctx, _env, core) => new ToolsPart(ctx, core),
}) {}

export default {
  fetch: () => new Response("Tools' test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;

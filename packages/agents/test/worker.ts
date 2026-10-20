// The test Worker's entry (vitest.config.ts): a test-only ControlPlane, `@commissary/state`'s org-wide base composed
// with the Agents part the way a Worker composes it (`composeControlPlane`), the Platform registry and SessionState, on
// real SQLite storage. Agents' tests depend on no other area and on no app.
import { composeControlPlane } from "@commissary/state";
import { type AgentRunEnv, AgentRunObject, type RunGateway } from "../src/api.ts";
import { AgentsPart } from "../src/state.ts";

export { Platform, SessionState } from "@commissary/state";

export class ControlPlane extends composeControlPlane({
  agents: (ctx, _env, core) => new AgentsPart(ctx, core),
}) {}

const NO_CLIENT_API: RunGateway = {
  serve: async () => new Response("no client API in Agents' tests", { status: 503 }),
};

/**
 * The agent runs' object (`AGENT_RUN`, #227) without the API Worker: its run gateway answers every request `503`, so a
 * run's turn fails at its first model call. The run's model and tool calls are tested with the API Worker's gateway in
 * the app Worker's tests (apps/app/test/agent-runs.test.ts).
 */
export class AgentRun extends AgentRunObject {
  constructor(ctx: DurableObjectState, env: AgentRunEnv) {
    super(ctx, env, { gateway: () => NO_CLIENT_API });
  }
}

export default {
  fetch: () => new Response("Agents' test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;

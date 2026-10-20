// The test Worker's entry (vitest.config.ts): a test-only ControlPlane, `@commissary/state`'s org-wide base composed
// with the Agents part the way a Worker composes it (`composeControlPlane`), the Platform registry and SessionState, on
// real SQLite storage. Agents' tests depend on no other area and on no app.
import { composeControlPlane } from "@commissary/state";
import {
  type AgentRunEnv,
  AgentRunObject,
  AgentScheduleObject,
  type RunGateway,
} from "../src/api.ts";
import { AgentsPart } from "../src/state.ts";

export { Platform, SessionState } from "@commissary/state";

export class ControlPlane extends composeControlPlane({
  agents: (ctx, _env, core) => new AgentsPart(ctx, core),
}) {}

/** The storage key by which a test marks a run's object unreachable for deliveries. */
export const UNREACHABLE = "test:unreachable";

/**
 * No client API: every request answers `404`, a status the model client (pi-ai) does not retry, so a turn fails at once.
 * A `503` it would retry with backoff, seconds per turn, which made the tests' waits depend on the runner's speed.
 */
const NO_CLIENT_API: RunGateway = {
  serve: async () => new Response("no client API in Agents' tests", { status: 404 }),
};

/**
 * The agent runs' object (`AGENT_RUN`, #227) without the API Worker: its run gateway answers every request `404`, so a
 * run's turn fails at its first model call. The run's model and tool calls are tested with the API Worker's gateway in
 * the app Worker's tests (apps/app/test/agent-runs.test.ts).
 */
export class AgentRun extends AgentRunObject {
  constructor(ctx: DurableObjectState, env: AgentRunEnv) {
    super(ctx, env, { gateway: () => NO_CLIENT_API });
  }

  /**
   * A test marks a run unreachable ({@link UNREACHABLE} in its storage): a child run's deliveries to it fail as to a
   * parent whose ControlPlane cannot be reached (#229).
   */
  override async deliver(child: Parameters<AgentRunObject["deliver"]>[0]) {
    if (this.ctx.storage.kv.get(UNREACHABLE) === true)
      return { ok: false, error: "unavailable", message: "unreachable in this test" } as const;

    return await super.deliver(child);
  }
}

/** The schedule triggers' object (`AGENT_SCHEDULE`, #231), as the API Worker defines it. */
export class AgentSchedule extends AgentScheduleObject {}

export default {
  fetch: () => new Response("Agents' test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;

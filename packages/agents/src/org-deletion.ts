/**
 * Agents' step of deleting an org (ADR 0027, #134 "Org deletion and crons"). Agents keeps its agents, their grants and
 * the org's index of runs in the org's ControlPlane, whose tables go with `wipeOrg` (`AgentsPart.wipe`). Each run's
 * transcript and turns are its own Durable Object's (`AGENT_RUN`, #227), which the ControlPlane cannot reach (the API
 * Worker defines it): this step, run by the app Worker, deletes each run's object (`purge`) a page at a time, then
 * forgets the page in the index, before `wipeOrg` drops the index.
 */
import { Effect } from "effect";
import type { OrgDeletionStep } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import { type AgentsBindings, type AgentsControlPlaneStub, AgentsEnv, agentRunOf } from "./env.ts";

/** Runs deleted per call of the ControlPlane: each is one call of its own object. */
const RUN_PAGE = 20;

/** Deletes the org's runs' objects, a page at a time within `budget` (one ControlPlane call and one per run). */
export const deleteOrgRuns =
  (env: Pick<AgentsBindings, "CONTROL_PLANE" | "AGENT_RUN">): OrgDeletionStep =>
  async (org, budget) => {
    let calls = 0;

    for (;;) {
      if (budget - calls < RUN_PAGE + 2) return { complete: false, calls, part: "runs" };
      const stub: AgentsControlPlaneStub = controlPlaneOf(env, org);
      const part = stub.agents();
      const { ids } = await part.runsPage(RUN_PAGE);

      calls += 1;

      if (ids.length === 0) return { complete: true, calls };

      await Promise.all(ids.map(async (id) => await agentRunOf(env, org, id).purge()));
      await part.forgetRuns(ids);
      calls += ids.length + 1;
    }
  };

/** Agents' step over the invocation's bindings. */
export const orgDeletionStep: Effect.Effect<OrgDeletionStep, never, AgentsEnv> = Effect.gen(
  function* () {
    return deleteOrgRuns(yield* AgentsEnv);
  },
);

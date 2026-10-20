/**
 * Agents' step of deleting an org (ADR 0027, #134 "Org deletion and crons"). Agents keeps its agents, their grants,
 * their triggers and the org's index of runs in the org's ControlPlane, whose tables go with `wipeOrg`
 * (`AgentsPart.wipe`). Each schedule's ticks are its own Durable Object's (`AGENT_SCHEDULE`, #231) and each run's
 * transcript and turns its own (`AGENT_RUN`, #227), which the ControlPlane cannot reach (the API Worker defines them):
 * this step, run by the app Worker, deletes each schedule's object first (its alarm would start runs), every one that
 * may exist (`agent_schedule_objects`: removed schedules' too), then each run's (`purge`), a page at a time, forgetting
 * each page in the ControlPlane, before `wipeOrg` drops the tables.
 *
 * {@link sweepRetiredSchedules} deletes, the same way, the objects of schedules removed with their agent or their
 * member, which the ControlPlane cannot delete itself: Agents' routes call it after removing a trigger or an agent, and
 * the app Worker after a member leaves or is removed.
 */
import { Effect } from "effect";
import type { OrgDeletionStep, OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import {
  type AgentsBindings,
  type AgentsControlPlaneStub,
  AgentsEnv,
  agentRunOf,
  agentScheduleOf,
} from "./env.ts";

/** Objects deleted per call of the ControlPlane: each is one call of its own object. */
const PAGE = 20;

/**
 * Deletes the org's schedules' and runs' objects, a page at a time within `budget` (one ControlPlane call and one per
 * object).
 */
export const deleteOrgRuns =
  (env: Pick<AgentsBindings, "CONTROL_PLANE" | "AGENT_RUN" | "AGENT_SCHEDULE">): OrgDeletionStep =>
  async (org, budget) => {
    let calls = 0;

    const part = () => {
      const stub: AgentsControlPlaneStub = controlPlaneOf(env, org);

      return stub.agents();
    };

    for (;;) {
      if (budget - calls < PAGE + 2) return { complete: false, calls, part: "schedules" };
      const ids = await part().scheduleObjectsPage(PAGE);

      calls += 1;

      if (ids.length === 0) break;

      await Promise.all(ids.map(async (id) => await agentScheduleOf(env, org, id).purge()));
      await part().forgetScheduleObjects(ids);
      calls += ids.length + 1;
    }

    for (;;) {
      if (budget - calls < PAGE + 2) return { complete: false, calls, part: "runs" };
      const { ids } = await part().runsPage(PAGE);

      calls += 1;

      if (ids.length === 0) return { complete: true, calls };

      await Promise.all(ids.map(async (id) => await agentRunOf(env, org, id).purge()));
      await part().forgetRuns(ids);
      calls += ids.length + 1;
    }
  };

/** Sweeps per call at most: a member's or an agent's schedules are few, and the next sweep finds the rest. */
const SWEEP_PAGES = 3;

/**
 * Deletes the objects of `org`'s schedules that are gone (removed, or with their agent or its member) and forgets them,
 * a page at a time, at most {@link SWEEP_PAGES} pages. Best effort: a failure leaves them for the next sweep or the
 * org's deletion, and each finds its schedule gone at its next alarm meanwhile.
 */
export const sweepRetiredSchedules = (
  env: Pick<AgentsBindings, "CONTROL_PLANE" | "AGENT_SCHEDULE">,
  org: OrgId,
): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const stub: AgentsControlPlaneStub = controlPlaneOf(env, org);

    for (let page = 0; page < SWEEP_PAGES; page += 1) {
      const ids = await stub.agents().retiredSchedules(PAGE);

      if (ids.length === 0) return;
      await Promise.all(ids.map(async (id) => await agentScheduleOf(env, org, id).purge()));
      await stub.agents().forgetScheduleObjects(ids);
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("agent schedules: sweep failed").pipe(
        Effect.annotateLogs({ org, detail: String(error) }),
      ),
    ),
  );

/** Agents' step over the invocation's bindings. */
export const orgDeletionStep: Effect.Effect<OrgDeletionStep, never, AgentsEnv> = Effect.gen(
  function* () {
    return deleteOrgRuns(yield* AgentsEnv);
  },
);

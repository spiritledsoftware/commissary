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
 * One kind of object the ControlPlane lists for deletion: the next page of their ids, deleting one object (its own
 * Durable Object's `purge`), and forgetting the ids of those deleted.
 */
export interface ObjectSweep {
  readonly page: (limit: number) => Promise<ReadonlyArray<string>>;
  readonly purge: (id: string) => Promise<void>;
  readonly forget: (ids: ReadonlyArray<string>) => Promise<void>;
}

/** What a sweep did: its calls, the objects it deleted, and whether none is left (`complete`). */
export interface Swept {
  readonly calls: number;
  readonly purged: number;
  readonly complete: boolean;
  /** The first failure of an object that could not be deleted (it stays listed), for the caller's log. */
  readonly failure?: string;
}

/**
 * Deletes the objects `sweep` lists, a page at a time, while `budget` leaves room for a page (one call for the page,
 * one per object, one to forget them), at most `pages` pages. Each object is deleted on its own: those deleted are
 * forgotten, one that failed stays listed, and the sweep stops after its page (the next sweep finds it first), so a
 * failing object never keeps the others from going.
 */
export const sweepObjects = async (
  sweep: ObjectSweep,
  budget: number,
  pages = Number.POSITIVE_INFINITY,
): Promise<Swept> => {
  let calls = 0;
  let purged = 0;

  for (let page = 0; page < pages; page += 1) {
    if (budget - calls < PAGE + 2) return { calls, purged, complete: false };
    const ids = await sweep.page(PAGE);

    calls += 1;

    if (ids.length === 0) return { calls, purged, complete: true };

    const results = await Promise.allSettled(ids.map(async (id) => await sweep.purge(id)));
    const gone = ids.filter((_id, index) => results[index]?.status === "fulfilled");

    calls += ids.length;

    if (gone.length > 0) {
      await sweep.forget(gone);
      calls += 1;
      purged += gone.length;
    }

    const failed = results.find((result) => result.status === "rejected");

    if (failed !== undefined)
      return { calls, purged, complete: false, failure: String(failed.reason) };
  }

  return { calls, purged, complete: false };
};

/**
 * Deletes the org's schedules' and runs' objects, a page at a time within `budget` (one ControlPlane call and one per
 * object). An object that could not be deleted stops the step, incomplete, and the next attempt tries it again.
 */
export const deleteOrgRuns =
  (env: Pick<AgentsBindings, "CONTROL_PLANE" | "AGENT_RUN" | "AGENT_SCHEDULE">): OrgDeletionStep =>
  async (org, budget) => {
    const part = () => {
      const stub: AgentsControlPlaneStub = controlPlaneOf(env, org);

      return stub.agents();
    };

    const schedules = await sweepObjects(
      {
        page: async (limit) => await part().scheduleObjectsPage(limit),
        purge: async (id) => await agentScheduleOf(env, org, id).purge(),
        forget: async (ids) => await part().forgetScheduleObjects(ids),
      },
      budget,
    );

    if (!schedules.complete) return incomplete(org, schedules, schedules.calls, "schedules");

    const runs = await sweepObjects(
      {
        page: async (limit) => (await part().runsPage(limit)).ids,
        purge: async (id) => await agentRunOf(env, org, id).purge(),
        forget: async (ids) => await part().forgetRuns(ids),
      },
      budget - schedules.calls,
    );

    const calls = schedules.calls + runs.calls;

    return runs.complete ? { complete: true, calls } : incomplete(org, runs, calls, "runs");
  };

/** The step stopped at `part`: out of budget, or an object that failed (logged). */
const incomplete = (org: OrgId, swept: Swept, calls: number, part: string) => {
  if (swept.failure !== undefined)
    Effect.runSync(
      Effect.logWarning(`agent ${part}: object not deleted`).pipe(
        Effect.annotateLogs({ org, detail: swept.failure }),
      ),
    );

  return { complete: false as const, calls, part };
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

    return await sweepObjects(
      {
        page: async (limit) => await stub.agents().retiredSchedules(limit),
        purge: async (id) => await agentScheduleOf(env, org, id).purge(),
        forget: async (ids) => await stub.agents().forgetScheduleObjects(ids),
      },
      Number.POSITIVE_INFINITY,
      SWEEP_PAGES,
    );
  }).pipe(
    Effect.flatMap((swept) =>
      swept.failure === undefined ? Effect.void : Effect.fail(new Error(swept.failure)),
    ),
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

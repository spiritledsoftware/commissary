/**
 * Deleting agent runs' objects (#228, ADR 0027, ADR 0040). A run leaves the org's index at once when it is deleted
 * (with its agent or its member, with its child runs) or pruned (alone, past the org's retention period for agent runs,
 * never while a turn runs) (`store.ts`); its object, which holds its transcript and turns, is the API Worker's
 * (`AGENT_RUN`), which the ControlPlane cannot reach. So the Workers delete the objects of the runs the index lists as
 * deleted (`deletedRuns`), with the org deletion's loop (`sweepObjects`): the app Worker's routes right after a deletion
 * ({@link sweepDeletedRuns}, best effort), and the API Worker's cron task ({@link pruneExpiredRuns}), which first
 * prunes each org's runs past its retention period and then deletes what any deletion left. The org's deletion deletes
 * them all (`org-deletion.ts`).
 *
 * A run's sandbox session (ADR 0041, #230) goes when the ControlPlane forgets the run (`forgetRuns`), after its object:
 * the Agents part has the Tools part of the same object delete it first, and a run whose session could not be deleted
 * stays listed, so the next sweep tries again.
 */
import { Clock, Effect } from "effect";
import type { OrgId, ScheduledTask } from "@commissary/core";
import { controlPlaneOf, platform, type StateEnv } from "@commissary/state";
import { type AgentsBindings, type AgentsControlPlaneStub, AgentsEnv, agentRunOf } from "../env.ts";
import { type Swept, sweepObjects } from "../org-deletion.ts";

const DAY_MS = 86_400_000;

const HOUR_MS = 3_600_000;

/** Pages a route's sweep deletes at most (20 runs each): a member's or an agent's runs beyond it wait for the cron. */
const SWEEP_PAGES = 3;

/** Pages the cron task deletes per org at most, so one org's backlog leaves the others their turn. */
const CRON_PAGES = 10;

/**
 * The calls (subrequests) one run of the cron task makes at most, across every org: an invocation has a limit, which
 * the other cron tasks share. Orgs it does not reach wait for the next run, which starts elsewhere in the list.
 */
export const RETENTION_BUDGET = 400;

/**
 * Deletes the objects of `org`'s deleted runs, up to `pages` pages within `budget` calls, and forgets those deleted;
 * a run whose object failed stays listed for the next sweep (`failure`).
 */
export const purgeDeletedRuns = async (
  env: Pick<AgentsBindings, "CONTROL_PLANE" | "AGENT_RUN">,
  org: OrgId,
  pages: number,
  budget = Number.POSITIVE_INFINITY,
): Promise<Swept> => {
  const stub: AgentsControlPlaneStub = controlPlaneOf(env, org);

  return await sweepObjects(
    {
      page: async (limit) => await stub.agents().deletedRuns(limit),
      purge: async (id) => await agentRunOf(env, org, id).purge(),
      forget: async (ids) => await stub.agents().forgetRuns(ids),
    },
    budget,
    pages,
  );
};

/**
 * Deletes the objects of `org`'s deleted runs right after a deletion (an agent removed, a member gone), a few pages at
 * most. Best effort: a failure is logged and leaves them to the cron task; meanwhile each answers like an unknown run.
 */
export const sweepDeletedRuns = (
  env: Pick<AgentsBindings, "CONTROL_PLANE" | "AGENT_RUN">,
  org: OrgId,
): Effect.Effect<void> =>
  Effect.tryPromise(() => purgeDeletedRuns(env, org, SWEEP_PAGES)).pipe(
    Effect.flatMap((swept) =>
      swept.failure === undefined ? Effect.void : Effect.fail(new Error(swept.failure)),
    ),
    Effect.catch((error) =>
      Effect.logWarning("agent runs: sweep failed").pipe(
        Effect.annotateLogs({ org, detail: String(error) }),
      ),
    ),
  );

/**
 * The cron task's work (`agent-run-retention`): for the orgs of the Platform registry, prunes the runs whose last
 * activity is older than the org's retention period for agent runs (none: kept) and that run no turn, counted from the
 * clock, then deletes the objects of its deleted runs, within {@link RETENTION_BUDGET} calls in all. It starts at an
 * org that moves on every hour, so a budget spent before the end of the list leaves different orgs for the next run.
 * One org's failure is logged and leaves the next org its turn. Answers how many runs' objects it deleted. When the
 * registry cannot be reached nothing is pruned (the failure is the task's).
 */
export const pruneExpiredRuns: Effect.Effect<number, Error, AgentsEnv | StateEnv> = Effect.gen(
  function* () {
    const env = yield* AgentsEnv;
    const listed = yield* platform("listOrgs", (stub) => stub.listOrgs());
    const now = yield* Clock.currentTimeMillis;
    const first = listed.length === 0 ? 0 : Math.floor(now / HOUR_MS) % listed.length;
    const orgs = [...listed.slice(first), ...listed.slice(0, first)];
    let calls = 0;
    let total = 0;

    for (const org of orgs) {
      // Pruning takes one call, and a page needs room for its objects.
      if (RETENTION_BUDGET - calls < 2) {
        yield* Effect.logWarning("agent run retention: budget spent").pipe(
          Effect.annotateLogs({ next: org.id }),
        );
        break;
      }

      const days = org.runRetentionDays;

      const done = yield* Effect.tryPromise(async () => {
        const stub: AgentsControlPlaneStub = controlPlaneOf(env, org.id);

        const expired =
          typeof days === "number" ? await stub.agents().expireRuns(now - days * DAY_MS) : 0;

        const used = typeof days === "number" ? 1 : 0;

        const swept = await purgeDeletedRuns(
          env,
          org.id,
          CRON_PAGES,
          RETENTION_BUDGET - calls - used,
        );

        return { expired, swept, calls: used + swept.calls };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent run retention failed").pipe(
            Effect.annotateLogs({ org: org.id, detail: String(error) }),
            Effect.as({ expired: 0, swept: undefined, calls: 1 }),
          ),
        ),
      );

      calls += done.calls;
      const purged = done.swept?.purged ?? 0;

      if (done.swept?.failure !== undefined)
        yield* Effect.logWarning("agent run retention: a run's object not deleted").pipe(
          Effect.annotateLogs({ org: org.id, detail: done.swept.failure }),
        );

      if (done.expired > 0 || purged > 0)
        yield* Effect.logInfo("agent run retention").pipe(
          Effect.annotateLogs({ org: org.id, expired: done.expired, purged, retentionDays: days }),
        );

      total += purged;
    }

    return total;
  },
);

/** Agents' cron tasks, run by the API Worker's cron runner (`apps/api/src/scheduled.ts`). */
export const scheduledTasks: ReadonlyArray<ScheduledTask<AgentsEnv | StateEnv>> = [
  // Agent runs past each org's retention period for them (on the Platform registry), and the objects of the runs
  // deleted with their agent or their member that a route's sweep left.
  { name: "agent-run-retention", scope: "deployment", run: pruneExpiredRuns },
];

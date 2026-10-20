// Deleting agent runs (#228, ADR 0027, ADR 0040) in the Agents part over RPC: a run goes from the org's index at once
// with its agent or its member, with the child runs it started (#229: a run whose starter is the run), or alone past
// the org's retention period for agent runs (the cron task, with `TestClock` driving its time; never while a turn runs),
// and its object, which holds its transcript and turns, is deleted by the sweep that follows. A run's object here has no client API behind it
// (test/worker.ts): its first turn fails, but its storage is there to delete.
import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { newOrgId, type OrgId } from "@commissary/core";
import { platformOf, StateEnv } from "@commissary/state";
import { AgentsEnv, agentRunOf } from "../src/env.ts";
import { sweepObjects } from "../src/org-deletion.ts";
import { purgeDeletedRuns, pruneExpiredRuns } from "../src/runs/retention.ts";
import { agentBody } from "./testing.ts";

const OWNER = { role: "owner" as const, sensitive: false };

const FOUND = { modelServed: true, unknownToolkits: [] };

const MODEL = "claude-sonnet-4";

const DAY_MS = 86_400_000;

/**
 * A new org, listed in the Platform registry (the cron task reads its retention period there), with an org admin and
 * two plain members, private agents on.
 */
const org = async () => {
  const id = newOrgId();
  const stub = env.CONTROL_PLANE.getByName(id);
  const listed = await platformOf(env).createOrg({ slug: id, name: id, id }, Date.now());

  if (!listed.ok) throw new Error(listed.message);
  await stub.setMembershipSettings({ privateAgents: true });

  const member = async (name: string, role: string) => {
    const added = await stub.addMember({ email: `${name}@example.com`, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return { member: added.value.id, admin: role !== "member" };
  };

  return {
    id,
    stub,
    get agents() {
      return stub.agents();
    },
    admin: await member("admin", "admin"),
    alice: await member("alice", "member"),
    bob: await member("bob", "member"),
  };
};

type Org = Awaited<ReturnType<typeof org>>;

type Person = Org["alice"];

const created = async (o: Org, viewer: Person, name: string, extra = {}) => {
  const result = await o.agents.createAgent(viewer, agentBody(name, MODEL, extra), FOUND, "test");

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value;
};

/** A run `viewer` starts of `agent`, with its object started too, so it holds a transcript. */
const started = async (o: Org, viewer: Person, agent: string) => {
  const result = await o.agents.startRun(viewer, agent, "chat", undefined);

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
  const { id } = result.value.run;

  expect(await agentRunOf(env, o.id, id).start({ org: o.id, id }, "hello")).toMatchObject({
    ok: true,
  });

  return id;
};

/**
 * A child run (#229) that the run `parent` starts of the agent named `agentName` through the agents toolkit, with its
 * object started as the toolkit's Worker starts it.
 */
const child = async (o: Org, parent: string, agentName: string) => {
  const result = await o.agents.startToolkitRun(
    { kind: "run", runId: parent },
    agentName,
    undefined,
    undefined,
  );

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
  const { id } = result.value.run;

  expect(
    await agentRunOf(env, o.id, id).start({ org: o.id, id, child: result.value.child }, "child"),
  ).toMatchObject({ ok: true });

  return id;
};

/** Whether the run's object still holds anything of it. */
const kept = async (orgId: OrgId, run: string) => (await agentRunOf(env, orgId, run).show()).ok;

/** Whether the org's index still knows the run: the gateway resolves its principal through it. */
const indexed = async (o: Org, run: string) => {
  const context = await o.agents.turnContext(run);

  return context.ok || context.error !== "not_found";
};

describe("removing a member", () => {
  it("deletes every run they started, a shared agent's too, with its child runs, and the sweep deletes their objects", async () => {
    const o = await org();
    const shared = await created(o, o.admin, "support", { subject: { kind: "everyone" } });

    for (const name of ["aide", "scout"])
      await created(o, o.admin, name, { subject: { kind: "everyone" } });

    const theirs = await started(o, o.alice, shared.id);
    // Child runs of other agents, which go with the run that started them.
    const descendant = await child(o, theirs, "aide");
    const grandchild = await child(o, descendant, "scout");
    const others = await started(o, o.bob, shared.id);

    expect((await o.stub.removeMember(o.alice.member, OWNER)).ok).toBe(true);

    // Gone from the index at once: each answers like an unknown run, and bob's stays.
    for (const run of [theirs, descendant, grandchild])
      expect(await o.agents.turnContext(run)).toMatchObject({ ok: false, error: "not_found" });
    expect(await indexed(o, others)).toBe(true);
    expect((await o.agents.listRuns(o.bob)).runs.map((run) => run.id)).toEqual([others]);

    // The sweep deletes their objects, and forgets them.
    expect(await o.agents.deletedRuns(10)).toHaveLength(3);
    expect(await purgeDeletedRuns(env, o.id, 3)).toMatchObject({ purged: 3, complete: true });

    for (const run of [theirs, descendant, grandchild]) expect(await kept(o.id, run)).toBe(false);
    expect(await kept(o.id, others)).toBe(true);
    expect(await o.agents.deletedRuns(10)).toEqual([]);
  });

  it("deletes their private agents' runs", async () => {
    const o = await org();
    const mine = await created(o, o.alice, "helper");
    const run = await started(o, o.alice, mine.id);

    expect((await o.stub.removeMember(o.alice.member, OWNER)).ok).toBe(true);
    expect(await o.agents.turnContext(run)).toMatchObject({ ok: false, error: "not_found" });
    expect(await o.agents.deletedRuns(10)).toEqual([run]);
  });
});

describe("removing an agent", () => {
  it("deletes its runs' child runs of other agents, and leaves those agents' own runs", async () => {
    const o = await org();
    const shared = await created(o, o.admin, "support", { subject: { kind: "everyone" } });
    const aide = await created(o, o.admin, "aide", { subject: { kind: "everyone" } });
    const run = await started(o, o.alice, shared.id);
    const descendant = await child(o, run, "aide");
    const direct = await started(o, o.bob, aide.id);

    expect(await o.agents.removeAgent(o.admin, shared.id, shared.revision)).toMatchObject({
      ok: true,
    });

    expect(await indexed(o, descendant)).toBe(false);
    expect(await indexed(o, direct)).toBe(true);
    expect(await purgeDeletedRuns(env, o.id, 3)).toMatchObject({ purged: 2, complete: true });
    expect(await kept(o.id, descendant)).toBe(false);
    expect(await kept(o.id, direct)).toBe(true);
  });

  it("deletes all its runs, whoever started them, and leaves other agents' runs", async () => {
    const o = await org();
    const shared = await created(o, o.admin, "support", { subject: { kind: "everyone" } });
    const other = await created(o, o.admin, "other", { subject: { kind: "everyone" } });
    const alices = await started(o, o.alice, shared.id);
    const bobs = await started(o, o.bob, shared.id);
    const unrelated = await started(o, o.bob, other.id);

    expect(await o.agents.removeAgent(o.admin, shared.id, shared.revision)).toMatchObject({
      ok: true,
    });

    expect((await o.agents.listRuns(o.alice)).runs).toEqual([]);
    expect((await o.agents.listRuns(o.bob)).runs.map((run) => run.id)).toEqual([unrelated]);
    expect(await purgeDeletedRuns(env, o.id, 3)).toMatchObject({ purged: 2, complete: true });
    expect(await kept(o.id, alices)).toBe(false);
    expect(await kept(o.id, bobs)).toBe(false);
    expect(await kept(o.id, unrelated)).toBe(true);
  });
});

describe("the retention period for agent runs", () => {
  /** Runs the cron task with `TestClock` at `now`. */
  const prune = (now: number) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      return yield* pruneExpiredRuns;
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(AgentsEnv, env),
      Effect.provideService(StateEnv, env),
      Effect.runPromise,
    );

  /** Sets the run's state and last activity in the org's index, as its object's reports would. */
  const indexedAs = (o: Org, run: string, state: "idle" | "running" | "ended", at: number) =>
    runInDurableObject(o.stub, (_instance, durable) => {
      durable.storage.sql.exec(
        `UPDATE agent_runs SET state = ?, updated_at = ? WHERE id = ?`,
        state,
        at,
        run,
      );
    });

  /** The run idle since `at`: its turn cancelled (its object reports it idle), its last activity then. */
  const idleSince = async (o: Org, run: string, at: number) => {
    expect(await agentRunOf(env, o.id, run).cancel()).toMatchObject({ ok: true });
    await indexedAs(o, run, "idle", at);
  };

  it("is 30 days after a run's last activity by default: the cron task prunes an idle run and deletes its object", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");
    const run = await started(o, o.alice, agent.id);
    const start = Date.now();

    await idleSince(o, run, start);

    // 29 days idle: kept.
    await prune(start + 29 * DAY_MS);
    expect(await indexed(o, run)).toBe(true);
    expect(await kept(o.id, run)).toBe(true);

    // Past 30 days: pruned, and its object deleted.
    await prune(start + 31 * DAY_MS);
    expect(await o.agents.turnContext(run)).toMatchObject({ ok: false, error: "not_found" });
    expect((await o.agents.listRuns(o.alice)).runs).toEqual([]);
    expect(await kept(o.id, run)).toBe(false);
    expect(await o.agents.runsPage(10)).toEqual({ ids: [], total: 0 });
  });

  it("prunes each run on its own last activity: a child run outlives its idle parent", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");

    await created(o, o.alice, "aide");
    const run = await started(o, o.alice, agent.id);
    const descendant = await child(o, run, "aide");
    const start = Date.now();

    await idleSince(o, run, start);
    await idleSince(o, descendant, start + 20 * DAY_MS);

    await prune(start + 31 * DAY_MS);
    expect(await indexed(o, run)).toBe(false);
    expect(await kept(o.id, run)).toBe(false);
    expect(await indexed(o, descendant)).toBe(true);
    expect(await kept(o.id, descendant)).toBe(true);

    await prune(start + 51 * DAY_MS);
    expect(await indexed(o, descendant)).toBe(false);
    expect(await kept(o.id, descendant)).toBe(false);
  });

  it("never prunes a run while a turn runs, however long ago its last activity was; an ended run goes", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");
    const running = await started(o, o.alice, agent.id);
    const ended = await started(o, o.alice, agent.id);
    const start = Date.now();

    await indexedAs(o, running, "running", start);
    await idleSince(o, ended, start);
    await indexedAs(o, ended, "ended", start);

    await prune(start + 400 * DAY_MS);
    expect(await indexed(o, running)).toBe(true);
    expect(await kept(o.id, running)).toBe(true);
    expect(await indexed(o, ended)).toBe(false);
  });

  it("counts a state change as activity: a turn starting or settling", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");
    const run = await started(o, o.alice, agent.id);
    const start = Date.now();

    await idleSince(o, run, start - 40 * DAY_MS);
    // The object reports the next turn's start, then its end.
    await o.agents.runStateChanged(run, "running");
    await o.agents.runStateChanged(run, "idle");

    await prune(start + DAY_MS);
    expect(await indexed(o, run)).toBe(true);
  });

  it("follows the org's own period, and none keeps runs", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");
    const run = await started(o, o.alice, agent.id);
    const start = Date.now();
    const registry = platformOf(env);

    await idleSince(o, run, start);
    expect(await registry.setRetention(o.id, { runDays: null })).toMatchObject({ ok: true });
    await prune(start + 400 * DAY_MS);
    expect(await kept(o.id, run)).toBe(true);

    expect(await registry.setRetention(o.id, { runDays: 2 })).toMatchObject({
      ok: true,
      org: { runRetentionDays: 2 },
    });
    await prune(start + DAY_MS);
    expect(await kept(o.id, run)).toBe(true);
    await prune(start + 3 * DAY_MS);
    expect(await kept(o.id, run)).toBe(false);
  });
});

describe("sweeping objects", () => {
  /** A queue of objects' ids, `failing` among them, as the ControlPlane lists them. */
  const queue = (ids: ReadonlyArray<string>, failing: string) => {
    const forgotten: string[] = [];

    return {
      forgotten,
      sweep: {
        page: async (limit: number) => ids.filter((id) => !forgotten.includes(id)).slice(0, limit),
        purge: async (id: string) => {
          if (id === failing) throw new Error(`${id} failed`);
        },
        forget: async (gone: ReadonlyArray<string>) => {
          forgotten.push(...gone);
        },
      },
    };
  };

  it("forgets the objects it deleted, and keeps one that failed listed without holding up the others", async () => {
    const { forgotten, sweep } = queue(["a", "b", "c"], "b");

    expect(await sweepObjects(sweep, Number.POSITIVE_INFINITY)).toEqual({
      calls: 5,
      purged: 2,
      complete: false,
      failure: "Error: b failed",
    });
    expect(forgotten).toEqual(["a", "c"]);
  });

  it("stops before a page its budget has no room for", async () => {
    const { forgotten, sweep } = queue(["a"], "none");

    expect(await sweepObjects(sweep, 21)).toEqual({ calls: 0, purged: 0, complete: false });
    expect(forgotten).toEqual([]);
    // Room for one page: its objects go, and the next page waits for the next sweep.
    expect(await sweepObjects(sweep, 22)).toEqual({ calls: 3, purged: 1, complete: false });
    expect(forgotten).toEqual(["a"]);
    expect(await sweepObjects(sweep, 22)).toEqual({ calls: 1, purged: 0, complete: true });
  });
});

describe("the org export", () => {
  it("lists each agent's runs' metadata, never a transcript", async () => {
    const o = await org();
    const shared = await created(o, o.admin, "support", { subject: { kind: "everyone" } });

    await created(o, o.admin, "aide", { subject: { kind: "everyone" } });
    const run = await started(o, o.alice, shared.id);
    const descendant = await child(o, run, "aide");
    const exported = await o.agents.exportAgents(o.admin);

    expect(exported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "support",
          runs: [
            {
              id: run,
              trigger: "chat",
              starter: { member: "alice@example.com" },
              state: expect.any(String),
              created_at: expect.any(String),
              last_activity_at: expect.any(String),
            },
          ],
        }),
        expect.objectContaining({
          name: "aide",
          runs: [expect.objectContaining({ id: descendant, trigger: "mcp", starter: { run } })],
        }),
      ]),
    );
    expect(JSON.stringify(exported)).not.toContain("hello");
  });
});

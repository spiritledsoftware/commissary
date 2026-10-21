// The agents toolkit's runs (#229, ADR 0040) in the Agents part over RPC and in the runs' objects: who starts which
// agent (a member through an API key or signed in, or a run, whose start makes a child run), who sees which run, the
// limits on chains (depth, cycles, child runs running at once), the end of a run ending its child runs, the index's
// `api_key_id` column on an older table, and in the objects the claims of each caller, the deliveries of a child run's
// results to its parent, their retries from the alarm, and the stop of a child run whose parent ended. The runs'
// objects here have no client API (test/worker.ts): each turn fails at its first model call, which is all a delivery
// needs. The toolkit's MCP calls through the API Worker are the app Worker's tests' (apps/app/test/agent-runs.test.ts).
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newOrgId } from "@commissary/core";
import { agentRunOf } from "../src/env.ts";
import { MAX_DELIVERY_ATTEMPTS } from "../src/runs/run-object.ts";
import { MAX_ACTIVE_CHILDREN, MAX_CHAIN } from "../src/runs/runs.ts";
import { RunStore } from "../src/runs/store.ts";
import { agentBody } from "./testing.ts";
import { UNREACHABLE } from "./worker.ts";

const OWNER = { role: "owner" as const, sensitive: false };

const FOUND = { modelServed: true, unknownToolkits: [] };

const MODEL = "claude-sonnet-4";

/** A new org's ControlPlane with an org admin and two plain members, private agents on. */
const org = async () => {
  const id = newOrgId();
  const stub = env.CONTROL_PLANE.getByName(id);

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

type Viewer = Org["alice"];

const created = async (o: Org, viewer: Viewer, name: string, extra = {}) => {
  const result = await o.agents.createAgent(viewer, agentBody(name, MODEL, extra), FOUND, "test");

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value;
};

/** A run of `agent` that `viewer` started in the panel, at its first turn (so it has a definition to run agents by). */
const running = async (o: Org, viewer: Viewer, agent: string) => {
  const result = await o.agents.startRun(viewer, agent, "chat", undefined);

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
  const turn = await o.agents.beginTurn(result.value.run.id);

  if (!turn.ok) throw new Error(`${turn.error}: ${turn.message}`);

  return result.value.run.id;
};

const asRun = (runId: string) => ({ kind: "run" as const, runId });

const asKey = (member: string, apiKeyId: string) => ({ kind: "member" as const, member, apiKeyId });

const asMember = (member: string) => ({ kind: "member" as const, member });

/** A child run of `agent` that the run `parent` starts, at its first turn. */
const child = async (o: Org, parent: string, agent: string) => {
  const result = await o.agents.startToolkitRun(asRun(parent), agent, undefined, undefined);

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
  const turn = await o.agents.beginTurn(result.value.run.id);

  if (!turn.ok) throw new Error(`${turn.error}: ${turn.message}`);

  return result.value;
};

describe("a member's start through the agents toolkit", () => {
  it("runs an agent they may use, once per key and idempotency key, and each key sees its own runs", async () => {
    const o = await org();
    const helper = await created(o, o.alice, "helper");

    await created(o, o.bob, "bobs");

    // Another member's private agent, and an agent outside the scope, answer like an unknown one.
    expect(
      await o.agents.startToolkitRun(asKey(o.alice.member, "k1"), "bobs", undefined, undefined),
    ).toMatchObject({ ok: false, error: "not_found" });
    expect(
      await o.agents.startToolkitRun(
        asKey(o.alice.member, "k1"),
        "helper",
        ["ag_other"],
        undefined,
      ),
    ).toMatchObject({ ok: false, error: "not_found" });

    const first = await o.agents.startToolkitRun(
      asKey(o.alice.member, "k1"),
      "helper",
      undefined,
      "same",
    );

    const again = await o.agents.startToolkitRun(
      asKey(o.alice.member, "k1"),
      "helper",
      undefined,
      "same",
    );

    const other = await o.agents.startToolkitRun(
      asKey(o.alice.member, "k2"),
      "helper",
      undefined,
      "same",
    );

    if (!first.ok || !again.ok || !other.ok) throw new Error("not started");
    expect(first.value).toMatchObject({
      created: true,
      run: { trigger: "mcp", starter: { kind: "member", id: o.alice.member }, state: "idle" },
    });
    expect(first.value.child).toBeUndefined();
    expect(again.value).toMatchObject({ created: false, run: { id: first.value.run.id } });
    // The same key from another API key is another start.
    expect(other.value.run.id).not.toBe(first.value.run.id);

    const one = first.value.run.id;

    // A key sees the runs it started; the member signed in sees every run they started; another member, none.
    expect(await o.agents.getToolkitRun(asKey(o.alice.member, "k1"), one)).toMatchObject({
      ok: true,
    });
    expect(await o.agents.getToolkitRun(asKey(o.alice.member, "k2"), one)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await o.agents.getToolkitRun(asMember(o.alice.member), one)).toMatchObject({ ok: true });
    expect(await o.agents.getToolkitRun(asMember(o.bob.member), one)).toMatchObject({
      error: "not_found",
    });
    expect(
      (await o.agents.listToolkitRuns(asKey(o.alice.member, "k1"))).runs.map((run) => run.id),
    ).toEqual([one]);
    expect(
      (await o.agents.listToolkitRuns(asMember(o.alice.member))).runs
        .map((run) => run.id)
        .toSorted(),
    ).toEqual([one, other.value.run.id].toSorted());

    // A disabled agent the member may use says so.
    await o.agents.updateAgent(o.alice, helper.id, 1, { enabled: false }, {}, "test");
    expect(
      await o.agents.startToolkitRun(asMember(o.alice.member), "helper", undefined, undefined),
    ).toMatchObject({ ok: false, error: "agent_disabled" });
  });
});

describe("a run's start through the agents toolkit", () => {
  it("starts a child run that acts as its agent, which only the calling run sees", async () => {
    const o = await org();
    const a = await created(o, o.alice, "a");

    await created(o, o.alice, "b");
    const head = await running(o, o.alice, a.id);
    const other = await running(o, o.alice, a.id);
    const started = await child(o, head, "b");

    expect(started).toMatchObject({
      created: true,
      child: { parent: head, agentName: "b" },
      run: { trigger: "mcp", starter: { kind: "run", id: head } },
    });

    const id = started.run.id;

    // Its turns act as the agent's member, and its approvals are the member's who started the head of the chain.
    expect(await o.agents.turnContext(id)).toMatchObject({
      ok: true,
      value: {
        actsAs: { kind: "member", memberId: o.alice.member },
        starter: { kind: "run", id: head },
        starterMember: o.alice.member,
      },
    });

    // The calling run sees it; another run, and the member, do not.
    expect(await o.agents.getToolkitRun(asRun(head), id)).toMatchObject({ ok: true });
    expect(await o.agents.getToolkitRun(asRun(other), id)).toMatchObject({ error: "not_found" });
    expect(await o.agents.getToolkitRun(asMember(o.alice.member), id)).toMatchObject({
      error: "not_found",
    });
    expect((await o.agents.listToolkitRuns(asRun(head))).runs.map((run) => run.id)).toEqual([id]);
    expect((await o.agents.listToolkitRuns(asRun(other))).runs).toEqual([]);

    // A run that ended starts nothing, and says so.
    await o.agents.runStateChanged(other, "ended");
    expect(await o.agents.startToolkitRun(asRun(other), "b", undefined, undefined)).toMatchObject({
      ok: false,
      error: "run_ended",
    });
  });

  it("runs only the agents its definition may run, a disabled one answering like an unknown one", async () => {
    const o = await org();
    const b = await created(o, o.alice, "b");

    await created(o, o.alice, "c");
    await created(o, o.admin, "shared_one", { subject: { kind: "everyone" } });
    const shared = await created(o, o.admin, "shared_two", { subject: { kind: "everyone" } });

    const narrowed = await created(o, o.alice, "narrowed", {
      tool_scope: [{ toolkit: "agents", tools: { kind: "all" }, agents: [b.id] }],
    });

    // A private agent's run: any agent its member may use, within the agents its scope names.
    const scoped = await running(o, o.alice, narrowed.id);

    expect(await o.agents.startToolkitRun(asRun(scoped), "c", undefined, undefined)).toMatchObject({
      error: "not_found",
    });
    expect(await o.agents.startToolkitRun(asRun(scoped), "b", undefined, undefined)).toMatchObject({
      ok: true,
    });

    // A shared agent's run: the shared agents, never a member's private one.
    const sharedRun = await running(o, o.alice, shared.id);

    expect(
      await o.agents.startToolkitRun(asRun(sharedRun), "b", undefined, undefined),
    ).toMatchObject({ error: "not_found" });
    expect(
      await o.agents.startToolkitRun(asRun(sharedRun), "shared_one", undefined, undefined),
    ).toMatchObject({ ok: true });

    // A disabled agent is unknown to a run, so a refusal tells nothing of its existence.
    await o.agents.updateAgent(o.alice, b.id, 1, { enabled: false }, {}, "test");
    expect(await o.agents.startToolkitRun(asRun(scoped), "b", undefined, undefined)).toMatchObject({
      error: "not_found",
    });
  });

  it(`refuses a chain deeper than ${MAX_CHAIN} runs, and an agent already in the chain`, async () => {
    const o = await org();
    const a = await created(o, o.alice, "a");

    for (const name of ["b", "c", "d"]) await created(o, o.alice, name);
    const head = await running(o, o.alice, a.id);
    const second = (await child(o, head, "b")).run.id;

    // a → b → a: the agent already runs in the chain.
    expect(await o.agents.startToolkitRun(asRun(second), "a", undefined, undefined)).toMatchObject({
      ok: false,
      error: "forbidden",
      message: expect.stringContaining("already runs in this chain"),
    });

    const third = (await child(o, second, "c")).run.id;

    // a → b → c → d: a fourth level.
    expect(await o.agents.startToolkitRun(asRun(third), "d", undefined, undefined)).toMatchObject({
      ok: false,
      error: "forbidden",
      message: expect.stringContaining(`at most ${MAX_CHAIN} deep`),
    });
  });

  it(`lets a run have at most ${MAX_ACTIVE_CHILDREN} child runs running at once`, async () => {
    const o = await org();
    const a = await created(o, o.alice, "a");

    await created(o, o.alice, "b");
    const head = await running(o, o.alice, a.id);
    const children: Array<string> = [];

    for (let index = 0; index < MAX_ACTIVE_CHILDREN; index++)
      children.push((await child(o, head, "b")).run.id);

    expect(await o.agents.startToolkitRun(asRun(head), "b", undefined, undefined)).toMatchObject({
      ok: false,
      error: "forbidden",
      message: expect.stringContaining(`at most ${MAX_ACTIVE_CHILDREN} child runs running`),
    });

    // One that finished its turn frees a place.
    await o.agents.runStateChanged(children[0] ?? "", "idle");
    expect(await o.agents.startToolkitRun(asRun(head), "b", undefined, undefined)).toMatchObject({
      ok: true,
    });
  });

  it("ends with the run that started it, and its own child runs with it", async () => {
    const o = await org();
    const a = await created(o, o.alice, "a");

    await created(o, o.alice, "b");
    await created(o, o.alice, "c");
    const head = await running(o, o.alice, a.id);
    const second = (await child(o, head, "b")).run.id;
    const third = (await child(o, second, "c")).run.id;

    expect((await o.agents.runStateChanged(head, "ended")).toSorted()).toEqual(
      [second, third].toSorted(),
    );

    for (const id of [second, third]) {
      expect(await o.agents.getToolkitRun(asRun(id === second ? head : second), id)).toMatchObject({
        value: { state: "ended" },
      });
      expect(await o.agents.turnContext(id)).toMatchObject({ ok: false, error: "run_ended" });
    }
  });
});

describe("the index of runs", () => {
  it("adds the API key and trigger columns to a table created before them", async () => {
    const object = env.AGENT_RUN.getByName(`${newOrgId()}:ar_migration`);

    const columns = await runInDurableObject(object, (_instance, state) => {
      const sql = state.storage.sql;

      // The table as #227 created it.
      sql.exec(`CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, trigger TEXT NOT NULL, starter_kind TEXT NOT NULL,
        starter_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL, turn_definition TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (agent_id, starter_kind, starter_id, idempotency_key)
      )`);
      sql.exec(
        `INSERT INTO agent_runs (id, agent_id, trigger, starter_kind, starter_id, idempotency_key, state, created_at,
         updated_at) VALUES ('ar_old', 'ag_1', 'chat', 'member', 'mb_1', 'ar_old', 'idle', 1, 1)`,
      );

      const store = new RunStore(sql);

      return {
        names: sql
          .exec<{ name: string }>("PRAGMA table_info(agent_runs)")
          .toArray()
          .map((column) => column.name),
        old: store.run("ar_old"),
      };
    });

    expect(columns.names).toEqual(expect.arrayContaining(["api_key_id", "trigger_id"]));
    expect(columns.old).toMatchObject({ id: "ar_old", starter: { kind: "member", id: "mb_1" } });
    expect(columns.old?.apiKeyId).toBeUndefined();
  });
});

/** A started run's object, with its first turn finished (it fails: no client API here). */
const startedObject = async (
  o: Org,
  run: string,
  init: { readonly child?: { readonly parent: string; readonly agentName: string } } = {},
) => {
  const object = agentRunOf(env, o.id, run);

  expect(await object.start({ org: o.id, id: run, ...init }, "work")).toMatchObject({ ok: true });
  expect(await object.wait("turn_1", 30_000)).toMatchObject({
    ok: true,
    value: { finished: true },
  });

  return object;
};

/** A child run's turn as its object keeps it. */
const storedTurn = (o: Org, run: string, turn: string) =>
  runInDurableObject(agentRunOf(env, o.id, run), (_instance, state) =>
    state.storage.kv.get<{
      readonly delivery?: string;
      readonly claimedBy?: ReadonlyArray<string>;
    }>(`turn:${turn}`),
  );

const pending = (o: Org, run: string) =>
  runInDurableObject(agentRunOf(env, o.id, run), (_instance, state) =>
    state.storage.kv.get<ReadonlyArray<{ readonly turn: string; readonly attempts: number }>>(
      "deliveries",
    ),
  );

/** A head run (of `a`, started by alice in the panel, its object started) and its child run of `b` (not started). */
const family = async () => {
  const o = await org();
  const a = await created(o, o.alice, "a");

  await created(o, o.alice, "b");
  const startedRun = await o.agents.startRun(o.alice, a.id, "chat", undefined);

  if (!startedRun.ok) throw new Error(startedRun.message);
  const head = startedRun.value.run.id;
  const parent = await startedObject(o, head);
  const started = await o.agents.startToolkitRun(asRun(head), "b", undefined, undefined);

  if (!started.ok || started.value.child === undefined) throw new Error("no child run");

  return { o, a, head, parent, child: started.value.run.id, childOf: started.value.child };
};

describe("a run's results", () => {
  // The first harness a test Worker opens loads the pi packages (`runs/pi.ts`, a dynamic import), seconds on a loaded
  // runner: pay it here, under the hook's timeout, rather than in the first test's.
  beforeAll(async () => {
    const o = await org();
    const agent = await created(o, o.alice, "warm");
    const run = await o.agents.startRun(o.alice, agent.id, "chat", undefined);

    if (!run.ok) throw new Error(run.message);
    await startedObject(o, run.value.run.id);
  });

  it("are claimed once by each caller", async () => {
    const o = await org();
    await created(o, o.alice, "helper");

    const run = await o.agents.startToolkitRun(
      asKey(o.alice.member, "k1"),
      "helper",
      undefined,
      undefined,
    );

    if (!run.ok) throw new Error(run.message);
    const object = await startedObject(o, run.value.run.id);

    expect(await object.claim(undefined, 0, "key:k1")).toMatchObject({
      ok: true,
      value: { finished: true, turn: { id: "turn_1", status: "failed" } },
    });
    // The same caller has it: nothing more to claim.
    expect(await object.claim(undefined, 0, "key:k1")).toMatchObject({
      ok: true,
      value: { finished: false, delivered: false },
    });
    // Another caller (the member signed in) still claims it.
    expect(await object.claim(undefined, 0, `member:${o.alice.member}`)).toMatchObject({
      value: { finished: true, turn: { id: "turn_1" } },
    });
  });

  it("of a child run are delivered to the run that started it, which then has them", async () => {
    const { o, head, parent, child: id, childOf } = await family();
    const object = await startedObject(o, id, { child: childOf });

    // The parent took the result as a message: a turn of its own.
    await vi.waitFor(async () => {
      const shown = await parent.show();

      expect(shown.ok && shown.value.turns.map((turn) => turn.input)).toEqual([
        "work",
        expect.stringContaining(
          `[agents] Run ${id} (agent b), which you started, finished its turn turn_1`,
        ),
      ]);
    });
    expect(await storedTurn(o, id, "turn_1")).toMatchObject({ delivery: "delivered" });

    // The parent has every result: one was delivered to it.
    expect(await object.claim(undefined, 0, `run:${head}`)).toMatchObject({
      value: { finished: false, delivered: true },
    });
  });

  it("are taken by the parent only from its own child runs", async () => {
    const { o, head, parent, child: id } = await family();

    const turn = {
      id: "turn_1",
      status: "done" as const,
      input: "x",
      started_at: "2026-01-01T00:00:00.000Z",
    };

    // A run it did not start, or one naming another parent.
    expect(
      await parent.deliver({ run: "ar_stranger", child: { parent: head, agentName: "b" }, turn }),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(
      await parent.deliver({ run: id, child: { parent: "ar_other", agentName: "b" }, turn }),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(await storedTurn(o, head, "turn_2")).toBeUndefined();
  });

  it("are delivered again from the alarm while the parent cannot be reached, and given up at last", async () => {
    const { o, parent, child: id, childOf } = await family();

    await runInDurableObject(parent, (_instance, state) => state.storage.kv.put(UNREACHABLE, true));
    await startedObject(o, id, { child: childOf });

    await vi.waitFor(async () => {
      expect(await pending(o, id)).toEqual([{ turn: "turn_1", attempts: 1 }]);
    });
    expect(await storedTurn(o, id, "turn_1")).toMatchObject({ delivery: "pending" });

    // Each alarm tries again, until the last try gives up.
    for (let attempt = 2; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      expect(await runDurableObjectAlarm(agentRunOf(env, o.id, id))).toBe(true);
      expect(await pending(o, id)).toEqual([{ turn: "turn_1", attempts: attempt }]);
    }

    expect(await runDurableObjectAlarm(agentRunOf(env, o.id, id))).toBe(true);
    expect(await pending(o, id)).toBeUndefined();
    expect(await storedTurn(o, id, "turn_1")).toMatchObject({ delivery: "dropped" });
    expect(await runDurableObjectAlarm(agentRunOf(env, o.id, id))).toBe(false);
  });

  it("reach the parent once it can be reached again", async () => {
    const { o, parent, child: id, childOf } = await family();

    await runInDurableObject(parent, (_instance, state) => state.storage.kv.put(UNREACHABLE, true));
    await startedObject(o, id, { child: childOf });
    await vi.waitFor(async () => {
      expect(await pending(o, id)).toEqual([{ turn: "turn_1", attempts: 1 }]);
    });

    await runInDurableObject(parent, (_instance, state) => state.storage.kv.delete(UNREACHABLE));
    expect(await runDurableObjectAlarm(agentRunOf(env, o.id, id))).toBe(true);
    expect(await pending(o, id)).toBeUndefined();
    expect(await storedTurn(o, id, "turn_1")).toMatchObject({ delivery: "delivered" });
  });
});

describe("a child run's object", () => {
  it("stops when the run that started it ends", async () => {
    const { o, a, parent, child: id, childOf } = await family();
    const object = await startedObject(o, id, { child: childOf });

    // The parent's agent is disabled: its next turn ends it, and with it its child run.
    await o.agents.updateAgent(o.alice, a.id, 1, { enabled: false }, {}, "test");
    await vi.waitFor(async () => {
      expect(await parent.message("again")).toMatchObject({ ok: false, error: "run_ended" });
    });

    expect(await object.show()).toMatchObject({ ok: true, value: { state: "ended" } });
    expect(await object.message("more")).toMatchObject({ ok: false, error: "run_ended" });
  });
});

/** A wait on a pending approval, until `inMs` from now. */
const approvalWait = (inMs: number) => ({
  kind: "approval" as const,
  id: `ap_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
  until: new Date(Date.now() + inMs).toISOString(),
  by_caller: true,
});

const parentWaits = async (parent: ReturnType<typeof agentRunOf>) => {
  const shown = await parent.show();

  return shown.ok ? (shown.value.waiting ?? []) : [];
};

describe("what a child run waits on (#232)", () => {
  it("shows in the run that started it, marked with the child, until its time and the grace passed", async () => {
    const { parent, child } = await family();
    const soon = approvalWait(60 * 60_000);

    expect(await parent.childWaiting(child, [soon])).toEqual({ ok: true, value: null });
    expect(await parentWaits(parent)).toEqual([{ ...soon, run: child }]);

    // A wait whose time passed more than a minute ago is not shown, though the child never said it ended.
    const past = approvalWait(-2 * 60_000);

    await parent.childWaiting(child, [past]);
    expect(await parentWaits(parent)).toEqual([]);

    // The child waits on nothing any more.
    await parent.childWaiting(child, [soon]);
    await parent.childWaiting(child, []);
    expect(await parentWaits(parent)).toEqual([]);

    // Only a run this one started tells it.
    expect(await parent.childWaiting("ar_someone_else", [soon])).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });

  it("is told again from the child's alarm after a telling failed, and cleared when the child is purged", async () => {
    const { o, parent, child, childOf } = await family();
    const object = await startedObject(o, child, { child: childOf });
    const soon = approvalWait(60 * 60_000);

    // The child's call waits on an approval, and its last telling failed.
    await runInDurableObject(agentRunOf(env, o.id, child), async (_instance, state) => {
      state.storage.kv.put("waiting", [soon]);
      state.storage.kv.put("waits-untold", true);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(agentRunOf(env, o.id, child))).toBe(true);
    expect(await parentWaits(parent)).toEqual([{ ...soon, run: child }]);
    expect(
      await runInDurableObject(agentRunOf(env, o.id, child), (_instance, state) =>
        state.storage.kv.get("waits-untold"),
      ),
    ).toBeUndefined();

    await object.purge();
    expect(await parentWaits(parent)).toEqual([]);
  });
});

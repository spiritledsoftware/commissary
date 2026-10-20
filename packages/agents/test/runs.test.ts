// The org's index of agent runs (#227, ADR 0040) in the Agents part over RPC: who starts and sees a run, idempotent
// starts, and what a turn reads: the definition as it stands when the turn starts, kept as the reach of every call of
// that turn (`turnContext`), so an edit, a disable or a revoked grant applies from the next turn, which ends the run
// when its agent or its starter can no longer go on. And the run's object, which takes a start only for the run it is.
// The turns themselves (models and tools through the API Worker's gateway) are the app Worker's tests'
// (apps/app/test/agent-runs.test.ts).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newOrgId } from "@commissary/core";
import { agentRunOf } from "../src/env.ts";
import { agentBody } from "./testing.ts";

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

const created = async (o: Org, viewer: Org["alice"], name: string, extra = {}) => {
  const result = await o.agents.createAgent(viewer, agentBody(name, MODEL, extra), FOUND, "test");

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value;
};

const started = async (o: Org, viewer: Org["alice"], agent: string, key?: string) => {
  const result = await o.agents.startRun(viewer, agent, "chat", key);

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value;
};

describe("starting a run", () => {
  it("is for an agent the member may use, once per idempotency key, and only its starter sees it", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");

    expect(await o.agents.startRun(o.bob, agent.id, "chat", undefined)).toMatchObject({
      ok: false,
      error: "not_found",
    });

    const first = await started(o, o.alice, agent.id, "key-1");
    const again = await started(o, o.alice, agent.id, "key-1");

    expect(first).toMatchObject({
      created: true,
      run: { trigger: "chat", starter: { kind: "member", id: o.alice.member }, state: "idle" },
    });
    expect(again).toEqual({ ...first, created: false });

    expect(await o.agents.getRun(o.alice, first.run.id)).toMatchObject({ ok: true });
    expect(await o.agents.getRun(o.bob, first.run.id)).toMatchObject({ error: "not_found" });
    expect(await o.agents.getRun(o.admin, first.run.id)).toMatchObject({ error: "not_found" });
    expect((await o.agents.listRuns(o.bob)).runs).toEqual([]);
  });
});

describe("a turn", () => {
  it("reads the definition when it starts, and every call of the turn keeps that reading", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");
    const { run } = await started(o, o.alice, agent.id);

    // No turn yet: the run calls nothing.
    expect(await o.agents.turnContext(run.id)).toMatchObject({ ok: false, error: "run_ended" });

    expect(await o.agents.beginTurn(run.id)).toMatchObject({
      ok: true,
      value: {
        runId: run.id,
        agentId: agent.id,
        starter: { kind: "member", id: o.alice.member },
        actsAs: { kind: "member", memberId: o.alice.member },
        model: MODEL,
      },
    });
    expect(await o.agents.getRun(o.alice, run.id)).toMatchObject({ value: { state: "running" } });

    // An edit and a disable during the turn: its calls keep the definition it started with.
    await o.agents.updateAgent(
      o.alice,
      agent.id,
      1,
      { model: "other-model" },
      { modelServed: true },
      "test",
    );
    await o.agents.updateAgent(o.alice, agent.id, 2, { enabled: false }, {}, "test");

    expect(await o.agents.turnContext(run.id)).toMatchObject({
      ok: true,
      value: { model: MODEL },
    });

    // The next turn reads them: the agent is disabled, so the run ends, and its calls are refused.
    expect(await o.agents.beginTurn(run.id)).toMatchObject({ ok: false, error: "run_ended" });
    await o.agents.runStateChanged(run.id, "ended");
    expect(await o.agents.turnContext(run.id)).toMatchObject({ ok: false, error: "run_ended" });

    // An ended run stays ended, whatever its object reports later.
    await o.agents.runStateChanged(run.id, "idle");
    expect(await o.agents.getRun(o.alice, run.id)).toMatchObject({ value: { state: "ended" } });
  });

  it("of a shared agent ends the run once its starter's grant is revoked, at the next turn", async () => {
    const o = await org();

    const agent = await created(o, o.admin, "support", {
      subject: { kind: "member", id: o.alice.member },
    });

    const { run } = await started(o, o.alice, agent.id);

    expect(await o.agents.beginTurn(run.id)).toMatchObject({
      ok: true,
      value: { actsAs: { kind: "agent" } },
    });

    const grant = (await o.agents.listGrants()).grants.find((g) => g.agent === agent.id);

    if (grant === undefined) throw new Error("no grant");
    expect(
      await o.agents.writeGrant({ id: grant.id, revision: grant.revision, value: null }, "test"),
    ).toMatchObject({ ok: true });

    // The running turn goes on; the next one does not start.
    expect(await o.agents.turnContext(run.id)).toMatchObject({ ok: true });
    expect(await o.agents.beginTurn(run.id)).toMatchObject({
      ok: false,
      error: "run_ended",
      message: "the run's starter may no longer use the agent",
    });
  });

  it("of a private agent stops at once when its member leaves the org: the run goes with them (#228)", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");
    const { run } = await started(o, o.alice, agent.id);

    expect(await o.agents.beginTurn(run.id)).toMatchObject({ ok: true });
    expect((await o.stub.removeMember(o.alice.member, OWNER)).ok).toBe(true);
    expect(await o.agents.turnContext(run.id)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("of a shared agent stops at once when its starter leaves the org: the run goes with them (#228)", async () => {
    const o = await org();
    const agent = await created(o, o.admin, "support", { subject: { kind: "everyone" } });
    const { run } = await started(o, o.alice, agent.id);

    expect(await o.agents.beginTurn(run.id)).toMatchObject({
      ok: true,
      value: { starterEmail: "alice@example.com" },
    });
    expect((await o.stub.removeMember(o.alice.member, OWNER)).ok).toBe(true);
    expect(await o.agents.turnContext(run.id)).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("the index", () => {
  it("ends a run whose object could not be started, and pages its runs for the org's deletion", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");
    const one = (await started(o, o.alice, agent.id)).run.id;
    const two = (await started(o, o.alice, agent.id)).run.id;

    // Only the starter abandons a run.
    await o.agents.abandonRun(o.bob, one);
    expect(await o.agents.getRun(o.alice, one)).toMatchObject({ value: { state: "idle" } });
    await o.agents.abandonRun(o.alice, one);
    expect(await o.agents.getRun(o.alice, one)).toMatchObject({ value: { state: "ended" } });
    expect(await o.agents.beginTurn(one)).toMatchObject({ ok: false, error: "run_ended" });

    const page = await o.agents.runsPage(1);

    expect(page.total).toBe(2);
    expect(page.ids).toHaveLength(1);

    await o.agents.forgetRuns([one, two]);
    expect(await o.agents.runsPage(10)).toEqual({ ids: [], total: 0 });
  });
});

describe("the run's object", () => {
  it("takes a start only for the run it is, so no caller makes it act as another run", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "helper");
    const { run } = await started(o, o.alice, agent.id);

    expect(
      await agentRunOf(env, o.id, run.id).start({ org: o.id, id: "ar_someone_else" }, "hi"),
    ).toMatchObject({ ok: false, error: "not_found" });
    expect(await agentRunOf(env, o.id, run.id).show()).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});

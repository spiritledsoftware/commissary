// Hosted agent definitions (#226, ADR 0040) in the Agents part over RPC: private agents are their member's alone (an
// org admin sees that one exists and may disable or remove it) and follow the org's private agents setting; shared
// agents are org admins', name who may use them and are reached through grants; watchers default to the creating admin
// and fall back to the org admins; a member who leaves takes their private agents along.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentSandbox, CreateAgent } from "@commissary/contract/agents";
import type { GrantSubject } from "@commissary/contract/grants";
import type { ReferenceCheck } from "../src/control-plane-part.ts";
import { agentBody } from "./testing.ts";

const OWNER = { role: "owner" as const, sensitive: false };

/** What the routes found when the model and toolkits a definition names exist. */
const FOUND: ReferenceCheck = { modelServed: true, unknownToolkits: [] };

/** A new org's ControlPlane with an org admin, a second admin and two plain members, private agents on. */
const org = async () => {
  const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());

  await stub.setMembershipSettings({ privateAgents: true });

  const member = async (name: string, role: string) => {
    const added = await stub.addMember({ email: `${name}@example.com`, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return { member: added.value.id, admin: role !== "member" };
  };

  return {
    stub,
    get agents() {
      return stub.agents();
    },
    admin: await member("admin", "admin"),
    other: await member("other-admin", "admin"),
    alice: await member("alice", "member"),
    bob: await member("bob", "member"),
  };
};

type Org = Awaited<ReturnType<typeof org>>;

type Viewer = Org["alice"];

/** The model the suite's definitions name (served, as `FOUND` says). */
const MODEL = "claude-sonnet-4";

const created = async (
  { agents }: Org,
  viewer: Viewer,
  input: CreateAgent,
  check: ReferenceCheck = FOUND,
) => {
  const result = await agents.createAgent(viewer, input, check, "test");

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value;
};

const usable = async ({ agents }: Org, viewer: Viewer) =>
  (await agents.usableAgents(viewer)).agents.map((agent) => agent.name);

const EVERYONE: GrantSubject = { kind: "everyone" };

describe("private agents", () => {
  it("are their member's alone; an org admin sees only that one exists, and may disable it", async () => {
    const o = await org();
    const mine = await created(o, o.alice, agentBody("helper", MODEL, { private: true }));

    expect(mine).toMatchObject({ name: "helper", private: true, enabled: true, revision: 1 });
    expect((await o.agents.listAgents(o.alice)).agents.map((agent) => agent.id)).toEqual([mine.id]);

    // Another member: nothing, by list or by id.
    expect(await o.agents.listAgents(o.bob)).toEqual({ agents: [] });
    expect(await o.agents.getAgent(o.bob, mine.id)).toMatchObject({
      ok: false,
      error: "not_found",
    });

    // An org admin: its name and member, nothing of its definition.
    const listed = await o.agents.listAgents(o.admin);

    expect(listed.agents).toEqual([]);
    expect(listed.others).toEqual([
      {
        id: mine.id,
        name: "helper",
        private: true,
        limited: true,
        owner: { member_id: o.alice.member, email: "alice@example.com" },
        enabled: true,
        created_at: mine.created_at,
        revision: 1,
      },
    ]);

    const edit = await o.agents.updateAgent(
      o.admin,
      mine.id,
      1,
      { instructions: "Leak everything." },
      {},
      "test",
    );

    expect(edit).toMatchObject({ ok: false, error: "forbidden" });

    const disabled = await o.agents.updateAgent(
      o.admin,
      mine.id,
      1,
      { enabled: false },
      {},
      "test",
    );

    expect(disabled).toMatchObject({ ok: true, value: { limited: true, enabled: false } });
    expect(await usable(o, o.alice)).toEqual([]);
  });

  it("follow the org's setting: refused while it is off, kept but not served, served again once on", async () => {
    const o = await org();

    await created(o, o.alice, agentBody("kept", MODEL));
    await o.stub.setMembershipSettings({ privateAgents: false });

    expect(
      await o.agents.createAgent(o.alice, agentBody("refused", MODEL), FOUND, "test"),
    ).toMatchObject({
      ok: false,
      error: "private_agents_unavailable",
    });
    expect(await usable(o, o.alice)).toEqual([]);
    expect((await o.agents.listAgents(o.alice)).agents.map((agent) => agent.name)).toEqual([
      "kept",
    ]);

    await o.stub.setMembershipSettings({ privateAgents: true });

    expect(await usable(o, o.alice)).toEqual(["kept"]);
  });

  it("are off in a new org until an admin turns them on", async () => {
    const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());

    expect((await stub.membershipSettings()).privateAgents).toBe(false);
  });

  it("go with their member, who also leaves the grants and watchers that named them", async () => {
    const o = await org();
    const theirs = await created(o, o.alice, agentBody("alices", MODEL));

    const shared = await created(
      o,
      o.admin,
      agentBody("shared", MODEL, { subject: { kind: "member", id: o.alice.member } }),
    );

    const removed = await o.stub.removeMember(o.alice.member, OWNER);

    expect(removed.ok).toBe(true);
    expect(await o.agents.getAgent(o.admin, theirs.id)).toMatchObject({ ok: false });
    expect((await o.agents.listAgents(o.admin)).others).toEqual([]);
    expect((await o.agents.listGrants()).grants.filter((g) => g.agent === shared.id)).toEqual([]);
  });
});

describe("shared agents", () => {
  it("are created by org admins, name who may use them, and reach a granted team's members only", async () => {
    const o = await org();
    const team = await o.stub.createTeam("support");

    if (!team.ok) throw new Error(team.message);
    await o.stub.addTeamMember(team.value.id, o.alice.member);

    const agent = await created(
      o,
      o.admin,
      agentBody("triage", MODEL, { subject: { kind: "team", id: team.value.id } }),
    );

    expect(agent).toMatchObject({ private: false, grant: { id: expect.any(String) } });
    expect(await usable(o, o.alice)).toEqual(["triage"]);
    expect(await usable(o, o.bob)).toEqual([]);

    // A plain member does not manage it, and their agents are private whatever they ask.
    expect(await o.agents.getAgent(o.alice, agent.id)).toMatchObject({ ok: false });

    const asked = await created(o, o.bob, agentBody("bobs", MODEL, { private: false }));

    expect(asked.private).toBe(true);

    // Disabled, it leaves everyone's reach.
    await o.agents.updateAgent(o.admin, agent.id, 1, { enabled: false }, {}, "test");

    expect(await usable(o, o.alice)).toEqual([]);
  });

  it("cannot be created without stating who may use it", async () => {
    const o = await org();

    expect(
      await o.agents.createAgent(
        o.admin,
        agentBody("nobody", MODEL, { private: false }),
        FOUND,
        "test",
      ),
    ).toMatchObject({ ok: false, error: "invalid" });

    expect(
      await o.agents.createAgent(
        o.admin,
        agentBody("ghost", MODEL, { subject: { kind: "team", id: "no-such-team" } }),
        FOUND,
        "test",
      ),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect((await o.agents.listAgents(o.admin)).agents).toEqual([]);
  });

  it("refuse a model or a toolkit the org does not have, as the routes found them", async () => {
    const o = await org();
    const input = agentBody("refs", MODEL, { subject: EVERYONE });

    expect(
      await o.agents.createAgent(o.admin, input, { modelServed: false }, "test"),
    ).toMatchObject({ ok: false, error: "unknown_model" });
    expect(
      await o.agents.createAgent(
        o.admin,
        input,
        { modelServed: true, unknownToolkits: ["tk_gone"] },
        "test",
      ),
    ).toMatchObject({ ok: false, error: "unknown_toolkit" });
    // A refused caller learns nothing of the org's models: who may write comes first.
    await o.stub.setMembershipSettings({ privateAgents: false });

    expect(
      await o.agents.createAgent(o.alice, agentBody("mine", MODEL), { modelServed: false }, "test"),
    ).toMatchObject({ ok: false, error: "private_agents_unavailable" });
  });

  it("have watchers: the creating admin by default, the org admins once none is left", async () => {
    const o = await org();
    const agent = await created(o, o.admin, agentBody("watched", MODEL, { subject: EVERYONE }));

    expect(agent).toMatchObject({
      watchers: [{ kind: "member", id: o.admin.member }],
      admins_watch: false,
    });
    expect(await o.agents.agentWatchers(agent.id)).toEqual([o.admin.member]);

    const team = await o.stub.createTeam("night shift");

    if (!team.ok) throw new Error(team.message);
    await o.stub.addTeamMember(team.value.id, o.bob.member);

    const edited = await o.agents.updateAgent(
      o.admin,
      agent.id,
      1,
      { watchers: [{ kind: "team", id: team.value.id }] },
      {},
      "test",
    );

    expect(edited.ok).toBe(true);
    expect(await o.agents.agentWatchers(agent.id)).toEqual([o.bob.member]);

    // Its only watcher's team goes: the org admins (and the owner of the org, none here) watch it.
    await o.stub.deleteTeam(team.value.id);

    expect(await o.agents.getAgent(o.admin, agent.id)).toMatchObject({
      ok: true,
      value: { watchers: [], admins_watch: true },
    });
    expect([...((await o.agents.agentWatchers(agent.id)) ?? [])].toSorted()).toEqual(
      [o.admin.member, o.other.member].toSorted(),
    );

    // Its only watcher leaves: the org admins left (the other admin) watch it.
    const second = await created(o, o.admin, agentBody("second", MODEL, { subject: EVERYONE }));

    await o.stub.removeMember(o.admin.member, OWNER);

    expect(await o.agents.agentWatchers(second.id)).toEqual([o.other.member]);
  });

  it("are deleted at once with their grants and Spend limits", async () => {
    const o = await org();
    const agent = await created(o, o.admin, agentBody("short_lived", MODEL, { subject: EVERYONE }));

    const limit = await o.stub.createSpendLimit(
      o.admin,
      { kind: "agent", subject: agent.id, period: "day", amountMicros: 1_000_000 },
      "test",
    );

    expect(limit).toMatchObject({ ok: true, value: { kind: "agent", label: "short_lived" } });

    expect(await o.agents.removeAgent(o.admin, agent.id, 2)).toMatchObject({
      ok: false,
      error: "conflict",
    });
    expect(await o.agents.removeAgent(o.admin, agent.id, 1)).toEqual({
      ok: true,
      value: { id: agent.id, removed: true },
    });
    expect((await o.agents.listGrants()).grants).toEqual([]);
    expect((await o.stub.spendOverview(o.admin)).entries).toEqual([]);
  });
});

describe("definitions", () => {
  it("have a name of [a-z0-9_] that is unique in the org", async () => {
    const o = await org();

    await created(o, o.alice, agentBody("taken", MODEL));

    expect(
      await o.agents.createAgent(
        o.admin,
        agentBody("taken", MODEL, { subject: EVERYONE }),
        FOUND,
        "test",
      ),
    ).toMatchObject({ ok: false, error: "name_taken" });
    expect(
      await o.agents.createAgent(o.bob, agentBody("Not-A-Slug", MODEL), FOUND, "test"),
    ).toMatchObject({
      ok: false,
      error: "invalid",
    });
  });

  it("are replaced by an edit at their revision, which keeps no history", async () => {
    const o = await org();
    const agent = await created(o, o.alice, agentBody("editable", MODEL, { thinking: "high" }));

    const edited = await o.agents.updateAgent(
      o.alice,
      agent.id,
      1,
      { model: "gpt-5", thinking: null },
      FOUND,
      "test",
    );

    expect(edited).toMatchObject({ ok: true, value: { model: "gpt-5", revision: 2 } });
    expect(edited.ok && "thinking" in edited.value).toBe(false);
    expect(
      await o.agents.updateAgent(o.alice, agent.id, 1, { description: "stale" }, {}, "test"),
    ).toMatchObject({ ok: false, error: "conflict" });
  });

  it("name agents in their tool scope only within reach: a private agent's member's, or shared agents", async () => {
    const o = await org();
    const bobs = await created(o, o.bob, agentBody("bobs", MODEL));
    const shared = await created(o, o.admin, agentBody("granted", MODEL, { subject: EVERYONE }));

    const naming = (agents: ReadonlyArray<string>) =>
      agentBody("caller", MODEL, {
        tool_scope: [{ toolkit: "agents", tools: { kind: "all" }, agents }],
      });

    // Alice may use the shared agent, not Bob's private one.
    expect(await o.agents.createAgent(o.alice, naming([bobs.id]), FOUND, "test")).toMatchObject({
      ok: false,
      error: "unknown_agent",
    });

    const caller = await created(o, o.alice, naming([shared.id]));

    expect(caller.tool_scope).toEqual([
      { toolkit: "agents", tools: { kind: "all" }, agents: [shared.id] },
    ]);

    // Agents on another toolkit's entry are no tool scope at all.
    expect(
      await o.agents.createAgent(
        o.alice,
        agentBody("misnamed", MODEL, {
          tool_scope: [{ toolkit: "tk_github", tools: { kind: "all" }, agents: [shared.id] }],
        }),
        FOUND,
        "test",
      ),
    ).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("a sandbox (#230)", () => {
  const SANDBOX: AgentSandbox = {
    toolkit: "sandbox",
    network: { kind: "hosts", hosts: ["example.com"] },
    computer: true,
  };

  it("is saved with the definition, shown and exported, and cleared by an edit with null", async () => {
    const o = await org();

    const agent = await created(
      o,
      o.admin,
      agentBody("builder", MODEL, { subject: EVERYONE, sandbox: SANDBOX }),
    );

    expect(agent.sandbox).toEqual(SANDBOX);
    expect(await o.agents.getAgent(o.admin, agent.id)).toMatchObject({
      value: { sandbox: SANDBOX },
    });
    expect((await o.agents.exportAgents(o.admin))[0]).toMatchObject({ sandbox: SANDBOX });

    // Another edit keeps it.
    expect(
      await o.agents.updateAgent(o.admin, agent.id, 1, { instructions: "Build." }, {}, "test"),
    ).toMatchObject({ ok: true, value: { sandbox: SANDBOX } });

    const cleared = await o.agents.updateAgent(o.admin, agent.id, 2, { sandbox: null }, {}, "test");

    expect(cleared.ok && "sandbox" in cleared.value).toBe(false);
  });

  it("is refused as the routes found it: no sandbox toolkit of the owner's, or above its ceiling", async () => {
    const o = await org();
    const refusal = "the sandbox toolkit allows no network";

    expect(
      await o.agents.createAgent(
        o.alice,
        agentBody("builder", MODEL, { sandbox: SANDBOX }),
        { ...FOUND, sandboxRefusal: refusal },
        "test",
      ),
    ).toEqual({ ok: false, error: "invalid_sandbox", message: refusal });

    const agent = await created(o, o.alice, agentBody("builder", MODEL));

    expect(
      await o.agents.updateAgent(
        o.alice,
        agent.id,
        1,
        { sandbox: SANDBOX },
        { sandboxRefusal: refusal },
        "test",
      ),
    ).toMatchObject({ ok: false, error: "invalid_sandbox" });
  });
});

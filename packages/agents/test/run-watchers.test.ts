// Who sees and answers a run (#232, ADR 0040 "Who watches and steers") in the Agents part over RPC: a run's starter
// sees it whole; a shared agent's watchers see the runs no one started (its triggers'); an org admin sees every shared
// agent's run as its metadata, never a private agent's; anyone else gets it as an unknown run. And who answers a run's
// approvals and handoffs (`runWatchers`, which the Tools part reads): the member at the head of its chain, or, for a
// run no one started, its agent's watchers, its child runs' too. The panel's routes over these, and the approvals and
// handoffs a run parks on, are the app Worker's tests' (apps/app/test/agent-runs.test.ts).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newOrgId } from "@commissary/core";
import { panelLinkOf, panelOrigin } from "../src/runs/wait-links.ts";
import { agentBody } from "./testing.ts";

const OWNER = { role: "owner" as const, sensitive: false };

const FOUND = { modelServed: true, unknownToolkits: [] };

const MODEL = "claude-sonnet-4";

/** A new org's ControlPlane with an org admin and three plain members, private agents on. */
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
    carol: await member("carol", "member"),
  };
};

type Org = Awaited<ReturnType<typeof org>>;

type Viewer = Org["alice"];

const created = async (o: Org, viewer: Viewer, name: string, extra = {}) => {
  const result = await o.agents.createAgent(viewer, agentBody(name, MODEL, extra), FOUND, "test");

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value;
};

/** A shared agent everyone may use, which `watcher` watches. */
const shared = (o: Org, name: string, watcher: Viewer) =>
  created(o, o.admin, name, {
    subject: { kind: "everyone" },
    watchers: [{ kind: "member", id: watcher.member }],
  });

const started = async (o: Org, viewer: Viewer, agent: string) => {
  const result = await o.agents.startRun(viewer, agent, "chat", undefined);

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value.run.id;
};

/** A run of the shared agent `agent` that no one started: its webhook's delivery. */
const unattended = async (o: Org, agent: string, delivery = "delivery-1") => {
  const hook = await o.agents.createTrigger(
    { viewer: o.admin, agentId: agent, origin: "https://api.example.com", by: "test" },
    { kind: "webhook", name: "Raw" },
  );

  if (!hook.ok) throw new Error(hook.message);
  const result = await o.agents.startWebhookRun(hook.value.id, `webhook:id:${delivery}`);

  if (!result.ok) throw new Error(result.message);
  expect(result.value.run.starter).toBeUndefined();

  return result.value.run.id;
};

/** Begins the run's first turn, so it has a definition to start child runs by. */
const begun = async (o: Org, runId: string) => {
  const turn = await o.agents.beginTurn(runId);

  if (!turn.ok) throw new Error(`${turn.error}: ${turn.message}`);

  return runId;
};

/** A child run of `agent` that the run `parent` starts. */
const child = async (o: Org, parent: string, agent: string) => {
  const result = await o.agents.startToolkitRun(
    { kind: "run", runId: parent },
    agent,
    undefined,
    undefined,
  );

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value.run.id;
};

describe("a run in the panel", () => {
  it("is its starter's whole, a shared agent's admins' as metadata, and no other member's", async () => {
    const o = await org();
    const agent = await shared(o, "support", o.bob);
    const run = await started(o, o.alice, agent.id);

    expect(await o.agents.viewRun(o.alice, run)).toMatchObject({
      ok: true,
      value: { id: run, access: "starter" },
    });
    // Its agent's watcher watches only the runs no one started.
    expect(await o.agents.viewRun(o.bob, run)).toMatchObject({ ok: false, error: "not_found" });
    expect(await o.agents.viewRun(o.carol, run)).toMatchObject({ ok: false, error: "not_found" });
    expect(await o.agents.viewRun(o.admin, run)).toMatchObject({
      ok: true,
      value: { id: run, access: "admin" },
    });

    expect((await o.agents.viewRuns(o.alice)).runs).toMatchObject([{ id: run, access: "starter" }]);
    expect((await o.agents.viewRuns(o.admin)).runs).toMatchObject([{ id: run, access: "admin" }]);
    expect((await o.agents.viewRuns(o.bob)).runs).toEqual([]);
  });

  it("of a private agent is its member's alone to see; an org admin cancels it, seeing nothing of it", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "mine");
    const run = await started(o, o.alice, agent.id);

    expect(await o.agents.viewRun(o.admin, run)).toMatchObject({ ok: false, error: "not_found" });
    expect((await o.agents.viewRuns(o.admin)).runs).toEqual([]);

    // Any run of the org is an org admin's to cancel (ADR 0040), with no view of it; its member's with its view.
    expect(await o.agents.cancellableRun(o.admin, run)).toEqual({ ok: true, value: null });
    expect(await o.agents.cancellableRun(o.alice, run)).toMatchObject({
      ok: true,
      value: { id: run, access: "starter" },
    });
    expect(await o.agents.cancellableRun(o.bob, run)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await o.agents.cancellableRun(o.admin, "ar_unknown")).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("that no one started is its shared agent's watchers', and an org admin's as metadata", async () => {
    const o = await org();
    const agent = await shared(o, "intake", o.bob);
    const run = await unattended(o, agent.id);

    expect(await o.agents.viewRun(o.bob, run)).toMatchObject({
      ok: true,
      value: { id: run, access: "watcher" },
    });
    expect(await o.agents.viewRun(o.carol, run)).toMatchObject({ ok: false, error: "not_found" });
    expect(await o.agents.viewRun(o.admin, run)).toMatchObject({ value: { access: "admin" } });

    expect((await o.agents.viewRuns(o.bob)).runs).toMatchObject([{ id: run, access: "watcher" }]);
    expect((await o.agents.viewRuns(o.carol)).runs).toEqual([]);

    // The runs before #232's routes: a starter's only.
    expect(await o.agents.getRun(o.bob, run)).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("a run's watchers", () => {
  it("are its starter, or the head of its chain's, or its agent's watchers when no one started it", async () => {
    const o = await org();
    const support = await shared(o, "support", o.bob);

    await shared(o, "helper", o.carol);

    // A member's run, and its child run: the member answers both.
    const own = await begun(o, await started(o, o.alice, support.id));
    const ownChild = await child(o, own, "helper");

    expect(await o.agents.runWatchers(own)).toEqual([o.alice.member]);
    expect(await o.agents.runWatchers(ownChild)).toEqual([o.alice.member]);

    // A run no one started, and its child run of another agent: the head agent's watchers answer both.
    const raw = await begun(o, await unattended(o, support.id));
    const rawChild = await child(o, raw, "helper");

    expect(await o.agents.runWatchers(raw)).toEqual([o.bob.member]);
    expect(await o.agents.runWatchers(rawChild)).toEqual([o.bob.member]);

    // Panel views of child runs (#234): those who answer the chain watch them too, so a parent's transcript links them;
    // an org admin sees their metadata; anyone else, the helper agent's own watcher included, an unknown run.
    expect(await o.agents.viewRun(o.admin, rawChild)).toMatchObject({ value: { access: "admin" } });
    expect(await o.agents.viewRun(o.bob, rawChild)).toMatchObject({
      ok: true,
      value: { id: rawChild, access: "watcher" },
    });
    expect(await o.agents.viewRun(o.alice, ownChild)).toMatchObject({
      ok: true,
      value: { id: ownChild, access: "watcher" },
    });

    for (const [viewer, run] of [
      [o.carol, rawChild],
      [o.carol, ownChild],
      [o.bob, ownChild],
      [o.alice, rawChild],
    ] as const)
      expect(await o.agents.viewRun(viewer, run)).toMatchObject({ ok: false, error: "not_found" });

    // They list them too, and cancel and delete them as any run they watch.
    expect((await o.agents.viewRuns(o.alice)).runs.map((each) => each.id).toSorted()).toEqual(
      [own, ownChild].toSorted(),
    );
    expect((await o.agents.viewRuns(o.carol)).runs).toEqual([]);
    expect(await o.agents.cancellableRun(o.bob, rawChild)).toMatchObject({
      ok: true,
      value: { access: "watcher" },
    });
    expect(await o.agents.deleteRun(o.alice, ownChild)).toEqual({
      ok: true,
      value: { deleted: 1 },
    });

    expect(await o.agents.runWatchers("run_unknown")).toEqual([]);
  });

  it("of a child run a private agent's run started name that run to an org admin by its kind only", async () => {
    const o = await org();

    await shared(o, "helper", o.carol);
    const mine = await created(o, o.alice, "mine");
    const head = await begun(o, await started(o, o.alice, mine.id));
    const id = await child(o, head, "helper");

    const seen = await o.agents.viewRun(o.admin, id);

    expect(seen).toMatchObject({ ok: true, value: { access: "admin", starter: { kind: "run" } } });
    expect(seen.ok && seen.value.starter).toEqual({ kind: "run" });
    // The member who started the head sees it through the agents toolkit only, as before.
    expect(await o.agents.runWatchers(id)).toEqual([o.alice.member]);
  });

  it("follow the agent's watchers as they change", async () => {
    const o = await org();
    const agent = await shared(o, "intake", o.bob);
    const run = await unattended(o, agent.id);

    const edited = await o.agents.updateAgent(
      o.admin,
      agent.id,
      agent.revision,
      { watchers: [{ kind: "member", id: o.carol.member }] },
      {},
      "test",
    );

    expect(edited.ok).toBe(true);
    expect(await o.agents.runWatchers(run)).toEqual([o.carol.member]);
    expect(await o.agents.viewRun(o.carol, run)).toMatchObject({ value: { access: "watcher" } });
    expect(await o.agents.viewRun(o.bob, run)).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("a wait's link", () => {
  const panel = panelOrigin("app.example.com");
  const approval = `ap_${"a1".repeat(12)}`;
  const session = `bs_${"b2".repeat(16)}`;

  const wait = (kind: "approval" | "handoff", id: string, link: string) => ({
    kind,
    id,
    until: new Date().toISOString(),
    link,
    by_caller: true,
  });

  it("is asked only as the panel's page of that very approval or browser session", () => {
    const page = `https://app.example.com/o/acme/approvals/${approval}`;
    const sessionPage = `https://app.example.com/o/acme/tools/sessions/${session}`;

    expect(panelLinkOf(wait("approval", approval, page), panel)).toBe(page);
    expect(panelLinkOf(wait("handoff", session, sessionPage), panel)).toBe(sessionPage);

    for (const forged of [
      `https://attacker.example/o/acme/approvals/${approval}`,
      `http://app.example.com/o/acme/approvals/${approval}`,
      `https://app.example.com/o/acme/approvals/${approval}?next=https://attacker.example`,
      `https://user@app.example.com/o/acme/approvals/${approval}`,
      `https://app.example.com/o/acme/approvals/ap_${"0".repeat(24)}`,
      `https://app.example.com/o/acme/tools/sessions/${approval}`,
      "not a url",
    ])
      expect(panelLinkOf(wait("approval", approval, forged), panel)).toBeUndefined();

    // An id of another form, or no panel's host, is never asked.
    expect(
      panelLinkOf(wait("approval", "ap_x", "https://app.example.com/o/acme/approvals/ap_x"), panel),
    ).toBeUndefined();
    expect(panelLinkOf(wait("approval", approval, page), panelOrigin(undefined))).toBeUndefined();
  });
});

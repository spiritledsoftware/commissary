// Approval rules and pending approvals (#201, ADR 0038) in the Tools part over RPC, against fake MCP servers served in
// workerd: the toolkit-wide write rule and marks on single tools make calls wait, on shared and private credentials
// alike; the caller approves on a form, or an approver in the panel, after which the identical call goes through once
// within the hour; the caller never approves their own call under a team or list rule; and the arguments, sealed at
// rest, are gone after the decision and with the approval after the hour. `TestClock` drives the hour.
import { env, runInDurableObject } from "cloudflare:test";
import { type Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { ApprovalRules } from "@commissary/contract/approvals";
import type { FormAction, ToolCall } from "../src/control-plane-part.ts";
import { fakeMcpServer, serveFakeMcpServers } from "./support/mcp-server.ts";

serveFakeMcpServers();

const POLICY = { ownHosts: [], localDevelopment: false };

const OWNER = { role: "owner" as const, sensitive: false };

/** A new org's ControlPlane with an org admin, alice, bob and carol, private credentials and toolkits on. */
const org = async () => {
  const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());

  await stub.setMembershipSettings({ privateCredentials: true, privateToolkits: true });

  const member = async (name: string, role: string) => {
    const added = await stub.addMember({ email: `${name}@example.com`, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return { member: added.value.id, admin: role !== "member" };
  };

  return {
    stub,
    get tools() {
      return stub.tools();
    },
    admin: await member("admin", "admin"),
    alice: await member("alice", "member"),
    bob: await member("bob", "member"),
    carol: await member("carol", "member"),
  };
};

type Org = Awaited<ReturnType<typeof org>>;

type Viewer = Org["alice"];

const GITHUB_TOOLS = [
  { name: "create_issue" },
  { name: "list_issues", annotations: { readOnlyHint: true } },
  { name: "delete_repo" },
];

/** A fake server whose calls answer `called <tool> <arguments>`. */
const server = () =>
  fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
    tools: GITHUB_TOOLS,
    call: (name, args) => ({
      content: [{ type: "text", text: `called ${name} ${JSON.stringify(args ?? {})}` }],
    }),
  });

/** An org toolkit `github` that takes both credentials, its shared one granted to everyone. */
const orgToolkit = async (plane: Org) => {
  const upstream = server();

  const added = await plane.tools.addToolkit(
    plane.admin,
    {
      source: upstream.url,
      name: "github",
      private: false,
      accepts: "both",
      credential: { kind: "bearer", token: "shared", subject: { kind: "everyone" } },
    },
    "test",
    POLICY,
  );

  if (!added.ok) throw new Error(added.message);

  return { upstream, id: added.value.id, revision: added.value.revision };
};

/** Sets a toolkit's approval rules as `viewer`; answers the new revision or the refusal's code. */
const setRules = async (
  plane: Org,
  viewer: Viewer,
  toolkit: string,
  rules: ApprovalRules | null,
): Promise<number | string> => {
  const current = (await plane.tools.listToolkits(viewer)).toolkits.find(
    (found) => found.id === toolkit,
  );

  const updated = await plane.tools.updateToolkit(
    viewer,
    toolkit,
    current?.revision ?? 0,
    { approval_rules: rules },
    "test",
    POLICY,
  );

  return updated.ok ? updated.value.revision : updated.error;
};

/**
 * What a call came to: the text a result answered, or the outcome (`pending`, `not_approved`, `approve`, ...). The call
 * understands the approval outcomes, as the MCP endpoint's does, unless `extra` says otherwise.
 */
const call = async (
  plane: Org,
  viewer: Viewer,
  name: string,
  args: Record<string, string> = {},
  extra: Partial<ToolCall> = {},
) => {
  const outcome = await plane.tools.callTool(
    viewer,
    {
      name,
      arguments: args,
      principalId: `user:${viewer.member}`,
      approvalOutcomes: true,
      ...extra,
    },
    POLICY,
  );

  if (outcome.outcome !== "result") return outcome;
  // SAFETY: the fake answers one text content (`server`).
  const [content] = outcome.result["content"] as ReadonlyArray<{ text: string }>;

  return { outcome: "result" as const, text: content?.text, usage: outcome.usage };
};

/** The id of the pending approval a call answered with. */
const pendingId = (outcome: Awaited<ReturnType<typeof call>>): string => {
  if (outcome.outcome !== "pending") throw new Error(`the call came to ${outcome.outcome}`);

  return outcome.approval.id;
};

/** The stored row of an approval, as SQLite holds it. */
const row = async (plane: Org, id: string) =>
  runInDurableObject(
    plane.stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{
          arguments: string | null;
          status: string;
        }>(`SELECT arguments, status FROM tool_approvals WHERE id = ?`, id)
        .toArray()[0],
  );

/** A `TestClock` at the real time, which the org's Tools part reads the time from from now on; `adjust` moves it. */
const testClock = async (plane: Org) => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  await Effect.runPromise(clock.setTime(Date.now()));
  await runInDurableObject(plane.stub, (instance) => instance.tools().useClock(clock));

  return { adjust: (duration: Duration.Input) => Effect.runPromise(clock.adjust(duration)) };
};

describe("approval rules", () => {
  it("the write rule makes write tools wait and lets read tools through", async () => {
    const plane = await org();
    const { id, upstream } = await orgToolkit(plane);

    expect(await setRules(plane, plane.admin, id, { writes: {} })).toBeTypeOf("number");

    expect(await call(plane, plane.alice, "github_list_issues")).toMatchObject({
      outcome: "result",
      usage: { approval: "none" },
    });
    expect(await call(plane, plane.alice, "github_create_issue")).toMatchObject({
      outcome: "pending",
      approval: { approver: { kind: "caller" } },
      usage: { approval: "pending", credential: "shared" },
    });
    expect(
      upstream.requests
        .filter((request) => request.rpc === "tools/call")
        .map((r) => r.params?.["name"]),
    ).toEqual(["list_issues"]);
  });

  it("per-tool marks make those tools wait, whatever their class", async () => {
    const plane = await org();
    const { id } = await orgToolkit(plane);

    await setRules(plane, plane.admin, id, { tools: [{ id: `${id}:list_issues` }] });

    expect((await call(plane, plane.alice, "github_list_issues")).outcome).toBe("pending");
    expect((await call(plane, plane.alice, "github_create_issue")).outcome).toBe("result");

    const view = (await plane.tools.listToolkits(plane.alice)).toolkits[0];

    expect(view?.approval_rules).toEqual({
      tools: [{ id: `${id}:list_issues`, approver: { kind: "caller" } }],
    });
  });

  it("follow a reclassified tool: a write tool classed read passes, a read tool classed write waits", async () => {
    const plane = await org();
    const { id } = await orgToolkit(plane);

    await setRules(plane, plane.admin, id, { writes: {} });

    for (const [tool, toolClass] of [
      ["create_issue", "read"],
      ["list_issues", "write"],
    ] as const) {
      const set = await plane.tools.setOverride(
        plane.admin,
        id,
        0,
        { tool, class: toolClass },
        "test",
      );

      expect(set.ok).toBe(true);
    }

    expect((await call(plane, plane.alice, "github_create_issue")).outcome).toBe("result");
    expect((await call(plane, plane.alice, "github_list_issues")).outcome).toBe("pending");
  });

  it("apply on shared and private credentials alike", async () => {
    const plane = await org();
    const { id, upstream } = await orgToolkit(plane);

    await setRules(plane, plane.admin, id, { writes: {} });

    const connected = await plane.tools.connectCredential(
      plane.bob,
      id,
      "private",
      { kind: "bearer", token: "bob-own" },
      "test",
      POLICY,
    );

    expect(connected.ok).toBe(true);

    expect(await call(plane, plane.alice, "github_delete_repo")).toMatchObject({
      outcome: "pending",
      usage: { credential: "shared", private: false },
    });
    expect(await call(plane, plane.bob, "github_delete_repo")).toMatchObject({
      outcome: "pending",
      usage: { credential: "private", private: true },
    });
    expect(upstream.requests.filter((request) => request.rpc === "tools/call")).toEqual([]);
  });

  it("are set by org admins on org toolkits and by a member on their own private toolkits only", async () => {
    const plane = await org();
    const { id } = await orgToolkit(plane);

    expect(await setRules(plane, plane.alice, id, { writes: {} })).toBe("forbidden");

    const upstream = server();

    const own = await plane.tools.addToolkit(
      plane.alice,
      {
        source: upstream.url,
        name: "mine",
        private: true,
        accepts: "private",
        credential: { kind: "none" },
      },
      "test",
      POLICY,
    );

    if (!own.ok) throw new Error(own.message);

    expect(
      await setRules(plane, plane.alice, own.value.id, {
        tools: [{ id: `${own.value.id}:list_issues` }],
      }),
    ).toBeTypeOf("number");
    expect(await setRules(plane, plane.bob, own.value.id, { writes: {} })).toBe("not_found");

    expect(await call(plane, plane.alice, "mine_list_issues")).toMatchObject({
      outcome: "pending",
      usage: { credential: "private", private: true },
    });
    expect((await call(plane, plane.alice, "mine_create_issue")).outcome).toBe("result");
  });

  it("refuse a mark of another toolkit's tool and an approver the org does not have, and clear with null", async () => {
    const plane = await org();
    const { id } = await orgToolkit(plane);

    expect(await setRules(plane, plane.admin, id, { tools: [{ id: "tk_other:x" }] })).toBe(
      "invalid",
    );
    expect(
      await setRules(plane, plane.admin, id, {
        writes: { approver: { kind: "team", id: "no-such-team" } },
      }),
    ).toBe("invalid");
    expect(
      await setRules(plane, plane.admin, id, {
        writes: { approver: { kind: "members", ids: ["no-such-member"] } },
      }),
    ).toBe("invalid");

    await setRules(plane, plane.admin, id, { writes: {} });
    await setRules(plane, plane.admin, id, null);

    expect((await call(plane, plane.alice, "github_create_issue")).outcome).toBe("result");
    expect((await plane.tools.listToolkits(plane.admin)).toolkits[0]).not.toHaveProperty(
      "approval_rules",
    );
  });
});

describe("a caller who is the approver, on a form", () => {
  /** The form a call of `github_create_issue` with `args` is answered with, as `viewer`: its `requestState`. */
  const asked = async (plane: Org, viewer: Viewer, args: Record<string, string>) => {
    const outcome = await call(plane, viewer, "github_create_issue", args, { approvalForm: {} });

    if (outcome.outcome !== "approve") throw new Error(`the call came to ${outcome.outcome}`);

    return outcome.requestState;
  };

  /** The call made again with the answer `answer` and the form's `requestState`. */
  const answered = (
    plane: Org,
    viewer: Viewer,
    args: Record<string, string>,
    answer: FormAction,
    requestState?: string,
  ) => call(plane, viewer, "github_create_issue", args, { approvalForm: { answer, requestState } });

  const formOrg = async () => {
    const plane = await org();
    const toolkit = await orgToolkit(plane);

    await setRules(plane, plane.admin, toolkit.id, { writes: {} });

    return { plane, toolkit };
  };

  /** The tool calls the upstream got. */
  const upstreamCalls = (toolkit: Awaited<ReturnType<typeof orgToolkit>>) =>
    toolkit.upstream.requests.filter((request) => request.rpc === "tools/call");

  it("is asked, and the call made again with the answer and the form's state goes through once, or is denied", async () => {
    const { plane, toolkit } = await formOrg();

    expect(
      await call(plane, plane.alice, "github_create_issue", { title: "x" }, { approvalForm: {} }),
    ).toEqual({
      outcome: "approve",
      toolkit: { id: toolkit.id, name: "github" },
      arguments: { title: "x" },
      requestState: expect.any(String),
    });

    const state = await asked(plane, plane.alice, { title: "x" });

    expect(await answered(plane, plane.alice, { title: "x" }, "accept", state)).toMatchObject({
      outcome: "result",
      text: 'called create_issue {"title":"x"}',
      usage: { approval: "approved_elicitation" },
    });
    // A form is answered once: the same answer again is no answer, and the caller is asked anew.
    expect((await answered(plane, plane.alice, { title: "x" }, "accept", state)).outcome).toBe(
      "approve",
    );

    for (const answer of ["decline", "cancel"] as const) {
      const denied = await asked(plane, plane.alice, { title: "y" });

      expect(await answered(plane, plane.alice, { title: "y" }, answer, denied)).toMatchObject({
        outcome: "not_approved",
        reason: "denied",
        usage: { approval: "denied" },
      });
    }

    expect(upstreamCalls(toolkit)).toHaveLength(1);
    // A form is no pending approval: nothing to list.
    expect((await plane.tools.listApprovals(plane.alice)).approvals).toEqual([]);
  });

  it("does not count an answer the caller was not asked for: they are asked", async () => {
    const { plane, toolkit } = await formOrg();
    const state = await asked(plane, plane.alice, { title: "x" });
    const [id] = state.split(":");

    for (const forged of [
      undefined,
      `${id}:enc:forged`,
      `ap_other:${state.slice(state.indexOf(":") + 1)}`,
    ])
      for (const answer of ["accept", "decline"] as const)
        expect((await answered(plane, plane.alice, { title: "x" }, answer, forged)).outcome).toBe(
          "approve",
        );

    expect(upstreamCalls(toolkit)).toEqual([]);
  });

  it("does not count an accept for other arguments, or another caller's, with the form's state", async () => {
    const { plane, toolkit } = await formOrg();
    const state = await asked(plane, plane.alice, { title: "a" });

    expect((await answered(plane, plane.alice, { title: "b" }, "accept", state)).outcome).toBe(
      "approve",
    );
    expect((await answered(plane, plane.bob, { title: "a" }, "accept", state)).outcome).toBe(
      "approve",
    );
    expect(upstreamCalls(toolkit)).toEqual([]);

    // The form still answers the call it was sent for.
    expect(await answered(plane, plane.alice, { title: "a" }, "accept", state)).toMatchObject({
      outcome: "result",
      text: 'called create_issue {"title":"a"}',
    });
  });

  it("does not count an answer after the hour", async () => {
    const { plane, toolkit } = await formOrg();
    const clock = await testClock(plane);
    const state = await asked(plane, plane.alice, { title: "x" });

    await clock.adjust("1 hour");

    expect((await answered(plane, plane.alice, { title: "x" }, "accept", state)).outcome).toBe(
      "approve",
    );
    expect(upstreamCalls(toolkit)).toEqual([]);
  });
});

describe("a pending approval", () => {
  /** An org whose `github` write tools wait for the team `ops` (alice and bob). */
  const teamOrg = async () => {
    const plane = await org();
    const toolkit = await orgToolkit(plane);
    const team = await plane.stub.createTeam("ops");

    if (!team.ok) throw new Error(team.message);
    await plane.stub.addTeamMember(team.value.id, plane.alice.member);
    await plane.stub.addTeamMember(team.value.id, plane.bob.member);

    await setRules(plane, plane.admin, toolkit.id, {
      writes: { approver: { kind: "team", id: team.value.id } },
    });

    return { plane, toolkit, team: team.value.id };
  };

  it("lets the identical call through once after an eligible approver approves it, and nothing else", async () => {
    const { plane, toolkit } = await teamOrg();
    const args = { title: "deploy" };
    const id = pendingId(await call(plane, plane.alice, "github_create_issue", args));

    // The same call again, before a decision: the same approval.
    expect(pendingId(await call(plane, plane.alice, "github_create_issue", args))).toBe(id);

    const approved = await plane.tools.decideApproval(plane.bob, id, "approve", "user:bob");

    expect(approved).toMatchObject({ ok: true, value: { status: "approved", can_decide: false } });

    // Other arguments, or another member's identical call, are other calls.
    expect(
      pendingId(await call(plane, plane.alice, "github_create_issue", { title: "other" })),
    ).not.toBe(id);
    expect(pendingId(await call(plane, plane.carol, "github_create_issue", args))).not.toBe(id);

    expect(await call(plane, plane.alice, "github_create_issue", args)).toMatchObject({
      outcome: "result",
      text: 'called create_issue {"title":"deploy"}',
      usage: { approval: "approved_panel" },
    });

    // A third call asks anew.
    const third = pendingId(await call(plane, plane.alice, "github_create_issue", args));

    expect(third).not.toBe(id);
    expect(
      toolkit.upstream.requests.filter((request) => request.rpc === "tools/call"),
    ).toHaveLength(1);
    expect(await plane.tools.getApproval(plane.alice, id)).toMatchObject({
      ok: true,
      value: { status: "used" },
    });
  });

  it("is gone after the original hour, approved or not: approving starts no new hour, and the call waits anew", async () => {
    const { plane, toolkit } = await teamOrg();
    const clock = await testClock(plane);
    const args = { title: "late" };
    const id = pendingId(await call(plane, plane.alice, "github_create_issue", args));

    await clock.adjust("30 minutes");
    expect(await plane.tools.decideApproval(plane.bob, id, "approve", "user:bob")).toMatchObject({
      ok: true,
    });
    // Half an hour after the approval: the hour from the call is over.
    await clock.adjust("30 minutes");

    const repeated = await call(plane, plane.alice, "github_create_issue", args);

    expect(repeated).toMatchObject({ outcome: "pending", usage: { approval: "pending" } });
    expect(pendingId(repeated)).not.toBe(id);
    expect(await plane.tools.getApproval(plane.alice, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });

    // An undecided one past its hour cannot be decided, and is listed no more.
    await clock.adjust("1 hour");
    expect(
      await plane.tools.decideApproval(plane.bob, pendingId(repeated), "approve", "user:bob"),
    ).toMatchObject({ ok: false, error: "not_found" });
    expect((await plane.tools.listApprovals(plane.bob)).approvals).toEqual([]);
    expect(toolkit.upstream.requests.filter((request) => request.rpc === "tools/call")).toEqual([]);
  });

  it("is denied for its call, which learns so once", async () => {
    const { plane } = await teamOrg();
    const id = pendingId(await call(plane, plane.alice, "github_delete_repo"));

    expect(await plane.tools.decideApproval(plane.bob, id, "deny", "user:bob")).toMatchObject({
      ok: true,
      value: { status: "denied" },
    });
    expect(await call(plane, plane.alice, "github_delete_repo")).toMatchObject({
      outcome: "not_approved",
      reason: "denied",
      usage: { approval: "denied" },
    });
    expect((await call(plane, plane.alice, "github_delete_repo")).outcome).toBe("pending");
  });

  it("is never decided by its caller under a team or list rule, even as a member of that set", async () => {
    const { plane, toolkit } = await teamOrg();
    const id = pendingId(await call(plane, plane.alice, "github_create_issue", { secret: "x" }));

    expect(
      await plane.tools.decideApproval(plane.alice, id, "approve", "user:alice"),
    ).toMatchObject({ ok: false, error: "forbidden" });

    // The caller sees it without its arguments; an approver with them; anyone else not at all.
    const own = await plane.tools.getApproval(plane.alice, id);

    expect(own).toMatchObject({ ok: true, value: { can_decide: false } });
    expect(own.ok && own.value.arguments).toBeFalsy();
    expect(await plane.tools.getApproval(plane.bob, id)).toMatchObject({
      ok: true,
      value: {
        can_decide: true,
        arguments: { secret: "x" },
        approver: { kind: "team", name: "ops" },
      },
    });
    expect(await plane.tools.getApproval(plane.carol, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await plane.tools.getApproval(plane.admin, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });

    // The pending list: what bob may decide, and alice's own (without arguments).
    expect((await plane.tools.listApprovals(plane.bob)).approvals.map((a) => a.id)).toEqual([id]);
    expect((await plane.tools.listApprovals(plane.alice)).approvals.map((a) => a.id)).toEqual([id]);

    // A list that names the caller: the others decide. (The team's approval goes with its rule.)
    await setRules(plane, plane.admin, toolkit.id, {
      writes: { approver: { kind: "members", ids: [plane.alice.member, plane.carol.member] } },
    });
    const listed = pendingId(await call(plane, plane.alice, "github_delete_repo"));

    expect(
      await plane.tools.decideApproval(plane.alice, listed, "approve", "user:alice"),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(
      await plane.tools.decideApproval(plane.carol, listed, "approve", "user:carol"),
    ).toMatchObject({ ok: true });
    expect((await plane.tools.listApprovals(plane.bob)).approvals).toEqual([]);
  });

  it("keeps its arguments sealed, deletes them on the decision, and is deleted when the hour is over", async () => {
    const { plane } = await teamOrg();
    const marker = `marker-${crypto.randomUUID()}`;
    const decided = pendingId(await call(plane, plane.alice, "github_create_issue", { marker }));
    const lapsed = pendingId(await call(plane, plane.alice, "github_delete_repo", { marker }));

    const sealed = await row(plane, decided);

    expect(sealed?.arguments).toMatch(/^enc:/);
    expect(sealed?.arguments).not.toContain(marker);

    await plane.tools.decideApproval(plane.bob, decided, "deny", "user:bob");
    expect(await row(plane, decided)).toMatchObject({ arguments: null, status: "denied" });
    expect((await row(plane, lapsed))?.arguments).not.toBeNull();

    // The part's alarm at the hour's end deletes both, arguments and all.
    const viewed = await plane.tools.getApproval(plane.bob, lapsed);

    if (!viewed.ok) throw new Error(viewed.message);
    const expiresAt = Date.parse(viewed.value.expires_at);

    const next = await runInDurableObject(plane.stub, (instance) =>
      instance.tools().alarm(expiresAt),
    );

    expect(await row(plane, lapsed)).toBeUndefined();
    expect(await row(plane, decided)).toBeUndefined();
    expect(next ?? Number.POSITIVE_INFINITY).toBeGreaterThan(expiresAt);
  });

  it("goes with its caller when they leave the org", async () => {
    const { plane } = await teamOrg();
    const id = pendingId(await call(plane, plane.alice, "github_create_issue"));

    await plane.stub.removeMember(plane.alice.member, OWNER);

    expect(await row(plane, id)).toBeUndefined();
  });
});

describe("a change of the rules", () => {
  /** An org whose `github` write tools wait for the team `ops` (alice and bob). */
  const teamOrg = async () => {
    const plane = await org();
    const toolkit = await orgToolkit(plane);
    const team = await plane.stub.createTeam("ops");

    if (!team.ok) throw new Error(team.message);
    await plane.stub.addTeamMember(team.value.id, plane.alice.member);
    await plane.stub.addTeamMember(team.value.id, plane.bob.member);

    const rules: ApprovalRules = { writes: { approver: { kind: "team", id: team.value.id } } };

    await setRules(plane, plane.admin, toolkit.id, rules);

    return { plane, toolkit, rules };
  };

  it("deletes the approvals of a removed rule, which restoring it does not bring back", async () => {
    const { plane, toolkit, rules } = await teamOrg();
    const args = { title: "x" };
    const id = pendingId(await call(plane, plane.alice, "github_create_issue", args));

    await plane.tools.decideApproval(plane.bob, id, "approve", "user:bob");
    await setRules(plane, plane.admin, toolkit.id, null);
    expect(await row(plane, id)).toBeUndefined();

    await setRules(plane, plane.admin, toolkit.id, rules);

    const repeated = await call(plane, plane.alice, "github_create_issue", args);

    expect(repeated.outcome).toBe("pending");
    expect(pendingId(repeated)).not.toBe(id);
    expect(toolkit.upstream.requests.filter((request) => request.rpc === "tools/call")).toEqual([]);
  });

  it("deletes those whose tool leaves the rule or whose approver changes, and keeps the others", async () => {
    const { plane, toolkit } = await teamOrg();
    const created = pendingId(await call(plane, plane.alice, "github_create_issue"));
    const deleted = pendingId(await call(plane, plane.alice, "github_delete_repo"));

    // Reclassified read, create_issue no longer waits under the write rule.
    expect(
      await plane.tools.setOverride(
        plane.admin,
        toolkit.id,
        0,
        { tool: "create_issue", class: "read" },
        "test",
      ),
    ).toMatchObject({ ok: true });
    expect(await row(plane, created)).toBeUndefined();
    expect(await row(plane, deleted)).toBeDefined();

    // An unrelated change keeps it.
    const current = (await plane.tools.listToolkits(plane.admin)).toolkits[0];

    await plane.tools.updateToolkit(
      plane.admin,
      toolkit.id,
      current?.revision ?? 0,
      { price_micros: 100 },
      "test",
      POLICY,
    );
    expect(await row(plane, deleted)).toBeDefined();

    // Another approver: delete_repo's waits for someone else now, so its approval goes.
    await setRules(plane, plane.admin, toolkit.id, {
      writes: { approver: { kind: "members", ids: [plane.carol.member] } },
    });
    expect(await row(plane, deleted)).toBeUndefined();
  });

  it("is flagged in the view when no one can approve under it, and its calls still wait", async () => {
    const plane = await org();
    const { id } = await orgToolkit(plane);
    const team = await plane.stub.createTeam("ops");

    if (!team.ok) throw new Error(team.message);

    await setRules(plane, plane.admin, id, {
      writes: { approver: { kind: "team", id: team.value.id } },
      tools: [
        { id: `${id}:list_issues`, approver: { kind: "members", ids: [plane.carol.member] } },
      ],
    });

    const view = async () =>
      (await plane.tools.listToolkits(plane.admin)).toolkits.find((found) => found.id === id)
        ?.approval_rules;

    expect(JSON.stringify(await view())).not.toContain("nobody_decides");

    await plane.stub.deleteTeam(team.value.id);
    await plane.stub.removeMember(plane.carol.member, OWNER);

    expect(await view()).toEqual({
      writes: { approver: { kind: "team", id: team.value.id }, nobody_decides: true },
      tools: [
        { id: `${id}:list_issues`, approver: { kind: "members", ids: [] }, nobody_decides: true },
      ],
    });
    expect((await call(plane, plane.alice, "github_create_issue")).outcome).toBe("pending");
    expect((await call(plane, plane.alice, "github_list_issues")).outcome).toBe("pending");
  });
});

describe("a caller deployed before approvals", () => {
  it("gets a call that waits, or was denied, as failed: never an outcome it does not know", async () => {
    const plane = await org();
    const { id } = await orgToolkit(plane);
    const team = await plane.stub.createTeam("ops");

    if (!team.ok) throw new Error(team.message);
    await plane.stub.addTeamMember(team.value.id, plane.bob.member);
    await setRules(plane, plane.admin, id, {
      writes: { approver: { kind: "team", id: team.value.id } },
    });

    const legacy = { approvalOutcomes: undefined };

    expect(await call(plane, plane.alice, "github_create_issue", {}, legacy)).toMatchObject({
      outcome: "failed",
      message: expect.stringContaining("waits for approval"),
      usage: { approval: "pending" },
    });

    const [pending] = (await plane.tools.listApprovals(plane.bob)).approvals;

    await plane.tools.decideApproval(plane.bob, pending?.id ?? "", "deny", "user:bob");
    expect(await call(plane, plane.alice, "github_create_issue", {}, legacy)).toMatchObject({
      outcome: "failed",
      message: "the call was not approved",
      usage: { approval: "denied" },
    });
  });
});

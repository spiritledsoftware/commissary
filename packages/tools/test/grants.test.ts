// Tool grants (#198, ADR 0038) in the Tools part over RPC, against fake MCP servers served in workerd: a toolkit's shared
// credential reaches nobody until a grant gives it, grants give all, read or named tools and add up, connecting a shared
// credential names who may use it, a private credential needs no grant and wins, and the org's private toolkits setting
// decides whether private toolkits are added and served.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { GrantSubject, ToolGrantBody } from "@commissary/contract/grants";
import type { AddToolkitInput } from "../src/control-plane-part.ts";
import { fakeMcpServer, serveFakeMcpServers } from "./support/mcp-server.ts";

serveFakeMcpServers();

const POLICY = { ownHosts: [], localDevelopment: false };

const OWNER = { role: "owner" as const, sensitive: false };

const EVERYONE: GrantSubject = { kind: "everyone" };

/** A new org's ControlPlane with an org admin and two plain members, private credentials and toolkits on. */
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
  };
};

type Org = Awaited<ReturnType<typeof org>>;

type Viewer = Org["alice"];

const memberOf = (viewer: Viewer): GrantSubject => ({ kind: "member", id: viewer.member });

/** A fake server at an origin of its own, whose calls answer `<token>:<tool>` (the token of the credential called with). */
const server = (tools: ReadonlyArray<{ name: string; annotations?: Record<string, unknown> }>) =>
  fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
    tools,
    call: (name, _args, request) => ({
      content: [{ type: "text", text: `${request.headers.get("authorization") ?? ""}:${name}` }],
    }),
  });

const GITHUB_TOOLS = [
  { name: "create_issue" },
  { name: "list_issues", annotations: { readOnlyHint: true } },
  { name: "delete_repo" },
];

/** An org toolkit with a shared bearer credential, granted to `subject` when connected. */
const sharedToolkit = async (
  { tools, admin }: Org,
  name: string,
  subject: GrantSubject | undefined,
  extra: Partial<AddToolkitInput> = {},
) => {
  const upstream = server(GITHUB_TOOLS);

  const added = await tools.addToolkit(
    admin,
    {
      source: upstream.url,
      name,
      private: false,
      accepts: "shared",
      credential: {
        kind: "bearer",
        token: `${name}-shared`,
        ...(subject === undefined ? {} : { subject }),
      },
      ...extra,
    },
    "test",
    POLICY,
  );

  if (!added.ok) throw new Error(added.message);

  return { upstream, id: added.value.id };
};

/** The full names `viewer` is listed by Commissary's MCP endpoint. */
const listed = async ({ tools }: Org, viewer: Viewer) =>
  (await tools.clientTools(viewer)).map((tool) => tool.name);

/** What calling `name` as `viewer` came to: `unknown`, `connect`, `failed` or the text the fake answered. */
const call = async ({ tools }: Org, viewer: Viewer, name: string) => {
  const outcome = await tools.callTool(viewer, { name }, POLICY);

  if (outcome.outcome !== "result") return outcome.outcome;
  // SAFETY: the fake answers one text content (`server`).
  const [content] = outcome.result["content"] as ReadonlyArray<{ text: string }>;

  return content?.text;
};

const grant = async ({ tools }: Org, body: ToolGrantBody) => {
  const written = await tools.writeGrant({ revision: 0, value: body }, "test");

  if (!written.ok) throw new Error(written.message);

  return written.value;
};

describe("a toolkit's shared credential", () => {
  it("reaches nobody until a grant gives it, and its tools then answer as unknown ones", async () => {
    const plane = await org();
    const { upstream, id } = await sharedToolkit(plane, "github", memberOf(plane.admin));

    // Granted to the org admin only: alice neither sees nor calls the tools.
    expect(await listed(plane, plane.alice)).toEqual([]);
    expect(await call(plane, plane.alice, "github_create_issue")).toBe("unknown");
    expect(await call(plane, plane.alice, "github_no_such_tool")).toBe("unknown");
    expect(upstream.requests.filter((request) => request.rpc === "tools/call")).toEqual([]);

    expect(await listed(plane, plane.admin)).toEqual([
      "github_create_issue",
      "github_delete_repo",
      "github_list_issues",
    ]);

    await grant(plane, { subject: EVERYONE, toolkit: id, tools: { kind: "all" } });

    expect(await listed(plane, plane.alice)).toHaveLength(3);
    expect(await call(plane, plane.alice, "github_create_issue")).toBe(
      "Bearer github-shared:create_issue",
    );
  });

  it("of a source that needs no sign-in (kind none) is unreachable until someone is granted it", async () => {
    const plane = await org();
    const upstream = server([{ name: "search" }]);

    const added = await plane.tools.addToolkit(
      plane.admin,
      {
        source: upstream.url,
        name: "open",
        private: false,
        accepts: "shared",
        credential: { kind: "none", subject: { kind: "member", id: plane.bob.member } },
      },
      "test",
      POLICY,
    );

    if (!added.ok) throw new Error(added.message);

    expect(await listed(plane, plane.alice)).toEqual([]);
    expect(await call(plane, plane.alice, "open_search")).toBe("unknown");
    expect(await listed(plane, plane.bob)).toEqual(["open_search"]);
    expect(await call(plane, plane.bob, "open_search")).toBe(":search");
  });
});

describe("tool grants", () => {
  it("of all, read and named tools each give exactly their tools, and a member's add up", async () => {
    const plane = await org();
    const github = await sharedToolkit(plane, "github", memberOf(plane.admin));
    const linear = await sharedToolkit(plane, "linear", memberOf(plane.admin));
    const team = await plane.stub.createTeam("ops");

    if (!team.ok) throw new Error(team.message);
    await plane.stub.addTeamMember(team.value.id, plane.alice.member);

    await grant(plane, { subject: EVERYONE, toolkit: github.id, tools: { kind: "read" } });

    await grant(plane, {
      subject: { kind: "member", id: plane.bob.member },
      toolkit: github.id,
      tools: { kind: "named", ids: [`${github.id}:delete_repo`] },
    });

    await grant(plane, {
      subject: { kind: "team", id: team.value.id },
      toolkit: linear.id,
      tools: { kind: "all" },
    });

    expect(await listed(plane, plane.alice)).toEqual([
      "github_list_issues",
      "linear_create_issue",
      "linear_delete_repo",
      "linear_list_issues",
    ]);

    expect(await listed(plane, plane.bob)).toEqual(["github_delete_repo", "github_list_issues"]);
    expect(await call(plane, plane.bob, "github_delete_repo")).toBe(
      "Bearer github-shared:delete_repo",
    );
    expect(await call(plane, plane.bob, "github_create_issue")).toBe("unknown");

    // Leaving the team takes what only its grant gave.
    await plane.stub.removeTeamMember(team.value.id, plane.alice.member);
    expect(await listed(plane, plane.alice)).toEqual(["github_list_issues"]);
  });

  it("of read tools follow a tool's class at once when it is reclassified", async () => {
    const plane = await org();
    const github = await sharedToolkit(plane, "github", memberOf(plane.admin));

    await grant(plane, { subject: EVERYONE, toolkit: github.id, tools: { kind: "read" } });
    expect(await listed(plane, plane.alice)).toEqual(["github_list_issues"]);

    for (const [tool, toolClass] of [
      ["create_issue", "read"],
      ["list_issues", "write"],
    ] as const) {
      const set = await plane.tools.setOverride(
        plane.admin,
        github.id,
        0,
        { tool, class: toolClass },
        "test",
      );

      if (!set.ok) throw new Error(set.message);
    }

    expect(await listed(plane, plane.alice)).toEqual(["github_create_issue"]);
    expect(await call(plane, plane.alice, "github_list_issues")).toBe("unknown");
  });

  it("are written at their revision, one per subject and toolkit, naming what the org has", async () => {
    const plane = await org();
    const github = await sharedToolkit(plane, "github", memberOf(plane.admin));
    const body = { subject: EVERYONE, toolkit: github.id, tools: { kind: "all" as const } };
    const created = await grant(plane, body);

    expect(created.revision).toBe(1);

    const write = (revision: number, value: ToolGrantBody | null, id?: string) =>
      plane.tools.writeGrant({ ...(id === undefined ? {} : { id }), revision, value }, "test");

    // A second grant of the subject on the toolkit, and a stale revision.
    expect(await write(0, body)).toMatchObject({ ok: false, error: "conflict" });
    expect(await write(0, body, created.id)).toMatchObject({ ok: false, error: "conflict" });

    const replaced = await write(1, { ...body, tools: { kind: "read" } }, created.id);

    expect(replaced).toEqual({ ok: true, value: { id: created.id, revision: 2 } });

    const personal = await plane.tools.addToolkit(
      plane.alice,
      {
        source: server([]).url,
        name: "mine",
        private: true,
        accepts: "private",
      },
      "test",
      POLICY,
    );

    if (!personal.ok) throw new Error(personal.message);

    for (const value of [
      { ...body, subject: { kind: "member" as const, id: "m-nobody" } },
      { ...body, subject: { kind: "team" as const, id: "t-nobody" } },
      { ...body, toolkit: "tk_nothing" },
      { ...body, toolkit: personal.value.id },
      { ...body, tools: { kind: "named" as const, ids: [] } },
      { ...body, tools: { kind: "named" as const, ids: ["tk_other:create_issue"] } },
    ])
      expect(await write(0, value)).toMatchObject({ ok: false, error: "invalid" });

    expect(await write(2, null, created.id)).toEqual({
      ok: true,
      value: { id: created.id, revision: 0 },
    });
    expect((await plane.tools.listGrants()).grants).toEqual([
      expect.objectContaining({ subject: { kind: "member", id: plane.admin.member } }),
    ]);
  });

  it("show a named tool the toolkit's source no longer lists as missing", async () => {
    const plane = await org();
    const github = await sharedToolkit(plane, "github", memberOf(plane.admin));

    const named = await grant(plane, {
      subject: EVERYONE,
      toolkit: github.id,
      tools: { kind: "named", ids: [`${github.id}:delete_repo`, `${github.id}:list_issues`] },
    });

    github.upstream.tools = GITHUB_TOOLS.filter((tool) => tool.name !== "delete_repo");
    const refreshed = await plane.tools.refreshToolList(plane.admin, github.id, POLICY);

    if (!refreshed.ok) throw new Error(refreshed.message);

    expect(
      (await plane.tools.listGrants()).grants.find((entry) => entry.id === named.id),
    ).toMatchObject({ missing: [`${github.id}:delete_repo`] });
    expect(await listed(plane, plane.alice)).toEqual(["github_list_issues"]);
  });

  it("go with the member, the team or the toolkit they name", async () => {
    const plane = await org();
    const github = await sharedToolkit(plane, "github", memberOf(plane.admin));
    const linear = await sharedToolkit(plane, "linear", memberOf(plane.admin));
    const team = await plane.stub.createTeam("ops");

    if (!team.ok) throw new Error(team.message);

    for (const subject of [
      { kind: "member" as const, id: plane.bob.member },
      { kind: "team" as const, id: team.value.id },
    ])
      await grant(plane, { subject, toolkit: github.id, tools: { kind: "all" } });

    await grant(plane, { subject: EVERYONE, toolkit: linear.id, tools: { kind: "all" } });

    const subjects = async () =>
      (await plane.tools.listGrants()).grants.map((entry) => [entry.subject, entry.toolkit]);

    expect(await subjects()).toHaveLength(5);

    await plane.stub.removeMember(plane.bob.member, OWNER);
    await plane.stub.deleteTeam(team.value.id);

    const removed = await plane.tools.removeToolkit(plane.admin, linear.id, 1);

    if (!removed.ok) throw new Error(removed.message);

    expect(await subjects()).toEqual([[{ kind: "member", id: plane.admin.member }, github.id]]);
  });
});

describe("connecting a toolkit's shared credential", () => {
  it("is refused without a subject, and with one writes its grant of every tool in the same write", async () => {
    const plane = await org();
    const upstream = server(GITHUB_TOOLS);

    const add = (credential: Parameters<Org["tools"]["addToolkit"]>[1]["credential"]) =>
      plane.tools.addToolkit(
        plane.admin,
        { source: upstream.url, name: "github", private: false, accepts: "shared", credential },
        "test",
        POLICY,
      );

    expect(await add({ kind: "bearer", token: "t" })).toMatchObject({
      ok: false,
      error: "invalid",
    });
    expect(
      await add({ kind: "bearer", token: "t", subject: { kind: "member", id: "m-nobody" } }),
    ).toMatchObject({ ok: false, error: "invalid" });

    // Nothing was added, and no grant exists for a toolkit nobody chose.
    expect((await plane.tools.listToolkits(plane.admin)).toolkits).toEqual([]);

    const added = await plane.tools.addToolkit(
      plane.admin,
      { source: upstream.url, name: "github", private: false, accepts: "shared" },
      "test",
      POLICY,
    );

    if (!added.ok) throw new Error(added.message);
    const id = added.value.id;

    expect((await plane.tools.listGrants()).grants).toEqual([]);

    const connect = (credential: Parameters<Org["tools"]["connectCredential"]>[3]) =>
      plane.tools.connectCredential(plane.admin, id, "shared", credential, "test", POLICY);

    expect(await connect({ kind: "bearer", token: "t" })).toMatchObject({
      ok: false,
      error: "invalid",
    });
    expect((await plane.tools.listToolkits(plane.admin)).toolkits[0]?.credentials).toEqual({
      private_count: 0,
    });

    expect(
      (
        await connect({
          kind: "bearer",
          token: "github-shared",
          subject: { kind: "member", id: plane.alice.member },
        })
      ).ok,
    ).toBe(true);

    expect((await plane.tools.listGrants()).grants).toEqual([
      expect.objectContaining({
        subject: { kind: "member", id: plane.alice.member },
        toolkit: id,
        tools: { kind: "all" },
        revision: 1,
      }),
    ]);
    expect(await listed(plane, plane.alice)).toHaveLength(3);
    expect(await listed(plane, plane.bob)).toEqual([]);

    // Connecting again for a subject that has a grant on the toolkit keeps that grant as it is.
    const [held] = (await plane.tools.listGrants()).grants;

    await plane.tools.writeGrant(
      { id: held?.id, revision: 1, value: { ...held!, tools: { kind: "read" } } },
      "test",
    );

    await connect({
      kind: "bearer",
      token: "rotated",
      subject: { kind: "member", id: plane.alice.member },
    });

    expect((await plane.tools.listGrants()).grants).toEqual([
      expect.objectContaining({ tools: { kind: "read" }, revision: 2 }),
    ]);
  });

  it("takes no subject for a private credential", async () => {
    const plane = await org();

    const added = await plane.tools.addToolkit(
      plane.admin,
      { source: server(GITHUB_TOOLS).url, name: "github", private: false, accepts: "private" },
      "test",
      POLICY,
    );

    if (!added.ok) throw new Error(added.message);

    expect(
      await plane.tools.connectCredential(
        plane.alice,
        added.value.id,
        "private",
        { kind: "none", subject: EVERYONE },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("a private credential on an org toolkit", () => {
  it("needs no grant, and wins over the shared one a grant gives", async () => {
    const plane = await org();
    const github = await sharedToolkit(plane, "github", EVERYONE, { accepts: "both" });

    const connected = await plane.tools.connectCredential(
      plane.alice,
      github.id,
      "private",
      { kind: "bearer", token: "alice-own" },
      "test",
      POLICY,
    );

    if (!connected.ok) throw new Error(connected.message);

    expect(await call(plane, plane.alice, "github_create_issue")).toBe(
      "Bearer alice-own:create_issue",
    );
    expect(await call(plane, plane.bob, "github_create_issue")).toBe(
      "Bearer github-shared:create_issue",
    );

    // Without the grant, bob is asked to connect his own; alice keeps hers.
    const [everyone] = (await plane.tools.listGrants()).grants;

    await plane.tools.writeGrant({ id: everyone?.id, revision: 1, value: null }, "test");

    expect(await call(plane, plane.bob, "github_create_issue")).toBe("connect");
    expect(await call(plane, plane.alice, "github_create_issue")).toBe(
      "Bearer alice-own:create_issue",
    );
  });
});

describe("the private toolkits setting", () => {
  it("refuses new private toolkits while off and stops serving the ones there, until it is on again", async () => {
    const plane = await org();
    const upstream = server([{ name: "add_note" }]);

    const add = (name: string) =>
      plane.tools.addToolkit(
        plane.alice,
        {
          source: upstream.url,
          name,
          private: true,
          accepts: "private",
          credential: { kind: "bearer", token: "alice-notes" },
        },
        "test",
        POLICY,
      );

    expect((await add("notes")).ok).toBe(true);
    expect(await listed(plane, plane.alice)).toEqual(["notes_add_note"]);

    await plane.stub.setMembershipSettings({ privateToolkits: false });

    expect(await add("more")).toMatchObject({ ok: false, error: "private_toolkits_unavailable" });
    expect(await listed(plane, plane.alice)).toEqual([]);
    expect(await call(plane, plane.alice, "notes_add_note")).toBe("unknown");
    // Kept, for its owner to see and remove.
    expect((await plane.tools.listToolkits(plane.alice)).toolkits).toHaveLength(1);

    await plane.stub.setMembershipSettings({ privateToolkits: true });

    expect(await listed(plane, plane.alice)).toEqual(["notes_add_note"]);
    expect(await call(plane, plane.alice, "notes_add_note")).toBe("Bearer alice-notes:add_note");
  });

  it("does not let a private toolkit that is not served shadow an org toolkit of its name", async () => {
    const plane = await org();

    const personal = await plane.tools.addToolkit(
      plane.alice,
      {
        source: server([{ name: "mine" }]).url,
        name: "docs",
        private: true,
        accepts: "private",
        credential: { kind: "none" },
      },
      "test",
      POLICY,
    );

    if (!personal.ok) throw new Error(personal.message);
    await sharedToolkit(plane, "docs", EVERYONE);

    expect(await listed(plane, plane.alice)).toEqual(["docs_mine"]);

    await plane.stub.setMembershipSettings({ privateToolkits: false });

    expect(await listed(plane, plane.alice)).toEqual([
      "docs_create_issue",
      "docs_delete_repo",
      "docs_list_issues",
    ]);
  });

  it("starts as private credentials do: on for global, off for a new org", async () => {
    const fresh = await env.CONTROL_PLANE.getByName(crypto.randomUUID()).membershipSettings();

    expect(fresh).toMatchObject({ privateCredentials: false, privateToolkits: false });
    expect(await env.CONTROL_PLANE.getByName("global").membershipSettings()).toMatchObject({
      privateCredentials: true,
      privateToolkits: true,
    });
  });
});

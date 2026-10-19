// The Tools part of the ControlPlane (#196) over RPC, against fake MCP servers served in workerd: toolkits, their tool
// lists with full names, classes and stable ids, the rules that keep full names unique (ADR 0037), overrides keyed by
// stable id, the cron refresh and what goes when a member leaves, an upstream session ages or the org is deleted.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AddToolkitInput } from "../src/control-plane-part.ts";
import { SESSION_LIFETIME_MS, TOOLS_TABLES, ToolkitStore } from "../src/toolkits/store.ts";
import { fakeMcpServer, serveFakeMcpServers } from "./support/mcp-server.ts";

serveFakeMcpServers();

const POLICY = { ownHosts: [], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

const BOB = { member: "m-bob", admin: false };

/** A new org's ControlPlane, with private credentials on (a new org has them off). */
const plane = async () => {
  const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());

  await stub.setMembershipSettings({ privateCredentials: true });

  return stub;
};

/** A unique origin per server, so tests never share one. */
const origin = () => `https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com`;

const orgToolkit = (source: string, name: string, extra: Partial<AddToolkitInput> = {}) => ({
  source,
  name,
  private: false,
  accepts: "shared" as const,
  credential: { kind: "none" as const },
  ...extra,
});

const privateToolkit = (source: string, name: string) => ({
  source,
  name,
  private: true,
  accepts: "private" as const,
  credential: { kind: "none" as const },
});

type Stub = Awaited<ReturnType<typeof plane>>;

const add = async (stub: Stub, viewer: typeof ADMIN, input: AddToolkitInput) => {
  const added = await stub.tools().addToolkit(viewer, input, "test", POLICY);

  if (!added.ok) throw new Error(`add failed: ${added.message}`);

  return added.value;
};

const toolsOf = async (stub: Stub, viewer: typeof ADMIN, id: string) => {
  const listed = await stub.tools().listTools(viewer, id);

  if (!listed.ok) throw new Error(`list failed: ${listed.message}`);

  return listed.value.tools;
};

/** The names a member is served, the flat list of the MCP endpoint (#197). */
const served = async (stub: Stub, member: string | undefined) =>
  (await stub.tools().servedTools({ member, admin: false })).map((tool) => tool.name);

describe("an org toolkit from a remote MCP server", () => {
  it("lists its tools with full names, classes and stable ids, signed in with a shared bearer token", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      authorized: (request) => request.headers.get("authorization") === "Bearer secret-token",
      tools: [
        { name: "Create-Issue", description: "Opens an issue" },
        { name: "list.issues", annotations: { readOnlyHint: true } },
        { name: "delete_repo", annotations: { readOnlyHint: false, destructiveHint: true } },
      ],
    });

    const stub = await plane();

    const toolkit = await add(
      stub,
      ADMIN,
      orgToolkit(server.url, "github", { credential: { kind: "bearer", token: "secret-token" } }),
    );

    expect(toolkit.tool_list).toMatchObject({ tools: 3 });
    expect(toolkit.tool_list.error).toBeUndefined();
    expect(toolkit.credentials.shared).toMatchObject({ kind: "bearer", active: true });

    const tools = await toolsOf(stub, ADMIN, toolkit.id);

    expect(
      tools.map(({ id, name, upstream_name, class: toolClass }) => ({
        id,
        name,
        upstream_name,
        toolClass,
      })),
    ).toEqual([
      {
        id: `${toolkit.id}:Create-Issue`,
        name: "github_create_issue",
        upstream_name: "Create-Issue",
        toolClass: "write",
      },
      {
        id: `${toolkit.id}:list.issues`,
        name: "github_list_issues",
        upstream_name: "list.issues",
        toolClass: "read",
      },
      {
        id: `${toolkit.id}:delete_repo`,
        name: "github_delete_repo",
        upstream_name: "delete_repo",
        toolClass: "write",
      },
    ]);
    expect(tools[0]).toMatchObject({
      description: "Opens an issue",
      input_schema: { type: "object" },
    });
    expect(server.requests.map((request) => request.rpc ?? request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "DELETE",
    ]);
  });

  it("records why its list could not be built, and keeps the toolkit", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { authorized: () => false });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(server.url, "denied"));

    expect(toolkit.tool_list).toEqual({
      error: "the MCP server refused the credential (HTTP 401)",
      tools: 0,
    });
  });

  it("reads every page, over SSE, and from a server of the stateless revision", async () => {
    const tools = Array.from({ length: 5 }, (_, index) => ({ name: `tool_${index}` }));
    const paged = fakeMcpServer(`${origin()}/mcp`, { tools, pageSize: 2, sse: true });
    const stateless = fakeMcpServer(`${origin()}/mcp`, { tools, pageSize: 3, stateless: true });
    const stub = await plane();

    for (const [server, name] of [
      [paged, "paged"],
      [stateless, "stateless"],
    ] as const) {
      const toolkit = await add(stub, ADMIN, orgToolkit(server.url, name));

      expect((await toolsOf(stub, ADMIN, toolkit.id)).map((tool) => tool.name)).toEqual(
        tools.map((tool) => `${name}_${tool.name}`),
      );
    }

    expect(
      stateless.requests
        .filter((request) => request.rpc === "tools/list")
        .map((request) => request.headers.get("mcp-method")),
    ).toEqual(["tools/list", "tools/list"]);
  });

  it("flags a full name cut to 46 characters", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      tools: [{ name: "retrieve_a_very_long_customer_payment_method_configuration" }],
    });

    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(server.url, "stripe"));
    const [tool] = await toolsOf(stub, ADMIN, toolkit.id);

    expect(tool).toMatchObject({
      name: "stripe_retrieve_a_very_long_customer_paym_a318",
      flags: { shortened: true },
    });
  });
});

describe("unique full names", () => {
  it("checks the full name, so github_rest + create_issue and github + rest_create_issue cannot both have it", async () => {
    const github = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "rest_create_issue" }] });
    const rest = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "create_issue" }] });
    const stub = await plane();
    const first = await add(stub, ADMIN, orgToolkit(github.url, "github"));
    const second = await add(stub, ADMIN, orgToolkit(rest.url, "github_rest"));

    expect(await toolsOf(stub, ADMIN, first.id)).toMatchObject([
      { name: "github_rest_create_issue", flags: { clash: false } },
    ]);
    expect(await toolsOf(stub, ADMIN, second.id)).toMatchObject([
      { name: "github_rest_create_issue", flags: { clash: true } },
    ]);
    expect(await served(stub, undefined)).toEqual(["github_rest_create_issue"]);
    expect((await stub.tools().servedTools({ admin: true }))[0]?.id).toBe(
      `${first.id}:rest_create_issue`,
    );

    // Renaming the hidden tool resolves the clash.
    const renamed = await stub
      .tools()
      .setOverride(ADMIN, second.id, 0, { tool: "create_issue", name: "new_issue" }, "test");

    expect(renamed).toMatchObject({
      ok: true,
      value: { name: "github_rest_new_issue", flags: { renamed: true, clash: false } },
    });
    expect(await served(stub, undefined)).toEqual([
      "github_rest_create_issue",
      "github_rest_new_issue",
    ]);
  });

  it("refuses a rename to a full name another tool holds", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "a" }, { name: "b" }] });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(server.url, "kit"));

    expect(
      await stub.tools().setOverride(ADMIN, toolkit.id, 0, { tool: "b", name: "a" }, "test"),
    ).toMatchObject({
      ok: false,
      error: "name_taken",
    });
  });

  it("refuses an org toolkit name the org already has, and a private name that clashes for its member", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`);
    const stub = await plane();

    await add(stub, ADMIN, orgToolkit(server.url, "linear"));
    await add(stub, ALICE, privateToolkit(server.url, "notes"));

    const refusals = [
      await stub.tools().addToolkit(ADMIN, orgToolkit(server.url, "linear"), "test", POLICY),
      await stub.tools().addToolkit(ALICE, privateToolkit(server.url, "linear"), "test", POLICY),
      await stub.tools().addToolkit(ALICE, privateToolkit(server.url, "notes"), "test", POLICY),
    ];

    expect(refusals.map((refusal) => (refusal.ok ? "ok" : refusal.error))).toEqual([
      "name_taken",
      "name_taken",
      "name_taken",
    ]);

    // Another member's private names are theirs alone.
    expect(
      (await stub.tools().addToolkit(BOB, privateToolkit(server.url, "notes"), "test", POLICY)).ok,
    ).toBe(true);
  });

  it("lets a member's private toolkit win over an org toolkit added later with its name, for that member only", async () => {
    const mine = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "search" }] });

    const org = fakeMcpServer(`${origin()}/mcp`, {
      tools: [{ name: "search" }, { name: "fetch" }],
    });

    const stub = await plane();
    const personal = await add(stub, ALICE, privateToolkit(mine.url, "docs"));
    const shared = await add(stub, ADMIN, orgToolkit(org.url, "docs"));

    expect(await served(stub, ALICE.member)).toEqual(["docs_search"]);
    expect((await stub.tools().servedTools(ALICE)).map((tool) => tool.toolkit_id)).toEqual([
      personal.id,
    ]);
    expect(await served(stub, BOB.member)).toEqual(["docs_search", "docs_fetch"]);

    const alice = (await stub.tools().listToolkits(ALICE)).toolkits;

    expect(alice.find((toolkit) => toolkit.id === personal.id)).toMatchObject({
      rename_suggested: true,
    });
    expect(alice.find((toolkit) => toolkit.id === shared.id)).toMatchObject({ shadowed: true });

    const bob = (await stub.tools().listToolkits(BOB)).toolkits;

    expect(bob.map((toolkit) => toolkit.id)).toEqual([shared.id]);
    expect(bob[0]?.shadowed).toBeUndefined();
  });

  it("keeps an admin's rename over a tool a refresh brings later with that name, hidden and flagged", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "search_v1" }] });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(server.url, "web"));

    await stub
      .tools()
      .setOverride(ADMIN, toolkit.id, 0, { tool: "search_v1", name: "search" }, "test");
    server.tools = [{ name: "search_v1" }, { name: "search" }];
    expect((await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY)).ok).toBe(true);

    expect(
      (await toolsOf(stub, ADMIN, toolkit.id)).map(({ upstream_name, name, flags }) => ({
        upstream_name,
        name,
        clash: flags.clash,
      })),
    ).toEqual([
      { upstream_name: "search_v1", name: "web_search", clash: false },
      { upstream_name: "search", name: "web_search", clash: true },
    ]);
    expect(await served(stub, undefined)).toEqual(["web_search"]);
  });

  it("drops a tool that disappears upstream, and flags an override of it as missing", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      tools: [{ name: "keep" }, { name: "gone" }],
    });

    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(server.url, "kit"));

    await stub
      .tools()
      .setOverride(ADMIN, toolkit.id, 0, { tool: "gone", description: "Old" }, "test");
    server.tools = [{ name: "keep" }];
    await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY);

    expect(await served(stub, undefined)).toEqual(["kit_keep"]);
    expect(
      (await toolsOf(stub, ADMIN, toolkit.id)).map(({ upstream_name, flags }) => [
        upstream_name,
        flags.missing,
      ]),
    ).toEqual([
      ["keep", false],
      ["gone", true],
    ]);
  });

  it("answers removed when the override of a tool gone upstream is cleared, and the tool leaves the list", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      tools: [{ name: "keep" }, { name: "gone" }],
    });

    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(server.url, "kit"));

    await stub.tools().setOverride(ADMIN, toolkit.id, 0, { tool: "gone", hidden: true }, "test");
    server.tools = [{ name: "keep" }];
    await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY);

    expect(await stub.tools().setOverride(ADMIN, toolkit.id, 1, { tool: "gone" }, "test")).toEqual({
      ok: true,
      value: { id: `${toolkit.id}:gone`, removed: true },
    });
    expect((await toolsOf(stub, ADMIN, toolkit.id)).map((tool) => tool.upstream_name)).toEqual([
      "keep",
    ]);
    // Nothing is left to override.
    expect(
      await stub.tools().setOverride(ADMIN, toolkit.id, 0, { tool: "gone", hidden: true }, "test"),
    ).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("overrides", () => {
  it("survive a toolkit rename and a refresh, keyed by stable id", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      tools: [
        { name: "read_page", annotations: { readOnlyHint: true } },
        { name: "click" },
        { name: "secret_admin" },
      ],
    });

    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(server.url, "browser"));

    const writes = [
      await stub
        .tools()
        .setOverride(
          ADMIN,
          toolkit.id,
          0,
          { tool: "read_page", class: "write", name: "page" },
          "test",
        ),
      await stub
        .tools()
        .setOverride(ADMIN, toolkit.id, 0, { tool: "click", description: "Clicks" }, "test"),
      await stub
        .tools()
        .setOverride(ADMIN, toolkit.id, 0, { tool: "secret_admin", hidden: true }, "test"),
    ];

    expect(writes.every((write) => write.ok)).toBe(true);

    const renamed = await stub
      .tools()
      .updateToolkit(ADMIN, toolkit.id, toolkit.revision, { name: "web" }, "test");

    expect(renamed).toMatchObject({
      ok: true,
      value: { name: "web", revision: toolkit.revision + 1 },
    });
    await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY);

    const tools = await toolsOf(stub, ADMIN, toolkit.id);

    expect(
      tools.map((tool) => ({
        name: tool.name,
        class: tool.class,
        description: tool.description,
        hidden: tool.flags.hidden,
      })),
    ).toEqual([
      { name: "web_page", class: "write", description: undefined, hidden: false },
      { name: "web_click", class: "write", description: "Clicks", hidden: false },
      { name: "web_secret_admin", class: "write", description: undefined, hidden: true },
    ]);
    expect(await served(stub, undefined)).toEqual(["web_page", "web_click"]);
  });

  it("name the revision they are based on, and are for whoever manages the toolkit", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const stub = await plane();
    const shared = await add(stub, ADMIN, orgToolkit(server.url, "kit"));
    const personal = await add(stub, ALICE, privateToolkit(server.url, "mine"));

    expect(
      await stub.tools().setOverride(ADMIN, shared.id, 0, { tool: "t", hidden: true }, "test"),
    ).toMatchObject({
      ok: true,
      value: { override: { revision: 1 } },
    });
    expect(
      await stub.tools().setOverride(ADMIN, shared.id, 0, { tool: "t" }, "test"),
    ).toMatchObject({
      ok: false,
      error: "conflict",
    });
    expect(
      await stub.tools().setOverride(ALICE, shared.id, 0, { tool: "t", hidden: true }, "test"),
    ).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(
      (await stub.tools().setOverride(ALICE, personal.id, 0, { tool: "t", name: "x" }, "test")).ok,
    ).toBe(true);
    expect(
      await stub.tools().setOverride(BOB, personal.id, 0, { tool: "t" }, "test"),
    ).toMatchObject({
      ok: false,
      error: "not_found",
    });
    // An override that sets nothing clears it.
    expect(
      await stub.tools().setOverride(ADMIN, shared.id, 1, { tool: "t" }, "test"),
    ).toMatchObject({
      ok: true,
      value: { flags: { hidden: false } },
    });
    expect((await toolsOf(stub, ADMIN, shared.id))[0]?.override).toBeUndefined();

    // A new override starts from 0 again, but its revision goes on from the cleared one's, so a write based on the
    // override before the clear (revision 1) cannot land on the new one.
    expect(
      await stub.tools().setOverride(ADMIN, shared.id, 0, { tool: "t", name: "u" }, "test"),
    ).toMatchObject({ ok: true, value: { override: { revision: 3 } } });
    expect(
      await stub.tools().setOverride(ADMIN, shared.id, 1, { tool: "t", hidden: true }, "test"),
    ).toMatchObject({ ok: false, error: "conflict" });
  });
});

describe("credentials", () => {
  it("builds with a member's private credential when the toolkit has no shared one", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      authorized: (request) => request.headers.get("x-api-key") === "alice-key",
      tools: [{ name: "t" }],
    });

    const stub = await plane();

    const toolkit = await add(
      stub,
      ADMIN,
      orgToolkit(server.url, "kit", { accepts: "private", credential: undefined }),
    );

    expect(toolkit.tool_list).toEqual({ tools: 0 });

    const connected = await stub
      .tools()
      .connectCredential(
        ALICE,
        toolkit.id,
        "private",
        { kind: "header", name: "X-Api-Key", value: "alice-key" },
        "alice",
        POLICY,
      );

    expect(connected).toMatchObject({
      ok: true,
      value: {
        credentials: { mine: { kind: "header", name: "X-Api-Key" } },
        tool_list: { tools: 1 },
      },
    });
    expect(
      await stub
        .tools()
        .connectCredential(ADMIN, toolkit.id, "shared", { kind: "none" }, "admin", POLICY),
    ).toMatchObject({ ok: false, error: "not_accepted" });
  });

  it("sends a query key and basic auth as their kinds say", async () => {
    const query = fakeMcpServer(`${origin()}/mcp`, {
      authorized: (request) => new URL(request.url).searchParams.get("key") === "k1",
      tools: [{ name: "t" }],
    });

    const basic = fakeMcpServer(`${origin()}/mcp`, {
      authorized: (request) => request.headers.get("authorization") === `Basic ${btoa("me:pw")}`,
      tools: [{ name: "t" }],
    });

    const stub = await plane();

    const viaQuery = await add(
      stub,
      ADMIN,
      orgToolkit(query.url, "q", { credential: { kind: "query", name: "key", value: "k1" } }),
    );

    const viaBasic = await add(
      stub,
      ADMIN,
      orgToolkit(basic.url, "b", { credential: { kind: "basic", username: "me", password: "pw" } }),
    );

    expect([viaQuery.tool_list.tools, viaBasic.tool_list.tools]).toEqual([1, 1]);
  });
});

describe("what an org toolkit accepts", () => {
  it("keeps the credentials it no longer accepts, inactive and unused, until it accepts them again", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      // Lists only for a caller without a sign-in: Alice's `none`, never the shared bearer token.
      authorized: (request) => request.headers.get("authorization") === null,
      tools: [{ name: "t" }],
    });

    const stub = await plane();

    const toolkit = await add(
      stub,
      ADMIN,
      orgToolkit(server.url, "kit", {
        accepts: "both",
        credential: { kind: "bearer", token: "shared" },
      }),
    );

    expect(
      (
        await stub
          .tools()
          .connectCredential(ALICE, toolkit.id, "private", { kind: "none" }, "alice", POLICY)
      ).ok,
    ).toBe(true);

    const narrowed = await stub
      .tools()
      .updateToolkit(ADMIN, toolkit.id, toolkit.revision, { accepts: "shared" }, "test");

    expect(narrowed).toMatchObject({
      ok: true,
      value: { credentials: { shared: { active: true }, private_count: 1 } },
    });

    const aliceView = (await stub.tools().listToolkits(ALICE)).toolkits[0];

    expect(aliceView?.credentials.mine).toMatchObject({ kind: "none", active: false });

    const onlyPrivate = await stub
      .tools()
      .updateToolkit(ADMIN, toolkit.id, toolkit.revision + 1, { accepts: "private" }, "test");

    expect(onlyPrivate).toMatchObject({
      ok: true,
      value: { credentials: { shared: { kind: "bearer", active: false } } },
    });
    // The kept shared credential is not used: Alice's own builds the list.
    expect((await stub.tools().refreshToolList(ALICE, toolkit.id, POLICY)).ok).toBe(true);
    expect((await stub.tools().listToolkits(ALICE)).toolkits[0]?.credentials.mine).toMatchObject({
      active: true,
    });
  });
});

describe("the cron refresh", () => {
  it("rebuilds lists with shared credentials and private toolkits' own, and skips org toolkits with private ones only", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "a" }] });
    const stub = await plane();
    const shared = await add(stub, ADMIN, orgToolkit(server.url, "shared"));
    await add(stub, ALICE, privateToolkit(server.url, "mine"));
    await add(
      stub,
      ADMIN,
      orgToolkit(server.url, "byo", { accepts: "private", credential: undefined }),
    );

    server.tools = [{ name: "a" }, { name: "b" }];

    expect(await stub.tools().refreshToolLists(POLICY)).toEqual({
      built: 2,
      failed: 0,
      skipped: 1,
    });
    expect((await toolsOf(stub, ADMIN, shared.id)).map((tool) => tool.name)).toEqual([
      "shared_a",
      "shared_b",
    ]);
  });
});

/** A store over the ControlPlane's own tables, for its reads at an explicit `now`; sessions hold no secrets. */
const storeOf = (sql: SqlStorage) => new ToolkitStore(sql, NO_SECRETS, (body) => body());

const NO_SECRETS = {
  seal: () => {
    throw new Error("no secrets in this test");
  },
  open: () => {
    throw new Error("no secrets in this test");
  },
};

/** The upstream sessions the ControlPlane keeps, as rows. */
const keptSessions = (stub: Stub) =>
  runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ protocol_version: string; session_id: string; opened_at: number }>(
        `SELECT protocol_version, session_id, opened_at FROM toolkit_sessions`,
      )
      .toArray(),
  );

describe("an upstream session", () => {
  it("is opened again, once, when the server changed eras since the last call", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const stub = await plane();
    await add(stub, ALICE, privateToolkit(server.url, "mine"));

    const call = async () =>
      (await stub.tools().callTool(ALICE, { name: "mine_t" }, POLICY)).outcome;

    expect(await call()).toBe("result");
    expect((await keptSessions(stub)).map((row) => row.protocol_version)).toEqual(["2025-06-18"]);

    // The 2025 session is refused (`400`): a stateless call follows, and its revision is kept.
    server.stateless = true;
    expect(await call()).toBe("result");
    expect((await keptSessions(stub)).map((row) => row.protocol_version)).toEqual(["2026-07-28"]);

    // And back: the stateless call is refused (`400`, no session), and a new handshake opens one.
    server.stateless = false;
    expect(await call()).toBe("result");

    expect(await keptSessions(stub)).toEqual([
      expect.objectContaining({ protocol_version: "2025-06-18", session_id: "fake-session-3" }),
    ]);
  });

  it("is dropped when a call fails in it, so the next call opens a new one", async () => {
    let failing = false;

    const server = fakeMcpServer(`${origin()}/mcp`, {
      tools: [{ name: "t" }],
      call: () => (failing ? new Response("down", { status: 503 }) : { content: [] }),
    });

    const stub = await plane();
    await add(stub, ALICE, privateToolkit(server.url, "mine"));

    const call = async () =>
      (await stub.tools().callTool(ALICE, { name: "mine_t" }, POLICY)).outcome;

    expect(await call()).toBe("result");
    expect(await keptSessions(stub)).toHaveLength(1);

    failing = true;
    expect(await call()).toBe("failed");
    expect(await keptSessions(stub)).toEqual([]);

    failing = false;
    expect(await call()).toBe("result");

    expect(await keptSessions(stub)).toEqual([
      expect.objectContaining({ session_id: "fake-session-3" }),
    ]);
  });
});

describe("what goes", () => {
  it("the upstream session a call opened, seven days after, when the alarm comes", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const stub = await plane();
    const toolkit = await add(stub, ALICE, privateToolkit(server.url, "mine"));

    expect((await stub.tools().callTool(ALICE, { name: "mine_t" }, POLICY)).outcome).toBe("result");
    const [kept] = await keptSessions(stub);

    if (kept === undefined) throw new Error("no session kept");
    const expiry = kept.opened_at + SESSION_LIFETIME_MS;

    // The store at an explicit `now`: kept until seven days after it opened, and pruned then.
    await runInDurableObject(stub, async (_instance, state) => {
      const store = storeOf(state.storage.sql);

      expect(store.session(toolkit.id, ALICE.member, expiry - 1)).toBeDefined();
      expect(store.session(toolkit.id, ALICE.member, expiry)).toBeUndefined();
      expect(store.pruneSessions(expiry - 1)).toBe(expiry);
      expect(await state.storage.getAlarm()).toBe(expiry);
    });

    // The part's alarm at seven days after: the session goes, and nothing is left to wake up for.
    expect(await runInDurableObject(stub, (instance) => instance.tools().alarm(expiry))).toBeNull();
    expect(await keptSessions(stub)).toEqual([]);
  });

  it("a member who leaves takes their private toolkits and private credentials", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const stub = await plane();
    const shared = await add(stub, ADMIN, orgToolkit(server.url, "kit", { accepts: "both" }));
    await add(stub, ALICE, privateToolkit(server.url, "mine"));
    await stub
      .tools()
      .connectCredential(
        ALICE,
        shared.id,
        "private",
        { kind: "bearer", token: "t" },
        "alice",
        POLICY,
      );

    await runInDurableObject(stub, async (instance) => {
      await instance.tools().memberLeft(ALICE.member);
    });

    const left = await stub.tools().listToolkits(ADMIN);

    expect(left.toolkits.map((toolkit) => toolkit.name)).toEqual(["kit"]);
    expect(left.others).toEqual([]);
    expect(left.toolkits[0]?.credentials.private_count).toBe(0);
  });

  it("the org's deletion drops every table of the part", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(server.url, "kit"));
    await stub.tools().setOverride(ADMIN, toolkit.id, 0, { tool: "t", hidden: true }, "test");

    const tables = () =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .toArray()
          .map((row) => row.name),
      );

    expect(
      (await tables())
        .filter((name) => (TOOLS_TABLES as ReadonlyArray<string>).includes(name))
        .toSorted(),
    ).toEqual(TOOLS_TABLES.toSorted());

    await stub.wipeOrg();

    expect(
      (await tables()).filter((name) => (TOOLS_TABLES as ReadonlyArray<string>).includes(name)),
    ).toEqual([]);
  });
});

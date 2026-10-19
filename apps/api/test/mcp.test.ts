// Commissary's MCP endpoint (#197, ADR 0036, ADR 0037, ADR 0038): `/mcp` on the API host, through the production
// Worker's `exports.default.fetch` with the real gate and ControlPlanes, against fake upstream MCP servers
// (`@commissary/tools/testing`). Clients of both protocol eras: the stateless 2026-07-28 revision (`server/discover`,
// per-request `_meta` and headers) and the 2025 handshake (`initialize`). Orgs, members, keys and toolkits are set up
// straight through the state Worker's objects: the management routes are the app Worker's.
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newOrgId, type OrgId } from "@commissary/core";
import { controlPlaneOf, platformOf } from "@commissary/state";
import { fakeMcpServer, type FakeMcpOptions, serveFakeMcpServers } from "@commissary/tools/testing";
import { addMember, issueKey, type TestMember } from "./support/client.ts";

serveFakeMcpServers();

const LOCAL = "http://localhost";

/** A JSON-RPC message as a client sends it. */
interface RpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const POLICY = { ownHosts: [], localDevelopment: false };

/** A fake MCP server at an origin of its own, so tests never share one. */
const upstream = (options: FakeMcpOptions = {}) =>
  fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, options);

/** Who acts on the org's ControlPlane: a member, and whether they are an org admin. */
const viewer = (member: TestMember, admin = false) => ({ member: member.id, admin });

const toolsOf = (org: OrgId) => env.CONTROL_PLANE.getByName(org).tools();

type Tools = ReturnType<typeof toolsOf>;

/** Adds a toolkit as `by` and answers its id. */
const addToolkit = async (
  org: OrgId,
  by: TestMember,
  admin: boolean,
  input: Parameters<Tools["addToolkit"]>[1],
): Promise<string> => {
  const added = await toolsOf(org).addToolkit(viewer(by, admin), input, "test", POLICY);

  if (!added.ok) throw new Error(added.message);

  return added.value.id;
};

const post = (body: RpcMessage, headers: Record<string, string> = {}) =>
  exports.default.fetch(
    new Request(`${LOCAL}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

/** An org of its own, registered with the Platform (its slug names it in connect links), with an admin and two members. */
const staffedOrg = async (prefix: string) => {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const org = newOrgId();

  await controlPlaneOf(env, org).setMembershipSettings({ privateCredentials: true });
  const created = await platformOf(env).createOrg({ slug, name: slug, id: org }, Date.now());

  if (!created.ok) throw new Error(created.message);

  return {
    org,
    slug,
    admin: await addMember(org, `admin-${slug}@example.com`, "admin"),
    alice: await addMember(org, `alice-${slug}@example.com`, "member"),
    bob: await addMember(org, `bob-${slug}@example.com`, "member"),
  };
};

/** A client of the endpoint signed in with an API key of `member`. */
const clientOf = async (org: OrgId, member: TestMember) => {
  const { key } = await issueKey(org, member);

  return {
    /** One JSON-RPC message POSTed with the key, and its HTTP answer. */
    send: async (body: RpcMessage, headers: Record<string, string> = {}, path = "/mcp") => {
      const response = await exports.default.fetch(
        new Request(`${LOCAL}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );

      const text = await response.text();

      return {
        status: response.status,
        headers: response.headers,
        body: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>),
      };
    },
  };
};

describe("the MCP endpoint's gate", () => {
  it("refuses a request without a valid API key with 401 and a Bearer challenge", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { authorization: "Bearer cms_not-a-key" },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await response.body?.cancel();
  });

  it("refuses a request from another origin with 403, as the transport's DNS rebinding rule asks", async () => {
    const { org, alice } = await staffedOrg("mcp-origin");

    const answer = await (
      await clientOf(org, alice)
    ).send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example.com" });

    expect(answer.status).toBe(403);
  });

  it("answers GET and DELETE with 405: it opens no stream and keeps no session", async () => {
    const { org, alice } = await staffedOrg("mcp-405");
    const { key } = await issueKey(org, alice);

    for (const method of ["GET", "DELETE"]) {
      const response = await exports.default.fetch(
        new Request(`${LOCAL}/mcp`, {
          method,
          headers: { authorization: `Bearer ${key}`, "mcp-session-id": "abc" },
        }),
      );

      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      await response.body?.cancel();
    }
  });
});

/** A request of the stateless revision: its `_meta` and the headers that mirror its body. */
const modern = (
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {},
) => ({
  body: {
    jsonrpc: "2.0" as const,
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": capabilities,
      },
    },
  },
  headers: {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(typeof params["name"] === "string" ? { "mcp-name": params["name"] } : {}),
  },
});

/** The tools a list answer holds. */
const toolsIn = (answer: {
  body: Record<string, unknown> | undefined;
}): ReadonlyArray<Record<string, unknown>> => {
  // SAFETY: read from a test's answer; one without a list fails below.
  const result = answer.body?.["result"] as
    | { tools?: ReadonlyArray<Record<string, unknown>> }
    | undefined;

  if (result?.tools === undefined) throw new Error(`no tool list: ${JSON.stringify(answer.body)}`);

  return result.tools;
};

/**
 * An org with a toolkit of every reach: `linear`, an org toolkit that takes shared and private credentials (with a
 * shared one), `stripe`, an org toolkit with a shared credential only, and alice's private `notes`. Each echoes the
 * calls it gets (`fakeMcpServer`).
 */
const toolkitsOrg = async (prefix: string) => {
  const staff = await staffedOrg(prefix);

  const linear = upstream({
    tools: [
      { name: "list_issues", description: "Lists issues", annotations: { readOnlyHint: true } },
      {
        name: "Create.Issue",
        description: "Opens an issue",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
        annotations: { destructiveHint: true, readOnlyHint: false },
      },
      { name: "delete_issue", description: "Deletes an issue" },
      { name: "find_issues", description: "Finds issues", annotations: { readOnlyHint: true } },
    ],
  });

  const stripe = upstream({ tools: [{ name: "refund" }] });
  const notes = upstream({ tools: [{ name: "add_note" }] });

  const linearId = await addToolkit(staff.org, staff.admin, true, {
    source: linear.url,
    name: "linear",
    private: false,
    accepts: "both",
    credential: { kind: "bearer", token: "linear-shared-token" },
  });

  await addToolkit(staff.org, staff.admin, true, {
    source: stripe.url,
    name: "stripe",
    private: false,
    accepts: "shared",
    credential: { kind: "none" },
  });

  const notesId = await addToolkit(staff.org, staff.alice, false, {
    source: notes.url,
    name: "notes",
    private: true,
    accepts: "private",
    credential: { kind: "bearer", token: "alice-notes-token" },
  });

  return { ...staff, linear, stripe, notes, linearId, notesId };
};

describe("the tool list", () => {
  it("is every tool the member may use, sorted, with overrides applied and annotations from the class", async () => {
    const { org, admin, alice, bob, linearId } = await toolkitsOrg("mcp-list");
    const tools = toolsOf(org);

    for (const override of [
      { tool: "delete_issue", hidden: true },
      {
        tool: "find_issues",
        name: "search",
        description: "Searches issues",
        class: "write" as const,
      },
      { tool: "Create.Issue", class: "read" as const },
    ]) {
      const set = await tools.setOverride(viewer(admin, true), linearId, 0, override, "test");

      if (!set.ok) throw new Error(set.message);
    }

    const list = modern(1, "tools/list");
    const answer = await (await clientOf(org, alice)).send(list.body, list.headers);

    expect(answer.status).toBe(200);

    expect(answer.body?.["result"]).toMatchObject({
      resultType: "complete",
      cacheScope: "private",
    });

    expect(toolsIn(answer)).toEqual([
      {
        name: "linear_create_issue",
        description: "Opens an issue",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: "linear_list_issues",
        description: "Lists issues",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      { name: "linear_search", description: "Searches issues", inputSchema: { type: "object" } },
      { name: "notes_add_note", inputSchema: { type: "object" } },
    ]);

    // Another member: the org toolkit, never alice's private one; nobody reaches the shared-only toolkit.
    const bobs = await (await clientOf(org, bob)).send(list.body, list.headers);

    expect(toolsIn(bobs).map((tool) => tool.name)).toEqual([
      "linear_create_issue",
      "linear_list_issues",
      "linear_search",
    ]);
  });

  it("is the same for a client of the 2025 handshake, without the stateless revision's fields", async () => {
    const { org, alice } = await toolkitsOrg("mcp-list-legacy");

    const answer = await (
      await clientOf(org, alice)
    ).send(
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
      { "mcp-protocol-version": "2025-11-25" },
    );

    expect(answer.body?.["result"]).not.toHaveProperty("resultType");

    expect(toolsIn(answer).map((tool) => tool.name)).toEqual([
      "linear_create_issue",
      "linear_delete_issue",
      "linear_find_issues",
      "linear_list_issues",
      "notes_add_note",
    ]);
  });

  it("narrows to the toolkits `?toolkits=` names, and to nothing for a name the member does not see", async () => {
    const { org, alice, bob } = await toolkitsOrg("mcp-narrow");
    const list = modern(1, "tools/list");

    const names = async (member: TestMember, query: string) =>
      toolsIn(
        await (await clientOf(org, member)).send(list.body, list.headers, `/mcp?${query}`),
      ).map((tool) => tool.name);

    expect(await names(alice, "toolkits=notes")).toEqual(["notes_add_note"]);

    expect(await names(alice, "toolkits=Notes,%20linear")).toEqual([
      "linear_create_issue",
      "linear_delete_issue",
      "linear_find_issues",
      "linear_list_issues",
      "notes_add_note",
    ]);

    expect(await names(alice, "toolkits=github")).toEqual([]);
    expect(await names(bob, "toolkits=notes")).toEqual([]);
    expect(await names(alice, "toolkits=stripe")).toEqual([]);
  });
});

/** A `tools/call` answer's result. */
const resultOf = (answer: { body: Record<string, unknown> | undefined }) =>
  answer.body?.["result"] as Record<string, unknown> | undefined;

/** The upstream calls a fake server got: the upstream name, the arguments and the credential. */
const callsTo = (server: ReturnType<typeof upstream>) =>
  server.requests
    .filter((request) => request.rpc === "tools/call")
    .map((request) => ({
      name: request.params?.["name"],
      arguments: request.params?.["arguments"],
      authorization: request.headers.get("authorization"),
    }));

const connectPrivate = async (org: OrgId, member: TestMember, toolkit: string, token: string) => {
  const connected = await toolsOf(org).connectCredential(
    viewer(member),
    toolkit,
    "private",
    { kind: "bearer", token },
    "test",
    POLICY,
  );

  if (!connected.ok) throw new Error(connected.message);
};

describe("a tool call", () => {
  it("reaches the upstream tool by its upstream name on the member's private credential, which wins", async () => {
    const { org, admin, alice, linear, linearId } = await toolkitsOrg("mcp-call");

    await connectPrivate(org, alice, linearId, "alice-linear-token");

    const renamed = await toolsOf(org).setOverride(
      viewer(admin, true),
      linearId,
      0,
      { tool: "find_issues", name: "search" },
      "test",
    );

    if (!renamed.ok) throw new Error(renamed.message);
    const client = await clientOf(org, alice);

    const call = modern(1, "tools/call", {
      name: "linear_create_issue",
      arguments: { title: "Hi" },
    });

    const answer = await client.send(call.body, call.headers);

    expect(answer.status).toBe(200);

    expect(resultOf(answer)).toMatchObject({
      resultType: "complete",
      content: [
        {
          type: "text",
          text: JSON.stringify({ name: "Create.Issue", arguments: { title: "Hi" } }),
        },
      ],
    });

    const search = await client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "linear_search", arguments: { query: "bug" } },
    });

    expect(resultOf(search)).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ name: "find_issues", arguments: { query: "bug" } }),
        },
      ],
    });

    expect(callsTo(linear)).toEqual([
      {
        name: "Create.Issue",
        arguments: { title: "Hi" },
        authorization: "Bearer alice-linear-token",
      },
      {
        name: "find_issues",
        arguments: { query: "bug" },
        authorization: "Bearer alice-linear-token",
      },
    ]);
  });

  it("calls a shortened tool by its upstream name, on a stateless upstream with the revision's headers", async () => {
    const { org, alice } = await staffedOrg("mcp-short");
    const long = "a_tool_whose_name_is_much_too_long_for_any_client";

    const server = upstream({
      stateless: true,
      tools: [
        {
          name: long,
          inputSchema: {
            type: "object",
            properties: {
              region: { type: "string", "x-mcp-header": "Region" },
              where: {
                type: "object",
                properties: { city: { type: "string", "x-mcp-header": "City" } },
              },
            },
          },
        },
      ],
    });

    await addToolkit(org, alice, false, {
      source: server.url,
      name: "longs",
      private: true,
      accepts: "private",
      credential: { kind: "none" },
    });

    const client = await clientOf(org, alice);
    const list = modern(1, "tools/list");
    const [tool] = toolsIn(await client.send(list.body, list.headers));
    const name = String(tool?.["name"]);

    expect(name).toMatch(/^longs_a_tool_whose_name_is_much_too_long_[0-9a-f]{4}$/);

    const args = { region: "us-west1", where: { city: "Zürich" } };
    const call = modern(2, "tools/call", { name, arguments: args });
    const answer = await client.send(call.body, call.headers);

    expect(resultOf(answer)?.["isError"]).toBeUndefined();
    const upstreamCall = server.requests.find((request) => request.rpc === "tools/call");

    expect(upstreamCall?.params?.["name"]).toBe(long);
    expect(upstreamCall?.headers.get("mcp-method")).toBe("tools/call");
    expect(upstreamCall?.headers.get("mcp-name")).toBe(long);
    expect(upstreamCall?.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    // Arguments the input schema marks `x-mcp-header` are mirrored, base64 where they are not plain ASCII.
    expect(upstreamCall?.headers.get("mcp-param-region")).toBe("us-west1");
    expect(upstreamCall?.headers.get("mcp-param-city")).toBe("=?base64?WsO8cmljaA==?=");

    expect(upstreamCall?.params?.["_meta"]).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    });
  });

  it("passes an upstream tool error through, and turns an upstream failure into a short tool error", async () => {
    const { org, alice } = await staffedOrg("mcp-fail");

    const server = upstream({
      tools: [{ name: "refused" }, { name: "broken" }],
      call: (name) =>
        name === "refused"
          ? { content: [{ type: "text", text: "no such issue" }], isError: true }
          : new Response("internal error at https://secret.example.com/?key=k", { status: 500 }),
    });

    await addToolkit(org, alice, false, {
      source: `${server.url}?key=secret-in-query`,
      name: "flaky",
      private: true,
      accepts: "private",
      credential: { kind: "none" },
    });

    const client = await clientOf(org, alice);
    const refused = modern(1, "tools/call", { name: "flaky_refused", arguments: {} });

    expect(resultOf(await client.send(refused.body, refused.headers))).toMatchObject({
      content: [{ type: "text", text: "no such issue" }],
      isError: true,
    });

    const broken = modern(2, "tools/call", { name: "flaky_broken", arguments: {} });
    const failed = await client.send(broken.body, broken.headers);

    expect(failed.status).toBe(200);

    expect(resultOf(failed)).toEqual({
      resultType: "complete",
      content: [{ type: "text", text: "the MCP server answered HTTP 500" }],
      isError: true,
      _meta: expect.any(Object),
    });
  });

  it("answers a tool outside the member's reach as it answers an unknown tool", async () => {
    const { org, alice, bob, stripe } = await toolkitsOrg("mcp-reach");

    const unknown = async (member: TestMember, name: string, path = "/mcp") => {
      const call = modern(1, "tools/call", { name, arguments: {} });
      const answer = await (await clientOf(org, member)).send(call.body, call.headers, path);

      return { status: answer.status, error: answer.body?.["error"] };
    };

    const nothing = await unknown(alice, "linear_nothing");

    expect(nothing).toEqual({
      status: 200,
      error: { code: -32602, message: "Unknown tool: linear_nothing" },
    });

    // The shared credential's tools, another member's private toolkit, a toolkit `?toolkits=` leaves out.
    expect(await unknown(alice, "stripe_refund")).toEqual({
      ...nothing,
      error: { code: -32602, message: "Unknown tool: stripe_refund" },
    });

    expect(await unknown(bob, "notes_add_note")).toEqual({
      ...nothing,
      error: { code: -32602, message: "Unknown tool: notes_add_note" },
    });

    expect(await unknown(alice, "notes_add_note", "/mcp?toolkits=linear")).toEqual({
      ...nothing,
      error: { code: -32602, message: "Unknown tool: notes_add_note" },
    });

    expect(callsTo(stripe)).toEqual([]);
  });
});

describe("an upstream's session", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A private toolkit of alice on a 2025 server, and a call of its tool. */
  const sessionOrg = async (prefix: string) => {
    const { org, alice } = await staffedOrg(prefix);
    const server = upstream({ tools: [{ name: "ping" }] });

    await addToolkit(org, alice, false, {
      source: server.url,
      name: "kept",
      private: true,
      accepts: "private",
      credential: { kind: "none" },
    });

    const client = await clientOf(org, alice);
    const call = modern(1, "tools/call", { name: "kept_ping", arguments: {} });

    return {
      server,
      call: async () => {
        const answer = await client.send(call.body, call.headers);

        expect(resultOf(answer)?.["isError"]).toBeUndefined();
      },
      /** The `initialize` requests the server got from calls (the tool list's build is not one). */
      handshakes: () =>
        server.requests.filter((request) => request.rpc === "initialize").length - 1,
    };
  };

  it("is kept between calls, and opened again when the server forgets it", async () => {
    const { server, call, handshakes } = await sessionOrg("mcp-session");

    await call();
    await call();
    expect(handshakes()).toBe(1);

    server.forgetSessions();
    await call();
    await call();
    expect(handshakes()).toBe(2);
  });

  it("is not kept for seven days", async () => {
    const { call, handshakes } = await sessionOrg("mcp-session-expiry");

    await call();
    expect(handshakes()).toBe(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await call();
    expect(handshakes()).toBe(2);
  });
});

describe("a call that needs a private credential the member has not connected", () => {
  it("elicits the connect link from a stateless client that declares URL mode", async () => {
    const { org, slug, bob, linear, linearId } = await toolkitsOrg("mcp-connect");
    const client = await clientOf(org, bob);

    const call = modern(
      1,
      "tools/call",
      { name: "linear_list_issues", arguments: {} },
      { elicitation: { url: {} } },
    );

    const answer = await client.send(call.body, call.headers);
    const link = `${LOCAL}/o/${slug}/tools/${linearId}/connect`;

    expect(answer.status).toBe(200);

    expect(resultOf(answer)).toEqual({
      resultType: "input_required",
      inputRequests: {
        connect_linear: {
          method: "elicitation/create",
          params: { mode: "url", url: link, message: expect.stringContaining("linear") },
        },
      },
      _meta: expect.any(Object),
    });

    // The member declined: the link as a tool result.
    const retry = modern(
      2,
      "tools/call",
      {
        name: "linear_list_issues",
        arguments: {},
        inputResponses: { connect_linear: { action: "decline" } },
      },
      { elicitation: { url: {} } },
    );

    const declined = resultOf(await client.send(retry.body, retry.headers));

    expect(declined?.["isError"]).toBe(true);
    expect(JSON.stringify(declined?.["content"])).toContain(link);
    // Never the shared credential, nor another member's.
    expect(callsTo(linear)).toEqual([]);
  });

  it("answers the link as a tool result to a client without URL elicitation, of either era", async () => {
    const { org, slug, bob, linearId } = await toolkitsOrg("mcp-connect-result");
    const client = await clientOf(org, bob);
    const link = `${LOCAL}/o/${slug}/tools/${linearId}/connect`;
    const formOnly = modern(1, "tools/call", { name: "linear_list_issues" }, { elicitation: {} });
    const modernAnswer = resultOf(await client.send(formOnly.body, formOnly.headers));

    expect(modernAnswer).toMatchObject({ resultType: "complete", isError: true });
    expect(JSON.stringify(modernAnswer?.["content"])).toContain(link);

    const legacyAnswer = resultOf(
      await client.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "linear_list_issues", arguments: {} },
      }),
    );

    expect(legacyAnswer?.["isError"]).toBe(true);
    expect(JSON.stringify(legacyAnswer?.["content"])).toContain(link);
  });
});

describe("a client of the stateless revision", () => {
  it("discovers the revisions the endpoint speaks and that it serves tools", async () => {
    const { org, alice } = await staffedOrg("mcp-discover");
    const client = await clientOf(org, alice);
    const discover = modern(1, "server/discover");
    const answer = await client.send(discover.body, discover.headers);

    expect(answer.status).toBe(200);

    expect(answer.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
        capabilities: { tools: {} },
        ttlMs: expect.any(Number),
        cacheScope: "public",
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "commissary", version: expect.any(String) },
        },
      },
    });
  });

  it("refuses headers that do not match the body, and a revision it does not speak", async () => {
    const { org, alice } = await staffedOrg("mcp-headers");
    const client = await clientOf(org, alice);
    const list = modern(1, "tools/list");

    const mismatched = await client.send(list.body, {
      ...list.headers,
      "mcp-method": "tools/call",
    });

    expect(mismatched.status).toBe(400);
    expect(mismatched.body?.["error"]).toMatchObject({ code: -32020 });

    const future = await client.send(list.body, {
      ...list.headers,
      "mcp-protocol-version": "2099-01-01",
    });

    expect(future.status).toBe(400);
    expect(future.body?.["error"]).toMatchObject({ code: -32020 });

    const unknown = modern(2, "tools/list");

    const unsupported = await client.send(
      {
        ...unknown.body,
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } },
      },
      { ...unknown.headers, "mcp-protocol-version": "2099-01-01" },
    );

    expect(unsupported.status).toBe(400);

    expect(unsupported.body?.["error"]).toMatchObject({
      code: -32022,
      data: { supported: expect.arrayContaining(["2026-07-28"]), requested: "2099-01-01" },
    });

    const resources = modern(3, "resources/list");
    const notServed = await client.send(resources.body, resources.headers);

    expect(notServed.status).toBe(404);
    expect(notServed.body?.["error"]).toMatchObject({ code: -32601 });
  });
});

describe("a client of the 2025 handshake", () => {
  it("is answered `initialize` in the revision it asked for, with tools and no session", async () => {
    const { org, alice } = await staffedOrg("mcp-init");
    const client = await clientOf(org, alice);

    const answer = await client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });

    expect(answer.status).toBe(200);
    expect(answer.headers.get("mcp-session-id")).toBeNull();

    expect(answer.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "commissary", version: expect.any(String) },
      },
    });

    const initialized = await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    expect(initialized.status).toBe(202);
    expect(initialized.body).toBeUndefined();
  });
});

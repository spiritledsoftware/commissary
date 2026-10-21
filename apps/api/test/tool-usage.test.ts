// Tool calls' usage records, prices and Spend limits (#199, ADR 0038) through the API Worker's `/mcp`: every call of a
// tool the member reaches leaves one usage record (no arguments, no results), a priced call is checked against the
// Spend limits before the upstream is reached and charged after, and a free call goes ahead whatever the limits. Orgs,
// members, keys, toolkits, prices and limits are set up straight through the state Worker's objects.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { newOrgId, type OrgId } from "@commissary/core";
import {
  authIndexOf,
  listUsageRecords,
  resetUsageDb,
  rowToPayload,
} from "@commissary/models/testing";
import { controlPlaneOf, platformOf } from "@commissary/state";
import {
  fakeMcpServer,
  type FakeMcpOptions,
  insertSessionRecord,
  insertToolCallRecord,
  serveFakeMcpServers,
} from "@commissary/tools/testing";
import worker from "../src/index.ts";
import { addMember, issueKey, type TestMember } from "./support/client.ts";

serveFakeMcpServers();

beforeAll(async () => {
  await resetUsageDb();
});

const POLICY = { ownHosts: [], localDevelopment: false };

/** A fake MCP server at an origin of its own, so tests never share one. */
const upstream = (options: FakeMcpOptions = {}) =>
  fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, options);

const viewer = (member: TestMember, admin = false) => ({ member: member.id, admin });

const planeOf = (org: OrgId) => env.CONTROL_PLANE.getByName(org);

/** An org registered with the Platform (its API keys are checked there): an admin, alice and bob, private credentials and toolkits on. */
const staffedOrg = async (prefix: string) => {
  const org = newOrgId();
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

  await controlPlaneOf(env, org).setMembershipSettings({
    privateCredentials: true,
    privateToolkits: true,
  });
  const created = await platformOf(env).createOrg({ slug, name: slug, id: org }, Date.now());

  if (!created.ok) throw new Error(created.message);

  return {
    org,
    admin: await addMember(org, `admin-${prefix}@example.com`, "admin"),
    alice: await addMember(org, `alice-${prefix}@example.com`, "member"),
    bob: await addMember(org, `bob-${prefix}@example.com`, "member"),
  };
};

/**
 * Adds an org toolkit with a shared credential `subject` may use (everyone by default); answers its view. One that
 * accepts `both` serves the members its grant leaves out on their own credential.
 */
const orgToolkit = async (
  org: OrgId,
  admin: TestMember,
  name: string,
  source: string,
  accepts: "shared" | "both" = "shared",
  subject: { readonly kind: "everyone" } | { readonly kind: "member"; readonly id: string } = {
    kind: "everyone",
  },
) => {
  const added = await planeOf(org)
    .tools()
    .addToolkit(
      viewer(admin, true),
      {
        source,
        name,
        private: false,
        accepts,
        credential: { kind: "none", subject },
      },
      "test",
      POLICY,
    );

  if (!added.ok) throw new Error(added.message);

  return added.value;
};

/** A client of `/mcp` with an API key of `member`; each call waits for what the Worker wrote off the response path. */
const clientOf = async (org: OrgId, member: TestMember) => {
  const { id, key } = await issueKey(org, member);

  return {
    keyId: id,
    call: async (name: string, args?: Record<string, unknown>) => {
      const ctx = createExecutionContext();

      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, ...(args === undefined ? {} : { arguments: args }) },
        }),
      });

      // SAFETY: the default export reads no `cf` property of the request; workerd's own requests carry them.
      const incoming = request as Request<unknown, IncomingRequestCfProperties>;
      const response = await worker.fetch(incoming, env, ctx);
      const body: Record<string, unknown> = await response.json();

      await waitOnExecutionContext(ctx);

      if (body["error"] !== undefined) throw new Error(JSON.stringify(body["error"]));

      // SAFETY: read from a test's answer; a call answers a result or an error.
      return body["result"] as Record<string, unknown> | undefined;
    },
  };
};

interface ToolRow {
  readonly [column: string]: unknown;
  readonly tool_id: string;
  readonly tool_outcome: string;
}

/** The org's tool calls' records, oldest first. */
const toolRows = async (org: OrgId): Promise<ReadonlyArray<ToolRow>> =>
  (
    await env.USAGE.prepare(
      `SELECT * FROM usage_records WHERE org_id = ? AND area = 'tools' ORDER BY requested_at, rowid`,
    )
      .bind(org)
      .all<ToolRow>()
  ).results;

const textOf = (result: Record<string, unknown> | undefined): string =>
  // SAFETY: a tool result's content, as the endpoint answers it.
  ((result?.["content"] as ReadonlyArray<{ readonly text?: string }> | undefined) ?? [])
    .map((part) => part.text ?? "")
    .join("");

describe("a tool call's usage record", () => {
  it("is written for a success, a tool error and an upstream failure, and holds no argument or result text", async () => {
    const marker = `marker-${crypto.randomUUID()}`;

    const server = upstream({
      tools: [{ name: "echo" }, { name: "broken" }, { name: "down" }],
      call: (name) => {
        if (name === "broken")
          return { content: [{ type: "text", text: `failed: ${marker}` }], isError: true };

        if (name === "down") return new Response("unavailable", { status: 503 });

        return { content: [{ type: "text", text: `echo ${marker}` }] };
      },
    });

    const { org, admin, alice } = await staffedOrg("records");
    const toolkit = await orgToolkit(org, admin, "kit", server.url);
    const client = await clientOf(org, alice);

    expect(textOf(await client.call("kit_echo", { query: marker }))).toContain(marker);
    await client.call("kit_broken", { query: marker });
    await client.call("kit_down", { query: marker });

    const rows = await toolRows(org);

    expect(rows.map((row) => [row.tool_id, row.tool_outcome])).toEqual([
      [`${toolkit.id}:echo`, "success"],
      [`${toolkit.id}:broken`, "tool_error"],
      [`${toolkit.id}:down`, "upstream_failure"],
    ]);
    expect(rows[0]).toMatchObject({
      area: "tools",
      org_id: org,
      principal_id: `key:${client.keyId}`,
      member_id: alice.id,
      toolkit_id: toolkit.id,
      auth_type: "shared",
      private: 0,
      failed: 0,
      cost_micros: 0,
      unpriced: 0,
      approval: "none",
      exported_at: null,
      request_bytes: JSON.stringify({ query: marker }).length,
    });
    expect(rows[0]?.["response_bytes"]).toBeGreaterThan(marker.length);
    expect(rows.map((row) => row["failed"])).toEqual([0, 1, 1]);

    // Nothing of the arguments or results is stored, in any column of any record.
    const everything = await env.USAGE.prepare(`SELECT * FROM usage_records`).all();

    expect(JSON.stringify(everything.results)).not.toContain(marker);
  });

  it("reads back through the usage records' reader as the management API answers it", async () => {
    // The records route (`GET /v9/management/observability/usage/records?area=tools`) is the app Worker's, whose tests
    // cannot serve `/mcp`: this reads the call `/mcp` recorded with the functions that route answers with.
    const server = upstream({ tools: [{ name: "lookup" }] });
    const { org, admin, alice } = await staffedOrg("read-back");
    const toolkit = await orgToolkit(org, admin, "kit", server.url);
    const client = await clientOf(org, alice);

    await client.call("kit_lookup", { q: "x" });

    const page = await listUsageRecords(env.USAGE, org, { area: "tools" }, authIndexOf);

    expect(page.rows.map((row) => rowToPayload(row, authIndexOf))).toEqual([
      expect.objectContaining({
        area: "tools",
        toolkit_id: toolkit.id,
        tool_id: `${toolkit.id}:lookup`,
        outcome: "success",
        credential: "shared",
        request_bytes: JSON.stringify({ q: "x" }).length,
        response_bytes: expect.any(Number),
        api_key: `key:${client.keyId}`,
        member_id: alice.id,
        auth_index: "",
        failed: false,
        fail: { status_code: 200 },
        cost_micros: 0,
        unpriced: false,
      }),
    ]);
    // Model attempts' reads leave it out.
    expect((await listUsageRecords(env.USAGE, org, {}, authIndexOf)).rows).toEqual([]);
  });

  it("carries the browser toolkit's browser time, a Quick Action's and a closed session's, and reads it back", async () => {
    // The browser toolkit needs Browser Run, which this Worker's tests do not bind: the records are seeded with Tools'
    // writers, as the MCP endpoint and a session's object write them (#214).
    const { org, alice } = await staffedOrg("browser-time");
    const at = Date.now();

    await insertToolCallRecord(env.USAGE, {
      requestId: crypto.randomUUID(),
      orgId: org,
      principalId: "key:k-browser",
      memberId: alice.id,
      toolkitId: "browser",
      toolId: "browser:markdown",
      credential: "shared",
      private: false,
      outcome: "success",
      requestedAt: at,
      latencyMs: 2_000,
      requestBytes: 30,
      responseBytes: 300,
      costMicros: 1_500,
      approval: "none",
      browserMs: 1_500,
    });
    await insertSessionRecord(env.USAGE, {
      sessionId: `bs_${"0".repeat(32)}`,
      orgId: org,
      principalId: "key:k-browser",
      memberId: alice.id,
      toolkitId: "browser",
      openedAt: at + 1,
      browserMs: 90_000,
      costMicros: 2_250,
      profileId: "bp_work",
    });

    const page = await listUsageRecords(env.USAGE, org, { toolkit: "browser" }, authIndexOf);
    const payloads = page.rows.map((row) => rowToPayload(row, authIndexOf));

    expect(payloads).toEqual([
      expect.objectContaining({
        area: "tools",
        toolkit_id: "browser",
        credential: "shared",
        browser_ms: 90_000,
        browser_profile_id: "bp_work",
        cost_micros: 2_250,
        api_key: "key:k-browser",
        member_id: alice.id,
      }),
      expect.objectContaining({
        tool_id: "browser:markdown",
        outcome: "success",
        browser_ms: 1_500,
        cost_micros: 1_500,
      }),
    ]);
    // The session's record names no tool and no outcome.
    expect(payloads[0]).not.toHaveProperty("tool_id");
    expect(payloads[0]).not.toHaveProperty("outcome");
    expect(payloads[1]).not.toHaveProperty("browser_profile_id");
  });

  it("is written when the member must connect their own credential, and marked private on a private toolkit", async () => {
    const server = upstream({ tools: [{ name: "t" }] });
    const { org, admin, alice } = await staffedOrg("private");

    // Its shared credential is the admin's alone: alice reaches its tools as herself, with a credential she has not connected.
    const byo = await orgToolkit(org, admin, "byo", server.url, "both", {
      kind: "member",
      id: admin.id,
    });

    const mine = await planeOf(org)
      .tools()
      .addToolkit(
        viewer(alice),
        {
          source: server.url,
          name: "mine",
          private: true,
          accepts: "private",
          credential: { kind: "none" },
        },
        "test",
        POLICY,
      );

    if (!mine.ok) throw new Error(mine.message);
    const client = await clientOf(org, alice);

    await client.call("byo_t");
    await client.call("mine_t");

    expect(await toolRows(org)).toMatchObject([
      { toolkit_id: byo.id, tool_outcome: "needs_credential", auth_type: "", private: 0 },
      { toolkit_id: mine.value.id, tool_outcome: "success", auth_type: "private", private: 1 },
    ]);
  });

  it("is not written for a tool the member does not reach", async () => {
    const { org, alice } = await staffedOrg("unknown");
    const client = await clientOf(org, alice);

    await expect(client.call("nothing_here")).rejects.toThrow("Unknown tool: nothing_here");

    expect(await toolRows(org)).toEqual([]);
  });
});

describe("a priced tool call", () => {
  /**
   * An org whose toolkit `paid` costs 1,000 micro-USD a call, its `premium` tool 5,000, its `free` tool nothing; its
   * `down` tool fails upstream (503), its `broken` tool answers an `isError` result. `accepts` `both` with a shared
   * credential for the admin alone serves the other members on their own credential.
   */
  const pricedOrg = async (prefix: string, accepts: "shared" | "both" = "shared") => {
    const staff = await staffedOrg(prefix);

    const server = upstream({
      tools: [
        { name: "search" },
        { name: "premium" },
        { name: "free" },
        { name: "down" },
        { name: "broken" },
      ],
      call: (name) => {
        if (name === "down") return new Response("unavailable", { status: 503 });

        if (name === "broken") return { content: [{ type: "text", text: "no" }], isError: true };

        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    const toolkit = await orgToolkit(
      staff.org,
      staff.admin,
      "paid",
      server.url,
      accepts,
      accepts === "both" ? { kind: "member", id: staff.admin.id } : { kind: "everyone" },
    );

    const tools = planeOf(staff.org).tools();
    const admin = viewer(staff.admin, true);

    await tools.updateToolkit(
      admin,
      toolkit.id,
      toolkit.revision,
      { price_micros: 1_000 },
      "t",
      POLICY,
    );
    await tools.setOverride(admin, toolkit.id, 0, { tool: "premium", price_micros: 5_000 }, "t");
    await tools.setOverride(admin, toolkit.id, 0, { tool: "free", price_micros: 0 }, "t");

    return { ...staff, server, toolkit };
  };

  const limit = async (
    org: OrgId,
    admin: TestMember,
    kind: "member" | "team" | "org" | "toolkit_credential" | "key",
    subject: string,
    amountMicros: number,
  ) => {
    const made = await planeOf(org).createSpendLimit(
      viewer(admin, true),
      { kind, subject, period: "day", amountMicros },
      "t",
    );

    if (!made.ok) throw new Error(`${made.error}: ${made.message}`);

    return made.value;
  };

  it("costs the tool's price over the toolkit's, and counts toward the member, team, org, toolkit and key limits", async () => {
    const { org, admin, alice, toolkit } = await pricedOrg("charges");
    const team = await controlPlaneOf(env, org).createTeam("eng");

    if (!team.ok) throw new Error(team.message);
    await controlPlaneOf(env, org).addTeamMember(team.value.id, alice.id);
    const client = await clientOf(org, alice);
    const roomy = 1_000_000;

    await limit(org, admin, "member", alice.id, roomy);
    await limit(org, admin, "team", team.value.id, roomy);
    await limit(org, admin, "org", "", roomy);
    await limit(org, admin, "toolkit_credential", toolkit.id, roomy);
    await limit(org, admin, "key", client.keyId, roomy);

    await client.call("paid_search");
    await client.call("paid_premium");
    await client.call("paid_free");

    expect((await toolRows(org)).map((row) => [row.tool_id, row["cost_micros"]])).toEqual([
      [`${toolkit.id}:search`, 1_000],
      [`${toolkit.id}:premium`, 5_000],
      [`${toolkit.id}:free`, 0],
    ]);
    expect((await toolRows(org)).every((row) => row["unpriced"] === 0)).toBe(true);

    const overview = await planeOf(org).spendOverview(viewer(admin, true));

    expect(
      Object.fromEntries(overview.entries.map((entry) => [entry.kind, entry.spentMicros])),
    ).toEqual({ member: 6_000, team: 6_000, org: 6_000, toolkit_credential: 6_000, key: 6_000 });
    // A toolkit limit names the toolkit by its id, and shows its name.
    expect(overview.entries.find((entry) => entry.kind === "toolkit_credential")).toMatchObject({
      subject: toolkit.id,
      label: "paid",
    });
  });

  it("is refused before the upstream once a limit it counts toward has no room; a free call goes ahead", async () => {
    const { org, admin, alice, toolkit, server } = await pricedOrg("refused");
    const client = await clientOf(org, alice);

    await limit(org, admin, "toolkit_credential", toolkit.id, 0);
    const calls = () => server.requests.filter((request) => request.rpc === "tools/call").length;

    const refused = await client.call("paid_search");

    expect(refused?.["isError"]).toBe(true);
    expect(textOf(refused)).toMatch(
      /^The daily Spend limit of this toolkit's shared credential is reached; it resets at .+\. paid_search was not called\.$/,
    );
    expect(calls()).toBe(0);

    expect(textOf(await client.call("paid_free"))).not.toContain("Spend limit");
    expect(calls()).toBe(1);

    expect(await toolRows(org)).toMatchObject([
      { tool_outcome: "refused", cost_micros: 0, failed: 1 },
      { tool_outcome: "success", cost_micros: 0, failed: 0 },
    ]);
  });

  it("charges a call the upstream answered with an isError result, and not one that failed upstream", async () => {
    const { org, admin, alice, toolkit } = await pricedOrg("failures");

    await limit(org, admin, "member", alice.id, 1_000_000);
    const client = await clientOf(org, alice);

    const spent = async () =>
      (await planeOf(org).spendOverview(viewer(admin, true))).entries.find(
        (entry) => entry.kind === "member",
      )?.spentMicros;

    await client.call("paid_down");
    expect(await spent()).toBe(0);

    await client.call("paid_broken");
    expect(await spent()).toBe(1_000);

    expect(
      (await toolRows(org)).map((row) => [row.tool_id, row.tool_outcome, row["cost_micros"]]),
    ).toEqual([
      [`${toolkit.id}:down`, "upstream_failure", 0],
      [`${toolkit.id}:broken`, "tool_error", 1_000],
    ]);
  });

  it("on the member's private credential counts toward their API key's limits only, in a private record", async () => {
    const { org, admin, alice, toolkit } = await pricedOrg("private-spend", "both");

    const connected = await planeOf(org)
      .tools()
      .connectCredential(
        viewer(alice),
        toolkit.id,
        "private",
        { kind: "bearer", token: "alice-token" },
        "test",
        POLICY,
      );

    if (!connected.ok) throw new Error(connected.message);
    const client = await clientOf(org, alice);
    const roomy = 1_000_000;

    await limit(org, admin, "member", alice.id, roomy);
    await limit(org, admin, "org", "", roomy);
    await limit(org, admin, "toolkit_credential", toolkit.id, roomy);
    await limit(org, admin, "key", client.keyId, roomy);

    await client.call("paid_search");

    const overview = await planeOf(org).spendOverview(viewer(admin, true));

    expect(
      Object.fromEntries(overview.entries.map((entry) => [entry.kind, entry.spentMicros])),
    ).toEqual({ member: 0, org: 0, toolkit_credential: 0, key: 1_000 });
    expect(await toolRows(org)).toMatchObject([
      { auth_type: "private", private: 1, cost_micros: 1_000, tool_outcome: "success" },
    ]);
  });

  it("stops at the member's limit once its calls used it up", async () => {
    const { org, admin, alice, bob } = await pricedOrg("used-up");

    await limit(org, admin, "member", alice.id, 2_000);
    const client = await clientOf(org, alice);

    await client.call("paid_search");
    await client.call("paid_search");
    expect(textOf(await client.call("paid_search"))).toContain(
      "The daily Spend limit of your membership is reached",
    );
    // Bob's calls do not count toward alice's limit.
    expect(textOf(await (await clientOf(org, bob)).call("paid_search"))).not.toContain(
      "Spend limit",
    );
  });
});

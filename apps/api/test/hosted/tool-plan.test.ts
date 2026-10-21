// What Commissary Cloud's plans count of tool calls (#241, ADR 0042) through the production Worker's `/mcp` with the
// real ControlPlane, its Tools and Billing parts: each call of a tool counts once with requests toward a Free org's
// 25,000 a month, and the call that finds the free usage used up is refused with a tool error that names the limit and
// links to the billing page, without counting. (The test Worker allows a Free org 5 requests a minute,
// vitest.config.ts: the test seeds the month's count instead of sending thousands of calls.)
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { FREE_USAGE, requestsUsed, seedRequestsUsed } from "@commissary/billing/testing";
import { resetUsageDb } from "@commissary/models/testing";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import { call, keyedOrg, roomInWindow } from "./support.ts";

serveFakeMcpServers();

beforeAll(async () => {
  await resetUsageDb();
});

const POLICY = { ownHosts: [], localDevelopment: false };

/** `tools/call` of `name` with the API key `key`: the tool result. */
const callTool = async (key: string, name: string) => {
  const response = await call("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } }),
  });

  expect(response.status).toBe(200);

  // SAFETY: a tool call answers a JSON-RPC result.
  return (
    (await response.json()) as {
      result: {
        isError?: boolean;
        content: [{ text: string }];
        _meta?: Record<string, unknown>;
      };
    }
  ).result;
};

/** A new Cloud org with a toolkit of one tool, `kit_echo`, that everyone may use. */
const orgWithToolkit = async (email: string) => {
  const staffed = await keyedOrg(email);

  const server = fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
    tools: [{ name: "echo" }],
    call: () => ({ content: [{ type: "text", text: "echoed" }] }),
  });

  const added = await env.CONTROL_PLANE.getByName(staffed.org)
    .tools()
    .addToolkit(
      { member: staffed.member, admin: true },
      {
        source: server.url,
        name: "kit",
        private: false,
        accepts: "shared",
        credential: { kind: "none", subject: { kind: "everyone" } },
      },
      "test",
      POLICY,
    );

  if (!added.ok) throw new Error(added.message);

  return staffed;
};

describe("tool calls on Commissary Cloud's Free plan", () => {
  it("count with requests toward the 25,000 a month, and the call past them is refused without counting", async () => {
    const { org, key } = await orgWithToolkit("tool-plan@example.com");

    await roomInWindow();
    // 24,998 used: two more tool calls reach 25,000, and the third finds the free usage used up.
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests - 2);

    expect(await callTool(key, "kit_echo")).toMatchObject({ content: [{ text: "echoed" }] });
    expect(await callTool(key, "kit_echo")).toMatchObject({ content: [{ text: "echoed" }] });
    expect(await requestsUsed(env, org, Date.now())).toBe(FREE_USAGE.requests);

    const refused = await callTool(key, "kit_echo");

    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("kit_echo was not called");
    expect(refused.content[0].text).toContain("Free plan's 25,000 requests and tool calls");
    expect(refused.content[0].text).toContain("billing page");
    // The code is in the text and in `_meta`, so a client can tell a plan limit from a Spend limit.
    expect(refused.content[0].text).toContain("plan_limit_reached");
    expect(refused._meta).toEqual({
      "commissary.dev/plan_limit": {
        error: "plan_limit_reached",
        limit: "requests",
        allowed: FREE_USAGE.requests,
        retry_after: expect.any(Number),
      },
    });
    expect(await requestsUsed(env, org, Date.now())).toBe(FREE_USAGE.requests);
  });

  it("do not count when the tool does not exist", async () => {
    const { org, key } = await orgWithToolkit("tool-plan-unknown@example.com");

    const unknown = await call("/mcp", {
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
        params: { name: "kit_missing" },
      }),
    });

    await unknown.body?.cancel();
    expect(await requestsUsed(env, org, Date.now())).toBe(0);
  });
});

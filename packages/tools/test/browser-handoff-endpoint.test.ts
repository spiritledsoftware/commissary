// A browser session's handoff through Commissary's MCP endpoint (#216): the endpoint's routes (`mcpRoutesAt`) behind a
// gate this file plays (Alice's principal, the org, the bindings with the browser's ControlPlane), on the fake
// provider's browsers (test/support/fake-sessions.ts). A 2026-07-28 client that takes URL elicitation is asked to
// open the session's page in the panel (an `InputRequiredResult`), and its retry with the person's decline declines the
// handoff; a 2025 client gets the page's link in words; the call that started a handoff is a successful call in its
// usage record. The Live View route answers `Cache-Control: no-store` with its link.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal, type AccessIdentity } from "@commissary/auth";
import { BillingEnv } from "@commissary/billing/api";
import { CurrentOrg, type OrgId } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { ToolsEnv } from "../src/env.ts";
import { browserSessionHandlers } from "../src/management/browser-session-routes.ts";
import { mcpRoutesAt } from "../src/mcp/endpoint.ts";
import { fakeBrowsers } from "./support/fake-sessions.ts";
import { migrateUsageDb } from "./support/usage-db.ts";

const REASON = "Sign in to example.com, then click Done.";

const EMAIL = "alice@example.com";

const ALICE: Omit<AccessIdentity, "org"> = {
  principal: { kind: "user", email: EMAIL, sub: "alice" },
  principalId: `user:${EMAIL}`,
  callerScope: "scope-alice",
  platformAdmin: false,
  role: "member",
  memberId: "m-alice",
};

/** The endpoint, and the Live View route as the management API mounts it (refusals are other tests'). */
const web = HttpRouter.toWebHandler(
  Layer.mergeAll(
    mcpRoutesAt("/mcp"),
    HttpRouter.add(
      "POST",
      "/browser-sessions/:id/live-view",
      browserSessionHandlers((result) =>
        result.ok ? Effect.succeed(result.value) : Effect.die(new Error(result.message)),
      ).liveView,
    ),
  ),
  { disableLogger: true },
);

beforeAll(async () => {
  await migrateUsageDb();
});

/** An org in the Platform registry (its page links name its slug) whose browser toolkit everyone may use. */
const org = async () => {
  const slug = `handoff-${crypto.randomUUID().slice(0, 8)}`;
  const created = await platformOf(env).createOrg({ slug, name: slug });

  if (!created.ok) throw new Error(created.message);
  const id = created.org.id;

  const written = await env.BROWSER_CONTROL_PLANE.getByName(id)
    .tools()
    .writeGrant(
      {
        revision: 0,
        value: { subject: { kind: "everyone" }, toolkit: "browser", tools: { kind: "all" } },
      },
      "test",
    );

  if (!written.ok) throw new Error(written.message);

  return { id, slug };
};

/** One request to the routes as Alice, in the org `id`. */
const fetchAs = async (id: OrgId, path: string, init: RequestInit) => {
  const context = Context.make(AccessPrincipal, { ...ALICE, org: id }).pipe(
    Context.add(ToolsEnv, { ...env, CONTROL_PLANE: env.BROWSER_CONTROL_PLANE }),
    // The endpoint words a plan's refusal with it (#241); this org has no plans.
    Context.add(BillingEnv, env),
    Context.add(CurrentOrg, id),
  );

  return await web.handler(new Request(`https://api.example.com${path}`, init), context);
};

/** One JSON-RPC request to the endpoint, and its answer's `result`. */
const rpc = async (
  id: OrgId,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> => {
  const response = await fetchAs(id, "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(200);

  // SAFETY: the endpoint answers JSON-RPC; a test's answer without a result fails below.
  const result = ((await response.json()) as { result?: Record<string, unknown> }).result;

  if (result === undefined) throw new Error("no result");

  return result;
};

/** A `tools/call` of the stateless revision (2026-07-28), from a client with `capabilities`. */
const modernCall = (
  id: OrgId,
  name: string,
  args: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  more: Record<string, unknown> = {},
) =>
  rpc(
    id,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        ...more,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": capabilities,
        },
      },
    },
    { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
  );

/** A `tools/call` of the 2025 handshake's era. */
const legacyCall = (id: OrgId, name: string, args: Record<string, unknown>) =>
  rpc(
    id,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { "mcp-protocol-version": "2025-11-25" },
  );

const textOf = (result: Record<string, unknown>): string =>
  // SAFETY: a tool result's contents are text here.
  (result["content"] as ReadonlyArray<{ readonly text?: string }>)
    .map((content) => content.text ?? "")
    .join("\n");

/** Alice opens a session at the fake web's sign-in page. */
const openSession = async (id: OrgId) => {
  const opened = textOf(await legacyCall(id, "browser_open", { url: "https://example.com/login" }));

  const session = /Browser session (bs_[0-9a-f]{32}) is open/.exec(opened)?.[1];

  if (session === undefined) throw new Error(`no session opened: ${opened}`);

  return { session, browser: fakeBrowsers.opened.at(-1) ?? "" };
};

describe("browser_ask_human through the MCP endpoint", () => {
  it("asks a client that takes URL elicitation to open the session's page, and declines the handoff on its decline", async () => {
    const { id, slug } = await org();
    const { session, browser } = await openSession(id);
    const url = { elicitation: { url: {} } };

    const asked = await modernCall(
      id,
      "browser_ask_human",
      { sessionId: session, reason: REASON },
      url,
    );

    expect(asked).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        handoff: {
          method: "elicitation/create",
          params: {
            mode: "url",
            url: `https://app.example.com/o/${slug}/tools/sessions/${session}`,
            message: expect.stringContaining(REASON),
          },
        },
      },
    });
    expect(JSON.stringify(asked)).not.toContain("live.browser.run");
    expect(fakeBrowsers.handoff(browser)).toBeDefined();

    const declined = await modernCall(
      id,
      "browser_ask_human",
      { sessionId: session, reason: REASON },
      url,
      { inputResponses: { handoff: { action: "decline" } } },
    );

    expect(declined).toMatchObject({
      resultType: "complete",
      structuredContent: { outcome: "declined" },
    });
    expect(fakeBrowsers.handoff(browser)).toBeUndefined();

    // The call that started the handoff, and the one the decline answered, are successful calls in their records.
    const records = await env.USAGE.prepare(
      "SELECT tool_id, tool_outcome FROM usage_records WHERE org_id = ? AND tool_id = ?",
    )
      .bind(id, "browser:ask_human")
      .all<{ tool_id: string; tool_outcome: string }>();

    expect(records.results.map((record) => record.tool_outcome)).toEqual(["success", "success"]);
  });

  it("gives a 2025 client the session page's link in words", async () => {
    const { id, slug } = await org();
    const { session } = await openSession(id);

    const asked = await legacyCall(id, "browser_ask_human", { sessionId: session, reason: REASON });

    expect(asked["isError"]).toBe(false);
    expect(textOf(asked)).toContain(
      `open its page at https://app.example.com/o/${slug}/tools/sessions/${session}`,
    );
  });
});

describe("the Live View route", () => {
  it("answers its link with Cache-Control: no-store", async () => {
    const { id } = await org();
    const { session } = await openSession(id);

    const response = await fetchAs(id, `/browser-sessions/${session}/live-view`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      url: expect.stringMatching(/^https:\/\/live\.browser\.run\//),
    });
  });
});

// Approvals of tool calls (#201, ADR 0038) through the API Worker's `/mcp`: a caller who is their call's approver, on a
// 2026-07-28 client that declares form elicitation, approves or denies on a form and the call finishes in the same call
// (made again with the answer); every other call that waits answers pending, with the link to its approval page in the
// panel, and the identical call goes through once after an approver approves it. Each call that ends leaves a usage
// record with its approval's outcome and none of its arguments. Orgs, members, keys, toolkits, rules and decisions are
// set up straight through the state Worker's objects (the panel's routes are the app Worker's).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { newOrgId, type OrgId } from "@commissary/core";
import { resetUsageDb } from "@commissary/models/testing";
import { platformOf } from "@commissary/state";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import worker from "../src/index.ts";
import { addMember, issueKey, type TestMember } from "./support/client.ts";

serveFakeMcpServers();

beforeAll(async () => {
  await resetUsageDb();
});

const POLICY = { ownHosts: [], localDevelopment: false };

/** The hosts of a stage with an API host of its own: links point to the app host. */
const APP_HOST = { APP_DOMAIN: "app.example.com", API_DOMAIN: "localhost" };

const viewer = (member: TestMember, admin = false) => ({ member: member.id, admin });

const toolsOf = (org: OrgId) => env.CONTROL_PLANE.getByName(org).tools();

/** A toolkit's approval rules as the Tools part takes them. */
type ApprovalRules = NonNullable<
  Parameters<ReturnType<typeof toolsOf>["updateToolkit"]>[3]["approval_rules"]
>;

/**
 * An org of its own with an admin, alice and bob, and the org toolkit `kit` (its shared credential everyone's) whose
 * calls echo their arguments, under `rules`.
 */
const kitOrg = async (prefix: string, rules: (staff: { bob: TestMember }) => ApprovalRules) => {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const org = newOrgId();
  const created = await platformOf(env).createOrg({ slug, name: slug, id: org }, Date.now());

  if (!created.ok) throw new Error(created.message);

  const admin = await addMember(org, `admin-${slug}@example.com`, "admin");
  const alice = await addMember(org, `alice-${slug}@example.com`, "member");
  const bob = await addMember(org, `bob-${slug}@example.com`, "member");

  const server = fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
    tools: [{ name: "write" }],
    call: (name, args) => ({
      content: [{ type: "text", text: `${name} ${JSON.stringify(args ?? {})}` }],
    }),
  });

  const added = await toolsOf(org).addToolkit(
    viewer(admin, true),
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

  const updated = await toolsOf(org).updateToolkit(
    viewer(admin, true),
    added.value.id,
    added.value.revision,
    { approval_rules: rules({ bob }) },
    "test",
  );

  if (!updated.ok) throw new Error(updated.message);

  return { org, slug, admin, alice, bob, server, toolkit: added.value.id };
};

/** A client of `/mcp` with an API key of `member`; each call waits for what the Worker wrote off the response path. */
const clientOf = async (org: OrgId, member: TestMember) => {
  const { key } = await issueKey(org, member);

  return async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const ctx = createExecutionContext();

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    });

    // SAFETY: the default export reads no `cf` property of the request; workerd's own requests carry them.
    const incoming = request as Request<unknown, IncomingRequestCfProperties>;
    const response = await worker.fetch(incoming, { ...env, ...APP_HOST }, ctx);
    const answer: Record<string, unknown> = await response.json();

    await waitOnExecutionContext(ctx);

    if (answer["error"] !== undefined) throw new Error(JSON.stringify(answer["error"]));

    // SAFETY: read from a test's answer; a call answers a result or an error.
    return answer["result"] as Record<string, unknown>;
  };
};

/** A `tools/call` of the stateless revision whose client declares `capabilities`, with `extra` params. */
const modernCall = (
  name: string,
  args: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  body: {
    method: "tools/call",
    params: {
      name,
      arguments: args,
      ...extra,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": capabilities,
      },
    },
  },
  headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
});

/** A 2025 client's `tools/call`. */
const legacyCall = (name: string, args: Record<string, unknown>) => ({
  method: "tools/call",
  params: { name, arguments: args },
});

const textOf = (result: Record<string, unknown>): string =>
  // SAFETY: a tool result's content, as the endpoint answers it.
  ((result["content"] as ReadonlyArray<{ readonly text?: string }> | undefined) ?? [])
    .map((part) => part.text ?? "")
    .join("");

const upstreamCalls = (server: { requests: ReadonlyArray<{ rpc?: string }> }) =>
  server.requests.filter((request) => request.rpc === "tools/call").length;

/** The org's tool calls' records, oldest first. */
const records = async (org: OrgId) =>
  (
    await env.USAGE.prepare(
      `SELECT * FROM usage_records WHERE org_id = ? AND area = 'tools' ORDER BY requested_at, rowid`,
    )
      .bind(org)
      .all<Record<string, unknown>>()
  ).results;

const outcomes = async (org: OrgId) =>
  (await records(org)).map((row) => [row["tool_outcome"], row["approval"]]);

describe("a caller who approves their own call on a form", () => {
  it("is asked with the tool and its arguments, and the call made again with an accept finishes", async () => {
    const { org, alice, server } = await kitOrg("form-approve", () => ({ writes: {} }));
    const send = await clientOf(org, alice);
    const marker = `marker-${crypto.randomUUID()}`;
    const form = { elicitation: {} };
    const first = modernCall("kit_write", { note: marker }, form);

    const asked = await send(first.body, first.headers);

    expect(asked).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: expect.stringContaining("kit_write"),
            requestedSchema: { type: "object", properties: {} },
          },
        },
      },
      requestState: expect.any(String),
    });
    expect(JSON.stringify(asked)).toContain(marker);
    expect(upstreamCalls(server)).toBe(0);
    // Nothing is recorded until the call ends.
    expect(await records(org)).toEqual([]);

    // The answer goes back with the form's state, as MRTR asks.
    const again = modernCall("kit_write", { note: marker }, form, {
      inputResponses: { approval: { action: "accept", content: {} } },
      requestState: asked["requestState"],
    });

    const done = await send(again.body, again.headers);

    expect(done).toMatchObject({ resultType: "complete" });
    expect(textOf(done)).toBe(`write {"note":"${marker}"}`);
    expect(upstreamCalls(server)).toBe(1);
    expect(await outcomes(org)).toEqual([["success", "approved_elicitation"]]);
    expect(JSON.stringify(await records(org))).not.toContain(marker);
  });

  it("answers a tool error when they deny it, and calls nothing", async () => {
    const { org, alice, server } = await kitOrg("form-deny", () => ({ writes: {} }));
    const send = await clientOf(org, alice);
    const form = { elicitation: { form: {} } };
    const first = modernCall("kit_write", { n: 1 }, form);
    const asked = await send(first.body, first.headers);

    const denied = modernCall("kit_write", { n: 1 }, form, {
      inputResponses: { approval: { action: "decline" } },
      requestState: asked["requestState"],
    });

    const answer = await send(denied.body, denied.headers);

    expect(answer).toMatchObject({ resultType: "complete", isError: true });
    expect(textOf(answer)).toContain("denied");
    expect(upstreamCalls(server)).toBe(0);
    expect(await outcomes(org)).toEqual([["not_approved", "denied"]]);
  });

  it("asks again on an answer without the form's state, or with other arguments, and calls nothing", async () => {
    const { org, alice, server } = await kitOrg("form-unasked", () => ({ writes: {} }));
    const send = await clientOf(org, alice);
    const form = { elicitation: {} };
    const accept = { approval: { action: "accept", content: {} } };

    const unasked = modernCall("kit_write", { n: 1 }, form, { inputResponses: accept });

    expect(await send(unasked.body, unasked.headers)).toMatchObject({
      resultType: "input_required",
    });

    const first = modernCall("kit_write", { n: 1 }, form);
    const asked = await send(first.body, first.headers);

    const other = modernCall("kit_write", { n: 2 }, form, {
      inputResponses: accept,
      requestState: asked["requestState"],
    });

    expect(await send(other.body, other.headers)).toMatchObject({
      resultType: "input_required",
      inputRequests: { approval: { params: { message: expect.stringContaining('"n": 2') } } },
    });
    expect(upstreamCalls(server)).toBe(0);
    expect(await records(org)).toEqual([]);
  });
});

describe("a call that waits for an approver in the panel", () => {
  it("answers pending with its approval page's link, and its identical repeat goes through once after approval", async () => {
    const { org, slug, alice, bob, server } = await kitOrg("panel", ({ bob }) => ({
      writes: { approver: { kind: "members", ids: [bob.id] } },
    }));

    const send = await clientOf(org, alice);
    const marker = `marker-${crypto.randomUUID()}`;
    // A form-capable client: the approver is not the caller, so the call waits all the same.
    const call = modernCall("kit_write", { note: marker }, { elicitation: {} });

    const pending = await send(call.body, call.headers);
    const [approval] = (await toolsOf(org).listApprovals(viewer(bob))).approvals;
    const link = `https://app.example.com/o/${slug}/approvals/${approval?.id}`;

    // Not an error: the call is not refused, it waits.
    expect(pending).toMatchObject({ resultType: "complete", isError: false });
    expect(textOf(pending)).toContain(link);
    expect(approval?.arguments).toEqual({ note: marker });

    const decided = await toolsOf(org).decideApproval(
      viewer(bob),
      approval?.id ?? "",
      "approve",
      "test",
    );

    expect(decided.ok).toBe(true);
    expect(textOf(await send(call.body, call.headers))).toBe(`write {"note":"${marker}"}`);
    expect(textOf(await send(call.body, call.headers))).toContain("/approvals/");
    expect(upstreamCalls(server)).toBe(1);

    expect(await outcomes(org)).toEqual([
      ["approval_pending", "pending"],
      ["success", "approved_panel"],
      ["approval_pending", "pending"],
    ]);
    // Usage records never hold the arguments.
    expect(JSON.stringify(await records(org))).not.toContain(marker);
  });

  it("is a 2025 client's path when the caller is the approver, and a client's without form elicitation", async () => {
    const { org, slug, alice, server } = await kitOrg("legacy", () => ({ writes: {} }));
    const send = await clientOf(org, alice);
    const legacy = await send(legacyCall("kit_write", { n: 1 }));

    expect(legacy["isError"]).toBe(false);
    expect(textOf(legacy)).toContain(`https://app.example.com/o/${slug}/approvals/`);

    const urlOnly = modernCall("kit_write", { n: 2 }, { elicitation: { url: {} } });
    const modern = await send(urlOnly.body, urlOnly.headers);

    expect(modern).toMatchObject({ resultType: "complete", isError: false });
    expect(textOf(modern)).toContain(`https://app.example.com/o/${slug}/approvals/`);

    // The caller approves their own in the panel; the 2025 client's repeat goes through.
    const [own] = (await toolsOf(org).listApprovals(viewer(alice))).approvals.filter(
      (approval) => approval.arguments?.["n"] === 1,
    );

    expect(own?.can_decide).toBe(true);
    await toolsOf(org).decideApproval(viewer(alice), own?.id ?? "", "approve", "test");
    expect(textOf(await send(legacyCall("kit_write", { n: 1 })))).toBe(`write {"n":1}`);
    expect(upstreamCalls(server)).toBe(1);
  });
});

describe("a call no rule holds", () => {
  it("records that no approval applied", async () => {
    const { org, alice } = await kitOrg("none", () => ({ tools: [] }));
    const send = await clientOf(org, alice);

    await send(legacyCall("kit_write", {}));

    expect(await outcomes(org)).toEqual([["success", "none"]]);
  });
});

// Hosted agents' webhook triggers (#231, ADR 0040) on the API Worker: `POST /agent-webhooks/<org>/<trigger>` through the
// production Worker's `exports.default.fetch`, with no API key. A delivery proven by the trigger's secret (as a bearer,
// or as an HMAC-SHA256 signature of its delivery id, timestamp and body) starts a run whose first turn is the trigger's template
// filled with the body, and answers 202 with the run's id; a delivery id sent again finds that run; anything unproven
// (a stale signature replayed with a fresh delivery id, another org's trigger or secret among them) answers the same
// 401. The signatures' tolerance and the keys of deliveries without an id are tested with `TestClock` in Agents' own
// tests (packages/agents/test/triggers.test.ts). The org (in the Platform registry), its member, the agent and its trigger are set up straight through the state
// Worker's objects (the management routes are the app Worker's); the run is the API Worker's own `AgentRun`, whose first
// turn the test reads.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentBody } from "@commissary/agents/testing";
import { Schema } from "effect";
import { type CreateTrigger, WebhookDelivered } from "@commissary/contract/agent-triggers";
import { newOrgId, type OrgId } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { addMember, type TestMember } from "./support/client.ts";

const LOCAL = "http://localhost";

/** A new org with a member, private agents on, whose private agent `triage` has the webhook `input`. */
const hookedOrg = async (input: CreateTrigger = TEMPLATED) => {
  const org = newOrgId();
  const plane = env.CONTROL_PLANE.getByName(org);
  const listed = await platformOf(env).createOrg({ slug: org, name: org, id: org }, Date.now());

  if (!listed.ok) throw new Error(listed.message);

  await plane.setMembershipSettings({ privateAgents: true });
  const alice = await addMember(org, `alice-${org}@example.com`, "member");
  const viewer = { member: alice.id, admin: false };

  const agent = await plane
    .agents()
    .createAgent(viewer, agentBody("triage", "agent-model"), { modelServed: true }, "test");

  if (!agent.ok) throw new Error(agent.message);

  const hook = await plane
    .agents()
    .createTrigger({ viewer, agentId: agent.value.id, origin: LOCAL, by: "test" }, input);

  if (!hook.ok || hook.value.secret === undefined) throw new Error("no webhook");

  return {
    org,
    alice,
    viewer,
    agent: agent.value,
    hook: hook.value,
    secret: hook.value.secret,
    path: `/agent-webhooks/${org}/${hook.value.id}`,
  };
};

const TEMPLATED: CreateTrigger = {
  kind: "webhook",
  name: "Issues",
  input: "Triage this issue: {{body}}",
};

const deliver = async (path: string, body: string | Uint8Array, headers: Record<string, string>) =>
  await exports.default.fetch(
    new Request(`${LOCAL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );

/**
 * A delivery's signature headers: its id `delivery` (a fresh one by default), and an HMAC-SHA256 of
 * `<delivery>.<timestamp>.<body>` under `secret`, signed at `at` (epoch ms).
 */
const signed = async (
  secret: string,
  body: string,
  at = Date.now(),
  delivery: string = crypto.randomUUID(),
) => {
  const timestamp = String(Math.floor(at / 1000));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${delivery}.${timestamp}.${body}`),
    ),
  );

  return {
    "x-commissary-delivery": delivery,
    "x-commissary-timestamp": timestamp,
    "x-commissary-signature": `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  };
};

const decodeDelivered = Schema.decodeUnknownSync(WebhookDelivered);

/** The run id a 202 answered. */
const runOf = async (response: Response): Promise<string> => {
  expect(response.status, await response.clone().text()).toBe(202);

  return decodeDelivered(await response.json()).run;
};

/** The input of the run's first turn, as its object holds it. */
const firstInput = async (org: OrgId, run: string): Promise<string | undefined> => {
  const shown = await env.AGENT_RUN.getByName(`${org}:${run}`).show();

  return shown.ok ? shown.value.turns[0]?.input : undefined;
};

const runsOf = async (org: OrgId, member: TestMember) =>
  (await env.CONTROL_PLANE.getByName(org).agents().listRuns({ member: member.id, admin: false }))
    .runs;

describe("a webhook delivery", () => {
  it("proven by bearer or signature starts a run with the body in its template; anything else answers 401", async () => {
    const { org, alice, hook, secret, path } = await hookedOrg();
    const body = '{"title":"login is broken"}';

    const byBearer = await runOf(
      await deliver(path, body, {
        authorization: `Bearer ${secret}`,
        "x-commissary-delivery": "delivery-1",
      }),
    );

    expect(await firstInput(org, byBearer)).toBe(`Triage this issue: ${body}`);

    const bySignature = await runOf(
      await deliver(path, body, await signed(secret, body, Date.now(), "delivery-2")),
    );

    expect(bySignature).not.toBe(byBearer);
    expect(await runsOf(org, alice)).toMatchObject([
      { trigger: "webhook", trigger_id: hook.id, starter: { kind: "member", id: alice.id } },
      { trigger: "webhook", trigger_id: hook.id },
    ]);

    // The signed delivery sent again, as a sender's retry or a replay within its five minutes: the same run. Replayed
    // under a fresh delivery id, it no longer proves itself (the id is signed).
    const captured = await signed(secret, body, Date.now(), "delivery-2");

    expect(await runOf(await deliver(path, body, captured))).toBe(bySignature);

    const { "x-commissary-delivery": _signedId, ...withoutId } = captured;

    // A wrong secret, a wrong signature, a signature of another body, a replay under a fresh delivery id or none, a
    // captured signature replayed after its five minutes, an unknown trigger or org: the same 401.
    const refusals = [
      await deliver(path, body, { authorization: `Bearer ${secret}-not` }),
      await deliver(path, body, await signed("whsec_x", body)),
      await deliver(path, body, await signed(secret, "{}")),
      await deliver(path, body, { ...captured, "x-commissary-delivery": "delivery-3" }),
      await deliver(path, body, withoutId),
      await deliver(path, body, await signed(secret, body, Date.now() - 6 * 60_000)),
      await deliver(path, body, {}),
      await deliver(`/agent-webhooks/${org}/trg_${"0".repeat(32)}`, body, {
        authorization: `Bearer ${secret}`,
      }),
      await deliver(`/agent-webhooks/${newOrgId()}/${hook.id}`, body, {
        authorization: `Bearer ${secret}`,
      }),
      await deliver(`/agent-webhooks/NOT_AN_ORG/${hook.id}`, body, {
        authorization: `Bearer ${secret}`,
      }),
    ];

    expect(refusals.map((response) => response.status)).toEqual(
      Array.from({ length: 10 }, () => 401),
    );
    expect(new Set(await Promise.all(refusals.map((response) => response.text()))).size).toBe(1);
    expect(await runsOf(org, alice)).toHaveLength(2);
  });

  it("with a delivery id sent twice starts one run, and over 1 MiB is refused", async () => {
    const { org, alice, secret, path } = await hookedOrg({ kind: "webhook", name: "Raw" });
    const auth = { authorization: `Bearer ${secret}` };

    const first = await runOf(
      await deliver(path, "one", { ...auth, "x-commissary-delivery": "d" }),
    );

    const again = await runOf(
      await deliver(path, "one", { ...auth, "x-commissary-delivery": "d" }),
    );

    expect(again).toBe(first);
    // Without a template, the body alone.
    expect(await firstInput(org, first)).toBe("one");

    // Standard Webhooks' id names the delivery too.
    const standard = await runOf(await deliver(path, "two", { ...auth, "webhook-id": "msg_1" }));

    expect(await runOf(await deliver(path, "two", { ...auth, "webhook-id": "msg_1" }))).toBe(
      standard,
    );
    expect(await runsOf(org, alice)).toHaveLength(2);

    const large = await deliver(path, new Uint8Array(1024 * 1024 + 1).fill(97), auth);

    expect(large.status).toBe(413);
    expect(await runsOf(org, alice)).toHaveLength(2);
  });

  it("names one org's trigger: another org's address, trigger or secret proves nothing", async () => {
    const one = await hookedOrg();
    const other = await hookedOrg();
    const body = '{"title":"cross"}';

    const refusals = [
      // One org's trigger and secret at the other's address.
      await deliver(`/agent-webhooks/${other.org}/${one.hook.id}`, body, {
        authorization: `Bearer ${one.secret}`,
      }),
      await deliver(
        `/agent-webhooks/${other.org}/${one.hook.id}`,
        body,
        await signed(one.secret, body),
      ),
      // The other org's own trigger with the first org's secret.
      await deliver(other.path, body, { authorization: `Bearer ${one.secret}` }),
      await deliver(other.path, body, await signed(one.secret, body)),
    ];

    expect(refusals.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    expect(await runsOf(one.org, one.alice)).toEqual([]);
    expect(await runsOf(other.org, other.alice)).toEqual([]);

    // Each still takes its own.
    await runOf(await deliver(other.path, body, { authorization: `Bearer ${other.secret}` }));
    expect(await runsOf(other.org, other.alice)).toHaveLength(1);
    expect(await runsOf(one.org, one.alice)).toEqual([]);
  });

  it("to a disabled agent's webhook starts nothing", async () => {
    const { org, alice, viewer, agent, secret, path } = await hookedOrg();

    await env.CONTROL_PLANE.getByName(org)
      .agents()
      .updateAgent(viewer, agent.id, agent.revision, { enabled: false }, {}, "test");

    const refused = await deliver(path, "{}", { authorization: `Bearer ${secret}` });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "agent_disabled" });
    expect(await runsOf(org, alice)).toEqual([]);
  });
});

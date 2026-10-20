// Triggers of hosted agents on the management API (#231, ADR 0040): a webhook's secret is shown once, when it is created
// and when it is rotated, and its URL is on the API host; a schedule's object (the API Worker's `AgentSchedule`, which
// this test Worker exports) is armed with its next tick when it is added or enabled, disarmed when it is disabled, and
// deleted with it, with its agent, with its member or with its org. Only the agent's manager reaches its triggers. The agents are created on the org's
// ControlPlane (the models they name are taken as served: a check of the agent routes', tested in agents.test.ts).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBody } from "@commissary/agents/testing";
import type { Json } from "@commissary/json";
import { resetUsageDb } from "@commissary/models/testing";
import { ADMIN, jsonInit, makeHarness, token } from "./support/management.ts";

/** A Platform registry of this file's own. */
const PLATFORM_NAME = `platform-${crypto.randomUUID()}`;

// SAFETY: only `getByName` is read from the binding (`platformOf`), and it answers with a real Platform stub.
const PLATFORM = {
  getByName: () => env.PLATFORM.getByName(PLATFORM_NAME),
} as unknown as Env["PLATFORM"];

const API_HOST = "api.commissary.test";

const harness = makeHarness(undefined, { PLATFORM, API_DOMAIN: API_HOST });

beforeAll(async () => {
  // The org's deletion deletes its usage records too.
  await resetUsageDb();
});

afterAll(harness.dispose);

interface Person {
  readonly id: string;
  readonly auth: string;
}

const send = async (
  slug: string,
  path: string,
  who: Person | string,
  method = "GET",
  body?: Json,
  revision?: number,
): Promise<{ status: number; body: unknown }> =>
  await harness.json(`/v9/management/orgs/${slug}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(revision === undefined ? {} : { "if-match": String(revision) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    auth: typeof who === "string" ? who : who.auth,
  });

const ok = <T>(reply: { status: number; body: unknown }, status = 200): T => {
  expect(reply.status, JSON.stringify(reply.body)).toBe(status);

  // SAFETY: a test's own reading of an answer whose shape the contract describes.
  return reply.body as T;
};

interface Trigger {
  readonly id: string;
  readonly revision: number;
  readonly secret?: string;
  readonly webhook?: { readonly url: string };
  readonly schedule?: { readonly next_at?: string };
}

/** An org with a plain member, alice, whose private agent the tests trigger. */
const newOrg = async () => {
  const slug = `triggers-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  expect(
    (
      await harness.json(
        "/v9/management/orgs",
        jsonInit("POST", { slug, name: slug, private_agents: true }),
      )
    ).status,
  ).toBe(201);

  const person = async (name: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;

    const added = ok<{ id: string }>(
      await send(slug, "/members", platform, "POST", { email, role: "member" }),
      201,
    );

    return { id: added.id, auth: await token(email) };
  };

  const found = await env.PLATFORM.getByName(PLATFORM_NAME).getOrgBySlug(slug);

  if (found === undefined) throw new Error("the org is not registered");
  const alice = await person("alice");

  const agent = await env.CONTROL_PLANE.getByName(found.id)
    .agents()
    .createAgent(
      { member: alice.id, admin: false },
      agentBody("reporter", "agent-model"),
      { modelServed: true },
      "test",
    );

  if (!agent.ok) throw new Error(agent.message);

  return { slug, id: found.id, alice, bob: await person("bob"), agent: agent.value.id };
};

/** The alarm of the schedule `trigger`'s object, `null` for none. */
const alarmOf = async (org: string, trigger: string) =>
  await runInDurableObject(env.AGENT_SCHEDULE.getByName(`${org}:${trigger}`), (_instance, state) =>
    state.storage.getAlarm(),
  );

const DAILY = {
  kind: "schedule",
  name: "Daily",
  input: "Summarise yesterday.",
  schedule: { cron: "0 9 * * *", time_zone: "UTC" },
};

describe("a webhook trigger", () => {
  it("shows its secret once, when it is created and rotated, with its URL on the API host", async () => {
    const org = await newOrg();
    const path = `/agents/${org.agent}/triggers`;

    const created = ok<Trigger>(
      await send(org.slug, path, org.alice, "POST", { kind: "webhook", name: "Issues" }),
      201,
    );

    expect(created.secret).toMatch(/^whsec_/);
    expect(created.webhook?.url).toBe(`https://${API_HOST}/agent-webhooks/${org.id}/${created.id}`);

    const listed = await send(org.slug, path, org.alice);

    expect(ok<{ triggers: ReadonlyArray<Trigger> }>(listed).triggers).toMatchObject([
      { id: created.id, kind: "webhook", webhook: { url: created.webhook?.url } },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(created.secret);

    const rotated = ok<Trigger>(
      await send(org.slug, `${path}/${created.id}/secret`, org.alice, "POST", undefined, 1),
    );

    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.revision).toBe(2);

    // Another member does not see the agent, nor its triggers.
    expect((await send(org.slug, path, org.bob)).status).toBe(404);
  });
});

describe("a schedule trigger", () => {
  it("arms its object when it is added or enabled, disarms it when disabled, and deletes it with itself", async () => {
    const org = await newOrg();
    const path = `/agents/${org.agent}/triggers`;
    const created = ok<Trigger>(await send(org.slug, path, org.alice, "POST", DAILY), 201);
    const next = created.schedule?.next_at;

    expect(next).toMatch(/T09:00:00\.000Z$/);
    expect(await alarmOf(org.id, created.id)).toBe(Date.parse(next ?? ""));

    ok(await send(org.slug, `${path}/${created.id}`, org.alice, "PATCH", { enabled: false }, 1));
    expect(await alarmOf(org.id, created.id)).toBeNull();

    ok(await send(org.slug, `${path}/${created.id}`, org.alice, "PATCH", { enabled: true }, 2));
    expect(await alarmOf(org.id, created.id)).toBe(Date.parse(next ?? ""));

    expect(
      await send(
        org.slug,
        `${path}/${created.id}`,
        org.alice,
        "PATCH",
        {
          schedule: { cron: "61 9 * * *", time_zone: "UTC" },
        },
        3,
      ),
    ).toMatchObject({ status: 422, body: { error: "invalid" } });

    ok(await send(org.slug, `${path}/${created.id}`, org.alice, "DELETE", undefined, 3));
    expect(await alarmOf(org.id, created.id)).toBeNull();
  });

  it("goes with its agent and with its member, its object included", async () => {
    const org = await newOrg();

    const created = ok<Trigger>(
      await send(org.slug, `/agents/${org.agent}/triggers`, org.alice, "POST", DAILY),
      201,
    );

    expect(await alarmOf(org.id, created.id)).not.toBeNull();
    ok(await send(org.slug, `/agents/${org.agent}`, org.alice, "DELETE", undefined, 1));
    expect(await alarmOf(org.id, created.id)).toBeNull();

    // Alice's next agent's schedule goes when she is removed from the org.
    const agent = await env.CONTROL_PLANE.getByName(org.id)
      .agents()
      .createAgent(
        { member: org.alice.id, admin: false },
        agentBody("reporter_two", "agent-model"),
        { modelServed: true },
        "test",
      );

    if (!agent.ok) throw new Error(agent.message);

    const another = ok<Trigger>(
      await send(org.slug, `/agents/${agent.value.id}/triggers`, org.alice, "POST", DAILY),
      201,
    );

    expect(await alarmOf(org.id, another.id)).not.toBeNull();
    ok(await send(org.slug, `/members/${org.alice.id}`, await token(ADMIN), "DELETE"));
    expect(await alarmOf(org.id, another.id)).toBeNull();
  });

  it("goes with its org, its object included", async () => {
    const org = await newOrg();
    const path = `/agents/${org.agent}/triggers`;
    const created = ok<Trigger>(await send(org.slug, path, org.alice, "POST", DAILY), 201);

    expect(await alarmOf(org.id, created.id)).not.toBeNull();
    expect(
      (await send(org.slug, "/org", await token(ADMIN), "DELETE", { name: org.slug })).status,
    ).toBe(200);
    expect(await alarmOf(org.id, created.id)).toBeNull();
  });
});

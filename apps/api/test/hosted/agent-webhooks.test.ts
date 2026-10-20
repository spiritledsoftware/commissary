// Hosted agents' webhook deliveries on Commissary Cloud (#231, #236). Every delivery to a known org, proven or not,
// counts against the org's webhook bucket before its ControlPlane checks the proof (the size of its ceiling: the test
// Worker allows 5 a minute on Free, vitest.config.ts), so a flood of unproven deliveries is refused there and never
// uses up the ceiling the org's API keys count against; a proven delivery also counts against that ceiling, as an API
// key's request does; one to an unknown org counts for none. The deliveries go to a disabled agent's webhook, which
// answers 409 and starts no run, so that no run's own requests count too.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { agentBody } from "@commissary/agents/testing";
import { RATE_LIMITED } from "@commissary/billing/api";
import { newOrgId } from "@commissary/core";
import { resetUsageDb } from "@commissary/models/testing";
import { call, keyedOrg, models, roomInWindow } from "./support.ts";

beforeAll(async () => {
  await resetUsageDb();
});

const FREE_LIMIT = 5;

/** A new org with an API key, whose disabled shared agent has a webhook: its delivery function and the key. */
const hookedOrg = async (email: string) => {
  const { org, member, key } = await keyedOrg(email);
  const agents = env.CONTROL_PLANE.getByName(org).agents();
  const admin = { member, admin: true };

  const agent = await agents.createAgent(
    admin,
    { ...agentBody("intake", "agent-model"), subject: { kind: "everyone" } },
    { modelServed: true },
    "test",
  );

  if (!agent.ok) throw new Error(agent.message);

  const hook = await agents.createTrigger(
    { viewer: admin, agentId: agent.value.id, origin: "https://commissary.test", by: "test" },
    { kind: "webhook", name: "Intake" },
  );

  if (!hook.ok || hook.value.secret === undefined) throw new Error("no webhook");
  await agents.updateAgent(admin, agent.value.id, 1, { enabled: false }, {}, "test");

  const deliver = (secret: string, to: string = org) =>
    call(`/agent-webhooks/${to}/${hook.value.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: "{}",
    });

  return { key, secret: hook.value.secret, deliver };
};

const expectLimited = async (response: Response) => {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(await response.json()).toEqual({ error: RATE_LIMITED });
};

describe("webhook deliveries on Commissary Cloud", () => {
  it("count before their proof on the org's webhook bucket, which leaves its API keys' ceiling alone", async () => {
    const { key, secret, deliver } = await hookedOrg("hooks@example.com");

    await roomInWindow();

    // Deliveries to an org that does not exist count for none.
    for (let sent = 0; sent < FREE_LIMIT + 1; sent += 1)
      expect((await deliver(secret, newOrgId())).status).toBe(401);

    // Unproven deliveries fill the webhook bucket; past it, proven ones are refused too, before any proof is checked.
    for (let sent = 0; sent < FREE_LIMIT; sent += 1)
      expect((await deliver("whsec_wrong")).status).toBe(401);

    await expectLimited(await deliver("whsec_wrong"));
    await expectLimited(await deliver(secret));

    // The org's API keys count against its ceiling, which the flood did not touch.
    expect((await models(key)).status).toBe(200);
  });

  it("count against the org's ceiling once proven, with its API keys' requests", async () => {
    const { key, secret, deliver } = await hookedOrg("proven-hooks@example.com");

    await roomInWindow();

    for (let sent = 0; sent < FREE_LIMIT - 1; sent += 1)
      expect((await deliver(secret)).status).toBe(409);

    // The ceiling's last place goes to the key; the next request of either is refused.
    expect((await models(key)).status).toBe(200);
    await expectLimited(await models(key));
  });
});

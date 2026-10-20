// `POST /webhooks/polar` (src/webhook.ts) through a router of its own with the test Worker's Polar settings
// (vitest.config.ts): webhooks signed the way Polar signs them (Standard Webhooks, here with node:crypto) move an org
// between Free and Pay as you go; anything unsigned or wrongly signed is refused, and a repeat changes nothing.
import { createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { Context } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";
import { newOrgId, type OrgId } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { type BillingBindings, BillingEnv } from "../src/api.ts";
import { BillingWebhookRoutes } from "../src/management.ts";
import { FREE_USAGE, seedRequestsUsed, TEST_POLAR } from "./testing.ts";

const { handler } = HttpRouter.toWebHandler(BillingWebhookRoutes, { disableLogger: true });

let delivery = 0;

/** A webhook of `type` about `org`'s subscription, signed with `secret` (the deployment's by default). */
const webhook = (
  type: string,
  org: string,
  fields: Record<string, unknown> = {},
  options: { readonly secret?: string; readonly signed?: boolean; readonly id?: string } = {},
) => {
  const body = JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    data: {
      id: "sub_1",
      status: "active",
      cancel_at_period_end: false,
      created_at: "2026-01-01T00:00:00Z",
      modified_at: new Date(Date.now() - 60_000).toISOString(),
      product_id: TEST_POLAR.productId,
      customer_id: "cus_1",
      customer: { id: "cus_1", external_id: org },
      ...fields,
    },
  });

  const id = options.id ?? `msg_${(delivery += 1)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));

  const signature = createHmac("sha256", options.secret ?? TEST_POLAR.webhookSecret)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  return {
    body,
    headers:
      options.signed === false
        ? {}
        : {
            "webhook-id": id,
            "webhook-timestamp": timestamp,
            "webhook-signature": `v1,${signature}`,
          },
  };
};

const deliver = async (
  sent: { readonly body: string; readonly headers: Record<string, string> },
  bindings: BillingBindings = env,
) =>
  await handler(
    new Request("https://app.example.com/webhooks/polar", {
      method: "POST",
      headers: { "content-type": "application/json", ...sent.headers },
      body: sent.body,
    }),
    Context.make(BillingEnv, bindings),
  );

const registeredOrg = async (): Promise<OrgId> => {
  const id = newOrgId();

  await platformOf(env).createOrg(
    { slug: `org-${crypto.randomUUID().slice(0, 8)}`, name: "Org", id },
    Date.now(),
  );

  return id;
};

const partOf = (org: OrgId) => env.CONTROL_PLANE.getByName(org).billing();

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("POST /webhooks/polar", () => {
  it("moves the org to Pay as you go on a verified subscription.active, and a repeat changes nothing", async () => {
    const org = await registeredOrg();
    const active = webhook("subscription.active", org, { modified_at: minutesAgo(5) });

    expect((await deliver(active)).status).toBe(200);
    expect(await partOf(org).plan()).toBe("payg");

    // Ended since; the same delivery again, and a late subscription.updated about the same moment.
    expect(
      (
        await deliver(
          webhook("subscription.revoked", org, { status: "canceled", modified_at: minutesAgo(1) }),
        )
      ).status,
    ).toBe(200);
    expect((await deliver(active)).status).toBe(200);
    expect(
      (await deliver(webhook("subscription.updated", org, { modified_at: minutesAgo(5) }))).status,
    ).toBe(200);
    expect(await partOf(org).plan()).toBe("free");
  });

  it("refuses an unsigned or wrongly signed webhook and changes nothing", async () => {
    const org = await registeredOrg();

    const unsigned = await deliver(webhook("subscription.active", org, {}, { signed: false }));
    const forged = await deliver(webhook("subscription.active", org, {}, { secret: "not-polar" }));

    expect([unsigned.status, forged.status]).toEqual([401, 401]);
    expect(await partOf(org).plan()).toBe("free");
  });

  it("holds a past-due org to Free's limits until a payment succeeds", async () => {
    const org = await registeredOrg();

    await deliver(webhook("subscription.active", org, { modified_at: minutesAgo(10) }));
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests);
    await deliver(
      webhook("subscription.past_due", org, { status: "past_due", modified_at: minutesAgo(5) }),
    );

    expect(await partOf(org).plan()).toBe("payg");
    expect((await partOf(org).admit(Date.now())).ok).toBe(false);

    await deliver(webhook("subscription.active", org, { modified_at: minutesAgo(1) }));

    expect((await partOf(org).admit(Date.now())).ok).toBe(true);
  });

  it("moves a revoked or cancelled org to Free and keeps its data", async () => {
    for (const [type, fields] of [
      ["subscription.revoked", { status: "canceled" }],
      ["subscription.canceled", { cancel_at_period_end: true }],
    ] as const) {
      const org = await registeredOrg();

      await deliver(webhook("subscription.active", org, { modified_at: minutesAgo(10) }));
      await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests + 3);
      await deliver(webhook(type, org, { ...fields, modified_at: minutesAgo(1) }));

      expect(await partOf(org).plan()).toBe("free");
      expect((await partOf(org).usage(Date.now())).used.requests).toBe(FREE_USAGE.requests + 3);
    }
  });

  it("acknowledges and ignores other events and orgs that do not exist", async () => {
    const ghost = newOrgId();

    expect((await deliver(webhook("subscription.active", ghost))).status).toBe(200);
    expect((await deliver(webhook("order.paid", ghost))).status).toBe(200);
    expect(await partOf(ghost).plan()).toBe("free");
  });

  it("does not exist without the webhook secret or on a self-hosted Commissary", async () => {
    const org = await registeredOrg();

    for (const bindings of [
      { ...env, POLAR_WEBHOOK_SECRET: undefined },
      { ...env, COMMISSARY_MODE: undefined },
    ])
      expect((await deliver(webhook("subscription.active", org), bindings)).status).toBe(404);

    expect(await partOf(org).plan()).toBe("free");
  });
});

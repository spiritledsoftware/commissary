// The Billing part of the ControlPlane (src/part.ts, src/store.ts) on real SQLite storage: the plan every org starts on,
// the counters per calendar month in UTC and the Free plan's stop (ADR 0042), through the RPC surface the Workers use.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newOrgId } from "@commissary/core";
import { tablesOf } from "@commissary/state/testing";
import { FREE_USAGE, seedRequestsUsed, setPlan } from "./testing.ts";

/** 2026-03-15T12:00:00Z. */
const MID_MARCH = Date.UTC(2026, 2, 15, 12);

const FIRST_OF_APRIL = Date.UTC(2026, 3, 1);

const billingOf = (org = newOrgId()) => ({ org, part: env.CONTROL_PLANE.getByName(org).billing() });

describe("the plan", () => {
  it("is Free for an org that never set one, with nothing used", async () => {
    const { part } = billingOf();

    expect(await part.plan()).toBe("free");

    const usage = await part.usage(MID_MARCH);

    expect(usage.plan).toBe("free");
    expect(usage.monthStart).toBe(Date.UTC(2026, 2, 1));
    expect(usage.monthEnd).toBe(FIRST_OF_APRIL);
    expect(usage.used).toEqual({ requests: 0, browserHours: 0, computerHours: 0 });
  });

  it("is stored per org", async () => {
    const paying = billingOf();
    const other = billingOf();

    await setPlan(env, paying.org, "payg");

    expect(await paying.part.plan()).toBe("payg");
    expect(await other.part.plan()).toBe("free");
  });
});

describe("free usage", () => {
  it("is 25,000 requests and tool calls, 1 browser hour and no computer hours a month", () => {
    expect(FREE_USAGE).toEqual({ requests: 25_000, browserHours: 1, computerHours: 0 });
  });

  it("counts each request that starts being served", async () => {
    const { part } = billingOf();

    for (let sent = 0; sent < 3; sent += 1) expect((await part.admit(MID_MARCH)).ok).toBe(true);

    expect((await part.usage(MID_MARCH)).used.requests).toBe(3);
  });

  it("starts each calendar month at zero without losing the last one", async () => {
    const { part } = billingOf();

    await part.admit(MID_MARCH);
    await part.admit(FIRST_OF_APRIL);

    expect((await part.usage(FIRST_OF_APRIL)).used.requests).toBe(1);
    expect((await part.usage(FIRST_OF_APRIL - 1)).used.requests).toBe(1);
    expect((await part.usage(MID_MARCH)).used.requests).toBe(1);
  });

  it("refuses a Free org's request past 25,000 until the first of the next month UTC, without counting it", async () => {
    const { org, part } = billingOf();

    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests - 1);

    expect((await part.admit(MID_MARCH)).ok).toBe(true);

    const refused = await part.admit(MID_MARCH);

    expect(refused.ok).toBe(false);

    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.limit).toEqual({
      limit: "requests",
      allowed: 25_000,
      resetsAt: FIRST_OF_APRIL,
      retryAfterSeconds: (FIRST_OF_APRIL - MID_MARCH) / 1000,
      pastDue: false,
    });
    expect((await part.usage(MID_MARCH)).used.requests).toBe(25_000);

    // On the first of the month it is served again.
    expect((await part.admit(FIRST_OF_APRIL - 1)).ok).toBe(false);
    expect((await part.admit(FIRST_OF_APRIL)).ok).toBe(true);
  });

  it("stops a Free org one second before the month ends with a Retry-After of one second", async () => {
    const { org, part } = billingOf();

    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests);

    const refused = await part.admit(FIRST_OF_APRIL - 1);

    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.limit.retryAfterSeconds).toBe(1);
  });

  it("does not stop a Pay as you go org at its free usage, and keeps counting", async () => {
    const { org, part } = billingOf();

    await setPlan(env, org, "payg");
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests);

    expect((await part.admit(MID_MARCH)).ok).toBe(true);
    expect((await part.usage(MID_MARCH)).used.requests).toBe(25_001);
  });

  it("stops an org that goes back to Free over its free usage", async () => {
    const { org, part } = billingOf();

    await setPlan(env, org, "payg");
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 10);
    await setPlan(env, org, "free");

    expect((await part.admit(MID_MARCH)).ok).toBe(false);
  });

  it("takes back a counted request, never below zero", async () => {
    const { part } = billingOf();

    const admitted = await part.admit(MID_MARCH);

    if (!admitted.ok) throw new Error("expected the request to be counted");
    await part.refund(admitted.monthStart);
    expect((await part.usage(MID_MARCH)).used.requests).toBe(0);

    await part.refund(admitted.monthStart);
    expect((await part.usage(MID_MARCH)).used.requests).toBe(0);
  });
});

/** Requests and tool calls above free usage that Pay as you go bills $50 for ($0.50 per 100,000). */
const FIFTY_DOLLARS_OF_REQUESTS = 10_000_000;

describe("the billing cap", () => {
  it("is $50 for a new org, and refuses the next billed request once the month's bill reaches it", async () => {
    const { org, part } = billingOf();

    await setPlan(env, org, "payg");
    await seedRequestsUsed(
      env,
      org,
      MID_MARCH,
      FREE_USAGE.requests + FIFTY_DOLLARS_OF_REQUESTS - 1,
    );

    const before = await part.usage(MID_MARCH);

    expect(before.billingCap).toBe(50);
    expect(before.bill).toBeCloseTo(49.999_995, 9);

    // The request that brings the bill to $50 is served; the next one would bill past the cap.
    expect((await part.admit(MID_MARCH)).ok).toBe(true);
    expect((await part.usage(MID_MARCH)).bill).toBe(50);

    const refused = await part.admit(MID_MARCH);

    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.limit).toEqual({
      limit: "billing_cap",
      allowed: 50,
      resetsAt: FIRST_OF_APRIL,
      retryAfterSeconds: (FIRST_OF_APRIL - MID_MARCH) / 1000,
      pastDue: false,
    });
    // The refusal counted nothing, and the next month starts over.
    expect((await part.usage(MID_MARCH)).used.requests).toBe(
      FREE_USAGE.requests + FIFTY_DOLLARS_OF_REQUESTS,
    );
    expect((await part.admit(FIRST_OF_APRIL)).ok).toBe(true);
  });

  it("never refuses use within free usage, even at a cap of $0", async () => {
    const { org, part } = billingOf();

    await setPlan(env, org, "payg");
    await part.setBillingCap(0);
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests - 1);

    expect((await part.admit(MID_MARCH)).ok).toBe(true);
    expect((await part.admit(MID_MARCH)).ok).toBe(false);
  });

  it("takes effect at once when an owner raises or removes it", async () => {
    const { org, part } = billingOf();

    await setPlan(env, org, "payg");
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + FIFTY_DOLLARS_OF_REQUESTS);
    expect((await part.admit(MID_MARCH)).ok).toBe(false);

    await part.setBillingCap(50.5);
    expect((await part.usage(MID_MARCH)).billingCap).toBe(50.5);
    expect((await part.admit(MID_MARCH)).ok).toBe(true);

    await part.setBillingCap(null);
    expect((await part.usage(MID_MARCH)).billingCap).toBeNull();
    await seedRequestsUsed(
      env,
      org,
      MID_MARCH,
      FREE_USAGE.requests + 10 * FIFTY_DOLLARS_OF_REQUESTS,
    );
    expect((await part.admit(MID_MARCH)).ok).toBe(true);
  });

  it("does not apply on Free, where free usage is the limit", async () => {
    const { org, part } = billingOf();

    await part.setBillingCap(0);
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests);

    const refused = await part.admit(MID_MARCH);

    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.limit.limit).toBe("requests");
  });
});

/** A change of the org's Polar subscription, as a webhook reports it. */
const change = (
  status: "active" | "past_due" | "ended",
  changedAt: number,
  subscriptionId = "sub_1",
) => ({ status, subscriptionId, customerId: "cus_1", changedAt });

describe("the Polar subscription", () => {
  it("moves the org to Pay as you go when it becomes active, and a repeat changes nothing", async () => {
    const { part } = billingOf();

    expect(await part.applySubscription(change("active", MID_MARCH))).toBe(true);
    expect(await part.plan()).toBe("payg");
    expect((await part.usage(MID_MARCH)).payment).toBe("ok");
    expect((await part.usage(MID_MARCH)).customerId).toBe("cus_1");

    expect(await part.applySubscription(change("active", MID_MARCH))).toBe(false);
    expect(await part.plan()).toBe("payg");
  });

  it("holds a past-due org to Free's limits until a payment succeeds", async () => {
    const { org, part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests);
    expect((await part.admit(MID_MARCH)).ok).toBe(true);

    expect(await part.applySubscription(change("past_due", MID_MARCH + 1))).toBe(true);
    expect(await part.plan()).toBe("payg");
    expect(await part.limitsPlan()).toBe("free");
    expect((await part.usage(MID_MARCH)).payment).toBe("past_due");
    expect((await part.admit(MID_MARCH)).ok).toBe(false);

    expect(await part.applySubscription(change("active", MID_MARCH + 2))).toBe(true);
    expect(await part.limitsPlan()).toBe("payg");
    expect((await part.usage(MID_MARCH)).payment).toBe("ok");
    expect((await part.admit(MID_MARCH)).ok).toBe(true);
  });

  it("moves the org to Free when it ends, keeping what it used", async () => {
    const { org, part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 5);

    expect(await part.applySubscription(change("ended", MID_MARCH + 1))).toBe(true);
    expect(await part.plan()).toBe("free");
    expect((await part.usage(MID_MARCH)).used.requests).toBe(FREE_USAGE.requests + 5);
    // The customer stays: the usage it still owes is sent.
    expect((await part.usage(MID_MARCH)).customerId).toBe("cus_1");
  });

  it("ignores a change older than the last one, and the end of a subscription it no longer has", async () => {
    const { part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH, "sub_old"));
    await part.applySubscription(change("ended", MID_MARCH + 10, "sub_old"));
    await part.applySubscription(change("active", MID_MARCH + 20, "sub_new"));

    // Delivered late: the old subscription's activation, and its end once more.
    expect(await part.applySubscription(change("active", MID_MARCH, "sub_old"))).toBe(false);
    expect(await part.applySubscription(change("ended", MID_MARCH + 30, "sub_old"))).toBe(false);
    expect(await part.plan()).toBe("payg");
  });

  it("switches to Free at once when an owner ends Pay as you go, whatever arrives about it later", async () => {
    const { part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));

    expect(await part.endSubscription(MID_MARCH + 100)).toBe("sub_1");
    expect(await part.plan()).toBe("free");
    expect(await part.applySubscription(change("active", MID_MARCH + 50))).toBe(false);
    expect(await part.plan()).toBe("free");
    expect(await part.endSubscription(MID_MARCH + 200)).toBeNull();
  });

  it("ignores a past_due about a subscription that already ended", async () => {
    const { part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));
    await part.endSubscription(MID_MARCH + 100);

    // Cancelled at the end of its period, the subscription's last invoice is not paid.
    expect(await part.applySubscription(change("past_due", MID_MARCH + 200))).toBe(false);
    expect(await part.plan()).toBe("free");
    expect((await part.usage(MID_MARCH)).payment).toBe("ok");

    // Its owner takes the cancellation back in the portal: it is the org's subscription again.
    expect(await part.applySubscription(change("active", MID_MARCH + 300))).toBe(true);
    expect(await part.plan()).toBe("payg");
    expect(await part.applySubscription(change("past_due", MID_MARCH + 400))).toBe(true);
    expect((await part.usage(MID_MARCH)).payment).toBe("past_due");
  });

  it("ignores a past_due about a subscription that ended through Polar", async () => {
    const { part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));
    await part.applySubscription(change("ended", MID_MARCH + 100));

    expect(await part.applySubscription(change("past_due", MID_MARCH + 200))).toBe(false);
    expect(await part.plan()).toBe("free");
  });
});

describe("meter batches", () => {
  it("has nothing to send for an org that has no Polar customer", async () => {
    const { org, part } = billingOf();

    await setPlan(env, org, "payg");
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 100);

    expect(await part.meterBatch(MID_MARCH)).toBeNull();
  });

  it("sends only what is above free usage and not sent before", async () => {
    const { org, part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests - 1);
    expect(await part.meterBatch(MID_MARCH)).toBeNull();

    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 300);

    const first = await part.meterBatch(MID_MARCH);

    expect(first?.customerId).toBe("cus_1");
    expect(first?.events).toEqual([
      expect.objectContaining({ unit: "requests", monthStart: Date.UTC(2026, 2, 1), amount: 300 }),
    ]);

    await part.meterBatchSent(first?.id ?? "");
    expect(await part.meterBatch(MID_MARCH)).toBeNull();

    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 320);

    const second = await part.meterBatch(MID_MARCH);

    expect(second?.events.map((event) => event.amount)).toEqual([20]);
    expect(second?.id).not.toBe(first?.id);
  });

  it("answers the same batch with the same ids until it is sent, so a retry is not counted twice", async () => {
    const { org, part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 7);

    const pending = await part.meterBatch(MID_MARCH);

    // More usage while the batch is out: the retry is the same batch, the rest goes in the next one.
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 9);
    const retried = await part.meterBatch(MID_MARCH);

    expect(retried).toEqual(pending);
    expect(new Set(pending?.events.map((event) => event.externalId)).size).toBe(1);

    // Confirming another batch changes nothing.
    await part.meterBatchSent("another");
    expect(await part.meterBatch(MID_MARCH)).toEqual(pending);

    await part.meterBatchSent(pending?.id ?? "");
    expect((await part.meterBatch(MID_MARCH))?.events.map((event) => event.amount)).toEqual([2]);
  });

  it("sends what it owed when it went back to Free, then nothing, and nothing of before to a later subscription", async () => {
    const { org, part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 40);
    await part.applySubscription(change("ended", MID_MARCH + 1));

    // Used after it ended: on Free, never sent.
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 45);
    await seedRequestsUsed(env, org, FIRST_OF_APRIL, 10);

    const owed = await part.meterBatch(FIRST_OF_APRIL);

    expect(owed?.events).toEqual([
      expect.objectContaining({ unit: "requests", monthStart: Date.UTC(2026, 2, 1), amount: 40 }),
    ]);
    await part.meterBatchSent(owed?.id ?? "");
    expect(await part.meterBatch(FIRST_OF_APRIL)).toBeNull();

    await part.applySubscription(change("active", FIRST_OF_APRIL, "sub_2"));
    expect(await part.meterBatch(FIRST_OF_APRIL)).toBeNull();

    await seedRequestsUsed(env, org, FIRST_OF_APRIL, FREE_USAGE.requests + 3);
    expect((await part.meterBatch(FIRST_OF_APRIL))?.events).toEqual([
      expect.objectContaining({ unit: "requests", monthStart: FIRST_OF_APRIL, amount: 3 }),
    ]);
  });

  it("still sends the batch that was on its way when the org went back to Free", async () => {
    const { org, part } = billingOf();

    await part.applySubscription(change("active", MID_MARCH));
    await seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 40);

    const pending = await part.meterBatch(MID_MARCH);

    await part.endSubscription(MID_MARCH + 1);
    expect(await part.meterBatch(MID_MARCH + 2)).toEqual(pending);

    await part.meterBatchSent(pending?.id ?? "");
    await part.applySubscription(change("active", MID_MARCH + 3, "sub_2"));
    expect(await part.meterBatch(MID_MARCH + 4)).toBeNull();
  });
});

describe("org deletion", () => {
  it("drops the part's tables with the org's", async () => {
    const { org, part } = billingOf();

    await part.admit(MID_MARCH);
    expect(await tablesOf(env.CONTROL_PLANE.getByName(org))).toEqual(
      expect.arrayContaining([
        "billing_plan",
        "billing_usage",
        "billing_account",
        "billing_meter_sent",
        "billing_meter_batch",
        "billing_cap",
      ]),
    );

    await env.CONTROL_PLANE.getByName(org).wipeOrg();

    expect(await tablesOf(env.CONTROL_PLANE.getByName(org))).toEqual([]);
  });
});

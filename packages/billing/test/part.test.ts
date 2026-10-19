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
      allowed: 25_000,
      resetsAt: FIRST_OF_APRIL,
      retryAfterSeconds: (FIRST_OF_APRIL - MID_MARCH) / 1000,
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

describe("org deletion", () => {
  it("drops the part's tables with the org's", async () => {
    const { org, part } = billingOf();

    await part.admit(MID_MARCH);
    expect(await tablesOf(env.CONTROL_PLANE.getByName(org))).toEqual(
      expect.arrayContaining(["billing_plan", "billing_usage"]),
    );

    await env.CONTROL_PLANE.getByName(org).wipeOrg();

    expect(await tablesOf(env.CONTROL_PLANE.getByName(org))).toEqual([]);
  });
});

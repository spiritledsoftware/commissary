// The month's bill (src/bill.ts) and the notices GET /billing gives the panel (src/notices.ts), from hand-built
// BillingUsage values: pure functions, no ControlPlane.
import { describe, expect, it } from "vitest";
import { billMicros } from "../src/bill.ts";
import { billingNotices } from "../src/notices.ts";
import type { BillingUsage } from "../src/store.ts";
import { FREE_USAGE } from "./testing.ts";

/** An org's month: nothing used, on Free, payments ok, the default cap; `overrides` change any of it. */
const month = (overrides: Partial<BillingUsage> = {}): BillingUsage => ({
  plan: "free",
  unbilled: false,
  limitsPlan: "free",
  raised: { browserSessions: null, computers: null, requestRate: null },
  payment: "ok",
  customerId: null,
  subscriptionId: null,
  monthStart: Date.UTC(2026, 2, 1),
  monthEnd: Date.UTC(2026, 3, 1),
  used: { requests: 0, browserHours: 0, computerHours: 0 },
  bill: 0,
  billingCap: 50,
  ...overrides,
});

/** Requests and tool calls above free usage, as a count of requests used. */
const requestsAbove = (above: number) => ({
  requests: FREE_USAGE.requests + above,
  browserHours: 0,
  computerHours: 0,
});

describe("the month's bill", () => {
  it("prices only what is above free usage: $0.50 per 100,000 requests, $0.15 a browser or computer hour", () => {
    expect(billMicros({ requests: FREE_USAGE.requests, browserHours: 1, computerHours: 0 })).toBe(
      0,
    );
    expect(billMicros({ requests: 0, browserHours: 2, computerHours: 0 })).toBe(150_000);
    expect(billMicros({ requests: 0, browserHours: 0, computerHours: 2 })).toBe(300_000);
    expect(billMicros(requestsAbove(100_000))).toBe(500_000);
    expect(billMicros(requestsAbove(10_000_000))).toBe(50_000_000);
  });
});

describe("billing notices", () => {
  it("tells a Free org at 80% and 100% of each unit's free usage, browser hours included", () => {
    expect(
      billingNotices(month({ used: { requests: 0, browserHours: 0.8, computerHours: 0 } })),
    ).toEqual([{ kind: "free_usage", unit: "browser_hours", percent: 80 }]);
    expect(
      billingNotices(
        month({ used: { requests: FREE_USAGE.requests, browserHours: 0.79, computerHours: 0 } }),
      ),
    ).toEqual([{ kind: "free_usage", unit: "requests", percent: 100 }]);
  });

  it("tells a Pay as you go org at 80% of its cap, and at 100% when the cap refuses the next use of a unit", () => {
    const payg = (above: number, billingCap: number | null = 50) =>
      billingNotices(month({ plan: "payg", used: requestsAbove(above), billingCap }));

    expect(payg(7_999_999)).toEqual([]);
    expect(payg(8_000_000)).toEqual([{ kind: "billing_cap", percent: 80 }]);
    // A minute of computer time is $0.0025: the cap refuses it, though requests are still served, from the last
    // $0.0025 of the cap.
    expect(payg(9_999_500)).toEqual([{ kind: "billing_cap", percent: 80 }]);
    expect(payg(9_999_501)).toEqual([{ kind: "billing_cap", percent: 100 }]);
    expect(payg(10_000_000)).toEqual([{ kind: "billing_cap", percent: 100 }]);
    expect(payg(10_000_000, null)).toEqual([]);
  });

  it("tells of a $0 cap at once, as the computer has no free usage: its first minute would be billed and is refused", () => {
    const capped = (requests: number) =>
      billingNotices(
        month({
          plan: "payg",
          used: { requests, browserHours: 0, computerHours: 0 },
          billingCap: 0,
        }),
      );

    expect(capped(0)).toEqual([{ kind: "billing_cap", percent: 100 }]);
    expect(capped(FREE_USAGE.requests)).toEqual([{ kind: "billing_cap", percent: 100 }]);
  });

  it("tells an unbilled org nothing, past its cap or with a failed payment: it is never billed", () => {
    const unbilled = { plan: "payg", unbilled: true, limitsPlan: "payg" } as const;

    expect(billingNotices(month({ ...unbilled, used: requestsAbove(10_000_000) }))).toEqual([]);
    expect(
      billingNotices(month({ ...unbilled, payment: "past_due", used: requestsAbove(9_000_000) })),
    ).toEqual([]);
  });

  it("tells of a failed payment first, and holds the org to Free's notices meanwhile", () => {
    expect(
      billingNotices(month({ plan: "payg", payment: "past_due", used: requestsAbove(10_000_000) })),
    ).toEqual([{ kind: "payment_failed" }, { kind: "free_usage", unit: "requests", percent: 100 }]);
  });
});

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { BillingCap, type BillingView } from "@commissary/contract/billing";
import {
  awaitingUpgrade,
  billReading,
  changesBilling,
  noticeLines,
  ownerBillingProblem,
  parseBillingCap,
  seesBilling,
  unitReadings,
} from "../src/lib/billing.ts";
import { callerOf } from "../src/lib/role.ts";

/** Pay as you go's rates as `GET /billing` states them. */
const RATES: BillingView["rates"] = {
  requests: { dollars: 0.5, per: 100_000 },
  browser_hours: { dollars: 0.15, per: 1 },
  computer_hours: { dollars: 0.15, per: 1 },
};

/** An org on Free at the start of August 2026, nothing used yet. */
const view = (patch: Partial<BillingView> = {}): BillingView => ({
  plan: "free",
  unbilled: false,
  payment: "ok",
  card_on_file: false,
  month_start: "2026-08-01T00:00:00.000Z",
  resets_at: "2026-09-01T00:00:00.000Z",
  usage: {
    requests: { used: 0, free: 25_000 },
    browser_hours: { used: 0, free: 1 },
    computer_hours: { used: 0, free: 0 },
  },
  rates: RATES,
  billing_cap: 50,
  bill: 0,
  notices: [],
  ...patch,
});

describe("this month's usage against free usage", () => {
  it("states each unit's free usage and the rate above it that the server states (ADR 0042)", () => {
    expect(unitReadings(view()).map((row) => [row.name, row.free, row.rate])).toEqual([
      ["Requests and tool calls", "25,000", "$0.50 per 100,000"],
      ["Browser hours", "1 hour", "$0.15 an hour"],
      ["Computer hours", undefined, "$0.15 an hour"],
    ]);

    // The rates are the server's, not the panel's.
    const repriced = view({
      rates: {
        ...RATES,
        requests: { dollars: 0.6, per: 100_000 },
        browser_hours: { dollars: 0.2, per: 1 },
      },
    });

    expect(unitReadings(repriced).map((row) => row.rate)).toEqual([
      "$0.60 per 100,000",
      "$0.20 an hour",
      "$0.15 an hour",
    ]);
  });

  it("measures what Free used against free usage, near at 80% and out at 100% as the notices say", () => {
    const [requests, browser] = unitReadings(
      view({
        usage: {
          requests: { used: 25_000, free: 25_000 },
          browser_hours: { used: 0.85, free: 1 },
          computer_hours: { used: 0, free: 0 },
        },
        notices: [
          { kind: "free_usage", unit: "requests", percent: 100 },
          { kind: "free_usage", unit: "browser_hours", percent: 80 },
        ],
      }),
    );

    expect(requests).toMatchObject({
      used: "25,000",
      percent: 100,
      level: "out",
      levelNote: "Free usage used up",
    });
    expect(browser).toMatchObject({
      used: "0.85 hours",
      percent: 85,
      level: "near",
      levelNote: "Over 80% of free usage",
    });
  });

  it("keeps what Pay as you go uses above free usage calm: it is billed, not refused", () => {
    const [requests] = unitReadings(
      view({
        plan: "payg",
        card_on_file: true,
        usage: {
          requests: { used: 125_000, free: 25_000 },
          browser_hours: { used: 0, free: 1 },
          computer_hours: { used: 0, free: 0 },
        },
        bill: 0.5,
      }),
    );

    expect(requests).toMatchObject({
      used: "125,000",
      percent: 100,
      level: "ok",
      levelNote: undefined,
      billed: "100,000 above free usage, billed",
    });
  });

  it("draws no meter for a unit without free usage", () => {
    expect(unitReadings(view()).at(-1)).toMatchObject({
      used: "0 hours",
      free: undefined,
      percent: undefined,
      billed: undefined,
    });
  });
});

const payg = (patch: Partial<BillingView> = {}) =>
  view({ plan: "payg", card_on_file: true, ...patch });

describe("the bill so far against the billing cap", () => {
  it("measures Pay as you go's bill against the cap, near at 80% as the notice says", () => {
    expect(
      billReading(payg({ bill: 40, notices: [{ kind: "billing_cap", percent: 80 }] })),
    ).toEqual({
      bill: "$40.00",
      cap: "$50.00",
      percent: 80,
      level: "near",
      levelNote: "Over 80% of the billing cap.",
    });
  });

  it("reads a cap of $0 as reached, and no cap as nothing to measure", () => {
    expect(
      billReading(payg({ billing_cap: 0, notices: [{ kind: "billing_cap", percent: 100 }] })),
    ).toEqual({
      bill: "$0.00",
      cap: "$0.00",
      percent: 100,
      level: "out",
      levelNote:
        "The billing cap is reached: use that would be billed is refused until September 1, UTC.",
    });
    expect(billReading(payg({ billing_cap: null, bill: 12.4 }))).toEqual({
      bill: "$12.40",
      cap: undefined,
      percent: undefined,
      level: "ok",
      levelNote: undefined,
    });
  });

  it("has no bill on Free or for an unbilled org", () => {
    expect(billReading(view())).toBeUndefined();
    expect(billReading(payg({ unbilled: true }))).toBeUndefined();
  });
});

describe("typing a billing cap", () => {
  it("reads dollars from 0 in whole cents, with or without a $ and thousands commas", () => {
    expect(parseBillingCap("50")).toEqual({ kind: "cap", value: 50 });
    expect(parseBillingCap(" $1,250.5 ")).toEqual({ kind: "cap", value: 1250.5 });
    expect(parseBillingCap("0")).toEqual({ kind: "cap", value: 0 });
    expect(parseBillingCap("19.99")).toEqual({ kind: "cap", value: 19.99 });

    for (const text of ["", "  ", "-1", "1.234", "fifty", "1e3", "$"])
      expect(parseBillingCap(text)).toEqual({ kind: "invalid" });
  });

  it("is checked against the contract's billing cap", () => {
    for (const text of ["0.01", "0.07", "0.29", "123456.78"]) {
      const parsed = parseBillingCap(text);

      expect(parsed.kind).toBe("cap");

      if (parsed.kind === "cap") expect(Schema.is(BillingCap)(parsed.value)).toBe(true);
    }
  });
});

const lines = (patch: Partial<BillingView>, owner = true) =>
  noticeLines(view(patch), owner).map(({ level, text, action }) => ({ level, text, action }));

describe("plan notices", () => {
  it("tells of free usage at 80% and 100%, most urgent first, and what is refused until when", () => {
    expect(
      lines({
        notices: [
          { kind: "free_usage", unit: "browser_hours", percent: 80 },
          { kind: "free_usage", unit: "requests", percent: 100 },
        ],
      }),
    ).toEqual([
      {
        level: "out",
        text: "This org has used all of this month’s free requests and tool calls: requests and tool calls are refused until September 1, UTC.",
        action: undefined,
      },
      {
        level: "near",
        text: "This org has used 80% of this month’s free browser hours. At 100%, browser sessions and Quick Actions are refused until September 1, UTC.",
        action: undefined,
      },
    ]);
  });

  it("says at 80% of free requests that requests are refused at 100%", () => {
    expect(lines({ notices: [{ kind: "free_usage", unit: "requests", percent: 80 }] })).toEqual([
      {
        level: "near",
        text: "This org has used 80% of this month’s free requests and tool calls. At 100%, requests and tool calls are refused until September 1, UTC.",
        action: undefined,
      },
    ]);
  });

  it("tells of the billing cap at 80% and 100%", () => {
    const onPayg = { plan: "payg", card_on_file: true } as const;

    expect(lines({ ...onPayg, bill: 40, notices: [{ kind: "billing_cap", percent: 80 }] })).toEqual(
      [
        {
          level: "near",
          text: "This month’s bill has reached 80% of the billing cap of $50.00.",
          action: undefined,
        },
      ],
    );
    expect(
      lines({ ...onPayg, bill: 50, notices: [{ kind: "billing_cap", percent: 100 }] }),
    ).toEqual([
      {
        level: "out",
        text: "This month’s bill has reached the billing cap of $50.00: use that would be billed is refused until September 1, UTC.",
        action: undefined,
      },
    ]);
  });

  it("sends an org owner to the billing portal after a failed payment, and other org admins to an owner", () => {
    const failed = {
      plan: "payg",
      payment: "past_due",
      notices: [{ kind: "payment_failed" }],
    } as const;

    expect(lines(failed)).toEqual([
      {
        level: "out",
        text: "A payment failed: this org is held to Free’s limits until a payment succeeds.",
        action: "portal",
      },
    ]);
    expect(lines(failed, false)).toEqual([
      {
        level: "out",
        text: "A payment failed: this org is held to Free’s limits until a payment succeeds. Ask an org owner to update the payment method.",
        action: undefined,
      },
    ]);
  });

  it("has nothing to say without notices", () => {
    expect(lines({})).toEqual([]);
  });
});

describe("who changes billing", () => {
  it("is org owners (and platform admins, owners of every org); other org admins read it", () => {
    expect(changesBilling(callerOf({ role: "owner", platform_admin: false }))).toBe(true);
    expect(changesBilling(callerOf({ role: null, platform_admin: true }))).toBe(true);
    expect(changesBilling(callerOf({ role: "admin", platform_admin: false }))).toBe(false);
  });
});

describe("a refused billing call of an org owner", () => {
  it("says what went wrong and what to do, by the server's error code", () => {
    expect(ownerBillingProblem("billing_email_taken", "409")).toBe(
      "Your email already bills another org on Commissary Cloud, and one email bills one org. Another org owner can upgrade this one.",
    );
    expect(ownerBillingProblem("already_on_payg", "409")).toBe(
      "This org is on Pay as you go already. Reload the page to see it.",
    );
    expect(ownerBillingProblem("no_billing_account", "409")).toBe(
      "This org has no billing account yet: it gets one with its first upgrade to Pay as you go.",
    );
    expect(ownerBillingProblem("person_required", "403")).toBe(
      "Only a person can upgrade, since the billing email is theirs; a token cannot.",
    );
    expect(ownerBillingProblem("unbilled", "409")).toBe(
      "This org is unbilled: a platform admin decides its billing.",
    );
    expect(ownerBillingProblem("invalid_billing_cap", "422")).toBe(
      "A billing cap is an amount of dollars from 0, in whole cents.",
    );
    expect(ownerBillingProblem(undefined, "Failed", "the billing provider is unavailable")).toBe(
      "The billing provider is unavailable.",
    );
    expect(ownerBillingProblem(undefined, "Failed")).toBe("Failed");
  });
});

describe("coming back from checkout", () => {
  const started = Date.parse("2026-08-03T10:00:00.000Z");

  it("waits for Pay as you go for an hour after an owner started a checkout", () => {
    expect(awaitingUpgrade(started, started + 5 * 60_000, view())).toBe(true);
    expect(awaitingUpgrade(started, started + 61 * 60_000, view())).toBe(false);
    expect(awaitingUpgrade(undefined, started, view())).toBe(false);
  });

  it("stops once the webhook put the org on Pay as you go", () => {
    expect(awaitingUpgrade(started, started + 60_000, view({ plan: "payg" }))).toBe(false);
  });
});

describe("where billing shows", () => {
  it("is Commissary Cloud's org owners and admins only: no page or banner self-hosted or for plain members", () => {
    const admin = callerOf({ role: "admin", platform_admin: false });

    expect(seesBilling(true, admin)).toBe(true);
    expect(seesBilling(true, callerOf({ role: "owner", platform_admin: false }))).toBe(true);
    expect(seesBilling(false, admin)).toBe(false);
    expect(seesBilling(false, callerOf({ role: "owner", platform_admin: true }))).toBe(false);
    expect(seesBilling(true, callerOf({ role: "member", platform_admin: false }))).toBe(false);
  });
});

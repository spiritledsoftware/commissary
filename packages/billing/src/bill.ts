/**
 * What Pay as you go bills an org for a month, and the billing cap that stops it (ADR 0042), as named constants: the
 * rates are the deployment's pricing, not settings. New in the Workers port, no Go counterpart.
 *
 * Amounts are kept in micro-dollars, so a month of requests (5 µ$ each) adds up exactly and a bill compares with a cap
 * without floating-point drift; the API speaks dollars.
 *
 * Polar bills the usage Commissary sends at the prices of the Pay-as-you-go product, set up by hand
 * (`docs/DEPLOY.md` "Polar", step 2): they must equal {@link PAYG_RATE_MICROS}, or the bill the cap stops is not the
 * one Polar invoices.
 */
import type { BillingRate } from "@commissary/contract/billing";
import { FREE_USAGE, UNITS, type Unit, type Usage } from "./plan.ts";

/** Micro-dollars in a dollar. */
const MICROS = 1_000_000;

/**
 * What Pay as you go bills per unit above free usage, in micro-dollars: $0.50 per 100,000 requests and tool calls,
 * $0.15 a browser hour and $0.15 a computer hour.
 */
export const PAYG_RATE_MICROS: Readonly<Record<Unit, number>> = {
  requests: 5,
  browserHours: 150_000,
  computerHours: 150_000,
};

/** The billing cap of an org whose owners never set one: $50 a month. */
export const DEFAULT_BILLING_CAP = 50;

/** A dollar amount in micro-dollars, rounded to the nearest one. */
export const toMicros = (dollars: number): number => Math.round(dollars * MICROS);

export const toDollars = (micros: number): number => micros / MICROS;

/**
 * How much of each unit a rate is stated for (ADR 0042: "$0.50 per 100,000" requests and tool calls, "$0.15 per hour"):
 * how `GET /billing` states {@link PAYG_RATE_MICROS}, so the panel shows the rates the bill counts at.
 */
export const PAYG_RATE_PER: Readonly<Record<Unit, number>> = {
  requests: 100_000,
  browserHours: 1,
  computerHours: 1,
};

/** A unit's rate in dollars per {@link PAYG_RATE_PER} of it. */
export const paygRate = (unit: Unit): BillingRate => ({
  dollars: toDollars(PAYG_RATE_MICROS[unit] * PAYG_RATE_PER[unit]),
  per: PAYG_RATE_PER[unit],
});

/** What a month's usage bills above free usage, in micro-dollars (whatever the plan: the bill on Pay as you go). */
export const billMicros = (used: Usage): number =>
  UNITS.reduce(
    (sum, unit) => sum + Math.max(0, used[unit] - FREE_USAGE[unit]) * PAYG_RATE_MICROS[unit],
    0,
  );

/**
 * What the next use of a unit adds to the bill, in units: one request or tool call, or a minute of browser or computer
 * time (those are metered as they run, so the cap stops use once a minute more would take the bill past it).
 */
const CAP_STEP: Readonly<Record<Unit, number>> = {
  requests: 1,
  browserHours: 1 / 60,
  computerHours: 1 / 60,
};

/**
 * Whether the billing cap (dollars) refuses the next use of `unit` after `used`: use that would be billed (the unit's
 * free usage is used up) and would take the bill past the cap. The one test both the refusal (`BillingStore.admit`,
 * `BillingStore.limitOf`) and the 100% notice (`notices.ts`) use, so they cannot disagree.
 */
export const capRefuses = (used: Usage, cap: number, unit: Unit): boolean =>
  used[unit] >= FREE_USAGE[unit] &&
  billMicros(used) + PAYG_RATE_MICROS[unit] * CAP_STEP[unit] > toMicros(cap);

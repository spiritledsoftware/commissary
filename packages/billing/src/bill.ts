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

/** What a month's usage bills above free usage, in micro-dollars (whatever the plan: the bill on Pay as you go). */
export const billMicros = (used: Usage): number =>
  UNITS.reduce(
    (sum, unit) => sum + Math.max(0, used[unit] - FREE_USAGE[unit]) * PAYG_RATE_MICROS[unit],
    0,
  );

/**
 * Whether the billing cap (dollars) refuses the next request after `used`: one that would be billed (free usage of
 * requests is used up) and would take the bill past the cap. The one test both the refusal (`BillingStore.admit`) and
 * the 100% notice (`notices.ts`) use, so they cannot disagree.
 */
export const capRefusesNextRequest = (used: Usage, cap: number): boolean =>
  used.requests >= FREE_USAGE.requests &&
  billMicros(used) + PAYG_RATE_MICROS.requests > toMicros(cap);

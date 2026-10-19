/**
 * Plans, free usage and the request-rate ceilings of Commissary Cloud (ADR 0042), as named constants: the numbers are
 * the deployment's pricing, not settings. New in the Workers port, no Go counterpart.
 */

/** What an org holds to decide what it is billed: Free or Pay as you go. A self-hosted Commissary has none. */
export const PLANS = ["free", "payg"] as const;

export type Plan = (typeof PLANS)[number];

/** Every org starts on Free, those that existed when plans arrived included (no backfill of past usage). */
export const DEFAULT_PLAN: Plan = "free";

/**
 * What a plan counts per org per calendar month in UTC: requests and tool calls together, browser hours and computer
 * hours. `requests` is counted since #236; the other units are counted when their areas exist (#241) and read 0 until
 * then.
 */
export const UNITS = ["requests", "browserHours", "computerHours"] as const;

export type Unit = (typeof UNITS)[number];

/** An amount of each unit. */
export type Usage = Readonly<Record<Unit, number>>;

/** Free usage, on either plan (ADR 0042). */
export const FREE_USAGE: Usage = {
  requests: 25_000,
  browserHours: 1,
  computerHours: 0,
};

/** Requests an org may send a minute on the client API, by plan (ADR 0042 "Ceilings for fairness between orgs"). */
export const REQUEST_RATE_CEILING: Readonly<Record<Plan, number>> = {
  free: 60,
  payg: 600,
};

/** The period the ceilings count in: the Workers rate-limiting binding allows 10 or 60 seconds. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export const isPlan = (value: string): value is Plan => PLANS.some((plan) => plan === value);

/**
 * Plans, free usage and the request-rate ceilings of Commissary Cloud (ADR 0042), as named constants: the numbers are
 * the deployment's pricing, not settings. New in the Workers port, no Go counterpart.
 */
import { Schema } from "effect";

/** What an org holds to decide what it is billed: Free or Pay as you go. A self-hosted Commissary has none. */
export const PLANS = ["free", "payg"] as const;

export type Plan = (typeof PLANS)[number];

/** Every org starts on Free, those that existed when plans arrived included (no backfill of past usage). */
export const DEFAULT_PLAN: Plan = "free";

/**
 * Whether a Pay-as-you-go org's payments go through: `past_due` from Polar marking its subscription past due until a
 * payment succeeds, while the org keeps Pay as you go but is held to Free's limits (ADR 0042). A Free org is `ok`.
 */
export const PAYMENT_STATES = ["ok", "past_due"] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * What a plan counts per org per calendar month in UTC: requests and tool calls together (a tool call counts as a
 * request, #241), browser hours (the browser toolkit's time, #214) and computer hours (the sandbox toolkit's computer,
 * #224).
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

/**
 * Which plan limit refuses use: free usage of requests and tool calls (`requests`), of browser hours (`browser_hours`)
 * or of computer hours (`computer_hours`), on Free or while past due, or the billing cap (`billing_cap`, on Pay as you
 * go; `bill.ts`). It is a `plan_limit_reached` body's `limit`.
 */
export const PlanLimitKind = Schema.Literals([
  "requests",
  "browser_hours",
  "computer_hours",
  "billing_cap",
]);

export type PlanLimitKind = typeof PlanLimitKind.Type;

/** The plan limit that refuses use of a unit once its free usage is used up. */
export const UNIT_LIMIT: Readonly<Record<Unit, PlanLimitKind>> = {
  requests: "requests",
  browserHours: "browser_hours",
  computerHours: "computer_hours",
};

/** Requests an org may send a minute on the client API, by plan (ADR 0042 "Ceilings for fairness between orgs"). */
export const REQUEST_RATE_CEILING: Readonly<Record<Plan, number>> = {
  free: 60,
  payg: 600,
};

/**
 * The ceilings for fairness between orgs a plan sets (ADR 0042), each of which a platform admin may raise for one org
 * (#240): concurrent browser sessions, concurrent computers (both enforced by the Tools part, #241) and the request
 * rate a minute.
 */
export const CEILINGS = ["browserSessions", "computers", "requestRate"] as const;

export type Ceiling = (typeof CEILINGS)[number];

/**
 * The ceilings on concurrent use that refuse opening one more (`plan_limit_reached` with this as the `limit`):
 * browser sessions and computers. The request rate is a rate limit, not a refusal to open.
 */
export type CeilingKind = Extract<Ceiling, "browserSessions" | "computers">;

/** A value for each ceiling. */
export type Ceilings = Readonly<Record<Ceiling, number>>;

/** The ceilings a platform admin raised for one org; `null`: the plan's. */
export type RaisedCeilings = Readonly<Record<Ceiling, number | null>>;

/** Each plan's ceilings (ADR 0042 "Ceilings for fairness between orgs"). */
export const PLAN_CEILINGS: Readonly<Record<Plan, Ceilings>> = {
  free: { browserSessions: 1, computers: 0, requestRate: REQUEST_RATE_CEILING.free },
  payg: { browserSessions: 5, computers: 3, requestRate: REQUEST_RATE_CEILING.payg },
};

/** The period the ceilings count in: the Workers rate-limiting binding allows 10 or 60 seconds. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export const isPlan = (value: string): value is Plan => PLANS.some((plan) => plan === value);

export const isUnit = (value: string): value is Unit => UNITS.some((unit) => unit === value);

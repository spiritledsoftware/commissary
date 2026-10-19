// `@commissary/billing/testing`: what the Workers' tests need of Billing (docs/DEVELOPMENT.md, "Tests"). Test files only
// (they run in workerd, which provides `cloudflare:test`). The Workers' tests go through their routers or `fetch`; they
// set up and read an org's plan and counters through these helpers instead of Billing's modules.
import { runInDurableObject } from "cloudflare:test";
import type { OrgId } from "@commissary/core";
import { type BillingBindings, billingPartOf } from "../src/env.ts";
import { monthOf } from "../src/month.ts";
import type { Plan } from "../src/plan.ts";

export { FREE_USAGE, REQUEST_RATE_CEILING } from "../src/plan.ts";

/** Puts `org` on `plan`, as switching plans will (#237). */
export const setPlan = async (env: BillingBindings, org: OrgId, plan: Plan): Promise<void> => {
  await billingPartOf(env, org).setPlan(plan);
};

/** What `org` used of requests and tool calls in the month containing `now` (epoch ms). */
export const requestsUsed = async (
  env: BillingBindings,
  org: OrgId,
  now: number,
): Promise<number> => (await billingPartOf(env, org).usage(now)).used.requests;

/**
 * Sets what `org` used of requests and tool calls in the month containing `now` (epoch ms), the way a month of
 * requests would have, without sending them.
 */
export const seedRequestsUsed = async (
  env: BillingBindings,
  org: OrgId,
  now: number,
  used: number,
): Promise<void> => {
  await billingPartOf(env, org).usage(now);

  await runInDurableObject(env.CONTROL_PLANE.getByName(org), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO billing_usage (month_start, unit, amount) VALUES (?, 'requests', ?)
       ON CONFLICT (month_start, unit) DO UPDATE SET amount = excluded.amount`,
      monthOf(now).start,
      used,
    );
  });
};

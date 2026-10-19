/**
 * Billing (`GET /v9/management/billing`, `packages/billing/src/routes.ts`; the rules live in `packages/billing/`):
 * Commissary Cloud's plan of the org and what it used this calendar month (UTC) against free usage, in each unit
 * (ADR 0042). Cloud only: a self-hosted Commissary answers 404. Any org admin may read it. Workers addition, no Go
 * counterpart. Shared with the browser: imports `effect` and `./errors.ts` only.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

/** What an org holds to decide what it is billed: Free, or Pay as you go. */
export const BillingPlan = Schema.Literals(["free", "payg"]);

export type BillingPlan = typeof BillingPlan.Type;

/** What the org used of one unit this month, and what the month gives free (on either plan). */
export const BillingUnitUsage = Schema.Struct({
  used: Schema.Number,
  free: Schema.Number,
});

export type BillingUnitUsage = typeof BillingUnitUsage.Type;

/**
 * `GET /billing`. `requests` counts requests and tool calls together (tool calls are not counted yet); browser and
 * computer hours read 0 until they are counted. Times are ISO: when this month began and when the next one starts and
 * the counters start over.
 */
export const BillingView = Schema.Struct({
  plan: BillingPlan,
  month_start: Schema.String,
  resets_at: Schema.String,
  usage: Schema.Struct({
    requests: BillingUnitUsage,
    browser_hours: BillingUnitUsage,
    computer_hours: BillingUnitUsage,
  }),
});

export type BillingView = typeof BillingView.Type;

export class BillingGroup extends HttpApiGroup.make("billing").add(
  HttpApiEndpoint.get("overview", "/billing", { success: BillingView, error: managementErrors }),
) {}

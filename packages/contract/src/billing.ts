/**
 * Billing (`/v9/management/billing`, `packages/billing/src/routes.ts`; the rules live in `packages/billing/`):
 * Commissary Cloud's plan of the org and what it used this calendar month (UTC) against free usage, in each unit
 * (ADR 0042), and Pay as you go through Polar (#237): checkout, the customer portal and switching back to Free; the
 * billing cap and the notices of plan limits and failed payments (#238). Cloud only: a self-hosted Commissary answers
 * 404, and so do the checkout, portal and plan routes on a Commissary Cloud stage without Polar's settings. Any org
 * admin may read the overview; the writes are for org owners. Workers addition, no Go counterpart. Shared with the
 * browser: imports `effect` and `./errors.ts` only.
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
 * Whether Pay as you go's payments go through: `past_due` once Polar marked the subscription past due, until a payment
 * succeeds; the org keeps Pay as you go but is held to Free's limits meanwhile. Always `ok` on Free.
 */
export const BillingPayment = Schema.Literals(["ok", "past_due"]);

export type BillingPayment = typeof BillingPayment.Type;

/** The units a plan counts, as the API names them. */
export const BillingUnit = Schema.Literals(["requests", "browser_hours", "computer_hours"]);

export type BillingUnit = typeof BillingUnit.Type;

/** How near a plan limit is: 80% of it, or all of it (100%: use it covers is refused). */
export const BillingNoticeLevel = Schema.Literals([80, 100]);

/**
 * What the panel tells the org's owners and admins (Commissary sends no billing email, ADR 0042):
 * - `free_usage`: on Free (or on Pay as you go while a payment failed, held to Free's limits), a unit's free usage is
 *   80% or 100% used; units with no free usage have none.
 * - `billing_cap`: on Pay as you go, the month's bill is at 80% or 100% of the billing cap.
 * - `payment_failed`: Polar marked the subscription past due. It carries no link: the panel calls
 *   `POST /billing/portal` (org owners only, who alone may change the payment method) when an owner follows it, and
 *   tells other org admins to ask an owner.
 */
export const BillingNotice = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("free_usage"),
    unit: BillingUnit,
    percent: BillingNoticeLevel,
  }),
  Schema.Struct({ kind: Schema.Literal("billing_cap"), percent: BillingNoticeLevel }),
  Schema.Struct({ kind: Schema.Literal("payment_failed") }),
]);

export type BillingNotice = typeof BillingNotice.Type;

/**
 * `GET /billing`. `payment` is the payment state; `card_on_file` whether the org's Polar customer has a payment method
 * (`false` before its first checkout or without Polar, `null` when Polar could not be asked). `requests` counts
 * requests and tool calls together (tool calls are not counted yet); browser and computer hours read 0 until they are
 * counted. Times are ISO: when this month began and when the next one starts and the counters start over.
 * `billing_cap` is the most Pay as you go may bill the org a month, in dollars ($50 until an org owner sets it; `null`:
 * no cap; it applies on Pay as you go only); `bill` what the month's usage above free usage bills so far, in dollars.
 */
export const BillingView = Schema.Struct({
  plan: BillingPlan,
  payment: BillingPayment,
  card_on_file: Schema.NullOr(Schema.Boolean),
  month_start: Schema.String,
  resets_at: Schema.String,
  usage: Schema.Struct({
    requests: BillingUnitUsage,
    browser_hours: BillingUnitUsage,
    computer_hours: BillingUnitUsage,
  }),
  billing_cap: Schema.NullOr(Schema.Number),
  bill: Schema.Number,
  notices: Schema.Array(BillingNotice),
});

export type BillingView = typeof BillingView.Type;

/** Where to send the org owner: Polar's checkout or its customer portal. */
export const BillingRedirect = Schema.Struct({ url: Schema.String });

export type BillingRedirect = typeof BillingRedirect.Type;

/** `POST /billing/plan`: back to Free, at once (upgrading goes through `POST /billing/checkout`). */
export const SwitchBillingPlan = Schema.Struct({ plan: Schema.Literal("free") });

export type SwitchBillingPlan = typeof SwitchBillingPlan.Type;

/** A billing cap: dollars a month, from 0, in whole cents. */
export const BillingCap = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isMultipleOf(0.01),
);

/**
 * `PATCH /billing`: the billing cap in dollars a month, or `null` for no cap. `400` for another shape, `422
 * invalid_billing_cap` for an amount below 0 or in fractions of a cent.
 */
export const SetBillingCap = Schema.Struct({ billing_cap: Schema.NullOr(BillingCap) });

export type SetBillingCap = typeof SetBillingCap.Type;

export class BillingGroup extends HttpApiGroup.make("billing").add(
  HttpApiEndpoint.get("overview", "/billing", { success: BillingView, error: managementErrors }),
  /** Org owners: sets or removes the billing cap; it applies to the next request. */
  HttpApiEndpoint.patch("cap", "/billing", {
    payload: SetBillingCap,
    success: BillingView,
    error: managementErrors,
  }),
  /**
   * Org owners: a Polar checkout of Pay as you go, creating the org's Polar customer (billed to the owner) on the
   * first; `409 already_on_payg` when the org has Pay as you go, `409 billing_email_taken` when the owner's email is
   * another org's billing email.
   */
  HttpApiEndpoint.post("checkout", "/billing/checkout", {
    success: BillingRedirect,
    error: managementErrors,
  }),
  /** Org owners: the org's Polar customer portal; `409 no_billing_account` before its first checkout. */
  HttpApiEndpoint.post("portal", "/billing/portal", {
    success: BillingRedirect,
    error: managementErrors,
  }),
  /** Org owners: back to Free at once, cancelling the subscription after sending the usage not sent yet. */
  HttpApiEndpoint.post("plan", "/billing/plan", {
    payload: SwitchBillingPlan,
    success: BillingView,
    error: managementErrors,
  }),
) {}

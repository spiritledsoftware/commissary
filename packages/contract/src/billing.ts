/**
 * Billing (`/v9/management/billing`, `packages/billing/src/routes.ts`; the rules live in `packages/billing/`):
 * Commissary Cloud's plan of the org and what it used this calendar month (UTC) against free usage, in each unit
 * (ADR 0042), and Pay as you go through Polar (#237): checkout, the customer portal and switching back to Free. Cloud
 * only: a self-hosted Commissary answers 404, and so do the checkout, portal and plan routes on a Commissary Cloud
 * stage without Polar's settings. Any org admin may read the overview; the writes are for org owners. Workers addition,
 * no Go counterpart. Shared with the browser: imports `effect` and `./errors.ts` only.
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

/**
 * `GET /billing`. `payment` is the payment state; `card_on_file` whether the org's Polar customer has a payment method
 * (`false` before its first checkout or without Polar, `null` when Polar could not be asked). `requests` counts
 * requests and tool calls together (tool calls are not counted yet); browser and computer hours read 0 until they are
 * counted. Times are ISO: when this month began and when the next one starts and the counters start over.
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
});

export type BillingView = typeof BillingView.Type;

/** Where to send the org owner: Polar's checkout or its customer portal. */
export const BillingRedirect = Schema.Struct({ url: Schema.String });

export type BillingRedirect = typeof BillingRedirect.Type;

/** `POST /billing/plan`: back to Free, at once (upgrading goes through `POST /billing/checkout`). */
export const SwitchBillingPlan = Schema.Struct({ plan: Schema.Literal("free") });

export type SwitchBillingPlan = typeof SwitchBillingPlan.Type;

export class BillingGroup extends HttpApiGroup.make("billing").add(
  HttpApiEndpoint.get("overview", "/billing", { success: BillingView, error: managementErrors }),
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

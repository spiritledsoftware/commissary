/**
 * The notices `GET /billing` gives the panel for the org's owners and admins (ADR 0042 "Notices"; Commissary sends no
 * billing email): 80% and 100% of a unit's free usage where Free's limits apply, 80% and 100% of the billing cap on Pay
 * as you go, and a failed payment; none for an unbilled org (#240), which is never billed. Pure: computed from what the Billing part answers, without asking the billing
 * provider anything. New in the Workers port, no Go counterpart.
 */
import type { BillingNotice, BillingUnit } from "@commissary/contract/billing";
import { billMicros, capRefusesNextRequest, toMicros } from "./bill.ts";
import { FREE_USAGE, UNITS, type Unit } from "./plan.ts";
import type { BillingUsage } from "./store.ts";

const API_UNIT: Readonly<Record<Unit, BillingUnit>> = {
  requests: "requests",
  browserHours: "browser_hours",
  computerHours: "computer_hours",
};

/** Whether `used` is at least 80% of `limit` (a positive amount). */
const atEightyPercent = (used: number, limit: number): boolean => used * 5 >= limit * 4;

/** The billing cap's notice: 100% exactly when the cap refuses the next request (`admit`'s test), else 80% from 80%. */
const capNotice = (billing: BillingUsage, cap: number): BillingNotice | undefined => {
  if (capRefusesNextRequest(billing.used, cap)) return { kind: "billing_cap", percent: 100 };

  const capMicros = toMicros(cap);

  return capMicros > 0 && atEightyPercent(billMicros(billing.used), capMicros)
    ? { kind: "billing_cap", percent: 80 }
    : undefined;
};

/**
 * The org's notices: a failed payment first, then the plan limits it is near. Free usage counts where Free's limits
 * apply (on Free, and on Pay as you go while past due), for each unit that has some; the billing cap on Pay as you go
 * otherwise, unless it was removed. The failed-payment notice carries no link: the panel asks for the customer portal
 * (`POST /billing/portal`, org owners only) when an owner follows it.
 */
export const billingNotices = (billing: BillingUsage): ReadonlyArray<BillingNotice> => {
  // Unbilled: never billed, so no cap, free usage or payment applies to it.
  if (billing.unbilled) return [];

  const notices: Array<BillingNotice> = [];
  const pastDue = billing.plan === "payg" && billing.payment === "past_due";

  if (pastDue) notices.push({ kind: "payment_failed" });

  if (billing.plan === "free" || pastDue) {
    for (const unit of UNITS) {
      const free = FREE_USAGE[unit];
      const used = billing.used[unit];

      if (free <= 0) continue;

      if (used >= free) notices.push({ kind: "free_usage", unit: API_UNIT[unit], percent: 100 });
      else if (atEightyPercent(used, free))
        notices.push({ kind: "free_usage", unit: API_UNIT[unit], percent: 80 });
    }

    return notices;
  }

  const notice = billing.billingCap === null ? undefined : capNotice(billing, billing.billingCap);

  if (notice !== undefined) notices.push(notice);

  return notices;
};

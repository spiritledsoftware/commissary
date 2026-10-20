/**
 * What an isolate remembers of an org's billing for a short while, so the client API's hot path does not ask the org's
 * ControlPlane (or the Platform registry) on every request: the org's plan for the rate ceiling, and a refusal by the
 * plan limit. Like `@commissary/auth`'s standing: bounded, per isolate, trusted for {@link BILLING_TTL_MS}, so a plan
 * change reaches every isolate within that time; a refusal by the billing cap only for
 * {@link BILLING_CAP_REFUSAL_TTL_MS}, so an owner who raises or removes the cap sees use resume within seconds. Code
 * that switches a plan (Polar's webhook, `POST /billing/plan`, #237) or sets the billing cap (`PATCH /billing`, #238)
 * calls {@link forgetBilling} so the isolate that made the change sees it at once.
 */
import { makeOrgCache, type OrgId } from "@commissary/core";
import type { Plan, PlanLimitKind } from "./plan.ts";

/** How long an isolate trusts what it knows of an org's billing without asking again. */
export const BILLING_TTL_MS = 30_000;

/**
 * How long an isolate trusts a refusal by the billing cap: an owner raising or removing the cap in the app Worker
 * cannot clear the API Worker's isolates, so their refusals must lapse soon.
 */
export const BILLING_CAP_REFUSAL_TTL_MS = 5_000;

const MAX_CACHED = 4096;

/** The name an org's entry has in each cache: there is one per org. */
const ENTRY = "billing";

/** A bounded {@link OrgCache}, one entry per org, whose entries expire at a time (epoch ms). */
class Expiring<V> {
  readonly #entries = makeOrgCache<{ readonly value: V; readonly until: number }>(MAX_CACHED);

  get(org: OrgId, now: number): V | undefined {
    const entry = this.#entries.get(org, ENTRY);

    if (entry === undefined) return undefined;

    if (now >= entry.until) {
      this.#entries.delete(org, ENTRY);

      return undefined;
    }

    return entry.value;
  }

  set(org: OrgId, value: V, until: number): void {
    this.#entries.set(org, ENTRY, { value, until });
  }

  delete(org: OrgId): void {
    this.#entries.delete(org, ENTRY);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Orgs' plans as the rate ceiling reads them: Free's while a Pay-as-you-go org is past due. */
export const plans = new Expiring<Plan>();

/** What a plan-limit refusal needs besides the time: the limit and the link to the billing page. */
export interface CachedRefusal {
  /** Free usage of requests and tool calls, or the billing cap (`PlanLimit`). */
  readonly limit: PlanLimitKind;
  /** The month's free usage of requests and tool calls, or the billing cap in dollars. */
  readonly allowed: number;
  /** When the month ends (epoch ms): the refusal is good until then at most. */
  readonly resetsAt: number;
  readonly page: string;
  /** A Pay-as-you-go org held to Free's limits until a payment succeeds. */
  readonly pastDue: boolean;
}

/** Orgs refused by their plan limit, and where their billing page is (looked up once per refusal, not per request). */
export const refusals = new Expiring<CachedRefusal>();

/** Forgets what this isolate knows of an org's billing, after its plan changed. */
export const forgetBilling = (org: OrgId): void => {
  plans.delete(org);
  refusals.delete(org);
};

/** Empties the caches, for tests. */
export const resetBillingCaches = (): void => {
  plans.clear();
  refusals.clear();
};

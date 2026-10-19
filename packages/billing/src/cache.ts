/**
 * What an isolate remembers of an org's billing for a short while, so the client API's hot path does not ask the org's
 * ControlPlane (or the Platform registry) on every request: the org's plan for the rate ceiling, and a refusal by the
 * plan limit. Like `@commissary/auth`'s standing: bounded, per isolate, trusted for {@link BILLING_TTL_MS}; a change
 * applies within that time everywhere and at once in the isolate that made it ({@link forgetBilling}).
 */
import type { OrgId } from "@commissary/core";
import type { Plan } from "./plan.ts";

/** How long an isolate trusts what it knows of an org's billing without asking again. */
export const BILLING_TTL_MS = 30_000;

const MAX_CACHED = 4096;

/** A bounded map whose entries expire at a time (epoch ms). */
class Expiring<V> {
  readonly #entries = new Map<string, { readonly value: V; readonly until: number }>();

  get(key: string, now: number): V | undefined {
    const entry = this.#entries.get(key);

    if (entry === undefined) return undefined;

    if (now >= entry.until) {
      this.#entries.delete(key);

      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: V, until: number): void {
    if (this.#entries.size >= MAX_CACHED) {
      const oldest = this.#entries.keys().next();

      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }

    this.#entries.set(key, { value, until });
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Orgs' plans as the rate ceiling reads them. */
export const plans = new Expiring<Plan>();

/** What a plan-limit refusal needs besides the time: the limit and the link to the billing page. */
export interface CachedRefusal {
  readonly allowed: number;
  /** When the month ends (epoch ms): the refusal is good until then at most. */
  readonly resetsAt: number;
  readonly page: string;
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

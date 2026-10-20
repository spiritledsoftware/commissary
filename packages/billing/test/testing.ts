// `@commissary/billing/testing`: what the Workers' tests need of Billing (docs/DEVELOPMENT.md, "Tests"). Test files only
// (they run in workerd, which provides `cloudflare:test`). The Workers' tests go through their routers or `fetch`; they
// set up and read an org's plan and counters through these helpers instead of Billing's modules.
import { runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import type { OrgId } from "@commissary/core";
import { forgetBilling } from "../src/cache.ts";
import { type BillingBindings, billingPartOf } from "../src/env.ts";
import { monthOf } from "../src/month.ts";
import type { Plan } from "../src/plan.ts";
import { readWebhook } from "../src/polar.ts";
import { type BillingProvider, BillingProviderError, WebhookRefused } from "../src/provider.ts";
import type { MeterEvent } from "../src/store.ts";

export { BillingProviders } from "../src/providers.ts";

export { resetBillingCaches } from "../src/cache.ts";

export { FREE_USAGE, REQUEST_RATE_CEILING } from "../src/plan.ts";

/** Puts `org` on `plan` directly, without Polar (tests that are not about switching plans). */
export const setPlan = async (env: BillingBindings, org: OrgId, plan: Plan): Promise<void> => {
  await billingPartOf(env, org).setPlan(plan);
  // The Worker under test runs in this isolate: it must see the change at once, not after the cache's time.
  forgetBilling(org);
};

/**
 * Puts `org` on Pay as you go as Polar's webhook would once its checkout is paid: its customer `cus_1` and its active
 * subscription `subscriptionId`, changed at `changedAt` (epoch ms).
 */
export const startPayAsYouGo = async (
  env: BillingBindings,
  org: OrgId,
  changedAt: number,
  subscriptionId = "sub_1",
): Promise<void> => {
  await billingPartOf(env, org).applySubscription({
    status: "active",
    subscriptionId,
    customerId: "cus_1",
    changedAt,
  });
  forgetBilling(org);
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

/** Polar's settings as the test Worker binds them (vitest.config.ts): webhooks are signed with this secret. */
export const TEST_POLAR = {
  webhookSecret: "polar_whs_test-secret",
  productId: "prod_payg",
} as const;

/** What a {@link fakeBillingProvider} was asked, in order. */
export interface FakeCall {
  readonly call: keyof BillingProvider;
  readonly input: unknown;
}

/**
 * A billing provider that answers from memory, the way Polar would: `counted` keeps the meter events it took by their
 * external id, so an event sent again is not counted twice. `failing` makes the named calls fail as when Polar cannot
 * be reached (`unavailable`, no answer), `refusing` as when it refuses them for good (a 404), `emailTaken` makes
 * customer creation fail as Polar does for an email another customer has, and `answersLost` makes Polar take meter
 * events but the answer never arrive (the call fails after the events were counted).
 */
export const fakeBillingProvider = () => {
  const calls: Array<FakeCall> = [];
  const counted = new Map<string, MeterEvent>();
  const failing = new Set<keyof BillingProvider>();
  const refusing = new Set<keyof BillingProvider>();
  const state = { emailTaken: false, paymentMethod: false, answersLost: false, customers: 0 };

  const record = <I, A>(call: keyof BillingProvider, input: I, answer: () => A) =>
    Effect.suspend(() => {
      calls.push({ call, input });

      if (refusing.has(call))
        return Effect.fail(
          new BillingProviderError({
            reason: "unavailable",
            message: `fake ${call} refused`,
            status: 404,
          }),
        );

      return failing.has(call)
        ? Effect.fail(
            new BillingProviderError({ reason: "unavailable", message: `fake ${call} failed` }),
          )
        : Effect.sync(answer);
    });

  const provider: BillingProvider = {
    createCustomer: (input) =>
      state.emailTaken
        ? Effect.fail(new BillingProviderError({ reason: "email_taken", message: "taken" }))
        : record("createCustomer", input, () => `cus_${(state.customers += 1)}`),
    startCheckout: (input) =>
      record("startCheckout", input, () => `https://polar.test/checkout/${input.customerId}`),
    portalUrl: (input) =>
      record("portalUrl", input, () => `https://polar.test/portal/${input.customerId}`),
    hasPaymentMethod: (customerId) =>
      record("hasPaymentMethod", customerId, () => state.paymentMethod),
    sendMeterEvents: (customerId, events) =>
      record("sendMeterEvents", { customerId, events }, () => {
        for (const event of events)
          if (!counted.has(event.externalId)) counted.set(event.externalId, event);
      }).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            state.answersLost
              ? Effect.fail(
                  new BillingProviderError({ reason: "unavailable", message: "fake: answer lost" }),
                )
              : Effect.void,
          ),
        ),
      ),
    cancelSubscription: (subscriptionId) =>
      record("cancelSubscription", subscriptionId, () => undefined),
    verifyWebhook: (request) =>
      request.headers["x-fake-signature"] === "valid"
        ? Effect.succeed(readWebhook(TEST_POLAR.productId, request.body))
        : Effect.fail(new WebhookRefused({ message: "fake: unsigned" })),
  };

  /** What Polar counted of `unit`, summed over the events it took. */
  const total = (unit: MeterEvent["unit"]): number =>
    [...counted.values()]
      .filter((event) => event.unit === unit)
      .reduce((sum, event) => sum + event.amount, 0);

  return { provider, calls, counted, failing, refusing, state, total };
};

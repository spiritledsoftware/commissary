/**
 * Billing's step of deleting an org (ADR 0027, ADR 0042, #134 "Org deletion and crons"): what Billing keeps outside the
 * org's ControlPlane is its Polar customer's subscription. The step sends the usage not sent yet and cancels the
 * subscription at the end of its period, so Polar still invoices the usage sent; deletion does not wait for any
 * payment. The plan and the counters are tables of the Billing part, which go with `wipeOrg`. The app Worker's org
 * deletion (`platform/org-deletion.ts`) runs it with the other areas' steps, before the ControlPlane is wiped.
 *
 * Without a billing provider there is nothing to do. A failure that may pass (the part cannot be reached, or the
 * provider is rate limited, answers 5xx or does not answer) makes the step answer `complete: false` (logged), and it
 * runs again with the next deletion request: it is safe to repeat (a batch sent again is not counted twice, and
 * cancelling an ended subscription is not an error). A refusal that trying again cannot change (a 4xx: the customer or
 * the subscription was deleted in Polar by hand, for one) is logged with the org's id and the step answers
 * `complete: true`, so such an org can still be deleted; what is left in Polar is for a person to settle.
 */
import { Clock, Effect } from "effect";
import type { OrgDeletionProgress, OrgDeletionStep, OrgId } from "@commissary/core";
import { type BillingBindings, BillingEnv, callPart } from "./env.ts";
import { type BillingProvider, BillingProviderError, isPermanentRefusal } from "./provider.ts";
import { BillingProviders } from "./providers.ts";
import { sendUsage } from "./send-usage.ts";

/** The calls one run makes at most: the part three or four times, the provider twice. */
const CALLS = 6;

const deleteOrgBilling = (
  env: BillingBindings,
  provider: BillingProvider,
  org: OrgId,
  budget: number,
): Effect.Effect<OrgDeletionProgress> =>
  Effect.gen(function* () {
    if (budget < CALLS) return { complete: false, calls: 0, part: "billing" } as const;
    const now = yield* Clock.currentTimeMillis;
    const billing = yield* callPart(env, org, "usage", (part) => part.usage(now));

    yield* sendUsage(env, provider, org);

    if (billing.subscriptionId !== null) {
      yield* provider.cancelSubscription(billing.subscriptionId);
      yield* callPart(env, org, "end subscription", (part) => part.endSubscription(now));
    }

    return { complete: true, calls: CALLS } as const;
  }).pipe(
    Effect.catch((error): Effect.Effect<OrgDeletionProgress> =>
      error instanceof BillingProviderError && isPermanentRefusal(error)
        ? Effect.logError(
            `org deletion: billing of org ${org} left unsettled in the provider, which refused: ${error.message}`,
          ).pipe(Effect.as({ complete: true, calls: CALLS } as const))
        : Effect.logError(`org deletion: billing of org ${org} not settled: ${error.message}`).pipe(
            Effect.as({ complete: false, calls: CALLS, part: "billing" } as const),
          ),
    ),
  );

/** Billing's step over the invocation's bindings, billing provider and services (its logger and clock). */
export const orgDeletionStep: Effect.Effect<OrgDeletionStep, never, BillingEnv> = Effect.gen(
  function* () {
    const env = yield* BillingEnv;
    const provider = (yield* BillingProviders)(env);
    const context = yield* Effect.context<never>();

    const step: OrgDeletionStep =
      provider === undefined
        ? () => Promise.resolve({ complete: true, calls: 0 })
        : (org, budget) =>
            Effect.runPromiseWith(context)(deleteOrgBilling(env, provider, org, budget));

    return step;
  },
);

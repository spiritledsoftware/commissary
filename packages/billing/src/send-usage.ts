/**
 * Sending an org's usage above free usage to the billing provider (ADR 0042, #237), shared by the cron task
 * (`scheduled-tasks.ts`), an owner's switch to Free (`routes.ts`) and org deletion (`org-deletion.ts`): the org's
 * Billing part answers the batch not sent yet (`BillingStore.meterBatch`: the one on its way first, with the same ids,
 * so a batch sent again is not counted twice), the provider takes it, and the part records it as sent. New in the
 * Workers port, no Go counterpart.
 */
import { Clock, Effect } from "effect";
import type { OrgId } from "@commissary/core";
import { type BillingBindings, type BillingPartUnavailable, callPart } from "./env.ts";
import type { BillingProvider, BillingProviderError } from "./provider.ts";

/** Sends what `org` has not sent yet; answers whether there was anything to send. */
export const sendUsage = (
  env: BillingBindings,
  provider: BillingProvider,
  org: OrgId,
): Effect.Effect<boolean, BillingProviderError | BillingPartUnavailable> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const batch = yield* callPart(env, org, "meter batch", (part) => part.meterBatch(now));

    if (batch === null) return false;

    yield* provider.sendMeterEvents(batch.customerId, batch.events);
    yield* callPart(env, org, "meter batch sent", (part) => part.meterBatchSent(batch.id));

    return true;
  });

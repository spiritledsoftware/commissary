/**
 * Billing's cron task (#134 "Org deletion and crons", #237), run by the API Worker's cron runner
 * (`apps/api/src/scheduled.ts`) for every org: the usage above free usage an org has not sent to the billing provider
 * yet goes to it (`send-usage.ts`; only orgs with a Polar customer have any). Polar files the events into the billing
 * period it receives them in (ADR 0042). After each batch the task pauses {@link SEND_PAUSE}, so the runner, which runs
 * the orgs one after another, stays under Polar's 500 requests a minute; a batch Polar refuses (a rate limit, an
 * outage) stays pending and goes, with the same ids, on the next run. Without a billing provider the task does nothing.
 */
import { Duration, Effect } from "effect";
import { CurrentOrg, type ScheduledTask } from "@commissary/core";
import { BillingEnv } from "./env.ts";
import { BillingProviders } from "./providers.ts";
import { sendUsage } from "./send-usage.ts";

/** At most one batch per 120 ms: 500 a minute, Polar's limit. */
export const SEND_PAUSE = Duration.millis(120);

/** What Billing's task reads besides the org: the bindings. */
export type ScheduledTaskServices = BillingEnv;

export const scheduledTasks: ReadonlyArray<ScheduledTask<ScheduledTaskServices>> = [
  {
    name: "billing-meter-events",
    scope: "org",
    run: Effect.gen(function* () {
      const env = yield* BillingEnv;
      const provider = (yield* BillingProviders)(env);

      if (provider === undefined) return;

      const sent = yield* sendUsage(env, provider, yield* CurrentOrg);

      if (sent) yield* Effect.sleep(SEND_PAUSE);
    }),
  },
];

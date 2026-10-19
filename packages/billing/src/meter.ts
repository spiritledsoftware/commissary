/**
 * Counting requests against free usage, and the plan limit (ADR 0042): Models calls {@link countRequest} when it starts
 * serving a client API request. On Commissary Cloud it counts the request in the org's Billing part and, for a Free org
 * whose requests and tool calls of the month are used up, refuses it with {@link PlanLimitReached} (`429
 * plan_limit_reached`, `Retry-After` until the first of the next month UTC); work in flight finishes. On a self-hosted
 * Commissary it does nothing. A request the plan refuses is not counted, and one that a spend limit refuses after all
 * is taken back ({@link uncountRequest}). New in the Workers port, no Go counterpart.
 *
 * The count is one atomic step of the org's ControlPlane (`BillingStore.admit`), so concurrent requests cannot pass the
 * limit together beyond what is in flight. A Billing part that cannot be reached lets the request through (logged):
 * serving needs the same object, so a refusal here would add nothing.
 */
import { Clock, Effect, Schema } from "effect";
import { CurrentOrg, type OrgId } from "@commissary/core";
import { isHosted } from "@commissary/auth";
import { platformOf } from "@commissary/state";
import { type BillingBindings, BillingEnv, billingPartOf } from "./env.ts";

export const PLAN_LIMIT_REACHED = "plan_limit_reached";

/** A Free org used up its free usage for the month. */
export class PlanLimitReached extends Schema.TaggedError<PlanLimitReached>()("PlanLimitReached", {
  /** Names the limit and links to the billing page; safe to show. */
  message: Schema.String,
  /** The month's free usage of requests and tool calls, and the seconds until it starts over (at least 1). */
  allowed: Schema.Number,
  retryAfterSeconds: Schema.Number,
  /** ISO time of the first of the next month. */
  resetsAt: Schema.String,
}) {
  /** The JSON error body, in the shape of `spend_limit_reached`'s. */
  get body(): string {
    return JSON.stringify({
      error: {
        code: PLAN_LIMIT_REACHED,
        message: this.message,
        limit: "requests",
        allowed: this.allowed,
        resets_at: this.resetsAt,
        reset_seconds: this.retryAfterSeconds,
      },
    });
  }
}

/** A request counted against a month (epoch ms of its start); `undefined` stands for one nothing was counted for. */
export interface CountedRequest {
  readonly monthStart: number;
}

/** Where the panel's billing page of `org` is: the app host's URL when it is known, else the path. */
const billingPage = (env: BillingBindings, org: OrgId): Effect.Effect<string> =>
  Effect.tryPromise(async () => await platformOf(env).getOrgById(org)).pipe(
    Effect.map((record) => {
      if (record === undefined) return "the billing page of the panel";

      const path = `/orgs/${record.slug}/billing`;
      const host = (env.APP_DOMAIN ?? "").trim();

      return host === "" ? path : `https://${host}${path}`;
    }),
    Effect.catch(() => Effect.succeed("the billing page of the panel")),
  );

const groups = new Intl.NumberFormat("en-US");

/**
 * A request of the current org starts being served: counts it, or fails with {@link PlanLimitReached}. Succeeds with
 * what to take back ({@link uncountRequest}), `undefined` where nothing was counted (a self-hosted Commissary, or a
 * Billing part that could not be reached).
 */
export const countRequest: Effect.Effect<
  CountedRequest | undefined,
  PlanLimitReached,
  BillingEnv | CurrentOrg
> = Effect.gen(function* () {
  const env = yield* BillingEnv;

  if (!isHosted(env)) return undefined;
  const org = yield* CurrentOrg;
  const now = yield* Clock.currentTimeMillis;

  const admission = yield* Effect.tryPromise(
    async () => await billingPartOf(env, org).admit(now),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`request not counted: ${error.message}`).pipe(Effect.as(undefined)),
    ),
  );

  if (admission === undefined) return undefined;

  if (admission.ok) return { monthStart: admission.monthStart };

  const { limit } = admission;
  const resetsAt = new Date(limit.resetsAt).toISOString();
  const page = yield* billingPage(env, org);

  return yield* new PlanLimitReached({
    message: `The Free plan's ${groups.format(limit.allowed)} requests and tool calls a month are used up; free usage starts over at ${resetsAt}. Plan and usage: ${page}`,
    allowed: limit.allowed,
    retryAfterSeconds: limit.retryAfterSeconds,
    resetsAt,
  });
});

/** Takes back a request {@link countRequest} counted (one a spend limit refused after all); never fails. */
export const uncountRequest = (
  counted: CountedRequest | undefined,
): Effect.Effect<void, never, BillingEnv | CurrentOrg> =>
  Effect.gen(function* () {
    if (counted === undefined) return;
    const env = yield* BillingEnv;
    const org = yield* CurrentOrg;

    yield* Effect.tryPromise(
      async () => await billingPartOf(env, org).refund(counted.monthStart),
    ).pipe(Effect.catch((error) => Effect.logWarning(`request not taken back: ${error.message}`)));
  });

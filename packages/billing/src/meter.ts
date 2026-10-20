/**
 * Counting requests against free usage, and the plan limit (ADR 0042): Models calls {@link countRequest} when it starts
 * serving a client API request. On Commissary Cloud it counts the request in the org's Billing part and, for a Free org
 * whose requests and tool calls of the month are used up, refuses it with {@link PlanLimitReached} (`429
 * plan_limit_reached`, `Retry-After` until the first of the next month UTC), and so for a Pay-as-you-go org whose
 * payment failed (Polar marked its subscription past due), which is held to Free's limits until a payment succeeds;
 * work in flight finishes. On a self-hosted Commissary it does nothing. A request the plan refuses is not counted, and
 * one that did no work (no upstream attempt: a spend limit, an unknown model, no credential) is taken back
 * ({@link uncountRequest}). New in the Workers port, no Go counterpart.
 *
 * The count is one atomic step of the org's ControlPlane (`BillingStore.admit`), so concurrent requests cannot pass the
 * limit together beyond what is in flight. An org the plan refused stays refused in the isolate for a short while
 * (`cache.ts`), so a client that retries against the limit does not reach the ControlPlane. A Billing part that cannot
 * be reached lets the request through (logged): serving needs the same object, so a refusal here would add nothing.
 */
import { Clock, Effect, Schema } from "effect";
import { CurrentOrg, type OrgId } from "@commissary/core";
import { isHosted } from "@commissary/auth";
import { panelPageUrl } from "@commissary/state";
import { BILLING_TTL_MS, type CachedRefusal, refusals } from "./cache.ts";
import { type BillingBindings, BillingEnv, billingPartOf } from "./env.ts";

export const PLAN_LIMIT_REACHED = "plan_limit_reached";

/** A Free org used up its free usage for the month. */
export class PlanLimitReached extends Schema.TaggedError<PlanLimitReached>()("PlanLimitReached", {
  /** Names the limit and links to the billing page; safe to show. */
  message: Schema.String,
  /** The month's free usage of requests and tool calls. */
  allowed: Schema.Number,
  /** The seconds until free usage starts over (at least 1). */
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

/**
 * Where the panel's billing page of `org` is (`panelPageUrl`): asked once per refusal ({@link refusals} keeps the
 * answer), never for a request that is served.
 */
const billingPage = (env: BillingBindings, org: OrgId): Effect.Effect<string> =>
  panelPageUrl(env, org, "billing", "the billing page of the panel");

const groups = new Intl.NumberFormat("en-US");

/** The refusal of a request at `now`: what the month allows, when it starts over and where to see usage. */
const refused = (refusal: CachedRefusal, now: number): PlanLimitReached => {
  const resetsAt = new Date(refusal.resetsAt).toISOString();

  const held = refusal.pastDue
    ? "A payment failed: Pay as you go is held to the Free plan's limits until a payment succeeds, and the"
    : "The";

  return new PlanLimitReached({
    message: `${held} Free plan's ${groups.format(refusal.allowed)} requests and tool calls a month are used up; free usage starts over at ${resetsAt}. Plan and usage: ${refusal.page}`,
    allowed: refusal.allowed,
    retryAfterSeconds: Math.max(1, Math.ceil((refusal.resetsAt - now) / 1000)),
    resetsAt,
  });
};

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
  const known = refusals.get(org, now);

  // An org the plan refused a moment ago is refused again without asking its ControlPlane.
  if (known !== undefined) return yield* refused(known, now);

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
  const page = yield* billingPage(env, org);

  const refusal = {
    allowed: limit.allowed,
    resetsAt: limit.resetsAt,
    page,
    pastDue: limit.pastDue,
  };

  refusals.set(org, refusal, Math.min(limit.resetsAt, now + BILLING_TTL_MS));

  return yield* refused(refusal, now);
});

/** Takes back a request {@link countRequest} counted (one that did no work); never fails. */
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

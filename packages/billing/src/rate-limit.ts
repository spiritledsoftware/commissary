/**
 * The per-org request-rate ceiling of Commissary Cloud's client API, by plan (ADR 0026, ADR 0042): two Workers
 * rate-limiting bindings, `FREE_RATE_LIMIT` (60 a minute) and `PAYG_RATE_LIMIT` (600 a minute; the numbers are
 * `REQUEST_RATE_CEILING` in `plan.ts`, set where the bindings are declared, `alchemy.run.ts`), the one the org's plan
 * picks, keyed by the org so one org's traffic never slows another's. A binding counts per Cloudflare location and is
 * eventually consistent: a ceiling against abuse, not exact accounting. It covers every client-facing surface (the
 * client API, the MCP endpoint and hosted agents' proven webhook deliveries); the management API has none.
 *
 * Webhook deliveries are also counted before their proof is checked, on a bucket of their own in the same bindings
 * (`limitWebhookAttempts`, key `webhook:<org>`, the same size as the org's ceiling): a flood of unproven deliveries is
 * refused there without loading the org's ControlPlane, and never uses up the ceiling its API keys count against.
 *
 * The bindings' limits are fixed, so an org whose rate a platform admin raised above its plan's (#240) is counted by
 * its own ControlPlane instead (`BillingStore.admitRate`): one call per request for that org only; every other org
 * keeps the bindings.
 *
 * The org's ceiling is cached per isolate for a short while (`cache.ts`), so a request on a binding costs no
 * ControlPlane call here. A deployment without the bindings has no ceiling, raised or not; a failing binding or
 * ControlPlane lets the request through (logged), since refusing every org would be worse; an org whose ceiling cannot
 * be read gets Free's (logged).
 */
import { Clock, Effect } from "effect";
import { RateLimitedError, type OrgId } from "@commissary/core";
import { isHosted } from "@commissary/auth";
import { BILLING_TTL_MS, rateCeilings } from "./cache.ts";
import { type BillingBindings, BillingEnv, billingPartOf, type RateLimiter } from "./env.ts";
import { DEFAULT_PLAN, RATE_LIMIT_PERIOD_SECONDS } from "./plan.ts";
import type { RateCeiling } from "./store.ts";

export const RATE_LIMITED = "Rate limit exceeded";

/**
 * The request-rate ceiling of the org (its plan's, Free's while it is past due, or a raised one), cached per isolate
 * for `BILLING_TTL_MS` (a change applies within that time); Free's (logged, not cached) when it cannot be read.
 */
const ceilingOf = (org: OrgId): Effect.Effect<RateCeiling, never, BillingEnv> =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;
    const now = yield* Clock.currentTimeMillis;
    const cached = rateCeilings.get(org, now);

    if (cached !== undefined) return cached;

    const ceiling = yield* Effect.tryPromise(
      async () => await billingPartOf(env, org).rateCeiling(),
    ).pipe(
      Effect.tap((read) => Effect.sync(() => rateCeilings.set(org, read, now + BILLING_TTL_MS))),
      Effect.catch((error) =>
        Effect.logWarning(`rate ceiling not read: ${error.message}`).pipe(
          Effect.as<RateCeiling>({ plan: DEFAULT_PLAN, raised: null }),
        ),
      ),
    );

    return ceiling;
  });

/**
 * Whether the org's ControlPlane admits a request against its raised rate; through (logged) when it cannot be asked.
 */
const withinRaised = (org: OrgId): Effect.Effect<boolean, never, BillingEnv> =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;
    const now = yield* Clock.currentTimeMillis;

    return yield* Effect.tryPromise(async () => await billingPartOf(env, org).admitRate(now)).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`raised rate not checked: ${error.message}`).pipe(Effect.as(true)),
      ),
    );
  });

/**
 * Whether the plan's binding admits a request counted under `key` (an org id, or an org's webhook bucket); through when
 * it is not bound, or fails (logged).
 */
const onBinding = (limiter: RateLimiter | undefined, key: string): Effect.Effect<boolean> =>
  limiter === undefined
    ? Effect.succeed(true)
    : Effect.tryPromise(async () => await limiter.limit({ key })).pipe(
        Effect.map((outcome) => outcome.success),
        Effect.catch((error) =>
          Effect.logWarning(`rate limit not checked: ${error.message}`).pipe(Effect.as(true)),
        ),
      );

const rateLimited = () =>
  new RateLimitedError({ message: RATE_LIMITED, retryAfterSeconds: RATE_LIMIT_PERIOD_SECONDS });

/** Whether the deployment counts rates at all: Commissary Cloud with at least one binding. */
const counts = (env: BillingBindings): boolean =>
  isHosted(env) && (env.FREE_RATE_LIMIT !== undefined || env.PAYG_RATE_LIMIT !== undefined);

/**
 * Counts a request of `org` against its ceiling (its plan's, or a raised one); over it, `429 Rate limit exceeded` with
 * `Retry-After`. Does nothing on a self-hosted Commissary.
 */
export const limitClientRate = (org: OrgId): Effect.Effect<void, RateLimitedError, BillingEnv> =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;

    if (!counts(env)) return;
    const ceiling = yield* ceilingOf(org);

    const success =
      ceiling.raised === null
        ? yield* onBinding(ceiling.plan === "payg" ? env.PAYG_RATE_LIMIT : env.FREE_RATE_LIMIT, org)
        : yield* withinRaised(org);

    if (!success) return yield* rateLimited();
  });

/**
 * Counts a webhook delivery to `org` before its proof is checked, on the org's webhook bucket (key `webhook:<org>` in
 * the plan's binding, the size of the org's ceiling; Pay as you go's for an org with a raised ceiling, which the
 * bindings cannot hold, so that an unproven delivery never costs a ControlPlane call); over it, `429`. The org's
 * ceiling itself counts only proven deliveries (`limitClientRate`). Does nothing on a self-hosted Commissary.
 */
export const limitWebhookAttempts = (
  org: OrgId,
): Effect.Effect<void, RateLimitedError, BillingEnv> =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;

    if (!counts(env)) return;
    const ceiling = yield* ceilingOf(org);

    const limiter =
      ceiling.plan === "payg" || ceiling.raised !== null
        ? env.PAYG_RATE_LIMIT
        : env.FREE_RATE_LIMIT;

    if (!(yield* onBinding(limiter, `webhook:${org}`))) return yield* rateLimited();
  });

/**
 * The per-org request-rate ceiling of Commissary Cloud's client API, by plan (ADR 0026, ADR 0042): two Workers
 * rate-limiting bindings, `FREE_RATE_LIMIT` (60 a minute) and `PAYG_RATE_LIMIT` (600 a minute; the numbers are
 * `REQUEST_RATE_CEILING` in `plan.ts`, set where the bindings are declared, `alchemy.run.ts`), the one the org's plan
 * picks, keyed by the org so one org's traffic never slows another's. A binding counts per Cloudflare location and is
 * eventually consistent: a ceiling against abuse, not exact accounting. It covers every client-facing surface (the
 * client API now; the MCP endpoint and webhook triggers when they exist); the management API has none.
 *
 * A deployment without the binding has no ceiling; a failing binding lets the request through (logged), since refusing
 * every org would be worse; an org whose plan cannot be read gets Free's ceiling (logged).
 */
import { Effect } from "effect";
import { RateLimitedError, type OrgId } from "@commissary/core";
import { isHosted } from "@commissary/auth";
import { BillingEnv, billingPartOf } from "./env.ts";
import { DEFAULT_PLAN, type Plan, RATE_LIMIT_PERIOD_SECONDS } from "./plan.ts";

export const RATE_LIMITED = "Rate limit exceeded";

/** The org's plan; Free's (logged) when it cannot be read. */
const planOf = (org: OrgId): Effect.Effect<Plan, never, BillingEnv> =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;

    return yield* Effect.tryPromise(async () => await billingPartOf(env, org).plan()).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`plan not read for the rate limit: ${error.message}`).pipe(
          Effect.as(DEFAULT_PLAN),
        ),
      ),
    );
  });

/**
 * Counts a request of `org` against its plan's ceiling; over it, `429 Rate limit exceeded` with `Retry-After`. Does
 * nothing on a self-hosted Commissary.
 */
export const limitClientRate = (org: OrgId): Effect.Effect<void, RateLimitedError, BillingEnv> =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;

    if (!isHosted(env) || (env.FREE_RATE_LIMIT === undefined && env.PAYG_RATE_LIMIT === undefined))
      return;

    const limiter = (yield* planOf(org)) === "payg" ? env.PAYG_RATE_LIMIT : env.FREE_RATE_LIMIT;

    if (limiter === undefined) return;

    const outcome = yield* Effect.tryPromise(async () => await limiter.limit({ key: org })).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`rate limit not checked: ${error.message}`).pipe(
          Effect.as({ success: true }),
        ),
      ),
    );

    if (!outcome.success)
      return yield* new RateLimitedError({
        message: RATE_LIMITED,
        retryAfterSeconds: RATE_LIMIT_PERIOD_SECONDS,
      });
  });

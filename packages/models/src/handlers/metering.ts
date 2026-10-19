/**
 * Counting a client API request against the org's free usage when Models starts serving it, and the plan limit that
 * refuses it on Commissary Cloud (ADR 0042; `@commissary/billing`'s `countRequest`, which does nothing on a self-hosted
 * Commissary). A request counts once however many credentials it tries, and whatever its outcome; one a spend limit
 * refuses (the first pick answers `spend_limit_reached`) is taken back, since it did no work. New in the Workers port,
 * no Go counterpart.
 */
import { Effect } from "effect";
import {
  type BillingEnv,
  type CountedRequest,
  countRequest,
  PLAN_LIMIT_REACHED,
  type PlanLimitReached,
  uncountRequest,
} from "@commissary/billing/api";
import type { CurrentOrg } from "@commissary/core";
import { ExecutionError } from "../executor/errors.ts";

/** `429 plan_limit_reached`: a Free org used up its free usage (JSON body and `Retry-After` until the month ends). */
export const planLimitError = (refused: PlanLimitReached): ExecutionError =>
  new ExecutionError({
    status: 429,
    code: PLAN_LIMIT_REACHED,
    message: refused.body,
    retryAfterMs: refused.retryAfterSeconds * 1000,
    safeHeaders: { "retry-after": String(refused.retryAfterSeconds) },
  });

/** Whether `error` is a spend limit's refusal, which did no work and so is not counted. */
export const refusedBySpendLimit = (error: ExecutionError): boolean =>
  error.code === "spend_limit_reached";

/**
 * Counts the request the execution serves, or refuses it with {@link planLimitError} before any work; takes the count
 * back when the execution ends in a spend limit's refusal.
 */
export const metered = <A, E, R>(
  execution: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ExecutionError, R | BillingEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const counted = yield* countRequest.pipe(Effect.mapError(planLimitError));

    return yield* execution.pipe(
      Effect.tapError((error) =>
        error instanceof ExecutionError ? uncountedWhenRefused(counted, error) : Effect.void,
      ),
    );
  });

/** Takes the count back when `error` is a spend limit's refusal. */
export const uncountedWhenRefused = (
  counted: CountedRequest | undefined,
  error: ExecutionError,
): Effect.Effect<void, never, BillingEnv | CurrentOrg> =>
  refusedBySpendLimit(error) ? uncountRequest(counted) : Effect.void;

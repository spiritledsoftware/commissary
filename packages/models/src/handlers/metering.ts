/**
 * Counting a client API request against the org's free usage when Models starts serving it, and the plan limit that
 * refuses it on Commissary Cloud (ADR 0042; `@commissary/billing`'s `countRequest`, which does nothing on a self-hosted
 * Commissary). A request counts once however many credentials it tries, and whatever its outcome once an upstream
 * attempt was made; one that made none (a spend limit, an unknown model or provider, no credential to pick) did no work
 * and is taken back. Only requests count: token counting and polling a video are not (GLOSSARY "Request"), and a body
 * that does not parse never reaches execution. New in the Workers port, no Go counterpart.
 */
import { Context, Effect, Option } from "effect";
import {
  type BillingEnv,
  countRequest,
  PLAN_LIMIT_REACHED,
  type PlanLimitReached,
  uncountRequest,
} from "@commissary/billing/api";
import type { CurrentOrg } from "@commissary/core";
import { ExecutionError } from "../executor/errors.ts";

/**
 * `429 plan_limit_reached`: a Free org used up its free usage, or a Pay-as-you-go org reached its billing cap (JSON
 * body and `Retry-After` until the month ends).
 */
export const planLimitError = (refused: PlanLimitReached): ExecutionError =>
  new ExecutionError({
    status: 429,
    code: PLAN_LIMIT_REACHED,
    message: refused.body,
    retryAfterMs: refused.retryAfterSeconds * 1000,
    safeHeaders: { "retry-after": String(refused.retryAfterSeconds) },
  });

/** What a metered execution knows of the request it serves: whether any upstream attempt has been made. */
class RequestMeter extends Context.Service<RequestMeter, { worked: boolean }>()(
  "commissary/models/RequestMeter",
) {}

/** The conductor made an upstream attempt for the request being metered (if any): the request did work, so it stays counted. */
export const markWorked: Effect.Effect<void> = Effect.serviceOption(RequestMeter).pipe(
  Effect.map((meter) => {
    if (Option.isSome(meter)) meter.value.worked = true;
  }),
);

/**
 * Counts the request the execution serves, or refuses it with {@link planLimitError} before any work; takes the count
 * back when the execution fails without an upstream attempt having been made.
 */
export const metered = <A, E, R>(
  execution: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ExecutionError, R | BillingEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const counted = yield* countRequest.pipe(Effect.mapError(planLimitError));
    const meter = { worked: false };

    return yield* execution.pipe(
      Effect.provideService(RequestMeter, meter),
      Effect.onError(() => (meter.worked ? Effect.void : uncountRequest(counted))),
    );
  });

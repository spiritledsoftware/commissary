/**
 * `/v9/management/billing` (`BillingGroup` in @commissary/contract/billing): the org's plan and this month's usage
 * against free usage, in each unit. Workers addition, no Go counterpart.
 *
 * Commissary Cloud only: on a self-hosted Commissary the route answers like a path the router does not know, so nothing
 * of Billing is reachable there. Any org admin may read it (the role table's default for a route without an entry,
 * `apps/app/src/management/policy.ts`). Units not counted yet read 0.
 */
import { Clock, Effect } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest } from "effect/http";
import { isHosted } from "@commissary/auth";
import type { BillingView } from "@commissary/contract/billing";
import { handled, jsonReply } from "@commissary/core";
import { BillingEnv, billingControlPlane } from "./env.ts";
import { FREE_USAGE } from "./plan.ts";
import type { BillingUsage } from "./store.ts";

const BASE = "/v9/management";

const iso = (ms: number): string => new Date(ms).toISOString();

export const billingView = (billing: BillingUsage): BillingView => ({
  plan: billing.plan,
  month_start: iso(billing.monthStart),
  resets_at: iso(billing.monthEnd),
  usage: {
    requests: { used: billing.used.requests, free: FREE_USAGE.requests },
    browser_hours: { used: billing.used.browserHours, free: FREE_USAGE.browserHours },
    computer_hours: { used: billing.used.computerHours, free: FREE_USAGE.computerHours },
  },
});

const overview = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const billing = yield* billingControlPlane("billing", (stub) => stub.billing().usage(now));

  return jsonReply(200, billingView(billing));
});

/** Answers like a path the router does not know (`apps/app/src/http/not-found.ts` turns that into the plain 404). */
const routeNotFound = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return yield* new HttpServerError.HttpServerError({
    reason: new HttpServerError.RouteNotFound({ request }),
  });
});

/** Runs the route on Commissary Cloud only. */
const hostedOnly = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return isHosted(yield* BillingEnv) ? yield* handler : yield* routeNotFound;
  });

export const BillingRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", `${BASE}/billing`, hostedOnly(handled(overview))),
]);

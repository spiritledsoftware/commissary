/**
 * `@commissary/billing/api`, Billing's entry for the Workers that serve the client API and for the areas that count
 * what the plans count (#134 "The area package convention"): the request-rate ceiling per plan, counting a request
 * against free usage and its plan limit, and its view of `env`. Everything here does nothing on a self-hosted
 * Commissary. The apps import Billing only through this entry, `./management`, `./state` and (in tests) `./testing`
 * (the lint rule `boundaries/billing-imports`).
 */
export {
  type BillingBindings,
  type BillingControlPlane,
  BillingEnv,
  type RateLimiter,
} from "./env.ts";

export {
  type CountedRequest,
  countRequest,
  PLAN_LIMIT_REACHED,
  PlanLimitReached,
  uncountRequest,
} from "./meter.ts";

export { limitClientRate, RATE_LIMITED } from "./rate-limit.ts";

export { RATE_LIMIT_PERIOD_SECONDS, REQUEST_RATE_CEILING } from "./plan.ts";

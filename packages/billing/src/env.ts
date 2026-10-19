/**
 * What `@commissary/billing` reads from a Worker's env (#134 "How packages get their bindings"). Each Worker provides
 * its own `env` as {@link BillingBindings}. Billing types `CONTROL_PLANE` as objects with its part
 * ({@link BillingControlPlane}): callers write `stub.billing().x(…)`.
 */
import { Context, Effect } from "effect";
import { type OrgId, type Reply, CurrentOrg } from "@commissary/core";
import { callControlPlane, controlPlaneOf, type StateBindings } from "@commissary/state";
import type { BillingPart } from "./part.ts";

/** The methods of the Billing part Billing calls. */
type BillingPartMethod = "plan" | "setPlan" | "usage" | "admit" | "refund";

/** The Billing part of an org's ControlPlane as Billing sees it: the methods it calls. */
export type BillingControlPlanePart = Pick<BillingPart, BillingPartMethod> & Rpc.RpcTargetBranded;

/** Billing's view of an org's ControlPlane: its part, reached in one pipelined round trip (`stub.billing().x(…)`). */
export interface BillingControlPlane extends Rpc.DurableObjectBranded {
  billing(): BillingControlPlanePart;
}

export type BillingControlPlaneStub = DurableObjectStub<BillingControlPlane>;

/**
 * The Workers rate-limiting binding as Billing calls it (`rate-limit.ts`); structural, so Billing needs no Workers
 * types of its own and the binding (`RateLimit`) satisfies it.
 */
export interface RateLimiter {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

export interface BillingBindings extends Pick<StateBindings, "PLATFORM"> {
  /** One ControlPlane per org, seen through {@link BillingControlPlane}. */
  readonly CONTROL_PLANE: DurableObjectNamespace<BillingControlPlane>;
  /** `cloud`: Commissary Cloud (ADR 0026). Billing does nothing on anything else. */
  readonly COMMISSARY_MODE?: string | undefined;
  /** Cloud: the request-rate ceiling of the Free plan (60 a minute, `plan.ts`), counted per org. Unbound: no ceiling. */
  readonly FREE_RATE_LIMIT?: RateLimiter | undefined;
  /** Cloud: the request-rate ceiling of Pay as you go (600 a minute). Unbound: no ceiling. */
  readonly PAYG_RATE_LIMIT?: RateLimiter | undefined;
  /** The app host, which the panel's billing page is at (`plan-limit.ts`); unset: the message names the path only. */
  readonly APP_DOMAIN?: string | undefined;
}

/**
 * The Billing bindings of the current Worker invocation. Provided per request through the `Context` handed to the web
 * handler (`requestContext`), never through a long-lived layer: bindings must not be captured across requests.
 */
export class BillingEnv extends Context.Service<BillingEnv, BillingBindings>()(
  "commissary/billing/BillingEnv",
) {}

/** The Billing part of `org`'s ControlPlane, reached in one pipelined round trip. */
export const billingPartOf = (env: BillingBindings, org: OrgId) =>
  controlPlaneOf(env, org).billing();

/** Calls the current org's ControlPlane from a Billing management route (`callControlPlane`). */
export const billingControlPlane = <R>(
  label: string,
  call: (stub: BillingControlPlaneStub) => R,
): Effect.Effect<Awaited<R>, Reply, BillingEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const stub = controlPlaneOf(yield* BillingEnv, yield* CurrentOrg);

    return yield* callControlPlane(label, stub, call);
  });

/**
 * `/v9/management/billing` (`BillingGroup` in @commissary/contract/billing). Workers addition, no Go counterpart.
 *
 * - `GET /billing`: the org's plan, its payment state, whether a card is on file, this month's usage against free
 *   usage in each unit (units not counted yet read 0), the billing cap, the month's bill so far and the notices of plan
 *   limits and a failed payment (`notices.ts`; the failed-payment notice carries no link, the panel asks
 *   `POST /billing/portal` when an owner follows it). Any org admin may read it (the role table's default for a route
 *   without an entry, `apps/app/src/management/policy.ts`).
 * - `PATCH /billing {billing_cap: <dollars> | null}` (#238): sets or removes the billing cap, in whole cents; org
 *   owners only ({@link accessRules}). It needs no billing provider: Commissary enforces the cap itself.
 * - `POST /billing/checkout`, `POST /billing/portal`, `POST /billing/plan {plan: "free"}` (#237): Pay as you go through
 *   the billing provider (Polar, `polar.ts`); org owners only ({@link accessRules}). Without the provider's settings
 *   they answer 404, like a path the router does not know.
 *
 * Commissary Cloud only: on a self-hosted Commissary every route answers 404, so nothing of Billing is reachable
 * there. A plan this isolate switches is forgotten by its caches at once (`forgetBilling`); other isolates (the API
 * Worker's) see it within `BILLING_TTL_MS`.
 */
import { Clock, Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest } from "effect/http";
import { type AccessRule, AccessPrincipal, isHosted } from "@commissary/auth";
import { BillingCap, type BillingView, SwitchBillingPlan } from "@commissary/contract/billing";
import {
  CurrentOrg,
  handled,
  jsonReply,
  type OrgId,
  type Reply,
  replyError,
} from "@commissary/core";
import { bodyJson, platformOf } from "@commissary/state";
import { forgetBilling } from "./cache.ts";
import {
  type BillingBindings,
  BillingEnv,
  type BillingPartUnavailable,
  billingControlPlane,
  callPart,
} from "./env.ts";
import { billingNotices } from "./notices.ts";
import { FREE_USAGE } from "./plan.ts";
import type { BillingProvider, BillingProviderError } from "./provider.ts";
import { BillingProviders } from "./providers.ts";
import { sendUsage } from "./send-usage.ts";
import type { BillingUsage } from "./store.ts";

const BASE = "/v9/management";

/**
 * The billing routes only org owners may call (ADR 0042: owners switch plans, change the payment method and set the
 * billing cap).
 */
export const accessRules: ReadonlyArray<AccessRule> = [
  { path: `${BASE}/billing`, methods: ["PATCH"], role: "owner" },
  { path: `${BASE}/billing/checkout`, role: "owner" },
  { path: `${BASE}/billing/portal`, role: "owner" },
  { path: `${BASE}/billing/plan`, role: "owner" },
];

const iso = (ms: number): string => new Date(ms).toISOString();

const billingView = (billing: BillingUsage, cardOnFile: boolean | null): BillingView => ({
  plan: billing.plan,
  payment: billing.payment,
  card_on_file: cardOnFile,
  month_start: iso(billing.monthStart),
  resets_at: iso(billing.monthEnd),
  usage: {
    requests: { used: billing.used.requests, free: FREE_USAGE.requests },
    browser_hours: { used: billing.used.browserHours, free: FREE_USAGE.browserHours },
    computer_hours: { used: billing.used.computerHours, free: FREE_USAGE.computerHours },
  },
  billing_cap: billing.billingCap,
  bill: billing.bill,
  notices: billingNotices(billing),
});

/** The billing provider of the invocation, `undefined` without one. */
const invocationProvider = Effect.flatMap(BillingEnv, (env) =>
  Effect.map(BillingProviders, (pick) => pick(env)),
);

const usageNow = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;

  return yield* billingControlPlane("billing", (stub) => stub.billing().usage(now));
});

/** Whether the org's customer has a card on file: `false` without one, `null` when the provider cannot say. */
const cardOnFile = (provider: BillingProvider | undefined, billing: BillingUsage) =>
  provider === undefined || billing.customerId === null
    ? Effect.succeed(false)
    : provider
        .hasPaymentMethod(billing.customerId)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`card on file not read: ${error.message}`).pipe(Effect.as(null)),
          ),
        );

/** What the billing routes answer of the org: {@link billingView} with whether a card is on file. */
const viewReply = (provider: BillingProvider | undefined, billing: BillingUsage) =>
  Effect.map(cardOnFile(provider, billing), (card) => jsonReply(200, billingView(billing, card)));

/** The request's JSON body decoded by `schema`, excess properties refused; `400 invalid body` saying `expected`. */
const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, expected: string) =>
  bodyJson.pipe(
    Effect.flatMap((value) =>
      Option.match(Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value), {
        onNone: () => Effect.fail(replyError(400, "invalid body", { message: expected })),
        onSome: (body: S["Type"]) => Effect.succeed(body),
      }),
    ),
  );

const overview = Effect.gen(function* () {
  const billing = yield* usageNow;

  return yield* viewReply(yield* invocationProvider, billing);
});

/** Answers like a path the router does not know (`apps/app/src/http/not-found.ts` turns that into the plain 404). */
export const routeNotFound = Effect.gen(function* () {
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

/** Runs `handler` with the billing provider; without one the route does not exist. */
const withProvider = <A, E, R>(handler: (provider: BillingProvider) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const provider = yield* invocationProvider;

    return provider === undefined ? yield* routeNotFound : yield* handler(provider);
  });

/** A provider failure as a reply: logged, never with its details. */
const providerUnavailable = (error: BillingProviderError): Effect.Effect<never, Reply> =>
  Effect.logError(error.message).pipe(
    Effect.andThen(
      Effect.fail(
        replyError(502, "billing_unavailable", {
          message: "the billing provider could not be reached; try again",
        }),
      ),
    ),
  );

/** A Billing part that cannot be reached, as a reply. */
const partUnavailable = (error: BillingPartUnavailable): Effect.Effect<never, Reply> =>
  Effect.logError(error.message).pipe(
    Effect.andThen(
      Effect.fail(
        replyError(502, "billing_state_unavailable", {
          message: "the org's billing state could not be reached; try again",
        }),
      ),
    ),
  );

/** The origin of an absolute URL, `""` for anything else. */
const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/** The org's panel billing page on the host the request came to, where Polar sends the owner back. */
const billingPage = (env: BillingBindings, org: OrgId) =>
  Effect.gen(function* () {
    const origin = originOf((yield* HttpServerRequest.HttpServerRequest).originalUrl);

    // Polar sends the owner back to an absolute URL on this host.
    if (origin === "" || origin === "null")
      return yield* replyError(400, "request_origin_unknown", {
        message: "the request's origin could not be read",
      });

    const record = yield* Effect.tryPromise(async () => await platformOf(env).getOrgById(org)).pipe(
      Effect.tapError((cause) =>
        Effect.logError(
          `billing: the platform registry could not be read: ${cause.cause instanceof Error ? cause.cause.message : "unknown error"}`,
        ),
      ),
      Effect.mapError(() =>
        replyError(502, "registry_unavailable", {
          message: "the org's record could not be read; try again",
        }),
      ),
    );

    if (record === undefined)
      return yield* replyError(502, "org_not_registered", {
        message: "the org was not found in the platform registry",
      });

    return { url: `${origin}/o/${encodeURIComponent(record.slug)}/billing`, name: record.name };
  });

const checkout = (provider: BillingProvider) =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;
    const org = yield* CurrentOrg;
    const identity = yield* AccessPrincipal;

    // The customer's billing email is the owner's: a person, not a token.
    if (identity.principal.kind !== "user")
      return yield* replyError(403, "person_required", {
        message: "only a person can start a checkout, not a token",
      });

    const email = identity.principal.email;
    const billing = yield* usageNow;

    if (billing.plan === "payg")
      return yield* replyError(409, "already_on_payg", {
        message: "the org is on Pay as you go; manage its payment method in the portal",
      });

    const page = yield* billingPage(env, org);

    const customerId =
      billing.customerId ??
      (yield* provider
        .createCustomer({ org, name: page.name, email })
        .pipe(
          Effect.tap((created) =>
            callPart(env, org, "customer", (part) => part.setCustomer(created)),
          ),
        ));

    const url = yield* provider.startCheckout({
      customerId,
      org,
      successUrl: page.url,
      returnUrl: page.url,
    });

    return jsonReply(200, { url });
  }).pipe(
    Effect.catchTag("BillingProviderError", (error) =>
      error.reason === "email_taken"
        ? Effect.fail(
            replyError(409, "billing_email_taken", {
              message: "your email is already the billing email of another org on Commissary Cloud",
            }),
          )
        : providerUnavailable(error),
    ),
    Effect.catchTag("BillingPartUnavailable", partUnavailable),
  );

const portal = (provider: BillingProvider) =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;
    const org = yield* CurrentOrg;
    const billing = yield* usageNow;

    if (billing.customerId === null)
      return yield* replyError(409, "no_billing_account", {
        message: "the org has no billing account yet: upgrade to Pay as you go first",
      });

    const page = yield* billingPage(env, org);
    const url = yield* provider.portalUrl({ customerId: billing.customerId, returnUrl: page.url });

    return jsonReply(200, { url });
  }).pipe(Effect.catchTag("BillingProviderError", providerUnavailable));

/**
 * Back to Free at once: sends the usage not sent yet (the open month's is still invoiced), cancels the subscription,
 * then puts the org on Free. A failure before the last step changes nothing.
 */
const switchPlan = (provider: BillingProvider) =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;
    const org = yield* CurrentOrg;

    const body = yield* decodeBody(
      SwitchBillingPlan,
      'expected {"plan": "free"}; upgrade through POST /billing/checkout',
    );

    const billing = yield* usageNow;

    if (billing.plan !== body.plan) {
      yield* sendUsage(env, provider, org);

      if (billing.subscriptionId !== null)
        yield* provider.cancelSubscription(billing.subscriptionId);

      const now = yield* Clock.currentTimeMillis;

      yield* callPart(env, org, "end subscription", (part) => part.endSubscription(now));
      forgetBilling(org);
    }

    return yield* viewReply(provider, yield* usageNow);
  }).pipe(
    Effect.catchTag("BillingProviderError", providerUnavailable),
    Effect.catchTag("BillingPartUnavailable", partUnavailable),
  );

/** `PATCH /billing`'s shape; the amount is checked apart ({@link isBillingCap}): a wrong one answers 422, not 400. */
const CapBody = Schema.Struct({ billing_cap: Schema.NullOr(Schema.Number) });

const isBillingCap = Schema.is(BillingCap);

/**
 * Sets or removes the billing cap; the org's next request sees it (this isolate forgets its refusal at once, the API
 * Worker's within `BILLING_CAP_REFUSAL_TTL_MS`).
 */
const setCap = Effect.gen(function* () {
  const env = yield* BillingEnv;
  const org = yield* CurrentOrg;

  const { billing_cap: cap } = yield* decodeBody(
    CapBody,
    'expected {"billing_cap": <dollars> | null}',
  );

  if (cap !== null && !isBillingCap(cap))
    return yield* replyError(422, "invalid_billing_cap", {
      message: "the billing cap is an amount of dollars from 0, in whole cents",
    });

  yield* callPart(env, org, "billing cap", (part) => part.setBillingCap(cap));
  forgetBilling(org);

  return yield* viewReply(yield* invocationProvider, yield* usageNow);
}).pipe(Effect.catchTag("BillingPartUnavailable", partUnavailable));

export const BillingRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", `${BASE}/billing`, hostedOnly(handled(overview))),
  HttpRouter.route("PATCH", `${BASE}/billing`, hostedOnly(handled(setCap))),
  HttpRouter.route(
    "POST",
    `${BASE}/billing/checkout`,
    hostedOnly(withProvider((provider) => handled(checkout(provider)))),
  ),
  HttpRouter.route(
    "POST",
    `${BASE}/billing/portal`,
    hostedOnly(withProvider((provider) => handled(portal(provider)))),
  ),
  HttpRouter.route(
    "POST",
    `${BASE}/billing/plan`,
    hostedOnly(withProvider((provider) => handled(switchPlan(provider)))),
  ),
]);

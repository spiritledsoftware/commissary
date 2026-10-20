/**
 * Polar (https://polar.sh), Commissary Cloud's merchant of record (ADR 0042), as the billing provider (`provider.ts`):
 * its REST API over `fetch` (no SDK) and its webhooks (Standard Webhooks signatures). New in the Workers port, no Go
 * counterpart.
 *
 * - **Settings** (the deployment's, `BillingBindings`): `POLAR_ACCESS_TOKEN` (an organization access token),
 *   `POLAR_PRODUCT_ID` (the Pay-as-you-go product), `POLAR_SERVER` (`production` on the `cloud` stage, `sandbox`
 *   elsewhere) and `POLAR_WEBHOOK_SECRET`, which only the app Worker has (only it takes webhooks; without it the
 *   provider has no `verifyWebhook` and the webhook route does not exist). Without the token and the product, or on a
 *   self-hosted Commissary, there is no provider ({@link polarProviderOf}) and nothing is billed. A stage sets all of
 *   them or none (`infra/settings.ts`).
 * - **Customer**: one per org, created at its first checkout with the org's id as `external_id` and the owner who
 *   started it as its email. Polar requires a customer's email to be unique among its customers, so one person can be
 *   the billing email of one org only (`email_taken`).
 * - **Meter events** ({@link METER_EVENT_NAMES}): one event per unit and month, `metadata.units` the amount, which the
 *   product's meters sum (docs/DEPLOY.md "Polar"). Each carries the batch's `external_id`, which Polar deduplicates.
 * - **Webhooks**: every `subscription.*` event is read from the subscription it carries (its status, whether it is set
 *   to cancel at the end of the period, its `modified_at`), so `subscription.updated` and the specific events agree and
 *   any order of delivery comes to the same state (`BillingStore.applySubscription`).
 */
import { Effect, Option, Schema } from "effect";
import type { OrgId } from "@commissary/core";
import { isHosted } from "@commissary/auth";
import type { BillingBindings } from "./env.ts";
import type { Unit } from "./plan.ts";
import {
  type BillingProvider,
  BillingProviderError,
  type BillingWebhook,
  type WebhookRequest,
  WebhookRefused,
} from "./provider.ts";
import type { MeterEvent, SubscriptionChange } from "./store.ts";

export const POLAR_API = {
  production: "https://api.polar.sh",
  sandbox: "https://sandbox-api.polar.sh",
} as const;

/** The event name of each unit, which the Pay-as-you-go product's meters filter on. */
export const METER_EVENT_NAMES: Readonly<Record<Unit, string>> = {
  requests: "commissary_requests",
  browserHours: "commissary_browser_hours",
  computerHours: "commissary_computer_hours",
};

/** How far a webhook's timestamp may be from now (Standard Webhooks' default tolerance). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Polar's settings, read from the bindings; `webhookSecret` is `undefined` on a Worker that takes no webhooks. */
export interface PolarSettings {
  readonly accessToken: string;
  readonly webhookSecret: string | undefined;
  readonly productId: string;
  readonly apiBase: string;
}

/** Polar's settings when the deployment bills through Polar: Commissary Cloud with the token and the product set. */
export const polarSettingsOf = (env: BillingBindings): PolarSettings | undefined => {
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim() ?? "";
  const webhookSecret = env.POLAR_WEBHOOK_SECRET?.trim() ?? "";
  const productId = env.POLAR_PRODUCT_ID?.trim() ?? "";

  if (!isHosted(env) || accessToken === "" || productId === "") return undefined;

  return {
    accessToken,
    webhookSecret: webhookSecret === "" ? undefined : webhookSecret,
    productId,
    apiBase: env.POLAR_SERVER === "production" ? POLAR_API.production : POLAR_API.sandbox,
  };
};

/** What Polar answered: the status and the body, parsed as JSON (`undefined` when empty or not JSON), not decoded yet. */
interface PolarAnswer {
  readonly status: number;
  readonly json: unknown;
}

/** A JSON value Commissary sends Polar. */
type PolarJson =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<PolarJson>
  | { readonly [key: string]: PolarJson };

/** A JSON request body. */
type PolarRequestBody = { readonly [key: string]: PolarJson };

/** A 422 of Polar's: which body fields it refused. */
const ValidationFailure = Schema.Struct({
  detail: Schema.Array(
    Schema.Struct({ loc: Schema.Array(Schema.Union([Schema.String, Schema.Number])) }),
  ),
});

/** Which body fields a 422 of Polar's refused. */
const refusedFields = (answer: PolarAnswer): ReadonlyArray<string> =>
  Option.match(Schema.decodeUnknownOption(ValidationFailure)(answer.json), {
    onNone: () => [],
    onSome: (failure) => failure.detail.map((detail) => String(detail.loc.at(-1) ?? "")),
  });

const Identified = Schema.Struct({ id: Schema.String });

const WithUrl = Schema.Struct({ url: Schema.String });

const PortalSession = Schema.Struct({ customer_portal_url: Schema.String });

const PaymentMethods = Schema.Struct({ items: Schema.Array(Schema.Unknown) });

const Envelope = Schema.Struct({ type: Schema.String, data: Schema.Unknown });

/** A refusal of Polar's: its error's name (`AlreadyCanceledSubscription`, `insufficient_scope`, …). */
const Refusal = Schema.Struct({ error: Schema.String });

/** The error name of a refusal, `undefined` without one. */
const refusalOf = (answer: PolarAnswer): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Refusal)(answer.json))?.error;

/**
 * The 403s of cancelling a subscription that leave nothing to cancel: it is cancelled already or set to be
 * (`AlreadyCanceledSubscription`), or it is not active any more (`InactiveSubscription`).
 */
const NOTHING_TO_CANCEL: ReadonlySet<string> = new Set([
  "AlreadyCanceledSubscription",
  "InactiveSubscription",
]);

const Subscription = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  cancel_at_period_end: Schema.Boolean,
  created_at: Schema.String,
  modified_at: Schema.NullOr(Schema.String),
  product_id: Schema.String,
  customer_id: Schema.String,
  customer: Schema.Struct({ external_id: Schema.NullOr(Schema.String) }),
});

type Subscription = typeof Subscription.Type;

/** What a subscription's state means for the org; `undefined` for one Billing does not act on (not started yet). */
const statusOf = (subscription: Subscription): SubscriptionChange["status"] | undefined => {
  switch (subscription.status) {
    case "active":
    case "trialing":
      // Cancelled at the end of the period: the org goes to Free now (#237); un-cancelling brings it back.
      return subscription.cancel_at_period_end ? "ended" : "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
    case "paused":
      return "ended";
    default:
      return undefined;
  }
};

const encoder = new TextEncoder();

const base64Bytes = (text: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/**
 * Checks a Standard Webhooks signature: `webhook-signature` lists `v1,<base64 HMAC-SHA256>` entries of
 * `<webhook-id>.<webhook-timestamp>.<body>`, keyed by the secret's bytes (Polar's SDK hands its secret to the Standard
 * Webhooks library base64-encoded, so the key is the secret as written), and `webhook-timestamp` is within
 * {@link WEBHOOK_TOLERANCE_SECONDS} of `now`.
 */
export const verifySignature = (
  secret: string,
  request: WebhookRequest,
  now: number,
): Effect.Effect<void, WebhookRefused> =>
  Effect.gen(function* () {
    const id = request.headers["webhook-id"] ?? "";
    const timestamp = request.headers["webhook-timestamp"] ?? "";
    const signatures = request.headers["webhook-signature"] ?? "";

    if (id === "" || timestamp === "" || signatures === "")
      return yield* new WebhookRefused({ message: "unsigned webhook" });

    const seconds = Number(timestamp);

    if (
      !Number.isSafeInteger(seconds) ||
      Math.abs(now / 1000 - seconds) > WEBHOOK_TOLERANCE_SECONDS
    )
      return yield* new WebhookRefused({ message: "webhook timestamp out of tolerance" });

    const signed = encoder.encode(`${id}.${timestamp}.${request.body}`);

    const verified = yield* Effect.promise(async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );

      for (const entry of signatures.split(" ")) {
        const [version, value] = entry.split(",", 2);
        const signature = version === "v1" && value !== undefined ? base64Bytes(value) : undefined;

        // `verify` compares in constant time.
        if (signature !== undefined && (await crypto.subtle.verify("HMAC", key, signature, signed)))
          return true;
      }

      return false;
    });

    if (!verified) return yield* new WebhookRefused({ message: "wrong webhook signature" });
  });

/** Reads a verified webhook body: a change of an org's Pay-as-you-go subscription, or one Billing ignores. */
export const readWebhook = (productId: string, body: string): BillingWebhook => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "ignored", type: "unreadable" };
  }

  const envelope = Schema.decodeUnknownOption(Envelope)(parsed);

  if (Option.isNone(envelope)) return { kind: "ignored", type: "unreadable" };
  const { type, data } = envelope.value;

  if (!type.startsWith("subscription.")) return { kind: "ignored", type };
  const decoded = Schema.decodeUnknownOption(Subscription)(data);

  if (Option.isNone(decoded)) return { kind: "ignored", type };
  const subscription = decoded.value;
  const org = subscription.customer.external_id;
  const status = statusOf(subscription);
  const changedAt = Date.parse(subscription.modified_at ?? subscription.created_at);

  if (
    subscription.product_id !== productId ||
    org === null ||
    status === undefined ||
    Number.isNaN(changedAt)
  )
    return { kind: "ignored", type };

  return {
    kind: "subscription",
    org,
    change: {
      status,
      subscriptionId: subscription.id,
      customerId: subscription.customer_id,
      changedAt,
    },
  };
};

const monthLabel = (monthStart: number): string => new Date(monthStart).toISOString().slice(0, 7);

/** Checks and reads Polar's webhooks with the settings' secret; `undefined` without one. */
const webhookVerifier = (settings: PolarSettings): BillingProvider["verifyWebhook"] => {
  const secret = settings.webhookSecret;

  if (secret === undefined) return undefined;

  return (request, now) =>
    verifySignature(secret, request, now).pipe(
      // Read only once verified: an unsigned body is never parsed.
      Effect.map(() => readWebhook(settings.productId, request.body)),
    );
};

/** Polar's REST API, through `fetch`, with the settings' token. */
export const polarProvider = (settings: PolarSettings): BillingProvider => {
  const call = (
    label: string,
    method: string,
    path: string,
    body?: PolarRequestBody,
  ): Effect.Effect<PolarAnswer, BillingProviderError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${settings.apiBase}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${settings.accessToken}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        const text = await response.text();
        let json: unknown = undefined;

        try {
          json = text === "" ? undefined : JSON.parse(text);
        } catch {
          json = undefined;
        }

        return { status: response.status, json };
      },
      catch: (cause) =>
        new BillingProviderError({
          reason: "unavailable",
          message: `Polar ${label} failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
        }),
    });

  /** The answer of a call that must succeed, decoded with `schema`. */
  const expect = <S extends Schema.Top & { readonly DecodingServices: never }>(
    label: string,
    schema: S,
    answer: PolarAnswer,
  ): Effect.Effect<S["Type"], BillingProviderError> => {
    if (answer.status === 429)
      return Effect.fail(
        new BillingProviderError({
          reason: "rate_limited",
          message: `Polar ${label}: 429`,
          status: 429,
        }),
      );

    if (answer.status < 200 || answer.status > 299)
      return Effect.fail(
        new BillingProviderError({
          reason: "unavailable",
          message: `Polar ${label} answered ${answer.status}`,
          status: answer.status,
        }),
      );

    return Option.match(Schema.decodeUnknownOption(schema)(answer.json), {
      onNone: () =>
        Effect.fail(
          new BillingProviderError({
            reason: "unavailable",
            message: `Polar ${label} answered an unexpected body`,
          }),
        ),
      onSome: (value) => Effect.succeed(value),
    });
  };

  const customerByOrg = (org: OrgId) =>
    call("customer lookup", "GET", `/v1/customers/external/${encodeURIComponent(org)}`).pipe(
      Effect.flatMap((answer) => expect("customer lookup", Identified, answer)),
      Effect.map((customer) => customer.id),
    );

  return {
    createCustomer: ({ org, name, email }) =>
      Effect.gen(function* () {
        const answer = yield* call("customer creation", "POST", "/v1/customers/", {
          email,
          name,
          external_id: org,
          metadata: { org },
        });

        if (answer.status === 422) {
          const fields = refusedFields(answer);

          // Created before (a retry after the id was lost): the org's existing customer.
          if (fields.includes("external_id")) return yield* customerByOrg(org);

          if (fields.includes("email"))
            return yield* new BillingProviderError({
              reason: "email_taken",
              message: "Polar has a customer with this email already",
            });
        }

        return (yield* expect("customer creation", Identified, answer)).id;
      }),

    startCheckout: ({ customerId, org, successUrl, returnUrl }) =>
      call("checkout", "POST", "/v1/checkouts/", {
        products: [settings.productId],
        customer_id: customerId,
        success_url: successUrl,
        return_url: returnUrl,
        metadata: { org },
      }).pipe(
        Effect.flatMap((answer) => expect("checkout", WithUrl, answer)),
        Effect.map((checkout) => checkout.url),
      ),

    portalUrl: ({ customerId, returnUrl }) =>
      call("customer session", "POST", "/v1/customer-sessions/", {
        customer_id: customerId,
        return_url: returnUrl,
      }).pipe(
        Effect.flatMap((answer) => expect("customer session", PortalSession, answer)),
        Effect.map((session) => session.customer_portal_url),
      ),

    hasPaymentMethod: (customerId) =>
      call(
        "payment methods",
        "GET",
        `/v1/customers/${encodeURIComponent(customerId)}/payment-methods?limit=1`,
      ).pipe(
        Effect.flatMap((answer) => expect("payment methods", PaymentMethods, answer)),
        Effect.map((methods) => methods.items.length > 0),
      ),

    sendMeterEvents: (customerId, events: ReadonlyArray<MeterEvent>) =>
      call("event ingestion", "POST", "/v1/events/ingest", {
        events: events.map((event) => ({
          name: METER_EVENT_NAMES[event.unit],
          customer_id: customerId,
          external_id: event.externalId,
          metadata: { units: event.amount, month: monthLabel(event.monthStart) },
        })),
      }).pipe(
        Effect.flatMap((answer) =>
          expect("event ingestion", Schema.Struct({ inserted: Schema.Number }), answer),
        ),
        Effect.asVoid,
      ),

    cancelSubscription: (subscriptionId) =>
      call(
        "subscription cancellation",
        "PATCH",
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { cancel_at_period_end: true },
      ).pipe(
        Effect.flatMap((answer) =>
          // Cancelled already, set to be, not active or gone: nothing left to cancel. Any other 403 (a token without
          // the scope, for one) is a failure: the subscription may still be live.
          (answer.status === 403 && NOTHING_TO_CANCEL.has(refusalOf(answer) ?? "")) ||
          answer.status === 404
            ? Effect.void
            : expect("subscription cancellation", Schema.Unknown, answer).pipe(Effect.asVoid),
        ),
      ),

    verifyWebhook: webhookVerifier(settings),
  };
};

/** Polar as the provider of an invocation, `undefined` without its settings (`BillingProviders`' default). */
export const polarProviderOf = (env: BillingBindings): BillingProvider | undefined => {
  const settings = polarSettingsOf(env);

  return settings === undefined ? undefined : polarProvider(settings);
};

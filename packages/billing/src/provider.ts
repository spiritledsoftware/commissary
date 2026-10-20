/**
 * The billing provider behind Pay as you go (ADR 0042: "Billing sits behind a small adapter so Stripe direct remains
 * possible"): what Billing asks of whoever bills orgs. Polar (`polar.ts`) is the only implementation; tests use a fake
 * (`test/testing.ts`). Provider-neutral: the ids are the provider's, the rest is Billing's own vocabulary.
 *
 * Which provider a Worker invocation uses is `BillingProviders` (`providers.ts`): Polar when the deployment has its
 * settings, none otherwise, and then Billing bills nothing and its billing routes answer 404. New in the Workers port,
 * no Go counterpart.
 */
import { Data, type Effect } from "effect";
import type { OrgId } from "@commissary/core";
import type { MeterEvent, SubscriptionChange } from "./store.ts";

/**
 * A call to the provider failed. `reason`: `email_taken` (another customer has the billing email), `rate_limited` (try
 * later), `unavailable` (anything else). `status` is the HTTP status the provider answered, absent when no answer came
 * (a network failure). The message is for logs: it never carries a token.
 */
export class BillingProviderError extends Data.TaggedError("BillingProviderError")<{
  readonly reason: "email_taken" | "rate_limited" | "unavailable";
  readonly message: string;
  readonly status?: number;
}> {}

/**
 * Whether trying again cannot help: the provider answered and refused the call itself (a 4xx other than a rate limit),
 * as opposed to a rate limit, a 5xx or no answer at all.
 */
export const isPermanentRefusal = (error: BillingProviderError): boolean =>
  error.reason !== "rate_limited" &&
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500;

/** A webhook that is not the provider's: unsigned, wrongly signed, too old, or unreadable. */
export class WebhookRefused extends Data.TaggedError("WebhookRefused")<{
  readonly message: string;
}> {}

/** What a verified webhook tells Billing: a change of an org's subscription, or nothing Billing acts on. */
export type BillingWebhook =
  | { readonly kind: "subscription"; readonly org: string; readonly change: SubscriptionChange }
  | { readonly kind: "ignored"; readonly type: string };

/** A received webhook: its headers (lowercase names) and its body as sent. */
export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export interface BillingProvider {
  /** Creates the org's customer, billed to `email`; answers its id (the existing one's when the org already has one). */
  readonly createCustomer: (input: {
    readonly org: OrgId;
    readonly name: string;
    readonly email: string;
  }) => Effect.Effect<string, BillingProviderError>;
  /** A checkout of Pay as you go for the customer; answers the URL to send the owner to. */
  readonly startCheckout: (input: {
    readonly customerId: string;
    readonly org: OrgId;
    readonly successUrl: string;
    readonly returnUrl: string;
  }) => Effect.Effect<string, BillingProviderError>;
  /** A link to the customer's portal (invoices, receipts, payment method, tax ID). */
  readonly portalUrl: (input: {
    readonly customerId: string;
    readonly returnUrl: string;
  }) => Effect.Effect<string, BillingProviderError>;
  /** Whether the customer has a payment method on file. */
  readonly hasPaymentMethod: (customerId: string) => Effect.Effect<boolean, BillingProviderError>;
  /** Sends usage; an event sent again (same `externalId`) is not counted twice. */
  readonly sendMeterEvents: (
    customerId: string,
    events: ReadonlyArray<MeterEvent>,
  ) => Effect.Effect<void, BillingProviderError>;
  /**
   * Cancels a subscription at the end of its period, which bills the usage sent until then; one already cancelled (or
   * set to be) is not an error.
   */
  readonly cancelSubscription: (
    subscriptionId: string,
  ) => Effect.Effect<void, BillingProviderError>;
  /**
   * Checks a webhook's signature (at `now`, epoch ms) and reads it; `undefined` on a Worker that takes no webhooks
   * (it has no webhook secret).
   */
  readonly verifyWebhook:
    | ((request: WebhookRequest, now: number) => Effect.Effect<BillingWebhook, WebhookRefused>)
    | undefined;
}

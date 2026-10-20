// Polar as the billing provider (src/polar.ts) against a stand-in for Polar's API (the global `fetch`, which the
// provider reads on every call): what each call sends, how Polar's answers read, and the Standard Webhooks signature
// of its webhooks (signed here with node:crypto, an implementation of its own).
import { createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { newOrgId } from "@commissary/core";
import { polarProvider, polarProviderOf, type PolarSettings } from "../src/polar.ts";
import { WebhookRefused } from "../src/provider.ts";

const WEBHOOK_SECRET = "polar_whs_test-secret";

const SETTINGS: PolarSettings = {
  accessToken: "polar_oat_test",
  webhookSecret: WEBHOOK_SECRET,
  productId: "prod_payg",
  apiBase: "https://sandbox-api.polar.sh",
};

const polar = polarProvider(SETTINGS);

/** `polar`'s webhook check, which it has: its settings carry the webhook secret. */
const verify: NonNullable<typeof polar.verifyWebhook> = (request, now) =>
  polar.verifyWebhook === undefined
    ? Effect.die(new Error("no webhook check"))
    : polar.verifyWebhook(request, now);

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

const realFetch = globalThis.fetch;

/** Answers Polar's calls with `answer` and records them. */
const stubPolar = (answer: (sent: Sent) => Response): Array<Sent> => {
  const sent: Array<Sent> = [];

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();

    const call = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: text === "" ? undefined : JSON.parse(text),
    };

    sent.push(call);

    return answer(call);
  };

  return sent;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status: number, body: Readonly<Record<string, unknown>>) =>
  Response.json(body, { status });

const NOW = Date.UTC(2026, 2, 15, 12);

const subscription = (fields: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  cancel_at_period_end: false,
  created_at: "2026-03-15T11:00:00.000000Z",
  modified_at: "2026-03-15T11:59:00.000000Z",
  product_id: "prod_payg",
  customer_id: "cus_1",
  customer: { id: "cus_1", external_id: "org_1" },
  ...fields,
});

/** A webhook as Polar signs it: Standard Webhooks, HMAC-SHA256 keyed by the secret's bytes. */
const signed = (body: string, options: { secret?: string; at?: number } = {}) => {
  const id = "msg_1";
  const timestamp = String(Math.floor((options.at ?? NOW) / 1000));

  const signature = createHmac("sha256", options.secret ?? WEBHOOK_SECRET)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,bm90IHRoaXMgb25l v1,${signature}`,
    },
    body,
  };
};

const event = (type: string, data: Readonly<Record<string, unknown>>) =>
  JSON.stringify({ type, data });

/** The status a verified webhook about a subscription reads as, `undefined` when it is ignored or refused. */
const statusOf = (type: string, fields: Record<string, unknown>) =>
  Effect.gen(function* () {
    const read = yield* Effect.result(verify(signed(event(type, subscription(fields))), NOW));

    return Result.isSuccess(read) && read.success.kind === "subscription"
      ? read.success.change.status
      : undefined;
  });

describe("the provider's settings", () => {
  const configured = {
    ...env,
    POLAR_ACCESS_TOKEN: "t",
    POLAR_WEBHOOK_SECRET: "s",
    POLAR_PRODUCT_ID: "p",
  };

  it("exist on Commissary Cloud with the token and the product, with or without the webhook secret", () => {
    expect(polarProviderOf(configured)).toBeDefined();
    expect(polarProviderOf({ ...configured, POLAR_WEBHOOK_SECRET: undefined })).toBeDefined();
  });

  it("do not exist without the token or the product, or on a self-hosted Commissary", () => {
    expect(polarProviderOf({ ...configured, POLAR_ACCESS_TOKEN: undefined })).toBeUndefined();
    expect(polarProviderOf({ ...configured, POLAR_PRODUCT_ID: "" })).toBeUndefined();
    expect(polarProviderOf({ ...configured, COMMISSARY_MODE: undefined })).toBeUndefined();
  });
});

describe("customers", () => {
  it.effect(
    "creates the org's customer with the owner's email and the org as its external id",
    () =>
      Effect.gen(function* () {
        const org = newOrgId();
        const sent = stubPolar(() => json(201, { id: "cus_1" }));

        const created = yield* polar.createCustomer({ org, name: "Acme", email: "o@acme.test" });

        expect(created).toBe("cus_1");
        expect(sent).toEqual([
          {
            method: "POST",
            url: "https://sandbox-api.polar.sh/v1/customers/",
            authorization: "Bearer polar_oat_test",
            body: { email: "o@acme.test", name: "Acme", external_id: org, metadata: { org } },
          },
        ]);
      }),
  );

  it.effect("answers the org's existing customer when Polar has one for it already", () =>
    Effect.gen(function* () {
      const org = newOrgId();

      const sent = stubPolar((call) =>
        call.method === "POST"
          ? json(422, { detail: [{ loc: ["body", "external_id"], msg: "exists" }] })
          : json(200, { id: "cus_existing" }),
      );

      expect(yield* polar.createCustomer({ org, name: "Acme", email: "o@acme.test" })).toBe(
        "cus_existing",
      );
      expect(sent[1]?.url).toBe(`https://sandbox-api.polar.sh/v1/customers/external/${org}`);
    }),
  );

  it.effect("says when another customer has the email", () =>
    Effect.gen(function* () {
      stubPolar(() => json(422, { detail: [{ loc: ["body", "email"], msg: "exists" }] }));

      const refused = yield* Effect.flip(
        polar.createCustomer({ org: newOrgId(), name: "Acme", email: "o@acme.test" }),
      );

      expect(refused.reason).toBe("email_taken");
    }),
  );
});

describe("checkout and portal", () => {
  it.effect("checks the customer out of the Pay-as-you-go product", () =>
    Effect.gen(function* () {
      const org = newOrgId();
      const sent = stubPolar(() => json(201, { url: "https://polar.test/checkout/1" }));

      const url = yield* polar.startCheckout({
        customerId: "cus_1",
        org,
        successUrl: "https://app.test/o/acme/billing",
        returnUrl: "https://app.test/o/acme/billing",
      });

      expect(url).toBe("https://polar.test/checkout/1");
      expect(sent[0]?.body).toEqual({
        products: ["prod_payg"],
        customer_id: "cus_1",
        success_url: "https://app.test/o/acme/billing",
        return_url: "https://app.test/o/acme/billing",
        metadata: { org },
      });
    }),
  );

  it.effect("opens the customer's portal and tells whether a card is on file", () =>
    Effect.gen(function* () {
      stubPolar((call) =>
        call.url.includes("customer-sessions")
          ? json(201, { customer_portal_url: "https://polar.test/portal/1" })
          : json(200, { items: [{ id: "pm_1" }], pagination: { total_count: 1 } }),
      );

      expect(yield* polar.portalUrl({ customerId: "cus_1", returnUrl: "https://app.test" })).toBe(
        "https://polar.test/portal/1",
      );
      expect(yield* polar.hasPaymentMethod("cus_1")).toBe(true);
    }),
  );
});

describe("meter events", () => {
  it.effect("sends one event per unit and month, named for the meters, with the batch's ids", () =>
    Effect.gen(function* () {
      const sent = stubPolar(() => json(200, { inserted: 2, duplicates: 0 }));

      yield* polar.sendMeterEvents("cus_1", [
        { unit: "requests", monthStart: Date.UTC(2026, 2, 1), amount: 300, externalId: "b:1:r" },
        {
          unit: "browserHours",
          monthStart: Date.UTC(2026, 2, 1),
          amount: 1.5,
          externalId: "b:1:b",
        },
      ]);

      expect(sent[0]?.url).toBe("https://sandbox-api.polar.sh/v1/events/ingest");
      expect(sent[0]?.body).toEqual({
        events: [
          {
            name: "commissary_requests",
            customer_id: "cus_1",
            external_id: "b:1:r",
            metadata: { units: 300, month: "2026-03" },
          },
          {
            name: "commissary_browser_hours",
            customer_id: "cus_1",
            external_id: "b:1:b",
            metadata: { units: 1.5, month: "2026-03" },
          },
        ],
      });
    }),
  );

  it.effect("tells a rate limit and a refusal apart, with the status Polar answered", () =>
    Effect.gen(function* () {
      stubPolar(() => json(429, { detail: "slow down" }));
      expect(yield* Effect.flip(polar.sendMeterEvents("cus_1", []))).toMatchObject({
        reason: "rate_limited",
        status: 429,
      });

      stubPolar(() => json(404, { error: "ResourceNotFound", detail: "no such customer" }));
      expect(yield* Effect.flip(polar.sendMeterEvents("cus_1", []))).toMatchObject({
        reason: "unavailable",
        status: 404,
      });
    }),
  );
});

describe("cancelling", () => {
  it.effect("cancels the subscription at the end of its period", () =>
    Effect.gen(function* () {
      const sent = stubPolar(() => json(200, subscription({ cancel_at_period_end: true })));

      yield* polar.cancelSubscription("sub_1");
      expect(sent).toEqual([
        {
          method: "PATCH",
          url: "https://sandbox-api.polar.sh/v1/subscriptions/sub_1",
          authorization: "Bearer polar_oat_test",
          body: { cancel_at_period_end: true },
        },
      ]);
    }),
  );

  it.effect(
    "takes a subscription that is cancelled already, not active, or gone as cancelled",
    () =>
      Effect.gen(function* () {
        for (const answer of [
          json(403, { error: "AlreadyCanceledSubscription", detail: "already" }),
          json(403, { error: "InactiveSubscription", detail: "inactive" }),
          json(404, { error: "ResourceNotFound", detail: "gone" }),
        ]) {
          stubPolar(() => answer.clone());
          expect(Result.isSuccess(yield* Effect.result(polar.cancelSubscription("sub_1")))).toBe(
            true,
          );
        }
      }),
  );

  it.effect("fails on any other 403, such as a token without the scope", () =>
    Effect.gen(function* () {
      stubPolar(() => json(403, { error: "insufficient_scope", detail: "subscriptions:write" }));

      expect(yield* Effect.flip(polar.cancelSubscription("sub_1"))).toMatchObject({
        reason: "unavailable",
        status: 403,
      });
    }),
  );
});

describe("webhooks", () => {
  it.effect("reads a verified subscription.active as the org's subscription becoming active", () =>
    Effect.gen(function* () {
      const read = yield* verify(signed(event("subscription.active", subscription())), NOW);

      expect(read).toEqual({
        kind: "subscription",
        org: "org_1",
        change: {
          status: "active",
          subscriptionId: "sub_1",
          customerId: "cus_1",
          changedAt: Date.parse("2026-03-15T11:59:00Z"),
        },
      });
    }),
  );

  it.effect("refuses an unsigned, a wrongly signed or a stale webhook", () =>
    Effect.gen(function* () {
      const body = event("subscription.active", subscription());
      const good = signed(body);

      const refusals = [
        { headers: {}, body },
        signed(body, { secret: "another-secret" }),
        { ...good, body: body.replace("sub_1", "sub_2") },
        signed(body, { at: NOW - 10 * 60_000 }),
      ];

      for (const request of refusals)
        expect(yield* Effect.flip(verify(request, NOW))).toBeInstanceOf(WebhookRefused);
    }),
  );

  it("takes no webhooks on a Worker without the webhook secret", () => {
    expect(polarProvider({ ...SETTINGS, webhookSecret: undefined }).verifyWebhook).toBeUndefined();
  });

  it.effect("reads past due, cancellation and revocation from the subscription's state", () =>
    Effect.gen(function* () {
      expect(yield* statusOf("subscription.past_due", { status: "past_due" })).toBe("past_due");
      expect(yield* statusOf("subscription.canceled", { cancel_at_period_end: true })).toBe(
        "ended",
      );
      expect(yield* statusOf("subscription.revoked", { status: "canceled" })).toBe("ended");
      expect(yield* statusOf("subscription.uncanceled", {})).toBe("active");
    }),
  );

  it.effect("ignores other events, other products and customers that are no org", () =>
    Effect.gen(function* () {
      const bodies = [
        event("order.created", { id: "ord_1" }),
        event("subscription.active", subscription({ product_id: "prod_other" })),
        event("subscription.active", subscription({ customer: { id: "c", external_id: null } })),
      ];

      for (const body of bodies) expect((yield* verify(signed(body), NOW)).kind).toBe("ignored");
    }),
  );
});

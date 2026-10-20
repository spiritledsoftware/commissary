// The billing routes (src/routes.ts) through a router of their own, with what the Worker's gate would have set (the
// current org, the caller; the gate's role table keeps the writes for org owners,
// apps/app/test/hosted/billing.test.ts): the plan, the payment state and the month's usage on Commissary Cloud, Pay as
// you go through a fake billing provider, and a 404 wherever there is no billing.
import { env } from "cloudflare:workers";
import { Context, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";
import type { AccessIdentity, Principal } from "@commissary/auth";
import { AccessPrincipal } from "@commissary/auth";
import { BillingView } from "@commissary/contract/billing";
import { CurrentOrg, newOrgId, type OrgId } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { type BillingBindings, BillingEnv } from "../src/api.ts";
import { BillingRoutes } from "../src/management.ts";
import type { BillingProvider } from "../src/provider.ts";
import {
  BillingProviders,
  fakeBillingProvider,
  FREE_USAGE,
  seedRequestsUsed,
  setPlan,
} from "./testing.ts";

const { handler } = HttpRouter.toWebHandler(BillingRoutes, { disableLogger: true });

const OWNER: Principal = { kind: "user", email: "owner@acme.test", sub: "owner" };

const identity = (org: OrgId, principal: Principal, platformAdmin: boolean): AccessIdentity => ({
  principal,
  principalId: "user:owner@acme.test",
  callerScope: "scope",
  org,
  platformAdmin,
  role: "owner",
});

interface Call {
  readonly method?: string;
  readonly path?: string;
  readonly body?: unknown;
  readonly org?: OrgId;
  readonly bindings?: BillingBindings;
  /** The billing provider; the default (Polar, from the bindings) when absent. */
  readonly provider?: BillingProvider | undefined;
  readonly principal?: Principal;
  /** The caller is a platform admin (an owner of every org). */
  readonly platformAdmin?: boolean;
}

const call = async (options: Call = {}): Promise<Response> => {
  const org = options.org ?? newOrgId();
  const bindings = options.bindings ?? env;

  const base = Context.make(BillingEnv, bindings).pipe(
    Context.add(CurrentOrg, org),
    Context.add(
      AccessPrincipal,
      identity(org, options.principal ?? OWNER, options.platformAdmin ?? false),
    ),
  );

  const context =
    "provider" in options ? Context.add(base, BillingProviders, () => options.provider) : base;

  return await handler(
    new Request(`https://app.example.com/v9/management${options.path ?? "/billing"}`, {
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    context,
  );
};

/** An org the registry knows (`acme-<random>`), as the gate would have found it. */
const registeredOrg = async () => {
  const id = newOrgId();
  const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;

  await platformOf(env).createOrg({ slug, name: "Acme", id }, Date.now());

  return { id, slug };
};

const view = async (response: Response) =>
  Schema.decodeUnknownSync(BillingView)(await response.json());

/** Marks the org's subscription active, as Polar's webhook would. */
const activate = async (org: OrgId, subscriptionId = "sub_1", customerId = "cus_1") =>
  await env.CONTROL_PLANE.getByName(org)
    .billing()
    .applySubscription({
      status: "active",
      subscriptionId,
      customerId,
      changedAt: Date.now() - 1000,
    });

describe("GET /billing", () => {
  it("shows a new org on Free with nothing used of its free usage, payments ok and no card", async () => {
    const response = await call({ provider: fakeBillingProvider().provider });

    expect(response.status).toBe(200);

    const shown = await view(response);
    const start = new Date(shown.month_start);
    const resets = new Date(shown.resets_at);

    expect(shown.plan).toBe("free");
    expect(shown.payment).toBe("ok");
    expect(shown.card_on_file).toBe(false);
    // A calendar month in UTC: it starts on the first at midnight and resets on the first of the next month.
    expect(start.getUTCDate()).toBe(1);
    expect(start.getUTCHours()).toBe(0);
    expect(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1)).toBe(resets.getTime());
    expect(shown.usage).toEqual({
      requests: { used: 0, free: 25_000 },
      browser_hours: { used: 0, free: 1 },
      computer_hours: { used: 0, free: 0 },
    });
    // Pay as you go's rates above free usage (ADR 0042), the ones the bill counts at.
    expect(shown.rates).toEqual({
      requests: { dollars: 0.5, per: 100_000 },
      browser_hours: { dollars: 0.15, per: 1 },
      computer_hours: { dollars: 0.15, per: 1 },
    });
    expect(shown.billing_cap).toBe(50);
    expect(shown.bill).toBe(0);
    expect(shown.notices).toEqual([]);
  });

  it("shows the plan, the payment state, the card on file and what the month used", async () => {
    const org = newOrgId();
    const fake = fakeBillingProvider();

    fake.state.paymentMethod = true;
    await activate(org);
    await seedRequestsUsed(env, org, Date.now(), 25_300);
    await env.CONTROL_PLANE.getByName(org).billing().applySubscription({
      status: "past_due",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      changedAt: Date.now(),
    });

    const shown = await view(await call({ org, provider: fake.provider }));

    expect(shown.plan).toBe("payg");
    expect(shown.payment).toBe("past_due");
    expect(shown.card_on_file).toBe(true);
    expect(shown.usage.requests).toEqual({ used: 25_300, free: 25_000 });
  });

  it("says it cannot tell whether a card is on file when the provider fails", async () => {
    const org = newOrgId();
    const fake = fakeBillingProvider();

    fake.failing.add("hasPaymentMethod");
    await activate(org);

    expect((await view(await call({ org, provider: fake.provider }))).card_on_file).toBeNull();
  });

  it("still shows the plan on a Commissary Cloud stage without Polar", async () => {
    const response = await call({ provider: undefined });

    expect(response.status).toBe(200);
    expect((await view(response)).card_on_file).toBe(false);
  });

  it("answers 404 on a self-hosted Commissary", async () => {
    const response = await call({ bindings: { ...env, COMMISSARY_MODE: undefined } });

    expect(response.status).toBe(404);
  });
});

describe("GET /billing's notices", () => {
  const noticesOf = async (org: OrgId, options: Call = {}) =>
    (await view(await call({ org, provider: fakeBillingProvider().provider, ...options }))).notices;

  it("tells a Free org at 80% and at 100% of its free usage", async () => {
    const org = newOrgId();

    await seedRequestsUsed(env, org, Date.now(), 19_999);
    expect(await noticesOf(org)).toEqual([]);

    await seedRequestsUsed(env, org, Date.now(), 20_000);
    expect(await noticesOf(org)).toEqual([{ kind: "free_usage", unit: "requests", percent: 80 }]);

    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests);
    expect(await noticesOf(org)).toEqual([{ kind: "free_usage", unit: "requests", percent: 100 }]);
  });

  it("tells a Pay as you go org at 80% and at 100% of its billing cap, with the month's bill", async () => {
    const org = newOrgId();

    await activate(org);
    // $40 and then $50 above free usage, at $0.50 per 100,000 requests.
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests + 8_000_000);

    const at80 = await view(await call({ org, provider: fakeBillingProvider().provider }));

    expect(at80.bill).toBe(40);
    expect(at80.notices).toEqual([{ kind: "billing_cap", percent: 80 }]);

    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests + 10_000_000);
    expect(await noticesOf(org)).toEqual([{ kind: "billing_cap", percent: 100 }]);

    // Past its free usage on Pay as you go, but far from the cap: nothing to tell.
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests + 1_000);
    expect(await noticesOf(org)).toEqual([]);
  });

  it("tells of a failed payment without asking Polar for a portal link on a read", async () => {
    const org = newOrgId();
    const fake = fakeBillingProvider();

    await activate(org);
    await env.CONTROL_PLANE.getByName(org).billing().applySubscription({
      status: "past_due",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      changedAt: Date.now(),
    });
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests);

    // Held to Free's limits: its free usage is what stops it, not the cap.
    expect(await noticesOf(org, { provider: fake.provider })).toEqual([
      { kind: "payment_failed" },
      { kind: "free_usage", unit: "requests", percent: 100 },
    ]);
    expect(fake.calls.map((made) => made.call)).toEqual(["hasPaymentMethod"]);
  });
});

describe("PATCH /billing", () => {
  /** `PATCH /billing` of `org` with `options.body`, through a fake provider unless `options` names another. */
  const setCap = (org: OrgId, options: Call) =>
    call({ method: "PATCH", org, provider: fakeBillingProvider().provider, ...options });

  /** Whether the org's Billing part would count a request now (no isolate cache: `test/meter.test.ts` has that). */
  const admitted = async (org: OrgId) =>
    (await env.CONTROL_PLANE.getByName(org).billing().admit(Date.now())).ok;

  it("sets and removes the billing cap in dollars, which the org's Billing part applies to its next request", async () => {
    const org = newOrgId();

    await activate(org);
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests + 10_000_000);
    expect(await admitted(org)).toBe(false);

    const raised = await setCap(org, { body: { billing_cap: 120.5 } });

    expect(raised.status).toBe(200);
    expect((await view(raised)).billing_cap).toBe(120.5);
    expect(await admitted(org)).toBe(true);

    await setCap(org, { body: { billing_cap: 0 } });
    expect(await admitted(org)).toBe(false);

    const removed = await setCap(org, { body: { billing_cap: null } });

    expect(removed.status).toBe(200);
    expect((await view(removed)).billing_cap).toBeNull();
    expect(await admitted(org)).toBe(true);
  });

  it("takes a number of dollars or null, and refuses an amount below 0 or in fractions of a cent", async () => {
    for (const body of [{ billing_cap: "50" }, {}, { billing_cap: 50, extra: 1 }])
      expect((await setCap(newOrgId(), { body })).status).toBe(400);

    for (const billing_cap of [-1, 10.005])
      expect((await setCap(newOrgId(), { body: { billing_cap } })).status).toBe(422);

    expect((await setCap(newOrgId(), { body: { billing_cap: 19.99 } })).status).toBe(200);
  });

  it("works on a Commissary Cloud stage without Polar, and answers 404 on a self-hosted Commissary", async () => {
    const body = { billing_cap: 10 };

    expect((await setCap(newOrgId(), { body, provider: undefined })).status).toBe(200);
    expect(
      (await setCap(newOrgId(), { body, bindings: { ...env, COMMISSARY_MODE: undefined } })).status,
    ).toBe(404);
  });
});

describe("POST /billing/checkout", () => {
  it("creates the org's customer once, billed to the owner, and answers Polar's checkout", async () => {
    const { id, slug } = await registeredOrg();
    const fake = fakeBillingProvider();

    const first = await call({
      method: "POST",
      path: "/billing/checkout",
      org: id,
      provider: fake.provider,
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ url: "https://polar.test/checkout/cus_1" });

    const again = await call({
      method: "POST",
      path: "/billing/checkout",
      org: id,
      provider: fake.provider,
    });

    expect(again.status).toBe(200);
    expect(fake.calls.filter((made) => made.call === "createCustomer")).toEqual([
      { call: "createCustomer", input: { org: id, name: "Acme", email: "owner@acme.test" } },
    ]);
    expect(fake.calls.find((made) => made.call === "startCheckout")?.input).toEqual({
      customerId: "cus_1",
      org: id,
      successUrl: `https://app.example.com/o/${slug}/billing`,
      returnUrl: `https://app.example.com/o/${slug}/billing`,
    });
    // The org stays on Free until Polar reports the subscription active.
    expect(await env.CONTROL_PLANE.getByName(id).billing().plan()).toBe("free");
  });

  it("is refused for an org on Pay as you go, for a token, and when the email bills another org", async () => {
    const paying = await registeredOrg();
    const fake = fakeBillingProvider();

    await activate(paying.id);

    const onPayg = await call({
      method: "POST",
      path: "/billing/checkout",
      org: paying.id,
      provider: fake.provider,
    });

    expect(onPayg.status).toBe(409);
    expect(await onPayg.json()).toEqual(expect.objectContaining({ error: "already_on_payg" }));

    const free = await registeredOrg();

    const byToken = await call({
      method: "POST",
      path: "/billing/checkout",
      org: free.id,
      provider: fake.provider,
      principal: { kind: "service", commonName: "ci" },
    });

    expect(byToken.status).toBe(403);

    fake.state.emailTaken = true;

    const taken = await call({
      method: "POST",
      path: "/billing/checkout",
      org: free.id,
      provider: fake.provider,
    });

    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual(expect.objectContaining({ error: "billing_email_taken" }));
  });

  it("answers 502 when the provider cannot be reached", async () => {
    const { id } = await registeredOrg();
    const fake = fakeBillingProvider();

    fake.failing.add("startCheckout");

    const response = await call({
      method: "POST",
      path: "/billing/checkout",
      org: id,
      provider: fake.provider,
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: "billing_unavailable" }),
    );
  });
});

describe("POST /billing/portal", () => {
  it("needs a billing account, then answers the customer's portal", async () => {
    const { id } = await registeredOrg();
    const fake = fakeBillingProvider();

    const before = await call({
      method: "POST",
      path: "/billing/portal",
      org: id,
      provider: fake.provider,
    });

    expect(before.status).toBe(409);

    await activate(id);

    const after = await call({
      method: "POST",
      path: "/billing/portal",
      org: id,
      provider: fake.provider,
    });

    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ url: "https://polar.test/portal/cus_1" });
  });
});

describe("POST /billing/plan", () => {
  it("sends the usage not sent yet, cancels the subscription and puts the org on Free at once", async () => {
    const org = newOrgId();
    const fake = fakeBillingProvider();

    await activate(org);
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests + 42);

    const response = await call({
      method: "POST",
      path: "/billing/plan",
      body: { plan: "free" },
      org,
      provider: fake.provider,
    });

    expect(response.status).toBe(200);
    expect((await view(response)).plan).toBe("free");
    expect(fake.total("requests")).toBe(42);
    expect(fake.calls.map((made) => made.call)).toEqual([
      "sendMeterEvents",
      "cancelSubscription",
      "hasPaymentMethod",
    ]);
    // Its data stays.
    expect((await env.CONTROL_PLANE.getByName(org).billing().usage(Date.now())).used.requests).toBe(
      FREE_USAGE.requests + 42,
    );
  });

  it("changes nothing when the subscription cannot be cancelled", async () => {
    const org = newOrgId();
    const fake = fakeBillingProvider();

    fake.failing.add("cancelSubscription");
    await activate(org);

    const response = await call({
      method: "POST",
      path: "/billing/plan",
      body: { plan: "free" },
      org,
      provider: fake.provider,
    });

    expect(response.status).toBe(502);
    expect(await env.CONTROL_PLANE.getByName(org).billing().plan()).toBe("payg");
  });

  it("takes only Free: upgrading goes through checkout", async () => {
    for (const body of [{ plan: "payg" }, { plan: "free", extra: 1 }, {}])
      expect(
        (
          await call({
            method: "POST",
            path: "/billing/plan",
            body,
            provider: fakeBillingProvider().provider,
          })
        ).status,
      ).toBe(400);
  });

  it("leaves an org on Free as it is", async () => {
    const fake = fakeBillingProvider();
    const org = newOrgId();

    await setPlan(env, org, "free");

    const response = await call({
      method: "POST",
      path: "/billing/plan",
      body: { plan: "free" },
      org,
      provider: fake.provider,
    });

    expect(response.status).toBe(200);
    expect(fake.calls.filter((made) => made.call === "cancelSubscription")).toEqual([]);
  });
});

describe("without billing", () => {
  it("has no checkout, portal or plan route without Polar's settings, or on a self-hosted Commissary", async () => {
    const unconfigured = { ...env, POLAR_ACCESS_TOKEN: undefined };
    const selfHosted = { ...env, COMMISSARY_MODE: undefined };

    for (const bindings of [unconfigured, selfHosted])
      for (const path of ["/billing/checkout", "/billing/portal", "/billing/plan"])
        expect(
          (await call({ method: "POST", path, body: { plan: "free" }, bindings })).status,
        ).toBe(404);
  });
});

describe("what platform admins set for an org", () => {
  const admin = { platformAdmin: true, provider: undefined } as const;

  it("marks an org unbilled, which puts it on Pay as you go, and unmarks it back to Free", async () => {
    const org = newOrgId();

    const marked = await call({
      ...admin,
      method: "PUT",
      path: "/billing/unbilled",
      body: { unbilled: true },
      org,
    });

    expect(marked.status).toBe(200);
    expect(await view(marked)).toEqual(expect.objectContaining({ plan: "payg", unbilled: true }));

    // Its owners see it unbilled, without the ceilings.
    const seen = await view(await call({ org, provider: undefined }));

    expect(seen).toEqual(expect.objectContaining({ plan: "payg", unbilled: true }));
    expect(seen.ceilings).toBeUndefined();

    const unmarked = await call({
      ...admin,
      method: "PUT",
      path: "/billing/unbilled",
      body: { unbilled: false },
      org,
    });

    expect(await view(unmarked)).toEqual(
      expect.objectContaining({ plan: "free", unbilled: false }),
    );
  });

  it("raises an org's ceilings above its plan's, and null restores the plan's", async () => {
    const org = newOrgId();

    await setPlan(env, org, "payg");

    const before = await view(await call({ ...admin, org }));

    expect(before.ceilings).toEqual({
      browser_sessions: { plan: 5, raised: null },
      computers: { plan: 3, raised: null },
      request_rate: { plan: 600, raised: null },
    });

    const raised = await call({
      ...admin,
      method: "PATCH",
      path: "/billing/ceilings",
      body: { request_rate: 1200, browser_sessions: 10 },
      org,
    });

    expect(raised.status).toBe(200);
    expect((await view(raised)).ceilings).toEqual({
      browser_sessions: { plan: 5, raised: 10 },
      computers: { plan: 3, raised: null },
      request_rate: { plan: 600, raised: 1200 },
    });
    expect(await env.CONTROL_PLANE.getByName(org).billing().ceilings()).toEqual({
      browserSessions: 10,
      computers: 3,
      requestRate: 1200,
    });

    const restored = await call({
      ...admin,
      method: "PATCH",
      path: "/billing/ceilings",
      body: { request_rate: null },
      org,
    });

    const { ceilings } = await view(restored);

    expect(ceilings?.request_rate).toEqual({ plan: 600, raised: null });
    expect(ceilings?.browser_sessions).toEqual({ plan: 5, raised: 10 });
  });

  it("shows Free's ceilings for a past-due Pay as you go org, which is held to Free's limits", async () => {
    const org = newOrgId();

    await env.CONTROL_PLANE.getByName(org).billing().applySubscription({
      status: "past_due",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      changedAt: Date.now(),
    });
    await env.CONTROL_PLANE.getByName(org).billing().raiseCeilings({ requestRate: 1200 });

    const shown = await view(await call({ ...admin, org }));

    expect(shown.plan).toBe("payg");
    expect(shown.payment).toBe("past_due");
    expect(shown.ceilings).toEqual({
      browser_sessions: { plan: 1, raised: null },
      computers: { plan: 0, raised: null },
      request_rate: { plan: 60, raised: 1200 },
    });
  });

  it("takes whole numbers from 1 to 1,000,000 or null, and nothing else", async () => {
    for (const request_rate of [0, -5, 1.5, 1_000_001])
      expect(
        (
          await call({
            ...admin,
            method: "PATCH",
            path: "/billing/ceilings",
            body: { request_rate },
          })
        ).status,
      ).toBe(422);

    for (const body of [{}, { request_rate: "1200" }, { seats: 3 }])
      expect(
        (await call({ ...admin, method: "PATCH", path: "/billing/ceilings", body })).status,
      ).toBe(400);

    for (const body of [{}, { unbilled: "yes" }, { unbilled: true, plan: "payg" }])
      expect(
        (await call({ ...admin, method: "PUT", path: "/billing/unbilled", body })).status,
      ).toBe(400);
  });

  it("is for platform admins: an org owner gets 403 and nothing changes", async () => {
    const org = newOrgId();

    const unbilled = await call({
      method: "PUT",
      path: "/billing/unbilled",
      body: { unbilled: true },
      org,
      provider: undefined,
    });

    const ceilings = await call({
      method: "PATCH",
      path: "/billing/ceilings",
      body: { request_rate: 1200 },
      org,
      provider: undefined,
    });

    expect([unbilled.status, ceilings.status]).toEqual([403, 403]);
    expect(await unbilled.json()).toEqual(
      expect.objectContaining({ error: "platform_admin_required" }),
    );
    expect(await env.CONTROL_PLANE.getByName(org).billing().usage(Date.now())).toEqual(
      expect.objectContaining({ plan: "free", unbilled: false }),
    );
  });

  it("keeps an unbilled org's owners from starting a checkout or switching to Free", async () => {
    const { id } = await registeredOrg();
    const fake = fakeBillingProvider();

    await env.CONTROL_PLANE.getByName(id).billing().setUnbilled(true);

    for (const path of ["/billing/checkout", "/billing/plan"]) {
      const response = await call({
        method: "POST",
        path,
        body: { plan: "free" },
        org: id,
        provider: fake.provider,
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "unbilled" }));
    }

    expect(fake.calls.map((made) => made.call)).toEqual([]);
  });

  it("answers 404 on a self-hosted Commissary", async () => {
    const selfHosted = { ...env, COMMISSARY_MODE: undefined };

    expect(
      (
        await call({
          ...admin,
          method: "PUT",
          path: "/billing/unbilled",
          body: { unbilled: true },
          bindings: selfHosted,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call({
          ...admin,
          method: "PATCH",
          path: "/billing/ceilings",
          body: { request_rate: 1200 },
          bindings: selfHosted,
        })
      ).status,
    ).toBe(404);
  });
});

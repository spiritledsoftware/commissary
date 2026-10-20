// `/v9/management/billing` on Commissary Cloud (packages/billing/src/routes.ts, @commissary/contract/billing): a new
// org is on Free with nothing used of its free usage; the plan and the month's count follow what Billing stores; any
// org admin may read it and a plain member may not; checkout, the portal, switching plans and setting the billing cap
// are for org owners; marking an org unbilled and raising its ceilings are for platform admins. Polar's webhook route
// is public on the app host. A self-hosted Commissary answers 404 (test/billing-self-hosted.test.ts).
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedRequestsUsed, setPlan } from "@commissary/billing/testing";
import { BillingView } from "@commissary/contract/billing";
import { platformOf } from "@commissary/state";
import { call, clearPeople, installFakes, panelHeaders, restoreFetch, signIn } from "./support.ts";

beforeAll(async () => {
  await installFakes();
  await clearPeople();
});

afterAll(restoreFetch);

interface Me {
  readonly orgs: ReadonlyArray<{ readonly slug: string }>;
}

/** The Personal org of a person who just signed up. */
const personalOrg = async (cookie: string) => {
  const response = await call("/v9/management/me", { headers: panelHeaders(cookie) });
  const org = (await response.json<Me>()).orgs[0];

  const record = org === undefined ? undefined : await platformOf(env).getOrgBySlug(org.slug);

  if (record === undefined) throw new Error("the person has no org");

  return { id: record.id, slug: record.slug };
};

const billing = (cookie: string, slug: string) =>
  call(`/v9/management/orgs/${slug}/billing`, { headers: panelHeaders(cookie) });

describe("billing", () => {
  it("shows a new org on Free with 0 of 25,000 requests and tool calls", async () => {
    const cookie = await signIn({ email: "owner-billing@example.com" });
    const { slug } = await personalOrg(cookie);
    const response = await billing(cookie, slug);

    expect(response.status).toBe(200);

    const view = Schema.decodeUnknownSync(BillingView)(await response.json());

    expect(view.plan).toBe("free");
    expect(view.usage).toEqual({
      requests: { used: 0, free: 25_000 },
      browser_hours: { used: 0, free: 1 },
      computer_hours: { used: 0, free: 0 },
    });
    expect(new Date(view.resets_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("shows the plan and the month's usage", async () => {
    const cookie = await signIn({ email: "owner-usage@example.com" });
    const { id, slug } = await personalOrg(cookie);

    await setPlan(env, id, "payg");
    await seedRequestsUsed(env, id, Date.now(), 26_001);

    const view = Schema.decodeUnknownSync(BillingView)(await (await billing(cookie, slug)).json());

    expect(view.plan).toBe("payg");
    expect(view.usage.requests).toEqual({ used: 26_001, free: 25_000 });
  });

  it("is for org admins: a plain member is refused", async () => {
    const owner = await signIn({ email: "owner-members@example.com" });
    const { slug } = await personalOrg(owner);

    const added = await call(`/v9/management/orgs/${slug}/members`, {
      method: "POST",
      headers: panelHeaders(owner, { "content-type": "application/json" }),
      body: JSON.stringify({ email: "plain@example.com", role: "member" }),
    });

    expect(added.status).toBe(201);

    const member = await signIn({ email: "plain@example.com" });

    expect((await billing(member, slug)).status).toBe(403);
    expect((await billing(owner, slug)).status).toBe(200);
  });

  it("keeps checkout, the portal and switching plans for org owners: an org admin gets 403", async () => {
    const owner = await signIn({ email: "owner-writes@example.com" });
    const { slug } = await personalOrg(owner);

    const added = await call(`/v9/management/orgs/${slug}/members`, {
      method: "POST",
      headers: panelHeaders(owner, { "content-type": "application/json" }),
      body: JSON.stringify({ email: "admin-writes@example.com", role: "admin" }),
    });

    expect(added.status).toBe(201);

    const admin = await signIn({ email: "admin-writes@example.com" });

    for (const path of ["checkout", "portal", "plan"]) {
      const response = await call(`/v9/management/orgs/${slug}/billing/${path}`, {
        method: "POST",
        headers: panelHeaders(admin, { "content-type": "application/json" }),
        body: JSON.stringify({ plan: "free" }),
      });

      expect(response.status).toBe(403);
    }

    // The owner gets past the gate: an org on Free switching to Free changes nothing.
    const switched = await call(`/v9/management/orgs/${slug}/billing/plan`, {
      method: "POST",
      headers: panelHeaders(owner, { "content-type": "application/json" }),
      body: JSON.stringify({ plan: "free" }),
    });

    expect(switched.status).toBe(200);
    expect((await billing(admin, slug)).status).toBe(200);
  });

  it("keeps setting the billing cap for org owners: an org admin gets 403", async () => {
    const owner = await signIn({ email: "owner-cap@example.com" });
    const { slug } = await personalOrg(owner);

    const added = await call(`/v9/management/orgs/${slug}/members`, {
      method: "POST",
      headers: panelHeaders(owner, { "content-type": "application/json" }),
      body: JSON.stringify({ email: "admin-cap@example.com", role: "admin" }),
    });

    expect(added.status).toBe(201);

    const admin = await signIn({ email: "admin-cap@example.com" });

    const setCap = (cookie: string) =>
      call(`/v9/management/orgs/${slug}/billing`, {
        method: "PATCH",
        headers: panelHeaders(cookie, { "content-type": "application/json" }),
        body: JSON.stringify({ billing_cap: null }),
      });

    expect((await setCap(admin)).status).toBe(403);

    const removed = await setCap(owner);

    expect(removed.status).toBe(200);
    expect(Schema.decodeUnknownSync(BillingView)(await removed.json()).billing_cap).toBeNull();
    // The admin still reads the overview, cap included.
    expect(
      Schema.decodeUnknownSync(BillingView)(await (await billing(admin, slug)).json()).billing_cap,
    ).toBeNull();
  });

  it("lets platform admins mark an org unbilled and raise its ceilings; an org admin or owner gets 403", async () => {
    const owner = await signIn({ email: "owner-unbilled@example.com" });
    const { slug } = await personalOrg(owner);

    const added = await call(`/v9/management/orgs/${slug}/members`, {
      method: "POST",
      headers: panelHeaders(owner, { "content-type": "application/json" }),
      body: JSON.stringify({ email: "admin-unbilled@example.com", role: "admin" }),
    });

    expect(added.status).toBe(201);

    const admin = await signIn({ email: "admin-unbilled@example.com" });
    // A platform admin (PLATFORM_ADMIN_EMAILS of the hosted test Worker), not a member of the org.
    const root = await signIn({ email: "root@example.com" });

    const write = (
      cookie: string,
      method: string,
      path: string,
      body: Readonly<Record<string, boolean | number>>,
    ) =>
      call(`/v9/management/orgs/${slug}/billing/${path}`, {
        method,
        headers: panelHeaders(cookie, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      });

    for (const cookie of [admin, owner]) {
      expect((await write(cookie, "PUT", "unbilled", { unbilled: true })).status).toBe(403);
      expect((await write(cookie, "PATCH", "ceilings", { request_rate: 1200 })).status).toBe(403);
    }

    expect((await write(root, "PUT", "unbilled", { unbilled: true })).status).toBe(200);

    const raised = await write(root, "PATCH", "ceilings", { request_rate: 1200 });

    expect(raised.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(BillingView)(await raised.json()).ceilings?.request_rate,
    ).toEqual({
      plan: 600,
      raised: 1200,
    });

    // The org's owner sees it unbilled, without the ceilings.
    const seen = Schema.decodeUnknownSync(BillingView)(await (await billing(owner, slug)).json());

    expect(seen.plan).toBe("payg");
    expect(seen.unbilled).toBe(true);
    expect(seen.ceilings).toBeUndefined();
  });

  it("takes Polar's webhooks on the app host without a session, and refuses an unsigned one", async () => {
    const response = await call("/webhooks/polar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "subscription.active", data: {} }),
    });

    expect(response.status).toBe(401);
  });
});

// Deleting a Pay-as-you-go org on Commissary Cloud (ADR 0027, ADR 0042, #237): the org deletion of the app Worker
// (src/platform/org-deletion.ts) with Billing's step, its billing provider a fake (`BillingProviders`), sends the usage
// the org did not send yet and cancels its subscription while the org's ControlPlane still holds its billing state;
// then the ControlPlane is wiped and the org leaves the registry.
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BillingEnv } from "@commissary/billing/api";
import { orgDeletionStep } from "@commissary/billing/management";
import {
  BillingProviders,
  fakeBillingProvider,
  FREE_USAGE,
  seedRequestsUsed,
  startPayAsYouGo,
} from "@commissary/billing/testing";
import type { OrgId } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { tablesOf } from "@commissary/state/testing";
import { deleteOrg } from "../../src/platform/org-deletion.ts";
import { call, clearPeople, installFakes, panelHeaders, restoreFetch, signIn } from "./support.ts";

beforeAll(async () => {
  await installFakes();
  await clearPeople();
});

afterAll(restoreFetch);

/** The Personal org of a person who just signed up on Commissary Cloud. */
const personalOrg = async (email: string): Promise<OrgId> => {
  const cookie = await signIn({ email });
  const response = await call("/v9/management/me", { headers: panelHeaders(cookie) });
  const slug = (await response.json<{ orgs: ReadonlyArray<{ slug: string }> }>()).orgs[0]?.slug;
  const record = slug === undefined ? undefined : await platformOf(env).getOrgBySlug(slug);

  if (record === undefined) throw new Error("the person has no Personal org");

  return record.id;
};

const billingTables = async (org: OrgId) =>
  (await tablesOf(env.CONTROL_PLANE.getByName(org))).filter((table) =>
    table.startsWith("billing_"),
  );

describe("deleting a Pay-as-you-go org", () => {
  it("sends its usage and cancels its subscription before its ControlPlane is wiped", async () => {
    const org = await personalOrg("owner-deleted-payg@example.com");

    await startPayAsYouGo(env, org, Date.now() - 1000);
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests + 12);

    const fake = fakeBillingProvider();
    /** The org's billing tables when each provider call was made. */
    const seen: Array<readonly [string, ReadonlyArray<string>]> = [];

    const observed = (name: string) =>
      Effect.promise(async () => {
        seen.push([name, await billingTables(org)]);
      });

    const provider = {
      ...fake.provider,
      sendMeterEvents: (
        customerId: string,
        events: Parameters<typeof fake.provider.sendMeterEvents>[1],
      ) =>
        observed("sendMeterEvents").pipe(
          Effect.andThen(fake.provider.sendMeterEvents(customerId, events)),
        ),
      cancelSubscription: (subscriptionId: string) =>
        observed("cancelSubscription").pipe(
          Effect.andThen(fake.provider.cancelSubscription(subscriptionId)),
        ),
    };

    const billingStep = await Effect.runPromise(
      orgDeletionStep.pipe(
        Effect.provideService(BillingEnv, env),
        Effect.provideService(BillingProviders, () => provider),
      ),
    );

    expect(await deleteOrg(env, [billingStep], org, { now: Date.now() })).toEqual({
      state: "deleted",
    });

    expect(fake.total("requests")).toBe(12);
    expect(fake.calls.map((made) => made.call)).toEqual(["sendMeterEvents", "cancelSubscription"]);
    expect(fake.calls[1]?.input).toBe("sub_1");

    for (const [, tables] of seen) expect(tables).toContain("billing_account");
    expect(seen.map(([name]) => name)).toEqual(["sendMeterEvents", "cancelSubscription"]);

    expect(await billingTables(org)).toEqual([]);
    expect(await platformOf(env).getOrgById(org)).toBeUndefined();
  });
});

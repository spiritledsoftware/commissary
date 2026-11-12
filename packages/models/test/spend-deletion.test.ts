// Zero data retention (ADR 0027) and Spend limits (issue #71): what a member's or an API key's Spend limits and counters
// are is deleted with them, through the real ControlPlane. An org's go with the org: apps/app/test/spend-deletion.test.ts.
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { GONE, HELD, OWNER, spendingOrg, spendRows } from "./support/spending-org.ts";
import { resetUsageDb } from "./support/usage.ts";

beforeAll(async () => {
  await resetUsageDb();
});

describe("Spend data of a member who leaves", () => {
  it("is deleted with the member and with their API keys, and nothing of anyone else is", async () => {
    const org = await spendingOrg();

    expect(await spendRows(org, "member", org.alice.id)).toEqual(HELD);
    expect(await spendRows(org, "key", org.aliceKey.id)).toEqual(HELD);

    expect((await org.stub.removeMember(org.alice.id, OWNER)).ok).toBe(true);

    expect(await spendRows(org, "member", org.alice.id)).toEqual(GONE);
    expect(await spendRows(org, "key", org.aliceKey.id)).toEqual(GONE);
    expect(await spendRows(org, "member", org.bob.id)).toEqual(HELD);
    expect(await spendRows(org, "key", org.bobKey.id)).toEqual(HELD);
  });

  it("is deleted when the person deletes their account too", async () => {
    const org = await spendingOrg();

    expect(await org.stub.leaveOrg("bob@example.com")).toEqual({ left: true });
    expect(await spendRows(org, "member", org.bob.id)).toEqual(GONE);
    expect(await spendRows(org, "key", org.bobKey.id)).toEqual(GONE);
    expect(await spendRows(org, "member", org.alice.id)).toEqual(HELD);
  });
});

describe("Spend data of an API key that is deleted", () => {
  it("goes with the key when it is revoked", async () => {
    const org = await spendingOrg();

    expect((await org.stub.revokeApiKey(org.aliceKey.id, Date.now())).ok).toBe(true);
    expect(await spendRows(org, "key", org.aliceKey.id)).toEqual(GONE);
    expect(await spendRows(org, "key", org.bobKey.id)).toEqual(HELD);
    expect(await spendRows(org, "member", org.alice.id)).toEqual(HELD);
  });

  it("goes with the key when it has expired and is purged", async () => {
    const org = await spendingOrg();
    const expiring = await org.key(org.alice, "short", Date.now() + 60_000);

    await org.limit("key", expiring.id);
    await org.spend(org.alice.id, expiring.id);
    expect(await spendRows(org, "key", expiring.id)).toEqual(HELD);

    expect(await org.stub.purgeExpiredApiKeys(Date.now() + 120_000)).toBe(1);
    expect(await spendRows(org, "key", expiring.id)).toEqual(GONE);
    expect(await spendRows(org, "key", org.aliceKey.id)).toEqual(HELD);
  });
});

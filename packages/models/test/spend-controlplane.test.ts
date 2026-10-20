// Spend limits in an org's ControlPlane (issue #71, @commissary/state/spend, service.ts): who may write which limit, what each viewer
// sees with the Spend so far, the credential subject exposed as `auth_index`, and the limits through the real
// `pick` and `report` of the Durable Object (non-boundary cases: the Durable Object reads the wall clock; the
// boundaries of periods are tested with an injected clock in spend-pool.test.ts).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Viewer } from "@commissary/auth";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { orgAuthIndexer } from "../src/management/auth-index.ts";
import { OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import type { NewSpendLimit, SpendEntry } from "@commissary/state/spend";
import { claudeFile } from "./support/control-plane.ts";
import { USD } from "@commissary/state/testing";

const OWNER = { role: "owner", sensitive: true } as const;

const freshOrg = async () => {
  const org = OrgId.make(`spend-${crypto.randomUUID().slice(0, 8)}`);
  const stub = controlPlaneOf(env, org);

  const member = async (email: string, role: "admin" | "member" = "member") => {
    const added = await stub.addMember({ email, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return added.value;
  };

  const admin = await member("admin@example.com", "admin");
  const alice = await member("alice@example.com");
  const bob = await member("bob@example.com");

  const adminViewer: Viewer = { member: admin.id, admin: true };
  const aliceViewer: Viewer = { member: alice.id, admin: false };
  const bobViewer: Viewer = { member: bob.id, admin: false };

  const key = async (owner: { readonly id: string }, name: string) => {
    const made = await stub.createApiKey({ memberId: owner.id, name }, Date.now());

    if (!made.ok) throw new Error(made.message);

    return made.value.record;
  };

  const create = async (viewer: Viewer, input: NewSpendLimit): Promise<SpendEntry> => {
    const made = await stub.createSpendLimit(viewer, input, "test@example.com");

    if (!made.ok) throw new Error(`${made.error}: ${made.message}`);

    return made.value;
  };

  const shared = async (name: string) => {
    const imported = await stub
      .models()
      .importAuthFile(name, JSON.stringify(claudeFile()), {}, FULL_ACCESS);

    expect(imported.ok).toBe(true);
  };

  return { org, stub, admin, alice, bob, adminViewer, aliceViewer, bobViewer, key, create, shared };
};

const REQUEST = { providers: ["claude"], model: "claude-sonnet-4-5" };

describe("Spend limits of the ControlPlane", () => {
  it("starts with no limits, UTC and weeks from Monday, and limits nothing", async () => {
    const { stub, adminViewer, alice, shared } = await freshOrg();

    await shared("claude-a.json");
    expect(await stub.spendOverview(adminViewer)).toMatchObject({
      settings: { timeZone: "UTC", weekStart: "monday" },
      entries: [],
    });

    const picked = await stub.models().pick({ ...REQUEST, memberId: alice.id });

    expect(picked.ok).toBe(true);
  });

  it("lets an org admin write any limit and shows the Spend so far", async () => {
    const { stub, adminViewer, alice, create, shared } = await freshOrg();

    await shared("claude-a.json");

    const entry = await create(adminViewer, {
      kind: "member",
      subject: alice.id,
      period: "day",
      amountMicros: 5 * USD,
    });

    expect(entry).toMatchObject({
      kind: "member",
      subject: alice.id,
      label: "alice@example.com",
      amountMicros: 5 * USD,
      source: "admin",
      revision: 1,
      spentMicros: 0,
      editable: true,
    });

    expect(entry.resetsAt).toBeGreaterThan(Date.now());
    expect(new Date(entry.resetsAt).getUTCHours()).toBe(0);

    const picked = await stub.models().pick({ ...REQUEST, memberId: alice.id });

    if (!picked.ok) throw new Error(picked.failure.code);

    expect(picked.lease.spend).toEqual([{ kind: "member", subject: alice.id }]);
    await stub
      .models()
      .report(picked.lease, { success: true, httpStatus: 200, costMicros: 2 * USD });

    const after = await stub.spendOverview(adminViewer);

    expect(after.entries.map((e) => e.spentMicros)).toEqual([2 * USD]);
  });

  it("refuses a member at their limit with spend_limit_reached and no cooldown, while another member is served", async () => {
    const { stub, adminViewer, alice, bob, create, shared } = await freshOrg();

    await shared("claude-a.json");
    await create(adminViewer, {
      kind: "member",
      subject: alice.id,
      period: "day",
      amountMicros: USD,
    });
    const first = await stub.models().pick({ ...REQUEST, memberId: alice.id });

    if (!first.ok) throw new Error(first.failure.code);
    await stub.models().report(first.lease, { success: true, httpStatus: 200, costMicros: USD });

    const refused = await stub.models().pick({ ...REQUEST, memberId: alice.id });

    expect(refused).toMatchObject({
      ok: false,
      failure: { code: "spend_limit_reached", httpStatus: 429, retryable: false },
    });

    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.failure.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.failure.message).toContain("daily");

    // Nobody else is limited, and the credential was never cooled.
    expect((await stub.models().pick({ ...REQUEST, memberId: bob.id })).ok).toBe(true);
  });

  it("keeps a plain member to their own API keys and below an admin's limit on them", async () => {
    const { stub, adminViewer, aliceViewer, bobViewer, alice, bob, key, create } = await freshOrg();
    const aliceKey = await key(alice, "laptop");
    const bobKey = await key(bob, "ci");

    const forKey = (subject: string, amountMicros: number): NewSpendLimit => ({
      kind: "key",
      subject,
      period: "day",
      amountMicros,
    });

    await create(adminViewer, forKey(aliceKey.id, 10 * USD));

    const own = await create(aliceViewer, forKey(aliceKey.id, 4 * USD));

    expect(own).toMatchObject({ source: "member", editable: true });

    // Not above the admin's, not on another member's key, nothing but keys.
    expect(
      await stub.createSpendLimit(
        aliceViewer,
        { ...forKey(aliceKey.id, 11 * USD), period: "day" },
        "a",
      ),
    ).toMatchObject({ ok: false });
    expect(await stub.updateSpendLimit(aliceViewer, own.id, 1, 11 * USD, "a")).toMatchObject({
      ok: false,
      error: "exceeds_admin_limit",
    });
    expect(await stub.createSpendLimit(aliceViewer, forKey(bobKey.id, USD), "a")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(
      await stub.createSpendLimit(
        aliceViewer,
        { kind: "member", subject: alice.id, period: "day", amountMicros: 1 },
        "a",
      ),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(
      await stub.createSpendLimit(
        aliceViewer,
        { kind: "org", subject: "", period: "day", amountMicros: 1 },
        "a",
      ),
    ).toMatchObject({ ok: false, error: "forbidden" });

    // Can edit and delete their own, not the admin's.
    const lowered = await stub.updateSpendLimit(aliceViewer, own.id, 1, 3 * USD, "a");

    expect(lowered).toMatchObject({ ok: true, value: { amountMicros: 3 * USD, revision: 2 } });
    expect(await stub.updateSpendLimit(aliceViewer, own.id, 1, USD, "a")).toMatchObject({
      ok: false,
      error: "conflict",
    });

    const adminEntry = (await stub.spendOverview(adminViewer)).entries.find(
      (e) => e.source === "admin",
    );

    expect(adminEntry).toBeDefined();
    expect(
      await stub.updateSpendLimit(aliceViewer, adminEntry?.id ?? "", 1, 99 * USD, "a"),
    ).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await stub.removeSpendLimit(bobViewer, own.id, 2)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await stub.removeSpendLimit(aliceViewer, own.id, 2)).toMatchObject({
      ok: true,
    });
  });

  it("shows a plain member the limits that bind them and nothing else", async () => {
    const { stub, adminViewer, aliceViewer, alice, bob, key, create, shared } = await freshOrg();

    await shared("claude-a.json");
    const team = await stub.createTeam("Platform");

    if (!team.ok) throw new Error(team.message);
    await stub.addTeamMember(team.value.id, alice.id);
    const other = await stub.createTeam("Other");

    if (!other.ok) throw new Error(other.message);
    const aliceKey = await key(alice, "laptop");
    const bobKey = await key(bob, "ci");

    await create(adminViewer, {
      kind: "org",
      subject: "",
      period: "month",
      amountMicros: 100 * USD,
    });
    await create(adminViewer, {
      kind: "team",
      subject: team.value.id,
      period: "week",
      amountMicros: 30 * USD,
    });
    await create(adminViewer, {
      kind: "team",
      subject: other.value.id,
      period: "week",
      amountMicros: 30 * USD,
    });
    await create(adminViewer, {
      kind: "member",
      subject: alice.id,
      period: "day",
      amountMicros: 5 * USD,
    });
    await create(adminViewer, {
      kind: "member",
      subject: bob.id,
      period: "day",
      amountMicros: 5 * USD,
    });
    await create(adminViewer, {
      kind: "key",
      subject: aliceKey.id,
      period: "day",
      amountMicros: 5 * USD,
    });
    await create(adminViewer, {
      kind: "key",
      subject: bobKey.id,
      period: "day",
      amountMicros: 5 * USD,
    });

    const seen = (await stub.spendOverview(aliceViewer)).entries.map((e) => [
      e.kind,
      e.label,
      e.editable,
    ]);

    expect(seen).toEqual([
      ["org", "Whole org", false],
      ["team", "Platform", false],
      ["member", "alice@example.com", false],
      ["key", expect.stringContaining("laptop"), false],
    ]);

    expect((await stub.spendOverview(adminViewer)).entries).toHaveLength(7);
  });

  it("names a shared credential's limit by its auth_index, never its id, and limits only shared credentials", async () => {
    const { org, stub, adminViewer, create, shared, alice } = await freshOrg();

    await shared("claude-a.json");
    const [credential] = await stub.models().listCredentials(FULL_ACCESS);

    expect(credential).toBeDefined();
    const authIndex = orgAuthIndexer(env, org)(credential?.id ?? "");

    expect(authIndex).toMatch(/^[0-9a-f]{16}$/);

    const entry = await create(adminViewer, {
      kind: "credential",
      subject: authIndex,
      period: "day",
      amountMicros: 0,
    });

    expect(entry).toMatchObject({ kind: "credential", subject: authIndex });
    expect(JSON.stringify(await stub.spendOverview(adminViewer))).not.toContain("claude-a.json");

    expect(
      await stub.createSpendLimit(
        adminViewer,
        { kind: "credential", subject: "claude-a.json", period: "week", amountMicros: 1 },
        "a",
      ),
    ).toMatchObject({ ok: false, error: "subject_not_found" });

    // The only shared credential is at its limit: nothing can serve, and it is not a refusal of the member.
    const picked = await stub.models().pick({ ...REQUEST, memberId: alice.id });

    expect(picked.ok).toBe(false);
  });

  it("refuses a limit for a subject that does not exist, and amounts that are not micro-USD", async () => {
    const { stub, adminViewer, alice } = await freshOrg();

    for (const input of [
      { kind: "member", subject: "nobody", period: "day", amountMicros: 1 },
      { kind: "team", subject: "nobody", period: "day", amountMicros: 1 },
      { kind: "key", subject: "nobody", period: "day", amountMicros: 1 },
    ] as const)
      expect(await stub.createSpendLimit(adminViewer, input, "a")).toMatchObject({
        ok: false,
        error: "subject_not_found",
      });

    for (const amountMicros of [-1, 0.5, Number.NaN])
      expect(
        await stub.createSpendLimit(
          adminViewer,
          { kind: "member", subject: alice.id, period: "day", amountMicros },
          "a",
        ),
      ).toMatchObject({ ok: false, error: "invalid" });
  });

  it("refuses by an API key's limit whatever serves the request, and charges the key for private traffic", async () => {
    const { stub, adminViewer, alice, key, create } = await freshOrg();
    const aliceKey = await key(alice, "laptop");

    await stub.setMembershipSettings({ privateCredentials: true });

    const imported = await stub
      .models()
      .importAuthFile(
        "claude-private.json",
        JSON.stringify(claudeFile()),
        { private: true },
        { member: alice.id, admin: false },
      );

    expect(imported.ok).toBe(true);

    await create(adminViewer, {
      kind: "member",
      subject: alice.id,
      period: "day",
      amountMicros: 0,
    });
    await create(adminViewer, {
      kind: "key",
      subject: aliceKey.id,
      period: "day",
      amountMicros: 3 * USD,
    });

    // The member's own limit does not touch their private credential; the key's limit counts it.
    const picked = await stub
      .models()
      .pick({ ...REQUEST, memberId: alice.id, apiKeyId: aliceKey.id });

    if (!picked.ok) throw new Error(picked.failure.code);
    expect(picked.lease.spend).toEqual([{ kind: "key", subject: aliceKey.id }]);
    await stub
      .models()
      .report(picked.lease, { success: true, httpStatus: 200, costMicros: 3 * USD });

    expect(
      await stub.models().pick({ ...REQUEST, memberId: alice.id, apiKeyId: aliceKey.id }),
    ).toMatchObject({
      ok: false,
      failure: { code: "spend_limit_reached", httpStatus: 429 },
    });

    // The same member without the key is served by the private credential.
    expect((await stub.models().pick({ ...REQUEST, memberId: alice.id })).ok).toBe(true);
  });

  it("sets the calendar and refuses an unknown time zone", async () => {
    const { stub, adminViewer } = await freshOrg();

    expect(await stub.setSpendSettings({ timeZone: "Europe/Berlin", weekStart: "sunday" })).toEqual(
      {
        ok: true,
        value: { timeZone: "Europe/Berlin", weekStart: "sunday" },
      },
    );
    expect(await stub.setSpendSettings({ timeZone: "Mars/Base" })).toMatchObject({
      ok: false,
      error: "invalid",
    });
    expect((await stub.spendOverview(adminViewer)).settings).toEqual({
      timeZone: "Europe/Berlin",
      weekStart: "sunday",
    });
  });

  it("forgets the limits of a member who leaves and of a team that is deleted", async () => {
    const { stub, adminViewer, alice, bob, create } = await freshOrg();
    const team = await stub.createTeam("Platform");

    if (!team.ok) throw new Error(team.message);
    await create(adminViewer, {
      kind: "member",
      subject: alice.id,
      period: "day",
      amountMicros: USD,
    });
    await create(adminViewer, {
      kind: "member",
      subject: bob.id,
      period: "day",
      amountMicros: USD,
    });
    await create(adminViewer, {
      kind: "team",
      subject: team.value.id,
      period: "day",
      amountMicros: USD,
    });

    expect((await stub.removeMember(alice.id, OWNER)).ok).toBe(true);
    expect((await stub.deleteTeam(team.value.id)).ok).toBe(true);
    expect((await stub.spendOverview(adminViewer)).entries.map((e) => e.label)).toEqual([
      "bob@example.com",
    ]);
  });
});

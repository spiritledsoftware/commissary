// The ControlPlane composed from the org-wide base and the areas' parts (`composeControlPlane`; #134 "How an area's
// ControlPlane part works", #148), on the test Worker's ControlPlane (test/worker.ts) with two dummy parts in workerd
// and real SQLite storage. Callers reach a part in one pipelined call through a method of its name, `stub.dummy().x()`
// (vitest-pool-workers refuses a pipelined call through a getter of a Durable Object stub, which #134 first planned).
// The parts keep their own tables, read the base through `core`, hear what changed in the org, and share the object's
// one alarm. A stub of a part the test still holds keeps `evictDurableObject` from finishing, so a test that restarts
// the object disposes of it first (`withPart`).
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { OrgId } from "@commissary/core";
import { composeControlPlane } from "../src/index.ts";
import { alarmOf, ORG_WIDE_TABLES, tablesOf, USD, withPart } from "./testing.ts";
import { DummyPart } from "./support/dummy-part.ts";

const OWNER = { role: "owner", sensitive: true } as const;

const HOUR_MS = 60 * 60_000;

const PART_TABLES = [
  "dummy_calls",
  "dummy_items",
  "dummy_wake_ups",
  "other_calls",
  "other_items",
  "other_wake_ups",
];

const freshOrg = () => OrgId.make(`compose-${crypto.randomUUID().slice(0, 8)}`);

const fresh = () => env.CONTROL_PLANE.getByName(freshOrg());

type Stub = ReturnType<typeof fresh>;

/** Adds a member to the org; answers their id. */
const addMember = async (stub: Stub, email: string): Promise<string> => {
  const added = await stub.addMember({ email, role: "member" }, OWNER, "test");

  if (!added.ok) throw new Error(`the base refused ${email}: ${added.message}`);

  return added.value.id;
};

describe("a ControlPlane composed with area parts", () => {
  it("reaches each part in one pipelined call, stub.dummy().x(), constructed once per object", async () => {
    const stub = fresh();

    expect(await stub.dummy().add("a")).toBe(1);
    expect(await stub.dummy().addLater("b")).toBe(2);
    expect(await stub.dummy().list()).toEqual(["a", "b"]);
    expect(await stub.other().list()).toEqual([]);
    expect(
      await runInDurableObject(
        stub,
        (plane) => plane.dummy() === plane.dummy() && plane.dummy() !== plane.other(),
      ),
    ).toBe(true);
  });

  it("keeps each part's tables next to the base's, and they outlive a restart", async () => {
    const stub = fresh();

    await withPart(stub.dummy(), (part) => part.add("kept"));
    await evictDurableObject(stub);

    expect(await stub.dummy().list()).toEqual(["kept"]);
    expect(await tablesOf(stub)).toEqual([...ORG_WIDE_TABLES, ...PART_TABLES].toSorted());
  });

  it("gives each part the base's view: the org, its members and its teams", async () => {
    const org = freshOrg();
    const stub = env.CONTROL_PLANE.getByName(org);

    await stub.createTeam("eng");
    await addMember(stub, "a@example.com");

    const view = { org, members: ["a@example.com"], teams: ["eng"] };

    expect(await stub.dummy().orgView()).toEqual(view);
    expect(await stub.other().orgView()).toEqual(view);
  });

  it("asks the parts to seal their plain text once, when the org's data key is made", async () => {
    const stub = fresh();

    expect(await withPart(stub.dummy(), (part) => part.calls())).toEqual(["sealPlaintext"]);
    await evictDurableObject(stub);
    expect(await stub.dummy().calls()).toEqual(["sealPlaintext"]);
    expect(await stub.other().calls()).toEqual(["sealPlaintext"]);
  });

  it("tells every part what changed in the org", async () => {
    const stub = fresh();
    const team = await stub.createTeam("eng");
    const a = await addMember(stub, "a@example.com");
    const b = await addMember(stub, "b@example.com");

    if (!team.ok) throw new Error("the base refused the team");
    await stub.addTeamMember(team.value.id, a);

    const revoked = await stub.createApiKey({ memberId: a, name: "revoked" }, Date.now());
    const kept = await stub.createApiKey({ memberId: a, name: "kept" }, Date.now());

    if (!revoked.ok || !kept.ok) throw new Error("the base refused the keys");
    await stub.revokeApiKey(revoked.value.record.id, Date.now());

    const { privateCredentials } = await stub.membershipSettings();

    await stub.setMembershipSettings({ privateCredentials: !privateCredentials });
    // Unchanged: no part hears of it.
    await stub.setMembershipSettings({ privateCredentials: !privateCredentials });
    await stub.removeMember(a, OWNER);
    await stub.leaveOrg("b@example.com");
    await stub.deleteTeam(team.value.id);

    const told = [
      "sealPlaintext",
      "teamMembersChanged",
      `apiKeysDeleted [${revoked.value.record.id}]`,
      "privateCredentialsChanged",
      `apiKeysDeleted [${kept.value.record.id}]`,
      `memberLeft ${a} removed`,
      "apiKeysDeleted []",
      `memberLeft ${b} left`,
      `teamDeleted ${team.value.id}`,
    ];

    expect(await stub.listMembers()).toEqual([]);
    expect(await stub.dummy().calls()).toEqual(told);
    expect(await stub.other().calls()).toEqual(told);
  });

  it("removes the Spend limits and counters of a member, team or API key it removes, and keeps the others", async () => {
    const stub = fresh();
    const admin = { admin: true } as const;
    const team = await stub.createTeam("eng");
    const a = await addMember(stub, "a@example.com");
    const b = await addMember(stub, "b@example.com");

    if (!team.ok) throw new Error("the base refused the team");
    await stub.addTeamMember(team.value.id, b);

    const key = await stub.createApiKey({ memberId: b, name: "ci" }, Date.now());

    if (!key.ok) throw new Error("the base refused the key");

    const subjects = [
      { kind: "member", subject: a },
      { kind: "member", subject: b },
      { kind: "team", subject: team.value.id },
      { kind: "key", subject: key.value.record.id },
      { kind: "org", subject: "" },
    ] as const;

    for (const { kind, subject } of subjects) {
      const made = await stub.createSpendLimit(
        admin,
        { kind, subject, period: "day", amountMicros: 10 * USD },
        "test",
      );

      if (!made.ok) throw new Error(`the base refused a ${kind} limit: ${made.message}`);
    }

    await stub.dummy().chargeSpend({ memberId: a }, USD);
    await stub.dummy().chargeSpend({ memberId: b, apiKeyId: key.value.record.id }, USD);

    const counted = async () =>
      runInDurableObject(stub, (_plane, state) =>
        state.storage.sql
          .exec<{ kind: string; subject: string }>(
            "SELECT DISTINCT subject_kind AS kind, subject_id AS subject FROM spend_counters",
          )
          .toArray()
          .map((row) => `${row.kind}:${row.subject}`)
          .toSorted(),
      );

    const limited = async () =>
      (await stub.spendOverview(admin)).entries
        .map((entry) => `${entry.kind}:${entry.subject}`)
        .toSorted();

    expect(await counted()).toEqual(
      [
        `key:${key.value.record.id}`,
        `member:${a}`,
        `member:${b}`,
        "org:",
        `team:${team.value.id}`,
      ].toSorted(),
    );

    await stub.revokeApiKey(key.value.record.id, Date.now());
    await stub.deleteTeam(team.value.id);
    await stub.removeMember(a, OWNER);

    expect(await limited()).toEqual(["org:", `member:${b}`].toSorted());
    expect(await counted()).toEqual(["org:", `member:${b}`].toSorted());
  });

  it("has each part delete its tables when the org is deleted, then the rest of the storage goes", async () => {
    const stub = fresh();

    await stub.dummy().add("gone");
    await runInDurableObject(stub, async (plane) => {
      const wipes = [vi.spyOn(plane.dummy(), "wipe"), vi.spyOn(plane.other(), "wipe")];

      await plane.wipeOrg();

      for (const wipe of wipes) expect(wipe).toHaveBeenCalledOnce();
    });

    expect(await tablesOf(stub)).toEqual([]);
  });

  it("refuses a part named after a member of the base, which the part would hide", () => {
    for (const name of [
      "admit",
      "wipeOrg",
      "alarm",
      "constructor",
      "ctx",
      "env",
      "parts",
      "started",
    ])
      expect(() =>
        composeControlPlane({ [name]: (ctx, _env, core) => new DummyPart(ctx, "dummy", core) }),
      ).toThrow(`a ControlPlane part cannot be named "${name}"`);
  });
});

describe("the composed ControlPlane's one alarm", () => {
  it("is set to the earliest wake-up of any part", async () => {
    const stub = fresh();
    const soon = Date.now() + HOUR_MS;

    await stub.dummy().wakeAt(soon + HOUR_MS);
    expect(await alarmOf(stub)).toBe(soon + HOUR_MS);
    await stub.other().wakeAt(soon);
    expect(await alarmOf(stub)).toBe(soon);
    await stub.dummy().wakeAt(soon + 2 * HOUR_MS);
    expect(await alarmOf(stub)).toBe(soon);
  });

  it("calls only the parts that are due, then is set to the next wake-up", async () => {
    const stub = fresh();
    const due = Date.now() - 1;
    const later = Date.now() + HOUR_MS;

    await stub.other().wakeAt(later);
    await stub.dummy().wakeAt(due);
    // The due alarm may fire on its own before this runs it; run early, the alarm calls no part that is not due.
    await runDurableObjectAlarm(stub);

    expect(await stub.dummy().ran()).toEqual([due]);
    expect(await stub.dummy().calls()).toEqual(["sealPlaintext", "alarm"]);
    expect(await stub.other().calls()).toEqual(["sealPlaintext"]);
    expect(await alarmOf(stub)).toBe(later);
  });

  it("calls every part after a restart, as none has said yet when it wakes", async () => {
    const stub = fresh();
    const later = Date.now() + HOUR_MS;

    await withPart(stub.dummy(), (part) => part.wakeAt(later));
    await evictDurableObject(stub);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.dummy().calls()).toEqual(["sealPlaintext", "alarm"]);
    expect(await stub.other().calls()).toEqual(["sealPlaintext", "alarm"]);
    expect(await stub.dummy().ran()).toEqual([]);
    expect(await alarmOf(stub)).toBe(later);
  });
});

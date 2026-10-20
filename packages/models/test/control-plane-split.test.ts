// The ControlPlane split into the org-wide base and the Models part (#134 "How an area's ControlPlane part works",
// #148): callers reach the part as `stub.models().x()`, one pipelined round trip (vitest-pool-workers refuses a
// pipelined call through a getter of a Durable Object stub, which #134 first planned). The split keeps the Durable
// Object class, its storage and every table; the part reads the base through `core`, and the object's one alarm
// reaches the part. A stub of the part the test holds keeps `evictDurableObject` from finishing, so a test that
// restarts the object disposes of it first.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { OrgId } from "@commissary/core";
import { alarmOf, ORG_WIDE_TABLES, storedText, tablesOf } from "@commissary/state/testing";
import { withModelsPart } from "./support/models-part.ts";

const OWNER = { role: "owner", sensitive: true } as const;

const HOUR_MS = 60 * 60_000;

/** The Models part's tables, as the ControlPlane named them before the split (Spend limits' are the base's since #199). */
const MODELS_TABLES = [
  "config_changes",
  "config_key_groups",
  "config_model_aliases",
  "config_model_exclusions",
  "config_payload_rules",
  "config_price_overrides",
  "config_provider_keys",
  "config_settings",
  "credential_quota_report",
  "credential_reset_grants",
  "credential_state",
  "credentials",
  "grant_state",
  "grants",
  "oauth_sessions",
  "private_key_changes",
  "private_key_groups",
  "quota_sweep_lease",
];

const fresh = () =>
  env.CONTROL_PLANE.getByName(OrgId.make(`split-${crypto.randomUUID().slice(0, 8)}`));

type Stub = ReturnType<typeof fresh>;

const claudeFile = (expiresAt: number) => ({
  type: "claude",
  email: "me@x.com",
  access_token: "sk-ant-oat-split",
  refresh_token: "rt-split",
  expired: new Date(expiresAt).toISOString(),
});

/** An org with data in every store the split moved: members and a team in the base, config and an account in the part. */
const populated = async () => {
  const stub = fresh();
  const team = await stub.createTeam("eng");
  const added = await stub.addMember({ email: "a@example.com", role: "member" }, OWNER, "test");

  if (!team.ok || !added.ok) throw new Error("the base refused the setup");
  await stub.addTeamMember(team.value.id, added.value.id);

  const lease = await withModelsPart(stub, async (part) => {
    await part.importConfig("routing:\n  strategy: fill-first\n", "test");
    await part.importAuthFile(
      "claude-a.json",
      claudeFile(Date.now() + 10 * HOUR_MS),
      {},
      FULL_ACCESS,
    );

    return await part.takeQuotaSweepLease("cron");
  });

  if (!lease.ok) throw new Error("the quota sweep lease is taken");

  return { stub, team: team.value.id, member: added.value.id };
};

/** What the base and the part answer about the org. */
const readBack = (stub: Stub) =>
  withModelsPart(stub, async (part) => ({
    members: await stub.listMembers(),
    teams: await stub.listTeams(),
    config: (await part.getConfig()).document,
    credentials: (await part.listCredentials(FULL_ACCESS)).map(({ id, disabled }) => ({
      id,
      disabled,
    })),
    grants: (await part.grantEntries()).grants,
  }));

describe("the ControlPlane's Models part", () => {
  it("is reached in one pipelined call, stub.models().x(), and constructed once per object", async () => {
    const stub = fresh();

    expect((await stub.models().getConfig()).version).toBe(0);
    expect(await runInDurableObject(stub, (plane) => plane.models() === plane.models())).toBe(true);
  });

  it("keeps every table of the ControlPlane under its name, the base's and the part's", async () => {
    const { stub } = await populated();

    expect(await tablesOf(stub)).toEqual([...ORG_WIDE_TABLES, ...MODELS_TABLES].toSorted());
  });

  it("reads back what the object stored, unchanged, after a restart", async () => {
    const { stub } = await populated();
    const stored = await storedText(stub);
    const before = await readBack(stub);

    await evictDurableObject(stub);

    expect(await storedText(stub)).toBe(stored);
    expect(await readBack(stub)).toEqual(before);
  });

  it("reads the org's members and teams through the base", async () => {
    const { stub, team } = await populated();
    const grant = { scope: { kind: "all" }, models: ["claude-sonnet-4-5"] } as const;

    expect(
      await stub
        .models()
        .writeGrant({ revision: 0, value: { ...grant, subject: { kind: "team", id: team } } }, "t"),
    ).toMatchObject({ ok: true });
    expect(
      await stub
        .models()
        .writeGrant(
          { revision: 0, value: { ...grant, subject: { kind: "team", id: "nope" } } },
          "t",
        ),
    ).toMatchObject({ ok: false, message: "no such team" });
  });

  it("drops its own tables when the org is deleted, none of the base's", async () => {
    const { stub } = await populated();

    await runInDurableObject(stub, (plane) => {
      plane.models().wipe();
    });

    expect(await tablesOf(stub)).toEqual(ORG_WIDE_TABLES);
  });
});

describe("the ControlPlane's one alarm", () => {
  it("calls the part only once its wake-up is due, and the part answers its next one", async () => {
    const stub = fresh();

    await runInDurableObject(stub, async (plane, state) => {
      await plane.started;
      const part = plane.models();

      await part.importAuthFile(
        "claude-a.json",
        claudeFile(Date.now() + 10 * HOUR_MS),
        {},
        FULL_ACCESS,
      );
      const due = await state.storage.getAlarm();
      const alarm = vi.spyOn(part, "alarm");

      // The part said when it wakes next (in hours): the alarm run now leaves it alone and keeps that wake-up.
      await plane.alarm();
      expect(alarm).not.toHaveBeenCalled();
      expect(await state.storage.getAlarm()).toBe(due);

      // Called by the base, the part runs what is due (nothing) and answers the same wake-up.
      alarm.mockRestore();
      expect(await part.alarm(Date.now())).toBe(due);
    });
  });

  it("is set to the part's next wake-up, and still reaches the part after a restart", async () => {
    const stub = fresh();

    await withModelsPart(stub, (part) =>
      part.importAuthFile("claude-a.json", claudeFile(Date.now() + 10 * HOUR_MS), {}, FULL_ACCESS),
    );
    const due = await alarmOf(stub);

    expect(due).not.toBeNull();
    await evictDurableObject(stub);

    // The new instance has not heard from the part yet: the alarm runs it, which sets the same wake-up again.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmOf(stub)).toBe(due);
  });
});

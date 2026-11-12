// Grants in the real ControlPlane (ADR 0023): the writes (revisions, conflicts, what a grant may name), what a pick does
// the moment a grant changes, team grants following the team, and grants leaving with their member or team.
import { describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import { claudeFile, controlPlane } from "./support/control-plane.ts";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { type GrantValue } from "../src/grants/grant.ts";

const OWNER = { role: "owner", sensitive: true } as const;

type Stub = ReturnType<typeof controlPlane>;

const SONNET = "claude-sonnet-4-5";

const OPUS = "claude-opus-4-1";

/** An org with one shared Claude account, an admin and two members; its default grant is removed. */
const newOrg = async () => {
  const stub = controlPlane(OrgId.make(`gcp-${crypto.randomUUID().slice(0, 8)}`));

  await stub
    .models()
    .importAuthFile("sub-a.json", claudeFile({ email: "a@example.com" }), {}, FULL_ACCESS);

  const person = async (name: string) => {
    const added = await stub.addMember(
      { email: `${name}@example.com`, role: "member" },
      OWNER,
      "t",
    );

    if (!added.ok) throw new Error(added.message);

    return added.value.id;
  };

  const [initial] = (await stub.models().grantEntries()).grants;

  await stub
    .models()
    .writeGrant({ id: initial?.id ?? "", revision: initial?.revision ?? 0, value: null }, "t");

  return { stub, alice: await person("alice"), bob: await person("bob") };
};

const grantOf = (
  subject: GrantValue["subject"],
  models: string[],
  scope: GrantValue["scope"] = { kind: "all" },
): GrantValue => ({
  subject,
  scope,
  models,
});

const creates = async (stub: Stub, value: GrantValue) => {
  const written = await stub.models().writeGrant({ revision: 0, value }, "admin-1");

  if (!written.ok) throw new Error(written.message);

  return written;
};

const serves = async (stub: Stub, member: string | undefined, model: string) =>
  (
    await stub.models().pick({
      providers: ["claude"],
      model,
      ...(member === undefined ? {} : { memberId: member }),
    })
  ).ok;

describe("writing grants", () => {
  it("creates, replaces and deletes a grant at the revision it names", async () => {
    const { stub, alice } = await newOrg();
    const created = await creates(stub, grantOf({ kind: "member", id: alice }, ["claude-*"]));

    expect(created.revision).toBeGreaterThan(0);
    expect((await stub.models().grantEntries()).grants).toEqual([
      expect.objectContaining({
        id: created.id,
        revision: created.revision,
        updated_by: "admin-1",
        models: ["claude-*"],
      }),
    ]);

    const replaced = await stub.models().writeGrant(
      {
        id: created.id,
        revision: created.revision,
        value: grantOf({ kind: "member", id: alice }, [" Claude-Sonnet-* ", "claude-sonnet-*"]),
      },
      "admin-2",
    );

    expect(replaced.ok && replaced.revision).toBeGreaterThan(created.revision);
    expect((await stub.models().grantEntries()).grants[0]).toMatchObject({
      models: ["claude-sonnet-*"],
      updated_by: "admin-2",
    });

    const deleted = await stub
      .models()
      .writeGrant(
        { id: created.id, revision: replaced.ok ? replaced.revision : 0, value: null },
        "admin-2",
      );

    expect(deleted.ok).toBe(true);
    expect((await stub.models().grantEntries()).grants).toEqual([]);
  });

  it("refuses a write based on a stale revision, and a grant that already exists", async () => {
    const { stub, alice } = await newOrg();
    const created = await creates(stub, grantOf({ kind: "member", id: alice }, ["a"]));

    const stale = await stub.models().writeGrant(
      {
        id: created.id,
        revision: created.revision + 5,
        value: grantOf({ kind: "member", id: alice }, ["b"]),
      },
      "admin-1",
    );

    expect(stale).toMatchObject({ ok: false, error: "conflict" });

    const twice = await stub
      .models()
      .writeGrant({ revision: 0, value: grantOf({ kind: "member", id: alice }, ["c"]) }, "admin-1");

    expect(twice).toMatchObject({ ok: false, error: "conflict" });
    expect((await stub.models().grantEntries()).grants).toHaveLength(1);
    expect((await stub.models().grantEntries()).grants[0]?.models).toEqual(["a"]);
  });

  it("refuses a grant that names nothing, nobody or nothing that exists", async () => {
    const { stub } = await newOrg();

    const write = async (value: GrantValue) =>
      await stub.models().writeGrant({ revision: 0, value }, "t");

    expect(await write(grantOf({ kind: "everyone" }, ["  ", ""]))).toMatchObject({
      ok: false,
      error: "invalid",
    });
    expect(await write(grantOf({ kind: "member", id: "nobody" }, ["*"]))).toMatchObject({
      ok: false,
      error: "invalid",
    });
    expect(await write(grantOf({ kind: "team", id: "nothing" }, ["*"]))).toMatchObject({
      ok: false,
      error: "invalid",
    });
    expect(
      await write(grantOf({ kind: "everyone" }, ["*"], { kind: "credential", id: " " })),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect((await stub.models().grantEntries()).grants).toEqual([]);
  });
});

describe("picks follow the grants at once", () => {
  it("serves what a grant names and nothing else, and stops when the grant is deleted", async () => {
    const { stub, alice, bob } = await newOrg();

    expect(await serves(stub, alice, SONNET)).toBe(false);

    const created = await creates(
      stub,
      grantOf({ kind: "member", id: alice }, ["claude-sonnet-*"], {
        kind: "credential",
        id: "sub-a.json",
      }),
    );

    expect(await serves(stub, alice, SONNET)).toBe(true);
    expect(await serves(stub, alice, OPUS)).toBe(false);
    expect(await serves(stub, bob, SONNET)).toBe(false);
    expect(await serves(stub, undefined, SONNET)).toBe(false);

    await stub
      .models()
      .writeGrant({ id: created.id, revision: created.revision, value: null }, "t");

    expect(await serves(stub, alice, SONNET)).toBe(false);
  });

  it("answers an unreachable model with the unknown-model failure", async () => {
    const { stub, alice } = await newOrg();

    const result = await stub
      .models()
      .pick({ providers: ["claude"], model: OPUS, memberId: alice });

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.failure).toMatchObject({ code: "model_not_found", httpStatus: 400 });
  });

  it("serves a team grant to the team's members for as long as they are in it", async () => {
    const { stub, alice, bob } = await newOrg();
    const created = await stub.createTeam("platform");

    if (!created.ok) throw new Error(created.message);

    const team = created.value.id;

    await creates(stub, grantOf({ kind: "team", id: team }, ["*"]));

    expect(await serves(stub, alice, SONNET)).toBe(false);

    await stub.addTeamMember(team, alice);

    expect(await serves(stub, alice, SONNET)).toBe(true);
    expect(await serves(stub, bob, SONNET)).toBe(false);

    await stub.removeTeamMember(team, alice);

    expect(await serves(stub, alice, SONNET)).toBe(false);
  });

  it("serves a grant for everyone to a request without a member too", async () => {
    const { stub, alice } = await newOrg();

    await creates(stub, grantOf({ kind: "everyone" }, ["claude-sonnet-*"]));

    expect(await serves(stub, undefined, SONNET)).toBe(true);
    expect(await serves(stub, alice, SONNET)).toBe(true);
    expect(await serves(stub, alice, OPUS)).toBe(false);
  });
});

describe("grants leave with who they named", () => {
  it("drops a member's grants when the member is removed", async () => {
    const { stub, alice } = await newOrg();

    await creates(stub, grantOf({ kind: "member", id: alice }, ["*"]));

    expect((await stub.removeMember(alice, OWNER)).ok).toBe(true);
    expect((await stub.models().grantEntries()).grants).toEqual([]);
  });

  it("drops a team's grants when the team is deleted", async () => {
    const { stub } = await newOrg();
    const created = await stub.createTeam("temp");

    if (!created.ok) throw new Error(created.message);

    await creates(stub, grantOf({ kind: "team", id: created.value.id }, ["*"]));

    expect((await stub.deleteTeam(created.value.id)).ok).toBe(true);
    expect((await stub.models().grantEntries()).grants).toEqual([]);
  });
});

describe("the grant table of the registry", () => {
  it("carries the grants, the teams and a version that moves with each change", async () => {
    const { stub, alice } = await newOrg();
    const created = await stub.createTeam("platform");

    if (!created.ok) throw new Error(created.message);

    const before = await stub.models().grantTable();

    await stub.addTeamMember(created.value.id, alice);

    const joined = await stub.models().grantTable();

    expect(joined.version).toBeGreaterThan(before.version);
    expect(joined.teams).toEqual([{ id: created.value.id, members: [alice] }]);

    await creates(stub, grantOf({ kind: "team", id: created.value.id }, ["*"]));

    const granted = await stub.models().grantTable();

    expect(granted.version).toBeGreaterThan(joined.version);
    expect(granted.grants).toHaveLength(1);
  });
});

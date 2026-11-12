// Cost breakdowns by member, team and API key (issue #71, deferred from #70): GET /observability/usage/summary
// grouped by `member`, `team` and `key`, with private-credential traffic left to its owner (ADR 0023).
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";
import { insertUsageRecord, resetUsageDb, sampleRecord } from "@commissary/models/testing";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

beforeAll(async () => {
  await resetUsageDb();
});

interface Auth {
  readonly auth: string;
}

const as = async (email: string): Promise<Auth> => ({ auth: await token(email) });

const send = async (
  slug: string,
  path: string,
  who: Auth,
  method = "GET",
  body?: Parameters<typeof jsonInit>[1],
) =>
  await harness.json(`/v9/management/orgs/${slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    ...who,
  });

interface Group {
  readonly key: string;
  readonly requests: number;
  readonly cost_micros: number;
}

const groups = async (slug: string, by: string, who: Auth) => {
  const reply = await send(slug, `/observability/usage/summary?group_by=${by}`, who);

  expect(reply.status).toBe(200);
  const body = reply.body as { totals: Group; groups: ReadonlyArray<Group> };

  return {
    totals: body.totals,
    byKey: Object.fromEntries(body.groups.map((group) => [group.key, group])),
  };
};

/** An org with an admin, alice and bob (private credentials on) and a team of alice and bob's records. */
const setup = async () => {
  const slug = `brk-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await as(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug, private_credentials: true }),
  );

  expect(created.status).toBe(201);
  const org = OrgId.make((created.body as { id: string }).id);

  const person = async (name: string, role: string) => {
    const email = `${name}-${slug}@example.com`;
    const added = await send(slug, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, email, ...(await as(email)) };
  };

  const admin = await person("admin", "admin");
  const alice = await person("alice", "member");
  const bob = await person("bob", "member");
  const carol = await person("carol", "member");

  const platformTeam = await send(slug, "/teams", admin, "POST", { name: "Platform" });
  const dataTeam = await send(slug, "/teams", admin, "POST", { name: "Data" });
  const platformId = (platformTeam.body as { id: string }).id;
  const dataId = (dataTeam.body as { id: string }).id;

  for (const [team, who] of [
    [platformId, alice],
    [platformId, bob],
    [dataId, bob],
  ] as const)
    expect(
      (await send(slug, `/teams/${team}/members`, admin, "POST", { member_id: who.id })).status,
    ).toBe(200);

  const record = (
    requestId: string,
    who: { readonly id: string; readonly email: string },
    micros: number,
    extra: Partial<Parameters<typeof sampleRecord>[0]> = {},
  ) =>
    insertUsageRecord(
      env.USAGE,
      sampleRecord({
        requestId,
        orgId: org,
        principalId: "user:" + who.email,
        memberId: who.id,
        cost: { micros, unpriced: false },
        ...extra,
      }),
    );

  return { slug, org, admin, alice, bob, carol, platformId, dataId, record };
};

describe("usage cost breakdowns", () => {
  it("groups the cost by member, by team and by API key", async () => {
    const o = await setup();

    await o.record("a1", o.alice, 1_000_000, { principalId: `key:key-alice` });
    await o.record("a2", o.alice, 2_000_000, { principalId: `key:key-alice` });
    await o.record("a3", o.alice, 500_000);
    await o.record("b1", o.bob, 4_000_000, { principalId: `key:key-bob` });
    await o.record("c1", o.carol, 8_000_000);

    const members = await groups(o.slug, "member", o.admin);

    expect(members.byKey[o.alice.id]).toMatchObject({ requests: 3, cost_micros: 3_500_000 });
    expect(members.byKey[o.bob.id]).toMatchObject({ requests: 1, cost_micros: 4_000_000 });
    expect(members.totals).toMatchObject({ requests: 5, cost_micros: 15_500_000 });

    // A member may be in several teams: bob is in both, carol in none.
    const teams = await groups(o.slug, "team", o.admin);

    expect(teams.byKey[o.platformId]).toMatchObject({ requests: 4, cost_micros: 7_500_000 });
    expect(teams.byKey[o.dataId]).toMatchObject({ requests: 1, cost_micros: 4_000_000 });
    expect(Object.keys(teams.byKey)).toHaveLength(2);
    expect(teams.totals).toMatchObject({ requests: 5, cost_micros: 15_500_000 });

    const keys = await groups(o.slug, "key", o.admin);

    expect(keys.byKey["key-alice"]).toMatchObject({ requests: 2, cost_micros: 3_000_000 });
    expect(keys.byKey["key-bob"]).toMatchObject({ requests: 1, cost_micros: 4_000_000 });
    // Records of any other sign-in have no key.
    expect(keys.byKey[""]).toMatchObject({ requests: 2, cost_micros: 8_500_000 });
  });

  it("keeps the other filters: a team breakdown within a member filter and a time range", async () => {
    const o = await setup();

    await o.record("old", o.bob, 1_000_000, { requestedAt: 1_000 });
    await o.record("new", o.bob, 2_000_000, { requestedAt: 5_000 });
    await o.record("alice", o.alice, 4_000_000, { requestedAt: 5_000 });

    const reply = await send(
      o.slug,
      `/observability/usage/summary?group_by=team&member=${o.bob.id}&since=2000`,
      o.admin,
    );

    const body = reply.body as { groups: ReadonlyArray<Group> };

    expect(
      Object.fromEntries(
        body.groups.map((group) => [group.key, [group.requests, group.cost_micros]]),
      ),
    ).toEqual({
      [o.dataId]: [1, 2_000_000],
      [o.platformId]: [1, 2_000_000],
    });
  });

  it("shows private-credential traffic to its owner alone, in every breakdown", async () => {
    const o = await setup();

    await o.record("shared", o.alice, 1_000_000, { principalId: "key:key-alice" });
    await o.record("private", o.alice, 6_000_000, { principalId: "key:key-alice", private: true });

    for (const by of ["member", "team", "key"]) {
      const mine = await groups(o.slug, by, o.alice);
      const admins = await groups(o.slug, by, o.admin);
      const bobs = await groups(o.slug, by, o.bob);

      expect(mine.totals, by).toMatchObject({ requests: 2, cost_micros: 7_000_000 });
      expect(admins.totals, by).toMatchObject({ requests: 1, cost_micros: 1_000_000 });
      expect(bobs.totals, by).toMatchObject({ requests: 0, cost_micros: 0 });
    }

    const keys = await groups(o.slug, "key", o.alice);
    const adminKeys = await groups(o.slug, "key", o.admin);

    expect(keys.byKey["key-alice"]?.cost_micros).toBe(7_000_000);
    expect(adminKeys.byKey["key-alice"]?.cost_micros).toBe(1_000_000);

    const teams = await groups(o.slug, "team", o.admin);

    expect(teams.byKey[o.platformId]?.cost_micros).toBe(1_000_000);
  });

  it("shows a plain member only their own records by team and key", async () => {
    const o = await setup();

    await o.record("a", o.alice, 1_000_000, { principalId: "key:key-alice" });
    await o.record("b", o.bob, 2_000_000, { principalId: "key:key-bob" });

    expect((await groups(o.slug, "team", o.alice)).byKey[o.platformId]).toMatchObject({
      requests: 1,
      cost_micros: 1_000_000,
    });
    expect(Object.keys((await groups(o.slug, "key", o.alice)).byKey)).toEqual(["key-alice"]);
  });

  it("refuses an unknown grouping", async () => {
    const o = await setup();

    expect(
      (await send(o.slug, "/observability/usage/summary?group_by=tenant", o.admin)).status,
    ).toBe(400);
  });
});

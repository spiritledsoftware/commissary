// Spend limits through the management routes (apps/app/src/management/spend-routes.ts, @commissary/contract/spend): what an org
// admin and a plain member see and write, revisions, the calendar and the Access gate. Through the router with real
// ControlPlanes.
import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { SpendView, SpendLimitView } from "@commissary/contract/spend";
import { OrgId } from "@commissary/core";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";
import { USD } from "@commissary/models/testing";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

interface Auth {
  readonly auth: string;
}

const as = async (email: string): Promise<Auth> => ({ auth: await token(email) });

const api = (slug: string, path: string) => `/v9/management/orgs/${slug}${path}`;

const send = async (
  slug: string,
  path: string,
  who: Auth,
  method = "GET",
  body?: Parameters<typeof jsonInit>[1],
  headers: Record<string, string> = {},
) => {
  const init = body === undefined ? { method } : jsonInit(method, body);

  return await harness.json(api(slug, path), {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), ...headers },
    ...who,
  });
};

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

const decodeView = Schema.decodeUnknownSync(SpendView);

const decodeLimit = Schema.decodeUnknownSync(SpendLimitView);

/** An org of its own with an admin, two plain members, a team with alice in it and an API key each. */
const staffedOrg = async () => {
  const slug = `spend-${crypto.randomUUID().slice(0, 8)}`;
  const platformAdmin = await as(ADMIN);
  const created = await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }));

  expect(created.status).toBe(201);
  const org = OrgId.make((created.body as { id: string }).id);

  const add = async (email: string, role: string) => {
    const reply = await send(slug, "/members", platformAdmin, "POST", { email, role });

    expect(reply.status).toBe(201);

    return { id: (reply.body as { id: string }).id, email, ...(await as(email)) };
  };

  const admin = await add(`admin-${slug}@example.com`, "admin");
  const alice = await add(`alice-${slug}@example.com`, "member");
  const bob = await add(`bob-${slug}@example.com`, "member");

  const team = await send(slug, "/teams", admin, "POST", { name: "Platform" });

  expect(team.status).toBe(201);
  const teamId = (team.body as { id: string }).id;

  expect(
    (await send(slug, `/teams/${teamId}/members`, admin, "POST", { member_id: alice.id })).status,
  ).toBe(200);

  const key = async (who: typeof alice) => {
    const reply = await send(slug, "/api-keys", who, "POST", { name: "laptop" });

    expect(reply.status).toBe(201);

    return (reply.body as { id: string }).id;
  };

  return {
    org,
    slug,
    platformAdmin,
    admin,
    alice,
    bob,
    teamId,
    aliceKey: await key(alice),
    bobKey: await key(bob),
  };
};

const limitBody = (kind: string, subject: string, period = "day", amount = 5 * USD) => ({
  kind,
  subject,
  period,
  amount_micros: amount,
});

describe("Spend limit routes", () => {
  it("lets an org admin write every kind of limit and read them with the Spend so far", async () => {
    const o = await staffedOrg();

    for (const body of [
      limitBody("org", "", "month", 100 * USD),
      limitBody("team", o.teamId, "week", 40 * USD),
      limitBody("member", o.alice.id),
      limitBody("key", o.bobKey),
    ]) {
      const reply = await send(o.slug, "/spend/limits", o.admin, "POST", body);

      expect(reply.status).toBe(201);
      expect(decodeLimit(reply.body)).toMatchObject({
        kind: body.kind,
        source: "admin",
        revision: 1,
        spent_micros: 0,
        remaining_micros: body.amount_micros,
        editable: true,
      });
    }

    const overview = decodeView((await send(o.slug, "/spend", o.admin)).body);

    expect(overview).toMatchObject({ time_zone: "UTC", week_start: "monday" });
    expect(overview.limits.map((limit) => limit.kind)).toEqual(["org", "team", "member", "key"]);
    expect(overview.limits.find((limit) => limit.kind === "member")?.label).toBe(o.alice.email);
    expect(new Date(overview.limits[0]?.resets_at ?? "").getTime()).toBeGreaterThan(Date.now());
  });

  it("shows a plain member the limits that bind them and no others", async () => {
    const o = await staffedOrg();

    for (const body of [
      limitBody("org", "", "month"),
      limitBody("team", o.teamId, "week"),
      limitBody("member", o.alice.id),
      limitBody("member", o.bob.id),
      limitBody("key", o.aliceKey),
      limitBody("key", o.bobKey),
    ])
      expect((await send(o.slug, "/spend/limits", o.admin, "POST", body)).status).toBe(201);

    const alices = decodeView((await send(o.slug, "/spend", o.alice)).body);

    expect(alices.limits.map((limit) => [limit.kind, limit.editable])).toEqual([
      ["org", false],
      ["team", false],
      ["member", false],
      ["key", false],
    ]);

    const bobs = decodeView((await send(o.slug, "/spend", o.bob)).body);

    expect(bobs.limits.map((limit) => limit.kind)).toEqual(["org", "member", "key"]);
    expect(bobs.limits.find((limit) => limit.kind === "member")?.label).toBe(o.bob.email);
  });

  it("lets a member limit their own API keys, below an admin's limit and not others' keys", async () => {
    const o = await staffedOrg();

    expect(
      (
        await send(
          o.slug,
          "/spend/limits",
          o.admin,
          "POST",
          limitBody("key", o.aliceKey, "day", 10 * USD),
        )
      ).status,
    ).toBe(201);

    const own = await send(
      o.slug,
      "/spend/limits",
      o.alice,
      "POST",
      limitBody("key", o.aliceKey, "day", 4 * USD),
    );

    expect(own.status).toBe(201);
    expect(decodeLimit(own.body)).toMatchObject({
      source: "member",
      editable: true,
      amount_micros: 4 * USD,
    });

    const above = await send(
      o.slug,
      "/spend/limits",
      o.alice,
      "POST",
      limitBody("key", o.aliceKey, "week", 1 * USD),
    );

    // A weekly limit has no admin limit above it.
    expect(above.status).toBe(201);

    const id = (own.body as { id: string }).id;

    const raise = await send(
      o.slug,
      `/spend/limits/${id}`,
      o.alice,
      "PUT",
      { amount_micros: 11 * USD },
      { "if-match": "1" },
    );

    expect([raise.status, errorOf(raise)]).toEqual([422, "exceeds_admin_limit"]);

    const lower = await send(
      o.slug,
      `/spend/limits/${id}`,
      o.alice,
      "PUT",
      { amount_micros: 3 * USD },
      { "if-match": "1" },
    );

    expect(lower.status).toBe(200);
    expect(decodeLimit(lower.body)).toMatchObject({ amount_micros: 3 * USD, revision: 2 });

    const others = await send(o.slug, "/spend/limits", o.alice, "POST", limitBody("key", o.bobKey));

    expect([others.status, errorOf(others)]).toEqual([403, "forbidden"]);

    for (const body of [
      limitBody("member", o.alice.id),
      limitBody("org", ""),
      limitBody("team", o.teamId),
    ]) {
      const refused = await send(o.slug, "/spend/limits", o.alice, "POST", body);

      expect([refused.status, errorOf(refused)]).toEqual([403, "forbidden"]);
    }

    // Not the admin's limit, and not by another member.
    const overview = decodeView((await send(o.slug, "/spend", o.admin)).body);

    const adminLimit = overview.limits.find(
      (limit) => limit.source === "admin" && limit.kind === "key",
    );

    const edit = await send(
      o.slug,
      `/spend/limits/${adminLimit?.id ?? ""}`,
      o.alice,
      "PUT",
      { amount_micros: 99 * USD },
      { "if-match": "1" },
    );

    expect([edit.status, errorOf(edit)]).toEqual([403, "forbidden"]);

    const removeOthers = await send(o.slug, `/spend/limits/${id}`, o.bob, "DELETE", undefined, {
      "if-match": "2",
    });

    expect([removeOthers.status, errorOf(removeOthers)]).toEqual([403, "forbidden"]);
    expect(
      (await send(o.slug, `/spend/limits/${id}`, o.alice, "DELETE", undefined, { "if-match": "2" }))
        .status,
    ).toBe(200);
  });

  it("answers a stale or missing revision, a missing limit, a bad subject and a bad amount", async () => {
    const o = await staffedOrg();

    const made = await send(
      o.slug,
      "/spend/limits",
      o.admin,
      "POST",
      limitBody("member", o.alice.id),
    );

    const id = (made.body as { id: string }).id;

    const stale = await send(
      o.slug,
      `/spend/limits/${id}`,
      o.admin,
      "PUT",
      { amount_micros: 1 },
      { "if-match": "7" },
    );

    expect([stale.status, errorOf(stale)]).toEqual([409, "conflict"]);

    const noHeader = await send(o.slug, `/spend/limits/${id}`, o.admin, "PUT", {
      amount_micros: 1,
    });

    expect([noHeader.status, errorOf(noHeader)]).toEqual([400, "invalid_if_match"]);

    const missing = await send(o.slug, "/spend/limits/nope", o.admin, "DELETE", undefined, {
      "if-match": "1",
    });

    expect([missing.status, errorOf(missing)]).toEqual([404, "not_found"]);

    const dup = await send(
      o.slug,
      "/spend/limits",
      o.admin,
      "POST",
      limitBody("member", o.alice.id),
    );

    expect([dup.status, errorOf(dup)]).toEqual([409, "conflict"]);

    const ghost = await send(
      o.slug,
      "/spend/limits",
      o.admin,
      "POST",
      limitBody("member", "nobody"),
    );

    expect([ghost.status, errorOf(ghost)]).toEqual([404, "subject_not_found"]);

    for (const amount of [-1, 1.5]) {
      const bad = await send(
        o.slug,
        "/spend/limits",
        o.admin,
        "POST",
        limitBody("member", o.bob.id, "day", amount),
      );

      expect([bad.status, errorOf(bad)]).toEqual([422, "invalid_limit"]);
    }

    const garbage = await send(o.slug, "/spend/limits", o.admin, "POST", {
      kind: "everyone",
      subject: "",
      period: "day",
      amount_micros: 1,
    });

    expect([garbage.status, errorOf(garbage)]).toEqual([400, "invalid body"]);
  });

  it("keeps the calendar for org admins and refuses what is not a time zone or a weekday", async () => {
    const o = await staffedOrg();

    const denied = await send(o.slug, "/spend/settings", o.alice, "PATCH", {
      time_zone: "Asia/Tokyo",
    });

    expect(denied.status).toBe(403);

    const set = await send(o.slug, "/spend/settings", o.admin, "PATCH", {
      time_zone: "Asia/Tokyo",
      week_start: "sunday",
    });

    expect(set).toMatchObject({
      status: 200,
      body: { time_zone: "Asia/Tokyo", week_start: "sunday" },
    });
    expect(decodeView((await send(o.slug, "/spend", o.alice)).body)).toMatchObject({
      time_zone: "Asia/Tokyo",
      week_start: "sunday",
    });

    for (const body of [
      { time_zone: "Mars/Base" },
      { week_start: "someday" },
      { time_zone: "+02:00" },
    ]) {
      const refused = await send(o.slug, "/spend/settings", o.admin, "PATCH", body);

      expect([refused.status, errorOf(refused)]).toEqual([422, "invalid_settings"]);
    }
  });

  it("is for members of the org: a caller outside it is refused", async () => {
    const o = await staffedOrg();
    const stranger = await as("stranger@example.com");

    expect((await send(o.slug, "/spend", stranger)).status).toBeGreaterThanOrEqual(401);
    expect(
      (await send(o.slug, "/spend/limits", stranger, "POST", limitBody("org", ""))).status,
    ).toBeGreaterThanOrEqual(401);
  });
});

// An org's members, teams and service tokens through the management API (ADR 0022, the permission matrix of
// docs/ACCESS.md): who may reach which route, who may grant which role, auto-join, membership in several orgs, ADR
// 0006's rule per org, and that a removed member is refused on the next request. Through the router with the real
// ControlPlanes and a Platform registry of its own; every test works in an org of its own.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  ADMIN,
  claudeFile,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  serviceToken,
  token,
} from "./support/management.ts";
import { OrgId } from "@commissary/core";
import { insertUsageRecord, resetUsageDb, sampleRecord } from "@commissary/models/testing";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

beforeAll(async () => {
  await resetUsageDb();
});

type Payload = Parameters<typeof jsonInit>[1];

interface Auth {
  readonly auth: string;
}

interface MemberBody {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly teams: ReadonlyArray<string>;
}

const as = async (email: string): Promise<Auth> => ({ auth: await token(email) });

const asToken = async (clientId: string): Promise<Auth> => ({ auth: await serviceToken(clientId) });

const asAdmin = () => as(ADMIN);

/** Creates an org of its own for a test (as the platform admin) and answers with its slug. */
const newOrg = async (prefix: string): Promise<string> => {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }));

  expect(created.status).toBe(201);

  return slug;
};

const api = (slug: string, path: string) => `/v9/management/orgs/${slug}${path}`;

const send = async (
  slug: string,
  path: string,
  who: Auth,
  method = "GET",
  body?: Payload,
): Promise<{ status: number; body: unknown }> =>
  await harness.json(api(slug, path), {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    ...who,
  });

/** The status of a request whose body is not JSON (or not needed). */
const statusOf = async (slug: string, path: string, who: Auth, method = "GET"): Promise<number> =>
  (await harness.call(api(slug, path), { method, ...who })).status;

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

/** Adds `email` with `role` as the platform admin, who is an owner of every org. */
const addMember = async (slug: string, email: string, role: string): Promise<MemberBody> => {
  const reply = await send(slug, "/members", await asAdmin(), "POST", { email, role });

  expect(reply.status).toBe(201);

  return reply.body as MemberBody;
};

const members = async (slug: string): Promise<ReadonlyArray<MemberBody>> =>
  ((await send(slug, "/members", await asAdmin())).body as { members: ReadonlyArray<MemberBody> })
    .members;

/** An org with an owner, an admin and a plain member. */
const staffedOrg = async (prefix: string) => {
  const slug = await newOrg(prefix);
  const owner = await addMember(slug, `owner-${slug}@example.com`, "owner");
  const admin = await addMember(slug, `admin-${slug}@example.com`, "admin");
  const member = await addMember(slug, `member-${slug}@example.com`, "member");

  return {
    slug,
    owner: { ...owner, ...(await as(owner.email)) },
    admin: { ...admin, ...(await as(admin.email)) },
    member: { ...member, ...(await as(member.email)) },
  };
};

const USAGE = "/observability/usage/records";

/** A service token's Client ID of its own for a test. */
const clientId = (slug: string, name: string) => `${name}-${slug}.access`;

describe("the permission matrix", () => {
  it("lets a plain member read usage and use the panel's pages, and nothing an admin manages", async () => {
    const { slug, member } = await staffedOrg("matrix-member");

    expect((await send(slug, USAGE, member)).status).toBe(200);
    expect((await send(slug, "/observability/usage/summary", member)).status).toBe(200);
    expect((await harness.call(`/orgs/${slug}/usage`, member)).status).not.toBe(403);

    for (const [method, path] of [
      ["GET", "/settings"],
      ["GET", "/members"],
      ["GET", "/teams"],
      ["GET", "/service-tokens"],
      ["DELETE", USAGE],
    ] as const)
      expect(await statusOf(slug, path, member, method), `${method} ${path}`).toBe(403);

    expect((await send(slug, "/members", member, "POST", { email: "x@example.com" })).status).toBe(
      403,
    );
  });

  it("lets an admin manage plain members and teams, but not roles or who may join", async () => {
    const { slug, admin, member, owner } = await staffedOrg("matrix-admin");

    expect((await send(slug, "/members", admin)).status).toBe(200);
    expect(await statusOf(slug, "/settings", admin)).toBe(200);

    const added = await send(slug, "/members", admin, "POST", { email: "new@example.com" });

    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ email: "new@example.com", role: "member", teams: [] });

    for (const role of ["admin", "owner"]) {
      const refused = await send(slug, "/members", admin, "POST", {
        email: `${role}-try@example.com`,
        role,
      });

      expect(refused.status, role).toBe(403);
      expect(errorOf(refused)).toBe("owner_required");
    }

    const promote = await send(slug, `/members/${member.id}`, admin, "PATCH", { role: "admin" });

    expect(promote.status).toBe(403);
    expect(errorOf(promote)).toBe("owner_required");

    // An admin removes plain members, not other admins or owners.
    expect((await send(slug, `/members/${owner.id}`, admin, "DELETE")).status).toBe(403);
    expect((await send(slug, `/members/${member.id}`, admin, "DELETE")).status).toBe(200);

    const autoJoin = await send(slug, "/membership", admin, "PATCH", { auto_join: true });

    expect(autoJoin.status).toBe(403);
    expect(errorOf(autoJoin)).toBe("owner_required");

    const team = await send(slug, "/teams", admin, "POST", { name: "Platform" });

    expect(team.status).toBe(201);
  });

  it("lets an owner grant and change every role, but keeps one owner", async () => {
    const { slug, owner, member } = await staffedOrg("matrix-owner");

    const promoted = await send(slug, `/members/${member.id}`, owner, "PATCH", { role: "admin" });

    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ id: member.id, role: "admin" });

    expect(
      (await send(slug, "/members", owner, "POST", { email: "co@example.com", role: "owner" }))
        .status,
    ).toBe(201);

    const settings = await send(slug, "/membership", owner, "PATCH", { auto_join: true });

    expect(settings).toMatchObject({ status: 200, body: { auto_join: true } });

    // A lone owner cannot step down.
    const solo = await newOrg("matrix-solo");
    const only = await addMember(solo, "solo@example.com", "owner");
    await addMember(solo, "other@example.com", "member");

    const demote = await send(solo, `/members/${only.id}`, await as(only.email), "PATCH", {
      role: "admin",
    });

    expect(demote.status).toBe(409);
    expect(errorOf(demote)).toBe("last_owner");
  });

  it("answers the contract's errors for bad input", async () => {
    const slug = await newOrg("matrix-errors");
    const admin = await asAdmin();

    expect(errorOf(await send(slug, "/members", admin, "POST", { email: "nope" }))).toBe(
      "invalid_email",
    );
    expect((await send(slug, "/members", admin, "POST", { role: "owner" })).status).toBe(400);

    await addMember(slug, "twice@example.com", "member");

    const twice = await send(slug, "/members", admin, "POST", { email: "TWICE@example.com" });

    expect(twice.status).toBe(409);
    expect(errorOf(twice)).toBe("member_exists");
    expect((await send(slug, "/members/mem-unknown", admin, "DELETE")).status).toBe(404);
    expect(
      (await send(slug, "/members/mem-unknown", admin, "PATCH", { role: "superuser" })).status,
    ).toBe(400);
  });
});

describe("auto-join", () => {
  it("is off in a new org: someone Access admits but who is no member is refused", async () => {
    const slug = await newOrg("join-off");
    const stranger = await as(`stranger-${slug}@example.com`);

    expect(await send(slug, "/membership", await asAdmin())).toMatchObject({
      status: 200,
      body: { auto_join: false },
    });
    expect((await send(slug, USAGE, stranger)).status).toBe(403);
    expect(await members(slug)).toEqual([]);
  });

  it("makes everyone Access admits a plain member on their first request once an owner turns it on", async () => {
    const slug = await newOrg("join-on");
    const email = `joiner-${slug}@example.com`;

    await send(slug, "/membership", await asAdmin(), "PATCH", { auto_join: true });

    expect((await send(slug, USAGE, await as(email))).status).toBe(200);
    expect(await members(slug)).toMatchObject([{ email, role: "member" }]);
    // A member, not an admin.
    expect((await send(slug, "/members", await as(email))).status).toBe(403);

    // Turned off again: members stay, newcomers are refused.
    await send(slug, "/membership", await asAdmin(), "PATCH", { auto_join: false });

    expect((await send(slug, USAGE, await as(email))).status).toBe(200);
    expect((await send(slug, USAGE, await as(`late-${slug}@example.com`))).status).toBe(403);
  });
});

describe("membership in two orgs", () => {
  it("gives a person a role of their own in each org, and /me lists both", async () => {
    const first = await newOrg("two-first");
    const second = await newOrg("two-second");
    const email = `both-${first}@example.com`;
    await addMember(first, email, "admin");
    await addMember(second, email, "member");
    const both = await as(email);

    expect((await send(first, "/members", both)).status).toBe(200);
    expect((await send(second, "/members", both)).status).toBe(403);
    expect((await send(second, USAGE, both)).status).toBe(200);

    const me = await harness.json("/v9/management/me", both);

    expect(me.status).toBe(200);
    expect(
      (me.body as { orgs: ReadonlyArray<{ slug: string }> }).orgs.map((org) => org.slug).toSorted(),
      // `global` (slug `default`) lets everyone Access admits join: auto-join is on there.
    ).toEqual(["default", first, second].toSorted());
    expect(me.body).toMatchObject({ platform_admin: false });
    expect((await send(first, "/me", both)).body).toMatchObject({ role: "admin" });
    expect((await send(second, "/me", both)).body).toMatchObject({ role: "member" });

    // Removed from one org, the other stays.
    const [membership] = (await members(second)).filter((member) => member.email === email);

    expect(
      (await send(second, `/members/${membership?.id}`, await asAdmin(), "DELETE")).status,
    ).toBe(200);

    const after = (await harness.json("/v9/management/me", both)).body as {
      orgs: ReadonlyArray<{ slug: string }>;
    };

    expect(after.orgs.map((org) => org.slug).toSorted()).toEqual(["default", first].toSorted());
  });

  it("tells a platform admin it owns every org", async () => {
    const slug = await newOrg("me-platform");

    expect((await send(slug, "/me", await asAdmin())).body).toMatchObject({
      platform_admin: true,
      role: "owner",
    });
  });

  it("answers role null in /me for an org the caller does not belong to", async () => {
    const slug = await newOrg("me-outsider");

    expect((await send(slug, "/me", await as(`nobody-${slug}@example.com`))).body).toMatchObject({
      platform_admin: false,
      role: null,
    });
  });
});

describe("one org's admin and another org", () => {
  it("cannot reach the other org's routes, nor its members by id", async () => {
    const mine = await staffedOrg("cross-mine");
    const theirs = await staffedOrg("cross-theirs");

    expect((await send(theirs.slug, "/members", mine.owner)).status).toBe(403);
    expect(await statusOf(theirs.slug, "/settings", mine.admin)).toBe(403);
    expect(
      (await send(theirs.slug, `/members/${theirs.member.id}`, mine.owner, "DELETE")).status,
    ).toBe(403);
    expect(
      (await send(theirs.slug, "/members", mine.owner, "POST", { email: "spy@example.com" }))
        .status,
    ).toBe(403);

    // Its own org knows no member by the other org's id.
    expect(
      (await send(mine.slug, `/members/${theirs.member.id}`, mine.owner, "DELETE")).status,
    ).toBe(404);
    expect((await members(theirs.slug)).map((member) => member.id)).toContain(theirs.member.id);
  });
});

describe("a removed member", () => {
  it("is refused on the next request", async () => {
    const { slug, member, owner } = await staffedOrg("removed");

    expect((await send(slug, USAGE, member)).status).toBe(200);
    expect((await send(slug, `/members/${member.id}`, owner, "DELETE")).status).toBe(200);
    expect((await send(slug, USAGE, member)).status).toBe(403);
    expect((await send(slug, "/me", member)).body).toMatchObject({ role: null });
  });

  it("stays out where auto-join is on, until an org admin adds them back", async () => {
    const { slug, member, owner } = await staffedOrg("removed-join");

    await send(slug, "/membership", await asAdmin(), "PATCH", { auto_join: true });

    expect((await send(slug, `/members/${member.id}`, owner, "DELETE")).status).toBe(200);
    expect((await send(slug, USAGE, member)).status).toBe(403);
    expect(await members(slug)).not.toContainEqual(
      expect.objectContaining({ email: member.email }),
    );

    await addMember(slug, member.email, "member");

    expect((await send(slug, USAGE, member)).status).toBe(200);
  });

  it("as a service token stays out where auto-join is on, until it is registered again", async () => {
    const slug = await newOrg("removed-token");
    const ci = clientId(slug, "ci");
    const platform = await asAdmin();

    await send(slug, "/membership", platform, "PATCH", { auto_join: true });

    expect((await send(slug, "/service-tokens", platform, "POST", { client_id: ci })).status).toBe(
      201,
    );
    expect((await send(slug, `/service-tokens/${ci}`, platform, "DELETE")).status).toBe(200);
    expect((await send(slug, USAGE, await asToken(ci))).status).toBe(403);

    expect((await send(slug, "/service-tokens", platform, "POST", { client_id: ci })).status).toBe(
      201,
    );
    expect((await send(slug, USAGE, await asToken(ci))).status).toBe(200);
  });
});

describe("teams", () => {
  it("group members of the org; a member lists the teams it is in", async () => {
    const { slug, admin, member } = await staffedOrg("teams");
    const created = await send(slug, "/teams", admin, "POST", { name: "Research" });
    const team = created.body as { id: string };

    expect(created.body).toMatchObject({ name: "Research", members: [] });
    expect(errorOf(await send(slug, "/teams", admin, "POST", { name: "research" }))).toBe(
      "team_exists",
    );

    const joined = await send(slug, `/teams/${team.id}/members`, admin, "POST", {
      member_id: member.id,
    });

    expect(joined.body).toMatchObject({ members: [member.id] });
    expect((await members(slug)).find((m) => m.id === member.id)?.teams).toEqual([team.id]);

    // A member of another org is unknown here.
    const other = await staffedOrg("teams-other");

    expect(
      errorOf(
        await send(slug, `/teams/${team.id}/members`, admin, "POST", {
          member_id: other.member.id,
        }),
      ),
    ).toBe("member_not_found");

    expect(
      (await send(slug, `/teams/${team.id}`, admin, "PATCH", { name: "Applied" })).body,
    ).toMatchObject({ name: "Applied" });
    expect(
      (await send(slug, `/teams/${team.id}/members/${member.id}`, admin, "DELETE")).body,
    ).toMatchObject({ members: [] });
    expect((await send(slug, `/teams/${team.id}`, admin, "DELETE")).status).toBe(200);
    expect((await send(slug, "/teams", admin)).body).toEqual({ teams: [] });
  });

  it("lose a removed member", async () => {
    const { slug, admin, member } = await staffedOrg("teams-removed");

    const team = (await send(slug, "/teams", admin, "POST", { name: "Ops" })).body as {
      id: string;
    };

    await send(slug, `/teams/${team.id}/members`, admin, "POST", { member_id: member.id });
    await send(slug, `/members/${member.id}`, admin, "DELETE");

    expect((await send(slug, "/teams", admin)).body).toMatchObject({
      teams: [{ id: team.id, members: [] }],
    });
  });
});

describe("service tokens", () => {
  it("get roles like people, and a role above member only from an owner token or a platform admin", async () => {
    const { slug, owner, admin } = await staffedOrg("tokens");
    const ownerToken = clientId(slug, "owner");
    const adminToken = clientId(slug, "admin");

    // A person who is an org owner grants plain member only (ADR 0006's rule).
    const refused = await send(slug, "/service-tokens", owner, "POST", {
      client_id: adminToken,
      role: "admin",
    });

    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toBe("service_token_owner_required");

    // An admin registers plain member tokens.
    const plain = await send(slug, "/service-tokens", admin, "POST", {
      client_id: clientId(slug, "ci"),
      name: "CI",
    });

    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({
      client_id: clientId(slug, "ci"),
      name: "CI",
      role: "member",
    });

    // The platform admin grants the first owner token; that token grants further.
    expect(
      (
        await send(slug, "/service-tokens", await asAdmin(), "POST", {
          client_id: ownerToken,
          role: "owner",
        })
      ).status,
    ).toBe(201);

    const byToken = await send(slug, "/service-tokens", await asToken(ownerToken), "POST", {
      client_id: adminToken,
      role: "admin",
    });

    expect(byToken.status).toBe(201);

    // An owner person may not raise a token either, but may lower one and remove it.
    expect(
      errorOf(
        await send(slug, `/service-tokens/${clientId(slug, "ci")}`, owner, "PATCH", {
          role: "admin",
        }),
      ),
    ).toBe("service_token_owner_required");
    expect(
      (await send(slug, `/service-tokens/${adminToken}`, owner, "PATCH", { role: "member" })).body,
    ).toMatchObject({ role: "member" });

    // The tokens use their roles.
    expect(await statusOf(slug, "/settings", await asToken(ownerToken))).toBe(200);
    expect(await statusOf(slug, "/settings", await asToken(clientId(slug, "ci")))).toBe(403);
    expect((await send(slug, USAGE, await asToken(clientId(slug, "ci")))).status).toBe(200);

    expect((await send(slug, "/service-tokens", admin)).body).toMatchObject({
      service_tokens: expect.arrayContaining([
        expect.objectContaining({ client_id: ownerToken, role: "owner" }),
      ]),
    });
  });

  it("are refused when not registered and auto-join is off", async () => {
    const slug = await newOrg("tokens-unknown");

    expect((await send(slug, USAGE, await asToken(clientId(slug, "stray")))).status).toBe(403);
  });

  it("belong to one org", async () => {
    const first = await newOrg("tokens-one");
    const second = await newOrg("tokens-two");
    const shared = clientId(first, "shared");

    expect(
      (await send(first, "/service-tokens", await asAdmin(), "POST", { client_id: shared })).status,
    ).toBe(201);

    const taken = await send(second, "/service-tokens", await asAdmin(), "POST", {
      client_id: shared,
    });

    expect(taken.status).toBe(409);
    expect(errorOf(taken)).toBe("service_token_taken");
    expect((await send(second, USAGE, await asToken(shared))).status).toBe(403);
  });

  it("belong to one org when two orgs register the same token at once", async () => {
    const orgs = [await newOrg("tokens-race-a"), await newOrg("tokens-race-b")];
    const shared = clientId(orgs[0] ?? "", "raced");
    const platform = await asAdmin();

    const replies = await Promise.all(
      orgs.map(
        async (slug) =>
          await send(slug, "/service-tokens", platform, "POST", { client_id: shared }),
      ),
    );

    expect(replies.map((reply) => reply.status).toSorted((a, b) => a - b)).toEqual([201, 409]);

    const holders = await Promise.all(
      orgs.map(async (slug) => {
        const listed = (await send(slug, "/service-tokens", platform)).body as {
          service_tokens: ReadonlyArray<{ client_id: string }>;
        };

        return listed.service_tokens.some((token) => token.client_id === shared);
      }),
    );

    expect(holders.filter(Boolean)).toHaveLength(1);
  });
});

describe("usage by member", () => {
  /** The id of the org with `slug` (usage records name the org by id). */
  const orgIdOf = async (slug: string): Promise<OrgId> => {
    const { orgs } = (await harness.json("/v9/management/orgs")).body as {
      orgs: ReadonlyArray<{ id: string; slug: string }>;
    };

    return OrgId.make(orgs.find((org) => org.slug === slug)?.id ?? slug);
  };

  const requestIds = (reply: { body: unknown }) =>
    (reply.body as { records: ReadonlyArray<{ request_id: string }> }).records
      .map((record) => record.request_id)
      .toSorted();

  it("shows a plain member only their own requests, and lets an admin filter by member and team", async () => {
    const { slug, admin, member } = await staffedOrg("usage-member");
    const orgId = await orgIdOf(slug);

    for (const [requestId, who] of [
      ["member-1", member],
      ["admin-1", admin],
    ] as const)
      await insertUsageRecord(
        env.USAGE,
        sampleRecord({ requestId, orgId, principalId: `user:${who.email}`, memberId: who.id }),
      );

    // From before members: the member's Access principal, no member id.
    await insertUsageRecord(
      env.USAGE,
      sampleRecord({ requestId: "member-old", orgId, principalId: `user:${member.email}` }),
    );

    expect(requestIds(await send(slug, USAGE, member))).toEqual(["member-1", "member-old"]);
    // Whatever a member asks for, they see only their own.
    expect(requestIds(await send(slug, `${USAGE}?member=${admin.id}`, member))).toEqual([]);

    const summary = await send(slug, "/observability/usage/summary?group_by=member", member);

    expect(summary.body).toMatchObject({ totals: { requests: 2 } });

    expect(requestIds(await send(slug, USAGE, admin))).toEqual([
      "admin-1",
      "member-1",
      "member-old",
    ]);
    expect(requestIds(await send(slug, `${USAGE}?member=${member.id}`, admin))).toEqual([
      "member-1",
    ]);

    const team = (await send(slug, "/teams", admin, "POST", { name: "Admins" })).body as {
      id: string;
    };

    await send(slug, `/teams/${team.id}/members`, admin, "POST", { member_id: admin.id });

    expect(requestIds(await send(slug, `${USAGE}?team=${team.id}`, admin))).toEqual(["admin-1"]);
    expect(errorOf(await send(slug, `${USAGE}?team=team-unknown`, admin))).toBe("team_not_found");

    const grouped = await send(slug, "/observability/usage/summary?group_by=member", admin);

    const keys = (grouped.body as { groups: ReadonlyArray<{ key: string }> }).groups
      .map((group) => group.key)
      .toSorted();

    expect(keys).toEqual(["", admin.id, member.id].toSorted());
  });
});

describe("downloading a credential (ADR 0006's rule per org)", () => {
  it("answers a service token that is an org owner and a platform admin, nobody else", async () => {
    const { slug, owner, admin } = await staffedOrg("download");
    const ownerToken = `owner-${slug}.access`;
    const adminToken = `admin-${slug}.access`;
    const platform = await asAdmin();
    const name = "claude-download.json";

    expect(
      (await send(slug, `/credentials?name=${name}`, platform, "POST", claudeFile())).status,
    ).toBe(200);

    await send(slug, "/service-tokens", platform, "POST", { client_id: ownerToken, role: "owner" });
    await send(slug, "/service-tokens", platform, "POST", { client_id: adminToken, role: "admin" });

    const path = `/credentials/download?name=${name}`;

    for (const who of [owner, admin, await asToken(adminToken)]) {
      const refused = await send(slug, path, who);

      expect(refused.status).toBe(403);
      expect(errorOf(refused)).toBe("download_requires_service_token");
    }

    for (const who of [await asToken(ownerToken), platform]) {
      const file = await send(slug, path, who);

      expect(file.status).toBe(200);
      expect(file.body).toMatchObject({ access_token: "sk-ant-oat-secret-access" });
    }
  });
});

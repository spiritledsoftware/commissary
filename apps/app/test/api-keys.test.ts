// API keys (ADR 0022, issue #67) on the app Worker: the management routes that issue, list and revoke keys, that the
// management routes never take a key, and the org's `access_clients` setting. Through the router with the real
// ControlPlanes and a Platform registry of its own. The gate on the client API, where keys are used, is the API
// Worker's (apps/api/test/api-keys.test.ts); the key text is tested in packages/auth (keys.test.ts).
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { parseApiKey } from "@commissary/auth";
import { GLOBAL_ORG, OrgId } from "@commissary/core";
import { controlPlaneOf, type ControlPlaneStub, MAX_KEYS_PER_MEMBER } from "@commissary/state";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

serveFakeMcpServers();

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings, GLOBAL_ORG);

afterAll(harness.dispose);

interface Auth {
  readonly auth: string;
}

interface KeyBody {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly member_id: string;
  readonly member_email?: string;
  readonly mine: boolean;
  readonly last_used_at?: string;
  readonly revoked_at?: string;
  readonly key?: string;
}

const as = async (email: string): Promise<Auth> => ({ auth: await token(email) });

const api = (slug: string, path: string) => `/v9/management/orgs/${slug}${path}`;

const send = async (
  slug: string,
  path: string,
  who: Auth,
  method = "GET",
  body?: Parameters<typeof jsonInit>[1],
) =>
  await harness.json(api(slug, path), {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    ...who,
  });

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

/** An org of its own with an admin and two plain members; answers its id and slug and how to act as each. */
const staffedOrg = async (prefix: string, privateCredentials = false) => {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const admin = await as(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug, private_credentials: privateCredentials }),
  );

  expect(created.status).toBe(201);
  const org = OrgId.make((created.body as { id: string }).id);

  const add = async (email: string, role: string) => {
    const reply = await send(slug, "/members", admin, "POST", { email, role });

    expect(reply.status).toBe(201);

    return { id: (reply.body as { id: string }).id, email, ...(await as(email)) };
  };

  return {
    org,
    slug,
    platformAdmin: admin,
    admin: await add(`admin-${slug}@example.com`, "admin"),
    alice: await add(`alice-${slug}@example.com`, "member"),
    bob: await add(`bob-${slug}@example.com`, "member"),
  };
};

/** Creates a key as `who` and answers the creation's body (with the whole key). */
const createKey = async (slug: string, who: Auth, name = "laptop"): Promise<KeyBody> => {
  const reply = await send(slug, "/api-keys", who, "POST", { name });

  expect(reply.status).toBe(201);

  return reply.body as KeyBody;
};

const wholeKey = (created: KeyBody): string => {
  if (created.key === undefined) throw new Error("the creation did not answer the key");

  return created.key;
};

/** Issues a key straight through the ControlPlane and answers its name. */
const createKeyDirect = async (
  stub: ControlPlaneStub,
  memberId: string,
  name: string,
): Promise<string> => {
  const issued = await stub.createApiKey({ memberId, name }, Date.now());

  if (!issued.ok) throw new Error(issued.message);

  return issued.value.record.name;
};

describe("issuing keys", () => {
  it("shows a new key once and lists it by its prefix only", async () => {
    const { org, slug, alice } = await staffedOrg("issue");
    const created = await createKey(slug, alice, "  laptop  ");

    expect(wholeKey(created).startsWith(`cms_${org}_${created.id}_`)).toBe(true);
    expect(created).toMatchObject({ name: "laptop", member_id: alice.id, mine: true });
    expect(wholeKey(created).startsWith(created.prefix)).toBe(true);

    const listed = await send(slug, "/api-keys", alice);

    expect(listed.status).toBe(200);
    const keys = (listed.body as { keys: ReadonlyArray<KeyBody> }).keys;

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: created.id, prefix: created.prefix, mine: true });
    expect(keys[0]).not.toHaveProperty("key");
    expect(JSON.stringify(listed.body)).not.toContain(wholeKey(created));
  });

  it("refuses a bad name or expiry, and a caller who is not a member of the org", async () => {
    const { slug, alice, platformAdmin } = await staffedOrg("issue-refusals");

    const noName = await send(slug, "/api-keys", alice, "POST", { name: " " });
    expect([noName.status, errorOf(noName)]).toEqual([422, "invalid_name"]);

    const past = await send(slug, "/api-keys", alice, "POST", {
      name: "old",
      expires_at: "2001-01-01T00:00:00Z",
    });

    expect([past.status, errorOf(past)]).toEqual([422, "invalid_expiry"]);

    const garbled = await send(slug, "/api-keys", alice, "POST", {
      name: "x",
      expires_at: "soon",
    });

    expect([garbled.status, errorOf(garbled)]).toEqual([422, "invalid_expiry"]);

    // A platform admin manages every org but is a member of none of them here: keys go to members only.
    const outsider = await send(slug, "/api-keys", platformAdmin, "POST", { name: "admin" });
    expect([outsider.status, errorOf(outsider)]).toEqual([403, "member_required"]);
  });

  it("issues keys to the dev admin (the dev bypass of `alchemy dev`) in an org it joined, as to a platform admin", async () => {
    // Through the Worker's default export on a loopback host, where the test Worker's ACCESS_DEV_BYPASS applies.
    const local = async (path: string, init: RequestInit) => {
      const response = await exports.default.fetch(
        new Request(`http://localhost/v9/management/orgs/default${path}`, init),
      );

      return { status: response.status, body: await response.json<{ error?: string }>() };
    };

    const issue = () => local("/api-keys", jsonInit("POST", { name: "local" }));
    const outsider = await issue();

    expect([outsider.status, outsider.body.error]).toEqual([403, "member_required"]);
    expect(
      (await local("/members", jsonInit("POST", { email: "dev@localhost", role: "member" })))
        .status,
    ).toBe(201);
    expect((await issue()).status).toBe(201);
  });

  it("lets members list and revoke their own keys, and org admins every key", async () => {
    const { slug, admin, alice, bob } = await staffedOrg("issue-scope");
    const alices = await createKey(slug, alice);
    const bobs = await createKey(slug, bob);

    const aliceSees = (await send(slug, "/api-keys", alice)).body as { keys: Array<KeyBody> };
    expect(aliceSees.keys.map((key) => key.id)).toEqual([alices.id]);

    const adminSees = (await send(slug, "/api-keys", admin)).body as { keys: Array<KeyBody> };
    expect(new Set(adminSees.keys.map((key) => key.id))).toEqual(new Set([alices.id, bobs.id]));
    expect(adminSees.keys.find((key) => key.id === bobs.id)).toMatchObject({
      member_email: bob.email,
      mine: false,
    });

    // Another member's key is not there for a plain member.
    const foreign = await send(slug, `/api-keys/${bobs.id}`, alice, "DELETE");
    expect([foreign.status, errorOf(foreign)]).toEqual([404, "api_key_not_found"]);

    const own = await send(slug, `/api-keys/${alices.id}`, alice, "DELETE");
    expect(own.status).toBe(200);
    expect((own.body as KeyBody).revoked_at).toBeDefined();

    const byAdmin = await send(slug, `/api-keys/${bobs.id}`, admin, "DELETE");
    expect(byAdmin.status).toBe(200);

    // A revoked key is deleted, not kept marked (ADR 0027): gone from the lists, and revoking it again finds nothing.
    const after = (await send(slug, "/api-keys", alice)).body as { keys: Array<KeyBody> };
    expect(after.keys).toEqual([]);
    expect((await send(slug, "/api-keys", admin)).body).toEqual({ keys: [] });

    const again = await send(slug, `/api-keys/${alices.id}`, alice, "DELETE");
    expect([again.status, errorOf(again)]).toEqual([404, "api_key_not_found"]);
  });

  it("holds a member to 100 keys and gives a place back when a key is revoked or expires", async () => {
    const { org, alice } = await staffedOrg("issue-limit");
    const stub = controlPlaneOf(env, org);
    const now = Date.now();

    const issue = async (name: string, at: number, expiresAt?: number) => {
      const issued = await stub.createApiKey(
        { memberId: alice.id, name, ...(expiresAt === undefined ? {} : { expiresAt }) },
        at,
      );

      if (!issued.ok) throw new Error(issued.message);

      return issued.value.record.id;
    };

    const ids: Array<string> = [];

    // The last of them expires soon.
    for (let index = 0; index < MAX_KEYS_PER_MEMBER - 1; index++)
      ids.push(await issue(`key ${index}`, now + index));

    const soon = await issue("soon", now + 99, now + 1000);

    const full = await stub.createApiKey({ memberId: alice.id, name: "one more" }, now + 200);
    expect(full).toMatchObject({ ok: false, error: "too_many_keys" });

    // A revoked key leaves at once and frees its place.
    const [first] = ids;
    expect((await stub.revokeApiKey(first ?? "", now + 300)).ok).toBe(true);
    const added = await issue("replacement", now + 400);

    let listed = (await stub.listApiKeys(alice.id, now + 400)).map((key) => key.id);
    expect(listed).toHaveLength(MAX_KEYS_PER_MEMBER);
    expect(listed).toContain(added);
    expect(listed).not.toContain(first);

    // An expired key is deleted by the next listing or creation, and gives its place back too.
    listed = (await stub.listApiKeys(alice.id, now + 1000)).map((key) => key.id);
    expect(listed).toHaveLength(MAX_KEYS_PER_MEMBER - 1);
    expect(listed).not.toContain(soon);
  });

  it("deletes expired keys whenever the org lists or issues keys, and on the cron sweep", async () => {
    const { org, alice, bob } = await staffedOrg("issue-expiry");
    const stub = controlPlaneOf(env, org);
    const now = Date.now();

    const rows = async () =>
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>("SELECT name FROM api_keys ORDER BY name")
          .toArray()
          .map((row) => row.name),
      );

    const issue = async (memberId: string, name: string, expiresAt?: number) => {
      const issued = await stub.createApiKey(
        { memberId, name, ...(expiresAt === undefined ? {} : { expiresAt }) },
        now,
      );

      expect(issued.ok).toBe(true);
    };

    await issue(alice.id, "a-live");
    await issue(alice.id, "a-short", now + 1000);
    await issue(bob.id, "b-short", now + 2000);
    await issue(bob.id, "b-long", now + 100_000);
    expect(await rows()).toEqual(["a-live", "a-short", "b-long", "b-short"]);

    // Nothing has expired yet: a listing deletes nothing.
    await stub.listApiKeys(undefined, now + 999);
    expect(await rows()).toHaveLength(4);

    // A listing after the expiry deletes the key, not only hides it.
    await stub.listApiKeys(alice.id, now + 1000);
    expect(await rows()).toEqual(["a-live", "b-long", "b-short"]);

    // Issuing a key does the same for every member's keys.
    await stub.createApiKey({ memberId: alice.id, name: "a-new" }, now + 2000);
    expect(await rows()).toEqual(["a-live", "a-new", "b-long"]);

    // A key presented after its expiry is refused and deleted on the spot.
    const presented = await stub.createApiKey(
      { memberId: bob.id, name: "b-presented", expiresAt: now + 2500 },
      now + 2000,
    );

    if (!presented.ok) throw new Error(presented.message);
    const parsed = parseApiKey(presented.value.key);

    if (parsed === undefined) throw new Error("the issued key does not parse");
    expect(await stub.verifyApiKey(parsed.keyId, parsed.hash, now + 2600)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await rows()).toEqual(["a-live", "a-new", "b-long"]);

    // The cron sweep covers an org nobody opens.
    expect(await stub.purgeExpiredApiKeys(now + 100_000)).toBe(1);
    // The API Worker's cron runs it for every org (`api-key-expiry`, apps/api/test/scheduled.test.ts).
    expect(await rows()).toEqual(["a-live", "a-new"]);
  });

  it("deletes a revoked key a previous version kept, when the org's ControlPlane starts", async () => {
    const { org, alice } = await staffedOrg("issue-legacy");
    const stub = controlPlaneOf(env, org);
    const kept = await createKeyDirect(stub, alice.id, "kept");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO api_keys (id, member_id, name, hash, prefix, created_at, revoked_at)
         VALUES ('legacykey', ?, 'legacy', 'x', 'cms_x', 1, 2)`,
        alice.id,
      );
    });
    await evictDurableObject(stub);

    const names = (await stub.listApiKeys(alice.id, Date.now())).map((listed) => listed.name);

    expect(names).toEqual([kept]);
  });
});

describe("a key's tool scope", () => {
  /** An org whose members are all granted a toolkit with a write and a read tool, and that toolkit's id. */
  const toolkitOrg = async (prefix: string) => {
    const staff = await staffedOrg(prefix);

    const upstream = fakeMcpServer(
      `https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`,
      {
        tools: [
          { name: "create_issue" },
          { name: "list_issues", annotations: { readOnlyHint: true } },
        ],
      },
    );

    const added = await send(staff.slug, "/toolkits", staff.admin, "POST", {
      source: upstream.url,
      name: "github",
      accepts: "shared",
      credential: { kind: "none", subject: { kind: "everyone" } },
    });

    expect(added.status).toBe(201);

    return { ...staff, toolkit: (added.body as { id: string }).id };
  };

  it("lists what the member may use, by toolkit, for the scope to pick from", async () => {
    const { slug, alice, toolkit } = await toolkitOrg("scope-usable");
    const usable = await send(slug, "/tools", alice);

    expect(usable).toMatchObject({
      status: 200,
      body: {
        toolkits: [
          {
            id: toolkit,
            name: "github",
            tools: [
              { id: `${toolkit}:create_issue`, name: "github_create_issue", tool_class: "write" },
              { id: `${toolkit}:list_issues`, name: "github_list_issues", tool_class: "read" },
            ],
          },
        ],
      },
    });
  });

  it("is set when the key is created and changed by its member, with the tool count it gives", async () => {
    const { slug, alice, bob, toolkit } = await toolkitOrg("scope-set");
    const read = [{ toolkit, tools: { kind: "read" } }];

    const created = await send(slug, "/api-keys", alice, "POST", {
      name: "reader",
      tool_scope: read,
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "reader", tool_scope: read, tool_count: 1 });
    const { id } = created.body as { id: string };

    const unscoped = await createKey(slug, alice, "everything");

    expect(unscoped).toMatchObject({ tool_count: 2 });
    expect(unscoped).not.toHaveProperty("tool_scope");

    // A named tool its toolkit no longer lists shows as missing.
    const named = [
      {
        toolkit,
        tools: { kind: "named", ids: [`${toolkit}:create_issue`, ` ${toolkit}:gone`] },
      },
    ];

    const changed = await send(slug, `/api-keys/${id}`, alice, "PATCH", { tool_scope: named });

    expect(changed).toMatchObject({
      status: 200,
      body: {
        id,
        tool_scope: [
          {
            toolkit,
            tools: { kind: "named", ids: [`${toolkit}:create_issue`, `${toolkit}:gone`] },
          },
        ],
        tool_count: 1,
        tool_scope_missing: [`${toolkit}:gone`],
      },
    });

    const listed = (await send(slug, "/api-keys", alice)).body as {
      keys: ReadonlyArray<KeyBody & { tool_count?: number }>;
    };

    expect(listed.keys.map((key) => [key.name, key.tool_count])).toEqual([
      ["everything", 2],
      ["reader", 1],
    ]);

    const cleared = await send(slug, `/api-keys/${id}`, alice, "PATCH", { tool_scope: null });

    expect(cleared.body).toMatchObject({ id, tool_count: 2 });
    expect(cleared.body).not.toHaveProperty("tool_scope");

    // Another member's key answers as unknown; an empty scope gives nothing.
    expect(errorOf(await send(slug, `/api-keys/${id}`, bob, "PATCH", { tool_scope: [] }))).toBe(
      "api_key_not_found",
    );
    expect(
      (await send(slug, `/api-keys/${id}`, alice, "PATCH", { tool_scope: [] })).body,
    ).toMatchObject({ tool_scope: [], tool_count: 0 });
  });

  it("refuses a scope that names a toolkit twice or a tool of another toolkit", async () => {
    const { slug, alice, toolkit } = await toolkitOrg("scope-invalid");

    for (const tool_scope of [
      [
        { toolkit, tools: { kind: "all" } },
        { toolkit, tools: { kind: "read" } },
      ],
      [{ toolkit, tools: { kind: "named", ids: ["tk_other:create_issue"] } }],
      [{ toolkit, tools: { kind: "named", ids: [] } }],
    ]) {
      const refused = await send(slug, "/api-keys", alice, "POST", { name: "bad", tool_scope });

      expect(refused.status).toBe(422);
      expect(errorOf(refused)).toBe("invalid_tool_scope");
    }
  });
});

describe("API keys on the management API", () => {
  it("never takes a key on the management routes", async () => {
    const { slug, alice } = await staffedOrg("gate-management");
    const key = wholeKey(await createKey(slug, alice));

    for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }]) {
      const reply = await harness.json(api(slug, "/api-keys"), { headers, auth: false });

      expect([reply.status, reply.body]).toEqual([401, { error: "Missing API key" }]);
    }
  });
});

describe("Access sign-ins on the client API", () => {
  const owner = () => as(ADMIN);

  const setAccessClients = async (on: boolean) => {
    const reply = await harness.json("/v9/management/membership", {
      ...jsonInit("PATCH", { access_clients: on }),
      ...(await owner()),
    });

    expect(reply.status).toBe(200);

    return reply.body;
  };

  it("stay accepted in global, where clients signed in through Access before, and nowhere else", async () => {
    expect((await harness.json("/v9/management/membership", await owner())).body).toEqual({
      auto_join: true,
      private_credentials: true,
      private_toolkits: true,
      private_agents: true,
      access_clients: true,
    });

    const { slug } = await staffedOrg("access-default");
    // An Access sign-in on a client API route names no org, so it only ever reaches global: other orgs lack the setting.
    expect((await send(slug, "/membership", await owner())).body).toEqual({
      auto_join: false,
      private_credentials: false,
      private_toolkits: false,
      private_agents: false,
    });
  });

  it("are changed by org owners only", async () => {
    const { slug, admin } = await staffedOrg("access-owner");
    const reply = await send(slug, "/membership", admin, "PATCH", { access_clients: true });

    expect([reply.status, errorOf(reply)]).toEqual([403, "owner_required"]);

    const elsewhere = await send(slug, "/membership", await owner(), "PATCH", {
      access_clients: true,
    });

    expect([elsewhere.status, errorOf(elsewhere)]).toEqual([422, "access_clients_global_only"]);

    try {
      // Changing one setting keeps the other.
      expect(await setAccessClients(false)).toEqual({
        auto_join: true,
        private_credentials: true,
        private_toolkits: true,
        private_agents: true,
        access_clients: false,
      });
    } finally {
      await setAccessClients(true);
    }
  });
});

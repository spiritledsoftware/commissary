// Management keys (ADR 0026, issue #72) on a self-hosted Commissary: the key text, issuing, listing and revoking them, and
// the gate on the management API: a key works there with its role in its org only, never downloads a credential,
// never gives a key or a service token a role, never reaches another org, and is refused once revoked. That the API
// Worker's gate refuses it on the client API is tested in apps/api/test/api-keys.test.ts.
import { afterAll, describe, expect, it } from "vite-plus/test";
import { parseApiKey, parseManagementKey } from "@commissary/auth";
import { GLOBAL_ORG, OrgId } from "@commissary/core";
import {
  ADMIN,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  serviceToken,
  token,
} from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings, GLOBAL_ORG);

afterAll(harness.dispose);

interface Created {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly prefix: string;
  readonly created_by: string;
  readonly key: string;
}

const api = (slug: string, path: string) => `/v9/management/orgs/${slug}${path}`;

/** A request signed in through Access as `email`. */
const asPerson = async (email: string, path: string, init: RequestInit = {}) =>
  await harness.json(path, { ...init, auth: await token(email) });

/** A request with a management key only. */
const withKey = async (key: string, path: string, init: RequestInit = {}) =>
  await harness.json(path, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${key}` },
    auth: false,
  });

/** An org of its own with an admin and a plain member. */
const staffedOrg = async (prefix: string) => {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

  const created = await asPerson(
    ADMIN,
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug }),
  );

  expect(created.status).toBe(201);
  const admin = `admin-${slug}@example.com`;
  const member = `member-${slug}@example.com`;

  for (const [email, role] of [
    [admin, "admin"],
    [member, "member"],
  ] as const) {
    const added = await asPerson(ADMIN, api(slug, "/members"), jsonInit("POST", { email, role }));

    expect(added.status).toBe(201);
  }

  // SAFETY: the creation answers an org view (@commissary/contract/orgs), whose id is an `OrgId`.
  return { org: OrgId.make((created.body as { id: string }).id), slug, admin, member };
};

const issue = async (slug: string, email: string, name: string, role: string) => {
  const reply = await asPerson(
    email,
    api(slug, "/management-keys"),
    jsonInit("POST", { name, role }),
  );

  expect(reply.status).toBe(201);

  // SAFETY: a 201 answers a `CreatedManagementKey` (@commissary/contract/management-keys).
  return reply.body as Created;
};

const errorOf = (reply: { readonly body: unknown }) =>
  // SAFETY: management errors answer `{error}` (@commissary/contract/errors).
  (reply.body as { error?: string }).error;

describe("the key text", () => {
  it("names its org like an API key, and is never taken for one", async () => {
    const { org, slug, admin } = await staffedOrg("text");
    const created = await issue(slug, admin, "deploy", "admin");

    expect(created.key).toMatch(/^cmsm_org-[0-9a-f]{16}_[0-9a-f]{20}_[A-Za-z0-9_-]{48}$/);
    expect(parseManagementKey(created.key)).toMatchObject({ org, keyId: created.id });
    expect(parseApiKey(created.key)).toBeUndefined();
    expect(created.prefix).toBe(created.key.slice(0, created.prefix.length));
    expect(created.prefix.length).toBeLessThan(created.key.length);
  });
});

describe("issuing keys", () => {
  it("lets org admins issue, list and revoke keys, shown whole once", async () => {
    const { slug, admin } = await staffedOrg("issue");
    const created = await issue(slug, admin, "deploy", "admin");

    expect(created).toMatchObject({ name: "deploy", role: "admin", created_by: admin });

    const listed = await asPerson(admin, api(slug, "/management-keys"));

    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.key);
    expect(listed.body).toMatchObject({ keys: [{ id: created.id, prefix: created.prefix }] });

    const revoked = await asPerson(admin, api(slug, `/management-keys/${created.id}`), {
      method: "DELETE",
    });

    expect(revoked.status).toBe(200);
    expect(await asPerson(admin, api(slug, "/management-keys"))).toMatchObject({
      body: { keys: [] },
    });
    expect(
      errorOf(
        await asPerson(admin, api(slug, `/management-keys/${created.id}`), { method: "DELETE" }),
      ),
    ).toBe("management_key_not_found");
  });

  it("is for org admins, up to their own role", async () => {
    const { slug, admin, member } = await staffedOrg("roles");

    expect(
      (
        await asPerson(
          member,
          api(slug, "/management-keys"),
          jsonInit("POST", { name: "x", role: "member" }),
        )
      ).status,
    ).toBe(403);

    const tooHigh = await asPerson(
      admin,
      api(slug, "/management-keys"),
      jsonInit("POST", { name: "x", role: "owner" }),
    );

    expect([tooHigh.status, errorOf(tooHigh)]).toEqual([403, "role_too_high"]);

    const badName = await asPerson(
      admin,
      api(slug, "/management-keys"),
      jsonInit("POST", { name: "", role: "member" }),
    );

    expect([badName.status, errorOf(badName)]).toEqual([422, "invalid_name"]);

    // Nor does an org admin revoke a key holding the owner role; an owner (here a platform admin) does.
    const owners = await issue(slug, ADMIN, "owners", "owner");
    const path = api(slug, `/management-keys/${owners.id}`);
    const refused = await asPerson(admin, path, { method: "DELETE" });

    expect([refused.status, errorOf(refused)]).toEqual([403, "role_too_high"]);
    expect((await asPerson(ADMIN, path, { method: "DELETE" })).status).toBe(200);
  });
});

describe("the gate on the management API", () => {
  it("lets an admin key manage the org's credentials but never download one", async () => {
    const { slug, admin } = await staffedOrg("manage");
    const { key } = await issue(slug, admin, "ci", "admin");

    const uploaded = await withKey(
      key,
      api(slug, "/credentials?name=claude-ci.json"),
      jsonInit("POST", {
        type: "claude",
        access_token: "sk-ant-oat-test",
        email: "ci@example.com",
      }),
    );

    expect(uploaded.status).toBe(200);
    expect((await withKey(key, api(slug, "/credentials"))).status).toBe(200);

    // The unscoped address means the key's org.
    expect((await withKey(key, "/v9/management/members")).status).toBe(200);

    const download = await withKey(key, api(slug, "/credentials/download?name=claude-ci.json"));

    expect([download.status, errorOf(download)]).toEqual([403, "download_requires_service_token"]);
  });

  it("never gives a key or a service token a role", async () => {
    const { slug, admin } = await staffedOrg("grant");
    const { key } = await issue(slug, admin, "ci", "admin");

    const issued = await withKey(
      key,
      api(slug, "/management-keys"),
      jsonInit("POST", { name: "y", role: "member" }),
    );

    expect([issued.status, errorOf(issued)]).toEqual([403, "management_key_forbidden"]);

    const registered = await withKey(
      key,
      api(slug, "/service-tokens"),
      jsonInit("POST", { client_id: `ci-${slug}.access`, name: "ci", role: "member" }),
    );

    expect([registered.status, errorOf(registered)]).toEqual([403, "management_key_forbidden"]);
  });

  it("holds a member key to member routes", async () => {
    const { slug, admin } = await staffedOrg("member-key");
    const { key } = await issue(slug, admin, "reader", "member");

    expect((await withKey(key, api(slug, "/api-keys"))).status).toBe(200);
    expect((await withKey(key, api(slug, "/members"))).status).toBe(403);
  });

  it("never reaches another org", async () => {
    const first = await staffedOrg("first");
    const second = await staffedOrg("second");
    const { key } = await issue(first.slug, first.admin, "ci", "admin");

    expect((await withKey(key, api(second.slug, "/members"))).status).toBe(403);
    expect((await withKey(key, api("no-such-org", "/members"))).status).toBe(403);
  });

  it("refuses a revoked, unknown or malformed key", async () => {
    const { slug, admin } = await staffedOrg("revoked");
    const created = await issue(slug, admin, "ci", "admin");

    expect((await withKey(created.key, api(slug, "/members"))).status).toBe(200);

    await asPerson(admin, api(slug, `/management-keys/${created.id}`), { method: "DELETE" });

    for (const key of [created.key, `${created.key.slice(0, -4)}AAAA`, "cmsm_nonsense"]) {
      const reply = await withKey(key, api(slug, "/members"));

      expect([reply.status, reply.body]).toEqual([401, { error: "Invalid API key" }]);
    }
  });

  it("refuses a key under the old cfm_ prefix", async () => {
    const { slug, admin } = await staffedOrg("old-prefix");
    const created = await issue(slug, admin, "ci", "admin");
    const old = created.key.replace(/^cmsm_/, "cfm_");

    expect(parseManagementKey(old)).toBeUndefined();
    expect((await withKey(old, api(slug, "/members"))).status).toBe(401);
  });

  it("takes service tokens as issuers", async () => {
    const { slug } = await staffedOrg("service");
    const clientId = `issuer-${slug}.access`;

    expect(
      (
        await asPerson(
          ADMIN,
          api(slug, "/service-tokens"),
          jsonInit("POST", { client_id: clientId, name: "issuer", role: "admin" }),
        )
      ).status,
    ).toBe(201);

    const reply = await harness.json(api(slug, "/management-keys"), {
      ...jsonInit("POST", { name: "from-token", role: "admin" }),
      auth: await serviceToken(clientId),
    });

    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ created_by: `service:${clientId}` });
  });
});

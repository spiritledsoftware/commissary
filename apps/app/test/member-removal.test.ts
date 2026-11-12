// Zero data retention (ADR 0027): a member who leaves an org takes everything of theirs with them, at once and in that
// org only: API keys, private accounts, private provider key groups and their unfinished OAuth logins. What other members
// and the org share stays. Through the management API and the real ControlPlane.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import {
  ADMIN,
  claudeFile,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  token,
} from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

type Payload = Parameters<typeof jsonInit>[1];

interface Person {
  readonly id: string;
  readonly auth: string;
}

const send = async (slug: string, path: string, auth: string, method = "GET", body?: Payload) =>
  await harness.json(`/v9/management/orgs/${slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    auth,
  });

const newOrg = async () => {
  const slug = `zdr-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug, private_credentials: true }),
  );

  expect(created.status).toBe(201);

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;
    const added = await send(slug, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, auth: await token(email) };
  };

  return {
    slug,
    id: OrgId.make((created.body as { id: string }).id),
    platform,
    alice: await person("alice", "member"),
    bob: await person("bob", "member"),
  };
};

/** Everything `person` keeps in `org`: private accounts, private groups, API keys and owned OAuth logins. */
const holdings = async (org: Awaited<ReturnType<typeof newOrg>>, person: Person) => {
  const stub = env.CONTROL_PLANE.getByName(org.id);

  return await runInDurableObject(stub, (_instance, state) => {
    const count = (sql: string) => state.storage.sql.exec<{ n: number }>(sql, person.id).one().n;

    return {
      keys: count("SELECT COUNT(*) AS n FROM api_keys WHERE member_id = ?"),
      groups: count("SELECT COUNT(*) AS n FROM private_key_groups WHERE owner = ?"),
      logins: count("SELECT COUNT(*) AS n FROM oauth_sessions WHERE owner = ?"),
      accounts: count("SELECT COUNT(*) AS n FROM credentials WHERE owner = ?"),
    };
  });
};

const populate = async (org: Awaited<ReturnType<typeof newOrg>>, person: Person, tag: string) => {
  const slug = org.slug;

  const upload = await send(
    slug,
    `/credentials?name=${tag}.json`,
    person.auth,
    "POST",
    claudeFile(),
  );

  expect(upload.status).toBe(200);

  const group = await send(slug, "/provider-keys/groups", person.auth, "PUT", {
    family: "claude",
    revision: 0,
    group: { "base-url": "https://api.example.test/v1", keys: [{ "api-key": `sk-${tag}-0001` }] },
  });

  expect(group.status).toBe(200);
  expect((await send(slug, "/api-keys", person.auth, "POST", { name: tag })).status).toBe(201);
  expect((await send(slug, "/oauth/auth-url?provider=claude", person.auth)).status).toBe(200);
};

describe("removing a member", () => {
  it("deletes their API keys, private accounts, private key groups and unfinished logins", async () => {
    const org = await newOrg();

    await populate(org, org.alice, "alice");
    expect(await holdings(org, org.alice)).toEqual({ keys: 1, groups: 1, logins: 1, accounts: 1 });

    expect((await send(org.slug, `/members/${org.alice.id}`, org.platform, "DELETE")).status).toBe(
      200,
    );

    expect(await holdings(org, org.alice)).toEqual({ keys: 0, groups: 0, logins: 0, accounts: 0 });
  });

  it("leaves the other members' data and the org's shared credentials alone", async () => {
    const org = await newOrg();

    await populate(org, org.alice, "alice");
    await populate(org, org.bob, "bob");
    expect(
      (
        await send(
          org.slug,
          "/credentials?name=shared.json",
          org.platform,
          "POST",
          claudeFile({ email: "shared@x.com" }),
        )
      ).status,
    ).toBe(200);

    await send(org.slug, `/members/${org.alice.id}`, org.platform, "DELETE");

    expect(await holdings(org, org.bob)).toEqual({ keys: 1, groups: 1, logins: 1, accounts: 1 });

    const names = (
      (await send(org.slug, "/credentials", org.platform)).body as {
        files: ReadonlyArray<{ name: string }>;
        others?: ReadonlyArray<{ name: string }>;
      }
    ).files.map((file) => file.name);

    expect(names).toEqual(["shared.json"]);
    expect((await send(org.slug, "/credentials", org.bob.auth)).body).toMatchObject({
      files: [{ name: "bob.json" }],
    });
  });

  it("keeps a person's data in their other orgs", async () => {
    const first = await newOrg();
    const second = await newOrg();

    // The same person, a member of both orgs.
    const email = `shared-${first.slug}@example.com`;

    const person = async (org: Awaited<ReturnType<typeof newOrg>>): Promise<Person> => {
      const added = await send(org.slug, "/members", org.platform, "POST", {
        email,
        role: "member",
      });

      expect(added.status).toBe(201);

      return { id: (added.body as { id: string }).id, auth: await token(email) };
    };

    const inFirst = await person(first);
    const inSecond = await person(second);

    await populate(first, inFirst, "dual-a");
    await populate(second, inSecond, "dual-b");

    await send(first.slug, `/members/${inFirst.id}`, first.platform, "DELETE");

    expect(await holdings(first, inFirst)).toEqual({ keys: 0, groups: 0, logins: 0, accounts: 0 });
    expect(await holdings(second, inSecond)).toEqual({
      keys: 1,
      groups: 1,
      logins: 1,
      accounts: 1,
    });
  });
});

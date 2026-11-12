// The export an org offers before it is deleted (ADR 0027): the org's settings, shared config and who belongs, with every
// secret as a preview, so what the org had can be rebuilt by hand but never leaks. Usage records come from the usage
// routes that already page and export them. Through the management API with the real ControlPlane.
import { afterAll, describe, expect, it } from "vite-plus/test";
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

const send = async (slug: string, path: string, auth: string, method = "GET", body?: Payload) =>
  await harness.json(`/v9/management/orgs/${slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    auth,
  });

const SHARED_KEY = "sk-shared-key-secret-ABCD1234";

const ACCESS_TOKEN = "sk-ant-oat-secret-access";

const PRIVATE_KEY = "sk-alice-private-key-WXYZ9876";

const HEADER_VALUE = "Bearer header-secret-value-5555";

const byText = (a: string, b: string) => a.localeCompare(b);

const newOrg = async () => {
  const slug = `exp-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: `Export ${slug}`, private_credentials: true }),
  );

  expect(created.status).toBe(201);

  const person = async (who: string, role: string) => {
    const email = `${who}-${slug}@example.com`;

    expect((await send(slug, "/members", platform, "POST", { email, role })).status).toBe(201);

    return { email, auth: await token(email) };
  };

  const admin = await person("admin", "admin");
  const alice = await person("alice", "member");

  expect(
    (
      await send(slug, "/provider-keys/groups", platform, "PUT", {
        family: "claude",
        revision: 0,
        group: {
          "base-url": "https://shared.example.test/v1",
          keys: [{ "api-key": SHARED_KEY }],
          headers: { Authorization: HEADER_VALUE, "X-Team": "blue" },
        },
      })
    ).status,
  ).toBe(200);
  expect(
    (await send(slug, "/credentials?name=shared.json", platform, "POST", claudeFile())).status,
  ).toBe(200);
  expect(
    (
      await send(slug, "/provider-keys/groups", alice.auth, "PUT", {
        family: "claude",
        revision: 0,
        group: { "base-url": "https://alice.example.test/v1", keys: [{ "api-key": PRIVATE_KEY }] },
      })
    ).status,
  ).toBe(200);
  expect((await send(slug, "/org", platform, "PATCH", { usage_retention_days: 30 })).status).toBe(
    200,
  );
  expect(
    (
      await send(slug, "/price-overrides", platform, "POST", {
        provider: "claude",
        model: "claude-sonnet-4-5",
        input: 3,
        output: 15,
      })
    ).status,
  ).toBe(200);

  return { slug, platform, admin, alice };
};

interface Exported {
  readonly exported_at: string;
  readonly org: { readonly slug: string; readonly usage_retention_days: number | null };
  readonly config: Record<string, unknown>;
  readonly prices: ReadonlyArray<Record<string, unknown>>;
  readonly credentials: ReadonlyArray<Record<string, unknown>>;
  readonly grants: ReadonlyArray<Record<string, unknown>>;
  readonly members: ReadonlyArray<{ readonly email: string; readonly role: string }>;
}

describe("GET /export", () => {
  it("answers the org, its shared config, prices, credentials and members, with no secret in it", async () => {
    const org = await newOrg();
    const reply = await send(org.slug, "/export", org.platform);

    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");

    const body = reply.body as Exported;

    expect(body.exported_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(body.org).toMatchObject({ slug: org.slug, usage_retention_days: 30 });
    expect(body.members.map((member) => `${member.email}:${member.role}`).toSorted(byText)).toEqual(
      [`${org.admin.email}:admin`, `${org.alice.email}:member`].toSorted(byText),
    );
    expect(body.prices).toMatchObject([
      { provider: "claude", model: "claude-sonnet-4-5", input: 3 },
    ]);
    expect(body.credentials.map((entry) => entry["name"])).toContain("shared.json");

    // The org's grants are named by people, not by ids.
    expect(body.grants.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.grants)).not.toContain("mem_");

    // The shared group is there with its key as a preview.
    const text = JSON.stringify(body);

    expect(text).toContain("https://shared.example.test/v1");
    expect(text).toContain("1234");
    // A header the panel does not know to be harmless is masked too, like everywhere else config is shown.
    expect(text).not.toContain("blue");

    for (const secret of [
      SHARED_KEY,
      ACCESS_TOKEN,
      PRIVATE_KEY,
      HEADER_VALUE,
      "header-secret-value",
    ])
      expect(text, secret).not.toContain(secret);
  });

  it("is for org admins: a plain member is refused", async () => {
    const org = await newOrg();

    expect((await send(org.slug, "/export", org.alice.auth)).status).toBe(403);
    expect((await send(org.slug, "/export", org.admin.auth)).status).toBe(200);
  });

  it("keeps each org's export to that org", async () => {
    const one = await newOrg();
    const two = await newOrg();
    const body = (await send(two.slug, "/export", two.platform)).body as Exported;

    expect(body.org.slug).toBe(two.slug);
    expect(JSON.stringify(body)).not.toContain(one.slug);
  });
});

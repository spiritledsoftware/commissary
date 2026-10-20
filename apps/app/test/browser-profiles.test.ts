// Browser profiles through the management API (#215, ADR 0039): the app Worker's router, the Access gate and the role
// table, and the real ControlPlane with the Tools part, each answer decoded with the contract. The profiles' own rules
// (sessions opening from them and saving into them, sealing, the private-toolkits setting) are `@commissary/tools`'
// tests (test/browser-profiles.test.ts); here the routes are checked end to end.
import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  BrowserProfileGrants,
  BrowserProfileGrantSaved,
  BrowserProfilesList,
  BrowserProfileView,
  RemovedBrowserProfile,
} from "@commissary/contract/browser-profiles";
import type { Json } from "@commissary/json";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(async () => {
  await harness.dispose();
});

interface Person {
  readonly id: string;
  readonly auth: string;
}

interface Org {
  readonly slug: string;
  readonly admin: Person;
  readonly alice: Person;
  readonly bob: Person;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  who: Person | string,
  method = "GET",
  body?: Json,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> => {
  const merged = new Headers(headers);

  if (body !== undefined) merged.set("content-type", "application/json");

  return await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    method,
    headers: merged,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    auth: typeof who === "string" ? who : who.auth,
  });
};

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

const profileOf = (reply: { body: unknown }) =>
  Schema.decodeUnknownSync(BrowserProfileView)(reply.body);

/** An org with an org admin and two plain members, private toolkits on. */
const newOrg = async (): Promise<Org> => {
  const slug = `profiles-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const made = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug, private_toolkits: true }),
  );

  expect(made.status).toBe(201);

  const org = { slug };

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;
    const added = await send(org, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, auth: await token(email) };
  };

  return {
    slug,
    admin: await person("admin", "admin"),
    alice: await person("alice", "member"),
    bob: await person("bob", "member"),
  };
};

describe("browser profiles", () => {
  it("are created empty and named: a member's private, an org admin's shared, each seen by its manager", async () => {
    const org = await newOrg();

    const shared = await send(org, "/browser-profiles", org.admin, "POST", { name: "marketing" });

    expect(shared.status).toBe(201);
    expect(profileOf(shared)).toMatchObject({
      name: "marketing",
      private: false,
      saved_at: null,
      revision: 1,
    });

    // A plain member's profile is private whatever they ask.
    const own = await send(org, "/browser-profiles", org.alice, "POST", {
      name: "alice-bank",
      private: false,
    });

    expect(own.status).toBe(201);
    expect(profileOf(own)).toMatchObject({ name: "alice-bank", private: true });

    const alices = Schema.decodeUnknownSync(BrowserProfilesList)(
      (await send(org, "/browser-profiles", org.alice)).body,
    );

    expect(alices.profiles.map((profile) => profile.name)).toEqual(["alice-bank"]);
    expect(alices.others).toBeUndefined();

    // An org admin sees the shared ones, and only that another member's private one exists.
    const admins = Schema.decodeUnknownSync(BrowserProfilesList)(
      (await send(org, "/browser-profiles", org.admin)).body,
    );

    expect(admins.profiles.map((profile) => profile.name)).toEqual(["marketing"]);
    expect(admins.others).toEqual([
      expect.objectContaining({
        private: true,
        limited: true,
        owner: expect.objectContaining({ member_id: org.alice.id }),
      }),
    ]);
    expect(JSON.stringify(admins)).not.toContain("alice-bank");

    expect(
      errorOf(await send(org, "/browser-profiles", org.bob, "POST", { name: "marketing" })),
    ).toBe("name_taken");
    expect(
      errorOf(await send(org, "/browser-profiles", org.bob, "POST", { name: "Has Spaces" })),
    ).toBe("invalid");
  });

  it("are renamed and removed at their revision (If-Match)", async () => {
    const org = await newOrg();

    const created = profileOf(
      await send(org, "/browser-profiles", org.alice, "POST", { name: "shop" }),
    );

    const path = `/browser-profiles/${created.id}`;

    const stale = await send(org, path, org.alice, "PATCH", { name: "store" }, { "if-match": "2" });

    expect([stale.status, errorOf(stale)]).toEqual([409, "conflict"]);

    const renamed = await send(
      org,
      path,
      org.alice,
      "PATCH",
      { name: "store" },
      { "if-match": "1" },
    );

    expect(renamed.status).toBe(200);
    expect(profileOf(renamed)).toMatchObject({ name: "store", revision: 2 });

    // Another member reaches nothing of it; an org admin may remove it, not rename it.
    expect((await send(org, path, org.bob, "DELETE", undefined, { "if-match": "2" })).status).toBe(
      404,
    );
    expect(
      errorOf(await send(org, path, org.admin, "PATCH", { name: "x" }, { "if-match": "2" })),
    ).toBe("forbidden");

    const removed = await send(org, path, org.alice, "DELETE", undefined, { "if-match": "2" });

    expect(removed.status).toBe(200);
    expect(Schema.decodeUnknownSync(RemovedBrowserProfile)(removed.body)).toEqual({
      id: created.id,
      removed: true,
    });
    expect(
      (await send(org, path, org.alice, "DELETE", undefined, { "if-match": "2" })).status,
    ).toBe(404);
  });

  it("are granted through the grants routes, which are an org admin's", async () => {
    const org = await newOrg();

    const shared = profileOf(
      await send(org, "/browser-profiles", org.admin, "POST", { name: "marketing" }),
    );

    const body = { subject: { kind: "member", id: org.alice.id }, profile: shared.id };

    expect((await send(org, "/grants/profiles", org.alice)).status).toBe(403);
    expect((await send(org, "/grants/profiles", org.alice, "POST", body)).status).toBe(403);

    const granted = await send(org, "/grants/profiles", org.admin, "POST", body);

    expect(granted.status).toBe(200);
    const saved = Schema.decodeUnknownSync(BrowserProfileGrantSaved)(granted.body);

    expect(saved.revision).toBe(1);
    expect(
      Schema.decodeUnknownSync(BrowserProfileGrants)(
        (await send(org, "/grants/profiles", org.admin)).body,
      ).grants,
    ).toMatchObject([{ id: saved.id, subject: body.subject, profile: shared.id, revision: 1 }]);

    expect(errorOf(await send(org, "/grants/profiles", org.admin, "POST", body))).toBe("conflict");

    const everyone = await send(
      org,
      `/grants/profiles/${saved.id}`,
      org.admin,
      "PUT",
      { subject: { kind: "everyone" }, profile: shared.id },
      { "if-match": "1" },
    );

    expect(Schema.decodeUnknownSync(BrowserProfileGrantSaved)(everyone.body).revision).toBe(2);

    const removed = await send(
      org,
      `/grants/profiles/${saved.id}`,
      org.admin,
      "DELETE",
      undefined,
      {
        "if-match": "2",
      },
    );

    expect(Schema.decodeUnknownSync(BrowserProfileGrantSaved)(removed.body).revision).toBe(0);

    // A private profile takes no grant.
    const own = profileOf(await send(org, "/browser-profiles", org.alice, "POST", { name: "own" }));

    expect(
      errorOf(
        await send(org, "/grants/profiles", org.admin, "POST", {
          subject: { kind: "everyone" },
          profile: own.id,
        }),
      ),
    ).toBe("invalid");
  });

  it("follow the private-toolkits setting: while it is off a member creates none", async () => {
    const org = await newOrg();

    expect(
      (await send(org, "/membership", org.admin, "PATCH", { private_toolkits: false })).status,
    ).toBe(200);

    const refused = await send(org, "/browser-profiles", org.alice, "POST", { name: "shop" });

    expect([refused.status, errorOf(refused)]).toEqual([403, "private_toolkits_unavailable"]);
    // Shared profiles are an org admin's, whatever the setting.
    expect((await send(org, "/browser-profiles", org.admin, "POST", { name: "team" })).status).toBe(
      201,
    );
  });
});

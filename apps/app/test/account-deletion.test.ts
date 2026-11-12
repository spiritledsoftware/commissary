// Deleting a person's account (ADR 0027): they leave every org they belong to with everything of theirs, the orgs they
// were the only member of are deleted with all they hold, and an org that would be left without an owner stops it.
// Through the management API with the real ControlPlanes and a Platform registry of its own.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import {
  ADMIN,
  controlPlane,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  serviceToken,
  token,
} from "./support/management.ts";
import { resetUsageDb } from "@commissary/models/testing";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

beforeAll(async () => {
  await resetUsageDb();
});

type Payload = Parameters<typeof jsonInit>[1];

const send = async (slug: string, path: string, auth: string, method = "GET", body?: Payload) =>
  await harness.json(`/v9/management/orgs/${slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    auth,
  });

const deleteAccount = async (auth: string, body: Payload) =>
  await harness.json("/v9/management/me", { ...jsonInit("DELETE", body), auth });

interface Org {
  readonly slug: string;
  readonly id: OrgId;
}

const createOrg = async (label: string): Promise<Org> => {
  const slug = `${label}-${crypto.randomUUID().slice(0, 8)}`;

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: `Org ${slug}`, private_credentials: true }),
  );

  expect(created.status).toBe(201);

  return { slug, id: OrgId.make((created.body as { id: string }).id) };
};

const addMember = async (org: Org, email: string, role: string) => {
  const added = await send(org.slug, "/members", await token(ADMIN), "POST", { email, role });

  expect(added.status).toBe(201);
};

const person = () => `person-${crypto.randomUUID().slice(0, 8)}@example.com`;

/** The orgs the registry indexes `email` in (asking through the API would sign the person in and admit them again). */
const orgsOf = async (email: string) =>
  (await registry.platform.orgsOfEmail(email)).map((org) => org.slug);

const listed = async () =>
  (await harness.json("/v9/management/orgs", { method: "GET", auth: await token(ADMIN) })).body as {
    orgs: ReadonlyArray<{ slug: string }>;
  };

const tombstones = async (org: Org) =>
  await runInDurableObject(
    env.CONTROL_PLANE.getByName(org.id),
    (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM removed_principals").one().n,
  );

/** A person who shares one org (as a member, with a key and a private account group) and is alone in another. */
const newPerson = async () => {
  const email = person();
  const shared = await createOrg("acct-shared");
  const solo = await createOrg("acct-solo");

  await addMember(shared, `owner-${shared.slug}@example.com`, "owner");
  await addMember(shared, email, "member");
  await addMember(solo, email, "owner");
  const auth = await token(email);

  expect((await send(shared.slug, "/api-keys", auth, "POST", { name: "laptop" })).status).toBe(201);
  expect(
    (
      await send(shared.slug, "/provider-keys/groups", auth, "PUT", {
        family: "claude",
        revision: 0,
        group: { "base-url": "https://api.example.test/v1", keys: [{ "api-key": "sk-gone-0001" }] },
      })
    ).status,
  ).toBe(200);

  return { email, auth, shared, solo };
};

describe("DELETE /me", () => {
  it("removes the person from every org with their data, deletes the orgs they were alone in and drops the index", async () => {
    const { email, auth, shared, solo } = await newPerson();

    expect(await orgsOf(email)).toEqual(expect.arrayContaining([shared.slug, solo.slug]));

    const reply = await deleteAccount(auth, { email });

    // The request itself signed the person into the first org (auto-join), so they leave that one too.
    expect(reply.body).toMatchObject({
      deleted: true,
      orgs_left: expect.arrayContaining([shared.slug]),
      orgs_deleted: [solo.slug],
    });

    // Their org list is empty, the solo org is gone (its slug is free again) and the shared org keeps its owner.
    expect(await orgsOf(email)).toEqual([]);
    expect((await listed()).orgs.map((org) => org.slug)).not.toContain(solo.slug);
    expect((await listed()).orgs.map((org) => org.slug)).toContain(shared.slug);

    const plane = controlPlane(shared.id);

    expect((await plane.listMembers()).map((member) => member.email)).toEqual([
      `owner-${shared.slug}@example.com`,
    ]);
    expect(await plane.listApiKeys(undefined, Date.now())).toEqual([]);

    // Nothing is kept about them, not even the note that blocks a removed member from joining again.
    expect(await tombstones(shared)).toBe(0);
  });

  it("lets the person's address start over: a new account with the same email is a new member", async () => {
    const { email, auth, shared } = await newPerson();

    expect((await deleteAccount(auth, { email })).status).toBe(200);
    await addMember(shared, email, "member");
    expect(await orgsOf(email)).toEqual([shared.slug]);
  });

  it("refuses when the person is the only owner of an org that has other members, and changes nothing", async () => {
    const { email, auth, shared, solo } = await newPerson();
    const crowded = await createOrg("acct-crowded");

    await addMember(crowded, email, "owner");
    await addMember(crowded, `bob-${crowded.slug}@example.com`, "member");

    const reply = await deleteAccount(auth, { email });

    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ error: "sole_owner", orgs: [crowded.slug] });
    expect(await orgsOf(email)).toEqual(
      expect.arrayContaining([shared.slug, solo.slug, crowded.slug]),
    );

    // Handing the org over lets the deletion through.
    const ownerAuth = await token(ADMIN);

    expect(
      (
        await send(
          crowded.slug,
          `/members/${await memberId(crowded, `bob-${crowded.slug}@example.com`)}`,
          ownerAuth,
          "PATCH",
          { role: "owner" },
        )
      ).status,
    ).toBe(200);
    expect((await deleteAccount(auth, { email })).status).toBe(200);
  });

  it("asks for the person's own email", async () => {
    const { email, auth, shared } = await newPerson();

    expect((await deleteAccount(auth, { email: "someone-else@example.com" })).status).toBe(422);
    expect((await deleteAccount(auth, {})).status).toBe(400);
    expect(await orgsOf(email)).toContain(shared.slug);
  });

  it("is for people: a service token is refused", async () => {
    const reply = await deleteAccount(await serviceToken("automation.access"), {
      email: "automation.access",
    });

    expect(reply.status).toBe(403);
  });
});

const memberId = async (org: Org, email: string) =>
  (await controlPlane(org.id).listMembers()).find((member) => member.email === email)?.id;

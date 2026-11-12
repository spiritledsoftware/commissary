// The grant routes (`/v9/management/grants`, ADR 0023) and `models/mine` through the Access gate and the real
// ControlPlane: admin-only CRUD with `If-Match` revisions, the default grant every org starts with, and the model
// lists two members get from different grants (a team grant reaches the members of the team only).
import { assert, describe as effectDescribe, it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, describe, expect, it } from "vite-plus/test";
import type { Json } from "@commissary/json";
import { ManagementApi } from "@commissary/contract/api";
import { ManagementError } from "@commissary/contract/errors";
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

interface Person {
  readonly id: string;
  readonly auth: string;
}

interface Org {
  readonly slug: string;
  readonly platform: { readonly auth: string };
  readonly admin: Person;
  readonly alice: Person;
  readonly bob: Person;
}

interface GrantRow {
  readonly id: string;
  readonly revision: number;
  readonly subject: { readonly kind: string; readonly id?: string };
  readonly scope: { readonly kind: string };
  readonly models: ReadonlyArray<string>;
}

const send = async (
  org: { readonly slug: string },
  path: string,
  who: { readonly auth: string },
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> =>
  await harness.json(`/v9/management/orgs/${org.slug}${path}`, { ...init, auth: who.auth });

const write = (method: string, body?: Json, revision?: number): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(revision === undefined ? {} : { "if-match": String(revision) }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const newOrg = async (): Promise<Org> => {
  const slug = `grants-${crypto.randomUUID().slice(0, 8)}`;
  const platform = { auth: await token(ADMIN) };

  const created = await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }));

  expect(created.status).toBe(201);

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;
    const added = await send({ slug }, "/members", platform, jsonInit("POST", { email, role }));

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, auth: await token(email) };
  };

  return {
    slug,
    platform,
    admin: await person("admin", "admin"),
    alice: await person("alice", "member"),
    bob: await person("bob", "member"),
  };
};

const grants = async (org: Org): Promise<{ version: number; grants: ReadonlyArray<GrantRow> }> => {
  const reply = await send(org, "/grants", org.admin);

  expect(reply.status).toBe(200);

  return reply.body as { version: number; grants: ReadonlyArray<GrantRow> };
};

const subjectOf = (id: string) => ({ kind: "member" as const, id });

const ALL = { kind: "all" as const };

const modelIds = async (org: Org, who: Person): Promise<string[]> => {
  const reply = await send(org, "/models/mine", who);

  expect(reply.status).toBe(200);

  return (reply.body as { models: ReadonlyArray<{ id: string }> }).models.map((model) => model.id);
};

/** Replaces the default grant (everyone, all, `*`) so that only grants a test writes decide. */
const dropDefault = async (org: Org): Promise<void> => {
  const [first] = (await grants(org)).grants;

  expect(first).toMatchObject({ subject: { kind: "everyone" }, scope: ALL, models: ["*"] });

  const removed = await send(
    org,
    `/grants/${first?.id}`,
    org.admin,
    write("DELETE", undefined, first?.revision),
  );

  expect(removed.status).toBe(200);
};

describe("grant routes", () => {
  it("starts an org with the default grant: everyone, every shared credential, every model", async () => {
    const org = await newOrg();
    const { grants: rows } = await grants(org);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: { kind: "everyone" }, scope: ALL, models: ["*"] });
  });

  it("creates, replaces and deletes a grant with If-Match revisions", async () => {
    const org = await newOrg();
    const body = { subject: subjectOf(org.alice.id), scope: ALL, models: ["Claude-Sonnet-*", " "] };
    const created = await send(org, "/grants", org.admin, write("POST", body));

    expect(created.status).toBe(200);
    const saved = created.body as { id: string; revision: number; status: string };

    expect(saved.status).toBe("ok");
    expect((await grants(org)).grants.find((row) => row.id === saved.id)).toMatchObject({
      subject: subjectOf(org.alice.id),
      models: ["claude-sonnet-*"],
      revision: saved.revision,
    });

    const replaced = await send(
      org,
      `/grants/${saved.id}`,
      org.admin,
      write("PUT", { ...body, models: ["gpt-*"] }, saved.revision),
    );

    expect(replaced.status).toBe(200);
    const next = replaced.body as { revision: number };

    expect(next.revision).toBeGreaterThan(saved.revision);

    const stale = await send(
      org,
      `/grants/${saved.id}`,
      org.admin,
      write("PUT", { ...body, models: ["x"] }, saved.revision),
    );

    expect(stale.status).toBe(409);

    const removed = await send(
      org,
      `/grants/${saved.id}`,
      org.admin,
      write("DELETE", undefined, next.revision),
    );

    expect(removed.status).toBe(200);
    expect((await grants(org)).grants.some((row) => row.id === saved.id)).toBe(false);
  });

  it("answers 409 for a second grant of the same subject and scope", async () => {
    const org = await newOrg();
    const body = { subject: subjectOf(org.alice.id), scope: ALL, models: ["a"] };

    expect((await send(org, "/grants", org.admin, write("POST", body))).status).toBe(200);
    expect((await send(org, "/grants", org.admin, write("POST", body))).status).toBe(409);
  });

  it("refuses a grant without models or for a member or team the org does not have with 422", async () => {
    const org = await newOrg();

    const empty = await send(
      org,
      "/grants",
      org.admin,
      write("POST", { subject: subjectOf(org.alice.id), scope: ALL, models: [" "] }),
    );

    const nobody = await send(
      org,
      "/grants",
      org.admin,
      write("POST", { subject: subjectOf("ghost"), scope: ALL, models: ["*"] }),
    );

    const noTeam = await send(
      org,
      "/grants",
      org.admin,
      write("POST", { subject: { kind: "team", id: "ghost" }, scope: ALL, models: ["*"] }),
    );

    expect([empty.status, nobody.status, noTeam.status]).toEqual([422, 422, 422]);
  });

  it("answers 400 for a malformed body and a missing If-Match", async () => {
    const org = await newOrg();
    const [first] = (await grants(org)).grants;

    const malformed = await send(
      org,
      "/grants",
      org.admin,
      write("POST", { subject: { kind: "nobody" }, scope: ALL, models: ["*"] }),
    );

    const noHeader = await send(org, `/grants/${first?.id}`, org.admin, write("DELETE"));

    expect(malformed.status).toBe(400);
    expect(noHeader.status).toBe(400);
  });

  it("is for org admins: a plain member gets 403 on every grant route", async () => {
    const org = await newOrg();
    const [first] = (await grants(org)).grants;
    const body = { subject: { kind: "everyone" }, scope: ALL, models: ["*"] };

    const answers = [
      await send(org, "/grants", org.alice),
      await send(org, "/grants", org.alice, write("POST", body)),
      await send(org, `/grants/${first?.id}`, org.alice, write("PUT", body, first?.revision)),
      await send(
        org,
        `/grants/${first?.id}`,
        org.alice,
        write("DELETE", undefined, first?.revision),
      ),
    ];

    expect(answers.map((reply) => reply.status)).toEqual([403, 403, 403, 403]);
  });

  it("forgets the grants of a member who leaves", async () => {
    const org = await newOrg();

    await send(
      org,
      "/grants",
      org.admin,
      write("POST", { subject: subjectOf(org.alice.id), scope: ALL, models: ["a"] }),
    );
    expect(
      (await send(org, `/members/${org.alice.id}`, org.admin, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await grants(org)).grants.some((row) => row.subject.id === org.alice.id)).toBe(false);
  });
});

describe("models/mine", () => {
  const withSharedClaude = async (): Promise<Org> => {
    const org = await newOrg();

    const uploaded = await send(
      org,
      "/credentials?name=shared.json",
      org.admin,
      write("POST", claudeFile()),
    );

    expect(uploaded.status).toBe(200);

    return org;
  };

  it("lists every model to every member under the default grant", async () => {
    const org = await withSharedClaude();
    const alice = await modelIds(org, org.alice);

    expect(alice.length).toBeGreaterThan(0);
    expect(await modelIds(org, org.bob)).toEqual(alice);
  });

  it("lists different models to two members with different grants", async () => {
    const org = await withSharedClaude();
    const everything = await modelIds(org, org.alice);

    await dropDefault(org);

    const given = async (member: Person, models: string[]) =>
      await send(
        org,
        "/grants",
        org.admin,
        write("POST", {
          subject: subjectOf(member.id),
          scope: { kind: "credential", id: "shared.json" },
          models,
        }),
      );

    expect((await given(org.alice, ["claude-sonnet-*"])).status).toBe(200);
    expect((await given(org.bob, ["claude-opus-*"])).status).toBe(200);

    const alice = await modelIds(org, org.alice);
    const bob = await modelIds(org, org.bob);

    expect(alice.length).toBeGreaterThan(0);
    expect(bob.length).toBeGreaterThan(0);
    expect(alice.every((id) => id.startsWith("claude-sonnet-"))).toBe(true);
    expect(bob.every((id) => id.startsWith("claude-opus-"))).toBe(true);
    expect(everything.length).toBeGreaterThan(alice.length + bob.length - 1);
  });

  it("applies a team grant to the members of the team only", async () => {
    const org = await withSharedClaude();

    await dropDefault(org);

    const team = await send(org, "/teams", org.admin, write("POST", { name: "Research" }));

    expect(team.status).toBe(201);
    const teamId = (team.body as { id: string }).id;

    expect(
      (
        await send(
          org,
          `/teams/${teamId}/members`,
          org.admin,
          write("POST", { member_id: org.bob.id }),
        )
      ).status,
    ).toBe(200);

    const granted = await send(
      org,
      "/grants",
      org.admin,
      write("POST", { subject: { kind: "team", id: teamId }, scope: ALL, models: ["*"] }),
    );

    expect(granted.status).toBe(200);
    expect((await modelIds(org, org.bob)).length).toBeGreaterThan(0);
    expect(await modelIds(org, org.alice)).toEqual([]);
  });

  it("lists nothing to a member nobody granted anything", async () => {
    const org = await withSharedClaude();

    await dropDefault(org);

    expect(await modelIds(org, org.alice)).toEqual([]);
  });
});

/** The generated client of the management contract decodes the same routes (against an org of its own). */
const fetchVia =
  (org: Org): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace("/v9/management", `/v9/management/orgs/${org.slug}`);

    return await harness.call(`${path}${url.search}`, {
      method: request.method,
      headers: request.headers,
      auth: org.admin.auth,
      ...(request.body === null ? {} : { body: await request.text() }),
    });
  };

effectDescribe("grants contract", () => {
  effectIt.effect("decodes the list, the saves, the errors and models/mine", () =>
    Effect.flatMap(Effect.promise(newOrg), (org) =>
      Effect.gen(function* () {
        const api = yield* HttpApiClient.make(ManagementApi, {
          baseUrl: "https://commissary.test",
        });

        const body = { subject: subjectOf(org.alice.id), scope: ALL, models: ["claude-*"] };
        const saved = yield* api.grants.create({ payload: body });

        assert.strictEqual(saved.status, "ok");

        const list = yield* api.grants.list();

        assert.deepStrictEqual(list.grants.map((entry) => entry.id).includes(saved.id), true);

        const conflict = yield* Effect.flip(
          api.grants.replace({
            params: { id: saved.id },
            headers: { "if-match": "999" },
            payload: body,
          }),
        );

        assert.instanceOf(conflict, ManagementError);
        assert.strictEqual(conflict.error, "conflict");

        const removed = yield* api.grants.remove({
          params: { id: saved.id },
          headers: { "if-match": String(saved.revision) },
        });

        assert.strictEqual(removed.revision, 0);
        assert.deepStrictEqual((yield* api.grants.mine()).models, []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FetchHttpClient.layer,
            Layer.succeed(FetchHttpClient.Fetch, fetchVia(org)),
          ),
        ),
      ),
    ),
  );
});

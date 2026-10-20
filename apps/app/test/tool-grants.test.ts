// Tool grants (`/v9/management/grants/tools`, #198, ADR 0038) and the private toolkits setting through the app Worker's
// router, the Access gate and the real ControlPlane, against fake remote MCP servers: admin-only CRUD with `If-Match`
// revisions, connecting a toolkit's shared credential names who may use it, a named tool the source no longer lists
// shows as missing, and `private_toolkits` of `/membership` mirrors `private_credentials`.
import { assert, describe as effectDescribe, it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, describe, expect, it } from "vitest";
import { ManagementApi } from "@commissary/contract/api";
import { ManagementError } from "@commissary/contract/errors";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

serveFakeMcpServers();

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

type Payload = Parameters<typeof jsonInit>[1];

interface Person {
  readonly id: string;
  readonly auth: string;
}

interface Org {
  readonly slug: string;
  readonly platform: string;
  readonly admin: Person;
  readonly alice: Person;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  who: Person | string,
  method = "GET",
  body?: Payload,
  revision?: number,
): Promise<{ status: number; body: unknown }> => {
  const init = body === undefined ? { method } : jsonInit(method, body);

  return await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(revision === undefined ? {} : { "if-match": String(revision) }),
    },
    auth: typeof who === "string" ? who : who.auth,
  });
};

/** An org with an org admin and a plain member; `settings` are chosen at its creation. */
const newOrg = async (settings: Record<string, boolean> = {}): Promise<Org> => {
  const slug = `tool-grants-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug, ...settings }),
  );

  expect(created.status).toBe(201);

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;
    const added = await send({ slug }, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, auth: await token(email) };
  };

  return {
    slug,
    platform,
    admin: await person("admin", "admin"),
    alice: await person("alice", "member"),
  };
};

const server = () =>
  fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
    tools: [{ name: "create_issue" }, { name: "list_issues", annotations: { readOnlyHint: true } }],
  });

/** An org toolkit without a credential: nobody chose who may use it. */
const toolkitOf = async (org: Org, upstream = server()): Promise<string> => {
  const added = await send(org, "/toolkits", org.admin, "POST", {
    source: upstream.url,
    name: "github",
  });

  expect(added.status).toBe(201);

  return (added.body as { id: string }).id;
};

interface ToolGrantRow {
  readonly id: string;
  readonly revision: number;
  readonly subject: { readonly kind: string; readonly id?: string };
  readonly toolkit: string;
  readonly tools: { readonly kind: string; readonly ids?: ReadonlyArray<string> };
  readonly missing?: ReadonlyArray<string>;
}

const toolGrants = async (org: Org): Promise<ReadonlyArray<ToolGrantRow>> => {
  const reply = await send(org, "/grants/tools", org.admin);

  expect(reply.status).toBe(200);

  return (reply.body as { grants: ReadonlyArray<ToolGrantRow> }).grants;
};

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

describe("tool grant routes", () => {
  it("create, replace and delete a grant with If-Match revisions, beside the model grants", async () => {
    const org = await newOrg();
    const toolkit = await toolkitOf(org);
    const body = { subject: { kind: "everyone" }, toolkit, tools: { kind: "read" } };

    expect(await toolGrants(org)).toEqual([]);

    const created = await send(org, "/grants/tools", org.admin, "POST", body);

    expect(created).toMatchObject({
      status: 200,
      body: { status: "ok", id: expect.stringMatching(/^tg_/), revision: 1 },
    });
    const { id } = created.body as { id: string };

    expect(await toolGrants(org)).toEqual([
      {
        id,
        revision: 1,
        subject: { kind: "everyone" },
        toolkit,
        tools: { kind: "read" },
        updated_at: expect.any(Number),
        updated_by: expect.any(String),
      },
    ]);
    // The model grants keep their own list.
    expect(
      ((await send(org, "/grants", org.admin)).body as { grants: ReadonlyArray<unknown> }).grants,
    ).toHaveLength(1);

    expect(errorOf(await send(org, "/grants/tools", org.admin, "POST", body))).toBe("conflict");
    expect(errorOf(await send(org, `/grants/tools/${id}`, org.admin, "PUT", body, 7))).toBe(
      "conflict",
    );

    const replaced = await send(
      org,
      `/grants/tools/${id}`,
      org.admin,
      "PUT",
      { ...body, tools: { kind: "named", ids: [`${toolkit}:create_issue`, `${toolkit}:gone`] } },
      1,
    );

    expect(replaced.body).toEqual({ status: "ok", id, revision: 2 });

    // No list was built (no credential), so neither named tool is in it.
    expect((await toolGrants(org))[0]?.missing).toEqual([
      `${toolkit}:create_issue`,
      `${toolkit}:gone`,
    ]);

    expect(
      (await send(org, `/grants/tools/${id}`, org.admin, "DELETE", undefined, 2)).body,
    ).toEqual({ status: "ok", id, revision: 0 });
    expect(await toolGrants(org)).toEqual([]);
  });

  it("refuse what the org does not have with 422, a malformed body and a missing If-Match with 400", async () => {
    const org = await newOrg();
    const toolkit = await toolkitOf(org);
    const body = { subject: { kind: "everyone" }, toolkit, tools: { kind: "all" } };

    for (const invalid of [
      { ...body, subject: { kind: "member", id: "mem-nobody" } },
      { ...body, subject: { kind: "team", id: "team-nobody" } },
      { ...body, toolkit: "tk_nothing" },
      { ...body, tools: { kind: "named", ids: [] } },
      { ...body, tools: { kind: "named", ids: ["tk_other:create_issue"] } },
    ]) {
      const reply = await send(org, "/grants/tools", org.admin, "POST", invalid);

      expect(reply).toMatchObject({ status: 422, body: { error: "invalid" } });
    }

    expect(
      (await send(org, "/grants/tools", org.admin, "POST", { ...body, tools: "all" })).status,
    ).toBe(400);

    expect((await send(org, "/grants/tools/tg_x", org.admin, "PUT", body)).status).toBe(400);
    expect(await toolGrants(org)).toEqual([]);
  });

  it("are for org admins: a plain member gets 403 on every route", async () => {
    const org = await newOrg();
    const toolkit = await toolkitOf(org);
    const body = { subject: { kind: "everyone" }, toolkit, tools: { kind: "all" } };

    for (const [method, path, payload, revision] of [
      ["GET", "/grants/tools", undefined, undefined],
      ["POST", "/grants/tools", body, undefined],
      ["PUT", "/grants/tools/tg_x", body, 1],
      ["DELETE", "/grants/tools/tg_x", undefined, 1],
    ] as const)
      expect((await send(org, path, org.alice, method, payload, revision)).status).toBe(403);
  });
});

describe("connecting a toolkit's shared credential", () => {
  it("is refused without a subject, and with one creates its grant in the same write", async () => {
    const org = await newOrg();
    const upstream = server();

    // Added with a shared credential that names nobody: refused, and nothing is added.
    const refused = await send(org, "/toolkits", org.admin, "POST", {
      source: upstream.url,
      name: "github",
      credential: { kind: "bearer", token: "shared" },
    });

    expect(refused).toMatchObject({ status: 422, body: { error: "invalid" } });

    const toolkit = await toolkitOf(org, upstream);
    const path = `/toolkits/${toolkit}/credentials/shared`;

    expect(await toolGrants(org)).toEqual([]);

    expect(
      await send(org, path, org.admin, "PUT", { kind: "bearer", token: "shared" }),
    ).toMatchObject({ status: 422, body: { error: "invalid" } });

    const connected = await send(org, path, org.admin, "PUT", {
      kind: "bearer",
      token: "shared",
      subject: { kind: "member", id: org.alice.id },
    });

    expect(connected).toMatchObject({
      status: 200,
      body: { credentials: { shared: { kind: "bearer" } }, tool_list: { tools: 2 } },
    });

    expect(await toolGrants(org)).toEqual([
      expect.objectContaining({
        subject: { kind: "member", id: org.alice.id },
        toolkit,
        tools: { kind: "all" },
      }),
    ]);
  });
});

describe("the private toolkits setting", () => {
  it("is off for a new org unless chosen at its creation, and changed by org admins only", async () => {
    const off = await newOrg({ private_credentials: true });
    const on = await newOrg({ private_toolkits: true });

    expect((await send(off, "/membership", off.admin)).body).toMatchObject({
      private_credentials: true,
      private_toolkits: false,
    });
    expect((await send(on, "/membership", on.admin)).body).toMatchObject({
      private_credentials: false,
      private_toolkits: true,
    });
    expect((await send(on, "/me", on.alice)).body).toMatchObject({ private_toolkits: true });

    expect(
      (await send(on, "/membership", on.alice, "PATCH", { private_toolkits: false })).status,
    ).toBe(403);

    expect(
      (await send(on, "/membership", on.admin, "PATCH", { private_toolkits: false })).body,
    ).toMatchObject({ private_toolkits: false });
  });

  it("answers 403 to a private toolkit while off, and lets it be added once on", async () => {
    const org = await newOrg({ private_credentials: true });
    const toolkit = { source: server().url, name: "mine" };

    for (const who of [org.alice, org.admin]) {
      const refused = await send(org, "/toolkits", who, "POST", { ...toolkit, private: true });

      expect(refused).toMatchObject({
        status: 403,
        body: { error: "private_toolkits_unavailable" },
      });
    }

    await send(org, "/membership", org.admin, "PATCH", { private_toolkits: true });

    expect((await send(org, "/toolkits", org.alice, "POST", toolkit)).status).toBe(201);
  });

  it("is on for global, as private credentials are", async () => {
    const reply = await harness.json("/v9/management/membership", { auth: await token(ADMIN) });

    expect(reply.body).toMatchObject({ private_credentials: true, private_toolkits: true });
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

effectDescribe("tool grants contract", () => {
  effectIt.effect("decodes the list, the saves and the errors", () =>
    Effect.flatMap(
      Effect.promise(async () => {
        const org = await newOrg();

        return { org, toolkit: await toolkitOf(org) };
      }),
      ({ org, toolkit }) =>
        Effect.gen(function* () {
          const api = yield* HttpApiClient.make(ManagementApi, {
            baseUrl: "https://commissary.test",
          });

          const payload = {
            subject: { kind: "member" as const, id: org.alice.id },
            toolkit,
            tools: { kind: "named" as const, ids: [`${toolkit}:gone`] },
          };

          const saved = yield* api.toolGrants.create({ payload });

          assert.strictEqual(saved.revision, 1);

          const list = yield* api.toolGrants.list();

          assert.deepStrictEqual(list.grants[0]?.missing, [`${toolkit}:gone`]);

          const conflict = yield* Effect.flip(
            api.toolGrants.replace({
              params: { id: saved.id },
              headers: { "if-match": "9" },
              payload,
            }),
          );

          assert.instanceOf(conflict, ManagementError);
          assert.strictEqual(conflict.error, "conflict");

          const removed = yield* api.toolGrants.remove({
            params: { id: saved.id },
            headers: { "if-match": String(saved.revision) },
          });

          assert.strictEqual(removed.revision, 0);
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

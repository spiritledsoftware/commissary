// GraphQL toolkits through the management API (#204): the app Worker's router, the Access gate and the real
// ControlPlane with the Tools part. An endpoint the outbound guard refuses is refused on save; a toolkit names its
// endpoint, takes no base URL, no empty schema and none above the SDL limit; one built from an uploaded schema (SDL) is
// named after its endpoint, lists its fields without introspection, and its schema is read back and replaced by an org
// admin.
import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import { ToolkitsList, ToolkitView, ToolsList } from "@commissary/contract/tools";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

type Payload = Parameters<typeof jsonInit>[1];

interface Org {
  readonly slug: string;
  readonly admin: string;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  auth: string,
  method = "GET",
  body?: Payload,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> => {
  const init = body === undefined ? { method } : jsonInit(method, body);
  const merged = new Headers(init.headers);

  for (const [name, value] of Object.entries(headers)) merged.set(name, value);

  return await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...init,
    headers: merged,
    auth,
  });
};

/** An org with an org admin. */
const newOrg = async (): Promise<Org> => {
  const slug = `graphql-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  expect(
    (await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }))).status,
  ).toBe(201);

  const email = `admin-${slug}@example.com`;

  expect(
    (await send({ slug }, "/members", platform, "POST", { email, role: "admin" })).status,
  ).toBe(201);

  return { slug, admin: await token(email) };
};

const SCHEMA = "type Query { issue(id: ID!): Issue } type Issue { id: ID! title: String }";

/** The largest schema (SDL) a GraphQL toolkit takes, in bytes (`MAX_SDL_BYTES`), below an OpenAPI document's. */
const MAX_SDL_BYTES = 4 * 1024 * 1024;

/** A schema just above {@link MAX_SDL_BYTES}. */
const OVERSIZED = `${SCHEMA}\n${"#".repeat(MAX_SDL_BYTES)}`;

const REFUSED = [
  "http://tracker.example.com/graphql",
  "https://10.0.0.5/graphql",
  "https://[fd00::1]/graphql",
  "https://169.254.169.254/graphql",
];

/** The org's own toolkits, without the built-in ones every deployment has. */
const toolkitsOf = async (org: Org) =>
  Schema.decodeUnknownSync(ToolkitsList)(
    (await send(org, "/toolkits", org.admin)).body,
  ).toolkits.filter((toolkit) => toolkit.built_in !== true);

describe("a GraphQL toolkit", () => {
  it("is refused on save when the outbound guard refuses its endpoint", async () => {
    const org = await newOrg();

    for (const url of REFUSED)
      for (const body of [
        { kind: "graphql", source: url },
        { kind: "graphql", source: url, document: SCHEMA },
      ])
        expect(await send(org, "/toolkits", org.admin, "POST", body)).toMatchObject({
          status: 422,
          body: { error: OUTBOUND_REFUSED_MESSAGE, path: "source" },
        });

    expect(await toolkitsOf(org)).toEqual([]);
  });

  it("names its endpoint, and takes neither a base URL nor an empty schema", async () => {
    const org = await newOrg();

    for (const [body, path] of [
      [{ kind: "graphql", document: SCHEMA }, "source"],
      [
        {
          kind: "graphql",
          source: "https://tracker.example.com/graphql",
          base_url: "https://api.example.com",
        },
        "base_url",
      ],
      [
        { kind: "graphql", source: "https://tracker.example.com/graphql", document: " " },
        "document",
      ],
    ] as const)
      expect(await send(org, "/toolkits", org.admin, "POST", body)).toMatchObject({
        status: 422,
        body: { error: "invalid", path },
      });

    expect(
      await send(org, "/toolkits", org.admin, "POST", {
        kind: "graphql",
        source: "https://tracker.example.com/graphql",
        document: OVERSIZED,
      }),
    ).toMatchObject({
      status: 413,
      body: {
        error: "body_too_large",
        message: `the document is larger than ${MAX_SDL_BYTES} bytes`,
        path: "document",
      },
    });

    expect(await toolkitsOf(org)).toEqual([]);
  });

  it("is built from an uploaded schema, which an org admin reads back and replaces", async () => {
    const org = await newOrg();

    const added = await send(org, "/toolkits", org.admin, "POST", {
      kind: "graphql",
      source: "https://graphql.tracker.dev/graphql",
      document: SCHEMA,
      credential: { kind: "none", subject: { kind: "everyone" } },
    });

    expect(added.status).toBe(201);
    const toolkit = Schema.decodeUnknownSync(ToolkitView)(added.body);

    // Named after its endpoint's host, as an MCP toolkit is.
    expect(toolkit).toMatchObject({
      kind: "graphql",
      name: "tracker",
      source: "https://graphql.tracker.dev/graphql",
      uploaded: true,
      tool_list: { tools: 1 },
    });

    expect(await send(org, `/toolkits/${toolkit.id}/document`, org.admin)).toMatchObject({
      status: 200,
      body: { document: SCHEMA },
    });

    const replaced = await send(
      org,
      `/toolkits/${toolkit.id}/document`,
      org.admin,
      "PUT",
      { document: `${SCHEMA} type Mutation { close(id: ID!): Issue }` },
      { "if-match": String(toolkit.revision) },
    );

    expect(replaced.status).toBe(200);

    expect(
      await send(
        org,
        `/toolkits/${toolkit.id}/document`,
        org.admin,
        "PUT",
        { document: OVERSIZED },
        { "if-match": String(toolkit.revision + 1) },
      ),
    ).toMatchObject({
      status: 413,
      body: {
        error: "body_too_large",
        message: `the schema is larger than ${MAX_SDL_BYTES} bytes`,
        path: "document",
      },
    });

    const tools = Schema.decodeUnknownSync(ToolsList)(
      (await send(org, `/toolkits/${toolkit.id}/tools`, org.admin)).body,
    );

    expect(tools.tools.map((tool) => [tool.name, tool.class])).toEqual([
      ["tracker_query_issue", "read"],
      ["tracker_mutation_close", "write"],
    ]);
  });
});

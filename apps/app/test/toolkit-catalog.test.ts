// The toolkit catalog through the management API (#207): the app Worker's router, the Access gate and the role table,
// a fixture registry stored where the cron refresh stores integrations.sh's (merged with the bundled toolkit catalog
// additions), and fake upstreams served in workerd. Members list, search and read it and look domains up
// (integrations.sh's `detect` and `discover`, faked here, through the outbound guard and the org's throttle, without
// changing the catalog); org admins refresh it; a toolkit added from a catalog source gets the source's kind, URL,
// name, document fixes and key placement and a working tool list: an MCP server's, an OpenAPI document's and a Google
// Discovery document's. A source the outbound guard refuses is refused on save, from the catalog or a lookup.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import {
  CatalogPage,
  CatalogService,
  DomainLookup,
  ToolkitCatalogRefresh,
  ToolkitCatalogStatus,
} from "@commissary/contract/toolkit-catalog";
import { ToolkitView, ToolsList } from "@commissary/contract/tools";
import {
  fakeMcpServer,
  serveFakeMcpServers,
  serveOrigin,
  useToolkitCatalogRegistry,
} from "@commissary/tools/testing";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

serveFakeMcpServers();

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

/** The registry the tests' catalog is built from: integrations.sh's index records, of made-up services. */
const REGISTRY = {
  version: 1,
  data: [
    {
      kind: "mcp",
      slug: "wikiful-dev",
      name: "Wikiful",
      description: "A wiki that answers.",
      domain: "wikiful.dev",
      popularity: 90,
      connectUrl: "https://mcp.wikiful.dev/mcp",
      auth: { kind: "none" },
    },
    {
      kind: "graphql",
      slug: "wikiful-dev-graphql",
      name: "Wikiful GraphQL",
      domain: "wikiful.dev",
      popularity: 10,
      connectUrl: "https://api.wikiful.dev/graphql",
      auth: { kind: "api_key", header: "Authorization: {key}" },
    },
    {
      kind: "openapi",
      slug: "petstore-dev",
      name: "Petstore",
      domain: "petstore.dev",
      popularity: 50,
      connectUrl: "https://specs.petstore.dev/openapi.json",
      // integrations.sh's fix of the document's server.
      specOverrides: [{ op: "replace", path: "/servers/0/url", value: "https://api.petstore.dev" }],
    },
    {
      kind: "mcp",
      slug: "keyed-dev",
      name: "Keyed",
      domain: "keyed.dev",
      popularity: 30,
      connectUrl: "https://mcp.keyed.dev/mcp",
      auth: { kind: "api_key", header: "X-Keyed-Key: Token {key}" },
    },
    {
      // A source on Commissary's own host: the outbound guard refuses it when it is saved.
      kind: "mcp",
      slug: "inside-dev",
      name: "Inside",
      domain: "inside.dev",
      popularity: 20,
      connectUrl: "https://commissary.test/mcp",
    },
  ],
} as const;

/** The services of the catalog: the registry's four and the bundled additions' nine Google APIs. */
const SERVICES = 13;

beforeAll(async () => {
  await useToolkitCatalogRegistry(env.CACHE, REGISTRY);
});

afterAll(async () => {
  await useToolkitCatalogRegistry(env.CACHE, undefined);
  await harness.dispose();
});

type Payload = Parameters<typeof jsonInit>[1];

interface Org {
  readonly slug: string;
  readonly admin: string;
  readonly member: string;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  auth: string,
  method = "GET",
  body?: Payload,
): Promise<{ status: number; body: unknown }> =>
  await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    auth,
  });

/** An org with an org admin and a plain member. */
const newOrg = async (): Promise<Org> => {
  const slug = `catalog-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  expect(
    (await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }))).status,
  ).toBe(201);

  const person = async (name: string, role: string) => {
    const email = `${name}-${slug}@example.com`;

    expect((await send({ slug }, "/members", platform, "POST", { email, role })).status).toBe(201);

    return await token(email);
  };

  return { slug, admin: await person("admin", "admin"), member: await person("member", "member") };
};

/** What integrations.sh answers, by path; anything else is a 404. */
let integrationsSh: (path: string) => Response = () => new Response("not found", { status: 404 });

const asked: Array<string> = [];

serveOrigin("https://integrations.sh", (request) => {
  const path = new URL(request.url).pathname;

  asked.push(path);

  return integrationsSh(path);
});

const page = Schema.decodeUnknownSync(CatalogPage);

describe("the toolkit catalog", () => {
  it("lists featured services first, searches, filters by kind, and is read by members", async () => {
    const org = await newOrg();
    const listed = await send(org, "/toolkit-catalog", org.member);

    expect(listed.status).toBe(200);
    const all = page(listed.body);

    expect(all.total).toBe(SERVICES);
    // The additions' featured services the catalog has, in their order, then by popularity.
    expect(all.services.slice(0, 7).map((service) => service.id)).toEqual([
      "gmail",
      "google_calendar",
      "google_drive",
      "wikiful",
      "petstore",
      "keyed",
      "inside",
    ]);
    expect(all.services[0]?.featured).toBe(true);
    expect(all.services[3]?.featured).toBe(false);

    const searched = page((await send(org, "/toolkit-catalog?q=wiki%20answers", org.member)).body);

    expect(searched.services.map((service) => service.id)).toEqual(["wikiful"]);

    const discovery = page((await send(org, "/toolkit-catalog?kind=discovery", org.member)).body);

    expect(discovery.total).toBe(9);
    expect(discovery.services.every((service) => service.kinds.includes("discovery"))).toBe(true);

    const second = page((await send(org, "/toolkit-catalog?limit=2&offset=1", org.member)).body);

    expect(second.services.map((service) => service.id)).toEqual([
      "google_calendar",
      "google_drive",
    ]);

    expect(await send(org, "/toolkit-catalog?kind=cli", org.member)).toMatchObject({
      status: 422,
      body: { error: "invalid", path: "kind" },
    });
  });

  it("answers a service with its sources and how to sign in to them", async () => {
    const org = await newOrg();
    const wikiful = await send(org, "/toolkit-catalog/services/wikiful", org.member);

    expect(wikiful.status).toBe(200);
    expect(Schema.decodeUnknownSync(CatalogService)(wikiful.body)).toEqual({
      id: "wikiful",
      name: "Wikiful",
      domain: "wikiful.dev",
      description: "A wiki that answers.",
      categories: [],
      featured: false,
      kinds: ["mcp", "graphql"],
      sources: [
        {
          id: "wikiful-dev",
          kind: "mcp",
          name: "Wikiful",
          url: "https://mcp.wikiful.dev/mcp",
          credentials: [{ kind: "none" }],
        },
        {
          id: "wikiful-dev-graphql",
          kind: "graphql",
          name: "Wikiful GraphQL",
          url: "https://api.wikiful.dev/graphql",
          credentials: [{ kind: "header", name: "Authorization" }],
        },
      ],
    });
    // No managed OAuth app on a self-hosted Commissary.
    expect(JSON.stringify(wikiful.body)).not.toContain("managed_oauth_app");

    expect(await send(org, "/toolkit-catalog/services/nowhere", org.member)).toMatchObject({
      status: 404,
    });
  });
});

describe("a domain lookup", () => {
  const detected = (domain: string) => ({
    domain,
    found: true,
    probed: [],
    mcp: [
      { url: `https://mcp.${domain}/mcp`, source: "mcp-server-card", auth: "oauth2" },
      // An address the outbound guard refuses: left out, and named.
      { url: "https://10.0.0.5/mcp", source: "mcp-server-card", auth: "none" },
    ],
    apiSchema: { url: `https://${domain}/openapi.json` },
    errors: [],
  });

  it("answers the catalog's service of a domain, or of the domain above it, without asking integrations.sh", async () => {
    const org = await newOrg();
    const before = asked.length;

    for (const domain of ["wikiful.dev", "mcp.wikiful.dev", "WikiFul.dev."])
      expect(
        Schema.decodeUnknownSync(DomainLookup)(
          (await send(org, `/toolkit-catalog/domains/${encodeURIComponent(domain)}`, org.member))
            .body,
        ),
      ).toMatchObject({ via: "catalog", service: { id: "wikiful" } });

    expect(asked.length).toBe(before);
  });

  it("asks integrations.sh's detect for another, keeping what the guard allows, and leaves the catalog alone", async () => {
    const org = await newOrg();

    integrationsSh = (path) =>
      path === "/api/acme-widgets.dev/detect"
        ? Response.json(detected("acme-widgets.dev"))
        : new Response("not found", { status: 404 });

    const found = await send(org, "/toolkit-catalog/domains/acme-widgets.dev", org.member);

    expect(found.status).toBe(200);
    const lookup = Schema.decodeUnknownSync(DomainLookup)(found.body);

    expect(lookup).toMatchObject({
      via: "detect",
      service: {
        id: "acme_widgets",
        domain: "acme-widgets.dev",
        sources: [
          {
            kind: "mcp",
            url: "https://mcp.acme-widgets.dev/mcp",
            credentials: [{ kind: "oauth" }],
          },
          { kind: "openapi", url: "https://acme-widgets.dev/openapi.json" },
        ],
      },
      refused: ["https://10.0.0.5/mcp"],
    });

    // Nothing of it is kept: the catalog has no such service, and its list is unchanged.
    expect((await send(org, "/toolkit-catalog/services/acme_widgets", org.member)).status).toBe(
      404,
    );
    expect(page((await send(org, "/toolkit-catalog?q=acme-widgets", org.member)).body).total).toBe(
      0,
    );

    // A client that saves what the guard refused anyway is refused, as any source is.
    expect(
      await send(org, "/toolkits", org.member, "POST", { source: "https://10.0.0.5/mcp" }),
    ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: "source" } });
  });

  it("asks discover only when asked, and answers integrations.sh's limits and failures", async () => {
    const org = await newOrg();

    const answers = new Map<string, () => Response>([
      [
        "/api/acme-docs.dev/discover",
        () =>
          Response.json({
            version: 3,
            domain: "acme-docs.dev",
            description: "Acme's docs, read.",
            credentials: { key: { type: "api_key", label: "API key" } },
            surfaces: [
              {
                type: "http",
                slug: "acme-docs-rest",
                name: "Acme REST",
                basis: { via: "discovered", evidence: [] },
                spec: "https://acme-docs.dev/spec.json",
                auth: {
                  status: "required",
                  entries: [
                    {
                      use: [
                        {
                          id: "key",
                          mechanics: { source: "http", in: "header", headerName: "X-Api-Key" },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
      ],
      ["/api/busy.dev/discover", () => new Response("slow down", { status: 429 })],
    ]);

    integrationsSh = (path) => answers.get(path)?.() ?? new Response("down", { status: 500 });

    const discovered = await send(
      org,
      "/toolkit-catalog/domains/acme-docs.dev/discover",
      org.member,
      "POST",
    );

    expect(discovered).toMatchObject({
      status: 200,
      body: {
        via: "discover",
        service: {
          id: "acme_docs",
          description: "Acme's docs, read.",
          sources: [
            {
              kind: "openapi",
              url: "https://acme-docs.dev/spec.json",
              credentials: [{ kind: "header", name: "X-Api-Key" }],
            },
          ],
        },
      },
    });

    // The org's next discover within the minute waits, without asking integrations.sh.
    const before = asked.length;

    const throttled = await send(
      org,
      "/toolkit-catalog/domains/acme-docs.dev/discover",
      org.admin,
      "POST",
    );

    expect(throttled).toMatchObject({ status: 429, body: { error: "lookup_rate_limited" } });
    expect(JSON.stringify(throttled.body)).toMatch(/try again in \d+ s/);
    expect(asked.length).toBe(before);

    // integrations.sh's own limit answers the same.
    const other = await newOrg();

    expect(
      await send(other, "/toolkit-catalog/domains/busy.dev/discover", other.member, "POST"),
    ).toMatchObject({ status: 429, body: { error: "lookup_rate_limited" } });
    expect(await send(org, "/toolkit-catalog/domains/down.dev", org.member)).toMatchObject({
      status: 502,
      body: { error: "lookup_failed" },
    });
  });

  it("lets one member detect ten domains a minute", async () => {
    const org = await newOrg();

    integrationsSh = () => new Response("not found", { status: 404 });

    for (let n = 0; n < 10; n++)
      expect((await send(org, `/toolkit-catalog/domains/n${n}.dev`, org.member)).status).toBe(502);

    expect(await send(org, "/toolkit-catalog/domains/n10.dev", org.member)).toMatchObject({
      status: 429,
      body: { error: "lookup_rate_limited" },
    });
    // Another member, and a domain the catalog has, are not held back.
    expect((await send(org, "/toolkit-catalog/domains/n10.dev", org.admin)).status).toBe(502);
    expect((await send(org, "/toolkit-catalog/domains/wikiful.dev", org.member)).status).toBe(200);
  });

  it("refuses what is not a domain, and a domain the outbound guard refuses, before asking", async () => {
    const org = await newOrg();
    const before = asked.length;

    for (const domain of ["localhost", "not a domain", "a..b"])
      expect(
        await send(org, `/toolkit-catalog/domains/${encodeURIComponent(domain)}`, org.member),
      ).toMatchObject({ status: 422, body: { error: "invalid", path: "domain" } });

    for (const domain of ["10.0.0.5", "169.254.169.254", "commissary.test"])
      expect(
        await send(org, `/toolkit-catalog/domains/${domain}/discover`, org.member, "POST"),
      ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: "domain" } });

    expect(asked.length).toBe(before);
  });
});

describe("the catalog's refresh", () => {
  it("is for org admins, and a failure keeps the catalog", async () => {
    const org = await newOrg();

    integrationsSh = () => new Response("down", { status: 500 });

    expect(await send(org, "/toolkit-catalog/refresh", org.member, "POST")).toMatchObject({
      status: 403,
    });

    const refreshed = await send(org, "/toolkit-catalog/refresh", org.admin, "POST");

    expect(refreshed.status).toBe(200);
    expect(Schema.decodeUnknownSync(ToolkitCatalogRefresh)(refreshed.body)).toMatchObject({
      status: "failed",
      message: "integrations.sh answered HTTP 500",
    });
    expect(page((await send(org, "/toolkit-catalog", org.member)).body).total).toBe(SERVICES);

    const status = await send(org, "/toolkit-catalog/status", org.member);

    expect(Schema.decodeUnknownSync(ToolkitCatalogStatus)(status.body)).toMatchObject({
      stored: true,
      last_attempt: { status: "failed", message: "integrations.sh answered HTTP 500" },
      services: SERVICES,
      sources: 5 + 9,
    });
  });
});

describe("a toolkit added from the catalog", () => {
  const view = Schema.decodeUnknownSync(ToolkitView);

  const toolsOf = async (org: Org, id: string) =>
    Schema.decodeUnknownSync(ToolsList)(
      (await send(org, `/toolkits/${id}/tools`, org.admin)).body,
    ).tools.map((tool) => tool.name);

  it("is an MCP server's, named by its service, with a working tool list", async () => {
    const org = await newOrg();

    fakeMcpServer("https://mcp.wikiful.dev/mcp", {
      tools: [{ name: "ask_question" }, { name: "read_wiki_structure" }],
    });

    const added = await send(org, "/toolkits", org.admin, "POST", {
      catalog: { service: "wikiful", source: "wikiful-dev" },
      credential: { kind: "none", subject: { kind: "everyone" } },
    });

    expect(added.status).toBe(201);
    const toolkit = view(added.body);

    expect(toolkit).toMatchObject({
      kind: "mcp",
      name: "wikiful",
      source: "https://mcp.wikiful.dev/mcp",
      catalog: { service: "wikiful", source: "wikiful-dev", credential: { kind: "none" } },
      tool_list: { tools: 2 },
    });
    expect(await toolsOf(org, toolkit.id)).toEqual([
      "wikiful_ask_question",
      "wikiful_read_wiki_structure",
    ]);
  });

  it("keeps where the source's key goes: a key connected without a name goes there, prefixed", async () => {
    const org = await newOrg();

    const server = fakeMcpServer("https://mcp.keyed.dev/mcp", {
      tools: [{ name: "lookup" }],
      authorized: (request) => request.headers.get("x-keyed-key") === "Token k-1",
    });

    const added = await send(org, "/toolkits", org.admin, "POST", {
      catalog: { service: "keyed", source: "keyed-dev" },
      credential: { kind: "header", value: "k-1", subject: { kind: "everyone" } },
    });

    expect(added).toMatchObject({
      status: 201,
      body: {
        catalog: { credential: { kind: "header", name: "X-Keyed-Key", prefix: "Token" } },
        credentials: { shared: { kind: "header", name: "X-Keyed-Key" } },
        tool_list: { tools: 1 },
      },
    });
    expect(server.requests.at(-1)?.headers.get("x-keyed-key")).toBe("Token k-1");

    // A kind of credential the source does not take is refused.
    expect(
      await send(org, "/toolkits", org.admin, "POST", {
        catalog: { service: "keyed", source: "keyed-dev", credential: "bearer" },
        name: "keyed_2",
      }),
    ).toMatchObject({ status: 422, body: { error: "invalid", path: "catalog.credential" } });
  });

  it("is an OpenAPI document's, with integrations.sh's fixes to it", async () => {
    const org = await newOrg();

    serveOrigin("https://specs.petstore.dev", () =>
      Response.json({
        openapi: "3.1.0",
        info: { title: "Petstore", version: "1.0.0" },
        // A private address the outbound guard refuses: without the fix, no operation could be called.
        servers: [{ url: "https://10.0.0.9" }],
        paths: { "/pets": { get: { operationId: "listPets" } } },
      }),
    );

    const added = await send(org, "/toolkits", org.admin, "POST", {
      catalog: { service: "petstore", source: "petstore-dev" },
    });

    expect(added).toMatchObject({
      status: 201,
      body: {
        kind: "openapi",
        name: "petstore",
        source: "https://specs.petstore.dev/openapi.json",
        tool_list: { tools: 1 },
      },
    });
    expect(view(added.body).tool_list).not.toHaveProperty("error");
  });

  it("is refused on save when the outbound guard refuses its source", async () => {
    const org = await newOrg();

    expect(
      await send(org, "/toolkits", org.admin, "POST", {
        catalog: { service: "inside", source: "inside-dev" },
      }),
    ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: "source" } });
  });

  it("is a Google Discovery document's, from the additions", async () => {
    const org = await newOrg();

    serveOrigin("https://gmail.googleapis.com", () =>
      Response.json({
        kind: "discovery#restDescription",
        discoveryVersion: "v1",
        name: "gmail",
        version: "v1",
        title: "Gmail API",
        rootUrl: "https://gmail.googleapis.com/",
        servicePath: "",
        auth: { oauth2: { scopes: { "https://mail.google.com/": { description: "all" } } } },
        resources: {
          users: {
            methods: {
              getProfile: {
                id: "gmail.users.getProfile",
                path: "gmail/v1/users/{userId}/profile",
                httpMethod: "GET",
                parameters: { userId: { type: "string", location: "path", required: true } },
                scopes: ["https://mail.google.com/"],
              },
            },
          },
        },
      }),
    );

    const added = await send(org, "/toolkits", org.admin, "POST", {
      catalog: { service: "gmail", source: "gmail-discovery" },
    });

    expect(added).toMatchObject({
      status: 201,
      body: {
        kind: "discovery",
        name: "gmail",
        catalog: { service: "gmail", source: "gmail-discovery" },
        tool_list: { tools: 1 },
        scopes: ["https://mail.google.com/"],
      },
    });
  });

  it("is refused for a service or source the catalog lacks, or a kind or source that is not the source's", async () => {
    const org = await newOrg();

    for (const [body, path] of [
      [{ catalog: { service: "nowhere", source: "x" } }, "catalog"],
      [{ catalog: { service: "wikiful", source: "nope" } }, "catalog"],
      [{ catalog: { service: "wikiful", source: "wikiful-dev" }, kind: "openapi" }, "kind"],
      [
        {
          catalog: { service: "wikiful", source: "wikiful-dev" },
          source: "https://elsewhere.example.com/mcp",
        },
        "source",
      ],
    ] as const)
      expect(await send(org, "/toolkits", org.admin, "POST", body)).toMatchObject({
        status: 422,
        body: { error: "invalid", path },
      });
  });
});

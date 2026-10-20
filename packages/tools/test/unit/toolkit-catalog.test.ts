// The toolkit catalog (#207, ADR 0036): integrations.sh's index trimmed to the services Commissary can build toolkits
// from, merged with the toolkit catalog additions (which fill gaps and, unlike model catalog additions, correct the
// registry), listed and searched with featured services first, and how its auth methods become toolkit credentials.
import { describe, expect, it } from "vitest";
import { type Additions, additionsOf, bundledAdditions } from "../../src/catalog/additions.ts";
import {
  buildCatalog,
  type Catalog,
  embeddedCatalog,
  serviceView,
  summaryView,
} from "../../src/catalog/catalog.ts";
import { trimIntegrationsSh, type TrimmedRegistry } from "../../src/catalog/integrations-sh.ts";
import { discoveryFromText, sourceCredentials } from "../../src/catalog/credentials.ts";
import { managedAppsOf } from "../../src/catalog/managed-apps.ts";
import registry from "../fixtures/catalog/registry.json";

const text = JSON.stringify(registry);

describe("trimIntegrationsSh", () => {
  it("keeps the MCP, OpenAPI and GraphQL sources it can build from, with only the fields Commissary uses", () => {
    const trimmed = trimIntegrationsSh(text, { minimum: 1 });

    expect(trimmed.ok).toBe(true);

    if (!trimmed.ok) return;
    const slugs = trimmed.value.data.map((record) => record.slug);

    // No CLI, no source without a public https URL to build from (no spec, stdio, a templated host, plain http).
    expect(slugs.toSorted()).toEqual(
      [
        "deepwiki-com",
        "figma-com",
        "github-com",
        "github-com-openapi",
        "google-gmail",
        "linear-app",
        "linear-app-graphql",
        "linear-com-mcp",
        "outlook-calendar",
        "outlook-mail",
      ].toSorted(),
    );

    expect(trimmed.skipped).toBe(1);

    expect(trimmed.value.data.find((record) => record.slug === "linear-app-graphql")).toEqual({
      kind: "graphql",
      slug: "linear-app-graphql",
      name: "Linear",
      description: "Linear's GraphQL API.",
      domain: "linear.app",
      categories: ["productivity"],
      connectUrl: "https://api.linear.app/graphql",
      auth: { kind: "api_key", header: "Authorization: {api_key}" },
    });
  });

  it("is idempotent: trimming a trimmed document gives it back unchanged", () => {
    const once = trimIntegrationsSh(text, { minimum: 1 });

    if (!once.ok) throw new Error(once.error);
    const twice = trimIntegrationsSh(JSON.stringify(once.value), { minimum: 1 });

    expect(twice).toEqual({ ...once, skipped: 0 });
  });

  it("rejects a document that is not the index, or that keeps fewer sources than the minimum", () => {
    expect(trimIntegrationsSh("not json").ok).toBe(false);
    expect(trimIntegrationsSh(JSON.stringify({ version: 2, data: [] })).ok).toBe(false);
    expect(trimIntegrationsSh(text, { minimum: 100 })).toEqual({
      ok: false,
      error: "the registry lists 10 sources Commissary can build, fewer than 100",
    });
  });
});

/** The fixture registry, trimmed. */
const fixtureRegistry = (): TrimmedRegistry => {
  const trimmed = trimIntegrationsSh(text, { minimum: 1 });

  if (!trimmed.ok) throw new Error(trimmed.error);

  return trimmed.value;
};

const NO_ADDITIONS: Additions = {
  featured: [],
  services: [],
  corrections: [],
  managed_apps: {},
  tool_overrides: {},
};

/** No credentials from the domains' v3 documents: the fixture's sources take what the index says. */
const INDEX_ONLY = {};

const fixtureAdditions: Additions = additionsOf({
  featured: ["figma", "nowhere", "deepwiki"],
  services: [
    {
      id: "acme",
      name: "Acme",
      domain: "acme.example",
      description: "A service integrations.sh lacks.",
      sources: [
        {
          id: "acme-mcp",
          kind: "mcp",
          name: "Acme MCP",
          url: "https://mcp.acme.example/mcp",
          auth: [{ type: "jwt" }],
          credential_settings: {
            jwt: { algorithm: "RS256", token_url: "https://acme.example/token" },
          },
        },
      ],
    },
    {
      id: "gmail",
      icon: "https://example.com/gmail.png",
      description: "Not used: the registry has one.",
      sources: [
        {
          id: "gmail-discovery",
          kind: "discovery",
          name: "Gmail API",
          url: "https://gmail.googleapis.com/$discovery/rest?version=v1",
          auth: [{ type: "oauth2" }],
        },
        // The registry has this source: it wins over the addition.
        {
          id: "google-gmail",
          kind: "openapi",
          name: "Not used",
          url: "https://example.com/not-used.json",
        },
      ],
    },
    // A service the registry lacks, without the name and domain it needs: left out.
    { id: "nameless", sources: [] },
  ],
  corrections: [
    {
      service: "figma",
      source: "figma-com",
      url: "https://example.com/figma/openapi-fixed.yaml",
      auth: [{ type: "bearer" }, { type: "oauth2" }],
      reason: "the spec URL moved",
      upstream: "https://github.com/UsefulSoftwareCo/integrations/issues/1",
    },
    {
      service: "nowhere",
      source: "nothing",
      url: "https://example.com",
      reason: "names no service",
      upstream: "-",
    },
  ],
  managed_apps: {},
  tool_overrides: {},
});

describe("the toolkit catalog", () => {
  it("groups a domain's sources into one service named by its slug, a standalone product into its own", () => {
    const catalog = buildCatalog(fixtureRegistry(), NO_ADDITIONS, INDEX_ONLY);

    expect(catalog.services.map((service) => service.id).toSorted()).toEqual(
      [
        "deepwiki",
        "figma",
        "github",
        "gmail",
        "linear",
        // linear.com wants `linear` too: of two equally long domains, the first in order keeps it.
        "linear_com",
        "outlook_calendar",
        "outlook_mail",
      ].toSorted(),
    );

    expect(catalog.service("linear")).toMatchObject({
      name: "Linear",
      domain: "linear.app",
      sources: [
        { id: "linear-app", kind: "mcp", url: "https://mcp.linear.app/mcp" },
        { id: "linear-app-graphql", kind: "graphql", url: "https://api.linear.app/graphql" },
      ],
    });

    expect(catalog.service("outlook_mail")).toMatchObject({
      domain: "graph.microsoft.com",
      standalone: true,
      sources: [{ id: "outlook-mail", scopes: ["Mail.ReadWrite", "Mail.Send"] }],
    });
  });

  it("maps the registry's auth methods onto toolkit credentials", () => {
    const catalog = buildCatalog(fixtureRegistry(), NO_ADDITIONS, INDEX_ONLY);
    const view = (id: string) => serviceView(catalog.service(id) ?? expect.fail(id), false);

    expect(view("github").sources.map((source) => [source.id, source.credentials])).toEqual([
      ["github-com", [{ kind: "oauth" }, { kind: "bearer" }]],
      ["github-com-openapi", [{ kind: "bearer" }]],
    ]);

    // Linear's keys go in `Authorization` with no `Bearer`; Figma's in a header of its own.
    expect(view("linear").sources[1]?.credentials).toEqual([
      { kind: "header", name: "Authorization" },
    ]);
    expect(view("figma").sources[0]?.credentials).toEqual([
      { kind: "header", name: "X-Figma-Token" },
    ]);
    expect(view("deepwiki").sources[0]?.credentials).toEqual([{ kind: "none" }]);
    // The registry does not say: the source's own document does.
    expect(view("outlook_mail").sources[0]?.credentials).toEqual([]);
  });

  it("lets additions fill the registry's gaps but not replace what it has", () => {
    const catalog = buildCatalog(fixtureRegistry(), fixtureAdditions, INDEX_ONLY);

    expect(catalog.service("acme")).toMatchObject({
      name: "Acme",
      domain: "acme.example",
      sources: [{ id: "acme-mcp", kind: "mcp", auth: [{ type: "jwt" }] }],
    });

    expect(serviceView(catalog.service("acme") ?? expect.fail("acme"), false).sources).toEqual([
      {
        id: "acme-mcp",
        kind: "mcp",
        name: "Acme MCP",
        url: "https://mcp.acme.example/mcp",
        credentials: [{ kind: "jwt" }],
        credential_settings: {
          jwt: { algorithm: "RS256", token_url: "https://acme.example/token" },
        },
      },
    ]);

    const gmail = catalog.service("gmail");

    expect(gmail?.description).toBe("Gmail over its REST API.");
    expect(gmail?.icon).toBe("https://example.com/gmail.png");
    expect(gmail?.sources.map((source) => [source.id, source.kind, source.url])).toEqual([
      ["google-gmail", "openapi", "https://integrations.sh/specs/google/google-gmail.json"],
      ["gmail-discovery", "discovery", "https://gmail.googleapis.com/$discovery/rest?version=v1"],
    ]);

    expect(catalog.service("nameless")).toBeUndefined();
  });

  it("lets a correction win over the registry, and marks the source corrected", () => {
    const catalog = buildCatalog(fixtureRegistry(), fixtureAdditions, INDEX_ONLY);

    expect(serviceView(catalog.service("figma") ?? expect.fail("figma"), false).sources).toEqual([
      {
        id: "figma-com",
        kind: "openapi",
        name: "Figma",
        url: "https://example.com/figma/openapi-fixed.yaml",
        credentials: [{ kind: "bearer" }, { kind: "oauth" }],
        corrected: true,
      },
    ]);
  });

  it("lists featured services first, in the additions' order, then by popularity", () => {
    const catalog = buildCatalog(fixtureRegistry(), fixtureAdditions, INDEX_ONLY);

    expect(catalog.services.slice(0, 4).map((service) => service.id)).toEqual([
      "figma",
      "deepwiki",
      // Then by popularity.
      "linear_com",
      "github",
    ]);
    expect(summaryView(catalog.services[0] ?? expect.fail("empty"))).toMatchObject({
      id: "figma",
      featured: true,
      kinds: ["openapi"],
    });
  });

  it("searches words of a service's name, slug, domain, description and categories, by kind, a page at a time", () => {
    const catalog = buildCatalog(fixtureRegistry(), fixtureAdditions, INDEX_ONLY);

    const ids = (query: Parameters<Catalog["search"]>[0]) =>
      catalog.search(query).services.map((service) => service.id);

    expect(ids({ q: "outlook" })).toEqual(["outlook_calendar", "outlook_mail"]);
    expect(ids({ q: "Microsoft Graph calendars" })).toEqual(["outlook_calendar"]);
    expect(ids({ q: "developer-tools" })).toEqual(["deepwiki", "github"]);
    expect(ids({ kind: "graphql" })).toEqual(["linear"]);
    expect(ids({ kind: "discovery" })).toEqual(["gmail"]);
    expect(ids({ q: "linear", kind: "mcp" })).toEqual(["linear_com", "linear"]);
    expect(catalog.search({ limit: 2, offset: 1 })).toMatchObject({
      total: catalog.services.length,
      services: [{ id: "deepwiki" }, { id: "linear_com" }],
    });
  });

  it("finds a domain's service, or that of the nearest domain above it, but no standalone product's", () => {
    const catalog = buildCatalog(fixtureRegistry(), fixtureAdditions, INDEX_ONLY);

    expect(catalog.forDomain("linear.app")?.id).toBe("linear");
    expect(catalog.forDomain("MCP.Linear.App")?.id).toBe("linear");
    expect(catalog.forDomain("graph.microsoft.com")).toBeUndefined();
    expect(catalog.forDomain("app")).toBeUndefined();
    expect(catalog.forDomain("unknown.example")).toBeUndefined();
  });

  it("flags a source's managed OAuth app only when one is available and the source signs in with OAuth", () => {
    const catalog = buildCatalog(fixtureRegistry(), NO_ADDITIONS, INDEX_ONLY);
    const github = catalog.service("github") ?? expect.fail("github");

    expect(serviceView(github, true).sources.map((source) => source.managed_oauth_app)).toEqual([
      true,
      undefined,
    ]);
    expect(serviceView(github, false).sources.map((source) => source.managed_oauth_app)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("a domain's v3 document", () => {
  const document = {
    version: 3,
    credentials: {
      key: { type: "api_key" },
      oauth: { type: "oauth2" },
      signed: { type: "signature" },
    },
    surfaces: [
      {
        type: "http",
        spec: "https://acme.example/openapi.json",
        specAlternates: ["https://acme.example/openapi.yaml"],
        auth: {
          status: "required",
          entries: [
            {
              use: [
                {
                  id: "key",
                  mechanics: { source: "http", in: "header", headerName: "X-Key", scheme: "Token" },
                },
              ],
            },
            { use: [{ id: "signed", mechanics: { source: "http" } }] },
          ],
        },
      },
      {
        type: "mcp",
        url: "https://mcp.acme.example/mcp/",
        auth: {
          status: "required",
          entries: [{ use: [{ id: "oauth", mechanics: { source: "well-known" } }] }],
        },
      },
      { type: "graphql", url: "https://acme.example/graphql", auth: { status: "unknown" } },
      { type: "cli", auth: { status: "none" } },
    ],
  };

  it("gives each source the ways of the surface of its kind at its URL", () => {
    const read = discoveryFromText(JSON.stringify(document));

    if (read === undefined) throw new Error("the fixture is a v3 document");

    const sources = sourceCredentials(read, [
      { slug: "acme-openapi", kind: "openapi", connectUrl: "https://acme.example/openapi.yaml" },
      { slug: "acme-mcp", kind: "mcp", connectUrl: "https://MCP.acme.example/mcp" },
      // A surface that does not say, or of another kind at the URL: the index's note stays.
      { slug: "acme-graphql", kind: "graphql", connectUrl: "https://acme.example/graphql" },
      { slug: "acme-mcp-2", kind: "mcp", connectUrl: "https://acme.example/openapi.json" },
    ]);

    expect(Object.fromEntries(sources)).toEqual({
      "acme-openapi": [{ type: "api_key", in: "header", name: "X-Key", prefix: "Token" }],
      "acme-mcp": [{ type: "oauth2" }],
    });
    expect(discoveryFromText(JSON.stringify({ surfaces: "nope" }))).toBeUndefined();
  });
});

describe("the bundled catalog", () => {
  it("decodes, and every featured service, correction, managed app and override names one it has", () => {
    const additions = bundledAdditions();
    const catalog = embeddedCatalog();

    const sources = (service: string) =>
      catalog.service(service)?.sources.map((source) => source.id) ?? [];

    expect(catalog.services.length).toBeGreaterThan(1000);

    for (const id of additions.featured) expect(catalog.service(id), id).toBeDefined();

    for (const { service, source } of additions.corrections)
      expect(sources(service), `${service}/${source}`).toContain(source);

    for (const service of Object.keys(additions.managed_apps))
      expect(catalog.service(service), service).toBeDefined();

    for (const key of Object.keys(additions.tool_overrides)) {
      const [service = "", source = ""] = key.split("/");

      expect(sources(service), key).toContain(source);
    }

    for (const service of additions.services)
      expect(catalog.service(service.id), service.id).toBeDefined();
  });

  it("keeps the additions' services when a refreshed registry lacks them", () => {
    const additions = bundledAdditions();
    const bare = buildCatalog({ version: 1, data: [] }, additions, {});

    for (const service of additions.services) {
      // A service of the additions names itself, so it stands without the registry.
      expect(service.name, service.id).toBeDefined();
      expect(service.domain, service.id).toBeDefined();
      expect(
        bare.service(service.id)?.sources.map((source) => source.id),
        service.id,
      ).toEqual(service.sources.map((source) => source.id));
      expect(bare.forDomain(service.domain ?? "")?.id).toBe(service.id);
    }
  });

  it("reads its credentials from the domains' v3 documents where they say more than the index", () => {
    const fixture = buildCatalog(fixtureRegistry(), NO_ADDITIONS, {
      "github-com-openapi": [{ type: "app" }],
    });

    expect(fixture.service("github")?.sources.map((source) => [source.id, source.auth])).toEqual([
      // The index's note, where the documents say nothing.
      ["github-com", [{ type: "oauth2" }, { type: "bearer" }]],
      ["github-com-openapi", [{ type: "app" }]],
    ]);

    const catalog = embeddedCatalog();

    const credentials = (service: string, source: string) =>
      catalog.service(service)?.sources.find((entry) => entry.id === source)?.auth;

    // The index notes `Authorization: {api_key}`; linear.app's document adds its OAuth sign-in.
    expect(credentials("linear", "linear-app-graphql")).toEqual([
      { type: "api_key", in: "header", name: "Authorization" },
      { type: "oauth2" },
    ]);
  });
});

describe("the managed OAuth apps", () => {
  const additions = additionsOf({
    ...NO_ADDITIONS,
    managed_apps: {
      acme: {
        client_id: "cloud-acme",
        authorize_url: "https://acme.example.com/authorize",
        token_url: "https://acme.example.com/token",
        scopes: ["read"],
        secret: "TOOLKIT_OAUTH_ACME",
      },
    },
  });

  it("are available on Commissary Cloud only, each once its secret is bound", () => {
    const secret = { TOOLKIT_OAUTH_ACME: "acme-secret" };

    expect(
      managedAppsOf({ COMMISSARY_MODE: undefined, ...secret }, additions).app("acme", "t1"),
    ).toBeUndefined();
    expect(
      managedAppsOf({ COMMISSARY_MODE: "self-hosted", ...secret }, additions).app("acme", "t1"),
    ).toBeUndefined();
    expect(
      managedAppsOf({ COMMISSARY_MODE: "cloud" }, additions).app("acme", "t1"),
    ).toBeUndefined();
    const empty = { COMMISSARY_MODE: "cloud", TOOLKIT_OAUTH_ACME: "" };

    expect(managedAppsOf(empty, additions).app("acme", "t1")).toBeUndefined();

    const bound = { COMMISSARY_MODE: "cloud", ...secret };
    const cloud = managedAppsOf(bound, additions);

    expect(cloud.app("acme", "t1")).toMatchObject({
      toolkitId: "t1",
      clientId: "cloud-acme",
      clientSecret: "acme-secret",
      scopes: ["read"],
    });
    expect(cloud.app("linear", "t1")).toBeUndefined();
    // Not a key of the additions' own: `toString` is no service.
    expect(cloud.app("toString", "t1")).toBeUndefined();
    // What the catalog's views ask: a yes or no, without building the app or reading its secret.
    expect([cloud.has("acme"), cloud.has("linear"), cloud.has("toString")]).toEqual([
      true,
      false,
      false,
    ]);
    expect(managedAppsOf(empty, additions).has("acme")).toBe(false);
  });

  it("refuse a secret binding outside TOOLKIT_OAUTH_*", () => {
    expect(() =>
      additionsOf({
        ...NO_ADDITIONS,
        managed_apps: {
          acme: {
            client_id: "x",
            authorize_url: "https://acme.example.com/authorize",
            token_url: "https://acme.example.com/token",
            secret: "SECRETS_KEY",
          },
        },
      }),
    ).toThrow();
  });
});

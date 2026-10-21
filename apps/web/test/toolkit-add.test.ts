// Adding a toolkit (src/lib/toolkit-add.ts, #208, ADR 0036, #207): from the toolkit catalog, from a URL looked up with
// integrations.sh's detect (and discover, when asked), or from an uploaded document; the body each sends, and the name
// and credentials it is added with.
import { describe, expect, it } from "vitest";
import type { CatalogService, DomainLookup } from "@commissary/contract/toolkit-catalog";
import { addBody, documentProblem, domainOf, type AddDetails } from "../src/lib/toolkit-add.ts";

const LINEAR: CatalogService = {
  id: "linear",
  name: "Linear",
  domain: "linear.app",
  categories: ["project-management"],
  featured: true,
  kinds: ["mcp", "graphql"],
  sources: [
    {
      id: "linear-mcp",
      kind: "mcp",
      name: "Linear MCP",
      url: "https://mcp.linear.app/mcp",
      credentials: [{ kind: "oauth" }, { kind: "header", name: "Authorization", prefix: "Bearer" }],
    },
    {
      id: "linear-graphql",
      kind: "graphql",
      name: "Linear GraphQL",
      url: "https://api.linear.app/graphql",
      credentials: [],
    },
  ],
};

const ORG: AddDetails = { name: "", private: false, accepts: "shared", credential: undefined };

describe("adding from the catalog", () => {
  it("names the service and source, and lets the server fill the kind, URL, name and settings", () => {
    const [mcp] = LINEAR.sources;

    expect(
      addBody({ from: "catalog", service: LINEAR, source: mcp! }, { ...ORG, credential: "header" }),
    ).toEqual({
      catalog: { service: "linear", source: "linear-mcp", credential: "header" },
      accepts: "shared",
    });
  });

  it("adds a plain member's toolkit as a private one, with a name of their own", () => {
    const [, graphql] = LINEAR.sources;

    expect(
      addBody(
        { from: "catalog", service: LINEAR, source: graphql! },
        { name: " linear_api ", private: true, accepts: "both", credential: undefined },
      ),
    ).toEqual({
      catalog: { service: "linear", source: "linear-graphql" },
      name: "linear_api",
      private: true,
    });
  });
});

describe("adding by URL", () => {
  it("looks up the domain of what was typed, a URL or a bare domain", () => {
    expect(domainOf("https://mcp.linear.app/mcp")).toBe("mcp.linear.app");
    expect(domainOf("  Linear.app ")).toBe("linear.app");
    expect(domainOf("linear.app/docs")).toBe("linear.app");
    expect(domainOf("")).toBeUndefined();
    expect(domainOf("not a domain")).toBeUndefined();
  });

  it("adds a source that detect or discover found by its URL and kind, under the domain's slug", () => {
    const detected: DomainLookup = {
      via: "detect",
      service: {
        ...LINEAR,
        id: "acme_dev",
        featured: false,
        sources: [
          {
            id: "detected-0",
            kind: "openapi",
            name: "Acme API",
            url: "https://acme.dev/openapi.json",
            credentials: [],
          },
        ],
      },
    };

    expect(
      addBody({ from: "lookup", lookup: detected, source: detected.service.sources[0]! }, ORG),
    ).toEqual({
      kind: "openapi",
      source: "https://acme.dev/openapi.json",
      name: "acme_dev",
      accepts: "shared",
    });
  });

  it("adds a catalog service a lookup answers from the catalog, as the catalog would", () => {
    const fromCatalog: DomainLookup = { via: "catalog", service: LINEAR };

    expect(
      addBody({ from: "lookup", lookup: fromCatalog, source: LINEAR.sources[0]! }, ORG),
    ).toEqual({ catalog: { service: "linear", source: "linear-mcp" }, accepts: "shared" });
  });

  it("adds a URL as it was typed, of the kind picked", () => {
    expect(
      addBody({ from: "url", url: " https://mcp.example.com/mcp ", kind: "mcp" }, ORG),
    ).toEqual({ kind: "mcp", source: "https://mcp.example.com/mcp", accepts: "shared" });
  });
});

describe("adding an uploaded document", () => {
  it("sends the document's text with its kind", () => {
    expect(addBody({ from: "upload", kind: "openapi", document: "openapi: 3.1.0" }, ORG)).toEqual({
      kind: "openapi",
      document: "openapi: 3.1.0",
      accepts: "shared",
    });
  });

  it("refuses a document over the server's limit before sending it", () => {
    expect(documentProblem("openapi", 8 * 1024 * 1024)).toBeUndefined();
    expect(documentProblem("openapi", 8 * 1024 * 1024 + 1)).toBe(
      "The document is over 8 MiB, more than Commissary reads.",
    );
    expect(documentProblem("graphql", 4 * 1024 * 1024 + 1)).toBe(
      "The schema is over 4 MiB, more than Commissary reads.",
    );
  });
});

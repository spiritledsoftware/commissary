// A domain the toolkit catalog lacks, looked up at integrations.sh (#207): `detect` and `discover` answers become a
// service of the catalog's shape for one toolkit, their credential types mapped onto toolkit credentials; the domain
// and every source URL pass the outbound guard; integrations.sh's failures and rate limit are told apart.
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { CurrentOutboundPolicy, OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import {
  checkedDomain,
  lookupDomain,
  LookupError,
  type LookupVia,
} from "../../src/catalog/lookup.ts";
import detectNotion from "../fixtures/catalog/detect-notion.json";
import discoverAcme from "../fixtures/catalog/discover-acme.json";

/** integrations.sh answering every request with `answer`; the URLs asked are recorded. */
const integrationsSh = (answer: () => Response) => {
  const asked: Array<string> = [];

  const client = HttpClient.make((request, url) => {
    asked.push(url.toString());

    return Effect.succeed(HttpClientResponse.fromWeb(request, answer()));
  });

  return { asked, layer: Effect.provideService(HttpClient.HttpClient, client) };
};

/** `input` checked as a domain, then looked up (as the routes do). */
const lookedUp = (input: string, via: LookupVia) =>
  Effect.flatMap(checkedDomain(input), (domain) => lookupDomain(domain, via));

const POLICY = { ownHosts: ["app.commissary.example"], localDevelopment: false };

describe("lookupDomain", () => {
  it.effect("turns detect's MCP server into a source that signs in with OAuth", () =>
    Effect.gen(function* () {
      const upstream = integrationsSh(() => Response.json(detectNotion));
      const found = yield* lookedUp("MCP.Notion.com", "detect").pipe(upstream.layer);

      assert.deepStrictEqual(upstream.asked, ["https://integrations.sh/api/mcp.notion.com/detect"]);
      assert.deepStrictEqual(found, {
        via: "detect",
        service: {
          id: "notion",
          name: "mcp.notion.com",
          domain: "mcp.notion.com",
          categories: [],
          featured: false,
          kinds: ["mcp"],
          sources: [
            {
              id: "mcp",
              kind: "mcp",
              name: "MCP server",
              url: "https://mcp.notion.com/mcp",
              credentials: [{ kind: "oauth" }],
            },
          ],
        },
      });
    }),
  );

  it.effect(
    "maps discover's surfaces and credential types, leaving out what Commissary cannot build or the guard refuses",
    () =>
      Effect.gen(function* () {
        const upstream = integrationsSh(() => Response.json(discoverAcme));
        const found = yield* lookedUp("acme.example", "discover").pipe(upstream.layer);

        assert.deepStrictEqual(upstream.asked, [
          "https://integrations.sh/api/acme.example/discover",
        ]);
        expect(found.via).toBe("discover");
        expect(found.service.description).toBe("Acme makes anvils.");
        // The internal server's private address is refused; the specless API and the CLI have nothing to build from.
        expect(found.refused).toEqual(["https://10.0.0.5/mcp"]);

        expect(found.service.sources).toEqual([
          {
            id: "acme-rest",
            kind: "openapi",
            name: "Acme REST API",
            url: "https://acme.example/openapi.json",
            // Request signing needs code per service; two credentials together are not one credential.
            credentials: [
              { kind: "header", name: "X-Acme-Key" },
              { kind: "query", name: "api_key" },
              { kind: "bearer" },
            ],
          },
          {
            id: "acme-graphql",
            kind: "graphql",
            name: "Acme GraphQL API",
            url: "https://api.acme.example/graphql",
            credentials: [{ kind: "aws_sigv4" }],
          },
          {
            id: "acme-mcp",
            kind: "mcp",
            name: "Acme MCP server",
            url: "https://mcp.acme.example/mcp",
            credentials: [{ kind: "oauth" }],
          },
        ]);
      }),
  );

  it.effect(
    "refuses a domain the outbound guard refuses, or that is not a domain, without asking",
    () =>
      Effect.gen(function* () {
        const upstream = integrationsSh(() => Response.json(discoverAcme));

        for (const domain of ["10.0.0.5", "169.254.169.254", "app.commissary.example"]) {
          const refused = yield* lookedUp(domain, "discover").pipe(
            upstream.layer,
            Effect.provideService(CurrentOutboundPolicy, POLICY),
            Effect.flip,
          );

          assert.deepStrictEqual(
            refused,
            new LookupError({ reason: "refused", message: OUTBOUND_REFUSED_MESSAGE }),
          );
        }

        for (const domain of ["localhost", "not a domain", ""]) {
          const invalid = yield* lookedUp(domain, "detect").pipe(upstream.layer, Effect.flip);

          assert.strictEqual(invalid.reason, "invalid");
        }

        assert.deepStrictEqual(upstream.asked, []);
      }),
  );

  it.effect("tells integrations.sh's rate limit apart from its other failures", () =>
    Effect.gen(function* () {
      const limited = yield* lookedUp("acme.example", "discover").pipe(
        integrationsSh(() => new Response("slow down", { status: 429 })).layer,
        Effect.flip,
      );

      assert.strictEqual(limited.reason, "rate_limited");

      for (const answer of [
        () => new Response("oops", { status: 500 }),
        () => new Response("not json", { status: 200 }),
      ]) {
        const failed = yield* lookedUp("acme.example", "detect").pipe(
          integrationsSh(answer).layer,
          Effect.flip,
        );

        assert.strictEqual(failed.reason, "failed");
      }
    }),
  );
});

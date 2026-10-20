// The toolkit catalog's store and refresh (#207): the cron task and the panel's refresh fetch integrations.sh's index,
// trim it and keep it in KV, where every catalog request reads it; a refresh that fails in any way keeps the stored
// registry, and nothing stored (or a stored text that is not a registry) is the bundled snapshot's catalog.
import { env } from "cloudflare:workers";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutboundHttpClientLive } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { type Catalog, embeddedCatalog } from "../src/catalog/catalog.ts";
import { MIN_SOURCES } from "../src/catalog/integrations-sh.ts";
import { refreshToolkitCatalog } from "../src/catalog/refresh.ts";
import { CATALOG_CACHE_TTL_MS, currentCatalog } from "../src/catalog/store.ts";
import { CATALOG_KEYS, forgetCatalog, readRefreshStatus } from "../src/catalog/stored.ts";
import { deploymentKvOf } from "../src/kv.ts";
import { ToolsEnv } from "../src/env.ts";
import registry from "./fixtures/catalog/registry.json";
import { routeFakeServer, serveFakeServers } from "./support/fake-fetch.ts";

serveFakeServers();

const services = Layer.mergeAll(OutboundHttpClientLive, Layer.succeed(ToolsEnv, env));

const run = <A>(effect: Effect.Effect<A, never, ToolsEnv | Layer.Success<typeof services>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(services)));

/** The fixture's records and enough generated MCP servers to pass the minimum, as integrations.sh's index. */
const index = (extra: number = MIN_SOURCES): string =>
  JSON.stringify({
    ...registry,
    data: [
      ...registry.data,
      ...Array.from({ length: extra }, (_, n) => ({
        id: `generated/${n}`,
        kind: "mcp",
        slug: `generated-${n}`,
        name: `Generated ${n}`,
        domain: `generated${n}.dev`,
        feeds: ["discovered"],
        connectUrl: `https://mcp.generated${n}.dev/mcp`,
      })),
    ],
  });

/** Serves `answer` as integrations.sh, counting the requests. */
const serveIndex = (answer: () => Response) => {
  let requests = 0;

  routeFakeServer("https://integrations.sh", async (request) => {
    requests += 1;
    expect(new URL(request.url).pathname).toBe("/api.json");

    return answer();
  });

  return { requests: () => requests };
};

const stored = () => env.CACHE.get(CATALOG_KEYS.registry);

const status = () => readRefreshStatus(deploymentKvOf(env));

beforeEach(async () => {
  await env.CACHE.delete(CATALOG_KEYS.registry);
  await env.CACHE.delete(CATALOG_KEYS.status);
  await Effect.runPromise(forgetCatalog);
});

afterEach(async () => {
  await Effect.runPromise(forgetCatalog);
});

describe("the toolkit catalog's store", () => {
  it("is the bundled snapshot's catalog while nothing is stored", async () => {
    const catalog = await run(currentCatalog);

    expect(catalog.services.length).toBe(embeddedCatalog().services.length);
    expect(catalog.service("linear")).toBeDefined();
  });

  it("ignores a stored text that is not a registry", async () => {
    await env.CACHE.put(CATALOG_KEYS.registry, "{not json");
    const catalog = await run(currentCatalog);

    expect(catalog.services.length).toBe(embeddedCatalog().services.length);
  });

  effectIt.effect("looks at KV again once its catalog is a minute old", () =>
    Effect.gen(function* () {
      const generated = (catalog: Catalog) =>
        [0, 1, 2].filter((n) => catalog.service(`generated${n}`) !== undefined).length;

      yield* Effect.promise(() => env.CACHE.put(CATALOG_KEYS.registry, index(1)));
      expect(generated(yield* currentCatalog)).toBe(1);

      // Another isolate's refresh stores a new registry: this one serves what it has for a minute.
      yield* Effect.promise(() => env.CACHE.put(CATALOG_KEYS.registry, index(3)));
      yield* TestClock.adjust(CATALOG_CACHE_TTL_MS - 1);
      expect(generated(yield* currentCatalog)).toBe(1);

      yield* TestClock.adjust(1);
      expect(generated(yield* currentCatalog)).toBe(3);
    }).pipe(Effect.provideService(ToolsEnv, env)),
  );
});

describe("the toolkit catalog's refresh", () => {
  it("stores the trimmed index, which the catalog then reads", async () => {
    const server = serveIndex(() => Response.json(JSON.parse(index())));

    const outcome = await run(refreshToolkitCatalog("panel"));

    expect(outcome).toEqual({ status: "updated", sources: 10 + MIN_SOURCES });
    expect(server.requests()).toBe(1);
    expect(await status()).toEqual({
      attemptedAt: expect.any(Number),
      status: "updated",
      refreshedAt: expect.any(Number),
    });
    expect(JSON.parse((await stored()) ?? "{}").data).toHaveLength(10 + MIN_SOURCES);

    const catalog = await run(currentCatalog);

    expect(catalog.service("generated7")?.sources.map((source) => source.url)).toEqual([
      "https://mcp.generated7.dev/mcp",
    ]);
    // The registry's own services, merged with the bundled additions (their Google Discovery sources).
    expect(catalog.service("linear")?.name).toBe("Linear");
    expect(catalog.service("gmail")?.sources.some((source) => source.kind === "discovery")).toBe(
      true,
    );

    // The same document again changes nothing.
    expect(await run(refreshToolkitCatalog("cron"))).toEqual({
      status: "unchanged",
      sources: 10 + MIN_SOURCES,
    });
  });

  it.each([
    ["an error status", () => new Response("down", { status: 500 }), "HTTP 500"],
    ["a document that is not the index", () => Response.json({ hello: "world" }), "not"],
    ["too few sources", () => Response.json(JSON.parse(index(5))), `fewer than ${MIN_SOURCES}`],
  ])("keeps the stored registry on %s", async (_, answer, message) => {
    serveIndex(() => Response.json(JSON.parse(index())));
    await run(refreshToolkitCatalog("cron"));
    const before = await stored();

    serveIndex(answer);
    const outcome = await run(refreshToolkitCatalog("cron"));

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain(message);
    expect(await stored()).toBe(before);

    // The attempt is recorded, with when the stored registry was last confirmed current.
    const recorded = await status();

    expect(recorded).toMatchObject({ status: "failed", message: outcome.message });
    expect(recorded?.refreshedAt).toBeLessThanOrEqual(recorded?.attemptedAt ?? 0);
    await Effect.runPromise(forgetCatalog);
    expect((await run(currentCatalog)).service("generated7")).toBeDefined();
  });

  it("fetches nothing while another refresh holds the lease", async () => {
    const server = serveIndex(() => Response.json(JSON.parse(index())));
    const taken = await platformOf(env).takeLease("toolkit_catalog_refresh", "cron");

    try {
      const outcome = await run(refreshToolkitCatalog("panel"));

      expect(outcome.status).toBe("running");
      expect(outcome.message).toContain("the scheduled refresh");
      expect(server.requests()).toBe(0);
      expect(await stored()).toBeNull();
      expect(await status()).toBeUndefined();
    } finally {
      if (taken.ok) await platformOf(env).releaseLease(taken.lease.token);
    }
  });
});

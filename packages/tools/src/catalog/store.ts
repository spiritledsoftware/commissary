/**
 * The toolkit catalog as a Worker sees it (#207): integrations.sh's trimmed registry the cron task refreshed into KV
 * (`stored.ts`), falling back to the bundled snapshot, merged with the bundled toolkit catalog additions (`catalog.ts`).
 *
 * The catalog is built once per isolate from the stored text and looked at again in KV once a minute; a refresh in the
 * same isolate drops it (`forgetCatalog`). A KV read that fails keeps what the isolate has (the snapshot's
 * catalog at first), and a stored text that does not read as a registry is ignored for the snapshot: a catalog request
 * never fails and never fetches.
 */
import { Clock, Effect, Result } from "effect";
import type { ToolsEnv } from "../env.ts";
import { bundledAdditions } from "./additions.ts";
import { buildCatalog, type Catalog, embeddedCatalog } from "./catalog.ts";
import { registryFromText } from "./integrations-sh.ts";
import { catalogGeneration, storedRegistry } from "./stored.ts";

/** How long an isolate serves its catalog before looking at KV again. */
export const CATALOG_CACHE_TTL_MS = 60_000;

interface Cached {
  readonly loadedAt: number;
  /** The isolate's {@link catalogGeneration} when it was loaded: a refresh since moved it on. */
  readonly generation: number;
  /** The KV text the catalog was built from (`null`: nothing stored, the snapshot's). */
  readonly text: string | null;
  readonly catalog: Catalog;
}

let cached: Cached | undefined;

/** The catalog of a stored text: nothing stored, or a text that is not a registry, is the snapshot's. */
const catalogOf = (text: string | null): Effect.Effect<Catalog> => {
  if (text === null) return Effect.succeed(embeddedCatalog());
  const registry = registryFromText(text);

  if (registry.ok) return Effect.succeed(buildCatalog(registry.value, bundledAdditions()));

  return Effect.logWarning(
    `stored toolkit catalog rejected, using the bundled one: ${registry.error}`,
  ).pipe(Effect.as(embeddedCatalog()));
};

/** The toolkit catalog now. Never fails: a KV failure keeps the isolate's catalog (the snapshot's at first). */
export const currentCatalog: Effect.Effect<Catalog, never, ToolsEnv> = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const generation = catalogGeneration();
  const held = cached;

  if (
    held !== undefined &&
    held.generation === generation &&
    now - held.loadedAt < CATALOG_CACHE_TTL_MS
  )
    return held.catalog;
  const text = yield* Effect.result(storedRegistry);

  if (Result.isFailure(text)) {
    yield* Effect.logWarning(
      "toolkit catalog: KV unavailable, keeping the catalog this isolate has",
    );
    const catalog = held?.catalog ?? embeddedCatalog();

    cached = { loadedAt: now, generation, text: held?.text ?? null, catalog };

    return catalog;
  }

  const catalog =
    held !== undefined && held.text === text.success
      ? held.catalog
      : yield* catalogOf(text.success);

  cached = { loadedAt: now, generation, text: text.success, catalog };

  return catalog;
});

/**
 * Catalogs as the Worker sees them: the models.dev document refreshed into KV by the cron job, falling back to the
 * bundled snapshot, merged with the bundled catalog additions (`catalog.ts`).
 *
 * The KV entry holds the trimmed models.dev document only (`refresh.ts` writes it, `models-dev.ts` defines it).
 * Everything derived from it (the provider catalogs, the OpenCode gateways' models) is built per isolate when the
 * stored text changes.
 */
import { Clock, Context, Effect, Layer, Ref, Result, Schema } from "effect";
import {
  catalogsFromModelsDev,
  embeddedCatalogs,
  type ModelCatalogs,
  modelsDevFromText,
} from "./catalog.ts";
import { type DeploymentKv, deploymentKey } from "@commissary/core";
import { ModelsEnv } from "../env.ts";
import { deploymentKvOf } from "../kv.ts";

/** KV key of the refreshed models.dev document (trimmed JSON text) and of the last refresh report. */
export const CATALOG_KEYS = {
  modelsDev: deploymentKey("registry/models-dev.json"),
  status: deploymentKey("registry/refresh-status.json"),
} as const;

/** What the last refresh attempt left in KV (`CATALOG_KEYS.status`), for the panel. */
export interface RefreshStatusRecord {
  /** ms. */
  readonly attemptedAt: number;
  readonly status: "updated" | "unchanged" | "failed";
  readonly message?: string;
  /** ms the stored catalog was last confirmed current; absent while the shipped copy is in use. */
  readonly refreshedAt?: number;
}

const StatusDocument = Schema.Struct({
  attempted_at: Schema.Finite,
  status: Schema.Literals(["updated", "unchanged", "failed"]),
  message: Schema.optionalKey(Schema.String),
  refreshed_at: Schema.optionalKey(Schema.Finite),
});

const decodeStatus = Schema.decodeUnknownResult(Schema.fromJsonString(StatusDocument));

/** The stored status record; `undefined` when absent or unreadable. */
export const readRefreshStatus = async (
  kv: DeploymentKv,
): Promise<RefreshStatusRecord | undefined> => {
  const text = await kv.get(CATALOG_KEYS.status);

  if (text === null) return undefined;
  const decoded = decodeStatus(text);

  if (Result.isFailure(decoded)) return undefined;
  const { attempted_at: attemptedAt, status, message, refreshed_at: refreshedAt } = decoded.success;

  return {
    attemptedAt,
    status,
    ...(message === undefined ? {} : { message }),
    ...(refreshedAt === undefined ? {} : { refreshedAt }),
  };
};

export const writeRefreshStatus = (kv: DeploymentKv, record: RefreshStatusRecord): Promise<void> =>
  kv.put(
    CATALOG_KEYS.status,
    JSON.stringify({
      attempted_at: record.attemptedAt,
      status: record.status,
      ...(record.message === undefined ? {} : { message: record.message }),
      ...(record.refreshedAt === undefined ? {} : { refreshed_at: record.refreshedAt }),
    }),
  );

/** How long an isolate serves its parsed catalogs before looking at KV again. */
export const CATALOG_CACHE_TTL_MS = 60_000;

export interface CatalogsFromText {
  readonly catalogs: ModelCatalogs;
  /** Why a stored text was not used (the bundled catalogs were used instead). */
  readonly warning?: string;
}

/** The catalogs of a stored models.dev text; nothing stored or an invalid text yields the bundled catalogs. */
export const catalogsFromText = (text: string | null | undefined): CatalogsFromText => {
  if (text === undefined || text === null) return { catalogs: embeddedCatalogs() };
  const parsed = modelsDevFromText(text);

  if (parsed.ok) return { catalogs: catalogsFromModelsDev(parsed.value) };

  return {
    catalogs: embeddedCatalogs(),
    warning: `stored models.dev catalog rejected, using the bundled one: ${parsed.error}`,
  };
};

interface Cached {
  readonly loadedAt: number;
  /** KV text the catalogs were built from (`null` = nothing stored). */
  readonly text: string | null;
  readonly catalogs: ModelCatalogs;
}

export class CatalogStore extends Context.Service<
  CatalogStore,
  {
    /**
     * The active catalogs (cached per isolate, re-read from KV every minute). Never fails: KV errors keep the last
     * value. `embed` (`models.catalog` is `embed`) ignores the stored copy: the catalogs compiled into the Worker.
     */
    readonly load: (embed: boolean) => Effect.Effect<ModelCatalogs, never, ModelsEnv>;
    /** Raw stored models.dev text (for the refresh job, which compares against and replaces it). */
    readonly stored: Effect.Effect<string | null, Error, ModelsEnv>;
    /** Drops the isolate cache (after a refresh wrote a new text). */
    readonly invalidate: Effect.Effect<void>;
  }
>()("commissary/registry/CatalogStore") {
  static readonly layer = Layer.effect(
    CatalogStore,
    Effect.gen(function* () {
      const cache = yield* Ref.make<Cached | undefined>(undefined);

      const stored = Effect.gen(function* () {
        const env = yield* ModelsEnv;

        return yield* Effect.tryPromise({
          try: () => deploymentKvOf(env).get(CATALOG_KEYS.modelsDev),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("failed to read the catalog from KV"),
        });
      });

      const load = Effect.fnUntraced(function* (embed: boolean) {
        if (embed) return embeddedCatalogs();
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(cache);

        if (cached !== undefined && now - cached.loadedAt < CATALOG_CACHE_TTL_MS)
          return cached.catalogs;
        const text = yield* stored.pipe(Effect.result);

        if (Result.isFailure(text)) {
          yield* Effect.logWarning(
            `catalog KV read failed, keeping the previous catalogs: ${text.failure.message}`,
          );
          const fallback = cached?.catalogs ?? embeddedCatalogs();
          yield* Ref.set(cache, { loadedAt: now, text: cached?.text ?? null, catalogs: fallback });

          return fallback;
        }

        if (cached !== undefined && cached.text === text.success) {
          yield* Ref.set(cache, { ...cached, loadedAt: now });

          return cached.catalogs;
        }

        const built = catalogsFromText(text.success);

        if (built.warning !== undefined) yield* Effect.logWarning(built.warning);
        yield* Ref.set(cache, { loadedAt: now, text: text.success, catalogs: built.catalogs });

        return built.catalogs;
      });

      return CatalogStore.of({ load, stored, invalidate: Ref.set(cache, undefined) });
    }),
  );
}

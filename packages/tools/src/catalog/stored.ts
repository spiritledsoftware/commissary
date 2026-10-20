/**
 * What the toolkit catalog keeps in KV `CACHE` (#207), through a `DeploymentKv` (the catalog is the deployment's, the
 * same for every org): the refreshed registry ({@link CATALOG_KEYS}`.registry`, the trimmed index as JSON text) and
 * what the last refresh attempt left (`.status`, for the panel). The cron refresh (`refresh.ts`) writes them and the
 * catalog (`store.ts`) reads them.
 *
 * Kept apart from `store.ts` so the refresh, which the API Worker runs, imports neither the bundled snapshot nor the
 * catalog built from it: a refresh tells the isolate's catalog to rebuild by moving {@link catalogGeneration} on
 * ({@link forgetCatalog}).
 */
import { Effect, Result, Schema } from "effect";
import { type DeploymentKv, deploymentKey } from "@commissary/core";
import { ToolsEnv } from "../env.ts";
import { deploymentKvOf } from "../kv.ts";

export const CATALOG_KEYS = {
  registry: deploymentKey("toolkit-catalog/integrations-sh.json"),
  status: deploymentKey("toolkit-catalog/refresh-status.json"),
} as const;

let generation = 0;

/** Moves on each time a refresh stores a new registry in this isolate: a catalog built before it is stale. */
export const catalogGeneration = (): number => generation;

/** Drops the isolate's catalog: the next read builds it from KV again (after a refresh stored a new registry). */
export const forgetCatalog: Effect.Effect<void> = Effect.sync(() => {
  generation += 1;
});

/** The stored registry text; `null` when nothing is stored. Fails when KV cannot be read. */
export const storedRegistry: Effect.Effect<string | null, Error, ToolsEnv> = Effect.gen(
  function* () {
    const env = yield* ToolsEnv;

    return yield* Effect.tryPromise(() => deploymentKvOf(env).get(CATALOG_KEYS.registry));
  },
);

/** What the last refresh attempt left in KV, for the panel. */
export interface RefreshStatusRecord {
  /** ms. */
  readonly attemptedAt: number;
  readonly status: "updated" | "unchanged" | "failed";
  /** Why it failed: a fixed text, never a URL or an upstream body. */
  readonly message?: string;
  /** ms the stored registry was last confirmed current; absent while the bundled snapshot is in use. */
  readonly refreshedAt?: number;
}

const StatusJson = Schema.Struct({
  attempted_at: Schema.Finite,
  status: Schema.Literals(["updated", "unchanged", "failed"]),
  message: Schema.optionalKey(Schema.String),
  refreshed_at: Schema.optionalKey(Schema.Finite),
});

const decodeStatus = Schema.decodeUnknownResult(Schema.fromJsonString(StatusJson));

/** The last refresh attempt's record; undefined when there is none, or it does not read. */
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

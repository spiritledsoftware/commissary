/**
 * What the panel shows about the model catalog (`GET /v9/management/models/catalog`, @commissary/contract/catalog): the
 * `models.catalog` mode, whether a refreshed copy from KV or the copy shipped with the Worker is in use, when the
 * stored copy was last confirmed current, the latest refresh attempt and the model counts of the catalog in use.
 */
import { Effect } from "effect";
import type { CatalogMode, CatalogStatus } from "@commissary/contract/catalog";
import { embeddedModelsDev, modelsDevFromText } from "./catalog.ts";
import { deploymentKvOf } from "../kv.ts";
import { CATALOG_KEYS, readRefreshStatus } from "./catalog-store.ts";
import type { ModelsDevCatalog } from "./models-dev.ts";
import { resolveSource } from "./catalog-source.ts";
import { ModelsEnv } from "../env.ts";

export interface CatalogModeInfo {
  readonly mode: CatalogMode;
  readonly host?: string;
  /** Why the setting is not usable (an address that is not http(s)): the mode reads `disabled`, the panel says why. */
  readonly problem?: string;
}

/** The panel's name for a `models.catalog` value, and the host of a custom source. */
export const catalogMode = (configured: string): CatalogModeInfo => {
  const source = resolveSource(configured);

  if (source.mode === "embed") return { mode: "embed" };

  if (source.mode === "disabled")
    return source.reason === undefined
      ? { mode: "disabled" }
      : { mode: "disabled", problem: `models.catalog ${source.reason}` };

  if (configured.trim() === "") return { mode: "official" };

  return { mode: "custom", host: new URL(source.url).host };
};

const counts = (doc: ModelsDevCatalog): Record<string, number> =>
  Object.fromEntries(
    Object.values(doc).map((provider) => [provider.id, Object.keys(provider.models).length]),
  );

const iso = (ms: number): string => new Date(ms).toISOString();

/** Reads KV directly (no isolate cache): a refresh shows on the next read. A KV failure reads as nothing stored. */
export const catalogStatus = (configured: string): Effect.Effect<CatalogStatus, never, ModelsEnv> =>
  Effect.gen(function* () {
    const env = yield* ModelsEnv;
    const { mode, host, problem } = catalogMode(configured);

    const text = yield* Effect.tryPromise(() =>
      deploymentKvOf(env).get(CATALOG_KEYS.modelsDev),
    ).pipe(Effect.orElseSucceed(() => null));

    // `embed` ignores the stored copy: what is served is the shipped one, whatever KV still holds.
    const parsed = text === null || mode === "embed" ? undefined : modelsDevFromText(text);
    const stored = parsed?.ok === true;

    const status = yield* Effect.tryPromise(() => readRefreshStatus(deploymentKvOf(env))).pipe(
      Effect.orElseSucceed(() => undefined),
    );

    return {
      mode,
      ...(host === undefined ? {} : { source_host: host }),
      ...(problem === undefined ? {} : { source_problem: problem }),
      stored,
      ...(stored && status?.refreshedAt !== undefined
        ? { refreshed_at: iso(status.refreshedAt) }
        : {}),
      ...(status === undefined
        ? {}
        : {
            last_attempt: {
              at: iso(status.attemptedAt),
              status: status.status,
              ...(status.message === undefined ? {} : { message: status.message }),
            },
          }),
      models: counts(parsed?.ok === true ? parsed.value : embeddedModelsDev()),
    };
  });

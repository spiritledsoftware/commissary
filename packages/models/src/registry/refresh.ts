/**
 * Cron refresh of the model catalog (ADR 0020): fetches the models.dev document (`https://models.dev/api.json`), trims
 * it to the providers Commissary reads (`models-dev.ts`) and stores the trimmed JSON in KV `CACHE`
 * (`CATALOG_KEYS.modelsDev`), where the registry (`CatalogStore`) and the OpenCode executor
 * (`currentOpenCodeCatalog`) read it. It is the one scheduled task that keeps every provider's models current; the
 * catalog additions are bundled data and never fetched.
 *
 * `models.catalog` in the configuration overrides the source: empty = the official URL, `embed` = delete the stored
 * copy and serve the bundled snapshot, `disabled` = no refresh, otherwise one http(s) URL.
 *
 * Bounded: one fetch per cron run (every 3 hours), a 30 s timeout and a 16 MiB size limit (the document is ≈5.4 MB),
 * enforced on the declared `content-length` and while the body streams in (the read is cancelled once it passes the
 * limit, so no more than the limit plus one chunk is held). A failed fetch, an oversized or an invalid document (a
 * provider missing or without models) keeps the stored catalog; the request path never fetches. See
 * docs/ARCHITECTURE.md "Model catalog".
 */
import { Clock, Data, Effect, Result, Stream } from "effect";
import type { HttpClientResponse } from "effect/http";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ConfigReader } from "../config/reader.ts";
import { holdInvocation, CurrentOrg, GLOBAL_ORG, outboundRefusalOf } from "@commissary/core";
import { type NamedLease, platformOf, type StateBindings, StateEnv } from "@commissary/state";
import {
  catalogsFromModelsDev,
  embeddedCatalogs,
  type ModelCatalogs,
  modelsDevFromText,
} from "./catalog.ts";
import { resolveSource } from "./catalog-source.ts";
import { resetOpenCodeCatalogCache } from "./opencode-catalog.ts";
import {
  CATALOG_KEYS,
  CatalogStore,
  readRefreshStatus,
  writeRefreshStatus,
} from "./catalog-store.ts";
import { type ModelsDevCatalog, trimModelsDev } from "./models-dev.ts";
import { ModelsEnv } from "../env.ts";

/** The three-hourly cron trigger (`CRONS` in alchemy.run.ts) runs this refresh. */
export const MODELS_REFRESH_INTERVAL_HOURS = 3;

export { MODELS_DEV_URL, resolveSource } from "./catalog-source.ts";

/** Largest document accepted (the full models.dev document is ≈5.4 MB). */
export const MAX_CATALOG_BYTES = 16 << 20;

const TIMEOUT = "30 seconds";

export interface RefreshOutcome {
  /** `skipped`: the source setting is `disabled`; `running`: another refresh holds the lease, nothing was fetched. */
  readonly status: "updated" | "unchanged" | "failed" | "skipped" | "running";
  readonly message?: string;
  /** URL the stored catalog came from. */
  readonly source?: string;
  /** Model counts of the stored catalog by models.dev provider. */
  readonly models?: Readonly<Record<string, number>>;
  /** Models clients can call that appeared / disappeared (see {@link modelChanges}; `updated` only). */
  readonly added?: number;
  readonly removed?: number;
  /** Entries of the document that did not decode and were left out (only when there were any). */
  readonly skipped?: number;
}

/** Who asked for the refresh: the cron task or the panel's "Refresh catalog". */
export type RefreshTrigger = "cron" | "panel";

class RefreshFailure extends Data.TaggedError("CatalogRefreshFailure")<{
  readonly message: string;
}> {}

const failed = (message: string): RefreshOutcome => ({ status: "failed", message });

/** The response body as text, failing (and cancelling the read) as soon as it passes `maxBytes`. */
export const boundedResponseText = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
): Effect.Effect<string, RefreshFailure> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    let read = 0;
    let text = "";

    yield* response.stream.pipe(
      Stream.mapError(() => new RefreshFailure({ message: "catalog fetch failed" })),
      Stream.runForEach((chunk) => {
        read += chunk.byteLength;

        if (read > maxBytes)
          return Effect.fail(new RefreshFailure({ message: "catalog is too large" }));
        text += decoder.decode(chunk, { stream: true });

        return Effect.void;
      }),
    );

    return text + decoder.decode();
  });

const fetchText = (
  client: HttpClient.HttpClient,
  url: string,
): Effect.Effect<Result.Result<string, RefreshFailure>> =>
  client
    .execute(
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ accept: "application/json" })),
    )
    .pipe(
      // The catalog source is user-supplied: the outbound guard's refusal (ADR 0044) is shown as it is.
      Effect.mapError(
        (error) =>
          new RefreshFailure({
            message: outboundRefusalOf(error)?.message ?? "catalog fetch failed",
          }),
      ),
      Effect.flatMap((response): Effect.Effect<string, RefreshFailure> => {
        if (response.status !== 200)
          return Effect.fail(
            new RefreshFailure({ message: `catalog source answered HTTP ${response.status}` }),
          );
        const length = Number(response.headers["content-length"] ?? "0");

        if (length > MAX_CATALOG_BYTES)
          return Effect.fail(
            new RefreshFailure({ message: `catalog is too large (${length} bytes)` }),
          );

        return boundedResponseText(response, MAX_CATALOG_BYTES);
      }),
      Effect.timeoutOrElse({
        duration: TIMEOUT,
        orElse: () => Effect.fail(new RefreshFailure({ message: "catalog fetch timed out" })),
      }),
      Effect.result,
    );

/** Fixed failure texts only: a message reaches the panel, so it never carries a URL or an upstream body. */
const MAX_MESSAGE = 200;

const clip = (message: string): string =>
  message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;

const counts = (doc: ModelsDevCatalog): Readonly<Record<string, number>> =>
  Object.fromEntries(
    Object.values(doc).map((provider) => [provider.id, Object.keys(provider.models).length]),
  );

export interface ModelChanges {
  readonly added: number;
  readonly removed: number;
  /** The removed ones, as `provider/id`. */
  readonly removedIds: ReadonlyArray<string>;
}

/** Provider of a catalog section: the Codex plans are one provider. */
const providerOf = (section: string): string => (section.startsWith("codex-") ? "codex" : section);

/** The models a catalog serves, as `provider/id` (a model in several Codex plans counts once). */
const servedIds = (catalogs: ModelCatalogs): ReadonlySet<string> =>
  new Set(
    Object.entries(catalogs.models).flatMap(([section, models]) =>
      models.map((model) => `${providerOf(section)}/${model.id}`),
    ),
  );

/** The models clients can call that appeared and disappeared between two catalogs, not the ids of the raw document. */
export const modelChanges = (previous: ModelCatalogs, next: ModelCatalogs): ModelChanges => {
  const before = servedIds(previous);
  const after = servedIds(next);
  const removedIds = [...before].filter((id) => !after.has(id)).toSorted();

  return {
    added: [...after].filter((id) => !before.has(id)).length,
    removed: removedIds.length,
    removedIds,
  };
};

/**
 * The download-validate-trim-store step, without the lease. `configured` is the `models.catalog` value. Never fails:
 * every problem is part of the outcome, and the stored catalog stays in place.
 */
const refreshNow = (
  configured: string,
): Effect.Effect<RefreshOutcome, never, HttpClient.HttpClient | ModelsEnv | CatalogStore> =>
  Effect.gen(function* (): Effect.fn.Return<
    RefreshOutcome,
    never,
    HttpClient.HttpClient | ModelsEnv | CatalogStore
  > {
    const env = yield* ModelsEnv;
    const store = yield* CatalogStore;
    const client = yield* HttpClient.HttpClient;
    const source = resolveSource(configured);

    if (source.mode === "disabled")
      return {
        status: "skipped",
        ...(source.reason === undefined ? {} : { message: `models.catalog ${source.reason}` }),
      };

    const previous = yield* store.stored.pipe(Effect.orElseSucceed(() => null));

    if (source.mode === "embed") {
      if (previous === null) return { status: "unchanged" };

      const deleted = yield* Effect.tryPromise(() => env.CACHE.delete(CATALOG_KEYS.modelsDev)).pipe(
        Effect.result,
      );

      if (Result.isFailure(deleted)) return failed("removing the stored catalog failed");
      yield* store.invalidate;
      resetOpenCodeCatalogCache();

      return { status: "updated", message: "reverted to the bundled catalog" };
    }

    const text = yield* fetchText(client, source.url);

    if (Result.isFailure(text)) return failed(text.failure.message);
    const trimmed = trimModelsDev(text.success);

    if (!trimmed.ok) return failed(clip(trimmed.error));
    const next = JSON.stringify(trimmed.value);
    const models = counts(trimmed.value);
    const { skipped } = trimmed;
    const skippedPart = skipped > 0 ? { skipped } : {};

    if (skipped > 0)
      yield* Effect.logWarning(
        `model catalog: ${skipped} malformed entries in the document were left out`,
      );

    if (previous === next)
      return { status: "unchanged", source: source.url, models, ...skippedPart };

    const stored = yield* Effect.tryPromise(() => env.CACHE.put(CATALOG_KEYS.modelsDev, next)).pipe(
      Effect.result,
    );

    if (Result.isFailure(stored)) return failed("storing the catalog failed");
    yield* store.invalidate;
    resetOpenCodeCatalogCache();

    const before = previous === null ? undefined : modelsDevFromText(previous);

    const changes = modelChanges(
      before?.ok === true ? catalogsFromModelsDev(before.value) : embeddedCatalogs(),
      catalogsFromModelsDev(trimmed.value),
    );

    if (changes.removed > 0)
      yield* Effect.logWarning(
        `model catalog: ${changes.removed} served models are gone from the document: ${changes.removedIds.slice(0, 50).join(", ")}`,
      );

    return {
      status: "updated",
      source: source.url,
      models,
      added: changes.added,
      removed: changes.removed,
      ...skippedPart,
    };
  });

/**
 * The model catalog is shared by every org, so its refresh lease is deployment-wide: it lives in the Platform registry
 * (it was in the `global` org's ControlPlane before the registry existed, which no other org should have to reach).
 */
const catalogLeaseHolder = (env: StateBindings) => platformOf(env);

/** The Platform registry's lease (`@commissary/state` `lease.ts`) of the catalog refresh: `catalog_refresh_lease`. */
const CATALOG_REFRESH_LEASE = "catalog_refresh";

type Taken =
  | { readonly kind: "taken"; readonly token: string }
  | { readonly kind: "held"; readonly held: NamedLease }
  | { readonly kind: "unavailable" };

const takeLease = (trigger: RefreshTrigger): Effect.Effect<Taken, never, StateEnv> =>
  Effect.gen(function* () {
    const env = yield* StateEnv;

    return yield* Effect.tryPromise(async (): Promise<Taken> => {
      const taken = await catalogLeaseHolder(env).takeLease(CATALOG_REFRESH_LEASE, trigger);

      return taken.ok
        ? { kind: "taken", token: taken.lease.token }
        : { kind: "held", held: taken.held };
    }).pipe(Effect.orElseSucceed((): Taken => ({ kind: "unavailable" })));
  });

const releaseLease = (token: string): Effect.Effect<void, never, StateEnv> =>
  Effect.gen(function* () {
    const env = yield* StateEnv;

    yield* Effect.tryPromise(() => catalogLeaseHolder(env).releaseLease(token)).pipe(Effect.ignore);
  });

const record = (outcome: RefreshOutcome): Effect.Effect<void, never, ModelsEnv> =>
  Effect.gen(function* () {
    const env = yield* ModelsEnv;
    const now = yield* Clock.currentTimeMillis;

    if (outcome.status === "failed")
      yield* Effect.logWarning(
        `model catalog refresh failed, keeping the stored catalog: ${outcome.message ?? ""}`,
      );
    else yield* Effect.logInfo(`model catalog: ${outcome.status}`);

    const { status } = outcome;

    if (status === "skipped" || status === "running") return;

    const previous = yield* Effect.tryPromise(() => readRefreshStatus(env.CACHE)).pipe(
      Effect.orElseSucceed(() => undefined),
    );

    const succeeded = status === "updated" || status === "unchanged";
    // Reverting to the shipped copy leaves nothing stored that could have been refreshed.
    const reverted = status === "updated" && outcome.source === undefined;

    const refreshedAt = reverted ? undefined : succeeded ? now : previous?.refreshedAt;

    yield* Effect.tryPromise(() =>
      writeRefreshStatus(env.CACHE, {
        attemptedAt: now,
        status,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
        ...(refreshedAt === undefined ? {} : { refreshedAt }),
      }),
    ).pipe(Effect.ignore);
  });

/**
 * One refresh under the refresh lease (Platform registry, `catalog_refresh`): cron and the panel never download at
 * once, whichever isolates they run in. The second one gets `status: "running"` without any request being made. A
 * Platform registry that cannot be reached fails the refresh (exclusivity cannot be shown); the stored catalog stays.
 * `disabled` and `embed` do not fetch and need no lease. The invocation is held open until the lease is given back
 * (`holdInvocation`), so a request the client abandoned still releases it; a lease never released expires.
 */
export const refreshModelsDev = (
  configured: string,
  trigger: RefreshTrigger,
): Effect.Effect<
  RefreshOutcome,
  never,
  HttpClient.HttpClient | ModelsEnv | StateEnv | CatalogStore
> => {
  const source = resolveSource(configured);

  if (source.mode !== "fetch") return refreshNow(configured).pipe(Effect.tap(record));

  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const hold = yield* holdInvocation;
      const taken = yield* takeLease(trigger);

      return { hold, taken };
    }),
    ({
      taken,
    }): Effect.Effect<RefreshOutcome, never, HttpClient.HttpClient | ModelsEnv | CatalogStore> => {
      if (taken.kind === "unavailable")
        return Effect.succeed(failed("platform registry unavailable")).pipe(Effect.tap(record));

      if (taken.kind === "held") {
        const by = taken.held.source === "cron" ? "the scheduled refresh" : "the panel";

        return Effect.succeed({
          status: "running",
          message: `a refresh started by ${by} at ${new Date(taken.held.startedAt).toISOString()} is still running`,
        });
      }

      return refreshNow(configured).pipe(Effect.tap(record));
    },
    ({ hold, taken }) =>
      (taken.kind === "taken" ? releaseLease(taken.token) : Effect.void).pipe(
        Effect.ensuring(Effect.sync(hold)),
      ),
  );
};

/**
 * Cron task `model-catalog-refresh`: {@link refreshModelsDev} with the stored `models.catalog` setting. The catalog is
 * deployment-wide, so the setting is the `global` org's.
 */
export const refreshCatalogs: Effect.Effect<
  RefreshOutcome,
  never,
  HttpClient.HttpClient | ModelsEnv | StateEnv | ConfigReader | CatalogStore
> = Effect.gen(function* () {
  const configured = yield* ConfigReader.use((reader) => reader.get).pipe(
    Effect.provideService(CurrentOrg, GLOBAL_ORG),
    Effect.map((snapshot) => snapshot.config.models.catalog),
    Effect.catch((error) =>
      Effect.logWarning(
        `config unavailable for catalog refresh, using the default source: ${error.message}`,
      ).pipe(Effect.as("")),
    ),
  );

  return yield* refreshModelsDev(configured, "cron");
});

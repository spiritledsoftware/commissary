/**
 * `ModelRegistry` service: the registry as the pipeline and the listing routes see it.
 *
 * It combines three inputs: the model sources of all credentials (ControlPlane `listModelSources`), the config
 * (`ConfigReader`) and the catalogs (`CatalogStore`: KV copy refreshed by cron, embedded fallback), and exposes an
 * immutable `RegistrySnapshot` of the current org that is cached per isolate and org for a few seconds.
 *
 * Pipeline usage (slice #5): `snapshot.providersForModel(model)` is `util.GetProviderName`, and
 * `snapshot.lookupModelInfo` has the `ModelInfoLookup` shape the thinking pipeline expects
 * (`applyThinking({ lookupModelInfo })`).
 */
import { Clock, Context, Effect, Layer, Ref, Result, Schema } from "effect";
import { ConfigReader } from "../config/reader.ts";
import type { ConfigStoreError } from "../config/errors.ts";
import type { Config } from "../config/schema.ts";
import { CurrentOrg, type OrgId } from "@commissary/core";
import { ALLOW_ALL, type Reach, reachFromTable } from "../grants/reach.ts";
import type { GrantTable } from "../grants/grant.ts";
import { projectModel } from "./availability.ts";
import { assembleCredentialModels } from "./credential-models.ts";
import { type GrantFilter, grantFilter } from "./grant-filter.ts";
import { CatalogStore } from "./catalog-store.ts";
import { usesEmbeddedCatalog } from "./catalog-source.ts";
import { withAntigravityHints } from "../executor/antigravity/models.ts";
import type { ModelCatalogs } from "./catalog.ts";
import type { ModelInfo } from "./model-info.ts";
import { type ClientRegistration, ModelRegistryIndex } from "./registry.ts";
import type { ModelSource } from "./source.ts";
import { FULL_ACCESS } from "../credentials/ownership.ts";
import { ModelsEnv, currentModelsControlPlane } from "../env.ts";
import { orgKvOf } from "../kv.ts";

/** The ControlPlane could not provide the credential model sources. */
export class ModelRegistryError extends Schema.TaggedError<ModelRegistryError>()(
  "ModelRegistryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** How long an isolate reuses a built snapshot (credential or catalog edits show up within this time). */
export const SNAPSHOT_TTL_MS = 5_000;

export class RegistrySnapshot {
  constructor(
    readonly index: ModelRegistryIndex,
    readonly catalogs: ModelCatalogs,
    readonly config: Config,
    readonly now: number,
    /** The enriched credential model sources the index was built from (id order); `routingView` re-assembles them. */
    readonly sources: ReadonlyArray<ModelSource> = [],
    /** Version of `config` in the ControlPlane (0 = defaults, or unknown when built outside the service). */
    readonly configVersion: number = 0,
    /**
     * The org's grants and teams (ADR 0023) as of this snapshot; `visibleTo` computes each member's reach from them.
     * Absent only in a registry built without grants (tests): every member then reaches every model.
     */
    readonly grants?: GrantTable,
    /** Set on a member's view when their reach is restricted: the models it left out are not in `index`. */
    readonly grantFilter?: GrantFilter,
  ) {}

  /** `util.GetProviderName`: providers of an exact model id, retrying the lower-cased id. */
  providersForModel = (modelId: string): string[] => {
    if (modelId === "") return [];
    const exact = this.index.providersForModel(modelId);

    if (exact.length > 0 || modelId.toLowerCase() === modelId) return exact;

    return this.index.providersForModel(modelId.toLowerCase());
  };

  /** `registry.LookupModelInfo(modelID, provider)`: registry first, then the static catalogs. */
  lookupModelInfo = (modelId: string, provider: string): ModelInfo | undefined =>
    this.index.lookupModelInfo(this.catalogs, modelId, provider);

  /** `registry.ModelOverrideHeaders`: `config.override_header` of the catalog entry (forces upstream headers). */
  modelOverrideHeaders = (modelId: string, provider = ""): Record<string, string> | undefined => {
    const headers = this.lookupModelInfo(modelId, provider)?.config?.overrideHeader;
    const out: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers ?? {}))
      if (key.trim() !== "") out[key.trim()] = value;

    return Object.keys(out).length === 0 ? undefined : out;
  };

  /** `GetResponsesWebSearchCapability`: tri-state over every route serving the public model. */
  responsesWebSearchCapability = (modelId: string): boolean | undefined =>
    this.index.responsesWebSearchCapability(modelId);

  readonly #memberViews = new Map<string, RegistrySnapshot>();

  /**
   * The registry as one caller may use it: a private credential's models belong to its owner (ADR 0023), and a shared
   * credential's models to the members its grants name (ADR 0023), so every other caller, an org admin included, gets
   * the registry without them. The snapshot itself knows every model; `undefined` is a caller without a member, which
   * only the grants for everyone name. A view is built once per snapshot and member, and a snapshot is built from one
   * version of the grants, so a view is never older than its grants.
   */
  visibleTo = (memberId: string | undefined): RegistrySnapshot => {
    const reach: Reach =
      this.grants === undefined ? ALLOW_ALL : reachFromTable(this.grants, memberId);

    if (reach.unrestricted && !this.sources.some((source) => source.owner !== undefined))
      return this;
    const key = memberId ?? "";
    const cached = this.#memberViews.get(key);

    if (cached !== undefined) return cached;

    const view = buildSnapshot({
      sources: this.sources.filter(
        (source) => source.owner === undefined || source.owner === memberId,
      ),
      config: this.config,
      catalogs: this.catalogs,
      now: this.now,
      configVersion: this.configVersion,
      reach,
      ...(this.grants === undefined ? {} : { grants: this.grants }),
    });

    this.#memberViews.set(key, view);

    return view;
  };

  /** Models with at least one usable credential, sorted by id (`GetAvailableModelInfos`). */
  availableModels = (): ModelInfo[] => this.index.availableModels(this.now);

  /** `ResolveAutoModel`: the newest available model for `auto`. */
  firstAvailableModel = (): string | undefined => this.index.firstAvailableModel(this.now);

  /** The models one credential serves (prefix/alias/exclusion rules applied). */
  modelsForCredential = (credentialId: string): ModelInfo[] =>
    this.index.modelsForClient(credentialId);

  /** `ClientSupportsModel`. */
  credentialSupportsModel = (credentialId: string, modelId: string): boolean =>
    this.index.clientSupportsModel(credentialId, modelId);
}

/** Pure construction of a snapshot; credentials are registered in id order so "last registered wins" is stable. */
export const buildSnapshot = (input: {
  readonly sources: ReadonlyArray<ModelSource>;
  readonly config: Config;
  readonly catalogs: ModelCatalogs;
  readonly now: number;
  readonly configVersion?: number;
  /** The org's grants and teams; without them every member reaches every model. */
  readonly grants?: GrantTable;
  /** The reach a member's view is built under (`visibleTo`); unrestricted by default. */
  readonly reach?: Reach;
}): RegistrySnapshot => {
  const { config, catalogs, now } = input;
  const nowSeconds = Math.floor(now / 1000);
  const clients: ClientRegistration[] = [];
  const sources = input.sources.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const filter = grantFilter(input.reach ?? ALLOW_ALL, config, sources);

  for (const source of sources) {
    const assembled = assembleCredentialModels(source, {
      config,
      catalogs,
      nowSeconds,
      grants: filter,
    });

    if (assembled === undefined) continue;
    clients.push({
      id: source.id,
      provider: assembled.provider,
      models: assembled.models,
      projection: (model) => projectModel(source, model, now),
    });
  }

  return new RegistrySnapshot(
    new ModelRegistryIndex(clients, now),
    catalogs,
    config,
    now,
    sources,
    input.configVersion ?? 0,
    input.grants,
    filter,
  );
};

export class ModelRegistry extends Context.Service<
  ModelRegistry,
  {
    /** Current registry snapshot (cached for {@link SNAPSHOT_TTL_MS}). */
    readonly snapshot: Effect.Effect<
      RegistrySnapshot,
      ModelRegistryError | ConfigStoreError,
      ModelsEnv | CurrentOrg
    >;
    /**
     * A snapshot built right now from a freshly read config (the config reader's cache is dropped first), stored in
     * the cache. Unlike `snapshot` there is no stale fallback: a failure is reported. For admin views that must show an
     * edit made a moment ago.
     */
    readonly fresh: Effect.Effect<
      RegistrySnapshot,
      ModelRegistryError | ConfigStoreError,
      ModelsEnv | CurrentOrg
    >;
  }
>()("commissary/registry/ModelRegistry") {
  /** Needs `ConfigReader` and `CatalogStore`. */
  static readonly layer = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const configReader = yield* ConfigReader;
      const catalogStore = yield* CatalogStore;
      // Snapshots per org: each org has its own credentials and config.
      const cache = yield* Ref.make<ReadonlyMap<OrgId, RegistrySnapshot>>(new Map());

      const store = (org: OrgId, snapshot: RegistrySnapshot) =>
        Ref.update(cache, (all) => new Map(all).set(org, snapshot));

      const build = Effect.gen(function* () {
        const env = yield* ModelsEnv;
        const org = yield* CurrentOrg;
        const plane = yield* currentModelsControlPlane;

        const { config, version } = yield* configReader.get;

        const fromPlane = <A>(what: string, read: () => Promise<A>) =>
          Effect.tryPromise({
            try: read,
            catch: (cause) =>
              new ModelRegistryError({
                message: `failed to read ${what} from ControlPlane`,
                cause,
              }),
          });

        // The grants are read with the sources and never from an older read: a registry that could not read them is not
        // built (the previous snapshot serves), it is never built as if everyone had every model.
        const [catalogs, sources, grants] = yield* Effect.all(
          [
            catalogStore.load(usesEmbeddedCatalog(config.models.catalog)),
            fromPlane(
              "model sources",
              async () => await plane.models().listModelSources(FULL_ACCESS),
            ),
            fromPlane("grants", async () => await plane.models().grantTable()),
          ],
          { concurrency: "unbounded" },
        );

        const now = yield* Clock.currentTimeMillis;

        // Antigravity credentials serve the entitlements of their last `fetchAvailableModels` probe (KV).
        const enriched = yield* Effect.promise(() =>
          withAntigravityHints(orgKvOf(env, org), sources),
        );

        return buildSnapshot({
          sources: enriched,
          config,
          catalogs,
          now,
          configVersion: version,
          grants,
        });
      });

      const snapshot = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const org = yield* CurrentOrg;
        const cached = (yield* Ref.get(cache)).get(org);

        if (cached !== undefined && now - cached.now < SNAPSHOT_TTL_MS) return cached;
        const built = yield* build.pipe(Effect.result);

        if (Result.isSuccess(built)) {
          yield* store(org, built.success);

          return built.success;
        }

        // Stale-if-error, like the config reader: keep serving the previous registry while the DO is unreachable.
        if (cached !== undefined) {
          yield* Effect.logWarning(
            `model registry refresh failed, serving the previous snapshot: ${built.failure.message}`,
          );

          return cached;
        }

        return yield* built.failure;
      });

      const fresh = Effect.gen(function* () {
        yield* configReader.invalidate;
        const built = yield* build;
        yield* store(yield* CurrentOrg, built);

        return built;
      });

      return ModelRegistry.of({ snapshot, fresh });
    }),
  );
}

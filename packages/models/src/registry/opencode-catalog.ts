/**
 * The OpenCode gateways' view of the models.dev document: which models each gateway serves, which upstream protocol
 * each speaks, and their limits, modalities and reasoning support (ADR 0020: one document feeds every provider).
 *
 * OpenCode's own client picks a model's protocol from the catalog's AI SDK package (`provider.npm`, else the
 * provider's `npm`; sst/opencode `packages/core/src/aisdk-native.ts`) and so does Commissary. The document is bundled
 * (`catalog/models-dev.json`, `pnpm catalog:sync`) and refreshed into KV by the cron job (`refresh.ts`); readers use
 * the KV copy when it is valid, else the bundled one. Requests never fetch it. See docs/ARCHITECTURE.md "OpenCode Zen
 * and OpenCode Go".
 */
import { Clock, Effect, Option, type Types } from "effect";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import type { OpenCodeProtocol } from "../config/schema.ts";
import { OPENCODE_SPECS, type OpenCodeProvider } from "../executor/opencode/providers.ts";
import { embeddedModelsDev, modelsDevFromText } from "./catalog.ts";
import { usesEmbeddedCatalog } from "./catalog-source.ts";
import { deploymentKvOf } from "../kv.ts";
import { CATALOG_KEYS } from "./catalog-store.ts";
import { isDeprecatedModel, thinkingFromModelsDev } from "./catalog-build.ts";
import type { ModelInfo } from "./model-info.ts";
import type { ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from "./models-dev.ts";
import { ModelsEnv } from "../env.ts";

export type { ModelsDevModel as OpenCodeCatalogModel } from "./models-dev.ts";

/** The models.dev document the gateways read (`opencode` and `opencode-go` are the providers they use). */
export type OpenCodeCatalog = ModelsDevCatalog;

/** AI SDK package of providers and models that name none (models.dev default). */
export const DEFAULT_OPENCODE_NPM = "@ai-sdk/openai-compatible";

/** AI SDK package -> gateway protocol (sst/opencode `aisdk-native.ts`). */
const NPM_PROTOCOLS: ReadonlyMap<string, OpenCodeProtocol> = new Map([
  ["@ai-sdk/openai-compatible", "chat"],
  ["@ai-sdk/mistral", "chat"],
  ["@ai-sdk/openai", "responses"],
  ["@ai-sdk/anthropic", "messages"],
  ["@ai-sdk/google", "gemini"],
]);

export interface OpenCodeCatalogFromText {
  readonly catalog: OpenCodeCatalog;
  /** Why a stored text was not used (the bundled catalog was used instead). */
  readonly warning?: string;
}

/** The catalog of a stored KV text; nothing stored or an invalid text yields the bundled catalog. */
export const openCodeCatalogFromText = (
  text: string | null | undefined,
): OpenCodeCatalogFromText => {
  if (text === undefined || text === null) return { catalog: embeddedModelsDev() };
  const parsed = modelsDevFromText(text);

  if (parsed.ok) return { catalog: parsed.value };

  return {
    catalog: embeddedModelsDev(),
    warning: `stored models.dev catalog rejected, using the bundled one: ${parsed.error}`,
  };
};

// --- per-isolate KV copy (request path) -----------------------------------------------------------------------------

const LOCAL_CACHE_MS = 60_000;

let cached:
  | { readonly loadedAt: number; readonly text: string | null; readonly catalog: OpenCodeCatalog }
  | undefined;

/** Test hook: forgets the per-isolate copy. */
export const resetOpenCodeCatalogCache = (): void => {
  cached = undefined;
};

/**
 * The active catalog for request handling: the KV copy (re-read at most once a minute per isolate), else the bundled
 * one. Never fails; without Worker bindings (unit tests) it is the bundled catalog.
 */
export const currentOpenCodeCatalog: Effect.Effect<OpenCodeCatalog> = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;

  if (cached !== undefined && now - cached.loadedAt < LOCAL_CACHE_MS) return cached.catalog;
  const env = yield* Effect.serviceOption(ModelsEnv);

  if (Option.isNone(env)) return embeddedModelsDev();

  const stored = yield* Effect.tryPromise(() =>
    deploymentKvOf(env.value).get(CATALOG_KEYS.modelsDev),
  ).pipe(
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none<string | null>()),
  );

  // A failed read keeps the previous copy.
  if (Option.isNone(stored)) return cached?.catalog ?? embeddedModelsDev();

  if (cached !== undefined && cached.text === stored.value) {
    cached = { ...cached, loadedAt: now };

    return cached.catalog;
  }

  const built = openCodeCatalogFromText(stored.value);

  if (built.warning !== undefined) yield* Effect.logWarning(built.warning);
  cached = { loadedAt: now, text: stored.value, catalog: built.catalog };

  return built.catalog;
});

/** The catalog the gateways read under the `models.catalog` setting: `embed` ignores the stored copy. */
export const openCodeCatalogFor = (configured: string): Effect.Effect<OpenCodeCatalog> =>
  usesEmbeddedCatalog(configured) ? Effect.sync(embeddedModelsDev) : currentOpenCodeCatalog;

// --- lookups --------------------------------------------------------------------------------------------------------

/** The catalog section of a gateway. */
export const catalogProvider = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
): ModelsDevProvider => catalog[OPENCODE_SPECS[provider].catalogId];

/** A model of a gateway by id (exact, then case-insensitive). */
export const findCatalogModel = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
  modelId: string,
): ModelsDevModel | undefined => {
  const { models } = catalogProvider(catalog, provider);
  const id = modelId.trim();
  const exact = models[id];

  if (exact !== undefined) return exact;
  const lower = id.toLowerCase();

  return Object.values(models).find((model) => model.id.toLowerCase() === lower);
};

/** The model's AI SDK package: its own `provider.npm`, else the provider's, else the models.dev default. */
export const catalogModelNpm = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
  model: ModelsDevModel,
): string => model.provider?.npm ?? catalogProvider(catalog, provider).npm ?? DEFAULT_OPENCODE_NPM;

/**
 * The gateway protocol of an AI SDK package; `undefined` for an unknown package. `@ai-sdk/google` exists only on Zen;
 * a Go model naming it is unknown too.
 */
export const protocolForNpm = (
  npm: string,
  provider: OpenCodeProvider,
): OpenCodeProtocol | undefined => {
  const protocol = NPM_PROTOCOLS.get(npm.trim());

  return protocol === "gemini" && provider !== "opencode-zen" ? undefined : protocol;
};

/** OpenCode's free tier (both prices zero), flagged by the trim (`models-dev.ts`). */
export const isFreeModel = (model: ModelsDevModel): boolean => model.free === true;

/** The registry `type` of a protocol: the format family the thinking pipeline validates against. */
export const openCodeProtocolType = (protocol: OpenCodeProtocol | undefined): string => {
  switch (protocol) {
    case "messages":
      return "claude";
    case "gemini":
      return "gemini";
    case "systemone":
      return EntryOnlyFormats.SystemOne;
    default:
      return "openai";
  }
};

/** `ModelInfo` of a catalog model as the gateway `provider` serves it. */
export const catalogModelInfo = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
  model: ModelsDevModel,
): ModelInfo => {
  const protocol = protocolForNpm(catalogModelNpm(catalog, provider, model), provider);

  const info: Types.Mutable<ModelInfo> = {
    id: model.id,
    object: "model",
    created: 0,
    ownedBy: "opencode",
    type: openCodeProtocolType(protocol),
    displayName: model.name ?? model.id,
  };

  const context = model.limit?.context ?? 0;
  const output = model.limit?.output ?? 0;

  if (context > 0) info.contextLength = context;

  if (output > 0) info.maxCompletionTokens = output;
  const input = model.modalities?.input ?? [];

  if (input.length > 0) info.supportedInputModalities = [...input];
  const outputModalities = model.modalities?.output ?? [];

  if (outputModalities.length > 0) info.supportedOutputModalities = [...outputModalities];
  const thinking = thinkingFromModelsDev(model);

  if (thinking !== undefined) info.thinking = thinking;

  return info;
};

/**
 * The models a gateway registers when its config lists none: every catalog model that is not deprecated, minus the
 * free models where the gateway rejects them outside OpenCode's own client (Zen) unless the key cloaks them
 * (`includeFree`, ADR 0033), plus `additions`: the gateway's catalog additions (Zen's System One models, ADR 0032),
 * registered as they are whatever their price. An addition is authoritative for its id: a models.dev entry with the
 * same id (free or not) is left out.
 */
export const defaultCatalogModels = (
  catalog: OpenCodeCatalog,
  provider: OpenCodeProvider,
  additions: ReadonlyArray<ModelInfo> = [],
  includeFree = false,
): ModelInfo[] => {
  const added = new Set(additions.map((model) => model.id.toLowerCase()));

  return [
    ...Object.values(catalogProvider(catalog, provider).models)
      .filter(
        (model) =>
          !added.has(model.id.toLowerCase()) &&
          !isDeprecatedModel(model) &&
          !(OPENCODE_SPECS[provider].skipFreeModels && !includeFree && isFreeModel(model)),
      )
      .map((model) => catalogModelInfo(catalog, provider, model)),
    ...additions,
  ];
};

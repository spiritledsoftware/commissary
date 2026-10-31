/**
 * The model catalogs the registry reads: every provider's models built from the models.dev document and the catalog
 * additions (`catalog-build.ts`, ADR 0020), the Codex client catalog, and the OpenCode gateways' view of models.dev.
 *
 * Bundled copies live in `catalog/` (`models-dev.json` from `bun run catalog:sync`, `additions.json` and
 * `codex_client_models.json` maintained here); the cron job refreshes the models.dev document into KV
 * (`refresh.ts`, `catalog-store.ts`). The additions are never fetched: a refreshed document is merged with the bundled
 * additions. Static lookups (`lookupStaticModelInfo*`) read the same catalogs.
 */
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import additionsJson from "./catalog/additions.json";
import codexClientJson from "./catalog/codex_client_models.json";
import modelsDevJson from "./catalog/models-dev.json";
import { type CatalogAdditions, parseCatalogAdditions } from "./catalog-additions.ts";
import { buildModelsCatalog, type ModelsCatalog, SECTIONS, type Section } from "./catalog-build.ts";
import { cloneModelInfo, type ModelInfo } from "./model-info.ts";
import { type ModelsDevCatalog, trimModelsDev } from "./models-dev.ts";

export { SECTIONS };

export type { ModelsCatalog, Section };

export type CatalogResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Everything the registry reads from the catalogs. */
export interface ModelCatalogs {
  /** Every provider's models (models.dev merged with the catalog additions). */
  readonly models: ModelsCatalog;
  /** Codex client catalog (`codex_client_models.json`), validated JSON. Served by the Codex client listing. */
  readonly codexClient: Json;
  /** The models.dev document the models were built from; the OpenCode gateways read their models from it. */
  readonly modelsDev: ModelsDevCatalog;
}

// --- codex client catalog ------------------------------------------------------------------------------------------

const requiredString = (model: JsonObject, field: string): string => {
  const value = model[field];

  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`field "${field}" must be a non-empty string`);

  return value.trim();
};

const requiredInteger = (model: JsonObject, field: string, positive: boolean): number => {
  const value = model[field];

  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`field "${field}" must be an integer`);

  if (positive && value <= 0) throw new Error(`field "${field}" must be positive`);

  if (!positive && value < 0) throw new Error(`field "${field}" must not be negative`);

  return value;
};

const validateCodexClientModel = (model: JsonObject): void => {
  for (const field of [
    "display_name",
    "description",
    "base_instructions",
    "minimal_client_version",
    "visibility",
    "default_reasoning_level",
  ]) {
    requiredString(model, field);
  }

  const contextWindow = requiredInteger(model, "context_window", true);
  const maxContextWindow = requiredInteger(model, "max_context_window", true);

  if (contextWindow > maxContextWindow)
    throw new Error(
      `context_window ${contextWindow} exceeds max_context_window ${maxContextWindow}`,
    );
  requiredInteger(model, "priority", false);
  const levels = model.supported_reasoning_levels;

  if (!Array.isArray(levels) || levels.length === 0)
    throw new Error(`field "supported_reasoning_levels" must be a non-empty array`);
  const efforts = new Set<string>();

  for (const [index, level] of levels.entries()) {
    if (!isJsonObject(level))
      throw new Error(`field "supported_reasoning_levels" entry ${index} must be an object`);
    const effort = requiredString(level, "effort");

    if (efforts.has(effort))
      throw new Error(`field "supported_reasoning_levels" contains duplicate effort "${effort}"`);
    efforts.add(effort);
  }

  const defaultLevel = requiredString(model, "default_reasoning_level");

  if (!efforts.has(defaultLevel))
    throw new Error(
      `default_reasoning_level "${defaultLevel}" is not listed in supported_reasoning_levels`,
    );
};

/** `ValidateCodexClientModelsJSON`. */
export const validateCodexClientModels = (parsed: Json | undefined): CatalogResult<Json> => {
  try {
    if (!isJsonObject(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0)
      throw new Error("Codex client model catalog has no models");
    const models = parsed.models;
    const slugs = new Set<string>();

    for (const [index, model] of models.entries()) {
      if (!isJsonObject(model)) throw new Error(`models[${index}] must be an object`);
      const slug = requiredString(model, "slug");

      if (slugs.has(slug)) throw new Error(`duplicate slug "${slug}"`);
      slugs.add(slug);

      try {
        validateCodexClientModel(model);
      } catch (cause) {
        throw new Error(
          `model "${slug}": ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    }

    if (!slugs.has("gpt-5.5")) throw new Error(`missing default template "gpt-5.5"`);

    return { ok: true, value: parsed };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
};

// --- bundled data ----------------------------------------------------------------------------------------------------

let embeddedDoc: ModelsDevCatalog | undefined;

/** The models.dev snapshot compiled into the Worker (parsed once per isolate). */
export const embeddedModelsDev = (): ModelsDevCatalog => {
  if (embeddedDoc === undefined) {
    const trimmed = trimModelsDev(JSON.stringify(modelsDevJson));

    if (!trimmed.ok) throw new Error(`bundled models-dev.json is invalid: ${trimmed.error}`);
    embeddedDoc = trimmed.value;
  }

  return embeddedDoc;
};

let embeddedExtras: CatalogAdditions | undefined;

/** The catalog additions compiled into the Worker. */
export const catalogAdditions = (): CatalogAdditions => {
  if (embeddedExtras === undefined) {
    const parsed = parseCatalogAdditions(additionsJson);

    if (!parsed.ok) throw new Error(`bundled additions.json is invalid: ${parsed.error}`);
    embeddedExtras = parsed.value;
  }

  return embeddedExtras;
};

let embeddedCodexClient: Json | undefined;

const bundledCodexClient = (): Json => {
  if (embeddedCodexClient === undefined) {
    const codexClient = validateCodexClientModels(codexClientJson);

    if (!codexClient.ok)
      throw new Error(`bundled codex_client_models.json is invalid: ${codexClient.error}`);
    embeddedCodexClient = codexClient.value;
  }

  return embeddedCodexClient;
};

/** The catalogs built from a models.dev document and the bundled additions. */
export const catalogsFromModelsDev = (modelsDev: ModelsDevCatalog): ModelCatalogs => ({
  models: buildModelsCatalog(modelsDev, catalogAdditions()),
  codexClient: bundledCodexClient(),
  modelsDev,
});

let embedded: ModelCatalogs | undefined;

/** The catalogs compiled into the Worker (built once per isolate). */
export const embeddedCatalogs = (): ModelCatalogs => {
  embedded ??= catalogsFromModelsDev(embeddedModelsDev());

  return embedded;
};

/** A stored models.dev document (KV text); invalid text is an error naming the problem. */
export const modelsDevFromText = (text: string): CatalogResult<ModelsDevCatalog> => {
  const trimmed = trimModelsDev(text);

  return trimmed.ok ? { ok: true, value: trimmed.value } : { ok: false, error: trimmed.error };
};

// --- section getters (clones) ----------------------------------------------------------------------------------------

/** Models of one section. */
export const sectionModels = (catalogs: ModelCatalogs, section: Section): ModelInfo[] =>
  catalogs.models[section].map(cloneModelInfo);

/** The models of a provider channel (`claude`, `gemini`, ...); `undefined` for unknown channels. */
export const staticModelsByChannel = (
  catalogs: ModelCatalogs,
  channel: string,
): ModelInfo[] | undefined => {
  switch (channel.trim().toLowerCase()) {
    case "claude":
      return sectionModels(catalogs, "claude");
    case "gemini":
    case "gemini-interactions":
      return sectionModels(catalogs, "gemini");
    case "vertex":
      return sectionModels(catalogs, "vertex");
    case "aistudio":
      return sectionModels(catalogs, "aistudio");
    case "codex":
      return sectionModels(catalogs, "codex-pro");
    case "kimi":
    case "kimi-ai":
    case "kimi.ai":
    case "kimi.com":
      return sectionModels(catalogs, "kimi");
    case "antigravity":
      return sectionModels(catalogs, "antigravity");
    case "xai":
    case "x-ai":
    case "grok":
      return sectionModels(catalogs, "xai");
    case "devin":
      return sectionModels(catalogs, "devin");
    case "meta":
    case "muse":
      return sectionModels(catalogs, "meta");
    case "typesafe":
      return sectionModels(catalogs, "typesafe");
    case "subq":
      return sectionModels(catalogs, "subq");
    default:
      return undefined;
  }
};

/** Exact id within one channel's models. */
export const lookupStaticModelInfoByChannel = (
  catalogs: ModelCatalogs,
  modelId: string,
  channel: string,
): ModelInfo | undefined => {
  const id = modelId.trim();

  if (id === "") return undefined;
  const found = staticModelsByChannel(catalogs, channel)?.find((model) => model.id === id);

  return found === undefined ? undefined : cloneModelInfo(found);
};

/** First exact match over the provider catalogs, in a fixed provider order. */
export const lookupStaticModelInfo = (
  catalogs: ModelCatalogs,
  modelId: string,
): ModelInfo | undefined => {
  if (modelId === "") return undefined;
  const { models } = catalogs;

  const lists = [
    models.claude,
    models.gemini,
    models.vertex,
    models.aistudio,
    models["codex-pro"],
    models.kimi,
    models.antigravity,
    models.xai,
    models.devin,
    models.meta,
    models.typesafe,
    models.subq,
    models["opencode-zen"],
  ];

  for (const list of lists) {
    const found = list.find((model) => model.id === modelId);

    if (found !== undefined) return cloneModelInfo(found);
  }

  return undefined;
};

/**
 * Per-credential model assembly: which models a credential contributes to the registry.
 *
 * Go source: sdk/cliproxy/service_models.go (`registerModelsForAuthWithCache`, `applyExcludedModels`,
 * `applyOAuthModelAliasForAuth`, `applyOAuthSettingsForAuth`, `applyModelPrefixes`, `build*ConfigModels`),
 * internal/modelconfig/model_info.go (`ResolveModelInfo`, `NormalizeThinkingSupport`),
 * internal/config/config_types.go (`ResolveOAuthModelSetting`), sdk/cliproxy/auth/oauth_model_alias.go
 * (`OAuthModelAliasChannel`). Docs: config-management-oauth.md §4.2.
 *
 * Differences: plugin models are not supported; Antigravity uses the static catalog (the account-specific
 * `fetchAvailableModels` list belongs to the Antigravity slice); config entries are already attached to the
 * credential (`ModelSource.models`), so Go's config-entry lookup by index/key is not needed.
 */
import type { Types } from "effect";
import {
  type Config,
  isOpenCodeProtocol,
  type ModelEntry,
  type OAuthModelAlias,
  type OAuthModelSetting,
  type ThinkingSupport as ConfigThinking,
} from "../config/schema.ts";
import { matchWildcard, parseModelSuffix } from "../credentials/selection/model-name.ts";
import {
  type ModelCatalogs,
  lookupStaticModelInfo,
  lookupStaticModelInfoByChannel,
  sectionModels,
  type Section,
} from "./catalog.ts";
import { applyAntigravityHints } from "./antigravity-hints.ts";
import {
  OPENCODE_GO,
  OPENCODE_ZEN,
  openCodeCloakMode,
  type OpenCodeProvider,
} from "../executor/opencode/providers.ts";
import { supportsOpenCodeProtocol } from "../executor/opencode/protocol.ts";
import {
  catalogModelInfo,
  defaultCatalogModels,
  findCatalogModel,
  openCodeProtocolType,
} from "./opencode-catalog.ts";
import {
  SUBQ,
  SYSTEM_ONE_PROVIDER_SPECS,
  type SystemOneProvider,
  TYPESAFE,
} from "../executor/systemone/providers.ts";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import { cloneModelInfo, type ModelInfo, type ThinkingSupport } from "./model-info.ts";
import { type GrantFilter, grantsReach } from "./grant-filter.ts";
import type { ModelSource } from "./source.ts";

export interface AssemblyOptions {
  readonly config: Pick<Config, "oauth" | "routing" | "upstream">;
  readonly catalogs: ModelCatalogs;
  /** Unix seconds used as `created` of config-defined models (Go uses `time.Now().Unix()`). */
  readonly nowSeconds: number;
  /** A member's restricted reach (ADR 0023): models of a shared credential outside it are not registered. */
  readonly grants?: GrantFilter | undefined;
}

export interface AssembledModels {
  /** Registry provider key (executor key). */
  readonly provider: string;
  /** Models in registration order; duplicates are kept (they count as separate registrations, like Go). */
  readonly models: ReadonlyArray<ModelInfo>;
}

// --- config model builders -----------------------------------------------------------------------------------------

/** `NormalizeThinkingSupport`. */
export const normalizeThinkingSupport = (
  raw: ConfigThinking | ThinkingSupport | undefined,
): ThinkingSupport | undefined => {
  if (raw === undefined) return undefined;

  // SAFETY: ConfigThinking uses the dashed keys and ThinkingSupport the camelCase ones; this view lists every field of both as optional.
  const source = raw as {
    min?: number;
    max?: number;
    "zero-allowed"?: boolean;
    "dynamic-allowed"?: boolean;
    zeroAllowed?: boolean;
    dynamicAllowed?: boolean;
    levels?: readonly string[];
  };

  const out: Types.Mutable<ThinkingSupport> = {};

  if (source.min !== undefined) out.min = source.min;

  if (source.max !== undefined) out.max = source.max;
  let zeroAllowed = source["zero-allowed"] ?? source.zeroAllowed;
  let dynamicAllowed = source["dynamic-allowed"] ?? source.dynamicAllowed;
  const levels: string[] = [];

  for (const value of source.levels ?? []) {
    const level = value.trim().toLowerCase();

    if (level === "") continue;

    if (level === "none") zeroAllowed = true;
    else if (level === "auto") dynamicAllowed = true;

    if (!levels.includes(level)) levels.push(level);
  }

  if (zeroAllowed !== undefined) out.zeroAllowed = zeroAllowed;

  if (dynamicAllowed !== undefined) out.dynamicAllowed = dynamicAllowed;

  if (levels.length > 0) out.levels = levels;

  return out;
};

/** `buildConfiguredModelInfo`. */
const buildConfiguredModelInfo = (
  entry: ModelEntry,
  ownedBy: string,
  type: string,
  created: number,
  fallbackDisplayName: string,
  userDefined: boolean,
): Types.Mutable<ModelInfo> | undefined => {
  const name = entry.name.trim();
  const alias = (entry.alias ?? "").trim() || name;

  if (alias === "") return undefined;
  const displayName = (entry["display-name"] ?? "").trim() || fallbackDisplayName || alias;

  const info: Types.Mutable<ModelInfo> = {
    id: alias,
    metadataModelId: name || alias,
    object: "model",
    created,
    ownedBy,
    type,
    displayName,
    userDefined,
  };

  const maxContextLength = entry["max-context-length"] ?? 0;

  if (maxContextLength > 0) {
    info.contextLength = maxContextLength;
    info.maxContextLength = maxContextLength;
  }

  if (entry["is-compat"] === true) info.isCompat = true;

  return info;
};

/** `modelconfig.ResolveModelInfo(...).Thinking`: static capabilities of the base name, overridden by the config. */
const resolveThinking = (
  catalogs: ModelCatalogs,
  name: string,
  support: ConfigThinking | undefined,
): ThinkingSupport | undefined => {
  const base = parseModelSuffix(name.trim()).modelName.trim();
  const configured = normalizeThinkingSupport(support);

  if (configured !== undefined) return configured;

  return lookupStaticModelInfo(catalogs, base)?.thinking;
};

/** `buildConfigModels`: de-duplicated by lower-cased alias. */
const buildConfigModels = (
  entries: ReadonlyArray<ModelEntry>,
  ownedBy: string,
  type: string,
  channel: string,
  options: AssemblyOptions,
): ModelInfo[] => {
  const out: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const name = entry.name.trim();
    const info = buildConfiguredModelInfo(entry, ownedBy, type, options.nowSeconds, name, true);

    if (info === undefined) continue;
    const key = info.id.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);

    if (entry.thinking !== undefined) info.explicitThinking = true;
    const thinking = resolveThinking(options.catalogs, name, entry.thinking);

    if (thinking !== undefined) info.thinking = thinking;

    const native = lookupStaticModelInfoByChannel(
      options.catalogs,
      name,
      channel,
    )?.nativeCapabilities;

    if (native !== undefined) info.nativeCapabilities = structuredClone(native);
    out.push(info);
  }

  return out;
};

const normalizeModalities = (raw: ReadonlyArray<string> | undefined): string[] | undefined => {
  const out: string[] = [];

  for (const item of raw ?? []) {
    const modality = item.trim().toLowerCase();

    if (modality !== "" && !out.includes(modality)) out.push(modality);
  }

  return out.length === 0 ? undefined : out;
};

/** `buildOpenAICompatibilityConfigModels`: aliases may repeat (an internal model pool), nothing is de-duplicated. */
const buildCompatModels = (
  entries: ReadonlyArray<ModelEntry>,
  groupName: string,
  nowSeconds: number,
): ModelInfo[] => {
  const out: ModelInfo[] = [];

  for (const entry of entries) {
    const image = entry.image === true;
    const type = image ? "openai-image" : "openai-compatibility";

    const info = buildConfiguredModelInfo(
      entry,
      groupName,
      type,
      nowSeconds,
      (entry.alias ?? "").trim(),
      false,
    );

    if (info === undefined) continue;
    let support: ConfigThinking | undefined = entry.thinking;

    if (support === undefined && !image) support = { levels: ["low", "medium", "high"] };

    if (entry.thinking !== undefined) info.explicitThinking = true;

    if ((entry["input-modalities"] ?? []).length > 0) info.explicitInputModalities = true;
    const thinking = normalizeThinkingSupport(support);

    if (thinking !== undefined) info.thinking = thinking;
    const input = normalizeModalities(entry["input-modalities"]);

    if (input !== undefined) info.supportedInputModalities = input;
    const output = normalizeModalities(entry["output-modalities"]);

    if (output !== undefined) info.supportedOutputModalities = output;
    out.push(info);
  }

  return out;
};

/** `buildCodexConfigModels`. */
const buildCodexConfigModels = (
  entries: ReadonlyArray<ModelEntry>,
  options: AssemblyOptions,
): ModelInfo[] => {
  if (entries.length === 0) {
    return sectionModels(options.catalogs, "codex-pro").map((model) => ({
      ...model,
      supportConfigurationUpdate: false,
    }));
  }

  const models: Types.Mutable<ModelInfo>[] = buildConfigModels(
    entries,
    "openai",
    "openai",
    "codex",
    options,
  );

  const displayNames = new Map<string, string>();
  const configurationUpdates = new Map<string, boolean>();
  const seen = new Set<string>();

  for (const entry of entries) {
    const alias = (entry.alias ?? "").trim() || entry.name.trim();

    if (alias === "") continue;
    const key = alias.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    configurationUpdates.set(key, entry["support-configuration-update"] === true);
    const displayName = (entry["display-name"] ?? "").trim();

    if (displayName !== "") displayNames.set(key, displayName);
  }

  for (const model of models) {
    const key = model.id.toLowerCase();
    const displayName = displayNames.get(key);

    if (displayName !== undefined) model.displayName = displayName;
    model.supportConfigurationUpdate = configurationUpdates.get(key) ?? false;
  }

  return models;
};

/** A gateway's System One models (ADR 0032), its catalog additions: Zen's Jev, free or not; Go serves none. */
const openCodeSystemOneModels = (
  catalogs: ModelCatalogs,
  provider: OpenCodeProvider,
): ModelInfo[] =>
  supportsOpenCodeProtocol(provider, "systemone") ? sectionModels(catalogs, OPENCODE_ZEN) : [];

/**
 * OpenCode Zen/Go config models (no Go counterpart): `buildConfigModels`, then the catalog's limits, modalities and
 * reasoning support for names the catalog knows (an explicit `max-context-length`, `display-name` or `thinking` wins).
 * Zen's catalog additions (its System One models, ADR 0032) come before models.dev and type the model `systemone`.
 * The registry `type` follows the model's protocol (`protocol` override, else the catalog); a `systemone` override on
 * OpenCode Go, which serves no System One model, is ignored (the executor falls back to chat).
 */
const buildOpenCodeConfigModels = (
  entries: ReadonlyArray<ModelEntry>,
  provider: OpenCodeProvider,
  options: AssemblyOptions,
): ModelInfo[] => {
  const catalog = options.catalogs.modelsDev;
  const additions = openCodeSystemOneModels(options.catalogs, provider);
  const byAlias = new Map<string, ModelEntry>();

  for (const entry of entries) {
    const alias = ((entry.alias ?? "").trim() || entry.name.trim()).toLowerCase();

    if (alias !== "" && !byAlias.has(alias)) byAlias.set(alias, entry);
  }

  return buildConfigModels(entries, "opencode", "openai", provider, options).map((model) => {
    const entry = byAlias.get(model.id.toLowerCase());

    if (entry === undefined) return model;
    const name = parseModelSuffix(entry.name.trim()).modelName.trim();
    const out: Types.Mutable<ModelInfo> = { ...model };

    const addition = additions.find(
      (candidate) => candidate.id.toLowerCase() === name.toLowerCase(),
    );

    const known = addition === undefined ? findCatalogModel(catalog, provider, name) : undefined;

    if (addition !== undefined) applySystemOneRecord(out, entry, addition);
    else if (known !== undefined) {
      const fromCatalog = catalogModelInfo(catalog, provider, known);
      out.type = fromCatalog.type;

      if ((entry["display-name"] ?? "").trim() === "" && fromCatalog.displayName !== undefined)
        out.displayName = fromCatalog.displayName;

      if (out.contextLength === undefined && fromCatalog.contextLength !== undefined)
        out.contextLength = fromCatalog.contextLength;

      if (fromCatalog.maxCompletionTokens !== undefined)
        out.maxCompletionTokens = fromCatalog.maxCompletionTokens;

      if (fromCatalog.supportedInputModalities !== undefined)
        out.supportedInputModalities = fromCatalog.supportedInputModalities;

      if (fromCatalog.supportedOutputModalities !== undefined)
        out.supportedOutputModalities = fromCatalog.supportedOutputModalities;

      if (entry.thinking === undefined) {
        if (fromCatalog.thinking === undefined) delete out.thinking;
        else out.thinking = fromCatalog.thinking;
      }
    }

    const { protocol } = entry;

    // Go has no System One endpoint: a `systemone` there falls back to chat and keeps the model's type.
    if (
      isOpenCodeProtocol(protocol) &&
      (protocol !== "systemone" || supportsOpenCodeProtocol(provider, protocol))
    ) {
      out.type = openCodeProtocolType(protocol);

      if (protocol === "systemone") delete out.thinking;
    }

    return out;
  });
};

/**
 * A configured System One model takes its catalog record's details (an explicit `display-name` or `max-context-length`
 * wins): owner, display name, description, context length and modalities. Thinking does not apply to it.
 */
const applySystemOneRecord = (
  out: Types.Mutable<ModelInfo>,
  entry: ModelEntry,
  record: ModelInfo,
): void => {
  out.type = EntryOnlyFormats.SystemOne;
  delete out.thinking;
  out.ownedBy = record.ownedBy;

  if ((entry["display-name"] ?? "").trim() === "" && record.displayName !== undefined)
    out.displayName = record.displayName;

  if (record.description !== undefined) out.description = record.description;

  if (out.contextLength === undefined && record.contextLength !== undefined)
    out.contextLength = record.contextLength;

  if (record.supportedInputModalities !== undefined)
    out.supportedInputModalities = [...record.supportedInputModalities];

  if (record.supportedOutputModalities !== undefined)
    out.supportedOutputModalities = [...record.supportedOutputModalities];
};

/**
 * TypeSafe/SubQ config models (no Go counterpart, ADR 0032): `buildConfigModels` typed `systemone`, with the catalog's
 * display name, description and context length for names the catalog knows (an explicit `display-name` or
 * `max-context-length` wins). Thinking does not apply to System One models.
 */
const buildSystemOneConfigModels = (
  entries: ReadonlyArray<ModelEntry>,
  provider: SystemOneProvider,
  options: AssemblyOptions,
): ModelInfo[] => {
  const catalog = sectionModels(options.catalogs, provider);
  const byAlias = new Map<string, ModelEntry>();

  for (const entry of entries) {
    const alias = ((entry.alias ?? "").trim() || entry.name.trim()).toLowerCase();

    if (alias !== "" && !byAlias.has(alias)) byAlias.set(alias, entry);
  }

  return buildConfigModels(
    entries,
    SYSTEM_ONE_PROVIDER_SPECS[provider].displayName.toLowerCase(),
    EntryOnlyFormats.SystemOne,
    provider,
    options,
  ).map((model) => {
    const out: Types.Mutable<ModelInfo> = { ...model };
    delete out.thinking;
    const entry = byAlias.get(model.id.toLowerCase());
    const name = parseModelSuffix((entry?.name ?? "").trim()).modelName.trim();
    const known = catalog.find((candidate) => candidate.id.toLowerCase() === name.toLowerCase());

    if (entry === undefined || known === undefined) return out;
    applySystemOneRecord(out, entry, known);

    return out;
  });
};

// --- filters and rewrites ------------------------------------------------------------------------------------------

/** `applyExcludedModels`: case-insensitive wildcard patterns against the lower-cased id. */
export const applyExcludedModels = (
  models: ReadonlyArray<ModelInfo>,
  excluded: ReadonlyArray<string>,
): ModelInfo[] => {
  const patterns = excluded.flatMap((item) => {
    const pattern = item.trim().toLowerCase();

    return pattern === "" ? [] : [pattern];
  });

  if (models.length === 0 || patterns.length === 0) return [...models];

  return models.filter((model) => {
    const id = model.id.trim().toLowerCase();

    return !patterns.some((pattern) => matchWildcard(pattern, id));
  });
};

/** `applyModelPrefixes`: adds `prefix/<id>`; the plain id stays unless `force-model-prefix` is set. */
export const applyModelPrefixes = (
  models: ReadonlyArray<ModelInfo>,
  prefix: string | undefined,
  forceModelPrefix: boolean,
): ModelInfo[] => {
  const trimmed = (prefix ?? "").trim();

  if (trimmed === "" || models.length === 0) return [...models];
  const out: ModelInfo[] = [];
  const seen = new Set<string>();

  const add = (model: ModelInfo): void => {
    const id = model.id.trim();

    if (id === "" || seen.has(id)) return;
    seen.add(id);
    out.push(model);
  };

  for (const model of models) {
    const baseId = model.id.trim();

    if (baseId === "") continue;

    if (!forceModelPrefix || trimmed === baseId) add(model);
    const clone: Types.Mutable<ModelInfo> = cloneModelInfo(model);
    clone.id = `${trimmed}/${baseId}`;

    if (clone.metadataModelId === undefined || clone.metadataModelId === "")
      clone.metadataModelId = baseId;
    add(clone);
  }

  return out;
};

/** `OAuthModelAliasChannel`: the `oauth.model-alias` / `oauth.settings` key; empty = not applicable. */
export const oauthModelAliasChannel = (provider: string, authKind: string | undefined): string => {
  const kind = (authKind ?? "").trim().toLowerCase();

  if (kind === "apikey" || kind === "api_key" || kind === "api-key") return "";
  const key = provider.trim().toLowerCase();

  return key === "gemini" ? "" : key;
};

/** `rewriteModelInfoName`. */
const rewriteName = (name: string, oldId: string, newId: string): string => {
  const trimmed = name.trim();
  const from = oldId.trim();
  const to = newId.trim();

  if (trimmed === "" || from === "" || to === "" || from.toLowerCase() === to.toLowerCase())
    return name;

  if (trimmed.toLowerCase() === from.toLowerCase()) return to;

  if (trimmed.endsWith(`/${from}`)) return trimmed.slice(0, trimmed.length - from.length) + to;

  if (trimmed === `models/${from}`) return `models/${to}`;

  return name;
};

/** `oauthModelAliasesForAuth`: per-credential aliases first, then the global channel list, de-duplicated by alias. */
const aliasesForSource = (
  config: Pick<Config, "oauth">,
  channel: string,
  perCredential: ReadonlyArray<OAuthModelAlias>,
): ReadonlyArray<OAuthModelAlias> => {
  const global = config.oauth["model-alias"][channel] ?? [];

  if (global.length === 0) return perCredential;

  if (perCredential.length === 0) return global;
  const out: OAuthModelAlias[] = [];
  const seen = new Set<string>();

  for (const entry of [...perCredential, ...global]) {
    const alias = entry.alias.trim();

    if (alias === "" || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    out.push(entry);
  }

  return out;
};

/** `applyOAuthModelAliasEntries`. */
export const applyOAuthModelAliasEntries = (
  aliases: ReadonlyArray<OAuthModelAlias>,
  models: ReadonlyArray<ModelInfo>,
): ModelInfo[] => {
  interface Forward {
    readonly alias: string;
    readonly displayName: string;
    readonly fork: boolean;
  }

  const forward = new Map<string, Forward[]>();

  for (const entry of aliases) {
    const name = entry.name.trim();
    const alias = entry.alias.trim();

    if (name === "" || alias === "" || name.toLowerCase() === alias.toLowerCase()) continue;
    const key = name.toLowerCase();
    const list = forward.get(key) ?? [];
    list.push({
      alias,
      displayName: (entry["display-name"] ?? "").trim(),
      fork: entry.fork === true,
    });
    forward.set(key, list);
  }

  if (forward.size === 0) return [...models];

  const out: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    const id = model.id.trim();

    if (id === "") continue;
    const key = id.toLowerCase();
    const entries = forward.get(key);

    if (entries === undefined || entries.length === 0) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
      continue;
    }

    const keepOriginal = entries.some((entry) => entry.fork);

    if (keepOriginal && !seen.has(key)) {
      seen.add(key);
      out.push(model);
    }

    let addedAlias = false;

    for (const entry of entries) {
      const mappedId = entry.alias.trim();

      if (mappedId === "" || mappedId.toLowerCase() === key) continue;
      const aliasKey = mappedId.toLowerCase();

      if (seen.has(aliasKey)) continue;
      seen.add(aliasKey);
      const clone: Types.Mutable<ModelInfo> = cloneModelInfo(model);
      clone.id = mappedId;
      clone.metadataModelId =
        model.metadataModelId !== undefined && model.metadataModelId !== ""
          ? model.metadataModelId
          : id;

      if (entry.displayName !== "") clone.displayName = entry.displayName;

      if (clone.name !== undefined && clone.name !== "")
        clone.name = rewriteName(clone.name, id, mappedId);
      out.push(clone);
      addedAlias = true;
    }

    if (!keepOriginal && !addedAlias) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
    }
  }

  return out;
};

/** `config.ResolveOAuthModelSetting`: an alias match beats a name match; later entries win. */
const resolveSetting = (
  settings: ReadonlyArray<OAuthModelSetting>,
  model: ModelInfo,
): OAuthModelSetting | undefined => {
  const id = model.id.trim().toLowerCase();
  const metaId = (model.metadataModelId ?? "").trim().toLowerCase();
  const name = (model.name ?? "").trim().toLowerCase();
  let aliasMatch: OAuthModelSetting | undefined;
  let nameMatch: OAuthModelSetting | undefined;

  for (const entry of settings) {
    const entryName = entry.name.trim().toLowerCase();

    if (entryName === "") continue;
    const entryAlias = (entry.alias ?? "").trim().toLowerCase();

    if (entryAlias !== "" && id !== "" && id === entryAlias) aliasMatch = entry;
    else if (
      (entryAlias === "" || entryAlias === id) &&
      (id === entryName ||
        (metaId !== "" && metaId === entryName) ||
        (name !== "" && name === entryName))
    ) {
      nameMatch = entry;
    }
  }

  return aliasMatch ?? nameMatch;
};

/** `applyOAuthSettingEntries`: `max-context-length` overrides the model's context length. */
const applyOAuthSettings = (
  settings: ReadonlyArray<OAuthModelSetting>,
  models: ReadonlyArray<ModelInfo>,
): ModelInfo[] =>
  models.map((model) => {
    const length = resolveSetting(settings, model)?.["max-context-length"] ?? 0;

    return length > 0 ? { ...model, contextLength: length, maxContextLength: length } : model;
  });

// --- assembly ------------------------------------------------------------------------------------------------------

const CODEX_TIERS = new Map<string, Section>([
  ["pro", "codex-pro"],
  ["plus", "codex-plus"],
  ["team", "codex-team"],
  ["business", "codex-team"],
  ["go", "codex-team"],
  ["free", "codex-free"],
]);

/** Base list of a non-compat credential, before aliases/settings/prefix; `undefined` = unsupported provider. */
const baseModels = (source: ModelSource, options: AssemblyOptions): ModelInfo[] | undefined => {
  const { catalogs } = options;
  const provider = source.provider.trim().toLowerCase();
  const configured = source.models ?? [];
  const excluded = source.excludedModels;

  switch (provider) {
    case "gemini":
    case "gemini-interactions":
      return applyExcludedModels(
        configured.length > 0
          ? buildConfigModels(configured, "google", "gemini", "gemini", options)
          : sectionModels(catalogs, "gemini"),
        excluded,
      );
    case "vertex":
      return applyExcludedModels(
        configured.length > 0
          ? buildConfigModels(configured, "google", "vertex", "vertex", options)
          : sectionModels(catalogs, "vertex"),
        excluded,
      );
    case "aistudio":
      return applyExcludedModels(sectionModels(catalogs, "aistudio"), excluded);
    case "antigravity":
      return applyExcludedModels(
        applyAntigravityHints(sectionModels(catalogs, "antigravity"), source.antigravityHints),
        excluded,
      );
    case "claude":
      return applyExcludedModels(
        configured.length > 0
          ? buildConfigModels(configured, "anthropic", "claude", "claude", options)
          : sectionModels(catalogs, "claude"),
        excluded,
      );
    case "codex": {
      if (source.authKind === "apikey")
        return applyExcludedModels(buildCodexConfigModels(configured, options), excluded);
      const tier = CODEX_TIERS.get((source.planType ?? "").toLowerCase()) ?? "codex-pro";

      return applyExcludedModels(sectionModels(catalogs, tier), excluded);
    }

    case "kimi":
    case "kimi-ai":
    case "kimi.ai":
    case "kimi.com":
      return applyExcludedModels(sectionModels(catalogs, "kimi"), excluded);
    case "xai":
      return applyExcludedModels(
        configured.length > 0
          ? buildConfigModels(configured, "xai", "xai", "xai", options)
          : sectionModels(catalogs, "xai"),
        excluded,
      );
    case "devin":
      return applyExcludedModels(sectionModels(catalogs, "devin"), excluded);
    case "meta":
      return applyExcludedModels(
        configured.length > 0
          ? buildConfigModels(configured, "meta", "meta", "meta", options)
          : sectionModels(catalogs, "meta"),
        excluded,
      );
    case TYPESAFE:
    case SUBQ:
      return applyExcludedModels(
        configured.length > 0
          ? buildSystemOneConfigModels(configured, provider, options)
          : sectionModels(catalogs, provider),
        excluded,
      );
    case OPENCODE_ZEN:
    case OPENCODE_GO:
      return applyExcludedModels(
        configured.length > 0
          ? buildOpenCodeConfigModels(configured, provider, options)
          : defaultCatalogModels(
              catalogs.modelsDev,
              provider,
              openCodeSystemOneModels(catalogs, provider),
              openCodeCloakMode({
                provider,
                disabled: options.config.upstream.opencode["disable-cloaking"],
                mode: source.cloakMode,
              }) !== "never",
            ),
        excluded,
      );
    default:
      return undefined;
  }
};

/** `registerResolvedModelsForAuth`: trims ids and drops blank ones. */
const finalize = (
  source: ModelSource,
  models: ReadonlyArray<ModelInfo>,
  options: AssemblyOptions,
): AssembledModels | undefined => {
  const provider = source.executor;

  const normalized = models.flatMap((model) => {
    const id = model.id.trim();

    if (id === "" || !grantsReach(options.grants, source, id)) return [];

    return [id === model.id ? model : { ...model, id }];
  });

  return normalized.length === 0 ? undefined : { provider, models: normalized };
};

/**
 * The models a credential registers, or `undefined` when it registers none (disabled, unknown provider, or every
 * model excluded).
 */
export const assembleCredentialModels = (
  source: ModelSource,
  options: AssemblyOptions,
): AssembledModels | undefined => {
  if (source.disabled) return undefined;
  const forcePrefix = options.config.routing["force-model-prefix"];

  if (source.compat) {
    const models = buildCompatModels(source.models ?? [], source.label, options.nowSeconds);

    return finalize(source, applyModelPrefixes(models, source.prefix, forcePrefix), options);
  }

  const base = baseModels(source, options);

  if (base === undefined || base.length === 0) return undefined;
  const channel = oauthModelAliasChannel(source.provider, source.authKind);
  let models = base;

  if (channel !== "") {
    const aliases = aliasesForSource(options.config, channel, source.modelAliases);

    if (aliases.length > 0) models = applyOAuthModelAliasEntries(aliases, models);
  }

  if (models.length === 0) return undefined;

  if (channel !== "") {
    const settings = options.config.oauth.settings[channel] ?? [];

    if (settings.length > 0) models = applyOAuthSettings(settings, models);
  }

  return finalize(source, applyModelPrefixes(models, source.prefix, forcePrefix), options);
};

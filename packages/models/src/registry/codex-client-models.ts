/**
 * Codex client model catalog for `GET /v1/models?client_version=...`.
 *
 * Go source: internal/client/codex/models/models.go (`BuildResponseForClientWithToolCapabilities` and helpers) and
 * models/apply_patch.go (`applyCodexClientApplyPatchCapability`), sdk/api/handlers/openai/codex_client_models.go
 * (`codexClientModelsResponse`), sdk/api/handlers/openai/openai_handlers.go (`OpenAIModels`, compact marshalling).
 *
 * Every public model becomes a catalog entry: models with a template in `codex_client_models.json` clone it, every other
 * model clones the `gpt-5.5` template with compact instructions. Bodies are plain `JSON.stringify` output.
 */
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { compareStrings } from "./compare.ts";
import type { ModelInfo, ThinkingSupport } from "./model-info.ts";

export interface CodexClientModelsInput {
  /** The validated `codex_client_models.json` catalog (`{ models: [...] }`). */
  readonly catalog: Json;
  /** The public models (sorted by id), as `ModelInfo` records. */
  readonly models: ReadonlyArray<ModelInfo>;
  readonly providersForModel: (modelId: string) => string[];
  readonly lookupModelInfo: (modelId: string, provider?: string) => ModelInfo | undefined;
  /** `GetResponsesWebSearchCapability`: `undefined` = unknown. */
  readonly webSearchCapability?: (modelId: string) => boolean | undefined;
  /** Executor-backed `apply_patch` support for the exact public model id (config `client.codex.enable-apply-patch`). */
  readonly applyPatchCapability?: (modelId: string) => boolean;
  readonly optimizeMultiAgentV2: boolean;
  readonly clientVersion: string;
}

/**
 * Provider keys whose executor speaks the Codex `apply_patch` tool contract (Go: `SupportsApplyPatch()` on every
 * executor; the Workers executors are the keys of `executor/registry.ts`).
 */
const APPLY_PATCH_PROVIDERS = new Set([
  "antigravity",
  "codex",
  "xai",
  "claude",
  "gemini",
  "gemini-interactions",
  "vertex",
  "devin",
  "meta",
  "kimi",
  "kimi-ai",
  "opencode-zen",
  "opencode-go",
  "openai-compatibility",
]);

/** `SupportsApplyPatchForProviders`: every routing candidate must support the tool (none = unknown = no). */
export const supportsApplyPatchProviders = (providers: ReadonlyArray<string>): boolean =>
  providers.length > 0 &&
  providers.every((provider) => {
    const key = provider.trim().toLowerCase();

    return APPLY_PATCH_PROVIDERS.has(key) || key.startsWith("openai-compatible-");
  });

const ALLOWED_LEVELS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const LEGACY_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

const FALLBACK_INSTRUCTIONS =
  "You are Codex, a coding agent. You and the user share one workspace.";

const NON_CHAT_IDS = new Set([
  "grok-imagine-image-quality",
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6",
  "grok-imagine-image",
  "grok-imagine-image-2.0",
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  "grok-imagine-video-1.5-lite",
  "grok-imagine-video-1.5-preview",
  "grok-tts",
  "grok-voice-tts-1.0",
]);

type Entry = JsonObject;

const firstEntry = (list: readonly Json[]): Entry | undefined => {
  const [first] = list;

  return isJsonObject(first) ? first : undefined;
};

/** `stringModelValue`: the trimmed string at `key`, else `""`. */
const stringValue = (model: Entry | undefined, key: string): string => {
  const value = model?.[key];

  return typeof value === "string" ? value.trim() : "";
};

/** `intModelValue`. */
const intValue = (model: Entry | undefined, key: string): number => {
  const value = model?.[key];

  return typeof value === "number" ? Math.trunc(value) : 0;
};

const clone = <T>(value: T): T => structuredClone(value);

/** The part of an id after the first `/` (`id[idx+1:]`, trimmed). */
const afterSlash = (id: string): string | undefined => {
  const index = id.indexOf("/");

  return index === -1 ? undefined : id.slice(index + 1).trim();
};

// --- templates ------------------------------------------------------------------------------------------------------

interface Templates {
  readonly bySlug: ReadonlyMap<string, Entry>;
  readonly fallback: Entry | undefined;
}

const templateCache = new WeakMap<object, Templates>();

const loadTemplates = (catalog: Json | undefined): Templates | undefined => {
  if (!isJsonObject(catalog)) return undefined;
  const cached = templateCache.get(catalog);

  if (cached !== undefined) return cached;
  const models = catalog["models"];

  if (!Array.isArray(models)) return undefined;
  const bySlug = new Map<string, Entry>();
  let fallback: Entry | undefined;

  for (const model of models) {
    if (!isJsonObject(model)) continue;
    const slug = stringValue(model, "slug");

    if (slug === "") continue;
    bySlug.set(slug, model);

    if (slug === "gpt-5.5") fallback = model;
  }

  const templates = { bySlug, fallback };
  templateCache.set(catalog, templates);

  return templates;
};

// --- model records ----------------------------------------------------------------------------------------------------

/** `{ [key]: value }` when `value` is a positive number, else nothing to spread. */
const positiveField = (key: string, value: number | undefined): Entry =>
  value !== undefined && value > 0 ? { [key]: value } : {};

/** `convertModelToMap(model, "openai")`: the model map Go hands to the catalog builder. */
const openaiModelMap = (model: ModelInfo): Entry => ({
  id: model.id,
  object: "model",
  owned_by: model.ownedBy,
  ...(model.created > 0 ? { created: model.created } : {}),
  ...(model.type !== "" ? { type: model.type } : {}),
  ...(model.displayName ? { display_name: model.displayName } : {}),
  ...(model.version ? { version: model.version } : {}),
  ...(model.description ? { description: model.description } : {}),
  ...positiveField("context_length", model.contextLength),
  ...positiveField("max_context_length", model.maxContextLength),
  ...positiveField("max_completion_tokens", model.maxCompletionTokens),
  ...((model.supportedParameters?.length ?? 0) > 0
    ? { supported_parameters: [...(model.supportedParameters ?? [])] }
    : {}),
});

const providersOf = (input: CodexClientModelsInput, id: string): string[] => {
  let providers = input.providersForModel(id);

  if (providers.length === 0) {
    const base = afterSlash(id);

    if (base !== undefined) providers = input.providersForModel(base);
  }

  return providers;
};

// --- reasoning levels -------------------------------------------------------------------------------------------------

/** `parseDottedVersion`. */
const parseDottedVersion = (raw: string): number[] | undefined => {
  let version = raw.trim();

  if (version.startsWith("v") || version.startsWith("V")) version = version.slice(1);
  const suffix = version.search(/[-+]/);

  if (suffix !== -1) version = version.slice(0, suffix);
  const numbers: number[] = [];

  for (const part of version.split(".")) {
    const trimmed = part.trim();

    if (trimmed === "") continue;

    if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
    const value = Number(trimmed);

    if (value < 0) return undefined;
    numbers.push(value);
  }

  return numbers;
};

/** `compareDottedVersions`: `undefined` when either side does not parse. */
const compareDottedVersions = (a: string, b: string): number | undefined => {
  const left = parseDottedVersion(a);
  const right = parseDottedVersion(b);

  if (left === undefined || right === undefined || left.length === 0 || right.length === 0)
    return undefined;

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;

    if (x !== y) return x < y ? -1 : 1;
  }

  return 0;
};

/** `supportsExtendedReasoningLevels`: `max` and `ultra` need Codex CLI >= 0.144.0 (unknown versions get them). */
const supportsExtendedReasoningLevels = (clientVersion: string): boolean => {
  if (clientVersion.trim() === "") return true;
  const comparison = compareDottedVersions(clientVersion, "0.144.0");

  return comparison === undefined || comparison >= 0;
};

const normalizeReasoningLevel = (raw: string, clientVersion: string): string => {
  const level = raw.trim().toLowerCase();
  const allowed = supportsExtendedReasoningLevels(clientVersion) ? ALLOWED_LEVELS : LEGACY_LEVELS;

  return allowed.has(level) ? level : "";
};

const reasoningDescription = (level: string): string => {
  switch (level) {
    case "none":
      return "No reasoning";
    case "minimal":
      return "Fastest responses with minimal reasoning";
    case "low":
      return "Fast responses with lighter reasoning";
    case "medium":
      return "Balances speed and reasoning depth for everyday tasks";
    case "high":
      return "Greater reasoning depth for complex problems";
    case "xhigh":
      return "Extra high reasoning depth for complex problems";
    case "max":
      return "Maximum available reasoning depth for complex problems";
    default:
      return level;
  }
};

/** `applyCodexClientThinkingMetadata`. */
const applyThinkingMetadata = (
  entry: Entry,
  thinking: ThinkingSupport | undefined,
  clientVersion: string,
): void => {
  if (thinking === undefined) return;
  const levels: Json[] = [];
  let defaultLevel = "";
  let firstLevel = "";

  for (const rawLevel of thinking.levels ?? []) {
    const level = normalizeReasoningLevel(rawLevel, clientVersion);

    if (level === "") continue;

    if (firstLevel === "") firstLevel = level;

    if ((defaultLevel === "" && level !== "none") || level === "medium") defaultLevel = level;
    levels.push({ effort: level, description: reasoningDescription(level) });
  }

  if (levels.length === 0) {
    entry["supported_reasoning_levels"] = levels;
    delete entry["default_reasoning_level"];

    return;
  }

  entry["supported_reasoning_levels"] = levels;
  entry["default_reasoning_level"] = defaultLevel === "" ? firstLevel : defaultLevel;
};

/** `sanitizeCodexClientReasoningMetadata`. */
const sanitizeReasoningMetadata = (entry: Entry, clientVersion: string): void => {
  const raw = entry["supported_reasoning_levels"];

  if (!Array.isArray(raw)) return;
  const levels: Json[] = [];
  const allowedDefaults = new Set<string>();

  for (const item of raw) {
    if (!isJsonObject(item)) continue;
    const level = normalizeReasoningLevel(stringValue(item, "effort"), clientVersion);

    if (level === "") continue;
    const copy = clone(item);
    copy["effort"] = level;
    levels.push(copy);
    allowedDefaults.add(level);
  }

  if (levels.length === 0) {
    entry["supported_reasoning_levels"] = levels;
    delete entry["default_reasoning_level"];

    return;
  }

  let defaultLevel = normalizeReasoningLevel(
    stringValue(entry, "default_reasoning_level"),
    clientVersion,
  );

  if (!allowedDefaults.has(defaultLevel)) defaultLevel = stringValue(firstEntry(levels), "effort");
  entry["supported_reasoning_levels"] = levels;
  entry["default_reasoning_level"] = defaultLevel;
};

// --- modalities ---------------------------------------------------------------------------------------------------------

/** `filterCodexInputModalities`. */
const filterModalities = (modalities: ReadonlyArray<string>): string[] => {
  const out: string[] = [];

  for (const raw of modalities) {
    const modality = raw.trim().toLowerCase();

    if ((modality === "text" || modality === "image") && !out.includes(modality))
      out.push(modality);
  }

  return out;
};

const setModalities = (entry: Entry, modalities: string[]): void => {
  entry["input_modalities"] = modalities;

  if (modalities.includes("image")) entry["supports_image_detail_original"] = true;
  else delete entry["supports_image_detail_original"];
};

/** `applyCodexClientInputModalitiesMetadata`. */
const applyInputModalitiesMetadata = (
  entry: Entry,
  modalities: ReadonlyArray<string> | undefined,
): void => {
  if (modalities === undefined || modalities.length === 0) return;
  const filtered = filterModalities(modalities);

  if (filtered.length === 0) return;
  setModalities(entry, filtered);
};

/** `intersectStringSlices`: case-insensitive, first spelling and order of `a` win. */
const intersect = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): string[] => {
  if (a.length === 0 || b.length === 0) return [];
  const inB = new Set(b.map((item) => item.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of a) {
    const key = item.trim().toLowerCase();

    if (inB.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }

  return out;
};

/** `intersectThinkingSupport`. */
const intersectThinking = (a: ThinkingSupport, b: ThinkingSupport): ThinkingSupport => {
  const min = Math.max(a.min ?? 0, b.min ?? 0);
  const bMax = b.max ?? 0;
  const aMax = a.max ?? 0;
  const max = bMax > 0 && (aMax === 0 || bMax < aMax) ? bMax : aMax;

  return {
    min,
    max,
    zeroAllowed: a.zeroAllowed === true && b.zeroAllowed === true,
    dynamicAllowed: a.dynamicAllowed === true && b.dynamicAllowed === true,
    levels: intersect(a.levels ?? [], b.levels ?? []),
  };
};

/** `applyCodexClientModelCapabilities`: provider/alias constraints on modalities and reasoning levels. */
const applyModelCapabilities = (
  input: CodexClientModelsInput,
  entry: Entry,
  id: string,
  metadataId: string,
  info: ModelInfo | undefined,
): void => {
  if (info?.type === "openai-image") {
    entry["visibility"] = "hide";
    delete entry["input_modalities"];
    delete entry["supports_image_detail_original"];

    return;
  }

  const providers = providersOf(input, id);
  const isAlias = metadataId !== "" && id.toLowerCase() !== metadataId.toLowerCase();

  const providerInfo = (provider: string): ModelInfo | undefined => {
    const exact = input.lookupModelInfo(id, provider);

    if (exact !== undefined) return exact;
    const base = afterSlash(id);

    return base === undefined ? undefined : input.lookupModelInfo(base, provider);
  };

  let modalities: string[] | undefined;

  for (const provider of providers) {
    const found = providerInfo(provider);

    if (found === undefined) continue;
    const isCodex = provider.trim().toLowerCase() === "codex";

    if ((!isCodex && isAlias) || found.explicitInputModalities === true) {
      const mods = [...(found.supportedInputModalities ?? [])];
      modalities = modalities === undefined ? mods : intersect(modalities, mods);
    }
  }

  if (modalities === undefined && info?.explicitInputModalities === true) {
    modalities = [...(info.supportedInputModalities ?? [])];
  }

  if (modalities !== undefined) setModalities(entry, filterModalities(modalities));

  let thinking: ThinkingSupport | undefined;
  let constrained = false;

  for (const provider of providers) {
    const found = providerInfo(provider);

    if (found === undefined) continue;
    const isCodex = provider.trim().toLowerCase() === "codex";

    if ((!isCodex && isAlias) || found.explicitThinking === true) {
      constrained = true;
      const own = found.thinking ?? { levels: [] };
      thinking = thinking === undefined ? own : intersectThinking(thinking, own);
    }
  }

  if (!constrained && info?.explicitThinking === true) {
    thinking = info.thinking ?? { levels: [] };
    constrained = true;
  }

  if (constrained && thinking !== undefined)
    applyThinkingMetadata(entry, thinking, input.clientVersion);
};

// --- per entry tweaks ---------------------------------------------------------------------------------------------------

const setIfString = (entry: Entry, key: string, model: Entry): void => {
  const value = stringValue(model, key);

  if (value !== "") entry[key] = value;
};

const applyMaxContextLengthOverride = (entry: Entry, model: Entry): void => {
  const max = intValue(model, "max_context_length");

  if (max > 0) {
    entry["context_window"] = max;
    entry["max_context_window"] = max;
  }
};

const applyMaxTokens = (entry: Entry, model: Entry): void => {
  const max = intValue(model, "max_completion_tokens");

  if (max > 0) entry["max_tokens"] = max;
};

/** `applyCPAWebSearchCapability`: only `client_version=cpa` exposes `cpa_capabilities`. */
const applyWebSearchCapability = (
  entry: Entry,
  id: string,
  input: CodexClientModelsInput,
): void => {
  delete entry["cpa_capabilities"];

  if (input.clientVersion !== "cpa" || input.webSearchCapability === undefined) return;
  const supported = input.webSearchCapability(id.trim());

  if (supported !== undefined) entry["cpa_capabilities"] = { web_search: supported };
};

const isPureCodexProvider = (input: CodexClientModelsInput, id: string): boolean => {
  const providers = providersOf(input, id);

  return (
    providers.length > 0 && providers.every((provider) => provider.trim().toLowerCase() === "codex")
  );
};

const nullRequiredOptions = (entry: Entry): void => {
  entry["apply_patch_tool_type"] = null;
  entry["upgrade"] = null;
  entry["availability_nux"] = null;
};

/** `applyCodexClientSearchToolSupport`. */
const applySearchToolSupport = (
  entry: Entry,
  id: string,
  isTemplate: boolean,
  input: CodexClientModelsInput,
): void => {
  if (entry["supports_search_tool"] !== true) return;

  if (!isTemplate) {
    entry["supports_search_tool"] = false;

    return;
  }

  const providers = providersOf(input, id);

  if (
    providers.length === 0 ||
    providers.some((provider) => provider.trim().toLowerCase() !== "codex")
  ) {
    entry["supports_search_tool"] = false;
  }
};

/** `applyCodexClientProviderCapabilities`. */
const applyProviderCapabilities = (
  entry: Entry,
  id: string,
  isTemplate: boolean,
  input: CodexClientModelsInput,
): void => {
  if (!isTemplate) {
    applySearchToolSupport(entry, id, false, input);

    return;
  }

  if (!isPureCodexProvider(input, id)) {
    entry["supports_search_tool"] = false;
    entry["prefer_websockets"] = false;
    entry["service_tiers"] = [];
    nullRequiredOptions(entry);

    return;
  }

  applySearchToolSupport(entry, id, true, input);
};

/** `isCodexClientImageOrVideoModel`: catalog ids that are not chat models. */
const isImageOrVideoModel = (id: string): boolean => {
  let target = id.trim();
  const base = afterSlash(target);

  if (base !== undefined) target = base;

  return NON_CHAT_IDS.has(target);
};

const applyVisibilityOverride = (entry: Entry, id: string): void => {
  if (isImageOrVideoModel(id)) entry["visibility"] = "hide";
};

const devinInfo = (info: ModelInfo): boolean =>
  info.type.toLowerCase() === "devin" ||
  info.ownedBy.toLowerCase() === "cognition" ||
  info.id.toLowerCase().startsWith("devin/");

/** `isCodexClientDevinModel`. */
const isDevinModel = (
  input: CodexClientModelsInput,
  id: string,
  model: Entry,
  entry: Entry,
): boolean => {
  const lower = id.trim().toLowerCase();

  if (lower.startsWith("devin/")) return true;
  const slash = lower.indexOf("/");

  if (slash !== -1 && lower.slice(slash + 1).startsWith("devin/")) return true;

  if (stringValue(entry, "owned_by").toLowerCase() === "cognition") return true;

  if (
    stringValue(model, "type").toLowerCase() === "devin" ||
    stringValue(model, "owned_by").toLowerCase() === "cognition"
  ) {
    return true;
  }

  const info = input.lookupModelInfo(id);

  if (info !== undefined) {
    if (devinInfo(info)) return true;
  } else {
    const base = afterSlash(id);
    const baseInfo = base === undefined ? undefined : input.lookupModelInfo(base);

    if (baseInfo !== undefined && devinInfo(baseInfo)) return true;
  }

  return providersOf(input, id).some((provider) => provider.trim().toLowerCase() === "devin");
};

/** `applyCodexClientDevinDisplayName`: the display name ends in ` (Devin)`. */
const applyDevinDisplayName = (
  entry: Entry,
  id: string,
  model: Entry,
  input: CodexClientModelsInput,
): void => {
  if (!isDevinModel(input, id, model, entry)) return;
  const trimmed = (stringValue(entry, "display_name") || id).trim();

  if (trimmed.endsWith(" (Devin)")) return;
  const lower = trimmed.toLowerCase();

  if (lower.endsWith(" (devin)")) {
    entry["display_name"] = `${trimmed.slice(0, trimmed.length - " (devin)".length)} (Devin)`;
  } else if (lower.endsWith("(devin)")) {
    entry["display_name"] = `${trimmed.slice(0, trimmed.length - "(devin)".length).trim()} (Devin)`;
  } else {
    entry["display_name"] = `${trimmed} (Devin)`;
  }
};

/** `applyCodexClientApplyPatchCapability` (models/apply_patch.go). */
const applyApplyPatchCapability = (
  entry: Entry,
  id: string,
  capability: ((id: string) => boolean) | undefined,
): void => {
  const templateSupported = entry["apply_patch_tool_type"] === "freeform";
  entry["apply_patch_tool_type"] = null;
  let baseId = id.trim().toLowerCase();
  const slash = baseId.lastIndexOf("/");

  if (slash !== -1) baseId = baseId.slice(slash + 1).trim();

  if (isImageOrVideoModel(baseId)) return;
  const modalities = entry["input_modalities"];
  const hasModalities = Array.isArray(modalities) && modalities.length > 0;
  const supportsText = Array.isArray(modalities) && modalities.includes("text");

  if (!supportsText && (hasModalities || entry["visibility"] === "hide")) return;

  if (capability === undefined) {
    if (templateSupported) entry["apply_patch_tool_type"] = "freeform";

    return;
  }

  if (capability(id.trim())) entry["apply_patch_tool_type"] = "freeform";
};

/** `useCompactCodexClientInstructions`: both instruction fields must be present for catalog decoding. */
const useCompactInstructions = (entry: Entry): void => {
  entry["base_instructions"] = FALLBACK_INSTRUCTIONS;
  entry["model_messages"] = {
    instructions_template: FALLBACK_INSTRUCTIONS,
    instructions_variables: null,
    approvals: null,
    collaboration_modes: null,
    auto_review: null,
    permissions: null,
    multi_agent: null,
  };
};

/** `codexClientMetadataModelID`: the catalog id whose template an alias or prefixed model inherits. */
const metadataModelId = (input: CodexClientModelsInput, rawId: string): string => {
  const id = rawId.trim();
  const direct = input.lookupModelInfo(id)?.metadataModelId?.trim() ?? "";

  if (direct !== "") return direct;
  const base = afterSlash(id);

  if (base === undefined) return id;
  const baseMetadata = input.lookupModelInfo(base)?.metadataModelId?.trim() ?? "";

  return baseMetadata !== "" ? baseMetadata : base;
};

/** `applyCodexClientModelMetadata`: entry for a model without a template. */
const applyModelMetadata = (
  entry: Entry,
  id: string,
  model: Entry,
  input: CodexClientModelsInput,
): void => {
  const info = input.lookupModelInfo(id);
  let displayName = stringValue(model, "display_name");
  let description = stringValue(model, "description");
  let contextWindow = intValue(model, "context_length");
  let thinking: ThinkingSupport | undefined;

  if (info !== undefined) {
    if (info.displayName) displayName = info.displayName;

    if (info.description) description = info.description;

    if (contextWindow <= 0 && (info.contextLength ?? 0) > 0)
      contextWindow = info.contextLength ?? contextWindow;

    if (info.type === "openai-image") {
      entry["visibility"] = "hide";
      delete entry["input_modalities"];
      delete entry["supports_image_detail_original"];
    } else {
      applyInputModalitiesMetadata(entry, info.supportedInputModalities);
    }

    thinking ??= info.thinking;
  }

  applyThinkingMetadata(entry, thinking, input.clientVersion);
  const maxContext = intValue(model, "max_context_length");

  if (maxContext > 0) contextWindow = maxContext;
  entry["slug"] = id;
  entry["display_name"] = displayName === "" ? id : displayName;
  entry["description"] = description === "" ? id : description;
  entry["prefer_websockets"] = false;

  if (input.optimizeMultiAgentV2) entry["multi_agent_version"] = "v2";
  entry["service_tiers"] = [];
  nullRequiredOptions(entry);

  if (contextWindow > 0) {
    entry["context_window"] = contextWindow;
    entry["max_context_window"] = contextWindow;
  }

  if ("available_in_plans" in model)
    entry["available_in_plans"] = clone(model["available_in_plans"]);
  // Codex 0.156+ caps an explicit model_catalog_url body at 1MiB: non-template models get compact instructions.
  useCompactInstructions(entry);
};

const priorityOf = (entry: Entry): number => {
  const priority = entry["priority"];

  return typeof priority === "number" ? Math.trunc(priority) : 100;
};

/** `applyCodexClientNonTemplatePriorities`: models without a template follow the templates, by display name. */
const applyNonTemplatePriorities = (
  result: Entry[],
  templates: ReadonlyMap<string, Entry>,
  input: CodexClientModelsInput,
): void => {
  if (result.length === 0) return;
  let basePriority = 0;

  for (const template of templates.values())
    basePriority = Math.max(basePriority, priorityOf(template));

  const pending: Array<{
    readonly index: number;
    readonly displayName: string;
    readonly slug: string;
  }> = [];

  for (const [index, entry] of result.entries()) {
    const slug = stringValue(entry, "slug");

    if (templates.has(metadataModelId(input, slug))) continue;
    pending.push({ index, displayName: stringValue(entry, "display_name") || slug, slug });
  }

  pending.sort((a, b) => {
    const left = a.displayName.toLowerCase();
    const right = b.displayName.toLowerCase();

    return left === right ? compareStrings(a.slug, b.slug) : compareStrings(left, right);
  });

  for (const [rank, item] of pending.entries()) {
    const target = result[item.index];

    if (target !== undefined) target["priority"] = basePriority + 100 * (rank + 1);
  }
};

// --- public API -----------------------------------------------------------------------------------------------------------

/**
 * `BuildResponseForClientWithToolCapabilities`: `{ models: [...] }`; `models` is `null` when the catalog has no usable
 * default template (Go returns a nil slice).
 */
export const buildCodexClientModels = (input: CodexClientModelsInput): JsonObject => {
  const templates = loadTemplates(input.catalog);

  if (templates === undefined || templates.fallback === undefined) return { models: null };
  const result: Entry[] = [];

  for (const info of input.models) {
    const model = openaiModelMap(info);
    const id = stringValue(model, "id");

    if (id === "") continue;
    const metadataId = metadataModelId(input, id);
    const template = templates.bySlug.get(metadataId);

    if (template !== undefined) {
      const entry = clone(template);
      entry["slug"] = id;
      applyModelCapabilities(input, entry, id, metadataId, input.lookupModelInfo(id));
      setIfString(entry, "display_name", model);
      setIfString(entry, "description", model);
      setIfString(entry, "base_instructions", model);
      applyMaxContextLengthOverride(entry, model);
      applyMaxTokens(entry, model);
      applyProviderCapabilities(entry, id, true, input);
      applyWebSearchCapability(entry, id, input);
      sanitizeReasoningMetadata(entry, input.clientVersion);
      applyVisibilityOverride(entry, id);

      if (input.optimizeMultiAgentV2) entry["multi_agent_version"] = "v2";
      applyDevinDisplayName(entry, id, model, input);
      applyApplyPatchCapability(entry, id, input.applyPatchCapability);
      result.push(entry);
      continue;
    }

    const entry = clone(templates.fallback);
    applyModelMetadata(entry, id, model, input);
    applyMaxTokens(entry, model);
    applyProviderCapabilities(entry, id, false, input);
    applyWebSearchCapability(entry, id, input);
    sanitizeReasoningMetadata(entry, input.clientVersion);
    applyVisibilityOverride(entry, id);
    applyDevinDisplayName(entry, id, model, input);
    applyApplyPatchCapability(entry, id, input.applyPatchCapability);
    result.push(entry);
  }

  applyNonTemplatePriorities(result, templates.bySlug, input);
  // Array#sort is stable.
  result.sort((a, b) => priorityOf(a) - priorityOf(b));

  return { models: result };
};

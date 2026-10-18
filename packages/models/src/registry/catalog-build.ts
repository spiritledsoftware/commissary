/**
 * Builds the model catalog of every provider from the trimmed models.dev document and the catalog additions
 * (ADR 0020). Pure; imports nothing but `effect` and sibling data modules, so the seeding of the additions and the
 * tests can run it without a Worker.
 *
 * A provider offers every current model models.dev lists for it that produces text output and is not deprecated,
 * minus the families its additions `exclude` (the route cannot serve them), plus the additions' own models. Codex is
 * the exception: its plans name the models they offer, and models.dev only supplies the details. A model's record is
 * derived from models.dev; an addition only fills the gaps (`fillGaps`), so where models.dev has a value it wins.
 *
 * Models.dev provider -> our provider: `anthropic` -> Claude, `google` -> Gemini and AI Studio, `google-vertex` ->
 * Vertex (Gemini only), `xai` -> xAI, `meta` -> Meta, `kimi-code-plan-global` -> Kimi (`kimi-` prefixed ids, which
 * the Kimi executor normalizes), `openai` -> Codex (details only). Antigravity and Devin have private model ids and
 * are catalog additions entirely, like the System One models (ADR 0032) of TypeSafe, SubQ and OpenCode Zen (the
 * `opencode-zen` section holds only those; Zen's other models come from models.dev, `opencode-catalog.ts`).
 */
import type { Types } from "effect";
import { matchWildcard } from "../credentials/selection/model-name.ts";
import type {
  AdditionModel,
  CatalogAdditions,
  CodexPlan,
  ModelFacts,
  ProviderAdditions,
} from "./catalog-additions.ts";
import type { ModelInfo, ThinkingSupport } from "./model-info.ts";
import type { ModelsDevCatalog, ModelsDevModel, ModelsDevProviderId } from "./models-dev.ts";

/** Sections of the provider catalogs (one per provider, one per Codex plan). */
export const SECTIONS = [
  "claude",
  "gemini",
  "vertex",
  "aistudio",
  "codex-free",
  "codex-team",
  "codex-plus",
  "codex-pro",
  "kimi",
  "antigravity",
  "xai",
  "devin",
  "meta",
  "typesafe",
  "subq",
  // Zen's System One models only (ADR 0032); its chat models come from models.dev (`opencode-catalog.ts`).
  "opencode-zen",
] as const;

export type Section = (typeof SECTIONS)[number];

export type ModelsCatalog = { readonly [S in Section]: ReadonlyArray<ModelInfo> };

// --- models.dev -> ModelInfo ---------------------------------------------------------------------------------------

const DEFAULT_LEVELS: ReadonlyArray<string> = ["low", "medium", "high"];

/** A model models.dev marks `deprecated`. */
export const isDeprecatedModel = (model: ModelsDevModel): boolean =>
  (model.status ?? "").trim().toLowerCase() === "deprecated";

/** A model that produces text output (video, music, speech and embedding-only models do not). */
export const producesText = (model: ModelsDevModel): boolean =>
  (model.modalities?.output ?? []).includes("text");

interface RawThinking {
  readonly thinking: ThinkingSupport;
  /** models.dev offers a `budget_tokens` option. */
  readonly budget: boolean;
  /** `reasoning_options` is present and empty (or null): the model reasons, with no setting to change. */
  readonly noKnobs: boolean;
}

/** What models.dev itself says about a reasoning model's thinking, without defaults or additions. */
export const rawModelsDevThinking = (model: ModelsDevModel): RawThinking => {
  const out: Types.Mutable<ThinkingSupport> = {};
  let budget = false;
  let toggle = false;
  let budgetZero = false;

  if (model.reasoning !== true) return { thinking: out, budget, noKnobs: false };
  const levels: string[] = [];

  for (const option of model.reasoning_options ?? []) {
    if (option.type === "effort") {
      for (const value of option.values ?? []) {
        const level = value.trim().toLowerCase();

        if (level === "none") out.zeroAllowed = true;
        else if (level === "auto") out.dynamicAllowed = true;

        if (level !== "" && !levels.includes(level)) levels.push(level);
      }
    } else if (option.type === "budget_tokens") {
      budget = true;

      if (option.min !== undefined) out.min = option.min;

      if (option.max !== undefined) out.max = option.max;

      if (option.min === 0) budgetZero = true;
    } else if (option.type === "toggle") {
      toggle = true;
    }
  }

  // A budget alone does not say the budget may be 0: that needs a minimum of 0 or a switch that turns thinking off.
  if (budget && (budgetZero || toggle)) out.zeroAllowed = true;

  if (levels.length > 0) out.levels = levels;

  const noKnobs = model.reasoning_options !== undefined && model.reasoning_options.length === 0;

  return { thinking: out, budget, noKnobs };
};

/**
 * Thinking support from `reasoning`/`reasoning_options`: `effort` values become levels (`none` allows zero, `auto`
 * dynamic), `budget_tokens` a budget range (zero is allowed when its minimum is 0 or a `toggle` exists), `toggle`
 * (or no options at all) the standard low/medium/high levels. A model that reasons with an explicitly empty option
 * list has no settings, so it gets no defaults either. A model models.dev marks `reasoning: false` has no thinking,
 * whatever the additions say.
 *
 * `facts` (catalog additions) only fill what models.dev leaves out, in order. The defaults come last: a budget has
 * a minimum of 1024 and the output limit as its maximum, and a model without levels or a budget gets low/medium/high.
 */
export const thinkingFromModelsDev = (
  model: ModelsDevModel,
  facts: ReadonlyArray<ThinkingSupport | undefined> = [],
): ThinkingSupport | undefined => {
  if (model.reasoning === false) return undefined;
  const reasoning = model.reasoning === true;
  const raw = rawModelsDevThinking(model);
  const out: Types.Mutable<ThinkingSupport> = { ...raw.thinking };
  const { budget, noKnobs } = raw;

  for (const fact of facts) {
    if (fact === undefined) continue;

    if (out.min === undefined && fact.min !== undefined) out.min = fact.min;

    if (out.max === undefined && fact.max !== undefined) out.max = fact.max;

    if (out.zeroAllowed === undefined && fact.zeroAllowed !== undefined)
      out.zeroAllowed = fact.zeroAllowed;

    if (out.dynamicAllowed === undefined && fact.dynamicAllowed !== undefined)
      out.dynamicAllowed = fact.dynamicAllowed;

    if (out.levels === undefined && fact.levels !== undefined) out.levels = [...fact.levels];
  }

  if (reasoning && !noKnobs) {
    if (budget) {
      out.min ??= 1024;
      const output = model.limit?.output ?? 0;

      if (out.max === undefined && output > 0) out.max = output;
    } else if (out.levels === undefined && out.min === undefined) {
      out.levels = [...DEFAULT_LEVELS];
    }
  }

  return Object.keys(out).length === 0 ? undefined : out;
};

/** How a models.dev provider becomes one of ours. */
export interface SourceSpec {
  readonly source: ModelsDevProviderId;
  readonly type: string;
  readonly ownedBy: string;
  /** Gemini listing fields (`name`, `inputTokenLimit`, `outputTokenLimit`) from the id and the limits. */
  readonly gemini?: true;
  /** Our model id of a models.dev one. */
  readonly mapId?: (id: string) => string;
}

const kimiId = (id: string): string => (id.toLowerCase().startsWith("kimi-") ? id : `kimi-${id}`);

export const SOURCES = {
  claude: { source: "anthropic", type: "claude", ownedBy: "anthropic" },
  gemini: { source: "google", type: "gemini", ownedBy: "google", gemini: true },
  // Vertex lists Gemini under the same type as the Gemini API.
  vertex: { source: "google-vertex", type: "gemini", ownedBy: "google", gemini: true },
  aistudio: { source: "google", type: "gemini", ownedBy: "google", gemini: true },
  xai: { source: "xai", type: "xai", ownedBy: "xai" },
  meta: { source: "meta", type: "meta", ownedBy: "meta" },
  kimi: { source: "kimi-code-plan-global", type: "kimi", ownedBy: "moonshot", mapId: kimiId },
  codex: { source: "openai", type: "openai", ownedBy: "openai" },
} as const satisfies Record<string, SourceSpec>;

/** `release_date` (`YYYY-MM-DD`, sometimes `YYYY-MM`) as unix seconds; 0 when absent or unreadable. */
const createdOf = (releaseDate: string | undefined): number => {
  const parsed = releaseDate === undefined ? Number.NaN : Date.parse(releaseDate);

  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
};

type FilledField = (typeof FILLED_FIELDS)[number];

type FilledValue = NonNullable<ModelFacts[FilledField]>;

const isAbsent = (value: FilledValue | undefined): boolean =>
  value === undefined || value === "" || value === 0;

const FILLED_FIELDS = [
  "displayName",
  "name",
  "version",
  "description",
  "created",
  "inputTokenLimit",
  "outputTokenLimit",
  "contextLength",
  "maxCompletionTokens",
  "supportedGenerationMethods",
  "supportedParameters",
  "supportedInputModalities",
  "supportedOutputModalities",
  "supportsWebSearch",
  "supportConfigurationUpdate",
] as const satisfies ReadonlyArray<keyof ModelFacts & keyof ModelInfo>;

/** An addition only fills gaps: every field `info` already has stays as it is. */
const fillGaps = (info: Types.Mutable<ModelInfo>, facts: ModelFacts): void => {
  // The same object seen through the filled fields: each has one type in ModelFacts and ModelInfo (`satisfies` above).
  const target: Partial<Record<FilledField, FilledValue>> = info;

  for (const key of FILLED_FIELDS) {
    const value = facts[key];

    if (value !== undefined && isAbsent(info[key])) target[key] = structuredClone(value);
  }

  if (info.nativeCapabilities?.webSearch === undefined) {
    const webSearch = facts.nativeCapabilities?.webSearch;

    if (webSearch !== undefined)
      info.nativeCapabilities = { ...info.nativeCapabilities, webSearch };
  }

  if (info.config?.overrideHeader === undefined) {
    const overrideHeader = facts.config?.overrideHeader;

    if (overrideHeader !== undefined)
      info.config = { ...info.config, overrideHeader: { ...overrideHeader } };
  }
};

/**
 * The record of a models.dev model as provider `spec` serves it. `additions` fill its gaps, first one first, then the
 * provider's `defaults`; the thinking support is merged field by field (`thinkingFromModelsDev`).
 */
export const modelInfoFromModelsDev = (
  model: ModelsDevModel,
  id: string,
  spec: SourceSpec,
  additions: ReadonlyArray<ModelFacts | undefined> = [],
  defaults?: ModelFacts,
): ModelInfo => {
  const info: Types.Mutable<ModelInfo> = {
    id,
    object: "model",
    created: createdOf(model.release_date),
    ownedBy: spec.ownedBy,
    type: spec.type,
    displayName: model.name ?? id,
  };

  if (model.description !== undefined && model.description !== "")
    info.description = model.description;
  const context = model.limit?.context ?? 0;
  const output = model.limit?.output ?? 0;

  if (context > 0) info.contextLength = context;

  if (output > 0) info.maxCompletionTokens = output;

  if (spec.gemini === true) {
    const input = model.limit?.input ?? context;
    info.name = `models/${id}`;

    if (input > 0) info.inputTokenLimit = input;

    if (output > 0) info.outputTokenLimit = output;
  }

  const inputModalities = model.modalities?.input ?? [];

  if (inputModalities.length > 0) info.supportedInputModalities = [...inputModalities];
  const outputModalities = model.modalities?.output ?? [];

  if (outputModalities.length > 0) info.supportedOutputModalities = [...outputModalities];

  const present = additions.flatMap((facts) => (facts === undefined ? [] : [facts]));

  // The provider's default thinking facts (`dynamicAllowed`) only apply to models that reason and have settings.
  const thinking = thinkingFromModelsDev(model, [
    ...present.map((facts) => facts.thinking),
    ...(model.reasoning === true && !rawModelsDevThinking(model).noKnobs
      ? [defaults?.thinking]
      : []),
  ]);

  if (thinking !== undefined) info.thinking = thinking;

  for (const facts of present) fillGaps(info, facts);

  if (defaults !== undefined) fillGaps(info, defaults);

  return info;
};

/** The record of a model models.dev does not list: the addition as it is, without its price and System One facts. */
export const modelInfoFromAddition = (record: AdditionModel): ModelInfo => {
  const {
    id,
    object,
    ownedBy,
    type,
    cost: _cost,
    systemOne: _systemOne,
    ...facts
  } = structuredClone(record);

  return {
    id,
    object: object ?? "model",
    created: facts.created ?? 0,
    ownedBy: ownedBy ?? "",
    type: type ?? "",
    ...facts,
  };
};

// --- sections ------------------------------------------------------------------------------------------------------

const matchesAny = (patterns: ReadonlyArray<string> | undefined, id: string): boolean => {
  const lower = id.toLowerCase();

  return (patterns ?? []).some((pattern) => matchWildcard(pattern.trim().toLowerCase(), lower));
};

/** Whether provider `additions` take the models.dev model `id` at all (before the text/deprecated checks). */
const isSelected = (additions: ProviderAdditions | undefined, id: string): boolean =>
  (additions?.include === undefined || matchesAny(additions.include, id)) &&
  !matchesAny(additions?.exclude, id);

/** A provider fed by models.dev: its current text models, then the additions' own. */
const sourceSection = (
  spec: SourceSpec,
  doc: ModelsDevCatalog,
  additions: ProviderAdditions | undefined,
): ModelInfo[] => {
  const mapId = spec.mapId ?? ((id: string) => id);
  const known = new Map<string, ModelsDevModel>();

  for (const model of Object.values(doc[spec.source].models)) known.set(mapId(model.id), model);
  const records = new Map((additions?.models ?? []).map((record) => [record.id, record]));
  const out: ModelInfo[] = [];
  const served = new Set<string>();

  for (const [id, model] of known) {
    if (isDeprecatedModel(model) || !producesText(model) || !isSelected(additions, id)) continue;
    served.add(id);
    out.push(
      modelInfoFromModelsDev(
        model,
        id,
        spec,
        [additions?.facts?.[id], records.get(id)],
        additions?.defaults,
      ),
    );
  }

  for (const record of additions?.models ?? []) {
    if (served.has(record.id)) continue;
    const model = known.get(record.id);

    out.push(
      model === undefined
        ? modelInfoFromAddition(record)
        : modelInfoFromModelsDev(model, record.id, spec, [record], additions?.defaults),
    );
  }

  return out;
};

/**
 * A Codex plan: the models it names, with their details from models.dev where it lists them. Every plan id has a full
 * record in the additions: it fills what models.dev leaves out and stands in when models.dev stops listing the id, so
 * a refresh never empties a plan. The provider `defaults` do not apply here (the records carry the details, and the
 * plans include image models that have neither tools nor web search).
 */
const planSection = (
  doc: ModelsDevCatalog,
  additions: ProviderAdditions | undefined,
  plan: CodexPlan,
): ModelInfo[] => {
  const spec = SOURCES.codex;
  const records = new Map((additions?.models ?? []).map((record) => [record.id, record]));
  const out: ModelInfo[] = [];

  for (const id of additions?.plans?.[plan] ?? []) {
    const model = doc[spec.source].models[id];
    const record = records.get(id);

    if (model !== undefined)
      out.push(modelInfoFromModelsDev(model, id, spec, [additions?.facts?.[id], record]));
    else if (record !== undefined) out.push(modelInfoFromAddition(record));
  }

  return out;
};

/** Antigravity and Devin: private ids, catalog additions entirely. */
const recordsSection = (additions: ProviderAdditions | undefined): ModelInfo[] =>
  (additions?.models ?? []).map(modelInfoFromAddition);

/** Every provider's catalog from the models.dev document and the catalog additions. */
export const buildModelsCatalog = (
  doc: ModelsDevCatalog,
  additions: CatalogAdditions,
): ModelsCatalog => {
  const { providers } = additions;

  return {
    claude: sourceSection(SOURCES.claude, doc, providers.claude),
    gemini: sourceSection(SOURCES.gemini, doc, providers.gemini),
    vertex: sourceSection(SOURCES.vertex, doc, providers.vertex),
    aistudio: sourceSection(SOURCES.aistudio, doc, providers.aistudio),
    "codex-free": planSection(doc, providers.codex, "free"),
    "codex-team": planSection(doc, providers.codex, "team"),
    "codex-plus": planSection(doc, providers.codex, "plus"),
    "codex-pro": planSection(doc, providers.codex, "pro"),
    kimi: sourceSection(SOURCES.kimi, doc, providers.kimi),
    antigravity: recordsSection(providers.antigravity),
    xai: sourceSection(SOURCES.xai, doc, providers.xai),
    devin: recordsSection(providers.devin),
    meta: sourceSection(SOURCES.meta, doc, providers.meta),
    typesafe: recordsSection(providers.typesafe),
    subq: recordsSection(providers.subq),
    "opencode-zen": recordsSection(providers["opencode-zen"]),
  };
};

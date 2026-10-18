/**
 * Model list formats per protocol.
 *
 * Go source: internal/registry/model_registry.go (`convertModelToMap`), sdk/api/handlers/openai/openai_handlers.go
 * (`OpenAIModels`), internal/client/claude/models/models.go (`BuildResponse`, ID cloaking),
 * sdk/api/handlers/gemini/gemini_handlers.go (`GeminiModels`, `GeminiGetHandler`), internal/client/grokbuild.
 */
import type { JsonObject } from "@commissary/json";
import { compareStrings } from "./compare.ts";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import type { ModelInfo } from "./model-info.ts";

const SYSTEM_ONE_TYPE = EntryOnlyFormats.SystemOne;

export { compareStrings };

export const DEFAULT_CLAUDE_MAX_INPUT_TOKENS = 200000;

export const DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS = 64000;

// --- per-model entries ---------------------------------------------------------------------------------------------

const positive = (value: number | undefined): value is number => value !== undefined && value > 0;

const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value !== "";

/**
 * `OpenAIModels`: the four fields that survive the handler's filter. Not in Go: a System One model (ADR 0032) also
 * says `type: "systemone"`, so a client can tell it is served on `/v1/systemone` only.
 */
export const openaiEntry = (model: ModelInfo): JsonObject => ({
  id: model.id,
  object: "model",
  ...(model.created > 0 ? { created: model.created } : {}),
  owned_by: model.ownedBy,
  ...(model.type === SYSTEM_ONE_TYPE ? { type: SYSTEM_ONE_TYPE } : {}),
});

export const openaiList = (models: ReadonlyArray<ModelInfo>): JsonObject => ({
  object: "list",
  data: models.map(openaiEntry),
});

/** `convertModelToMap(..., "")`. */
export const genericEntry = (model: ModelInfo): JsonObject => ({
  id: model.id,
  object: "model",
  ...(model.ownedBy !== "" ? { owned_by: model.ownedBy } : {}),
  ...(model.type !== "" ? { type: model.type } : {}),
  ...(model.created !== 0 ? { created: model.created } : {}),
});

const rfc3339 = (unix: number): string =>
  new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** `convertModelToMap(..., "claude")`. */
export const claudeEntry = (model: ModelInfo): JsonObject => ({
  id: model.id,
  object: "model",
  owned_by: model.ownedBy,
  ...(model.created > 0 ? { created_at: rfc3339(model.created) } : {}),
  type: "model",
  display_name: nonEmpty(model.displayName) ? model.displayName : model.id,
  max_input_tokens: positive(model.contextLength)
    ? model.contextLength
    : DEFAULT_CLAUDE_MAX_INPUT_TOKENS,
  max_tokens: positive(model.maxCompletionTokens)
    ? model.maxCompletionTokens
    : DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS,
});

/** `convertModelToMap(..., "gemini")` (before the handler's normalisation). */
export const geminiEntry = (model: ModelInfo): JsonObject => ({
  name: nonEmpty(model.name) ? model.name : model.id,
  ...(nonEmpty(model.version) ? { version: model.version } : {}),
  ...(nonEmpty(model.displayName) ? { displayName: model.displayName } : {}),
  ...(nonEmpty(model.description) ? { description: model.description } : {}),
  ...(positive(model.inputTokenLimit) ? { inputTokenLimit: model.inputTokenLimit } : {}),
  ...(positive(model.outputTokenLimit) ? { outputTokenLimit: model.outputTokenLimit } : {}),
  ...((model.supportedGenerationMethods ?? []).length > 0
    ? { supportedGenerationMethods: [...(model.supportedGenerationMethods ?? [])] }
    : {}),
  ...((model.supportedInputModalities ?? []).length > 0
    ? { supportedInputModalities: [...(model.supportedInputModalities ?? [])] }
    : {}),
  ...((model.supportedOutputModalities ?? []).length > 0
    ? { supportedOutputModalities: [...(model.supportedOutputModalities ?? [])] }
    : {}),
});

// --- Claude --------------------------------------------------------------------------------------------------------

const CLAUDE_DD_PREFIX = "claude-fable-5-dd-";

const reverseCodePoints = (id: string): string => Array.from(id).toReversed().join("");

/** `EnsureClaudeModelIDPrefix`: ids not starting with `claude-` become `claude-fable-5-dd-<reversed id>`. */
export const ensureClaudeModelIdPrefix = (id: string): string =>
  id === "" || id.startsWith("claude-") ? id : CLAUDE_DD_PREFIX + reverseCodePoints(id);

/** `ResolveClaudeModelIDPrefix`: the inverse for request routing; a `(suffix)` is preserved. */
export const resolveClaudeModelIdPrefix = (id: string): string => {
  if (id === "") return id;
  const open = id.lastIndexOf("(");
  const hasSuffix = open !== -1 && id.endsWith(")");
  const base = hasSuffix ? id.slice(0, open) : id;
  const suffix = hasSuffix ? id.slice(open + 1, -1) : "";

  if (!base.startsWith(CLAUDE_DD_PREFIX)) return id;
  const encoded = base.slice(CLAUDE_DD_PREFIX.length);

  if (encoded === "") return id;
  const resolved = reverseCodePoints(encoded);

  return hasSuffix ? `${resolved}(${suffix})` : resolved;
};

const text = (entry: JsonObject, key: string): string =>
  typeof entry[key] === "string" ? entry[key] : "";

/** `claudemodels.BuildResponse`. */
export const claudeList = (
  models: ReadonlyArray<ModelInfo>,
  disableCloaking: boolean,
): JsonObject => {
  const entries = models.map((model) => {
    const entry = claudeEntry(model);

    return disableCloaking ? entry : { ...entry, id: ensureClaudeModelIdPrefix(model.id) };
  });

  const sorted = entries.toSorted(
    (a, b) =>
      compareStrings(text(a, "display_name"), text(b, "display_name")) ||
      compareStrings(text(a, "id"), text(b, "id")),
  );

  const first = sorted.at(0);
  const last = sorted.at(-1);

  return {
    data: sorted,
    has_more: false,
    first_id: first === undefined ? "" : text(first, "id"),
    last_id: last === undefined ? "" : text(last, "id"),
  };
};

// --- Gemini --------------------------------------------------------------------------------------------------------

/** `GeminiModels`: names get the `models/` prefix; display name/description default to the bare name. */
export const geminiList = (models: ReadonlyArray<ModelInfo>): JsonObject => ({
  models: models.map((model) => {
    const entry = { ...geminiEntry(model) };
    const name = text(entry, "name");

    if (name !== "") {
      if (!name.startsWith("models/")) entry.name = `models/${name}`;

      if (typeof entry.displayName !== "string" || entry.displayName === "")
        entry.displayName = name;

      if (typeof entry.description !== "string" || entry.description === "")
        entry.description = name;
    }

    if (entry.supportedGenerationMethods === undefined)
      entry.supportedGenerationMethods = ["generateContent"];

    return entry;
  }),
});

/** `GeminiGetHandler`: the raw entry whose name matches `action` with or without `models/`; `undefined` = 404. */
export const geminiDetail = (
  models: ReadonlyArray<ModelInfo>,
  action: string,
): JsonObject | undefined => {
  for (const model of models) {
    const entry = geminiEntry(model);
    const name = text(entry, "name");

    if (name !== action && name !== `models/${action}`) continue;

    return name !== "" && !name.startsWith("models/")
      ? { ...entry, name: `models/${name}` }
      : entry;
  }

  return undefined;
};

// --- Grok Build ----------------------------------------------------------------------------------------------------

/** `grokbuild.BuildResponse` over `grokModelsFromRegistryInfos`. */
export const grokList = (models: ReadonlyArray<ModelInfo>): JsonObject => ({
  object: "list",
  data: models.map((model) => {
    const efforts = (model.thinking?.levels ?? [])
      .map((level) => level.trim())
      .filter((level) => level !== "")
      .map((value) => ({ value }));

    return {
      id: model.id,
      model: model.id,
      name: nonEmpty(model.displayName) ? model.displayName : model.id,
      ...(positive(model.contextLength) ? { context_window: model.contextLength } : {}),
      api_backend: "responses",
      supported_in_api: true,
      ...(efforts.length > 0 ? { reasoning_efforts: efforts } : {}),
    };
  }),
});

/**
 * Reasoning-summary visibility: provider-neutral intent extracted from the client body and re-applied to the
 * provider body after the effort has been set. Orthogonal to thinking effort.
 *
 * Go source: internal/thinking/summary.go.
 */
import { asInt, get, type Json } from "@commissary/json";
import {
  delIfEmptyObject,
  delPath,
  delPaths,
  getBool,
  getString,
  isEmptyObject,
  normalize,
  setPath,
} from "./json.ts";
import { parseSuffix } from "./suffix.ts";
import type { ModelInfoLookup, ThinkingModelInfo } from "./types.ts";

export type SummaryMode = "unspecified" | "disabled" | "enabled";

/** Summary visibility intent; `detail` preserves protocols that distinguish auto, concise and detailed. */
export interface SummaryConfig {
  readonly mode: SummaryMode;
  readonly detail: string;
}

export const UNSPECIFIED_SUMMARY: SummaryConfig = { mode: "unspecified", detail: "" };

const DISABLED: SummaryConfig = { mode: "disabled", detail: "" };

const ENABLED_AUTO: SummaryConfig = { mode: "enabled", detail: "auto" };

type Found = SummaryConfig | undefined;

/** Protocols that carry summary visibility intent. */
const summaryFormatSupported = (format: string): boolean =>
  format === "openai" ||
  format === "openai-response" ||
  format === "codex" ||
  format === "claude" ||
  format === "gemini" ||
  format === "antigravity" ||
  format === "interactions";

// ---------------------------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------------------------

const summaryBoolConfig = (body: Json | undefined, path: string): Found => {
  const value = get(body, path);

  if (value === true) return ENABLED_AUTO;

  if (value === false) return DISABLED;

  return undefined;
};

const firstSummaryBoolConfig = (body: Json | undefined, paths: readonly string[]): Found => {
  for (const path of paths) {
    const config = summaryBoolConfig(body, path);

    if (config !== undefined) return config;
  }

  return undefined;
};

const responsesSummaryConfig = (body: Json | undefined, path: string): Found => {
  const value = get(body, path);

  if (value === undefined) return undefined;

  if (value === null) return DISABLED;

  if (typeof value !== "string") return undefined;
  const raw = normalize(value);

  switch (raw) {
    case "auto":
    case "concise":
    case "detailed":
      return { mode: "enabled", detail: raw };
    case "none":
      // The OpenAI wire representation disables summaries by omitting the field.
      return DISABLED;
    default:
      return undefined;
  }
};

const claudeSummaryConfig = (body: Json | undefined, path: string): Found => {
  const value = get(body, path);

  if (typeof value !== "string") return undefined;

  switch (normalize(value)) {
    case "summarized":
    case "updates":
      return ENABLED_AUTO;
    case "omitted":
      return DISABLED;
    default:
      return undefined;
  }
};

const interactionsSummaryConfig = (body: Json | undefined, path: string): Found => {
  const value = get(body, path);

  if (typeof value !== "string") return undefined;

  switch (normalize(value)) {
    case "auto":
      return ENABLED_AUTO;
    case "none":
      return DISABLED;
    default:
      return undefined;
  }
};

const OPENAI_EXPLICIT_BOOL_PATHS = [
  "extra_body.google.thinking_config.include_thoughts",
  "extra_body.google.thinking_config.includeThoughts",
  "extra_body.google.thinkingConfig.include_thoughts",
  "extra_body.google.thinkingConfig.includeThoughts",
  "extra_body.extra_body.google.thinking_config.include_thoughts",
  "extra_body.extra_body.google.thinking_config.includeThoughts",
  "google.thinking_config.include_thoughts",
  "google.thinking_config.includeThoughts",
  "thinking.includeThoughts",
  "thinking.include_thoughts",
  "reasoning.includeThoughts",
  "reasoning.include_thoughts",
  "generationConfig.thinkingConfig.includeThoughts",
  "generationConfig.thinkingConfig.include_thoughts",
  "generation_config.thinking_config.include_thoughts",
  "generation_config.thinking_config.includeThoughts",
];

/** Explicit Chat visibility controls only (Google extension, Responses-style summary, OpenRouter bits). */
const extractOpenAIExplicitSummaryConfig = (body: Json | undefined): Found => {
  const google = firstSummaryBoolConfig(body, OPENAI_EXPLICIT_BOOL_PATHS);

  if (google !== undefined) return google;

  for (const path of ["reasoning.summary", "reasoning.generate_summary"]) {
    const config = responsesSummaryConfig(body, path);

    if (config !== undefined) return config;
  }

  // reasoning.exclude is OpenRouter's "reason but hide" bit; include_reasoning its legacy inverse alias;
  // reasoning.enabled turns reasoning on with no exclusions. Only JSON booleans count.
  const exclude = getBool(body, "reasoning.exclude");

  if (exclude !== undefined) return exclude ? DISABLED : ENABLED_AUTO;
  const include = getBool(body, "include_reasoning");

  if (include !== undefined) return include ? ENABLED_AUTO : DISABLED;
  const enabled = getBool(body, "reasoning.enabled");

  if (enabled !== undefined) return enabled ? ENABLED_AUTO : DISABLED;

  return undefined;
};

/**
 * Reads protocol-specific summary visibility intent. OpenAI Chat is the one protocol where effort implies
 * summaries (a non-`none` `reasoning_effort` counts as an explicit request); elsewhere effort alone means nothing.
 */
export const extractSummaryConfig = (body: Json | undefined, format: string): SummaryConfig => {
  const normalized = normalize(format);

  if (!summaryFormatSupported(normalized) || body === undefined) return UNSPECIFIED_SUMMARY;

  switch (normalized) {
    case "openai": {
      const explicit = extractOpenAIExplicitSummaryConfig(body);

      if (explicit !== undefined) return explicit;
      const effort = get(body, "reasoning_effort");

      if (typeof effort === "string") {
        const value = normalize(effort);

        if (value === "") return UNSPECIFIED_SUMMARY;

        return value === "none" ? DISABLED : ENABLED_AUTO;
      }

      break;
    }

    case "openai-response":
    case "codex":
      return (
        responsesSummaryConfig(body, "reasoning.summary") ??
        responsesSummaryConfig(body, "reasoning.generate_summary") ??
        UNSPECIFIED_SUMMARY
      );
    case "claude":
      // Anthropic only accepts display alongside active adaptive/manual thinking.
      if (!claudeThinkingAcceptsDisplay(body)) return UNSPECIFIED_SUMMARY;

      return claudeSummaryConfig(body, "thinking.display") ?? UNSPECIFIED_SUMMARY;
    case "gemini":
      return (
        firstSummaryBoolConfig(body, [
          "generationConfig.thinkingConfig.includeThoughts",
          "generationConfig.thinkingConfig.include_thoughts",
          "generation_config.thinking_config.include_thoughts",
          "generation_config.thinking_config.includeThoughts",
        ]) ?? UNSPECIFIED_SUMMARY
      );
    case "antigravity":
      return (
        firstSummaryBoolConfig(body, [
          "request.generationConfig.thinkingConfig.includeThoughts",
          "request.generationConfig.thinkingConfig.include_thoughts",
          "request.generationConfig.thinking_config.includeThoughts",
          "request.generationConfig.thinking_config.include_thoughts",
        ]) ?? UNSPECIFIED_SUMMARY
      );
    case "interactions": {
      for (const path of [
        "generation_config.thinking_summaries",
        "generation_config.thinkingSummaries",
      ]) {
        const config = interactionsSummaryConfig(body, path);

        if (config !== undefined) return config;
      }

      // The OpenAI-style top-level compatibility object; the official generation_config selector wins.
      return (
        interactionsSummaryConfig(body, "reasoning.summary") ??
        firstSummaryBoolConfig(body, [
          "generation_config.thinking_config.include_thoughts",
          "generation_config.thinking_config.includeThoughts",
          "generation_config.thinkingConfig.include_thoughts",
          "generation_config.thinkingConfig.includeThoughts",
        ]) ??
        UNSPECIFIED_SUMMARY
      );
    }
  }

  return UNSPECIFIED_SUMMARY;
};

/** Explicit visibility controls only: OpenAI Chat `reasoning_effort` is not treated as a summary proxy. */
export const extractExplicitSummaryConfig = (
  body: Json | undefined,
  format: string,
): SummaryConfig => {
  const normalized = normalize(format);

  if (normalized !== "openai") return extractSummaryConfig(body, normalized);

  if (body === undefined) return UNSPECIFIED_SUMMARY;

  return extractOpenAIExplicitSummaryConfig(body) ?? UNSPECIFIED_SUMMARY;
};

/**
 * Source visibility intent for a source/target pair: Chat `reasoning_effort` controls depth, not Claude display
 * visibility, so it is ignored only for Chat → Claude.
 */
export const extractTranslatedSummaryConfig = (
  body: Json | undefined,
  sourceFormat: string,
  targetFormat: string,
): SummaryConfig => {
  const source = normalize(sourceFormat);
  const target = normalize(targetFormat);

  return target === "claude" && source === "openai"
    ? extractExplicitSummaryConfig(body, source)
    : extractSummaryConfig(body, source);
};

// ---------------------------------------------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------------------------------------------

/** Whether the body carries an active Claude thinking block that can hold a `display` field. */
export const claudeThinkingAcceptsDisplay = (body: Json | undefined): boolean => {
  switch (normalize(getString(body, "thinking.type"))) {
    case "adaptive":
      return true;
    case "enabled": {
      // Runs before ApplyThinking normalises the request: a missing budget_tokens is unfinished, not inactive.
      // -1 is the compatibility representation for auto thinking.
      const budget = get(body, "thinking.budget_tokens");

      if (typeof budget !== "number") return true;
      const value = asInt(budget);

      return value === -1 || value > 0;
    }

    default:
      return false;
  }
};

const isOpenRouterProvider = (providerRaw: string): boolean => {
  const provider = normalize(providerRaw);

  if (provider === "openrouter") return true;

  return provider.split(/[-_/.:]/).some((part) => part === "openrouter");
};

/**
 * Writes only documented Chat visibility controls. Summary intent never invents or overwrites thinking effort;
 * OpenRouter's `reasoning.exclude` (and legacy `include_reasoning`) are updated, unknown providers only when the
 * payload already carries them.
 */
const applyOpenAIChatSummaryConfig = (
  body: Json | undefined,
  provider: string,
  enabled: boolean,
): Json | undefined => {
  let result = body;

  if (isOpenRouterProvider(provider) || typeof get(result, "reasoning.exclude") === "boolean") {
    result = setPath(result, "reasoning.exclude", !enabled);
  }

  if (typeof get(result, "include_reasoning") === "boolean") {
    result = setPath(result, "include_reasoning", enabled);
  }

  return result;
};

const normalizedSummaryDetail = (detail: string): string => {
  const value = normalize(detail);

  return value === "concise" || value === "detailed" ? value : "auto";
};

/**
 * Activates Claude thinking so that a summary can be shown (adaptive for models with levels, else manual with the
 * model's minimum budget when `max_tokens` allows). Uses `modelInfo` when the caller resolved it, else the lookup.
 */
const enableClaudeThinkingForSummary = (
  body: Json | undefined,
  model: string,
  resolvedModelInfo: ThinkingModelInfo | undefined,
  lookup: ModelInfoLookup | undefined,
): Json | undefined => {
  let modelInfo = resolvedModelInfo;

  if (modelInfo === undefined) {
    let baseModel = parseSuffix(model).modelName;

    if (baseModel === "") baseModel = parseSuffix(getString(body, "model")).modelName;
    modelInfo = lookup?.(baseModel.trim(), "claude");
  }

  const thinking = modelInfo?.thinking;

  if (modelInfo === undefined || thinking === undefined) return body;

  if ((thinking.levels?.length ?? 0) > 0) {
    return delPath(setPath(body, "thinking.type", "adaptive"), "thinking.budget_tokens");
  }

  const budget = thinking.min ?? 0;

  if (budget <= 0) return body;
  const maxTokens = get(body, "max_tokens");

  if (maxTokens !== undefined && asInt(maxTokens) <= budget) return body;

  return setPath(setPath(body, "thinking.type", "enabled"), "thinking.budget_tokens", budget);
};

/**
 * Removes a globally inferred adaptive mode when the selected model supports only manual extended thinking, so
 * the model-aware summary pass can activate `enabled` thinking with a valid budget or leave thinking absent.
 */
export const stripInferredClaudeSummaryActivation = (
  body: Json | undefined,
  modelInfo: ThinkingModelInfo | undefined,
): Json | undefined => {
  const thinking = modelInfo?.thinking;

  if (thinking === undefined || (thinking.levels?.length ?? 0) > 0 || (thinking.min ?? 0) <= 0)
    return body;

  if (normalize(getString(body, "thinking.type")) !== "adaptive") return body;

  let result = delPaths(body, [
    "thinking.type",
    "thinking.budget_tokens",
    "thinking.display",
    "output_config.effort",
  ]);

  for (const path of ["thinking", "output_config"]) result = delIfEmptyObject(result, path);

  return result;
};

/**
 * Writes canonical summary intent in the target protocol. `provider` is the execution provider identity (needed
 * for Chat dialects such as OpenRouter); `modelInfo` the resolved model when known; `lookup` resolves the Claude
 * model when a summary has to activate thinking.
 */
export const applySummaryConfigForProvider = (
  body: Json | undefined,
  format: string,
  model: string,
  provider: string,
  modelInfo: ThinkingModelInfo | undefined,
  config: SummaryConfig,
  lookup?: ModelInfoLookup,
): Json | undefined => {
  const normalized = normalize(format);

  if (config.mode === "unspecified" || !summaryFormatSupported(normalized) || body === undefined)
    return body;

  const enabled = config.mode === "enabled";
  let result: Json | undefined = body;

  switch (normalized) {
    case "openai":
      return applyOpenAIChatSummaryConfig(result, provider, enabled);
    case "claude": {
      // display is invalid with thinking.type=disabled and required alongside adaptive/enabled thinking. Model
      // defaults differ, so a missing thinking block stays absent (preserving each model's default); only an
      // enabled summary may activate a valid thinking mode, a disabled one only adds `omitted` to an active mode.
      // https://platform.claude.com/docs/en/build-with-claude/thinking
      if (enabled && get(result, "thinking.type") === undefined) {
        result = enableClaudeThinkingForSummary(result, model, modelInfo, lookup);
      }

      if (!claudeThinkingAcceptsDisplay(result)) return result;

      // An existing `updates` display is an enabled mode of its own; keep it rather than overwriting it with `summarized`.
      const display = get(result, "thinking.display");

      const keepUpdates =
        enabled && typeof display === "string" && normalize(display) === "updates";

      if (!enabled) return setPath(result, "thinking.display", "omitted");

      return setPath(result, "thinking.display", keepUpdates ? "updates" : "summarized");
    }

    case "gemini":
      result = setPath(result, "generationConfig.thinkingConfig.includeThoughts", enabled);

      return delPaths(result, [
        "generationConfig.thinkingConfig.include_thoughts",
        "generation_config.thinking_config.include_thoughts",
        "generation_config.thinking_config.includeThoughts",
      ]);
    case "antigravity":
      result = setPath(result, "request.generationConfig.thinkingConfig.includeThoughts", enabled);

      return delPaths(result, [
        "request.generationConfig.thinkingConfig.include_thoughts",
        "request.generationConfig.thinking_config.include_thoughts",
        "request.generationConfig.thinking_config.includeThoughts",
      ]);
    case "interactions":
      // Interactions only accepts auto or none: concise/detailed collapse to the enabled value.
      result = setPath(result, "generation_config.thinking_summaries", enabled ? "auto" : "none");

      return delPath(result, "generation_config.thinkingSummaries");
    case "openai-response":
    case "codex":
      if (enabled) {
        result = setPath(result, "reasoning.summary", normalizedSummaryDetail(config.detail));

        return delPath(result, "reasoning.generate_summary");
      }

      // Omitting the field is the documented way to disable summaries.
      result = delPaths(result, ["reasoning.summary", "reasoning.generate_summary"]);

      return isEmptyObject(get(result, "reasoning")) ? delPath(result, "reasoning") : result;
    default:
      return result;
  }
};

/** Writes canonical summary intent in the target protocol. */
export const applySummaryConfig = (
  body: Json | undefined,
  format: string,
  config: SummaryConfig,
): Json | undefined => applySummaryConfigForProvider(body, format, "", "", undefined, config);

/** Like {@link applySummaryConfig}, using target model capabilities when thinking must be activated first. */
export const applySummaryConfigForModel = (
  body: Json | undefined,
  format: string,
  model: string,
  config: SummaryConfig,
  lookup?: ModelInfoLookup,
): Json | undefined =>
  applySummaryConfigForProvider(body, format, model, "", undefined, config, lookup);

/** Copies an explicit source visibility choice onto a Claude body (Chat `reasoning_effort` stays unspecified). */
export const applyTranslatedSummaryToClaude = (
  out: Json | undefined,
  source: Json | undefined,
  sourceFormat: string,
  model: string,
  lookup?: ModelInfoLookup,
): Json | undefined => {
  const config = extractTranslatedSummaryConfig(source, sourceFormat, "claude");

  return config.mode === "unspecified"
    ? out
    : applySummaryConfigForModel(out, "claude", model, config, lookup);
};

/**
 * Per-format extraction of the canonical config from a request body, plus usage-reporting helpers.
 *
 * Go source: internal/thinking/apply.go (extractThinkingConfig, extract*Config, ExtractReasoningEffort,
 * ExtractTranslatedReasoningEffort) and internal/thinking/configuration_update.go.
 */
import { asInt, asString, get, type Json } from "@commissary/json";
import { extractClaudeEffortDirectiveConfig } from "./claude-effort-directive.ts";
import { convertBudgetToLevel } from "./convert.ts";
import { extractConfigurationUpdateConfig, isResponsesFormat } from "./configuration-update.ts";
import { getFirst, getString, normalize } from "./json.ts";
import { parseSuffix, parseSuffixToConfig } from "./suffix.ts";
import {
  autoConfig,
  BETWEEN_TOOLS,
  budgetConfig,
  EMPTY_CONFIG,
  hasThinkingConfig,
  Level,
  levelConfig,
  noneConfig,
} from "./types.ts";
import type { ThinkingConfig } from "./types.ts";

/** Budget `0` → none, `-1` → auto, anything else a budget. */
const configFromBudget = (budget: Json | undefined): ThinkingConfig => {
  const value = asInt(budget);

  if (value === 0) return noneConfig();

  if (value === -1) return autoConfig();

  return budgetConfig(value);
};

/** `none` / `auto` / level word from an already normalised effort string. */
const configFromEffortWord = (value: string): ThinkingConfig => {
  switch (value) {
    case "none":
      return noneConfig();
    case "auto":
      return autoConfig();
    default:
      return levelConfig(value);
  }
};

/**
 * Claude: `thinking.type` disabled → none; adaptive/auto read `output_config.effort`; otherwise
 * `thinking.budget_tokens`; `enabled` without budget reads the effort or falls back to auto.
 */
export const extractClaudeConfig = (body: Json | undefined): ThinkingConfig => {
  const thinkingType = getString(body, "thinking.type");

  if (thinkingType === "disabled") return noneConfig();

  const effort = get(body, "output_config.effort");

  if (
    get(body, "thinking") === undefined ||
    thinkingType === "adaptive" ||
    thinkingType === "auto"
  ) {
    // Only an explicit effort counts (it also applies when thinking is omitted); otherwise upstream defaults apply.
    if (typeof effort === "string") {
      const value = normalize(effort);

      if (value === "") return EMPTY_CONFIG;

      return configFromEffortWord(value);
    }

    return EMPTY_CONFIG;
  }

  const budget = get(body, "thinking.budget_tokens");

  if (budget !== undefined) return configFromBudget(budget);

  if (thinkingType === "enabled") {
    if (typeof effort === "string") {
      const value = normalize(effort);

      if (value !== "") return configFromEffortWord(value);
    }

    return autoConfig();
  }

  return EMPTY_CONFIG;
};

/** Gemini (`generationConfig.thinkingConfig`) and Antigravity (`request.` prefix): level first, then budget. */
export const extractGeminiConfig = (body: Json | undefined, provider: string): ThinkingConfig => {
  const prefix =
    provider === "antigravity"
      ? "request.generationConfig.thinkingConfig"
      : "generationConfig.thinkingConfig";

  // The official Python SDK sends snake_case names.
  const level = getFirst(body, [`${prefix}.thinkingLevel`, `${prefix}.thinking_level`]);

  if (level !== undefined) {
    const value = asString(level);

    if (value === "none") return noneConfig();

    if (value === "auto") return autoConfig();

    return levelConfig(value);
  }

  const budget = getFirst(body, [`${prefix}.thinkingBudget`, `${prefix}.thinking_budget`]);

  if (budget !== undefined) return configFromBudget(budget);

  return EMPTY_CONFIG;
};

const INTERACTIONS_LEVEL_PATHS = [
  "generation_config.thinking_level",
  "generation_config.thinkingLevel",
  "generation_config.thinking_config.thinking_level",
  "generation_config.thinking_config.thinkingLevel",
  "generation_config.thinkingConfig.thinking_level",
  "generation_config.thinkingConfig.thinkingLevel",
];

const INTERACTIONS_BUDGET_PATHS = [
  "generation_config.thinking_budget",
  "generation_config.thinkingBudget",
  "generation_config.thinking_config.thinking_budget",
  "generation_config.thinking_config.thinkingBudget",
  "generation_config.thinkingConfig.thinking_budget",
  "generation_config.thinkingConfig.thinkingBudget",
];

export const extractInteractionsConfig = (body: Json | undefined): ThinkingConfig => {
  for (const path of INTERACTIONS_LEVEL_PATHS) {
    const level = get(body, path);

    if (level === undefined) continue;

    return configFromEffortWord(normalize(asString(level)));
  }

  for (const path of INTERACTIONS_BUDGET_PATHS) {
    const budget = get(body, path);

    if (budget === undefined) continue;

    return configFromBudget(budget);
  }

  return EMPTY_CONFIG;
};

/** `reasoning_effort` (Chat Completions); `none` disables. The value is not normalised. */
export const extractOpenAIConfig = (body: Json | undefined): ThinkingConfig => {
  const effort = get(body, "reasoning_effort");

  if (effort === undefined) return EMPTY_CONFIG;
  const value = asString(effort);

  return value === "none" ? noneConfig() : levelConfig(value);
};

/**
 * Kimi's native `thinking` object, with `reasoning_effort` as a legacy fallback. `thinking.type="enabled"` without an
 * effort means "use the upstream default" and yields the empty config.
 */
export const extractKimiConfig = (body: Json | undefined): ThinkingConfig => {
  const thinkingType = get(body, "thinking.type");
  const effort = get(body, "thinking.effort");

  if (thinkingType !== undefined) {
    switch (normalize(asString(thinkingType))) {
      case "disabled":
        return noneConfig();
      case "enabled":
        if (effort === undefined) return EMPTY_CONFIG;
    }
  }

  if (effort !== undefined) {
    const value = normalize(asString(effort));

    if (value === "") return EMPTY_CONFIG;

    return configFromEffortWord(value);
  }

  // A native thinking object without effort is left for the upstream and must not be overridden by the legacy field.
  if (thinkingType !== undefined) return EMPTY_CONFIG;

  return extractOpenAIConfig(body);
};

/** Codex / Responses: `reasoning.effort`. */
export const extractCodexConfig = (body: Json | undefined): ThinkingConfig => {
  const effort = get(body, "reasoning.effort");

  if (effort === undefined) return EMPTY_CONFIG;
  const value = asString(effort);

  return value === "none" ? noneConfig() : levelConfig(value);
};

/** The last effective Responses update, falling back to the top-level effort. */
export const extractCodexUsageConfig = (body: Json | undefined): ThinkingConfig => {
  const update = extractConfigurationUpdateConfig(body);

  return hasThinkingConfig(update) ? update : extractCodexConfig(body);
};

/** Config from a body already in `provider`'s format. Unknown providers yield the empty config. */
export const extractThinkingConfig = (body: Json | undefined, provider: string): ThinkingConfig => {
  if (body === undefined) return EMPTY_CONFIG;

  switch (provider) {
    case "claude":
      return extractClaudeConfig(body);
    case "gemini":
    case "antigravity":
      return extractGeminiConfig(body, provider);
    case "interactions":
      return extractInteractionsConfig(body);
    case "openai":
      return extractOpenAIConfig(body);
    case "codex":
    case "xai":
      return extractCodexConfig(body);
    case "kimi":
    case "kimi-ai":
    case "kimi.ai":
    case "kimi.com":
      return extractKimiConfig(body);
    default:
      return EMPTY_CONFIG;
  }
};

/** Config from the client's source body (`openai-response` reads like Codex). */
export const extractSourceThinkingConfig = (
  body: Json | undefined,
  provider: string,
): ThinkingConfig => {
  const format = normalize(provider);

  return format === "openai-response"
    ? extractCodexConfig(body)
    : extractThinkingConfig(body, format);
};

const extractThinkingConfigForUsage = (
  body: Json | undefined,
  provider: string,
): ThinkingConfig => {
  switch (normalize(provider)) {
    case "codex":
    case "xai":
    case "openai-response":
      return extractCodexUsageConfig(body);
    case "claude": {
      // between_tools is how claude-sonnet-5-5 turns thinking off.
      if (getString(body, "thinking.type") === BETWEEN_TOOLS) return noneConfig();
      const config = extractThinkingConfig(body, provider);

      if (config.mode === "none" && hasThinkingConfig(config)) return config;
      // The last effort directive, not the cached top-level placeholder, is the turn's effort.
      const directive = extractClaudeEffortDirectiveConfig(body);

      return hasThinkingConfig(directive) ? directive : config;
    }

    default:
      return extractThinkingConfig(body, provider);
  }
};

/** Canonical `reasoning_effort` label for usage logging; "" when nothing is configured. */
export const reasoningEffortFromConfig = (config: ThinkingConfig): string => {
  if (!hasThinkingConfig(config)) return "";

  switch (config.mode) {
    case "none":
      return Level.none;
    case "auto":
      return Level.auto;
    case "level":
      return normalize(config.level);
    case "budget":
      return convertBudgetToLevel(config.budget) ?? "";
  }
};

/**
 * The source request's thinking setting as a `reasoning_effort` label. Responses updates take precedence over a
 * suffix (they describe the source turn); otherwise a valid suffix overrides the top-level setting.
 */
export const extractReasoningEffort = (
  body: Json | undefined,
  providerRaw: string,
  model: string,
): string => {
  const provider = normalize(providerRaw);

  if (isResponsesFormat(provider)) {
    const effort = reasoningEffortFromConfig(extractConfigurationUpdateConfig(body));

    if (effort !== "") return effort;
  }

  const suffix = parseSuffix(model);

  if (suffix.hasSuffix) {
    const effort = reasoningEffortFromConfig(parseSuffixToConfig(suffix.rawSuffix));

    if (effort !== "") return effort;
  }

  let config = extractThinkingConfigForUsage(body, provider);

  if (!hasThinkingConfig(config) && (provider === "openai-response" || provider === "openai")) {
    config = extractCodexUsageConfig(body);
  }

  return reasoningEffortFromConfig(config);
};

/** The final provider payload's thinking setting as a `reasoning_effort` label. */
export const extractTranslatedReasoningEffort = (
  body: Json | undefined,
  providerRaw: string,
): string => {
  const provider = normalize(providerRaw);
  let config = extractThinkingConfigForUsage(body, provider);

  if (!hasThinkingConfig(config) && (provider === "openai" || provider === "openai-response")) {
    config = extractCodexUsageConfig(body);

    if (!hasThinkingConfig(config)) config = extractOpenAIConfig(body);
  }

  return reasoningEffortFromConfig(config);
};

/**
 * The thinking level a request explicitly asks for, before model defaults, validation or clamping: what picks an
 * Antigravity thinking-group member (CLIProxyAPI 2f86992c, ffa55112).
 *
 * Go source: internal/thinking/apply.go (`RequestedAntigravityThinkingLevel`) and internal/thinking/antigravity_intent.go
 * (`extractAntigravityOpenAIThinking`, `extractAntigravityInteractionsThinking`, `applyAntigravityRawEffort`).
 */
import { asInt, get, isJsonObject, type Json } from "@commissary/json";
import { convertBudgetToLevel } from "./convert.ts";
import { extractThinkingConfigForUsage } from "./extract.ts";
import { extractOpenAIGoogleExtraBodyThinkingConfig } from "./google-extra-body.ts";
import { parseSuffix, parseSuffixToConfig } from "./suffix.ts";
import {
  autoConfig,
  budgetConfig,
  EMPTY_CONFIG,
  hasThinkingConfig,
  Level,
  levelConfig,
  noneConfig,
} from "./types.ts";
import type { ThinkingConfig } from "./types.ts";

/** gjson `Result.String()` of a present value. */
const text = (value: Json | undefined): string => {
  if (value === undefined || value === null) return "";

  if (typeof value === "string") return value;

  if (typeof value === "number" || typeof value === "boolean") return String(value);

  return JSON.stringify(value);
};

/** `firstThinkingField`: the first path that exists (`null` included). */
const firstField = (root: Json | undefined, ...paths: string[]): Json | undefined => {
  for (const path of paths) {
    const value = get(root, path);

    if (value !== undefined) return value;
  }

  return undefined;
};

/** `geminiThinkingConfigFromValues`: a present level wins over a present budget. */
const configFromValues = (level: Json | undefined, budget: Json | undefined): ThinkingConfig => {
  if (level !== undefined) {
    const value = text(level);

    if (value === "none") return noneConfig();

    if (value === "auto") return autoConfig();

    return levelConfig(value);
  }

  if (budget !== undefined) {
    const value = asInt(budget);

    if (value === 0) return noneConfig();

    if (value === -1) return autoConfig();

    return budgetConfig(value);
  }

  return EMPTY_CONFIG;
};

interface Intent {
  level: Json | undefined;
  budget: Json | undefined;
}

/** `applyAntigravityRawEffort`: `auto` is a budget of -1, any other word a level. */
const applyRawEffort = (effort: string, intent: Intent): void => {
  const value = effort.trim().toLowerCase();

  if (value === "") return;

  if (value === "auto") intent.budget = -1;
  else intent.level = value;
};

/** `extractAntigravityOpenAIThinking`: the request converter's precedence, without its inferred defaults. */
const openAIIntent = (body: Json | undefined): ThinkingConfig => {
  const generation = firstField(body, "generationConfig", "generation_config");

  const intent: Intent = {
    level: get(generation, "thinkingConfig.thinkingLevel"),
    budget: get(generation, "thinkingConfig.thinkingBudget"),
  };

  applyRawEffort(text(get(body, "reasoning_effort")), intent);

  const level = firstField(
    generation,
    "thinkingConfig.thinking_level",
    "thinking_config.thinking_level",
    "thinking_config.thinkingLevel",
  );

  if (level !== undefined) intent.level = level;

  const budget = firstField(
    generation,
    "thinkingConfig.thinking_budget",
    "thinking_config.thinking_budget",
    "thinking_config.thinkingBudget",
  );

  if (budget !== undefined) intent.budget = budget;

  if (intent.level === undefined && intent.budget === undefined)
    return extractOpenAIGoogleExtraBodyThinkingConfig(body);

  return configFromValues(intent.level, intent.budget);
};

/** `extractAntigravityInteractionsThinking`. */
const interactionsIntent = (body: Json | undefined): ThinkingConfig => {
  const generation = firstField(body, "generation_config", "generationConfig");

  const intent: Intent = {
    level: firstField(
      generation,
      "thinking_level",
      "thinkingLevel",
      "thinking_config.thinking_level",
      "thinking_config.thinkingLevel",
      "thinkingConfig.thinking_level",
      "thinkingConfig.thinkingLevel",
    ),
    budget: firstField(
      generation,
      "thinking_budget",
      "thinkingBudget",
      "thinking_config.thinking_budget",
      "thinking_config.thinkingBudget",
      "thinkingConfig.thinking_budget",
      "thinkingConfig.thinkingBudget",
    ),
  };

  let effort = text(get(body, "reasoning.effort")).trim();

  if (effort === "") effort = text(get(body, "reasoning.thinking_level"));
  applyRawEffort(effort, intent);

  return configFromValues(intent.level, intent.budget);
};

/** The Gemini config under its snake_case `thinking_config` container. */
const snakeGeminiIntent = (body: Json | undefined, provider: string): ThinkingConfig => {
  const prefix =
    provider === "antigravity"
      ? "request.generationConfig.thinking_config"
      : "generationConfig.thinking_config";

  return configFromValues(
    firstField(body, `${prefix}.thinkingLevel`, `${prefix}.thinking_level`),
    firstField(body, `${prefix}.thinkingBudget`, `${prefix}.thinking_budget`),
  );
};

/**
 * `RequestedAntigravityThinkingLevel`: the explicit discrete thinking intent of `body` (in `providerRaw`'s format) for
 * `model`; `""` when none. A model suffix always wins, even one the static parser does not know; a numeric budget maps
 * to its canonical level; `auto` and `none` are no level.
 */
export const requestedAntigravityThinkingLevel = (
  body: Json | undefined,
  providerRaw: string,
  model: string,
): string => {
  const provider = providerRaw.trim().toLowerCase();
  const suffix = parseSuffix(model);
  let config: ThinkingConfig;

  if (suffix.hasSuffix) {
    config = parseSuffixToConfig(suffix.rawSuffix.trim());

    // A catalog may advertise a discrete level the static parser does not know yet.
    if (!hasThinkingConfig(config)) config = levelConfig(suffix.rawSuffix);
  } else if (provider === "openai") {
    config = openAIIntent(body);
  } else if (provider === "interactions") {
    config = interactionsIntent(body);
  } else {
    config = isJsonObject(body) ? extractThinkingConfigForUsage(body, provider) : EMPTY_CONFIG;

    if (!hasThinkingConfig(config) && (provider === "gemini" || provider === "antigravity"))
      config = snakeGeminiIntent(body, provider);
  }

  switch (config.mode) {
    case "level": {
      const level = config.level.trim().toLowerCase();

      return level === Level.auto || level === Level.none ? "" : level;
    }

    case "budget":
      return config.budget > 0 ? (convertBudgetToLevel(config.budget) ?? "") : "";
    default:
      return "";
  }
};

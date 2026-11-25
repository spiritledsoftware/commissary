/**
 * Antigravity: Gemini's thinkingConfig under `request.generationConfig`, with extra normalisation for Claude
 * model ids (budget < max output, dropped when below the model minimum).
 *
 * Go source: internal/thinking/provider/antigravity/apply.go.
 */
import { asInt, get, type Json } from "@commissary/json";
import { delPath, ensureBody, setPath } from "../json.ts";
import { isUserDefinedModel } from "../types.ts";
import type { ProviderApplier, ThinkingConfig, ThinkingModelInfo } from "../types.ts";
import { applyBudgetFormat, applyLevelFormat, readIncludeThoughts } from "./google.ts";

const PREFIX = "request.generationConfig.thinkingConfig";

/** The snake_case spelling of {@link PREFIX}: replaced by the canonical object, its includeThoughts kept. */
const ALIAS_PREFIX = "request.generationConfig.thinking_config";

/** Drops the `thinking_config` alias, moving its includeThoughts to `thinkingConfig` when that has none. */
const dropAlias = (body: Json | undefined): Json | undefined => {
  if (get(body, ALIAS_PREFIX) === undefined) return body;
  const include = readIncludeThoughts(body, PREFIX) ?? readIncludeThoughts(body, ALIAS_PREFIX);
  let result = delPath(body, ALIAS_PREFIX);

  if (include !== undefined && readIncludeThoughts(result, PREFIX) === undefined)
    result = setPath(result, `${PREFIX}.includeThoughts`, include);

  return result;
};

/** Antigravity writes levels upper case (`HIGH`). */
const levelFormat = (body: Json | undefined, config: ThinkingConfig): Json | undefined => {
  const result = applyLevelFormat(dropAlias(body), config, PREFIX);
  const level = get(result, `${PREFIX}.thinkingLevel`);

  return typeof level === "string"
    ? setPath(result, `${PREFIX}.thinkingLevel`, level.trim().toUpperCase())
    : result;
};

const MAX_OUTPUT_PATH = "request.generationConfig.maxOutputTokens";

const isClaudeModel = (modelInfo: ThinkingModelInfo | undefined): boolean =>
  modelInfo !== undefined && modelInfo.id.toLowerCase().includes("claude");

interface EffectiveMaxTokens {
  readonly max: number;
  readonly fromModel: boolean;
}

interface NormalizedBudget {
  readonly budget: number | "removed";
  readonly body: Json | undefined;
}

/** Request maxOutputTokens, else the model default (`fromModel` = it must be written back). */
const effectiveMaxTokens = (
  payload: Json | undefined,
  modelInfo: ThinkingModelInfo,
): EffectiveMaxTokens => {
  const requested = get(payload, MAX_OUTPUT_PATH);

  if (requested !== undefined && asInt(requested) > 0)
    return { max: asInt(requested), fromModel: false };
  const modelMax = modelInfo.maxCompletionTokens ?? 0;

  return modelMax > 0 ? { max: modelMax, fromModel: true } : { max: 0, fromModel: false };
};

/** Ensures budget < max output; removes thinkingConfig (`"removed"`) when the budget is below the model minimum. */
const normalizeClaudeBudget = (
  budgetIn: number,
  payloadIn: Json | undefined,
  modelInfo: ThinkingModelInfo,
): NormalizedBudget => {
  let budget = budgetIn;
  let payload = payloadIn;
  const { max, fromModel } = effectiveMaxTokens(payload, modelInfo);

  if (max > 0 && budget >= max) budget = max - 1;

  const minBudget = modelInfo.thinking?.min ?? 0;

  if (minBudget > 0 && budget >= 0 && budget < minBudget) {
    return { budget: "removed", body: delPath(delPath(payload, PREFIX), ALIAS_PREFIX) };
  }

  if (fromModel && max > 0) payload = setPath(payload, MAX_OUTPUT_PATH, max);

  return { budget, body: payload };
};

const budgetFormat = (
  body: Json | undefined,
  modelInfo: ThinkingModelInfo | undefined,
  config: Parameters<typeof applyBudgetFormat>[1],
) =>
  applyBudgetFormat(
    dropAlias(body),
    config,
    PREFIX,
    isClaudeModel(modelInfo) && modelInfo !== undefined
      ? (budget, payload) => normalizeClaudeBudget(budget, payload, modelInfo)
      : undefined,
  );

export const antigravityApplier: ProviderApplier = {
  apply(body, config, modelInfo) {
    const userDefined = isUserDefinedModel(modelInfo);

    if (!userDefined && modelInfo?.thinking === undefined) return body;

    const root = ensureBody(body);

    if (config.mode === "auto" || config.mode === "budget")
      return budgetFormat(root, modelInfo, config);

    if (userDefined) {
      if (config.mode === "level" || (config.mode === "none" && config.level !== "")) {
        return levelFormat(root, config);
      }

      return budgetFormat(root, modelInfo, config);
    }

    // Known models choose the format from their capabilities.
    if ((modelInfo?.thinking?.levels?.length ?? 0) > 0) return levelFormat(root, config);

    return budgetFormat(root, modelInfo, config);
  },
};

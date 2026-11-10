/**
 * Central normalisation and validation of a canonical config against model capabilities.
 *
 * Go source: internal/thinking/validate.go (ValidateConfig, clampLevel, clampBudget, convertAutoToMidRange).
 * Logging from the Go code is dropped; the functions are pure.
 */
import { convertBudgetToLevel, convertLevelToBudget, detectModelCapability } from "./convert.ts";
import { ThinkingError, thinkingError } from "./errors.ts";
import { equalFold, normalize } from "./json.ts";
import { Level } from "./types.ts";
import type { ModelThinkingSupport, ThinkingConfig, ThinkingModelInfo } from "./types.ts";

/** Canonical ordering of standard levels, lowest to highest. */
export const STANDARD_LEVEL_ORDER: readonly string[] = [
  Level.minimal,
  Level.low,
  Level.medium,
  Level.high,
  Level.xhigh,
  Level.max,
];

export const isLevelSupported = (
  level: string,
  supported: readonly string[] | undefined,
): boolean => (supported ?? []).some((candidate) => equalFold(level, candidate.trim()));

const levelIndex = (level: string): number =>
  STANDARD_LEVEL_ORDER.findIndex((candidate) => equalFold(level, candidate));

/** The lowest canonical effort level in `supported`, ignoring mode markers such as `none` and `auto`. */
const lowestSupportedLevel = (supported: readonly string[]): string | undefined => {
  let best = -1;

  for (const candidate of supported) {
    const index = levelIndex(candidate.trim());

    if (index !== -1 && (best === -1 || index < best)) best = index;
  }

  return best === -1 ? undefined : STANDARD_LEVEL_ORDER[best];
};

const normalizeLevels = (levels: readonly string[]): string[] => levels.map(normalize);

/** Providers whose thinking can be expressed as a numeric budget. */
export const isBudgetCapableProvider = (provider: string): boolean =>
  provider === "gemini" || provider === "antigravity" || provider === "claude";

const isGeminiFamily = (provider: string): boolean =>
  provider === "gemini" || provider === "antigravity";

const isOpenAIFamily = (provider: string): boolean =>
  provider === "openai" || provider === "openai-response" || provider === "codex";

/** gemini∼antigravity and openai∼openai-response∼codex are interchangeable families; others only match themselves. */
export const isSameProviderFamily = (from: string, to: string): boolean =>
  from === to ||
  (isGeminiFamily(from) && isGeminiFamily(to)) ||
  (isOpenAIFamily(from) && isOpenAIFamily(to));

/** Clamps a level to the nearest supported standard level; ties prefer the lower level. */
export const clampLevel = (level: string, modelInfo: ThinkingModelInfo | undefined): string => {
  const supported = modelInfo?.thinking?.levels ?? [];

  if (supported.length === 0 || isLevelSupported(level, supported)) return level;

  const position = levelIndex(level);

  if (position === -1) return level;

  let bestIndex = -1;
  let bestDistance = STANDARD_LEVEL_ORDER.length + 1;

  for (const candidate of supported) {
    const index = levelIndex(candidate.trim());

    if (index === -1) continue;
    const distance = Math.abs(position - index);

    if (distance < bestDistance || (distance === bestDistance && index < bestIndex)) {
      bestIndex = index;
      bestDistance = distance;
    }
  }

  return bestIndex >= 0 ? (STANDARD_LEVEL_ORDER[bestIndex] ?? level) : level;
};

/** Clamps a budget to the model range; -1 (auto) passes through. */
export const clampBudget = (value: number, modelInfo: ThinkingModelInfo | undefined): number => {
  const support = modelInfo?.thinking;

  if (support === undefined) return value;

  if (value === -1) return value;

  const min = support.min ?? 0;
  const max = support.max ?? 0;

  if (value === 0 && support.zeroAllowed !== true) return min;

  // Level-only models do not define numeric budget ranges.
  if (min === 0 && max === 0) return value;

  if (value < min) return value === 0 && support.zeroAllowed === true ? 0 : min;

  if (value > max) return max;

  return value;
};

/** Converts auto to a fixed value when the model has no dynamic thinking. */
const convertAutoToMidRange = (
  config: ThinkingConfig,
  support: ModelThinkingSupport,
): ThinkingConfig => {
  const min = support.min ?? 0;
  const max = support.max ?? 0;

  // Level-only models (levels but no budget range) use the medium level.
  if ((support.levels?.length ?? 0) > 0 && min === 0 && max === 0) {
    return { mode: "level", level: Level.medium, budget: 0 };
  }

  const mid = Math.trunc((min + max) / 2);

  if (mid <= 0 && support.zeroAllowed === true) return { ...config, mode: "none", budget: 0 };

  if (mid <= 0) return { ...config, mode: "budget", budget: min };

  return { ...config, mode: "budget", budget: mid };
};

/** Mutable copy of a {@link ThinkingConfig} that {@link validateConfig} edits step by step. */
interface WorkingConfig {
  mode: ThinkingConfig["mode"];
  budget: number;
  level: string;
}

/** Result of {@link validateConfig}: the normalised config or the validation error. */
export type ValidateResult =
  | { readonly config: ThinkingConfig; readonly error?: undefined }
  | { readonly config?: undefined; readonly error: ThinkingError };

/**
 * Validates and normalises `config` for `modelInfo` (budget↔level conversion, level clamping/validation, budget
 * range checks, auto conversion, final clamping). `fromSuffix` relaxes strict budget validation to clamping.
 */
export const validateConfig = (
  input: ThinkingConfig,
  modelInfo: ThinkingModelInfo | undefined,
  fromFormatRaw: string,
  toFormatRaw: string,
  fromSuffix: boolean,
): ValidateResult => {
  const fromFormat = normalize(fromFormatRaw);
  const toFormat = normalize(toFormatRaw);
  const model = modelInfo !== undefined && modelInfo.id !== "" ? modelInfo.id : "unknown";
  const support = modelInfo?.thinking;
  let config: WorkingConfig = { ...input };

  if (support === undefined) {
    if (config.mode !== "none") {
      return {
        error: thinkingError(
          "THINKING_NOT_SUPPORTED",
          "thinking not supported for this model",
          model,
        ),
      };
    }

    return { config };
  }

  // Crossing provider families (or serving another family's model over a borrowed protocol, e.g. Kimi via the
  // Claude protocol) clamps unsupported levels instead of failing; same-family conversions are strict.
  const capability = detectModelCapability(modelInfo);
  const toHasLevelSupport = capability === "level-only" || capability === "hybrid";
  let modelFamilyMismatch = false;
  const modelType = normalize(modelInfo?.type ?? "");

  if (modelType !== "") {
    if (
      (fromFormat !== "" && !isSameProviderFamily(fromFormat, modelType)) ||
      (toFormat !== "" && !isSameProviderFamily(toFormat, modelType))
    ) {
      modelFamilyMismatch = true;
    }
  }

  const allowClampUnsupported =
    toHasLevelSupport && (!isSameProviderFamily(fromFormat, toFormat) || modelFamilyMismatch);

  const strictBudget =
    !fromSuffix &&
    fromFormat !== "" &&
    isSameProviderFamily(fromFormat, toFormat) &&
    !modelFamilyMismatch;

  let budgetDerivedFromLevel = false;

  if (capability === "budget-only") {
    if (config.mode === "level" && config.level !== Level.auto) {
      const budget = convertLevelToBudget(config.level);

      if (budget === undefined) {
        return { error: thinkingError("UNKNOWN_LEVEL", `unknown level: ${config.level}`) };
      }

      config = { mode: "budget", budget, level: "" };
      budgetDerivedFromLevel = true;
    }
  } else if (capability === "level-only") {
    if (config.mode === "budget") {
      const level = convertBudgetToLevel(config.budget);

      if (level === undefined) {
        return {
          error: thinkingError(
            "UNKNOWN_LEVEL",
            `budget ${config.budget} cannot be converted to a valid level`,
          ),
        };
      }

      // Clamp the derived standard level to the nearest supported one; none/auto are preserved.
      config = { mode: "level", level: clampLevel(level, modelInfo), budget: 0 };
    }
  }

  if (config.mode === "level" && config.level === Level.none)
    config = { mode: "none", budget: 0, level: "" };

  if (config.mode === "level" && config.level === Level.auto)
    config = { mode: "auto", budget: -1, level: "" };

  if (config.mode === "budget" && config.budget === 0)
    config = { ...config, mode: "none", level: "" };

  const levels = support.levels ?? [];

  if (levels.length > 0 && config.mode === "level" && !isLevelSupported(config.level, levels)) {
    if (allowClampUnsupported) config.level = clampLevel(config.level, modelInfo);

    if (!isLevelSupported(config.level, levels)) {
      const valid = normalizeLevels(levels).join(", ");

      return {
        error: thinkingError(
          "LEVEL_NOT_SUPPORTED",
          `level ${JSON.stringify(config.level.toLowerCase())} not supported, valid levels: ${valid}`,
        ),
      };
    }
  }

  const min = support.min ?? 0;
  const max = support.max ?? 0;

  if (
    strictBudget &&
    config.mode === "budget" &&
    !budgetDerivedFromLevel &&
    (min !== 0 || max !== 0)
  ) {
    if (
      config.budget < min ||
      config.budget > max ||
      (config.budget === 0 && support.zeroAllowed !== true)
    ) {
      return {
        error: thinkingError(
          "BUDGET_OUT_OF_RANGE",
          `budget ${config.budget} out of range [${min},${max}]`,
        ),
      };
    }
  }

  if (config.mode === "auto" && support.dynamicAllowed !== true) {
    config = { ...convertAutoToMidRange(config, support) };

    // The canonical medium level may be missing from a discrete level subset: clamp the generated fallback.
    if (config.mode === "level" && levels.length > 0 && !isLevelSupported(config.level, levels)) {
      config.level = clampLevel(config.level, modelInfo);
    }
  }

  if (config.mode === "none" && toFormat === "claude") {
    const lowest = support.zeroAllowed === true ? undefined : lowestSupportedLevel(levels);

    if (lowest !== undefined) {
      // Adaptive-only Claude models (claude-opus-5-5, claude-fable-5, ...) reject thinking.type="disabled". Like
      // other models that cannot be disabled, they fall back to their lowest supported level.
      config.mode = "level";
      config.budget = 0;
      config.level = lowest;
    } else {
      // Claude disables explicitly via thinking.type="disabled" (or the model's disableType); keep budget 0 so the
      // applier omits budget_tokens.
      config.budget = 0;
      config.level = "";
    }
  } else {
    if (config.mode === "budget" || config.mode === "auto" || config.mode === "none") {
      config.budget = clampBudget(config.budget, modelInfo);
    }

    // A model that cannot be disabled falls back to its lowest level.
    const cannotDisableLevelModel =
      support.zeroAllowed !== true && !isLevelSupported(Level.none, levels);

    if (
      config.mode === "none" &&
      levels.length > 0 &&
      (config.budget > 0 || cannotDisableLevelModel)
    ) {
      config.level = lowestSupportedLevel(levels) ?? config.level;
    }
  }

  return { config };
};

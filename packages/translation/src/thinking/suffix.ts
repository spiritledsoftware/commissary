/**
 * Model-name thinking suffix parsing: `model(value)`.
 *
 * Go source: internal/thinking/suffix.go, plus `parseSuffixToConfig` from internal/thinking/apply.go and
 * `preserveResolvedModelSuffix` from sdk/cliproxy/auth/oauth_model_alias.go.
 */
import {
  autoConfig,
  budgetConfig,
  EMPTY_CONFIG,
  hasThinkingConfig,
  Level,
  levelConfig,
  noneConfig,
} from "./types.ts";
import type { SuffixResult, ThinkingConfig, ThinkingMode } from "./types.ts";

/** Splits `model(value)`: the last `(` up to a final `)` (the model must end with `)`). */
export const parseSuffix = (model: string): SuffixResult => {
  const lastOpen = model.lastIndexOf("(");

  if (lastOpen === -1 || !model.endsWith(")"))
    return { modelName: model, hasSuffix: false, rawSuffix: "" };

  return {
    modelName: model.slice(0, lastOpen),
    hasSuffix: true,
    rawSuffix: model.slice(lastOpen + 1, -1),
  };
};

/** Re-attaches the request's suffix unless `resolved` already has one (Go `preserveResolvedModelSuffix`). */
export const preserveSuffix = (resolved: string, request: SuffixResult): string => {
  const trimmed = resolved.trim();

  if (trimmed === "") return "";

  if (parseSuffix(trimmed).hasSuffix) return trimmed;

  return request.hasSuffix && request.rawSuffix !== ""
    ? `${trimmed}(${request.rawSuffix})`
    : trimmed;
};

const MAX_INT64 = 9223372036854775807n;

/** strconv.Atoi followed by the non-negative check: digits with an optional sign, no overflow of int64. */
export const parseNumericSuffix = (rawSuffix: string): number | undefined => {
  if (!/^[+-]?\d+$/.test(rawSuffix)) return undefined;
  const value = BigInt(rawSuffix);

  if (value < 0n || value > MAX_INT64) return undefined;

  return Number(value);
};

/** `none`, `auto` and `-1` (case-insensitive). */
export const parseSpecialSuffix = (rawSuffix: string): ThinkingMode | undefined => {
  switch (rawSuffix.toLowerCase()) {
    case "none":
      return "none";
    case "auto":
    case "-1":
      return "auto";
    default:
      return undefined;
  }
};

const SUFFIX_LEVELS: ReadonlySet<string> = new Set([
  Level.minimal,
  Level.low,
  Level.medium,
  Level.high,
  Level.xhigh,
  Level.max,
]);

/** Discrete level names (not `none`/`auto`), case-insensitive; returns the lowercase level. */
export const parseLevelSuffix = (rawSuffix: string): string | undefined => {
  const lower = rawSuffix.toLowerCase();

  return SUFFIX_LEVELS.has(lower) ? lower : undefined;
};

/**
 * Interprets a raw suffix: special values, then levels, then non-negative integers (0 → none). Anything else yields
 * the empty config (the suffix is ignored but still stripped from the upstream model name by callers).
 */
export const parseSuffixToConfig = (rawSuffix: string): ThinkingConfig => {
  const special = parseSpecialSuffix(rawSuffix);

  if (special === "none") return noneConfig();

  if (special === "auto") return autoConfig();

  const level = parseLevelSuffix(rawSuffix);

  if (level !== undefined) return levelConfig(level);

  const budget = parseNumericSuffix(rawSuffix);

  if (budget !== undefined) return budget === 0 ? noneConfig() : budgetConfig(budget);

  return EMPTY_CONFIG;
};

/** Whether the model's suffix is a thinking config (`model(high)`), not an ignored one (`model(preview)`). */
export const hasThinkingSuffix = (model: string): boolean => {
  const suffix = parseSuffix(model);

  return suffix.hasSuffix && hasThinkingConfig(parseSuffixToConfig(suffix.rawSuffix));
};

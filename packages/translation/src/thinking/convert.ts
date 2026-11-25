/**
 * Level/budget conversion helpers and model capability detection.
 *
 * Go source: internal/thinking/convert.go.
 */
import { equalFold, normalize } from "./json.ts";
import { Level } from "./types.ts";
import type { ThinkingModelInfo } from "./types.ts";

const LEVEL_TO_BUDGET: ReadonlyMap<string, number> = new Map([
  ["none", 0],
  ["auto", -1],
  ["minimal", 512],
  ["low", 1024],
  ["medium", 8192],
  ["high", 24576],
  ["xhigh", 32768],
  ["max", 128000],
]);

/** Standard level → budget mapping (case-insensitive); `undefined` for unknown levels. */
export const convertLevelToBudget = (level: string): number | undefined =>
  LEVEL_TO_BUDGET.get(level.toLowerCase());

export const THRESHOLD_MINIMAL = 512;

export const THRESHOLD_LOW = 1024;

export const THRESHOLD_MEDIUM = 8192;

export const THRESHOLD_HIGH = 24576;

export const THRESHOLD_XHIGH = 32768;

/** Budget → its canonical level (above xhigh's 32768 is max); `undefined` for invalid negatives (< -1). */
export const convertBudgetToLevel = (budget: number): string | undefined => {
  if (budget < -1) return undefined;

  if (budget === -1) return Level.auto;

  if (budget === 0) return Level.none;

  if (budget <= THRESHOLD_MINIMAL) return Level.minimal;

  if (budget <= THRESHOLD_LOW) return Level.low;

  if (budget <= THRESHOLD_MEDIUM) return Level.medium;

  if (budget <= THRESHOLD_HIGH) return Level.high;

  if (budget <= THRESHOLD_XHIGH) return Level.xhigh;

  return Level.max;
};

/** Case-insensitive, trimmed membership test. */
export const hasLevel = (levels: readonly string[] | undefined, target: string): boolean =>
  (levels ?? []).some((level) => equalFold(level.trim(), target));

/** Maps a generic level to Claude adaptive effort (low/medium/high/max). */
export const mapToClaudeEffort = (level: string, supportsMax: boolean): string | undefined => {
  const value = normalize(level);

  switch (value) {
    case "":
      return undefined;
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
      return value;
    case "xhigh":
    case "max":
      return supportsMax ? "max" : "high";
    case "auto":
      return "high";
    default:
      return undefined;
  }
};

export type ModelCapability = "unknown" | "none" | "budget-only" | "level-only" | "hybrid";

/** Classifies how a model accepts thinking configuration (`unknown` when there is no model info at all). */
export const detectModelCapability = (
  modelInfo: ThinkingModelInfo | undefined,
): ModelCapability => {
  if (modelInfo === undefined) return "unknown";
  const support = modelInfo.thinking;

  if (support === undefined) return "none";
  const hasBudget = (support.min ?? 0) > 0 || (support.max ?? 0) > 0;
  const hasLevels = (support.levels?.length ?? 0) > 0;

  if (hasBudget && hasLevels) return "hybrid";

  if (hasBudget) return "budget-only";

  if (hasLevels) return "level-only";

  return "none";
};

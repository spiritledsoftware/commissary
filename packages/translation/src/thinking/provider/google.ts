/**
 * Level/budget formats shared by the Gemini and Antigravity appliers. Both write a `thinkingConfig` object; the
 * only difference is its path prefix (`generationConfig.thinkingConfig` vs `request.generationConfig.thinkingConfig`).
 *
 * Go source: internal/thinking/provider/gemini/apply.go and internal/thinking/provider/antigravity/apply.go
 * (applyLevelFormat, applyBudgetFormat, apply*IncludeThoughts).
 */
import { get, type Json } from "@commissary/json";
import { delPath, delPaths, setPath } from "../json.ts";
import type { ThinkingConfig } from "../types.ts";

/** An explicit `includeThoughts`/`include_thoughts` boolean present in the body before it is rewritten. */
export const readIncludeThoughts = (
  body: Json | undefined,
  prefix: string,
): boolean | undefined => {
  for (const key of ["includeThoughts", "include_thoughts"]) {
    const value = get(body, `${prefix}.${key}`);

    if (typeof value === "boolean") return value;
  }

  return undefined;
};

const restoreIncludeThoughts = (
  body: Json | undefined,
  prefix: string,
  include: boolean | undefined,
) => (include === undefined ? body : setPath(body, `${prefix}.includeThoughts`, include));

/** Drops the amount fields of the other format and the includeThoughts spellings (restored afterwards). */
const clearConflicting = (
  body: Json | undefined,
  prefix: string,
  keys: readonly string[],
): Json | undefined =>
  delPaths(
    body,
    [...keys, "includeThoughts", "include_thoughts"].map((key) => `${prefix}.${key}`),
  );

/**
 * `thinkingLevel` format. ModeNone with budget 0 and no level removes the whole thinkingConfig (visibility is
 * irrelevant then, and restoring includeThoughts alone would let a default-on model think again).
 */
export const applyLevelFormat = (
  body: Json | undefined,
  config: ThinkingConfig,
  prefix: string,
): Json | undefined => {
  // Budget conversion is done by the upper layer: only none and level are handled here.
  if (config.mode !== "none" && config.mode !== "level") return body;

  const include = readIncludeThoughts(body, prefix);

  let result = clearConflicting(body, prefix, [
    "thinkingBudget",
    "thinking_budget",
    "thinking_level",
  ]);

  if (config.mode === "none") {
    if (config.budget === 0 && config.level === "") return delPath(result, prefix);

    if (config.level !== "") result = setPath(result, `${prefix}.thinkingLevel`, config.level);

    return restoreIncludeThoughts(result, prefix, include);
  }

  result = setPath(result, `${prefix}.thinkingLevel`, config.level);

  return restoreIncludeThoughts(result, prefix, include);
};

/** `thinkingBudget` format (also `-1` for auto). `normalize` lets Antigravity apply its Claude constraints. */
export const applyBudgetFormat = (
  body: Json | undefined,
  config: ThinkingConfig,
  prefix: string,
  normalize?: (
    budget: number,
    body: Json | undefined,
  ) => { readonly budget: number | "removed"; readonly body: Json | undefined },
): Json | undefined => {
  const include = readIncludeThoughts(body, prefix);

  let result = clearConflicting(body, prefix, [
    "thinkingLevel",
    "thinking_level",
    "thinking_budget",
  ]);

  let budget = config.budget;

  if (normalize !== undefined) {
    const normalized = normalize(budget, result);
    result = normalized.body;

    // The thinking amount was removed entirely, and its visibility control with it.
    if (normalized.budget === "removed") return result;
    budget = normalized.budget;
  }

  result = setPath(result, `${prefix}.thinkingBudget`, budget);

  return restoreIncludeThoughts(result, prefix, include);
};

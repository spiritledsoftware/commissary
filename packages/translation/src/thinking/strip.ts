/**
 * Removal of thinking configuration for models without thinking support.
 *
 * Go source: internal/thinking/strip.go.
 */
import type { Json } from "@commissary/json";
import { delIfEmptyObject, delPaths } from "./json.ts";

const STRIP_PATHS: ReadonlyMap<string, readonly string[]> = new Map([
  ["claude", ["thinking", "output_config.effort"]],
  ["gemini", ["generationConfig.thinkingConfig"]],
  ["antigravity", ["request.generationConfig.thinkingConfig"]],
  [
    "interactions",
    [
      "generation_config.thinking_level",
      "generation_config.thinkingLevel",
      "generation_config.thinking_budget",
      "generation_config.thinkingBudget",
      "generation_config.thinking_summaries",
      "generation_config.thinkingSummaries",
      "generation_config.thinking_config",
      "generation_config.thinkingConfig",
    ],
  ],
  ["openai", ["reasoning_effort", "reasoning"]],
  ["kimi", ["reasoning_effort", "thinking"]],
  ["kimi-ai", ["reasoning_effort", "thinking"]],
  ["kimi.ai", ["reasoning_effort", "thinking"]],
  ["kimi.com", ["reasoning_effort", "thinking"]],
  ["codex", ["reasoning"]],
  ["xai", ["reasoning"]],
]);

/**
 * Removes the provider's thinking fields; unknown providers and unparsable bodies are returned unchanged. The provider
 * name is matched case-insensitively and `openai-response` strips like `codex` (Go `6e6afab9`).
 */
export const stripThinkingConfig = (body: Json | undefined, format: string): Json | undefined => {
  if (body === undefined) return body;
  const normalized = format.trim().toLowerCase();
  const provider = normalized === "openai-response" ? "codex" : normalized;
  const paths = STRIP_PATHS.get(provider);

  if (paths === undefined) return body;

  let result = delPaths(body, paths);

  // Do not leave an empty output_config object when effort was its only field.
  if (provider === "claude") result = delIfEmptyObject(result, "output_config");

  return result;
};

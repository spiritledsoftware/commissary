/**
 * Claude mid-conversation effort directives.
 *
 * Go source: internal/thinking/claude_effort_directive.go.
 */
import { get, type Json } from "@commissary/json";
import { getString, normalize } from "./json.ts";
import { autoConfig, EMPTY_CONFIG, levelConfig, noneConfig } from "./types.ts";
import type { ThinkingConfig } from "./types.ts";

/**
 * The effort of the last Claude mid-conversation effort directive in `body`, lowercased, or "" when there is none
 * or the request turns thinking off (`thinking.type` `disabled` or `between_tools`).
 *
 * A directive is a role=system message carrying `output_config.effort` (mid-conversation-output-config beta). It
 * sets the effort for every later reply, so the last one is the effort of the current turn. Clients that send
 * directives keep the top-level `output_config.effort` fixed for prompt caching, which makes that value a
 * placeholder rather than the requested effort.
 */
export const claudeEffortDirective = (body: Json | undefined): string => {
  if (body === undefined) return "";

  switch (normalize(getString(body, "thinking.type"))) {
    case "disabled":
    case "between_tools":
      return "";
  }

  const messages = get(body, "messages");

  if (!Array.isArray(messages)) return "";
  let effort = "";

  for (const message of messages) {
    if (normalize(getString(message, "role")) !== "system") continue;
    const value = get(message, "output_config.effort");

    if (typeof value !== "string") continue;
    const normalized = normalize(value);

    if (normalized !== "") effort = normalized;
  }

  return effort;
};

export const extractClaudeEffortDirectiveConfig = (body: Json | undefined): ThinkingConfig => {
  const effort = claudeEffortDirective(body);

  switch (effort) {
    case "":
      return EMPTY_CONFIG;
    case "none":
      return noneConfig();
    case "auto":
      return autoConfig();
    default:
      return levelConfig(effort);
  }
};

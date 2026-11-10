/**
 * Claude mid-conversation effort directives.
 *
 * Go source: internal/thinking/claude_effort_directive.go (`ClaudeEffortDirective`). Kept local to Devin: the Claude
 * translators read the directives themselves.
 */
import { asString, get, isJsonArray, type Json } from "@commissary/json";

/**
 * The effort of the last mid-conversation effort directive of a Claude request, lowercased, or `""` when there is none
 * or the request turns thinking off (`thinking.type` `disabled` or `between_tools`).
 *
 * A directive is a `role: system` message carrying `output_config.effort` (the mid-conversation-output-config beta);
 * it sets the effort of every later reply, so the last one is the effort of the current turn. Clients that send
 * directives keep the top-level `output_config.effort` fixed for prompt caching, which makes that value a placeholder.
 */
export const claudeEffortDirective = (body: Json | undefined): string => {
  const thinkingType = asString(get(body, "thinking.type")).trim().toLowerCase();

  if (thinkingType === "disabled" || thinkingType === "between_tools") return "";
  const messages = get(body, "messages");

  if (!isJsonArray(messages)) return "";
  let effort = "";

  for (const message of messages) {
    if (asString(get(message, "role")).trim().toLowerCase() !== "system") continue;
    const value = get(message, "output_config.effort");

    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();

    if (normalized !== "") effort = normalized;
  }

  return effort;
};

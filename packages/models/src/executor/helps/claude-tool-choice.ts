/**
 * Forced tool_choice on Claude 5.5.
 *
 * Go source: internal/runtime/executor/helps/claude_tool_choice.go (`NormalizeClaudeToolChoice`) and the `claude55Model`
 * pattern of helps/antigravity_structured_output.go, called from claude_executor_execute.go, claude_executor_stream.go
 * and claude_executor_tokens.go (CLIProxyAPI 1d45a5f3).
 *
 * Opus 5.5 and Sonnet 5.5 reject forced tool use (`tool_choice` `any` or `tool`), so it is rewritten to `auto`. The
 * pipeline runs this before thinking preparation, so the forced-mode cleanup (`disableThinkingIfToolChoiceForced`)
 * never discards `thinking`, `output_config.effort` or signed history, and the preserved-thinking binding then applies.
 * Haiku 5.5 is deliberately outside the pattern, as in Go.
 */
import type { JsonObject } from "@commissary/json";
import { isObj, str } from "@commissary/translation";
import { parseSuffix } from "@commissary/translation/thinking";

/** `claude55Model`: Opus/Sonnet 5.5 with an optional `-high`/`-reasoning` variant, 8-digit date and `[context]` suffix. */
export const CLAUDE_55_MODEL =
  /^claude-(?:opus|sonnet)-5-5(?:-(?:high|reasoning))?(?:-[0-9]{8})?(?:\[[^[\]]+\])?$/;

/** The model (thinking suffix removed, lower case) is Claude Opus 5.5 or Sonnet 5.5. */
export const isForcedToolRestrictedClaude55 = (model: string): boolean =>
  CLAUDE_55_MODEL.test(parseSuffix(model.trim()).modelName.toLowerCase());

/**
 * `NormalizeClaudeToolChoice`: downgrades `tool_choice` `any`/`tool` to `auto` (dropping the tool name, keeping
 * `disable_parallel_tool_use`) when the routed upstream model is Claude 5.5. Pass the model the request is sent to,
 * not the one in the client body. The Claude provider only: delegated providers (Kimi) keep their own contract.
 * User payload rules run afterwards and stay authoritative.
 */
export const normalizeClaudeToolChoice = (body: JsonObject, upstreamModel: string): void => {
  if (!isForcedToolRestrictedClaude55(upstreamModel)) return;
  const toolChoice = body.tool_choice;

  if (!isObj(toolChoice)) return;
  const type = str(toolChoice.type);

  if (type !== "any" && type !== "tool") return;
  toolChoice.type = "auto";
  delete toolChoice.name;
};

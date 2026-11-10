/**
 * Preserved-thinking block binding for Claude upstreams.
 *
 * Go source: internal/runtime/executor/claude_executor_request.go (applyClaudePreservedThinkingBinding,
 * claudeDocHasSignedThinkingBlock). Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable/Mythos 5.1+ check replayed signed
 * thinking blocks against the prefix they were created under; cloaking and relayed history reshape that prefix, so
 * the request would fail with a 400. `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` makes the
 * upstream drop the blocks that no longer match instead.
 *
 * Differences from Go (ADR 0019, ARCHITECTURE.md "Claude provider"): the model set includes Mythos (`classify.ts`),
 * and the binding is injected only for an absent or `adaptive` thinking type, because Anthropic's docs accept
 * `block_binding` on no other type (Go also injects for `enabled` on Opus 5.5 and Fable).
 */
import { get, type JsonObject } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";
import { isPreservedThinkingModel } from "./classify.ts";

/** A replayed thinking block with a reasoning signature, or a `redacted_thinking` block with data. */
const hasSignedThinkingBlock = (body: JsonObject): boolean => {
  const messages = body.messages;

  if (!isArr(messages)) return false;

  return messages.some((message) => {
    const content = get(message, "content");

    return (
      isArr(content) &&
      content.some((block) => {
        switch (str(get(block, "type")).trim()) {
          case "thinking":
            return str(get(block, "signature")).trim() !== "";
          case "redacted_thinking":
            return str(get(block, "data")).trim() !== "";
          default:
            return false;
        }
      })
    );
  });
};

/**
 * Defaults `thinking.block_binding.prefix_mismatch_behavior` to `drop_block` when the body replays signed thinking on
 * a preserved-thinking model. A body without `thinking` runs adaptive thinking on these models, so `{type:"adaptive"}`
 * is stated along with the binding. Left untouched: forced tool choice (the thinking was removed for it), a thinking
 * type other than `adaptive` (or none at all in a `thinking` object), and a caller-supplied behaviour. Runs
 * immediately before the user payload rules, which stay the last word.
 */
export const applyPreservedThinkingBinding = (body: JsonObject): void => {
  if (!isPreservedThinkingModel(str(body.model))) return;
  const toolChoiceType = str(get(body, "tool_choice.type"));

  if (toolChoiceType === "any" || toolChoiceType === "tool") return;
  const thinking = body.thinking;

  if (thinking !== undefined) {
    if (!isObj(thinking)) return;

    if (str(thinking.type).trim().toLowerCase() !== "adaptive") return;

    if (get(thinking, "block_binding.prefix_mismatch_behavior") !== undefined) return;
  }

  if (!hasSignedThinkingBlock(body)) return;

  const target: JsonObject = isObj(thinking) ? thinking : { type: "adaptive" };
  const existing = target.block_binding;
  const binding: JsonObject = isObj(existing) ? existing : {};
  binding.prefix_mismatch_behavior = "drop_block";
  target.block_binding = binding;
  body.thinking = target;
};

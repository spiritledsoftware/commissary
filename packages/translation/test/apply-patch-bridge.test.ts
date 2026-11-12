// Codex apply_patch bridge details that the Go golden corpus cannot express (transport end of a Claude stream).
import { describe, expect, it } from "vite-plus/test";
import type { Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const PATCH_TOOL = {
  type: "custom",
  name: "apply_patch",
  format: { type: "grammar", syntax: "lark", definition: "x" },
};

const line = (event: Json): string => `data: ${JSON.stringify(event)}`;

const START = line({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude",
    content: [],
    usage: { input_tokens: 1 },
  },
});

const TOOL_START = line({
  type: "content_block_start",
  index: 0,
  content_block: { type: "tool_use", id: "toolu_1", name: "apply_patch", input: {} },
});

const context = (tools: Json[]) => {
  const request = { model: "claude", input: "go", tools };

  return {
    model: "claude",
    originalRequest: request,
    translatedRequest: request,
    state: { ...makeTranslationState(), claudeInputTokensHandled: true },
  };
};

describe("apply_patch bridge (Claude -> Responses)", () => {
  it("fails a patch-enabled stream that ends before message_stop instead of completing it", () => {
    const ctx = context([PATCH_TOOL]);
    builtinTranslators.translateStream("openai-response", "claude", ctx, START);
    builtinTranslators.translateStream("openai-response", "claude", ctx, TOOL_START);
    expect(ctx.state.toolInputError).toBeUndefined();
    const frames = ctx.state.finalizeToolInput?.() ?? [];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("response.failed");
    expect(frames[0]).toContain("invalid_tool_arguments");
    expect(ctx.state.toolInputError).toBe(
      "upstream apply_patch stream ended before protocol completion",
    );
    // Later lines produce nothing once the failure is retained.
    expect(builtinTranslators.translateStream("openai-response", "claude", ctx, START)).toEqual([]);
  });

  it("does not fail streams without an apply_patch declaration or after completion", () => {
    const plain = context([{ type: "function", name: "shell", parameters: { type: "object" } }]);
    builtinTranslators.translateStream("openai-response", "claude", plain, START);
    expect(plain.state.finalizeToolInput?.()).toEqual([]);
    expect(plain.state.toolInputError).toBeUndefined();

    const done = context([PATCH_TOOL]);
    const stop = line({ type: "message_stop" });
    builtinTranslators.translateStream("openai-response", "claude", done, START);
    builtinTranslators.translateStream("openai-response", "claude", done, stop);
    expect(done.state.finalizeToolInput?.()).toEqual([]);
    expect(done.state.toolInputError).toBeUndefined();
  });
});

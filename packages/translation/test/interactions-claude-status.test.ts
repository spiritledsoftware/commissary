// Claude Messages -> Interactions terminal status (Go: internal/translator/claude/interactions/interactions_claude_test.go;
// upstream 237fa0e4).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import {
  convertClaudeResponseToInteractions,
  convertClaudeResponseToInteractionsNonStream,
} from "../src/translator/claude/interactions/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (): ResponseContext => ({
  model: "claude-test",
  originalRequest: parse(`{"input":"hi"}`),
  translatedRequest: undefined,
  state: makeTranslationState(),
});

const completedPayload = (chunks: ReadonlyArray<string>): Json | undefined => {
  const chunk = chunks.find((item) => item.startsWith("event: interaction.completed\n"));

  return chunk === undefined ? undefined : parse(chunk.split("\n")[1]?.slice(6) ?? "");
};

describe("Claude -> Interactions stop reasons (237fa0e4)", () => {
  it("waits for the stream's stop reason before completing", () => {
    const ctx = context();

    const usageOnly = convertClaudeResponseToInteractions(
      ctx,
      `data: {"type":"message_delta","usage":{"output_tokens":2}}`,
    );

    expect(completedPayload(usageOnly)).toBeUndefined();

    const terminal = convertClaudeResponseToInteractions(
      ctx,
      `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
    );

    expect(get(completedPayload(terminal), "interaction.status")).toBe("requires_action");
    expect(get(completedPayload(terminal), "interaction.usage.output_tokens")).toBe(2);
  });

  for (const [stopReason, status] of [
    ["tool_use", "requires_action"],
    ["max_tokens", "incomplete"],
    ["model_context_window_exceeded", "incomplete"],
    ["end_turn", "completed"],
  ] as const) {
    it(`maps ${stopReason} to ${status} (native non-stream)`, () => {
      const out = convertClaudeResponseToInteractionsNonStream(
        context(),
        `{"id":"msg_1","model":"claude-test","content":[],"stop_reason":"${stopReason}"}`,
      );

      expect(get(parse(out), "status")).toBe(status);
    });

    it(`maps ${stopReason} to ${status} (SSE non-stream)`, () => {
      const out = convertClaudeResponseToInteractionsNonStream(
        context(),
        `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"}}`,
      );

      expect(get(parse(out), "status")).toBe(status);
    });

    it(`maps ${stopReason} to ${status} (stream)`, () => {
      const out = convertClaudeResponseToInteractions(
        context(),
        `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"}}`,
      );

      expect(get(completedPayload(out), "interaction.status")).toBe(status);
    });
  }
});

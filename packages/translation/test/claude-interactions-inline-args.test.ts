// Interactions -> Claude Messages stream: arguments given inline on a function_call step.start (Go:
// internal/translator/interactions/claude/interactions_claude_test.go; upstream 37082b62).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { convertInteractionsResponseToClaude } from "../src/translator/interactions/claude/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (): ResponseContext => ({
  model: "gemini-3.1-flash-lite",
  originalRequest: parse(`{"messages":[]}`),
  translatedRequest: undefined,
  state: makeTranslationState(),
});

/** The `partial_json` of every `input_json_delta` the chunks carry. */
const partialJsons = (chunks: ReadonlyArray<string>): unknown[] =>
  chunks.flatMap((chunk) => {
    if (!chunk.startsWith("event: content_block_delta\n")) return [];
    const payload = parse(chunk.split("\n")[1]?.slice(6) ?? "");

    return get(payload, "delta.type") === "input_json_delta"
      ? [get(payload, "delta.partial_json")]
      : [];
  });

const run = (...lines: string[]): string[] => {
  const ctx = context();

  return lines.flatMap((line) => [...convertInteractionsResponseToClaude(ctx, line)]);
};

describe("Interactions -> Claude inline tool arguments (37082b62)", () => {
  it("emits the step.start arguments as an input_json_delta", () => {
    const out = run(
      `data: {"interaction":{"id":"interaction_1","model":"gemini-3.1-flash-lite"},"event_type":"interaction.created"}`,
      `data: {"index":0,"step":{"type":"function_call","id":"call_1","name":"lookup","arguments":{"q":"x"}},"event_type":"step.start"}`,
      `data: {"index":0,"event_type":"step.stop"}`,
    );

    expect(partialJsons(out)).toEqual([`{"q":"x"}`]);
  });

  it("emits string arguments as given", () => {
    const out = run(
      `data: {"index":0,"step":{"type":"function_call","id":"call_1","name":"lookup","args":"{\\"q\\":1}"},"event_type":"step.start"}`,
    );

    expect(partialJsons(out)).toEqual([`{"q":1}`]);
  });

  it("skips empty inline arguments so later fragments stay valid JSON", () => {
    const out = run(
      `data: {"index":0,"step":{"type":"function_call","id":"call_1","name":"lookup","arguments":{ }},"event_type":"step.start"}`,
      `data: {"index":0,"delta":{"type":"arguments_delta","arguments":"{\\"q\\":\\"x\\"}"},"event_type":"step.delta"}`,
    );

    expect(partialJsons(out)).toEqual([`{"q":"x"}`]);
  });

  it("skips blank string arguments", () => {
    const out = run(
      `data: {"index":0,"step":{"type":"function_call","id":"call_1","name":"lookup","arguments":"  "},"event_type":"step.start"}`,
    );

    expect(partialJsons(out)).toEqual([]);
  });
});

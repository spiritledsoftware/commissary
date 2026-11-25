// Codex (Responses) refusal parts -> Claude text (Go: internal/translator/codex/claude/codex_claude_response_test.go;
// upstream ca459712, e442c32d: only the Claude translator's part, which the codex-claude golden fixture pins).
import { describe, expect, it } from "vite-plus/test";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import {
  convertCodexResponseToClaude,
  convertCodexResponseToClaudeNonStream,
} from "../src/translator/codex/claude/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (): ResponseContext => ({
  model: "gpt-5.4",
  originalRequest: parse(`{"messages":[]}`),
  translatedRequest: undefined,
  state: makeTranslationState(),
});

/** The text of every `text_delta` the stream emitted, joined. */
const streamedText = (lines: ReadonlyArray<string>): string => {
  const ctx = context();
  let text = "";

  for (const line of lines) {
    for (const chunk of convertCodexResponseToClaude(ctx, line)) {
      for (const row of chunk.split("\n")) {
        if (!row.startsWith("data:")) continue;
        const payload = parse(row.slice(5).trim());

        if (get(payload, "delta.type") === "text_delta")
          text += asString(get(payload, "delta.text"));
      }
    }
  }

  return text;
};

const created = `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}`;

describe("Codex refusal parts -> Claude (ca459712, e442c32d)", () => {
  it("streams refusal deltas as text", () => {
    expect(
      streamedText([
        created,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}`,
        `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"refusal","refusal":""}}`,
        `data: {"type":"response.refusal.delta","output_index":0,"content_index":0,"delta":"I can't help with that."}`,
        `data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"refusal","refusal":"I can't help with that."}}`,
      ]),
    ).toBe("I can't help with that.");
  });

  it("keeps a message delivered only in output_item.done, refusal included", () => {
    expect(
      streamedText([
        created,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Only here."},{"type":"refusal","refusal":"x"},{"type":"refusal","text":"y"}]}}`,
      ]),
    ).toBe("Only here.xy");
  });

  it("does not count an empty delta as streamed text", () => {
    expect(
      streamedText([
        created,
        `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":""}`,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"late"}]}}`,
      ]),
    ).toBe("late");
  });

  it("keeps refusal parts in the non-stream response", () => {
    const out = convertCodexResponseToClaudeNonStream(
      context(),
      `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a"},{"type":"refusal","refusal":"b"},{"type":"refusal","text":"c"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}`,
    );

    expect(get(parse(out), "content")).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "text", text: "c" },
    ]);
  });
});

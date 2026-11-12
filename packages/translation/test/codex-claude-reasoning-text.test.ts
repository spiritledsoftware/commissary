// C9 PR B (Go a68c7d8e `extractCodexReasoningItemText`, and the issue comment on #376): Codex -> Claude fills in the
// reasoning text from `output_item.done` when no summary deltas streamed, and `response.reasoning_text.delta` streams
// like a summary delta.
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { describe, expect, it } from "vite-plus/test";
import { convertCodexResponseToClaude } from "../src/translator/codex/claude/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const context = (): ResponseContext => ({
  model: "gpt-5",
  originalRequest: { messages: [] },
  translatedRequest: undefined,
  state: makeTranslationState(),
});

/** The `content_block_*` events of the stream, reduced to `type[:text]`. */
const events = (lines: ReadonlyArray<Json>): string[] => {
  const ctx = context();
  const out: string[] = [];

  for (const line of lines) {
    for (const chunk of convertCodexResponseToClaude(ctx, `data: ${JSON.stringify(line)}`)) {
      for (const sse of chunk.split("\n")) {
        if (!sse.startsWith("data: ")) continue;
        const data = tryParseJson(sse.slice(6));
        const type = asString(get(data, "type"));

        if (type === "content_block_start")
          out.push(`start:${asString(get(data, "content_block.type"))}`);
        else if (type === "content_block_stop") out.push("stop");
        else if (type === "content_block_delta") {
          const delta = get(data, "delta");

          out.push(
            `${asString(get(delta, "type"))}:${asString(get(delta, "thinking")) || asString(get(delta, "signature"))}`,
          );
        }
      }
    }
  }

  return out;
};

const created = { type: "response.created", response: { id: "resp_1", model: "gpt-5" } };

describe("Codex reasoning text in the Claude stream (Go a68c7d8e)", () => {
  it("emits the summary of a done-only reasoning item as the thinking text, before its signature", () => {
    expect(
      events([
        created,
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Quiet " }, { text: "thought" }],
            encrypted_content: "enc_sig",
          },
        },
      ]),
    ).toEqual([
      "start:thinking",
      "thinking_delta:Quiet thought",
      "signature_delta:enc_sig",
      "stop",
    ]);
  });

  it("falls back to the reasoning_text content when there is no summary", () => {
    expect(
      events([
        created,
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            summary: [],
            content: [{ type: "reasoning_text", text: "from content" }],
            encrypted_content: "enc_sig",
          },
        },
      ]),
    ).toEqual(["start:thinking", "thinking_delta:from content", "signature_delta:enc_sig", "stop"]);
  });

  it("does not repeat text that streamed as reasoning_text deltas", () => {
    expect(
      events([
        created,
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        { type: "response.reasoning_text.delta", delta: "streamed" },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "streamed" }],
            encrypted_content: "enc_sig",
          },
        },
      ]),
    ).toEqual(["start:thinking", "thinking_delta:streamed", "signature_delta:enc_sig", "stop"]);
  });

  it("still emits a signature-only thinking block when the item has no text at all", () => {
    expect(
      events([
        created,
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        {
          type: "response.output_item.done",
          item: { type: "reasoning", encrypted_content: "enc_only" },
        },
      ]),
    ).toEqual(["start:thinking", "signature_delta:enc_only", "stop"]);
  });
});

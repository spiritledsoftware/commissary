// Codex (Responses) refusal parts -> OpenAI Chat, Gemini and Interactions (Go: codex_openai_response_test.go,
// codex_gemini_response_test.go, interactions_codex_test.go; upstream ca459712, e442c32d, 2e940ba1). The Claude
// translator's part is `codex-claude-refusal.test.ts`.
import { describe, expect, it } from "vite-plus/test";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import {
  convertCodexResponseToGemini,
  convertCodexResponseToGeminiNonStream,
} from "../src/translator/codex/gemini/response.ts";
import {
  convertCodexResponseToInteractions,
  convertCodexResponseToInteractionsNonStream,
} from "../src/translator/codex/interactions/response.ts";
import {
  convertCodexResponseToOpenAI,
  convertCodexResponseToOpenAINonStream,
} from "../src/translator/codex/openai-chat/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const REFUSAL = "I'm sorry, but I can't help with that request.";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (): ResponseContext => ({
  model: "muse-ember-1.0",
  originalRequest: parse(`{"messages":[]}`),
  translatedRequest: undefined,
  state: makeTranslationState(),
});

const created = `data: {"type":"response.created","response":{"id":"resp_1","model":"muse-ember-1.0"}}`;

const added = `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}`;

const delta = (text: string) =>
  `data: {"type":"response.refusal.delta","output_index":0,"item_id":"msg_1","delta":${JSON.stringify(text)}}`;

const done = `data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"refusal","refusal":${JSON.stringify(REFUSAL)}}]}}`;

const completed = `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}`;

const nonStream = (part: string) =>
  `{"type":"response.completed","response":{"id":"resp_1","model":"muse-ember-1.0","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[${part}]}]}}`;

const streams = {
  streamed: [created, added, delta(REFUSAL), done, completed],
  doneOnly: [created, done, completed],
  emptyDelta: [created, added, delta(""), done, completed],
};

/** The data payloads of every chunk a stream translator emitted for `lines`. */
const translate = (
  convert: (context: ResponseContext, line: string) => ReadonlyArray<string>,
  lines: ReadonlyArray<string>,
): Json[] => {
  const ctx = context();
  const payloads: Json[] = [];

  for (const line of lines) {
    for (const chunk of convert(ctx, line)) {
      const rows = chunk.split("\n").filter((row) => row.startsWith("data:"));

      if (rows.length === 0) payloads.push(parse(chunk));
      else
        for (const row of rows) {
          const data = row.slice(5).trim();

          if (data !== "[DONE]") payloads.push(parse(data));
        }
    }
  }

  return payloads;
};

const chatText = (lines: ReadonlyArray<string>): string =>
  translate(convertCodexResponseToOpenAI, lines)
    .map((chunk) => asString(get(chunk, "choices.0.delta.content")))
    .join("");

const geminiText = (lines: ReadonlyArray<string>): string =>
  translate(convertCodexResponseToGemini, lines)
    .flatMap((chunk) => {
      const parts = get(chunk, "candidates.0.content.parts");

      return Array.isArray(parts) ? parts.map((part) => asString(get(part, "text"))) : [];
    })
    .join("");

const interactionsText = (lines: ReadonlyArray<string>): string =>
  translate(convertCodexResponseToInteractions, lines)
    .map((event) =>
      get(event, "event_type") === "step.delta" ? asString(get(event, "delta.text")) : "",
    )
    .join("");

describe("Codex refusal parts -> OpenAI Chat (ca459712, e442c32d)", () => {
  it.each(Object.entries(streams))("%s: the refusal is emitted exactly once", (_, lines) => {
    expect(chatText(lines)).toBe(REFUSAL);
  });

  it("a new response resets the streamed-text state", () => {
    expect(chatText([...streams.streamed, created, done])).toBe(REFUSAL + REFUSAL);
  });

  it("reads refusal parts in the non-stream answer, falling back to text", () => {
    const ctx = context();

    const content = (part: string) =>
      get(
        parse(convertCodexResponseToOpenAINonStream(ctx, nonStream(part))),
        "choices.0.message.content",
      );

    expect(content(`{"type":"refusal","refusal":${JSON.stringify(REFUSAL)}}`)).toBe(REFUSAL);
    expect(content(`{"type":"refusal","refusal":"","text":${JSON.stringify(REFUSAL)}}`)).toBe(
      REFUSAL,
    );
  });
});

describe("Codex refusal parts -> Gemini (ca459712, 2e940ba1)", () => {
  it.each(Object.entries(streams))("%s: the refusal is emitted exactly once", (_, lines) => {
    expect(geminiText(lines)).toBe(REFUSAL);
  });

  it("reads refusal parts in the non-stream answer, falling back to text", () => {
    const ctx = context();

    const text = (part: string) =>
      get(
        parse(convertCodexResponseToGeminiNonStream(ctx, nonStream(part))),
        "candidates.0.content.parts.0.text",
      );

    expect(text(`{"type":"refusal","refusal":${JSON.stringify(REFUSAL)}}`)).toBe(REFUSAL);
    expect(text(`{"type":"refusal","refusal":"","text":${JSON.stringify(REFUSAL)}}`)).toBe(REFUSAL);
  });
});

describe("Codex refusal parts -> Interactions (ca459712, e442c32d)", () => {
  it.each(Object.entries(streams))("%s: the refusal is emitted exactly once", (_, lines) => {
    expect(interactionsText(lines)).toBe(REFUSAL);
  });

  it("reads refusal parts in the non-stream answer, refusal first", () => {
    const ctx = context();

    const text = (part: string) =>
      get(
        parse(convertCodexResponseToInteractionsNonStream(ctx, nonStream(part))),
        "steps.0.content.0.text",
      );

    expect(text(`{"type":"refusal","refusal":${JSON.stringify(REFUSAL)},"text":"other"}`)).toBe(
      REFUSAL,
    );
    expect(text(`{"type":"refusal","refusal":"","text":${JSON.stringify(REFUSAL)}}`)).toBe(REFUSAL);
  });
});

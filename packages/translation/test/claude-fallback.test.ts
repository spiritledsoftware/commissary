// Anthropic server-side fallback in the Claude -> Chat Completions and Responses translators: the serving model and
// the ordered fallback hops (Go: claude_openai_response_test.go, claude_openai-responses_response_test.go; fa11a573).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { str } from "../src/translator/common/gjson.ts";
import { claudeModelSameOrSnapshot } from "../src/translator/common/claude-fallback.ts";
import {
  convertClaudeResponseToOpenAI,
  convertClaudeResponseToOpenAINonStream,
} from "../src/translator/claude/openai/chat-completions/response.ts";
import {
  convertClaudeResponseToOpenAIResponses,
  convertClaudeResponseToOpenAIResponsesNonStream,
} from "../src/translator/claude/openai/responses/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (model: string, translatedRequest?: Json): ResponseContext => ({
  model,
  originalRequest: undefined,
  translatedRequest,
  state: makeTranslationState(),
});

const chat = (model: string, events: ReadonlyArray<string>, translatedRequest?: Json): Json[] => {
  const ctx = context(model, translatedRequest);

  return events.flatMap((event) => convertClaudeResponseToOpenAI(ctx, `data: ${event}`)).map(parse);
};

const responses = (
  model: string,
  events: ReadonlyArray<string>,
  translatedRequest?: Json,
): Array<{ event: string; data: Json }> => {
  const ctx = context(model, translatedRequest);

  return events
    .flatMap((event) => convertClaudeResponseToOpenAIResponses(ctx, `data: ${event}`))
    .map((frame) => ({
      event: /^event: (.+)$/mu.exec(frame)?.[1] ?? "",
      data: parse(/^data: (.+)$/mu.exec(frame)?.[1] ?? ""),
    }));
};

const start = (id: string, model: string) =>
  `{"type":"message_start","message":{"id":"${id}","model":"${model}","usage":{"input_tokens":10,"output_tokens":0}}}`;

const text = (index: number, value: string) => [
  `{"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}`,
  `{"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":"${value}"}}`,
  `{"type":"content_block_stop","index":${index}}`,
];

const fallbackBlock = (index: number, from: string, to: string, category: string) => [
  `{"type":"content_block_start","index":${index},"content_block":{"type":"fallback","from":{"model":"${from}"},"to":{"model":"${to}"},"trigger":{"type":"refusal","category":"${category}"}}}`,
  `{"type":"content_block_stop","index":${index}}`,
];

const ITERATIONS_55_TO_48 =
  '[{"type":"message","model":"claude-opus-5-5","output_tokens":2},{"type":"fallback_message","model":"claude-opus-4-8","output_tokens":4}]';

const end = (iterations?: string) => [
  `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6${iterations === undefined ? "" : `,"iterations":${iterations}`}}}`,
  '{"type":"message_stop"}',
];

const PRE_TOKEN = [
  start("msg_pre", "claude-opus-4-8"),
  ...text(0, "fallback answer"),
  ...end(ITERATIONS_55_TO_48),
];

const MID_STREAM = [
  start("msg_mid", "claude-opus-5-5"),
  ...text(0, "partial "),
  ...fallbackBlock(1, "claude-opus-5-5", "claude-opus-4-8", "cyber"),
  ...text(2, "fallback text"),
  ...end(ITERATIONS_55_TO_48),
];

const MULTI_HOP = [
  start("msg_chain", "claude-fable-5-1"),
  ...text(0, "partA "),
  ...fallbackBlock(1, "claude-fable-5-1", "claude-opus-5", "reasoning_extraction"),
  ...text(2, "partB "),
  ...fallbackBlock(3, "claude-opus-5", "claude-opus-4-8", "cyber"),
  ...text(4, "partC"),
  ...end(
    '[{"type":"message","model":"claude-fable-5-1","output_tokens":3},{"type":"fallback_message","model":"claude-opus-5","output_tokens":3},{"type":"fallback_message","model":"claude-opus-4-8","output_tokens":3}]',
  ),
];

const MID_STREAM_NATIVE = JSON.stringify({
  id: "msg_mid",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [
    { type: "text", text: "partial " },
    {
      type: "fallback",
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { type: "refusal", category: "cyber" },
    },
    { type: "text", text: "fallback text" },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 6, iterations: parse(ITERATIONS_55_TO_48) },
});

describe("Chat Completions", () => {
  it("reports the serving model of a pre-token fallback on every chunk", () => {
    const chunks = chat("claude-opus-5-5", PRE_TOKEN);

    expect(chunks.map((chunk) => get(chunk, "model"))).toEqual(chunks.map(() => "claude-opus-4-8"));
    expect(get(chunks[0], "choices.0.delta.fallback")).toEqual({
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
    });
  });

  it("switches the model at a mid-stream fallback block and reports the boundary", () => {
    const chunks = chat("claude-opus-5-5", MID_STREAM);

    expect(chunks.map((chunk) => get(chunk, "model"))).toEqual([
      "claude-opus-5-5",
      "claude-opus-5-5",
      "claude-opus-4-8",
      "claude-opus-4-8",
      "claude-opus-4-8",
      "claude-opus-4-8",
    ]);
    expect(get(chunks[2], "choices.0.delta.fallback")).toEqual({
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { type: "refusal", category: "cyber" },
    });
    expect(get(chunks[2], "choices.0.delta.fallbacks")).toHaveLength(1);
    expect(chunks.map((chunk) => str(get(chunk, "choices.0.delta.content"))).join("")).toBe(
      "partial fallback text",
    );
  });

  it("reports a fallback block even when message_start already names the target model", () => {
    const chunks = chat("claude-opus-5-5", [
      start("msg_pre_block", "claude-opus-4-8"),
      ...fallbackBlock(0, "claude-opus-5-5", "claude-opus-4-8", "reasoning_extraction"),
      ...text(1, "ok"),
      ...end(),
    ]);

    expect(
      chunks.some(
        (chunk) =>
          get(chunk, "choices.0.delta.fallback.trigger.category") === "reasoning_extraction",
      ),
    ).toBe(true);
  });

  it("reports the hops of a non-stream response with their content offsets", () => {
    const out = parse(
      convertClaudeResponseToOpenAINonStream(context("claude-opus-5-5"), MID_STREAM_NATIVE),
    );

    expect(get(out, "model")).toBe("claude-opus-4-8");
    expect(get(out, "choices.0.message.content")).toBe("partial fallback text");
    expect(get(out, "choices.0.message.fallback")).toEqual({
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { type: "refusal", category: "cyber" },
      content_offset: 8,
    });

    const chain = parse(
      convertClaudeResponseToOpenAINonStream(
        context("claude-fable-5-1"),
        MULTI_HOP.map((event) => `data: ${event}`).join("\n"),
      ),
    );

    expect(get(chain, "model")).toBe("claude-opus-4-8");
    expect(get(chain, "choices.0.message.fallbacks.0.content_offset")).toBe(6);
    expect(get(chain, "choices.0.message.fallbacks.1.content_offset")).toBe(12);
    expect(get(chain, "choices.0.message.fallbacks.1.from.model")).toBe("claude-opus-5");
  });

  it("reports a sticky fallbacks: default switch at message_start", () => {
    const chunks = chat("claude-opus-5-5", [start("msg_sticky", "claude-opus-4-8")], {
      model: "claude-opus-5-5",
      fallbacks: "default",
    });

    expect(get(chunks[0], "choices.0.delta.fallback.to.model")).toBe("claude-opus-4-8");
  });
});

describe("Responses", () => {
  it("reports a pre-token fallback on response.created and response.completed", () => {
    const events = responses("claude-opus-5-5", PRE_TOKEN);
    const created = events.find((event) => event.event === "response.created")?.data;
    const completed = events.find((event) => event.event === "response.completed")?.data;

    expect(get(created, "response.model")).toBe("claude-opus-4-8");
    expect(get(created, "response.fallback.from.model")).toBe("claude-opus-5-5");
    expect(get(completed, "response.model")).toBe("claude-opus-4-8");
    expect(get(completed, "response.fallback.to.model")).toBe("claude-opus-4-8");
  });

  it("emits response.in_progress at a mid-stream boundary and splits the message", () => {
    const events = responses("claude-opus-5-5", MID_STREAM);

    const boundary = events.find(
      (event) =>
        event.event === "response.in_progress" &&
        get(event.data, "response.fallback") !== undefined,
    )?.data;

    const completed = events.find((event) => event.event === "response.completed")?.data;

    expect(get(boundary, "response.model")).toBe("claude-opus-4-8");
    expect(get(boundary, "response.fallback.trigger.category")).toBe("cyber");
    expect(get(boundary, "response.fallback.output_index")).toBe(1);
    expect(get(completed, "response.model")).toBe("claude-opus-4-8");
    expect(get(completed, "response.fallback.output_index")).toBe(1);
    expect(get(completed, "response.output")).toHaveLength(2);

    const native = parse(
      convertClaudeResponseToOpenAIResponsesNonStream(
        context("claude-opus-5-5"),
        MID_STREAM_NATIVE,
      ),
    );

    expect(get(native, "model")).toBe("claude-opus-4-8");
    expect(get(native, "fallback.trigger.category")).toBe("cyber");
    expect(get(native, "fallback.output_index")).toBe(1);
  });

  it("keeps every hop of a multi-hop chain", () => {
    const completed = responses("claude-fable-5-1", MULTI_HOP).find(
      (event) => event.event === "response.completed",
    )?.data;

    expect(get(completed, "response.model")).toBe("claude-opus-4-8");
    expect(get(completed, "response.fallbacks.0.output_index")).toBe(1);
    expect(get(completed, "response.fallbacks.1.output_index")).toBe(2);
    expect(get(completed, "response.output")).toHaveLength(3);

    const nonStream = parse(
      convertClaudeResponseToOpenAIResponsesNonStream(
        context("claude-fable-5-1"),
        MULTI_HOP.map((event) => `data: ${event}`).join("\n\n"),
      ),
    );

    expect(get(nonStream, "fallbacks.0.output_index")).toBe(1);
    expect(get(nonStream, "fallbacks.1.output_index")).toBe(2);
  });

  it("reports nothing for a dated snapshot of the requested model", () => {
    const events = responses("claude-opus-5-5", [start("msg_snap", "claude-opus-5-5-20260501")]);

    expect(events.every((event) => get(event.data, "response.fallback") === undefined)).toBe(true);
    expect(claudeModelSameOrSnapshot("claude-opus-5-5", "claude-opus-5-5-20260501")).toBe(true);
    expect(claudeModelSameOrSnapshot("claude-opus-5-5", "claude-opus-5-5-2026")).toBe(false);
  });
});

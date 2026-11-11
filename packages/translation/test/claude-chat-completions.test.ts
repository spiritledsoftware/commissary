// Claude -> Chat Completions translators (Go: internal/translator/claude/openai/chat-completions/
// claude_openai_{request,response,stop_reasons}_test.go; upstream 0d18d3b3, df07b1e5, c2dfec28, aadb34f9, 43f5386b).
import { describe, expect, it } from "vitest";
import { get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { attachMessageCacheControl } from "../src/translator/common/cache-control.ts";
import { convertOpenAIRequestToClaude } from "../src/translator/claude/openai/chat-completions/request.ts";
import {
  convertClaudeResponseToOpenAI,
  convertClaudeResponseToOpenAINonStream,
} from "../src/translator/claude/openai/chat-completions/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";
import { withModelInfoLookup } from "../src/translator/model-info.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (): ResponseContext => ({
  model: "claude-test",
  originalRequest: undefined,
  translatedRequest: undefined,
  state: makeTranslationState(),
});

const stream = (events: ReadonlyArray<JsonObject>): Json[] => {
  const ctx = context();

  return events
    .flatMap((event) => convertClaudeResponseToOpenAI(ctx, `data: ${JSON.stringify(event)}`))
    .map(parse);
};

const textMessage = (stopReason: string, usage: JsonObject): JsonObject => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "partial" }],
  stop_reason: stopReason,
  usage,
});

const textStream = (stopReason: string, usage: JsonObject): JsonObject[] => [
  {
    type: "message_start",
    message: { id: "msg_1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 1 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: stopReason }, usage },
  { type: "message_stop" },
];

describe("model_context_window_exceeded on Chat Completions", () => {
  it("streams as finish_reason length and keeps the text and usage", () => {
    const chunks = stream(textStream("model_context_window_exceeded", { output_tokens: 3 }));

    expect(chunks.some((chunk) => get(chunk, "error") !== undefined)).toBe(false);
    expect(chunks.map((chunk) => get(chunk, "choices.0.delta.content")).filter(Boolean)).toEqual([
      "partial",
    ]);
    expect(chunks.map((chunk) => get(chunk, "choices.0.finish_reason")).filter(Boolean)).toEqual([
      "length",
    ]);
    expect(get(chunks.at(-1), "usage.completion_tokens")).toBe(3);
  });

  it("answers a non-stream body as length with the text and usage", () => {
    const out = parse(
      convertClaudeResponseToOpenAINonStream(
        context(),
        JSON.stringify(
          textMessage("model_context_window_exceeded", { input_tokens: 10, output_tokens: 3 }),
        ),
      ) ?? "",
    );

    expect(get(out, "error")).toBeUndefined();
    expect(get(out, "choices.0.finish_reason")).toBe("length");
    expect(get(out, "choices.0.message.content")).toBe("partial");
    expect(get(out, "usage.completion_tokens")).toBe(3);
  });

  it.each(["max_tokens", "model_context_window_exceeded"])(
    "keeps length when %s cut a tool call short",
    (reason) => {
      const events: JsonObject[] = [
        {
          type: "message_start",
          message: { id: "msg_tc", model: "claude-test", usage: { input_tokens: 5 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls -l' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ];

      const finish = stream(events)
        .map((chunk) => get(chunk, "choices.0.finish_reason"))
        .filter(Boolean);

      expect(finish).toEqual(["length"]);

      const nonStream = parse(
        convertClaudeResponseToOpenAINonStream(
          context(),
          JSON.stringify({
            id: "msg_tc",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [
              { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls -l" } },
            ],
            stop_reason: reason,
            usage: { input_tokens: 5, output_tokens: 4 },
          }),
        ) ?? "",
      );

      expect(get(nonStream, "choices.0.finish_reason")).toBe("length");
      expect(get(nonStream, "choices.0.message.tool_calls.0.function.name")).toBe("bash");
    },
  );

  it("still reports tool_calls for a tool_use stop", () => {
    const out = parse(
      convertClaudeResponseToOpenAINonStream(
        context(),
        JSON.stringify({
          id: "msg_tc",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }],
          stop_reason: "tool_use",
          usage: { input_tokens: 5, output_tokens: 4 },
        }),
      ) ?? "",
    );

    expect(get(out, "choices.0.finish_reason")).toBe("tool_calls");
  });
});

describe("thinking tokens as reasoning_tokens", () => {
  const withThinking = {
    input_tokens: 10,
    output_tokens: 38,
    output_tokens_details: { thinking_tokens: 23 },
  };

  it("rides the stream's message_delta and trailing usage chunk", () => {
    const chunks = stream(textStream("end_turn", withThinking));
    const withUsage = chunks.filter((chunk) => get(chunk, "usage") !== undefined);

    expect(withUsage).toHaveLength(2);

    for (const chunk of withUsage) {
      expect(get(chunk, "usage.completion_tokens")).toBe(38);
      expect(get(chunk, "usage.completion_tokens_details.reasoning_tokens")).toBe(23);
    }

    const trailing = chunks.at(-1);
    expect(get(trailing, "choices")).toEqual([]);
  });

  it("rides the non-stream usage", () => {
    const out = parse(
      convertClaudeResponseToOpenAINonStream(
        context(),
        JSON.stringify(textMessage("end_turn", { ...withThinking, output_tokens: 52 })),
      ) ?? "",
    );

    expect(get(out, "usage.completion_tokens")).toBe(52);
    expect(get(out, "usage.completion_tokens_details.reasoning_tokens")).toBe(23);
  });

  it("is left out when upstream does not report it, and keeps an explicit 0", () => {
    const plain = stream(textStream("end_turn", { input_tokens: 10, output_tokens: 38 }));

    for (const chunk of plain)
      expect(get(chunk, "usage.completion_tokens_details")).toBeUndefined();

    const nonStream = parse(
      convertClaudeResponseToOpenAINonStream(
        context(),
        JSON.stringify(textMessage("end_turn", { input_tokens: 10, output_tokens: 38 })),
      ) ?? "",
    );

    expect(get(nonStream, "usage.completion_tokens_details")).toBeUndefined();

    const zero = stream(
      textStream("end_turn", {
        input_tokens: 10,
        output_tokens: 38,
        output_tokens_details: { thinking_tokens: 0 },
      }),
    );

    expect(get(zero.at(-1), "usage.completion_tokens_details.reasoning_tokens")).toBe(0);
  });
});

const lookupWith = (maxCompletionTokens: Record<string, number>) => (id: string) =>
  id in maxCompletionTokens ? { id, maxCompletionTokens: maxCompletionTokens[id] } : undefined;

const request = (model: string, extra = ""): string =>
  `{"model":"${model}"${extra},"messages":[{"role":"user","content":"hi"}]}`;

const maxTokensFor = (model: string, extra = ""): Json | undefined =>
  get(convertOpenAIRequestToClaude(model, parse(request(model, extra)), false), "max_tokens");

describe("the default max_tokens", () => {
  const lookup = lookupWith({
    "claude-opus-5-5": 128000,
    "claude-sonnet-4-6": 64000,
    "claude-fable-5-1": 128000,
    "claude-3-5-haiku-20241022": 8192,
  });

  it.each([
    ["claude-opus-5-5", 128000],
    ["claude-sonnet-4-6", 64000],
    ["claude-3-5-haiku-20241022", 8192],
    ["claude-fable-5-1", 64000],
    ["claude-test", 32000],
  ])(
    "%s gets the catalog's output limit (%d), else 32000, Fable capped at 64000",
    (model, want) => {
      expect(withModelInfoLookup(lookup, () => maxTokensFor(model))).toBe(want);
    },
  );

  it("leaves a Fable limit below the cap alone", () => {
    const small = lookupWith({ "claude-fable-5-1": 16000 });

    expect(withModelInfoLookup(small, () => maxTokensFor("claude-fable-5-1"))).toBe(16000);
  });

  it("treats a null max_tokens or max_completion_tokens as omitted", () => {
    withModelInfoLookup(lookup, () => {
      expect(maxTokensFor("claude-opus-5-5", ',"max_tokens":null')).toBe(128000);
      expect(maxTokensFor("claude-opus-5-5", ',"max_completion_tokens":null')).toBe(128000);
      expect(
        maxTokensFor("claude-opus-5-5", ',"max_tokens":null,"max_completion_tokens":4096'),
      ).toBe(4096);
    });
  });

  it("keeps an explicit limit", () => {
    withModelInfoLookup(lookup, () => {
      expect(maxTokensFor("claude-opus-5-5", ',"max_tokens":1000')).toBe(1000);
    });
  });
});

describe("empty text parts", () => {
  const convert = (body: Json): JsonObject =>
    convertOpenAIRequestToClaude("claude-sonnet-5", body, false) as JsonObject;

  it("are dropped, and a message-level cache_control lands on the last real block", () => {
    const out = convert({
      model: "claude-sonnet-5",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "System rule" },
            { type: "text", text: "" },
            { type: "text", text: "   " },
          ],
          cache_control: { type: "ephemeral" },
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with exactly OK." },
            { type: "text", text: "" },
            { type: "text", text: " \n\t " },
          ],
          cache_control: { type: "ephemeral" },
        },
      ],
    });

    expect(out.system).toEqual([
      { type: "text", text: "System rule", cache_control: { type: "ephemeral" } },
    ]);
    expect(get(out, "messages.0.content")).toEqual([
      { type: "text", text: "Reply with exactly OK.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("pass their cache_control to the block before them", () => {
    const out = convert({
      model: "claude-sonnet-5",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "S1" },
            { type: "text", text: "", cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "text", text: "S2", cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "text", text: "S3" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "A" },
            { type: "text", text: "", cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "text", text: "B", cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "text", text: "C" },
          ],
        },
      ],
    });

    expect(get(out, "system.0.cache_control.ttl")).toBe("1h");
    expect(get(out, "system.1.cache_control.ttl")).toBe("5m");
    expect(get(out, "system.2.cache_control")).toBeUndefined();
    expect(get(out, "messages.0.content.0.cache_control.ttl")).toBe("1h");
    expect(get(out, "messages.0.content.1.cache_control.ttl")).toBe("5m");
    expect(get(out, "messages.0.content.2.cache_control")).toBeUndefined();
  });

  it("are dropped from string content and tool results", () => {
    const out = convert({
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "   " },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: "" }, " "],
        },
      ],
    });

    expect(out.system).toBeUndefined();
    expect(get(out, "messages.1.content")).toEqual([
      { type: "tool_use", id: "call_1", name: "f", input: {} },
    ]);
    expect(get(out, "messages.2.content.0.content")).toBe("");
  });
});

describe("message-level cache_control helper", () => {
  const cc = { cache_control: { type: "ephemeral" } };

  it("picks the last non-empty block", () => {
    const msg: JsonObject = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "" },
        { type: "text", text: "   " },
      ],
    };

    attachMessageCacheControl(msg, cc);

    expect(get(msg, "content.0.cache_control.type")).toBe("ephemeral");
    expect(get(msg, "content.1.cache_control")).toBeUndefined();
    expect(get(msg, "content.2.cache_control")).toBeUndefined();
  });

  it.each([
    "",
    "   ",
    [
      { type: "text", text: "" },
      { type: "text", text: " \n " },
    ],
  ])("skips a message whose content is all empty (%j)", (content) => {
    const msg: JsonObject = { role: "user", content: content };

    attachMessageCacheControl(msg, cc);

    expect(JSON.stringify(msg)).not.toContain("cache_control");
  });
});

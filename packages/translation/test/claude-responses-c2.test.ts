// Claude -> Responses translators: stop reasons, pause_turn, parallel_tool_calls, empty text (Go:
// internal/translator/claude/openai/responses/claude_openai-responses_{stop_reasons,request}_test.go; upstream
// df07b1e5, d495e24c, aadb34f9).
import { describe, expect, it } from "vitest";
import { get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { convertOpenAIResponsesRequestToClaude } from "../src/translator/claude/openai/responses/request.ts";
import {
  convertClaudeResponseToOpenAIResponses,
  convertClaudeResponseToOpenAIResponsesNonStream,
} from "../src/translator/claude/openai/responses/response.ts";
import { claudeSignature } from "./support/claude-signature.ts";
import { str } from "../src/translator/common/gjson.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

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

/** The terminal event name and its response object of a streamed Claude turn. */
const terminal = (events: ReadonlyArray<JsonObject>): { event: string; response: Json } => {
  const ctx = context();
  let found: { event: string; response: Json } | undefined;

  for (const event of events) {
    for (const frame of convertClaudeResponseToOpenAIResponses(
      ctx,
      `data: ${JSON.stringify(event)}`,
    )) {
      const name = /^event: (.+)$/mu.exec(frame)?.[1] ?? "";
      const data = /^data: (.+)$/mu.exec(frame)?.[1] ?? "";

      if (["response.completed", "response.incomplete", "response.failed"].includes(name))
        found = { event: name, response: get(parse(data), "response") as Json };
    }
  }

  if (found === undefined) throw new Error("no terminal event");

  return found;
};

const textTurn = (stopReason: string): JsonObject[] => [
  {
    type: "message_start",
    message: {
      id: "msg_e",
      usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 3 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Some text." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
];

describe("stop reasons on Responses", () => {
  it.each([
    ["model_context_window_exceeded", "max_output_tokens"],
    ["max_tokens", "max_output_tokens"],
    ["refusal", "content_filter"],
  ])("%s ends incomplete with reason %s and keeps text and usage", (reason, want) => {
    const { event, response } = terminal(textTurn(reason));

    expect(event).toBe("response.incomplete");
    expect(get(response, "status")).toBe("incomplete");
    expect(get(response, "incomplete_details.reason")).toBe(want);
    expect(get(response, "error")).toBeNull();
    expect(get(response, "usage.input_tokens")).toBe(10);
    expect(get(response, "usage.output_tokens")).toBe(4);
  });

  it("answers a non-stream context-window stop as incomplete max_output_tokens", () => {
    const out = parse(
      convertClaudeResponseToOpenAIResponsesNonStream(
        context(),
        JSON.stringify({
          id: "msg_c",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "cut" }],
          stop_reason: "model_context_window_exceeded",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      ) ?? "",
    );

    expect(get(out, "status")).toBe("incomplete");
    expect(get(out, "incomplete_details.reason")).toBe("max_output_tokens");
    expect(get(out, "error")).toBeNull();
    expect(get(out, "output.0.status")).toBe("incomplete");
    expect(get(out, "output.0.content.0.text")).toBe("cut");
  });
});

const pausedTurn = (): JsonObject[] => [
  {
    type: "message_start",
    message: { id: "msg_p1", usage: { input_tokens: 10, output_tokens: 0 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial." } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "server_tool_use",
      id: "srvtoolu_paused",
      name: "web_search",
      input: {},
    },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"query":"paused query"}' },
  },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

const continuation: JsonObject[] = [
  {
    type: "message_start",
    message: { id: "msg_p2", usage: { input_tokens: 10, output_tokens: 0 } },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_paused",
      content: [
        {
          type: "web_search_result",
          url: "https://example.com/p",
          title: "P",
          encrypted_content: "ENC",
        },
      ],
    },
  },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Final." } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

const items = (response: Json): Json[] => {
  const output = get(response, "output");

  return Array.isArray(output) ? output : [];
};

/** The next request a client builds: the prompt plus every output item it received (web search results dropped). */
const history = (...responses: Json[]): Json => ({
  model: "claude-test",
  tools: [{ type: "web_search" }],
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "research" }] },
    ...responses.flatMap(items).map((item) => {
      if (get(item, "type") !== "web_search_call") return item;
      const { results: _results, ...rest } = item as JsonObject;

      return rest;
    }),
  ],
});

const assistantBlocks = (request: Json): Json[] => {
  const messages = get(request, "messages");

  return (Array.isArray(messages) ? messages : [])
    .filter((message) => get(message, "role") === "assistant")
    .flatMap((message) => {
      const content = get(message, "content");

      return Array.isArray(content) ? content : [];
    });
};

const types = (blocks: Json[]): string => blocks.map((block) => str(get(block, "type"))).join(",");

describe("pause_turn", () => {
  it("completes with end_turn false and leaves the unanswered search in_progress", () => {
    const { event, response } = terminal(pausedTurn());

    expect(event).toBe("response.completed");
    expect(get(response, "end_turn")).toBe(false);
    expect(get(response, "incomplete_details")).toBeUndefined();

    const search = items(response).find((item) => get(item, "type") === "web_search_call");

    expect(get(search, "status")).toBe("in_progress");
    expect(get(search, "results")).toBeUndefined();
  });

  it("goes back to Claude as a search without a result, on a model that rejects prefill", () => {
    const { response } = terminal(pausedTurn());

    const request = convertOpenAIResponsesRequestToClaude(
      "claude-sonnet-4-6",
      history(response),
      true,
    );

    const messages = get(request, "messages") as Json[];

    expect(get(messages.at(-1), "role")).toBe("assistant");
    const blocks = assistantBlocks(request);

    expect(types(blocks)).toBe("text,server_tool_use");
    expect(get(blocks[1], "id")).toBe("srvtoolu_paused");
    expect(get(blocks[1], "input.query")).toBe("paused query");
  });

  it("answers the continuation with one completed search under the paused id", () => {
    const paused = terminal(pausedTurn()).response;
    const { event, response } = terminal(continuation);

    expect(event).toBe("response.completed");
    expect(get(response, "end_turn")).toBeUndefined();

    const search = items(response).find((item) => get(item, "type") === "web_search_call");

    expect(get(search, "id")).toBe("ws_srvtoolu_paused");
    expect(get(search, "status")).toBe("completed");
    expect(get(search, "results.0.url")).toBe("https://example.com/p");

    // The history of both turns replays one server_tool_use/result pair carrying the paused query.
    const request = convertOpenAIResponsesRequestToClaude(
      "claude-test",
      history(paused, response),
      true,
    );

    const blocks = assistantBlocks(request);
    const uses = blocks.filter((block) => get(block, "type") === "server_tool_use");

    expect(uses).toHaveLength(1);
    expect(get(uses[0], "id")).toBe("srvtoolu_paused");
    expect(get(uses[0], "input.query")).toBe("paused query");
    expect(types(blocks)).toContain("server_tool_use,web_search_tool_result");
  });

  it("keeps the pair of a paused search a user turn followed", () => {
    const { response } = terminal(pausedTurn());
    const base = history(response) as JsonObject;
    (base.input as Json[]).push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "never mind" }],
    });

    const blocks = assistantBlocks(
      convertOpenAIResponsesRequestToClaude("claude-test", base, true),
    );

    expect(types(blocks)).toBe("text,server_tool_use,web_search_tool_result");
  });

  it("does not merge repeated search ids across turns", () => {
    const search = (query: string): Json => ({
      id: "ws_srvtoolu_x",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query },
    });

    const request = convertOpenAIResponsesRequestToClaude(
      "claude-test",
      {
        model: "claude-test",
        tools: [{ type: "web_search" }],
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
          search("query a"),
          { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
          search("query b"),
        ],
      },
      true,
    );

    const queries = assistantBlocks(request)
      .filter((block) => get(block, "type") === "server_tool_use")
      .map((block) => get(block, "input.query"));

    expect(queries).toEqual(["query a", "query b"]);
  });
});

describe("pause_turn across several turns", () => {
  const searchBlocks = (id: string, query: string, index: number): JsonObject[] => [
    {
      type: "content_block_start",
      index,
      content_block: { type: "server_tool_use", id, name: "web_search", input: {} },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
    },
    { type: "content_block_stop", index },
  ];

  const result = (id: string, index: number): JsonObject[] => [
    {
      type: "content_block_start",
      index,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: id,
        content: [
          {
            type: "web_search_result",
            url: "https://example.com/a",
            title: "A",
            encrypted_content: "ENC",
          },
        ],
      },
    },
    { type: "content_block_stop", index },
  ];

  const pause = (): JsonObject[] => [
    { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];

  const start = (id: string): JsonObject => ({
    type: "message_start",
    message: { id, usage: { input_tokens: 10, output_tokens: 0 } },
  });

  it("keeps only the latest search unanswered after two pauses", () => {
    const first = terminal([
      start("msg_p1"),
      ...searchBlocks("srvtoolu_a", "query a", 0),
      ...pause(),
    ]);

    // The continuation answers search A and pauses again on search B.
    const second = terminal([
      start("msg_p2"),
      ...result("srvtoolu_a", 0),
      ...searchBlocks("srvtoolu_b", "query b", 1),
      ...pause(),
    ]);

    expect(second.event).toBe("response.completed");
    expect(get(second.response, "end_turn")).toBe(false);

    const blocks = assistantBlocks(
      convertOpenAIResponsesRequestToClaude(
        "claude-test",
        history(first.response, second.response),
        true,
      ),
    );

    expect(types(blocks)).toBe("server_tool_use,web_search_tool_result,server_tool_use");
    expect(get(blocks[0], "id")).toBe("srvtoolu_a");
    expect(get(blocks[2], "id")).toBe("srvtoolu_b");
    expect(get(blocks[2], "input.query")).toBe("query b");
  });

  it("keeps a paused turn after a completed search on a model that rejects prefill", () => {
    const { event, response } = terminal([
      start("msg_ws"),
      ...searchBlocks("srvtoolu_1", "lindorm vector", 0),
      ...result("srvtoolu_1", 1),
      ...pause(),
    ]);

    expect(event).toBe("response.completed");
    expect(get(response, "end_turn")).toBe(false);

    const request = convertOpenAIResponsesRequestToClaude(
      "claude-opus-5-5",
      history(response),
      true,
    );

    expect(get(request, "messages") as Json[]).toHaveLength(2);
    expect(types(assistantBlocks(request))).toBe("server_tool_use,web_search_tool_result");
  });

  it("still drops a completed thinking-plus-text trailing assistant on such a model", () => {
    const request = convertOpenAIResponsesRequestToClaude(
      "claude-sonnet-4-6",
      {
        model: "claude-sonnet-4-6",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
          {
            type: "reasoning",
            encrypted_content: claudeSignature(),
            summary: [{ type: "summary_text", text: "thought" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "prefill text" }],
          },
        ],
      },
      false,
    );

    const messages = get(request, "messages") as Json[];

    expect(messages).toHaveLength(1);
    expect(get(messages[0], "role")).toBe("user");
  });

  it("does not merge a repeated search id across a tool output either", () => {
    const search = (query: string): Json => ({
      id: "ws_srvtoolu_x",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query },
    });

    const request = convertOpenAIResponsesRequestToClaude(
      "claude-test",
      {
        model: "claude-test",
        tools: [
          { type: "web_search" },
          { type: "function", name: "f", parameters: { type: "object", properties: {} } },
        ],
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
          search("query a"),
          { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "ok" },
          search("query b"),
        ],
      },
      true,
    );

    const queries = assistantBlocks(request)
      .filter((block) => get(block, "type") === "server_tool_use")
      .map((block) => get(block, "input.query"));

    expect(queries).toEqual(["query a", "query b"]);
  });
});

describe("parallel_tool_calls false", () => {
  const tools = [
    { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
  ];

  const choiceFor = (extra: JsonObject, toolList: Json = tools): Json | undefined =>
    get(
      convertOpenAIResponsesRequestToClaude(
        "claude-test",
        { model: "claude-test", input: "hi", tools: toolList, ...extra },
        true,
      ),
      "tool_choice",
    );

  const off = { parallel_tool_calls: false };

  it.each([
    ["no tool_choice", off, { type: "auto", disable_parallel_tool_use: true }],
    ["auto", { ...off, tool_choice: "auto" }, { type: "auto", disable_parallel_tool_use: true }],
    [
      "required",
      { ...off, tool_choice: "required" },
      { type: "any", disable_parallel_tool_use: true },
    ],
    [
      "a forced tool",
      { ...off, tool_choice: { type: "function", name: "shell" } },
      { name: "shell", type: "tool", disable_parallel_tool_use: true },
    ],
    ["none", { ...off, tool_choice: "none" }, undefined],
    [
      "a forced tool that was filtered out",
      { ...off, tool_choice: { type: "function", name: "missing" } },
      undefined,
    ],
    ["true", { parallel_tool_calls: true }, undefined],
    ["true with auto", { parallel_tool_calls: true, tool_choice: "auto" }, { type: "auto" }],
    ["absent", {}, undefined],
  ])("%s", (_name, extra, want) => {
    expect(choiceFor(extra)).toEqual(want);
  });

  it("adds nothing without tools", () => {
    expect(choiceFor(off, [])).toBeUndefined();
  });
});

describe("empty text in Responses requests", () => {
  const convert = (body: JsonObject): Json =>
    convertOpenAIResponsesRequestToClaude(
      "claude-sonnet-5",
      { model: "claude-sonnet-5", ...body },
      false,
    );

  it("drops blank input_text parts and keeps their cache_control on the block before", () => {
    const out = convert({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "A" },
            { type: "input_text", text: "", cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "input_text", text: "B", cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "input_text", text: "  \n " },
          ],
        },
      ],
    });

    expect(get(out, "messages.0.content")).toEqual([
      { type: "text", text: "A", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "B", cache_control: { type: "ephemeral", ttl: "5m" } },
    ]);
  });

  it("drops blank system text and blank string input", () => {
    const out = convert({
      instructions: "   ",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "" }] },
        { type: "message", role: "user", content: "hi" },
      ],
    });

    expect(get(out, "system")).toBeUndefined();
    expect(get(out, "messages.0.content")).toBe("hi");
  });

  it("answers an all-blank tool output with empty content", () => {
    const out = convert({
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_text", text: " " }],
        },
      ],
    });

    const result = (get(out, "messages") as Json[])
      .flatMap((message) => get(message, "content") as Json[])
      .find((block) => get(block, "type") === "tool_result");

    expect(get(result, "content")).toBe("");
  });
});

// Responses -> Claude request and Claude -> Responses response (Go: internal/translator/claude/openai/responses/
// claude_openai-responses_{request,stop_reasons}_test.go; upstream 59930ba3, df860eb9).
import { describe, expect, it } from "vitest";
import { get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { convertOpenAIResponsesRequestToClaude } from "../src/translator/claude/openai/responses/request.ts";
import { convertClaudeResponseToOpenAIResponses } from "../src/translator/claude/openai/responses/response.ts";
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

const terminalResponse = (events: ReadonlyArray<JsonObject>): Json => {
  const ctx = context();
  let found: Json | undefined;

  for (const event of events) {
    for (const frame of convertClaudeResponseToOpenAIResponses(
      ctx,
      `data: ${JSON.stringify(event)}`,
    )) {
      if (!/^event: response\.(completed|incomplete|failed)$/mu.test(frame)) continue;
      found = get(parse(/^data: (.+)$/mu.exec(frame)?.[1] ?? ""), "response");
    }
  }

  if (found === undefined) throw new Error("no terminal event");

  return found;
};

const outputItems = (response: Json): Json[] => {
  const output = get(response, "output");

  return Array.isArray(output) ? output : [];
};

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

const userText = (text: string): JsonObject => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

describe("incomplete tool output (59930ba3)", () => {
  const convert = (status: string): Json => {
    const request = convertOpenAIResponsesRequestToClaude(
      "claude-opus-5-5",
      {
        model: "gpt-4o",
        tools: [
          {
            type: "function",
            name: "get_weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        input: [
          userText("Weather in Atlantis?"),
          {
            type: "function_call",
            call_id: "call_err1",
            name: "get_weather",
            arguments: '{"city":"Atlantis"}',
          },
          {
            type: "function_call_output",
            call_id: "call_err1",
            ...(status === "" ? {} : { status }),
            output: "City not found",
          },
          userText("Did it fail?"),
        ],
        max_output_tokens: 128,
      },
      false,
    );

    const messages = get(request, "messages");

    const blocks = (Array.isArray(messages) ? messages : []).flatMap((message) => {
      const content = get(message, "content");

      return Array.isArray(content) ? content : [];
    });

    const result = blocks.find(
      (block) => get(block, "type") === "tool_result" && get(block, "tool_use_id") === "call_err1",
    );

    if (result === undefined) throw new Error("no tool_result for call_err1");

    return result;
  };

  it("marks a status:incomplete output as is_error", () => {
    const result = convert("incomplete");

    expect(get(result, "content")).toBe("City not found");
    expect(get(result, "is_error")).toBe(true);
  });

  it("leaves a completed output unflagged", () => {
    expect(get(convert("completed"), "is_error")).toBeUndefined();
    expect(get(convert(""), "is_error")).toBeUndefined();
  });
});

describe("tool_use-deferred web search (df860eb9)", () => {
  const deferredTurn = (): JsonObject[] => [
    {
      type: "message_start",
      message: { id: "msg_d1", usage: { input_tokens: 10, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "server_tool_use",
        id: "srvtoolu_deferred",
        name: "web_search",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":"deferred query"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_exec", name: "exec", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"cmd":"uname"}' },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];

  const continuationTurn = (): JsonObject[] => [
    {
      type: "message_start",
      message: { id: "msg_d2", usage: { input_tokens: 10, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_deferred",
        content: [
          {
            type: "web_search_result",
            url: "https://example.com/d",
            title: "D",
            encrypted_content: "ENC",
          },
        ],
      },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];

  const execOutput: JsonObject = {
    type: "function_call_output",
    call_id: "toolu_exec",
    output: "Linux",
  };

  const request = (...turns: Json[][]): Json => ({
    model: "claude-test",
    tools: [
      { type: "web_search" },
      { type: "function", name: "exec", parameters: { type: "object", properties: {} } },
    ],
    input: [
      userText("research"),
      ...turns.flatMap((turn) =>
        turn.map((item) => {
          if (get(item, "type") !== "web_search_call") return item;
          const { results: _results, ...rest } = item as JsonObject;

          return rest;
        }),
      ),
    ],
  });

  it("keeps the search in_progress, without results", () => {
    const search = outputItems(terminalResponse(deferredTurn()))[0];

    expect(get(search, "status")).toBe("in_progress");
    expect(get(search, "results")).toBeUndefined();
  });

  it("replays it without an invented result next to the tool output", () => {
    const deferred = outputItems(terminalResponse(deferredTurn()));

    const claude = convertOpenAIResponsesRequestToClaude(
      "claude-test",
      request([...deferred, execOutput]),
      true,
    );

    expect(types(assistantBlocks(claude))).toBe("server_tool_use,tool_use");
  });

  it("emits a single pair once the continuation delivers the result", () => {
    const deferred = outputItems(terminalResponse(deferredTurn()));
    const continued = outputItems(terminalResponse(continuationTurn()));
    const input = request([...deferred, execOutput, ...continued]) as JsonObject;
    (input.input as Json[]).push(userText("thanks"));

    const blocks = assistantBlocks(
      convertOpenAIResponsesRequestToClaude("claude-test", input, true),
    );

    expect(types(blocks)).toBe("tool_use,server_tool_use,web_search_tool_result,text");
    expect(get(blocks[1], "input.query")).toBe("deferred query");
  });
});

// Responses -> Claude request and Claude -> Responses response (Go: internal/translator/claude/openai/responses/
// claude_openai-responses_{request,stop_reasons}_test.go; upstream 59930ba3, df860eb9).
import { describe, expect, it } from "vitest";
import { get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { convertOpenAIResponsesRequestToClaude } from "../src/translator/claude/openai/responses/request.ts";
import {
  convertClaudeResponseToOpenAIResponses,
  convertClaudeResponseToOpenAIResponsesNonStream,
} from "../src/translator/claude/openai/responses/response.ts";
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

  it("keeps the search in_progress in a non-stream answer too", () => {
    const body = deferredTurn()
      .map((event) => `data: ${JSON.stringify(event)}`)
      .join("\n");

    const out = parse(convertClaudeResponseToOpenAIResponsesNonStream(context(), body) ?? "");
    const search = outputItems(out)[0];

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

describe("replayed web search citations without results (9acf81d3, 9d453bc0)", () => {
  const search = (id: string, extra: JsonObject = {}): JsonObject => ({
    type: "web_search_call",
    id: `ws_srvtoolu_${id}`,
    status: "completed",
    action: { type: "search", query: `q${id}` },
    ...extra,
  });

  const answer = (text: string, index: string): JsonObject => ({
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: [
          {
            type: "web_search_result_location",
            url: "https://example.com/a",
            title: "A",
            cited_text: text,
            encrypted_index: index,
          },
        ],
      },
    ],
  });

  const convert = (items: JsonObject[], webSearchResults?: ReadonlyMap<string, Json>): Json =>
    convertOpenAIResponsesRequestToClaude(
      "claude-opus-5-5",
      { model: "claude-opus-5-5", tools: [{ type: "web_search" }], input: items },
      false,
      webSearchResults === undefined ? undefined : { webSearchResults },
    );

  const content = (request: Json, message: number): Json[] => {
    const blocks = get(get(request, "messages"), String(message) + ".content");

    return Array.isArray(blocks) ? blocks : [];
  };

  it("drops the citations and keeps the text when the search has no results", () => {
    const out = convert([
      userText("search question"),
      search("1"),
      answer("Cited answer.", "IDX_A"),
      userText("Reply with OK"),
    ]);

    const blocks = content(out, 1);

    expect(types(blocks)).toBe("server_tool_use,web_search_tool_result,text");
    expect(get(blocks[1], "content")).toEqual([]);
    expect(get(blocks[2], "text")).toBe("Cited answer.");
    expect(get(blocks[2], "citations")).toBeUndefined();
  });

  it("drops them when the results degrade to empty (no encrypted_content)", () => {
    const out = convert([
      userText("question"),
      search("1", { results: [{ title: "T", url: "https://example.com/a" }] }),
      answer("Cited answer.", "IDX_A"),
      userText("follow up"),
    ]);

    expect(get(content(out, 1)[2], "citations")).toBeUndefined();
  });

  it("drops unbacked citations after an interleaved client tool call of the same turn", () => {
    const out = convert([
      userText("question"),
      search("1"),
      { type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      answer("After tool.", "IDX_A"),
      userText("follow up"),
    ]);

    const message = get(out, "messages.3.content");
    const block = Array.isArray(message) ? message[0] : undefined;

    expect(Array.isArray(message) ? get(block, "text") : message).toBe("After tool.");
    expect(get(block, "citations")).toBeUndefined();
  });

  it("keeps the citations of a later turn whose search has results", () => {
    const out = convert([
      userText("q1"),
      search("1"),
      answer("Turn 1 answer.", "IDX_1"),
      userText("q2"),
      search("2", {
        results: [{ title: "2", url: "https://example.com/2", encrypted_content: "ENC_2" }],
      }),
      answer("Turn 2 answer.", "IDX_2"),
      userText("q3"),
    ]);

    expect(get(content(out, 1)[2], "citations")).toBeUndefined();
    expect(get(content(out, 3)[2], "citations.0.encrypted_index")).toBe("IDX_2");
  });

  it("drops them when any search of the turn lacks results", () => {
    const out = convert([
      userText("q"),
      search("1", {
        results: [{ title: "1", url: "https://example.com/1", encrypted_content: "ENC_1" }],
      }),
      search("2"),
      answer("Combined answer.", "IDX_2"),
      userText("next"),
    ]);

    const blocks = content(out, 1);

    expect(get(blocks[4], "citations")).toBeUndefined();
    expect(get(blocks[4], "text")).toBe("Combined answer.");
  });

  it("restores a cached result by its server_tool_use id and keeps the citations", () => {
    const cached: Json = [
      {
        type: "web_search_result",
        url: "https://example.com/a",
        title: "A",
        encrypted_content: "ENC",
      },
    ];

    const out = convert(
      [userText("q"), search("1"), answer("Cited answer.", "IDX_A"), userText("next")],
      new Map([["srvtoolu_1", cached]]),
    );

    const blocks = content(out, 1);

    expect(get(blocks[1], "content")).toEqual(cached);
    expect(get(blocks[2], "citations.0.encrypted_index")).toBe("IDX_A");
  });
});

// Client-executed Responses `tool_search` on providers without native tool search: Gemini, Antigravity (Gemini format)
// and Chat Completions (Go: gemini/openai/responses/gemini_openai-responses_tool_search_test.go,
// antigravity/openai/responses/antigravity_openai-responses_tool_search_test.go,
// openai/openai/responses/openai_openai-responses_tool_search_test.go; upstream 77fd91e8, 90c447d3, 8c9a7851).
import { describe, expect, it } from "vitest";
import { asString, get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const array = (value: Json | undefined): Json[] => (isJsonArray(value) ? value : []);

/** The `data:` payloads of translated SSE chunks. */
const events = (chunks: readonly string[]): Json[] =>
  chunks.flatMap((chunk) =>
    chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .flatMap((line) => {
        const data = tryParseJson(line.slice(5).trim());

        return data === undefined ? [] : [data];
      }),
  );

const GEMINI_MODEL = "gemini-3.8-flash-high";

const fixtureRequest = (): Json => ({
  model: GEMINI_MODEL,
  stream: true,
  tools: [
    {
      type: "function",
      name: "exec_command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    },
    {
      type: "tool_search",
      execution: "client",
      description:
        "Search available deferred tools. Multi-agent tools: Spawn and manage sub-agents.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "spawn_agent",
      defer_loading: true,
      parameters: { type: "object", properties: { prompt: { type: "string" } } },
    },
  ],
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Find the multi-agent tools before answering." }],
    },
    {
      type: "tool_search_call",
      id: "tsc_search_1",
      execution: "client",
      call_id: "search_1",
      status: "completed",
      arguments: { query: "fixture tools", limit: 1 },
    },
    {
      type: "tool_search_output",
      id: "tso_search_1",
      execution: "client",
      call_id: "search_1",
      status: "completed",
      tools: [
        {
          type: "namespace",
          name: "fixture_tools",
          description: "Minimal discovery fixture",
          tools: [
            {
              type: "function",
              name: "ping",
              description: "Return a test reply",
              defer_loading: true,
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
      ],
    },
    {
      type: "function_call",
      call_id: "call_ping",
      name: "ping",
      namespace: "fixture_tools",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "call_ping", output: "pong" },
  ],
});

const toProvider = (provider: string, model: string, body: Json, stream = true): Json =>
  builtinTranslators.translateRequest("openai-response", provider, {
    format: "openai-response",
    model,
    stream,
    body,
  }).body;

const streamEvents = (provider: string, model: string, request: Json, frames: string[]): Json[] => {
  const context = {
    model,
    originalRequest: request,
    translatedRequest: undefined,
    state: makeTranslationState(),
  };

  return events(
    frames.flatMap((frame) =>
      builtinTranslators.translateStream("openai-response", provider, context, frame),
    ),
  );
};

describe("Gemini: client tool_search", () => {
  it("declares the shim and the discovered tools and replays the search as a function call pair", () => {
    const out = toProvider("gemini", GEMINI_MODEL, fixtureRequest());
    const declarations = array(get(out, "tools.0.functionDeclarations"));

    // `spawn_agent` stays hidden until a search loads it.
    expect(declarations.map((declaration) => get(declaration, "name"))).toEqual([
      "exec_command",
      "tool_search",
      "fixture_tools__ping",
    ]);
    expect(get(declarations[1], "description")).toBe(
      "Search available deferred tools. Multi-agent tools: Spawn and manage sub-agents.",
    );
    expect(get(declarations[1], "parametersJsonSchema.required.0")).toBe("query");
    expect(get(declarations[2], "description")).toBe("Return a test reply");

    const contents = array(get(out, "contents"));
    expect(contents).toHaveLength(5);
    expect(get(contents[1], "role")).toBe("model");
    expect(get(contents[1], "parts.0.functionCall.name")).toBe("tool_search");
    expect(get(contents[1], "parts.0.functionCall.id")).toBe("search_1");
    expect(get(contents[1], "parts.0.functionCall.args")).toEqual({
      query: "fixture tools",
      limit: 1,
    });
    expect(get(contents[2], "role")).toBe("user");
    expect(get(contents[2], "parts.0.functionResponse.name")).toBe("tool_search");
    expect(get(contents[2], "parts.0.functionResponse.id")).toBe("search_1");

    const result = tryParseJson(
      asString(get(contents[2], "parts.0.functionResponse.response.result")),
    );

    expect(get(result, "status")).toBe("completed");
    // The names Gemini sees, not the namespaced Responses ones.
    expect(get(result, "tools")).toEqual(["fixture_tools__ping"]);
    expect(get(contents[3], "parts.0.functionCall.name")).toBe("fixture_tools__ping");
    expect(get(contents[4], "parts.0.functionResponse.name")).toBe("fixture_tools__ping");
  });

  it("parses string arguments and an empty discovery", () => {
    const out = toProvider(
      "gemini",
      GEMINI_MODEL,
      {
        model: GEMINI_MODEL,
        tools: [{ type: "tool_search", execution: "client" }],
        input: [
          { type: "message", role: "user", content: "hi" },
          {
            type: "tool_search_call",
            execution: "client",
            call_id: "search_2",
            arguments: '{"query":"nothing"}',
          },
          {
            type: "tool_search_output",
            execution: "client",
            call_id: "search_2",
            status: "completed",
            tools: [],
          },
        ],
      },
      false,
    );

    const contents = array(get(out, "contents"));
    expect(contents).toHaveLength(3);
    expect(get(contents[1], "parts.0.functionCall.args.query")).toBe("nothing");

    const result = tryParseJson(
      asString(get(contents[2], "parts.0.functionResponse.response.result")),
    );

    expect(get(result, "tools")).toEqual([]);
  });

  it("answers a shim call with a tool_search_call item carrying a tsc_ id", () => {
    const request = fixtureRequest();

    const out = streamEvents("gemini", GEMINI_MODEL, request, [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"tool_search","args":{"query":"fixture tools","limit":2}}}]},"finishReason":"STOP"}],"modelVersion":"${GEMINI_MODEL}","responseId":"resp_tool_search"}`,
      "data: [DONE]",
    ]);

    const find = (type: string): Json | undefined =>
      out.find((event) => get(event, "type") === type);

    const added = get(find("response.output_item.added"), "item");
    const done = get(find("response.output_item.done"), "item");
    const completed = get(find("response.completed"), "response.output.0");
    expect(out.map((event) => get(event, "type"))).not.toContain(
      "response.function_call_arguments.delta",
    );

    const callId = asString(get(done, "call_id"));
    expect(callId).not.toBe("");

    for (const [item, status] of [
      [added, "in_progress"],
      [done, "completed"],
      [completed, "completed"],
    ] as const) {
      expect(get(item, "type")).toBe("tool_search_call");
      expect(get(item, "execution")).toBe("client");
      expect(get(item, "status")).toBe(status);
      expect(get(item, "call_id")).toBe(callId);
      expect(get(item, "id")).toBe(`tsc_${callId}`);
      expect(get(item, "name")).toBeUndefined();
    }

    expect(get(done, "arguments")).toEqual({ query: "fixture tools", limit: 2 });
    expect(get(completed, "arguments")).toEqual({ query: "fixture tools", limit: 2 });
  });

  it("answers a shim call in a non-stream response and reports non-object arguments as incomplete", () => {
    const request = fixtureRequest();

    const convert = (args: string): Json | undefined => {
      const body = builtinTranslators.translateNonStream(
        "openai-response",
        "gemini",
        {
          model: GEMINI_MODEL,
          originalRequest: request,
          translatedRequest: undefined,
          state: makeTranslationState(),
        },
        `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"tool_search","args":${args}}}]},"finishReason":"STOP"}],"responseId":"resp_ns"}`,
      );

      return get(tryParseJson(body ?? ""), "output.0");
    };

    const item = convert('{"query":"fixture tools"}');
    expect(get(item, "type")).toBe("tool_search_call");
    expect(get(item, "execution")).toBe("client");
    expect(get(item, "status")).toBe("completed");
    expect(get(item, "arguments")).toEqual({ query: "fixture tools" });
    expect(get(item, "id")).toBe(`tsc_${asString(get(item, "call_id"))}`);

    const bad = convert('"not an object"');
    expect(get(bad, "type")).toBe("tool_search_call");
    expect(get(bad, "status")).toBe("incomplete");
    expect(get(bad, "arguments")).toEqual({});
  });

  it("restores the namespace of a discovered tool call", () => {
    const out = streamEvents("gemini", GEMINI_MODEL, fixtureRequest(), [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"fixture_tools__ping","args":{}}}]},"finishReason":"STOP"}],"responseId":"resp_discovered"}`,
      "data: [DONE]",
    ]);

    const done = out.find(
      (event) =>
        get(event, "type") === "response.output_item.done" &&
        get(event, "item.type") === "function_call",
    );

    expect(get(done, "item.name")).toBe("ping");
    expect(get(done, "item.namespace")).toBe("fixture_tools");
  });

  it("keeps a user function named tool_search a function call", () => {
    const request = {
      model: GEMINI_MODEL,
      tools: [
        {
          type: "function",
          name: "tool_search",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    };

    const out = streamEvents("gemini", GEMINI_MODEL, request, [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"tool_search","args":{"query":"x"}}}]},"finishReason":"STOP"}],"responseId":"resp_user_fn"}`,
      "data: [DONE]",
    ]);

    const types = out
      .filter((event) => get(event, "type") === "response.output_item.done")
      .map((event) => get(event, "item.type"));

    expect(types).toEqual(["function_call"]);
  });

  it.each(["user function first", "client tool_search first"])(
    "keeps a user tool_search function and the client shim apart (%s)",
    (order) => {
      const userFn = {
        type: "function",
        name: "tool_search",
        description: "User tool.",
        parameters: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
      };

      const clientSearch = {
        type: "tool_search",
        execution: "client",
        description: "Search deferred tools.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      };

      const deferredFn = {
        type: "function",
        name: "hidden_until_discovered",
        defer_loading: true,
        parameters: { type: "object", properties: {} },
      };

      const request = {
        model: GEMINI_MODEL,
        tools:
          order === "user function first"
            ? [userFn, clientSearch, deferredFn]
            : [clientSearch, userFn, deferredFn],
        input: [
          { type: "message", role: "user", content: "hi" },
          {
            type: "tool_search_call",
            execution: "client",
            call_id: "search_1",
            status: "completed",
            arguments: { query: "ping" },
          },
          {
            type: "tool_search_output",
            execution: "client",
            call_id: "search_1",
            status: "completed",
            tools: [],
          },
          {
            type: "function_call",
            call_id: "user_call_1",
            name: "tool_search",
            arguments: '{"x":"val"}',
          },
          { type: "function_call_output", call_id: "user_call_1", output: "user_ok" },
        ],
      };

      const out = toProvider("gemini", GEMINI_MODEL, request);
      const declarations = array(get(out, "tools.0.functionDeclarations"));
      // The user tool and the shim; the deferred tool stays hidden.
      expect(declarations).toHaveLength(2);

      const shim = declarations
        .map((declaration) => asString(get(declaration, "name")))
        .find((name) => name !== "tool_search");

      expect(shim).toBeTruthy();

      const contents = array(get(out, "contents"));
      expect(get(contents[1], "parts.0.functionCall.name")).toBe(shim);
      expect(get(contents[2], "parts.0.functionResponse.name")).toBe(shim);
      expect(get(contents[3], "parts.0.functionCall.name")).toBe("tool_search");
      expect(get(contents[4], "parts.0.functionResponse.name")).toBe("tool_search");

      const done = streamEvents("gemini", GEMINI_MODEL, request, [
        `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"c_shim","name":"${shim}","args":{"query":"agents"}}},{"functionCall":{"id":"c_user","name":"tool_search","args":{"x":"abc"}}}]},"finishReason":"STOP"}],"responseId":"resp_coexist"}`,
        "data: [DONE]",
      ])
        .filter((event) => get(event, "type") === "response.output_item.done")
        .map((event) => get(event, "item"));

      expect(done).toHaveLength(2);
      expect(get(done[0], "type")).toBe("tool_search_call");
      expect(get(done[0], "arguments.query")).toBe("agents");
      expect(get(done[1], "type")).toBe("function_call");
      expect(get(done[1], "name")).toBe("tool_search");
    },
  );

  it("does not let a namespaced child named tool_search take over replayed history", () => {
    const out = toProvider("gemini", GEMINI_MODEL, {
      model: GEMINI_MODEL,
      stream: true,
      tools: [],
      input: [
        {
          type: "tool_search_call",
          execution: "client",
          call_id: "search_1",
          status: "completed",
          arguments: { query: "fixture tools", limit: 1 },
        },
        {
          type: "tool_search_output",
          execution: "client",
          call_id: "search_1",
          status: "completed",
          tools: [
            {
              type: "namespace",
              name: "fixture_tools",
              tools: [
                {
                  type: "function",
                  name: "tool_search",
                  description: "Namespaced child named tool_search",
                  parameters: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(get(out, "tools.0.functionDeclarations.0.name")).toBe("fixture_tools__tool_search");
    const contents = array(get(out, "contents"));
    expect(contents).toHaveLength(2);
    expect(get(contents[0], "parts.0.functionCall.name")).toBe("tool_search");
    expect(get(contents[1], "parts.0.functionResponse.name")).toBe("tool_search");
  });
});

describe("Antigravity: client tool_search", () => {
  it("exposes the shim and replays the search, and answers a call with a tool_search_call", () => {
    const request: Json = {
      model: GEMINI_MODEL,
      tools: [
        {
          type: "tool_search",
          execution: "client",
          description: "Search deferred tools.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      input: [
        { type: "message", role: "user", content: "find tools" },
        {
          type: "tool_search_call",
          execution: "client",
          call_id: "search_1",
          status: "completed",
          arguments: { query: "fixture" },
        },
        {
          type: "tool_search_output",
          execution: "client",
          call_id: "search_1",
          status: "completed",
          tools: [
            {
              type: "namespace",
              name: "fixture_tools",
              tools: [
                {
                  type: "function",
                  name: "ping",
                  defer_loading: true,
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
      ],
    };

    const out = toProvider("antigravity", GEMINI_MODEL, request);
    expect(
      array(get(out, "request.tools.0.functionDeclarations")).map((declaration) =>
        get(declaration, "name"),
      ),
    ).toEqual(["tool_search", "fixture_tools__ping"]);
    const contents = array(get(out, "request.contents"));
    expect(contents).toHaveLength(3);
    expect(get(contents[1], "parts.0.functionCall.name")).toBe("tool_search");
    expect(get(contents[2], "parts.0.functionResponse.name")).toBe("tool_search");

    const emitted = streamEvents("antigravity", GEMINI_MODEL, request, [
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"tool_search","args":{"query":"fixture"}}}]},"finishReason":"STOP"}],"responseId":"resp_ag_tool_search"}}`,
      "data: [DONE]",
    ]);

    const done = get(
      emitted.find((event) => get(event, "type") === "response.output_item.done"),
      "item",
    );

    expect(get(done, "type")).toBe("tool_search_call");
    expect(get(done, "arguments.query")).toBe("fixture");
    expect(get(done, "execution")).toBe("client");
    const callId = asString(get(done, "call_id"));
    expect(callId).not.toBe("");
    expect(get(done, "id")).toBe(`tsc_${callId}`);
  });
});

const chatRequest = (): Json => ({
  model: "chat-test",
  stream: true,
  tools: [
    {
      type: "function",
      name: "exec_command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    },
    {
      type: "tool_search",
      execution: "client",
      description: "Search deferred tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      },
    },
  ],
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "list my calendars" }] },
    {
      type: "tool_search_call",
      call_id: "call_ts1",
      status: "completed",
      execution: "client",
      arguments: { query: "calendar" },
    },
    {
      type: "tool_search_output",
      call_id: "call_ts1",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__demo__cal",
          description: "Calendar",
          tools: [
            {
              type: "function",
              name: "_list",
              description: "List calendars",
              defer_loading: true,
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    },
  ],
});

const chatChunk = (delta: string, finish: string | null = null): string =>
  `data: {"id":"r1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":${delta},"finish_reason":${JSON.stringify(finish)}}]}`;

const chatNonStream = (request: Json, toolCalls: string): Json | undefined => {
  const body = builtinTranslators.translateNonStream(
    "openai-response",
    "openai",
    {
      model: "m",
      originalRequest: request,
      translatedRequest: undefined,
      state: makeTranslationState(),
    },
    `{"id":"r2","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[${toolCalls}]}}]}`,
  );

  return tryParseJson(body ?? "");
};

const byCallId = (body: Json | undefined, callId: string): Json | undefined =>
  array(get(body, "output")).find((item) => get(item, "call_id") === callId);

describe("Chat Completions: client tool_search", () => {
  it("declares the search function and the loaded tools and replays the search as a call pair", () => {
    const out = toProvider("openai", "chat-test", chatRequest());
    const names = array(get(out, "tools")).map((tool) => asString(get(tool, "function.name")));
    expect(names).toEqual(
      expect.arrayContaining(["exec_command", "tool_search", "mcp__demo__cal___list"]),
    );

    const search = array(get(out, "tools")).find(
      (tool) => get(tool, "function.name") === "tool_search",
    );

    expect(get(search, "function.parameters.properties.limit")).toEqual({ type: "number" });

    const assistant = array(get(out, "messages")).find(
      (message) => get(message, "role") === "assistant",
    );

    const call = get(assistant, "tool_calls.0");
    expect(get(call, "id")).toBe("call_ts1");
    expect(get(call, "function.name")).toBe("tool_search");
    expect(tryParseJson(asString(get(call, "function.arguments")))).toEqual({ query: "calendar" });

    const tool = array(get(out, "messages")).find((message) => get(message, "role") === "tool");
    expect(get(tool, "tool_call_id")).toBe("call_ts1");
    expect(asString(get(tool, "content"))).toContain("mcp__demo__cal___list");
  });

  it("restores a streamed search call as a tool_search_call without argument events", () => {
    const out = streamEvents("openai", "m", chatRequest(), [
      chatChunk(
        '{"role":"assistant","tool_calls":[{"index":0,"id":"call_s","type":"function","function":{"name":"tool_search","arguments":""}}]}',
      ),
      chatChunk(
        '{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"cal\\"}"}}]}',
        "tool_calls",
      ),
      "data: [DONE]",
    ]);

    const types = out.map((event) => asString(get(event, "type")));
    expect(types.filter((type) => type.startsWith("response.function_call_arguments"))).toEqual([]);

    const added = out.find(
      (event) =>
        get(event, "type") === "response.output_item.added" &&
        get(event, "item.type") === "tool_search_call",
    );

    expect(get(added, "item.call_id")).toBe("call_s");

    const done = out.find(
      (event) =>
        get(event, "type") === "response.output_item.done" &&
        get(event, "item.type") === "tool_search_call",
    );

    expect(get(done, "item.arguments")).toEqual({ query: "cal" });
    expect(get(done, "item.execution")).toBe("client");

    const completed = out.find((event) => get(event, "type") === "response.completed");
    expect(get(completed, "response.output.0.type")).toBe("tool_search_call");
  });

  it("restores non-stream search and loaded tool calls", () => {
    const body = chatNonStream(
      chatRequest(),
      '{"id":"call_a","type":"function","function":{"name":"tool_search","arguments":"{\\"query\\":\\"cal\\"}"}},{"id":"call_b","type":"function","function":{"name":"mcp__demo__cal___list","arguments":"{}"}}',
    );

    const search = byCallId(body, "call_a");
    expect(get(search, "type")).toBe("tool_search_call");
    expect(get(search, "arguments")).toEqual({ query: "cal" });
    const loaded = byCallId(body, "call_b");
    expect(get(loaded, "type")).toBe("function_call");
    expect(get(loaded, "name")).toBe("_list");
    expect(get(loaded, "namespace")).toBe("mcp__demo__cal");
  });

  it("does not bridge hosted search", () => {
    const out = toProvider(
      "openai",
      "chat-test",
      {
        model: "chat-test",
        tools: [{ type: "tool_search", execution: "server" }],
        input: [
          { type: "message", role: "user", content: "hi" },
          {
            type: "tool_search_call",
            call_id: "call_h",
            execution: "server",
            arguments: { query: "x" },
          },
          {
            type: "tool_search_output",
            call_id: "call_h",
            execution: "server",
            tools: [{ type: "function", name: "hosted_tool", parameters: { type: "object" } }],
          },
        ],
      },
      false,
    );

    expect(array(get(out, "tools"))).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("call_h");
  });

  it("keeps a user function named tool_search and gives the search a distinct name", () => {
    const request: Json = {
      model: "chat-test",
      tools: [
        {
          type: "function",
          name: "tool_search",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
        { type: "tool_search", execution: "client" },
      ],
      input: [{ type: "message", role: "user", content: "hi" }],
      tool_choice: { type: "tool_search" },
    };

    const out = toProvider("openai", "chat-test", request, false);
    const names = array(get(out, "tools")).map((tool) => get(tool, "function.name"));
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(get(out, "tool_choice.function.name")).toBe("tool_search_1");

    const body = chatNonStream(
      request,
      '{"id":"call_u","type":"function","function":{"name":"tool_search","arguments":"{\\"q\\":\\"x\\"}"}},{"id":"call_s","type":"function","function":{"name":"tool_search_1","arguments":"{\\"query\\":\\"y\\"}"}},{"id":"call_trunc","type":"function","function":{"name":"tool_search_1","arguments":"{\\"query\\":"}}',
    );

    const user = byCallId(body, "call_u");
    expect(get(user, "type")).toBe("function_call");
    expect(get(user, "name")).toBe("tool_search");
    const search = byCallId(body, "call_s");
    expect(get(search, "type")).toBe("tool_search_call");
    expect(get(search, "arguments")).toEqual({ query: "y" });
    // A truncated argument object is incomplete, never a completed search.
    const truncated = byCallId(body, "call_trunc");
    expect(get(truncated, "type")).toBe("tool_search_call");
    expect(get(truncated, "status")).toBe("incomplete");
  });

  it("reports a streamed call with empty arguments as incomplete, like the non-stream path", () => {
    const request: Json = {
      model: "chat-test",
      tools: [{ type: "tool_search", execution: "client" }],
      input: [{ type: "message", role: "user", content: "hi" }],
    };

    const out = streamEvents("openai", "m", request, [
      chatChunk(
        '{"role":"assistant","tool_calls":[{"index":0,"id":"call_empty","type":"function","function":{"name":"tool_search","arguments":""}}]}',
        "tool_calls",
      ),
      "data: [DONE]",
    ]);

    const done = get(
      out.find((event) => get(event, "type") === "response.output_item.done"),
      "item",
    );

    const completed = get(
      out.find((event) => get(event, "type") === "response.completed"),
      "response.output.0",
    );

    const nonStream = get(
      chatNonStream(
        request,
        '{"id":"call_empty","type":"function","function":{"name":"tool_search","arguments":""}}',
      ),
      "output.0",
    );

    expect(get(done, "status")).toBe("incomplete");
    expect(done).toEqual(completed);
    expect(done).toEqual(nonStream);
  });
});

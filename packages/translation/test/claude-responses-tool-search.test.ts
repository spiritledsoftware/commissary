// Codex client-executed `tool_search` on Claude (native tool search) (Go: internal/translator/claude/openai/responses/
// claude_openai-responses_tool_search_test.go and ..._tool_search_disabled_test.go, internal/runtime/executor/helps/
// responses_tool_search_test.go; upstream 58c0f6a2, a68ad134, aeec5e97, 8eed08ef, 97ba1e89, 48ad3487).
import { describe, expect, it } from "vitest";
import { asString, get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

/** The `data:` payloads of one translated SSE chunk. */
const dataEvents = (chunk: string): Json[] =>
  chunk.split("\n").flatMap((line) => {
    if (!line.startsWith("data:")) return [];
    const data = tryParseJson(line.slice(5).trim());

    return data === undefined ? [] : [data];
  });

const array = (value: Json | undefined): Json[] => (isJsonArray(value) ? value : []);

const ANCHOR = "tool_search_deferred_anchor";

const toolSearchDeclaration = (): Json => ({
  type: "tool_search",
  execution: "client",
  description: "# Tool discovery\n\nSearches over deferred tool metadata.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Maximum number of tools to return." },
      query: { type: "string", description: "Search query for deferred tools." },
    },
    required: ["query"],
    additionalProperties: false,
  },
});

const execCommand = (): Json => ({
  type: "function",
  name: "exec_command",
  description: "Run a command.",
  strict: false,
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
  },
});

const deferredTool = (): Json => ({
  type: "function",
  name: "lookup_order",
  description: "Look up an order.",
  strict: false,
  defer_loading: true,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
});

const deferredNamespace = (): Json => ({
  type: "namespace",
  name: "mcp__node_repl__",
  description: "Node REPL.",
  tools: [
    {
      type: "function",
      name: "js",
      description: "Run JavaScript.",
      strict: false,
      defer_loading: true,
      parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    },
  ],
});

const calendarNamespace = (): Json => ({
  type: "namespace",
  name: "mcp__codex_apps__",
  description: "Tools in the mcp__codex_apps__ namespace.",
  tools: [
    {
      type: "function",
      name: "calendar_create_event",
      description: "Create a calendar event.",
      strict: false,
      defer_loading: true,
      parameters: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    },
  ],
});

const userTurn = (): Json => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "create a calendar event" }],
});

const searchCall = (callId: string, query: string): Json => ({
  type: "tool_search_call",
  call_id: callId,
  status: "completed",
  execution: "client",
  arguments: { query, limit: 8 },
});

const searchOutput = (callId: string, tools: Json[]): Json => ({
  type: "tool_search_output",
  call_id: callId,
  status: "completed",
  execution: "client",
  tools,
});

const searchCall1 = (): Json => searchCall("call_search_1", "calendar create");

const searchOutput1 = (): Json =>
  searchOutput("call_search_1", [calendarNamespace(), deferredTool()]);

const request = (input: Json[], tools?: Json[]): Json => ({
  model: "claude-sonnet-4-5",
  instructions: "You are Codex.",
  input,
  tools: tools ?? [execCommand(), toolSearchDeclaration(), deferredTool(), deferredNamespace()],
  tool_choice: "auto",
  stream: true,
});

const toClaude = (body: Json, nativeToolSearch: boolean, model = "claude-sonnet-4-5"): Json =>
  builtinTranslators.translateRequest(
    "openai-response",
    "claude",
    { format: "openai-response", model, stream: true, body },
    undefined,
    { nativeToolSearch },
  ).body;

const toolNames = (out: Json): string[] =>
  array(get(out, "tools")).map((tool) => asString(get(tool, "name")));

const toolNamed = (out: Json, name: string): Json | undefined =>
  array(get(out, "tools")).find((tool) => get(tool, "name") === name);

describe("native tool search: request", () => {
  it("declares tool_search as a function with a required query and withholds deferred tools", () => {
    const out = toClaude(request([userTurn()]), true);
    const tool = toolNamed(out, "tool_search");

    expect(tool).toBeDefined();
    expect(get(tool, "type")).toBeUndefined();
    expect(get(tool, "execution")).toBeUndefined();
    expect(get(tool, "input_schema.properties.query.type")).toBe("string");
    expect(get(tool, "input_schema.required")).toContain("query");
    expect(get(tool, "input_schema.properties.limit.type")).toBe("number");
    expect(asString(get(tool, "description"))).toMatch(/^# Tool discovery/);
    // Only the anchor is deferred on the first request.
    expect(toolNames(out)).toEqual(["exec_command", "tool_search", ANCHOR]);
  });

  it("guarantees the query field of a sparse declaration", () => {
    for (const declaration of [
      { type: "tool_search", execution: "client" },
      {
        type: "tool_search",
        execution: "client",
        parameters: { type: "object", properties: { limit: { type: "number" } } },
      },
    ]) {
      const out = toClaude({ model: "claude-sonnet-4-5", input: "hi", tools: [declaration] }, true);
      const tool = array(get(out, "tools"))[0];
      expect(get(tool, "name")).toBe("tool_search");
      expect(get(tool, "input_schema.properties.query.type")).toBe("string");
      expect(get(tool, "input_schema.required")).toContain("query");
    }
  });

  it("does not forward a hosted tool_search", () => {
    const out = toClaude(
      {
        model: "claude-sonnet-4-5",
        input: "hi",
        tools: [execCommand(), { type: "tool_search", name: "ToolSearch" }, deferredTool()],
      },
      true,
    );

    expect(toolNames(out)).toEqual(["exec_command", "lookup_order"]);
  });

  it("replays the search as tool_use/tool_result with tool_reference blocks and declares discoveries as deferred", () => {
    const turn2 = toClaude(request([userTurn(), searchCall1(), searchOutput1()]), true);

    expect(toolNames(turn2)).toEqual([
      "exec_command",
      "tool_search",
      ANCHOR,
      "mcp__codex_apps__calendar_create_event",
      "lookup_order",
    ]);

    for (const name of ["mcp__codex_apps__calendar_create_event", "lookup_order"])
      expect(get(toolNamed(turn2, name), "defer_loading")).toBe(true);

    for (const name of ["exec_command", "tool_search"])
      expect(get(toolNamed(turn2, name), "defer_loading")).toBeUndefined();

    expect(
      get(toolNamed(turn2, "mcp__codex_apps__calendar_create_event"), "input_schema.required.0"),
    ).toBe("title");

    const toolUse = get(turn2, "messages.1.content.0");
    expect(toolUse).toEqual({
      type: "tool_use",
      id: "call_search_1",
      name: "tool_search",
      input: { query: "calendar create", limit: 8 },
    });

    const toolResult = get(turn2, "messages.2.content.0");
    expect(get(toolResult, "type")).toBe("tool_result");
    expect(get(toolResult, "tool_use_id")).toBe("call_search_1");
    // The custom-search shape: never the server-side `tool_search_tool_result`.
    expect(get(toolResult, "content")).toEqual([
      { type: "tool_reference", tool_name: "mcp__codex_apps__calendar_create_event" },
      { type: "tool_reference", tool_name: "lookup_order" },
    ]);
    expect(JSON.stringify(turn2)).not.toContain("tool_search_tool_result");

    // The next discovery appends after the earlier tools: the prefix never changes.
    const turn3 = toClaude(
      request([
        userTurn(),
        searchCall1(),
        searchOutput1(),
        {
          type: "function_call",
          call_id: "call_cal_1",
          name: "calendar_create_event",
          namespace: "mcp__codex_apps__",
          arguments: '{"title":"Standup"}',
        },
        { type: "function_call_output", call_id: "call_cal_1", output: "created" },
        searchCall("call_search_2", "javascript"),
        searchOutput("call_search_2", [deferredNamespace()]),
      ]),
      true,
    );

    expect(toolNames(turn3)).toEqual([...toolNames(turn2), "mcp__node_repl__js"]);
    expect(array(get(turn3, "tools")).slice(0, 5)).toEqual(array(get(turn2, "tools")));
  });

  it("qualifies a replayed namespaced function call", () => {
    const out = toClaude(
      request([
        userTurn(),
        searchCall1(),
        searchOutput1(),
        {
          type: "function_call",
          call_id: "call_cal_1",
          name: "calendar_create_event",
          namespace: "mcp__codex_apps__",
          arguments: '{"title":"Standup"}',
        },
        { type: "function_call_output", call_id: "call_cal_1", output: "created" },
      ]),
      true,
    );

    const replayed = array(get(out, "messages"))
      .flatMap((message) => array(get(message, "content")))
      .find((block) => get(block, "id") === "call_cal_1");

    expect(get(replayed, "name")).toBe("mcp__codex_apps__calendar_create_event");
  });

  it("does not reference tools that are already declared, and summarises an empty result as text", () => {
    const declaredOnly = toClaude(
      request([userTurn(), searchCall1(), searchOutput("call_search_1", [execCommand()])]),
      true,
    );

    expect(get(declaredOnly, "messages.2.content.0.content")).toBe(
      "Tools now available to call: exec_command.",
    );

    const mixed = toClaude(
      request([
        userTurn(),
        searchCall1(),
        searchOutput("call_search_1", [execCommand(), calendarNamespace()]),
      ]),
      true,
    );

    expect(get(mixed, "messages.2.content.0.content")).toEqual([
      { type: "tool_reference", tool_name: "mcp__codex_apps__calendar_create_event" },
    ]);
    expect(get(toolNamed(mixed, "exec_command"), "defer_loading")).toBeUndefined();

    const empty = toClaude(
      request([userTurn(), searchCall1(), searchOutput("call_search_1", [])]),
      true,
    );

    expect(get(empty, "messages.2.content.0.content")).toBe("No matching tools were found.");
  });

  it("references a rediscovered tool once per result and declares it once", () => {
    const out = toClaude(
      request([
        userTurn(),
        searchCall1(),
        searchOutput1(),
        searchCall("call_search_2", "again"),
        searchOutput("call_search_2", [calendarNamespace(), calendarNamespace()]),
      ]),
      true,
    );

    expect(
      toolNames(out).filter((name) => name === "mcp__codex_apps__calendar_create_event"),
    ).toHaveLength(1);

    const references = array(get(out, "messages"))
      .flatMap((message) => array(get(message, "content")))
      .filter((block) =>
        array(get(block, "content")).some(
          (part) =>
            get(part, "type") === "tool_reference" &&
            get(part, "tool_name") === "mcp__codex_apps__calendar_create_event",
        ),
      )
      .map((block) => get(block, "tool_use_id"));

    expect(references).toEqual(["call_search_1", "call_search_2"]);
  });

  it("drops cache_control from deferred tools, even when the client sent one", () => {
    const cached = searchOutput("call_search_1", [
      {
        type: "function",
        name: "cached_fn",
        description: "Cached.",
        cache_control: { type: "ephemeral" },
        defer_loading: true,
        parameters: { type: "object", properties: {} },
      },
      {
        type: "custom",
        name: "cached_custom",
        description: "Cached custom.",
        cache_control: { type: "ephemeral" },
        defer_loading: true,
      },
    ]);

    const out = toClaude(request([userTurn(), searchCall1(), cached]), true);

    for (const name of ["cached_fn", "cached_custom"]) {
      const tool = toolNamed(out, name);
      expect(get(tool, "defer_loading")).toBe(true);
      expect(get(tool, "cache_control")).toBeUndefined();
    }
  });
});

describe("native tool search: deferred anchor", () => {
  it("is present from the first request, between declared and discovered tools, and never referenced", () => {
    const turn1 = toClaude(request([userTurn()]), true);
    const turn2 = toClaude(request([userTurn(), searchCall1(), searchOutput1()]), true);

    expect(toolNames(turn1)).toEqual(["exec_command", "tool_search", ANCHOR]);
    const anchor = toolNamed(turn1, ANCHOR);
    expect(get(anchor, "defer_loading")).toBe(true);
    expect(get(anchor, "cache_control")).toBeUndefined();

    // Request N's tools are a prefix of request N+1's.
    const earlier = array(get(turn1, "tools"));
    expect(array(get(turn2, "tools")).slice(0, earlier.length)).toEqual(earlier);
    expect(array(get(turn2, "tools")).length).toBeGreaterThan(earlier.length);
    expect(JSON.stringify(get(turn2, "messages.2.content.0.content"))).not.toContain(ANCHOR);
  });

  it.each([
    ["exact declared name", ANCHOR],
    ["normalized name", "tool.search.deferred.anchor"],
  ])("yields to a client tool with the anchor's name (%s)", (_label, name) => {
    const out = toClaude(
      {
        model: "claude-sonnet-4-5",
        input: "hi",
        tools: [
          toolSearchDeclaration(),
          {
            type: "function",
            name,
            description: "Client tool.",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      true,
    );

    const matches = array(get(out, "tools")).filter((tool) => get(tool, "name") === ANCHOR);
    expect(matches).toHaveLength(1);
    expect(get(matches[0], "description")).toBe("Client tool.");
  });

  it("is absent without native tool search", () => {
    const out = toClaude(request([userTurn()], [execCommand(), deferredTool()]), true);
    expect(JSON.stringify(out)).not.toContain(ANCHOR);
    expect(JSON.stringify(toClaude(request([userTurn()]), false))).not.toContain(ANCHOR);
  });
});

/** The request with every client tool_search declaration and tool_search_* item removed (Go `StripResponsesToolSearch`). */
const stripped = (body: Json): Json => {
  const copy = structuredClone(body) as { tools?: Json[]; input?: Json[] };

  const isSearch = (tool: Json): boolean =>
    get(tool, "type") === "tool_search" && get(tool, "execution") === "client";

  if (copy.tools !== undefined) copy.tools = copy.tools.filter((tool) => !isSearch(tool));

  if (copy.input !== undefined) {
    copy.input = copy.input
      .filter(
        (item) => !["tool_search_call", "tool_search_output"].includes(asString(get(item, "type"))),
      )
      .map((item) =>
        get(item, "type") === "additional_tools"
          ? {
              ...(item as object),
              tools: array(get(item, "tools")).filter((tool) => !isSearch(tool)),
            }
          : item,
      );
  }

  return copy;
};

describe("tool search off", () => {
  const cases: Array<[string, Json]> = [
    ["declaration only", request([userTurn()])],
    ["with history", request([userTurn(), searchCall1(), searchOutput1()])],
    [
      "named declaration and additional_tools",
      request(
        [
          userTurn(),
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ ...(toolSearchDeclaration() as object), name: "ToolSearch" }, execCommand()],
          },
          searchCall1(),
        ],
        [{ ...(toolSearchDeclaration() as object), name: "ToolSearch" }, deferredTool()],
      ),
    ],
  ];

  it.each(cases)(
    "equals the translation of the request without tool_search (%s)",
    (_label, body) => {
      const off = toClaude(body, false);
      expect(off).toEqual(toClaude(stripped(body), false));
      expect(JSON.stringify(off)).not.toContain("tool_search");
      expect(JSON.stringify(off)).not.toContain("tool_reference");
      expect(JSON.stringify(off)).not.toContain("defer_loading");
    },
  );

  it("keeps the deferred tools declared, as before tool_search support", () => {
    const out = toClaude(request([userTurn()]), false);
    expect(toolNames(out)).toEqual(["exec_command", "lookup_order", "mcp__node_repl__js"]);
  });
});

describe("a user function named tool_search", () => {
  const userFunction = (): Json => ({
    type: "function",
    name: "tool_search",
    description: "User tool.",
    parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
  });

  const body = (): Json => ({
    model: "claude-sonnet-4-5",
    input: "hi",
    tools: [userFunction(), toolSearchDeclaration(), deferredTool()],
  });

  it("is never deferred, and keeps the deferred tools declared", () => {
    const out = toClaude(body(), true);

    expect(JSON.stringify(out)).not.toContain("defer_loading");
    expect(JSON.stringify(out)).not.toContain(ANCHOR);
    expect(toolNames(out)).toEqual(["tool_search", "lookup_order"]);
    expect(get(toolNamed(out, "tool_search"), "description")).toBe("User tool.");
  });

  it.each([true, false])("maps back to function_call with the flag %s", (flag) => {
    const original = body();

    const message = (name: string): string =>
      [
        `data: {"type":"message_start","message":{"id":"msg_u","usage":{"input_tokens":1,"output_tokens":0}}}`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_u","name":"${name}","input":{}}}`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":\\"abc\\"}"}}`,
        `data: {"type":"content_block_stop","index":0}`,
        `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}`,
        `data: {"type":"message_stop"}`,
      ].join("\n");

    const nonStream = builtinTranslators.translateNonStream(
      "openai-response",
      "claude",
      {
        model: "claude-test",
        originalRequest: original,
        translatedRequest: undefined,
        state: makeTranslationState(),
        nativeToolSearch: flag,
      },
      message("tool_search"),
    );

    const item = get(tryParseJson(nonStream ?? ""), "output.0");
    expect(get(item, "type")).toBe("function_call");
    expect(get(item, "name")).toBe("tool_search");
    expect(get(item, "arguments")).toBe('{"x":"abc"}');
  });
});

const searchStream = [
  `data: {"type":"message_start","message":{"id":"msg_ts","usage":{"input_tokens":1,"output_tokens":0}}}`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_search","name":"tool_search","input":{}}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"calendar"}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" create\\",\\"limit\\":8}"}}`,
  `data: {"type":"content_block_stop","index":0}`,
  `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_cal","name":"mcp__codex_apps__calendar_create_event","input":{}}}`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"title\\":\\"Standup\\"}"}}`,
  `data: {"type":"content_block_stop","index":1}`,
  `data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_exec","name":"exec_command","input":{}}}`,
  `data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}`,
  `data: {"type":"content_block_stop","index":2}`,
  `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}`,
  `data: {"type":"message_stop"}`,
];

const contextFor = (original: Json, nativeToolSearch: boolean) => ({
  model: "claude-test",
  originalRequest: original,
  translatedRequest: undefined,
  state: makeTranslationState(),
  nativeToolSearch,
});

const assertSearchCall = (item: Json | undefined): void => {
  expect(get(item, "type")).toBe("tool_search_call");
  expect(get(item, "call_id")).toBe("toolu_search");
  expect(get(item, "execution")).toBe("client");
  expect(get(item, "status")).toBe("completed");
  expect(get(item, "id")).toBe("tsc_toolu_search");
  expect(get(item, "arguments")).toEqual({ query: "calendar create", limit: 8 });
};

const assertOrdinaryCalls = (calendar: Json | undefined, exec: Json | undefined): void => {
  expect(get(calendar, "type")).toBe("function_call");
  expect(get(calendar, "name")).toBe("calendar_create_event");
  expect(get(calendar, "namespace")).toBe("mcp__codex_apps__");
  expect(get(calendar, "arguments")).toBe('{"title":"Standup"}');
  expect(get(exec, "type")).toBe("function_call");
  expect(get(exec, "name")).toBe("exec_command");
  expect(get(exec, "namespace")).toBeUndefined();
};

describe("native tool search: response", () => {
  const original = (): Json => request([userTurn(), searchCall1(), searchOutput1()]);

  it("maps a streamed search call to a tool_search_call and restores discovered tool identities", () => {
    const context = contextFor(original(), true);

    const events = searchStream
      .flatMap((line) =>
        builtinTranslators.translateStream("openai-response", "claude", context, line),
      )
      .flatMap(dataEvents);

    const types = events.map((event) => asString(get(event, "type")));

    const argumentEvents = events.filter((event) =>
      asString(get(event, "type")).startsWith("response.function_call_arguments"),
    );

    // The search call (output index 0) never streams argument events.
    expect(argumentEvents.filter((event) => get(event, "output_index") === 0)).toEqual([]);
    expect(types.filter((type) => type === "response.output_item.added")).toHaveLength(3);

    const done = events.flatMap((event) =>
      get(event, "type") === "response.output_item.done" ? [get(event, "item")] : [],
    );

    expect(done).toHaveLength(3);
    expect(
      get(
        events.find((event) => get(event, "type") === "response.output_item.added"),
        "item.execution",
      ),
    ).toBe("client");
    assertSearchCall(done[0]);
    assertOrdinaryCalls(done[1], done[2]);

    const completed = array(
      get(
        events.find((event) => get(event, "type") === "response.completed"),
        "response.output",
      ),
    );

    expect(completed).toHaveLength(3);
    assertSearchCall(completed[0]);
    assertOrdinaryCalls(completed[1], completed[2]);
  });

  it("maps a non-stream search call the same way", () => {
    const out = builtinTranslators.translateNonStream(
      "openai-response",
      "claude",
      contextFor(original(), true),
      searchStream.join("\n"),
    );

    const output = array(get(tryParseJson(out ?? ""), "output"));
    expect(output).toHaveLength(3);
    assertSearchCall(output[0]);
    assertOrdinaryCalls(output[1], output[2]);
  });

  it.each([
    ["max_tokens mid input", ['{\\"query\\":\\"calen'], false, "max_tokens", {}],
    [
      "max_tokens after complete input",
      ['{\\"query\\":\\"calendar\\"}'],
      true,
      "max_tokens",
      { query: "calendar" },
    ],
    ["tool_use stop without input", [], true, "tool_use", {}],
  ])(
    "reports a truncated search call as incomplete (%s)",
    (_label, deltas, stopped, stopReason, args) => {
      const lines = [
        `data: {"type":"message_start","message":{"id":"msg_trunc","usage":{"input_tokens":1,"output_tokens":0}}}`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_search","name":"tool_search","input":{}}}`,
        ...deltas.map(
          (partial) =>
            `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"${partial}"}}`,
        ),
        ...(stopped ? [`data: {"type":"content_block_stop","index":0}`] : []),
        `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":5}}`,
        `data: {"type":"message_stop"}`,
      ];

      const context = contextFor(request([userTurn()]), true);

      const events = lines
        .flatMap((line) =>
          builtinTranslators.translateStream("openai-response", "claude", context, line),
        )
        .flatMap(dataEvents);

      const done = get(
        events.findLast((event) => get(event, "type") === "response.output_item.done"),
        "item",
      );

      const terminal = get(
        events.find((event) =>
          ["response.completed", "response.incomplete"].includes(asString(get(event, "type"))),
        ),
        "response.output.0",
      );

      for (const item of [done, terminal]) {
        expect(get(item, "type")).toBe("tool_search_call");
        expect(get(item, "status")).toBe("incomplete");
        expect(get(item, "arguments")).toEqual(args);
      }
    },
  );
});

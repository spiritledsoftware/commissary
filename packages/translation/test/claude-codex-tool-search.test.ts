// Claude client -> Codex / Chat: mid-conversation `tool_addition` blocks and deferred-tool discovery (Go:
// internal/translator/codex/claude/codex_claude_{request,response}_test.go, internal/translator/openai/claude/
// openai_claude_request_test.go; upstream 12d97cfe, 374056f2).
import { describe, expect, it } from "vitest";
import {
  asString,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const toCodex = (body: Json, model = "gpt-6-astra"): Json =>
  builtinTranslators.translateRequest("claude", "codex", {
    format: "claude",
    model,
    stream: false,
    body,
  }).body;

const toChat = (body: Json, model = "gpt-5"): Json =>
  builtinTranslators.translateRequest("claude", "openai", {
    format: "claude",
    model,
    stream: false,
    body,
  }).body;

const array = (value: Json | undefined): Json[] => (isJsonArray(value) ? value : []);

const inputItems = (out: Json): Json[] => array(get(out, "input"));

const additionalToolNames = (item: Json | undefined): string[] =>
  array(get(item, "tools")).map((tool) => asString(get(tool, "name")));

const schemaOf = (properties: JsonObject = {}): JsonObject => ({ type: "object", properties });

const eagerLongTool =
  "mcp__alpha_very_long_server_name_for_testing__deliver_final_subagent_handback_report";

const deferredLongTool =
  "mcp__bravo_very_long_server_name_for_testing__deliver_final_subagent_handback_report";

describe("Claude -> Codex: tool_addition", () => {
  const longMcpTool =
    "mcp__very_long_server_name_for_testing__deliver_final_subagent_handback_report";

  const request = (): Json => ({
    model: "gpt-6.1-sol",
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: schemaOf({ path: { type: "string" } }),
      },
      {
        name: "deferred_lookup",
        description: "Look up deferred notes",
        defer_loading: true,
        input_schema: { ...schemaOf({ query: { type: "string" } }), required: ["query"] },
      },
    ],
    messages: [
      { role: "user", content: "Start task" },
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "<system-reminder>SubagentHandback is now available</system-reminder>",
          },
          {
            type: "tool_addition",
            tool: {
              type: "tool_definition",
              definition: {
                name: "SubagentHandback",
                description: "Deliver subagent report",
                input_schema: {
                  $schema: "https://json-schema.org/draft/2020-12/schema",
                  ...schemaOf({ summary: { type: "string" } }),
                  required: ["summary"],
                },
              },
            },
          },
          { type: "tool_addition", tool: { type: "tool_reference", name: "deferred_lookup" } },
          { type: "tool_removal", tool: { type: "tool_reference", name: "Read" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Read", input: { path: "README.md" } }],
      },
      {
        role: "system",
        content: [
          {
            type: "tool_addition",
            tool: {
              type: "tool_definition",
              definition: {
                name: longMcpTool,
                description: "Long MCP handback tool",
                input_schema: { type: "object" },
              },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "file contents" },
          { type: "text", text: "Finish up" },
        ],
      },
    ],
  });

  it("becomes additional_tools items at their position, leaving top-level tools and tool adjacency alone", () => {
    const out = toCodex(request(), "gpt-6.1-sol");

    // The deferred tool is withheld, so the top-level tools never change.
    expect(array(get(out, "tools")).map((tool) => asString(get(tool, "name")))).toEqual(["Read"]);

    const items = inputItems(out);
    expect(items.map((item) => asString(get(item, "type")))).toEqual([
      "message",
      "message",
      "additional_tools",
      "function_call",
      "function_call_output",
      "additional_tools",
      "message",
    ]);

    const first = items[2];
    expect(get(first, "role")).toBe("developer");
    expect(additionalToolNames(first)).toEqual(["SubagentHandback", "deferred_lookup"]);

    const handback = array(get(first, "tools"))[0];
    expect(get(handback, "type")).toBe("function");
    expect(get(handback, "strict")).toBe(false);
    expect(get(handback, "input_schema")).toBeUndefined();
    expect(get(handback, "parameters.$schema")).toBeUndefined();
    expect(get(handback, "parameters.properties.summary.type")).toBe("string");
    expect(get(array(get(first, "tools"))[1], "defer_loading")).toBeUndefined();

    const [late] = additionalToolNames(items[5]);
    expect(late).not.toBe(longMcpTool);
    expect(late?.length).toBeLessThanOrEqual(64);
  });

  it("restores the shortened name of a mid-conversation tool in the response", () => {
    const topLong =
      "mcp__alpha_very_long_server_name_for_testing__deliver_final_subagent_handback_report";

    const midLong =
      "mcp__bravo_very_long_server_name_for_testing__deliver_final_subagent_handback_report";

    const original = {
      model: "gpt-6.1-sol",
      tools: [{ name: topLong, input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "hi" },
        {
          role: "system",
          content: [
            {
              type: "tool_addition",
              tool: {
                type: "tool_definition",
                definition: { name: midLong, input_schema: { type: "object" } },
              },
            },
          ],
        },
      ],
    };

    const translated = toCodex(original, "gpt-6.1-sol");
    const topShort = asString(get(translated, "tools.0.name"));
    const midShort = asString(get(inputItems(translated)[1], "tools.0.name"));
    expect(topShort).not.toBe("");
    expect(midShort).not.toBe("");
    expect(midShort).not.toBe(topShort);

    const context: ResponseContext = {
      model: "gpt-6.1-sol",
      originalRequest: original,
      translatedRequest: translated,
      state: makeTranslationState(),
    };

    const streamed = builtinTranslators
      .translateStream(
        "claude",
        "codex",
        context,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":${JSON.stringify(midShort)},"arguments":""}}`,
      )
      .join("");

    expect(streamed).toContain(`"name":"${midLong}"`);

    const completed = `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-6.1-sol","status":"completed","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":${JSON.stringify(topShort)},"arguments":"{}"},{"type":"function_call","id":"fc_2","call_id":"call_2","name":${JSON.stringify(midShort)},"arguments":"{}"}],"usage":{"input_tokens":10,"output_tokens":5}}}`;

    const nonStream = builtinTranslators.translateNonStream(
      "claude",
      "codex",
      { ...context, state: makeTranslationState() },
      completed,
    );

    const body = tryParseJson(nonStream ?? "");
    expect(get(body, "content.0.name")).toBe(topLong);
    expect(get(body, "content.1.name")).toBe(midLong);
  });
});

const deferred = (name: string, properties: JsonObject = {}): Json => ({
  name,
  description: `${name} tool`,
  defer_loading: true,
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...schemaOf(properties),
  },
});

const discoveryTurn = (refs: string[], callId = "toolu_search_1"): Json[] => [
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: callId,
        name: "ToolSearch",
        input: { query: "select:web", max_results: 2 },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: callId,
        content: refs.map((tool_name) => ({ type: "tool_reference", tool_name })),
      },
    ],
  },
];

describe("Claude -> Codex: deferred tool discovery", () => {
  const search = { name: "ToolSearch", input_schema: { type: "object" } };

  const tools = (): Json[] => [
    search,
    deferred("WebFetch", { url: { type: "string" } }),
    deferred("WebSearch", { query: { type: "string" } }),
    { name: "Workflow", description: "Run workflow", input_schema: schemaOf() },
    deferred("DeferredToolPlaceholder"),
    { name: "Write", description: "Write file", input_schema: schemaOf() },
  ];

  it("withholds deferred tools from top-level tools and emits each once where discovered", () => {
    const before = toCodex({
      tools: tools(),
      messages: [{ role: "user", content: "Load WebSearch and WebFetch" }],
    });

    const after = toCodex({
      tools: tools(),
      messages: [
        { role: "user", content: "Load WebSearch and WebFetch" },
        ...discoveryTurn(["WebSearch", "WebFetch", "WebSearch"]),
      ],
    });

    expect(array(get(after, "tools")).map((tool) => asString(get(tool, "name")))).toEqual([
      "ToolSearch",
      "Workflow",
      "Write",
    ]);
    // Request N+1's top-level tools and earlier items are byte-identical to request N's.
    expect(JSON.stringify(get(after, "tools"))).toBe(JSON.stringify(get(before, "tools")));

    const beforeItems = inputItems(before);
    const afterItems = inputItems(after);
    expect(beforeItems).toHaveLength(1);
    expect(afterItems.map((item) => asString(get(item, "type")))).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "additional_tools",
    ]);
    expect(JSON.stringify(afterItems.slice(0, beforeItems.length))).toBe(
      JSON.stringify(beforeItems),
    );

    const added = afterItems[3];
    expect(get(added, "role")).toBe("developer");
    // Reference order, deduplicated.
    expect(additionalToolNames(added)).toEqual(["WebSearch", "WebFetch"]);

    for (const tool of array(get(added, "tools"))) {
      expect(get(tool, "defer_loading")).toBeUndefined();
      expect(get(tool, "input_schema")).toBeUndefined();
      expect(get(tool, "parameters.$schema")).toBeUndefined();
      expect(get(tool, "strict")).toBe(false);
    }
  });

  it("keeps the earlier turns byte-identical after one more discovery", () => {
    const first = toCodex({
      tools: tools(),
      messages: [{ role: "user", content: "go" }, ...discoveryTurn(["WebSearch"])],
    });

    const second = toCodex({
      tools: tools(),
      messages: [
        { role: "user", content: "go" },
        ...discoveryTurn(["WebSearch"]),
        ...discoveryTurn(["WebFetch"], "toolu_search_2"),
      ],
    });

    expect(JSON.stringify(get(second, "tools"))).toBe(JSON.stringify(get(first, "tools")));
    const firstItems = inputItems(first);
    expect(JSON.stringify(inputItems(second).slice(0, firstItems.length))).toBe(
      JSON.stringify(firstItems),
    );
    expect(
      inputItems(second)
        .filter((item) => get(item, "type") === "additional_tools")
        .map(additionalToolNames),
    ).toEqual([["WebSearch"], ["WebFetch"]]);
  });

  it("keeps short names stable when a colliding deferred tool is added", () => {
    const eager: Json = {
      name: eagerLongTool,
      description: "Eager MCP tool",
      input_schema: { type: "object" },
    };

    const before = toCodex({
      tools: [search, eager],
      messages: [{ role: "user", content: "Search tools" }],
    });

    const original: Json = {
      tools: [
        search,
        {
          name: deferredLongTool,
          description: "Deferred MCP tool inserted before eager tool",
          defer_loading: true,
          input_schema: { type: "object" },
        },
        eager,
      ],
      messages: [
        { role: "user", content: "Search tools" },
        ...discoveryTurn([deferredLongTool], "call_ts_1"),
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_ts_2", name: "ToolSearch", input: { query: "again" } },
            { type: "tool_use", id: "call_mcp_1", name: deferredLongTool, input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_ts_2",
              content: [{ type: "tool_reference", tool_name: deferredLongTool }],
            },
            { type: "tool_result", tool_use_id: "call_mcp_1", content: "done" },
          ],
        },
      ],
    };

    const after = toCodex(original);

    expect(JSON.stringify(get(after, "tools"))).toBe(JSON.stringify(get(before, "tools")));

    const items = inputItems(after);
    const additions = items.filter((item) => get(item, "type") === "additional_tools");
    // The second search names an already loaded tool: no duplicate item.
    expect(additions).toHaveLength(1);

    const deferredShort = asString(get(additions[0], "tools.0.name"));
    const eagerShort = asString(get(after, "tools.1.name"));
    expect(deferredShort).not.toBe(deferredLongTool);
    expect(deferredShort.length).toBeLessThanOrEqual(64);
    expect(deferredShort).not.toBe(eagerShort);
    // The non-deferred tool keeps the base name; the deferred one takes the suffix.
    expect(deferredShort.endsWith("_1")).toBe(true);

    const call = items.find((item) => get(item, "call_id") === "call_mcp_1");
    expect(get(call, "name")).toBe(deferredShort);

    const output = items.find(
      (item) =>
        get(item, "type") === "function_call_output" && get(item, "call_id") === "call_ts_1",
    );

    expect(asString(get(output, "output"))).toContain(deferredShort);

    // The response maps both short names back.
    const completed = `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-6-astra","status":"completed","output":[{"type":"function_call","id":"fc_1","call_id":"c1","name":${JSON.stringify(deferredShort)},"arguments":"{}"},{"type":"function_call","id":"fc_2","call_id":"c2","name":${JSON.stringify(eagerShort)},"arguments":"{}"}],"usage":{"input_tokens":1,"output_tokens":1}}}`;

    const body = tryParseJson(
      builtinTranslators.translateNonStream(
        "claude",
        "codex",
        {
          model: "gpt-6-astra",
          originalRequest: original,
          translatedRequest: after,
          state: makeTranslationState(),
        },
        completed,
      ) ?? "",
    );

    expect(get(body, "content.0.name")).toBe(deferredLongTool);
    expect(get(body, "content.1.name")).toBe(eagerLongTool);
  });

  it("keeps mixed tool_result content and skips unknown references", () => {
    const out = toCodex({
      tools: [search, deferred("WebSearch", { query: { type: "string" } })],
      messages: [
        { role: "user", content: "Find tools" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "ToolSearch", input: { query: "web" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: "Matched tools:" },
                { type: "tool_reference", tool_name: "WebSearch" },
                { type: "tool_reference", tool_name: "NonExistentTool" },
              ],
            },
          ],
        },
      ],
    });

    const items = inputItems(out);

    const output = array(
      get(
        items.find((item) => get(item, "type") === "function_call_output"),
        "output",
      ),
    );

    expect(output).toHaveLength(3);
    expect(get(output[0], "text")).toBe("Matched tools:");
    expect(asString(get(output[1], "text"))).toContain("WebSearch");

    const additions = items.filter((item) => get(item, "type") === "additional_tools");
    expect(additions.map(additionalToolNames)).toEqual([["WebSearch"]]);
  });

  it("orders standalone references and search results with the surrounding text", () => {
    const out = toCodex({
      tools: [
        search,
        deferred("WebSearch", { query: { type: "string" } }),
        deferred("WebFetch", { url: { type: "string" } }),
        deferred(deferredLongTool),
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before standalone ref" },
            { type: "tool_reference", tool_name: "WebSearch" },
            { type: "text", text: "between ref and search result" },
            {
              type: "tool_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: {
                type: "tool_search_tool_search_result",
                tool_references: [{ type: "tool_reference", tool_name: "WebFetch" }],
              },
            },
            { type: "text", text: "after search result" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_img_ref", name: "ToolSearch", input: { query: "long" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_img_ref",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                },
                { type: "tool_reference", tool_name: deferredLongTool },
              ],
            },
          ],
        },
      ],
    });

    const items = inputItems(out);
    expect(items.map((item) => asString(get(item, "type")))).toEqual([
      "message",
      "additional_tools",
      "message",
      "additional_tools",
      "message",
      "function_call",
      "function_call_output",
      "additional_tools",
    ]);
    expect(get(items[0], "content.0.text")).toBe("before standalone ref");
    expect(additionalToolNames(items[1])).toEqual(["WebSearch"]);
    expect(get(items[2], "content.0.text")).toBe("between ref and search result");
    expect(additionalToolNames(items[3])).toEqual(["WebFetch"]);
    expect(get(items[4], "content.0.text")).toBe("after search result");

    const output = array(get(items[6], "output"));
    expect(output.map((part) => asString(get(part, "type")))).toEqual([
      "input_image",
      "input_text",
    ]);
    const [short] = additionalToolNames(items[7]);
    expect(short).not.toBe(deferredLongTool);
    expect(asString(get(output[1], "text"))).toContain(short);
  });
});

describe("Claude -> Chat: tool_addition", () => {
  it("merges the definitions into tools and maps the tool name back in the response", () => {
    const original: Json = {
      model: "gpt-5",
      tools: [
        {
          name: "Read",
          description: "Read file",
          input_schema: schemaOf({ path: { type: "string" } }),
        },
      ],
      messages: [
        { role: "user", content: "start" },
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "<system-reminder>SubagentHandback is now available</system-reminder>",
            },
            {
              type: "tool_addition",
              tool: {
                type: "tool_definition",
                definition: {
                  name: "SubagentHandback",
                  description: "Deliver subagent report",
                  input_schema: {
                    ...schemaOf({ summary: { type: "string" } }),
                    required: ["summary"],
                  },
                },
              },
            },
          ],
        },
      ],
    };

    const out = toChat(original);
    const tools = array(get(out, "tools"));
    expect(tools).toHaveLength(2);
    expect(get(tools[1], "function.name")).toBe("SubagentHandback");
    expect(get(tools[1], "function.parameters.properties.summary.type")).toBe("string");

    const response = `{"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"subagenthandback","arguments":"{\\"summary\\":\\"done\\"}"}}]}}]}`;

    const body = tryParseJson(
      builtinTranslators.translateNonStream(
        "claude",
        "openai",
        {
          model: "gpt-5",
          originalRequest: original,
          translatedRequest: out,
          state: makeTranslationState(),
        },
        response,
      ) ?? "",
    );

    expect(get(body, "content.0.name")).toBe("SubagentHandback");
  });

  it("replaces a top-level tool of the same name", () => {
    const out = toChat({
      tools: [{ name: "Read", description: "old", input_schema: schemaOf() }],
      messages: [
        { role: "user", content: "start" },
        {
          role: "system",
          content: [
            {
              type: "tool_addition",
              tool: {
                type: "tool_definition",
                definition: { name: "Read", description: "new", input_schema: schemaOf() },
              },
            },
          ],
        },
      ],
    });

    expect(array(get(out, "tools")).map((tool) => get(tool, "function.description"))).toEqual([
      "new",
    ]);
  });
});

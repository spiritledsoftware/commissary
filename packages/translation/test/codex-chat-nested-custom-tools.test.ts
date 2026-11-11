// Nested Chat Completions custom tools ({type:"custom", custom:{...}}) across the Codex round trip (Go:
// internal/translator/codex/openai/chat-completions/codex_openai_{request,response}_test.go; upstream 2443e883).
import { describe, expect, it } from "vitest";
import { get, type Json, tryParseJson } from "@commissary/json";
import { convertOpenAIRequestToCodex } from "../src/translator/codex/openai-chat/request.ts";
import {
  convertCodexResponseToOpenAI,
  convertCodexResponseToOpenAINonStream,
} from "../src/translator/codex/openai-chat/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (original: Json, translated?: Json): ResponseContext => ({
  model: "m",
  originalRequest: original,
  translatedRequest: translated,
  state: makeTranslationState(),
});

describe("nested custom tool declaration", () => {
  const cases: ReadonlyArray<readonly [string, string, Json | undefined]> = [
    [
      "grammar",
      `,"format":{"type":"grammar","grammar":{"syntax":"lark","definition":"start: patch"}}`,
      { type: "grammar", syntax: "lark", definition: "start: patch" },
    ],
    ["text", `,"format":{"type":"text"}`, { type: "text" }],
    ["default", "", undefined],
  ];

  it.each(cases)("flattens the %s format", (_name, format, want) => {
    const input = parse(`{
      "messages":[
        {"role":"assistant","tool_calls":[{"id":"call_patch","type":"function","function":{"name":"apply_patch","arguments":"{\\"input\\":\\"patch\\"}"}}]},
        {"role":"tool","tool_call_id":"call_patch","content":"done"}
      ],
      "tools":[
        {"type":"function","function":{"name":"bash"}},
        {"type":"custom","custom":{"name":"apply_patch","description":"Edit files"${format}}}
      ],
      "tool_choice":{"type":"custom","custom":{"name":"apply_patch"}}
    }`);

    const out = convertOpenAIRequestToCodex("codex-test", input, true);
    const tool = get(out, "tools.1");

    expect(get(tool, "custom")).toBeUndefined();
    expect(get(tool, "type")).toBe("custom");
    expect(get(tool, "name")).toBe("apply_patch");
    expect(get(tool, "description")).toBe("Edit files");
    expect(get(tool, "format")).toEqual(want);
    expect(get(out, "tool_choice.name")).toBe("apply_patch");
    expect(get(out, "input.0.type")).toBe("custom_tool_call");
    expect(get(out, "input.0.input")).toBe("patch");
    expect(get(out, "input.1.type")).toBe("custom_tool_call_output");
  });

  it("shortens a nested custom name in tools, tool_choice and history", () => {
    const name = "custom_tool_".repeat(7);

    const input = parse(
      JSON.stringify({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_long", type: "function", function: { name, arguments: "raw" } },
            ],
          },
          { role: "tool", tool_call_id: "call_long", content: "ok" },
        ],
        tools: [{ type: "custom", custom: { name } }],
        tool_choice: { type: "custom", custom: { name } },
      }),
    );

    const out = convertOpenAIRequestToCodex("codex-test", input, true);
    const shortName = get(out, "tools.0.name");

    expect(typeof shortName === "string" && shortName.length > 0 && shortName.length <= 64).toBe(
      true,
    );
    expect(shortName).not.toBe(name);
    expect(get(out, "tool_choice.name")).toBe(shortName);
    expect(get(out, "input.0.type")).toBe("custom_tool_call");
    expect(get(out, "input.0.name")).toBe(shortName);
  });
});

describe("apply_patch winner detection with nested custom tools", () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["flat custom", `[{"type":"custom","name":"apply_patch"}]`, true],
    ["nested custom", `[{"type":"custom","custom":{"name":"apply_patch"}}]`, true],
    ["function", `[{"type":"function","name":"apply_patch"}]`, false],
    [
      "nested custom before function",
      `[{"type":"custom","custom":{"name":"apply_patch"}},{"type":"function","function":{"name":"apply_patch"}}]`,
      false,
    ],
    [
      "function before nested custom",
      `[{"type":"function","function":{"name":"apply_patch"}},{"type":"custom","custom":{"name":"apply_patch"}}]`,
      false,
    ],
  ];

  const patch = '*** Begin Patch\n+中文😀 "\\path\\\n*** End Patch\n';

  it.each(cases)("%s (non-stream)", (_name, tools, wrap) => {
    const request = parse(`{"tools":${tools}}`);

    const out = convertCodexResponseToOpenAINonStream(
      context(request, request),
      JSON.stringify({
        type: "response.completed",
        response: {
          output: [{ type: "custom_tool_call", name: "apply_patch", call_id: "c", input: patch }],
        },
      }),
    );

    expect(get(parse(out), "choices.0.message.tool_calls.0.function.arguments")).toBe(
      wrap ? JSON.stringify({ input: patch }) : patch,
    );
  });

  it.each(cases.filter(([, , wrap]) => wrap))("%s (stream done fallback)", (_name, tools) => {
    const request = parse(`{"tools":${tools}}`);

    const out = convertCodexResponseToOpenAI(
      context(request, request),
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "custom_tool_call", id: "a", call_id: "c", name: "apply_patch", input: "p" },
      })}`,
    );

    expect(out).toHaveLength(1);
    expect(get(parse(out[0] ?? ""), "choices.0.delta.tool_calls.0.function.arguments")).toBe(
      '{"input":"p"}',
    );
  });

  it("leaves the original request untouched", () => {
    const request = parse(`{"tools":[{"type":"custom","custom":{"name":"apply_patch"}}]}`);
    const before = JSON.stringify(request);

    convertCodexResponseToOpenAINonStream(
      context(request, request),
      JSON.stringify({
        type: "response.completed",
        response: {
          output: [{ type: "custom_tool_call", name: "apply_patch", call_id: "c", input: "p" }],
        },
      }),
    );

    convertCodexResponseToOpenAI(
      context(request, request),
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "custom_tool_call", id: "a", call_id: "c", name: "apply_patch", input: "p" },
      })}`,
    );

    expect(JSON.stringify(request)).toBe(before);
  });

  it("leaves the client's original request unchanged", () => {
    const request = parse(`{"tools":[{"type":"custom","custom":{"name":"apply_patch"}}]}`);
    const before = JSON.stringify(request);

    convertCodexResponseToOpenAINonStream(
      context(request, request),
      JSON.stringify({
        type: "response.completed",
        response: {
          output: [{ type: "custom_tool_call", name: "apply_patch", call_id: "c", input: "p" }],
        },
      }),
    );

    expect(JSON.stringify(request)).toBe(before);
  });

  it("round-trips a nested grammar apply_patch through history", () => {
    const patch2 = '*** Begin Patch\n+中文😀 "quoted" \\path\\\n*** End Patch';
    const tools = `[{"type":"custom","custom":{"name":"apply_patch","description":"Edit files","format":{"type":"grammar","grammar":{"syntax":"lark","definition":"start: patch"}}}}]`;
    const original = parse(`{"messages":[{"role":"user","content":"patch"}],"tools":${tools}}`);
    const initial = convertOpenAIRequestToCodex("m", original, true);

    expect(get(initial, "tools.0.custom")).toBeUndefined();

    const response = convertCodexResponseToOpenAINonStream(
      context(original, initial),
      JSON.stringify({
        type: "response.completed",
        response: {
          output: [{ type: "custom_tool_call", call_id: "c", name: "apply_patch", input: patch2 }],
        },
      }),
    );

    const message = get(parse(response), "choices.0.message");

    expect(get(message, "tool_calls.0.function.arguments")).toBe(JSON.stringify({ input: patch2 }));

    const followup = parse(
      JSON.stringify({
        messages: [
          { role: "user", content: "patch" },
          message,
          { role: "tool", tool_call_id: "c", content: "ok" },
          { role: "assistant", content: "Patch applied." },
        ],
        tools: parse(tools),
      }),
    );

    const request = convertOpenAIRequestToCodex("m", followup, true);

    expect(get(request, "input.1.type")).toBe("custom_tool_call");
    expect(get(request, "input.1.input")).toBe(patch2);
    expect(get(request, "input.2.type")).toBe("custom_tool_call_output");
    expect(get(request, "input.3.content.0.text")).toBe("Patch applied.");
  });
});

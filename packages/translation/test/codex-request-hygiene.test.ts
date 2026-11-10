// Codex request hygiene in the OpenAI -> Codex translators (Go: internal/translator/codex/openai/chat-completions/
// codex_openai_request_test.go and internal/translator/codex/openai/responses/codex_openai-responses_request_test.go;
// upstream 99d1698f, b0debb35, 05e668cf).
import { describe, expect, it } from "vitest";
import { get, type Json, tryParseJson } from "@commissary/json";
import { convertOpenAIRequestToCodex } from "../src/translator/codex/openai-chat/request.ts";
import { shortenCodexCallIdIfNeeded } from "../src/translator/codex/claude/request.ts";
import { convertOpenAIResponsesRequestToCodex } from "../src/translator/codex/openai-responses/request.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const items = (body: Json): Json[] => {
  const input = get(body, "input");

  return Array.isArray(input) ? input : [];
};

describe("parallel_tool_calls (99d1698f)", () => {
  const cases: ReadonlyArray<readonly [string, string, Json]> = [
    ["false preserved", `"parallel_tool_calls":false,`, false],
    ["true preserved", `"parallel_tool_calls":true,`, true],
    ["null defaults to true", `"parallel_tool_calls":null,`, true],
    ["omitted defaults to true", "", true],
  ];

  it.each(cases)("Chat Completions: %s", (_name, field, expected) => {
    const out = convertOpenAIRequestToCodex(
      "gpt-6.1-sol",
      parse(`{"model":"gpt-6.1-sol",${field}"messages":[{"role":"user","content":"hello"}]}`),
      true,
    );

    expect(get(out, "parallel_tool_calls")).toBe(expected);
  });

  it.each(cases)("Responses: %s", (_name, field, expected) => {
    const out = convertOpenAIResponsesRequestToCodex(
      "gpt-5.6",
      parse(
        `{"model":"gpt-5.6","stream":true,"store":false,${field}"include":["reasoning.encrypted_content"],"input":[{"type":"message","role":"user","content":"hello"}]}`,
      ),
      true,
    );

    expect(get(out, "parallel_tool_calls")).toBe(expected);
  });
});

describe("over-length Chat Completions tool call ids (b0debb35)", () => {
  const convert = (messages: string): Json =>
    convertOpenAIRequestToCodex(
      "gpt-6.1-sol",
      parse(
        `{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"Multi-tool"},${messages}]}`,
      ),
      true,
    );

  it("shortens calls and their outputs consistently and keeps short ids", () => {
    const shared = "a".repeat(70);
    const longA = `${shared}_A`;
    const longB = `${shared}_B`;

    const out = convert(`
      {"role":"assistant","content":null,"tool_calls":[
        {"id":"${longA}","type":"function","function":{"name":"tool_a","arguments":"{}"}},
        {"id":"${longB}","type":"function","function":{"name":"tool_b","arguments":"{}"}},
        {"id":"short_id","type":"function","function":{"name":"tool_c","arguments":"{}"}}]},
      {"role":"tool","tool_call_id":"${longA}","content":"res_a"},
      {"role":"tool","tool_call_id":"${longB}","content":"res_b"},
      {"role":"tool","tool_call_id":"short_id","content":"res_c"}`);

    const callIds = items(out)
      .filter((item) => get(item, "type") === "function_call")
      .map((item) => get(item, "call_id") as string);

    const outputIds = items(out)
      .filter((item) => get(item, "type") === "function_call_output")
      .map((item) => get(item, "call_id") as string);

    expect(callIds).toHaveLength(3);
    expect(outputIds).toEqual(callIds);

    for (const id of callIds) expect(id.length).toBeLessThanOrEqual(64);
    expect(callIds[0]).not.toBe(callIds[1]);
    expect(callIds[2]).toBe("short_id");
  });

  it("keeps results matched when a legal 64-character id equals another id's shortened form", () => {
    const longA = `${"a".repeat(70)}_A`;
    const idB = shortenCodexCallIdIfNeeded(longA);

    expect(idB).toHaveLength(64);

    const out = convert(`
      {"role":"assistant","content":null,"tool_calls":[
        {"id":"${longA}","type":"function","function":{"name":"tool_a","arguments":"{}"}},
        {"id":"${idB}","type":"function","function":{"name":"tool_b","arguments":"{}"}}]},
      {"role":"tool","tool_call_id":"${idB}","content":"res_b"},
      {"role":"tool","tool_call_id":"${longA}","content":"res_a"}`);

    const callIdByName = new Map<string, string>();
    const outputIdByResult = new Map<string, string>();

    for (const item of items(out)) {
      if (get(item, "type") === "function_call")
        callIdByName.set(get(item, "name") as string, get(item, "call_id") as string);

      if (get(item, "type") === "function_call_output")
        outputIdByResult.set(get(item, "output") as string, get(item, "call_id") as string);
    }

    expect(callIdByName.size).toBe(2);
    expect(callIdByName.get("tool_a")).not.toBe(callIdByName.get("tool_b"));
    expect(callIdByName.get("tool_b")).toBe(idB);
    expect(callIdByName.get("tool_a")!.length).toBeLessThanOrEqual(64);
    expect(outputIdByResult.get("res_a")).toBe(callIdByName.get("tool_a"));
    expect(outputIdByResult.get("res_b")).toBe(callIdByName.get("tool_b"));
  });
});

describe("orphan Responses tool outputs (05e668cf)", () => {
  const request = (): Json =>
    parse(`{
      "model":"gpt-5.4",
      "input":[
        {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},
        {"type":"function_call_output","id":"fco_1","name":"codex_apps_open_page","namespace":"agent","output":"{\\"page_id\\":null}"},
        {"type":"custom_tool_call_output","id":"fco_2","name":"custom_ctx","output":[{"type":"input_text","text":"part one"},{"type":"input_text","text":"part two"},{"type":"input_image","image_url":"https://example.com/page.png"}]},
        {"type":"function_call","call_id":"call_ok","name":"shell","arguments":""},
        {"type":"function_call_output","call_id":"call_ok","output":"ok"},
        {"type":"function_call_output","call_id":" ","output":"blank id"},
        {"type":"function_call_output","id":"fco_3","name":"create_thread","namespace":"codex_app","output":"<codex_delegation>task</codex_delegation>"},
        {"type":"function_call","call_id":"call_pair","name":"shell","arguments":"{}"},
        {"type":"function_call_output","output":"paired without call_id"}
      ]
    }`);

  it("rewrites standalone outputs without call_id into user messages and keeps paired ones", () => {
    const input = items(convertOpenAIResponsesRequestToCodex("gpt-5.4", request(), false));

    expect(input).toHaveLength(9);

    expect(input[1]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: 'Tool output from codex_apps_open_page:\n{"page_id":null}' },
      ],
    });

    expect(input[2]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Tool output from custom_ctx:\npart one\npart two" },
        { type: "input_image", image_url: "https://example.com/page.png" },
      ],
    });

    expect(get(input[3], "arguments")).toBe("{}");
    expect(get(input[4], "type")).toBe("function_call_output");
    expect(get(input[4], "call_id")).toBe("call_ok");
    expect(get(input[5], "type")).toBe("message");
    expect(get(input[5], "content.0.text")).toBe("Tool output from tool:\nblank id");
    // Codex Desktop delegation outputs stay for the orphan delegation rewrite.
    expect(get(input[6], "type")).toBe("function_call_output");
    expect(get(input[6], "namespace")).toBe("codex_app");
    expect(get(input[8], "type")).toBe("function_call_output");
    expect(get(input[8], "call_id")).toBe("call_pair");
  });

  it("describes an empty output and falls back to the raw JSON of an odd one", () => {
    const input = items(
      convertOpenAIResponsesRequestToCodex(
        "gpt-5.4",
        parse(`{"model":"gpt-5.4","input":[
          {"type":"function_call_output","name":"a","output":null},
          {"type":"function_call_output","name":"b","output":"  "},
          {"type":"function_call_output","name":"c","output":[]},
          {"type":"function_call_output","name":"d","output":{"k":1}}
        ]}`),
        false,
      ),
    );

    expect(input.map((item) => get(item, "content.0.text"))).toEqual([
      "Tool output from a:\n(empty)",
      "Tool output from b:\n(empty)",
      "Tool output from c:\n[]",
      'Tool output from d:\n{"k":1}',
    ]);
  });
});

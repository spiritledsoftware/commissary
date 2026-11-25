// Claude Messages -> Codex: tool_use blocks without an input (Go: internal/translator/codex/claude/codex_claude_request_test.go;
// upstream d2b7dbbd).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { convertClaudeRequestToCodex } from "../src/translator/codex/claude/request.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const functionCallArguments = (toolUse: string): Json | undefined => {
  const out = convertClaudeRequestToCodex(
    "gpt-5.4",
    parse(
      `{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[${toolUse}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}]}`,
    ),
    false,
  );

  const input = get(out, "input");

  const call = Array.isArray(input)
    ? input.find((item) => get(item, "type") === "function_call")
    : undefined;

  return get(call, "arguments");
};

describe("Claude -> Codex tool_use input (d2b7dbbd)", () => {
  it("defaults a missing input to an empty JSON object string", () => {
    expect(functionCallArguments(`{"type":"tool_use","id":"toolu_1","name":"lookup"}`)).toBe("{}");
  });

  it("keeps a given input", () => {
    expect(
      functionCallArguments(`{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":1}}`),
    ).toBe(`{"q":1}`);
  });
});

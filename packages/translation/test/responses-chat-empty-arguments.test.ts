// OpenAI Responses -> Chat Completions: function calls with omitted or empty arguments (Go:
// internal/translator/openai/openai/responses/openai_openai-responses_request_test.go; upstream 927ed398).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { convertOpenAIResponsesRequestToOpenAIChatCompletions } from "../src/translator/openai/openai/responses/request.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const argumentsOf = (call: string): Json | undefined => {
  const out = convertOpenAIResponsesRequestToOpenAIChatCompletions(
    "gpt-4o",
    parse(`{"input":[${call},{"type":"function_call_output","call_id":"call_1","output":"ok"}]}`),
    false,
  );

  return get(out, "messages.0.tool_calls.0.function.arguments");
};

describe("Responses -> Chat empty function arguments (927ed398)", () => {
  it("defaults omitted arguments to an empty object", () => {
    expect(argumentsOf(`{"type":"function_call","call_id":"call_1","name":"lookup"}`)).toBe("{}");
  });

  it("defaults empty and blank arguments to an empty object", () => {
    expect(
      argumentsOf(`{"type":"function_call","call_id":"call_1","name":"lookup","arguments":""}`),
    ).toBe("{}");
    expect(
      argumentsOf(`{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"  "}`),
    ).toBe("{}");
  });

  it("keeps given arguments", () => {
    expect(
      argumentsOf(
        `{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":1}"}`,
      ),
    ).toBe(`{"q":1}`);
  });
});

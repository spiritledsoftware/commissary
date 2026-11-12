// Fallback item ids of the Interactions -> Responses stream are unique per response (Go:
// internal/translator/openai/interactions/responses/interactions_openai_responses_response_test.go; upstream b0db5448).
import { describe, expect, it } from "vite-plus/test";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { interactionsToOpenAIResponsesResponse } from "../src/translator/openai/interactions/responses/response-interactions-to-responses.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const events = (chunks: ReadonlyArray<string>): Array<{ event: string; data: Json }> =>
  chunks.flatMap((chunk) => {
    const match = /^event: (.*)\ndata: (.*)\n\n$/s.exec(chunk);
    const data = match === null ? undefined : tryParseJson(match[2] ?? "");

    return match === null || data === undefined ? [] : [{ event: match[1] ?? "", data }];
  });

const cases: ReadonlyArray<{
  name: string;
  step: string;
  delta: string;
  deltaEvent: string;
  /** The client's request, when the item is shaped by its tools (apply_patch). */
  request?: Json | undefined;
}> = [
  {
    name: "reasoning",
    step: `{"type":"thought"}`,
    delta: `{"type":"thought_summary","text":"thinking"}`,
    deltaEvent: "response.reasoning_summary_text.delta",
  },
  {
    name: "message",
    step: `{"type":"model_output"}`,
    delta: `{"type":"text","text":"ready"}`,
    deltaEvent: "response.output_text.delta",
  },
  {
    name: "function",
    step: `{"type":"function_call","name":"exec_command","arguments":{}}`,
    delta: `{"type":"arguments_delta","arguments":"{\\"cmd\\":\\"pwd\\"}"}`,
    deltaEvent: "response.function_call_arguments.delta",
  },
  {
    name: "apply_patch",
    step: `{"type":"function_call","name":"functions__apply_patch"}`,
    delta: `{"type":"arguments_delta","arguments":"{\\"input\\":\\"pq\\"}"}`,
    deltaEvent: "response.custom_tool_call_input.delta",
    request: tryParseJson(
      `{"tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","definition":"start: patch"}}]}]}`,
    ),
  },
];

describe("generated item ids do not collide across responses (b0db5448)", () => {
  it("gives every response its own fallback id, used consistently", () => {
    const seen = new Set<string>();

    for (const testCase of cases) {
      for (let response = 0; response < 2; response++) {
        const context: ResponseContext = {
          model: "devin/gpt-6-1-sol",
          originalRequest: testCase.request,
          translatedRequest: undefined,
          state: makeTranslationState(),
        };

        const chunks = [
          `{"event_type":"interaction.created","interaction":{"id":"interaction_${testCase.name}_${response}"}}`,
          `{"event_type":"step.start","index":0,"step":${testCase.step}}`,
          `{"event_type":"step.delta","index":0,"delta":${testCase.delta}}`,
          `{"event_type":"step.stop","index":0}`,
          `{"event_type":"interaction.completed","interaction":{"status":"completed"}}`,
        ].flatMap((line) => [
          ...(interactionsToOpenAIResponsesResponse.stream?.(context, line) ?? []),
        ]);

        const all = events(chunks);
        const find = (event: string): Json | undefined => all.find((e) => e.event === event)?.data;
        const id = asString(get(find("response.output_item.added"), "item.id"));

        expect(id).not.toBe("");
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        expect(get(find(testCase.deltaEvent), "item_id")).toBe(id);
        expect(get(find("response.output_item.done"), "item.id")).toBe(id);
        expect(get(find("response.completed"), "response.output.0.id")).toBe(id);
      }
    }
  });
});

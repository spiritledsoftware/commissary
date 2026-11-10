// The shared Responses compaction helpers (`executor/helps/compaction.ts`): the summary request built from a client
// payload, capsule expansion, the summary status check and the synthetic response and stream.
import { describe, expect, it } from "vitest";
import { get, type Json, type JsonObject } from "@commissary/json";
import { prepareCompactionSummaryPayload } from "../../src/executor/helps/compaction.ts";

const input = (payload: Json): ReadonlyArray<Json> => {
  const items = get(payload, "input");

  return Array.isArray(items) ? items : [];
};

describe("prepareCompactionSummaryPayload", () => {
  const userMessage: JsonObject = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "fix the bug" }],
  };

  it("removes control items, also with whitespace around the type, and appends the summary prompt last", () => {
    const out = prepareCompactionSummaryPayload({
      model: "m",
      input: [
        { type: "additional_tools", tools: [] },
        { type: " configuration_update ", settings: {} },
        userMessage,
        { type: "compaction_trigger" },
        { type: "\tcompaction_trigger\n" },
      ],
    });

    const items = input(out);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(userMessage);
    expect(get(items[1], "role")).toBe("user");
    expect(get(items[1], "content.0.text")).toContain("concise and comprehensive summary");
  });

  it("removes the fields that do not apply to a one-shot summary and forces stream false", () => {
    const out = prepareCompactionSummaryPayload({
      model: "m",
      type: "response.create",
      event_id: "evt_1",
      text: { format: { type: "json_schema", name: "x", schema: {} } },
      stream: true,
      tools: [{ type: "function", name: "f" }],
      tool_choice: "auto",
      previous_response_id: "resp_1",
      parallel_tool_calls: true,
      additional_tools: [],
      truncation: "auto",
      metadata: { a: "b" },
      instructions: "keep",
      input: [userMessage],
    });

    expect(out).toEqual({
      model: "m",
      instructions: "keep",
      stream: false,
      input: [userMessage, expect.anything()],
    });
  });
});

// Responses -> Interactions request: Devin-sealed reasoning items go back upstream as thought steps
// (CLIProxyAPI b3442f65, `TestConvertOpenAIResponsesRequestKeepsDevinSealedReasoning`).
import { describe, expect, it } from "vitest";
import { get } from "@commissary/json";
import { convertOpenAIResponsesRequestToInteractions } from "../src/translator/openai/interactions/responses/request-responses-to-interactions.ts";

describe("Responses reasoning items to Interactions", () => {
  const request = {
    model: "swe-2",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "picked 12345" }],
        encrypted_content: "sealed.v1.abc",
      },
      { type: "reasoning", summary: [], encrypted_content: "gAAAAother-provider" },
      { type: "function_call", name: "ping", call_id: "c1", arguments: "{}" },
    ],
  };

  it("keeps a sealed reasoning item as a thought step and drops other providers' items", () => {
    const out = convertOpenAIResponsesRequestToInteractions("swe-2", request, false);

    expect(get(out, "input.1.type")).toBe("thought");
    expect(get(out, "input.1.signature")).toBe("sealed.v1.abc");
    expect(get(out, "input.1.content.0.text")).toBe("picked 12345");
    expect(get(out, "input.2.type")).toBe("function_call");
  });

  it("joins the summary parts with a blank line and skips empty ones", () => {
    const out = convertOpenAIResponsesRequestToInteractions(
      "swe-2",
      {
        model: "swe-2",
        input: [
          {
            type: "reasoning",
            summary: [
              { type: "summary_text", text: "first" },
              { type: "summary_text", text: "" },
              { type: "summary_text", text: "second" },
            ],
            encrypted_content: " sealed.v1.xyz ",
          },
        ],
      },
      false,
    );

    expect(get(out, "input.0.content.0.text")).toBe("first\n\nsecond");
    expect(get(out, "input.0.signature")).toBe("sealed.v1.xyz");
  });
});

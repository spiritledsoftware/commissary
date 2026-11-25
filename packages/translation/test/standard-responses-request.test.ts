// Standard Responses conversions of OpenAI and Claude requests, without the Codex wire defaults (Go 7ae771fc:
// internal/translator/codex/openai/chat-completions `ConvertOpenAIRequestToResponses`, internal/translator/codex/claude
// `ConvertClaudeRequestToResponses`).
import { describe, expect, it } from "vite-plus/test";
import {
  convertClaudeRequestToCodex,
  convertClaudeRequestToResponses,
} from "../src/translator/codex/claude/request.ts";
import {
  convertOpenAIRequestToCodex,
  convertOpenAIRequestToResponses,
} from "../src/translator/codex/openai-chat/request.ts";

const TOOL = { name: "lookup", input_schema: { type: "object" }, strict: true };

describe("convertOpenAIRequestToResponses", () => {
  const request = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.2,
    top_p: 0.9,
    parallel_tool_calls: false,
    store: true,
  };

  it("forwards the client's sampling and storage fields and adds no default effort", () => {
    const body = convertOpenAIRequestToResponses("m", request, false);

    expect(body).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      parallel_tool_calls: false,
      store: true,
    });
    expect(body).not.toHaveProperty("reasoning.effort");
    expect(body).not.toHaveProperty("include");
  });

  it("keeps the Codex wire defaults for Codex", () => {
    const body = convertOpenAIRequestToCodex("m", request, false);

    expect(body).toMatchObject({ store: false, reasoning: { effort: "medium" } });
    expect(body).not.toHaveProperty("temperature");
  });
});

describe("convertClaudeRequestToResponses", () => {
  const request = {
    model: "m",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.5,
    top_p: 0.8,
    tools: [TOOL],
  };

  it("forwards sampling, follows the stream flag and sets no Codex defaults", () => {
    const body = convertClaudeRequestToResponses("m", request, false);

    expect(body).toMatchObject({ temperature: 0.5, top_p: 0.8, stream: false });

    for (const field of ["reasoning", "include", "store", "parallel_tool_calls", "tool_choice"])
      expect(body).not.toHaveProperty(field);
    // A client's strict tool stays strict.
    expect(body).toMatchObject({ tools: [{ name: "lookup", strict: true }] });
  });

  it("maps a thinking budget or an output effort to reasoning.effort", () => {
    const thinking = convertClaudeRequestToResponses(
      "m",
      { ...request, thinking: { type: "enabled", budget_tokens: 1024 } },
      true,
    );

    expect(thinking).toHaveProperty("reasoning.effort");

    const effort = convertClaudeRequestToResponses(
      "m",
      { ...request, output_config: { effort: "high" } },
      true,
    );

    expect(effort).toMatchObject({ reasoning: { effort: "high" } });
  });

  it("keeps the Codex wire defaults for Codex", () => {
    const body = convertClaudeRequestToCodex("m", request, false);

    expect(body).toMatchObject({
      stream: true,
      store: false,
      parallel_tool_calls: true,
      reasoning: { effort: "medium" },
      tools: [{ name: "lookup", strict: false }],
    });
    expect(body).not.toHaveProperty("temperature");
  });
});

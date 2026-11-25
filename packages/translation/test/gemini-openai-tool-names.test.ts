// Gemini -> OpenAI Chat Completions: sanitized tool names are restored to the client's names (upstream 5a64cfa1).
// Expected values come from the Go test of that commit (TestConvertGeminiResponseToOpenAI_RestoresSanitizedOpenAIToolNames).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const MODEL = "gemini-4-argon";

const context = (originalRequest: Json, translatedRequest?: Json) => ({
  model: MODEL,
  originalRequest,
  translatedRequest,
  state: makeTranslationState(),
});

const stream = (originalRequest: Json, upstream: Json, translatedRequest?: Json): Json[] =>
  builtinTranslators
    .translateStream(
      "openai",
      "gemini",
      context(originalRequest, translatedRequest),
      JSON.stringify(upstream),
    )
    .map((chunk) => tryParseJson(chunk) ?? null);

const nonStream = (originalRequest: Json, upstream: Json, translatedRequest?: Json): Json =>
  tryParseJson(
    builtinTranslators.translateNonStream(
      "openai",
      "gemini",
      context(originalRequest, translatedRequest),
      JSON.stringify(upstream),
    ) ?? "",
  ) ?? null;

const searchTool = (name: string): Json => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: { q: { type: "string" } } } },
});

const original: Json = {
  model: MODEL,
  messages: [{ role: "user", content: "hi" }],
  tools: [searchTool("mcp/search")],
};

const callFrom = (name: string): Json => ({
  candidates: [
    {
      content: { role: "model", parts: [{ functionCall: { name, args: { q: "test" } } }] },
      finishReason: "STOP",
    },
  ],
});

const streamedName = (chunks: Json[]): Json | undefined =>
  get(chunks[0] ?? null, "choices.0.delta.tool_calls.0.function.name");

describe("sanitized tool names are restored (5a64cfa1)", () => {
  it("streaming", () => {
    expect(streamedName(stream(original, callFrom("mcp_search")))).toBe("mcp/search");
  });

  it("streaming partial arguments", () => {
    const partial = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "mcp_search",
                  willContinue: true,
                  partialArgs: [{ jsonPath: "$.q", stringValue: "test" }],
                },
              },
            ],
          },
        },
      ],
    };

    const chunks = stream(original, partial);

    expect(chunks).toHaveLength(1);
    expect(streamedName(chunks)).toBe("mcp/search");
  });

  it("non-streaming", () => {
    expect(
      get(
        nonStream(original, callFrom("mcp_search")),
        "choices.0.message.tool_calls.0.function.name",
      ),
    ).toBe("mcp/search");
  });

  it("allowed_tools excludes a colliding sibling, round trip", () => {
    const filtered: Json = {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      tools: [searchTool("mcp/search"), searchTool("mcp_search")],
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "auto",
          tools: [{ type: "function", function: { name: "mcp/search" } }],
        },
      },
    };

    const geminiRequest = builtinTranslators.translateRequest("openai", "gemini", {
      format: "openai",
      model: MODEL,
      stream: false,
      body: filtered,
    }).body;

    const declarations = get(geminiRequest, "tools.0.functionDeclarations");

    expect(declarations).toHaveLength(1);
    expect(get(declarations, "0.name")).toBe("mcp_search");

    const upstream = callFrom("mcp_search");

    expect(streamedName(stream(filtered, upstream, geminiRequest))).toBe("mcp/search");
    expect(
      get(
        nonStream(filtered, upstream, geminiRequest),
        "choices.0.message.tool_calls.0.function.name",
      ),
    ).toBe("mcp/search");
  });
});

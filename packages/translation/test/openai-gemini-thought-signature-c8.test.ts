// Gemini thought signatures across OpenAI chat translations (ticket C8; upstream 38706390). Expected values come from the Go
// tests (openai_gemini_request_test.go, openai_gemini_response_test.go).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const MODEL = "google/gemini-3-pro";

describe("Gemini request -> OpenAI chat", () => {
  const convert = (contents: Json[]): Json =>
    builtinTranslators.translateRequest(
      "gemini",
      "openai",
      { format: "gemini", model: MODEL, stream: false, body: { contents } },
      undefined,
    ).body;

  it("maps a functionCall thoughtSignature to extra_content.google.thought_signature", () => {
    const out = convert([
      { role: "user", parts: [{ text: "weather in Paris and London?" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "get_weather", args: { city: "Paris" } },
            thoughtSignature: "SIG_PARIS",
          },
          { functionCall: { name: "get_weather", args: { city: "London" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "get_weather", response: { t: 20 } } },
          { functionResponse: { name: "get_weather", response: { t: 15 } } },
        ],
      },
    ]);

    expect(get(out, "messages.1.tool_calls.0.extra_content.google.thought_signature")).toBe(
      "SIG_PARIS",
    );
    expect(get(out, "messages.1.tool_calls.1.extra_content")).toBeUndefined();
  });

  it.each([
    ["thoughtSignature", { thoughtSignature: "S" }],
    ["thought_signature", { thought_signature: "S" }],
    [
      "functionCall.thoughtSignature",
      { functionCall: { name: "f", args: {}, thoughtSignature: "S" } },
    ],
    [
      "functionCall.thought_signature",
      { functionCall: { name: "f", args: {}, thought_signature: "S" } },
    ],
    ["extra_content", { extra_content: { google: { thought_signature: "S" } } }],
  ])("reads the signature from %s", (_name, extra) => {
    const out = convert([
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { name: "f", args: {} }, ...(extra as object) }] },
    ]);

    expect(get(out, "messages.1.tool_calls.0.extra_content.google.thought_signature")).toBe("S");
  });
});

describe("OpenAI chat response -> Gemini", () => {
  const context = () => ({
    model: MODEL,
    originalRequest: undefined,
    translatedRequest: undefined,
    state: makeTranslationState(),
  });

  it("keeps a tool call signature in a non-stream response", () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                extra_content: { google: { thought_signature: "SIG" } },
              },
              {
                id: "c2",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"London"}' },
              },
            ],
          },
        },
      ],
    });

    const out = tryParseJson(
      builtinTranslators.translateNonStream("gemini", "openai", context(), body) ?? "",
    ) as Json;

    expect(get(out, "candidates.0.content.parts.0.thoughtSignature")).toBe("SIG");
    expect(get(out, "candidates.0.content.parts.1.thoughtSignature")).toBeUndefined();
  });

  const stream = (ctx: ReturnType<typeof context>, line: Json): Json[] =>
    builtinTranslators
      .translateStream("gemini", "openai", ctx, JSON.stringify(line))
      .map((chunk) => tryParseJson(chunk) as Json);

  it("keeps signatures and call order across streamed deltas", () => {
    const ctx = context();

    stream(ctx, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "c2",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":' },
              },
              {
                index: 0,
                id: "c1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":' },
                extra_content: { google: { thought_signature: "SIG" } },
              },
            ],
          },
        },
      ],
    });

    stream(ctx, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: '"London"}' } },
              { index: 0, function: { arguments: '"Paris"}' } },
            ],
          },
        },
      ],
    });

    const out = stream(ctx, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    const last = out.at(-1);

    expect(get(last, "candidates.0.content.parts.0.functionCall.id")).toBe("c1");
    expect(get(last, "candidates.0.content.parts.0.thoughtSignature")).toBe("SIG");
    expect(get(last, "candidates.0.content.parts.1.functionCall.id")).toBe("c2");
    expect(get(last, "candidates.0.content.parts.1.thoughtSignature")).toBeUndefined();
  });

  it("keeps the signature of a single chunk that carries the finish_reason", () => {
    const out = stream(context(), {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "c_single",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Rome"}' },
                extra_content: { google: { thought_signature: "SIG_SINGLE" } },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    expect(out.length).toBeGreaterThan(0);
    expect(get(out.at(-1), "candidates.0.content.parts.0.thoughtSignature")).toBe("SIG_SINGLE");
  });

  it("takes a signature that arrives in a later delta without a function", () => {
    const ctx = context();

    const first = stream(ctx, {
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "checking weather",
            tool_calls: [
              {
                index: 0,
                id: "c_mixed",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Berlin"}' },
              },
            ],
          },
        },
      ],
    });

    expect(first).toHaveLength(1);
    expect(get(first[0], "candidates.0.content.parts.0.thought")).toBe(true);

    stream(ctx, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, extra_content: { google: { thought_signature: "SIG_LATE" } } },
            ],
          },
        },
      ],
    });

    const out = stream(ctx, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });

    expect(out.length).toBeGreaterThan(0);
    expect(get(out.at(-1), "candidates.0.content.parts.0.thoughtSignature")).toBe("SIG_LATE");
  });
});

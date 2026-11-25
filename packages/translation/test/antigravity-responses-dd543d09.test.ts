// Antigravity response translators at CLIProxyAPI dd543d09 (SPI-1420; upstream fe571afe, 4df055de, 28a00389, 8cd6817b,
// 07290e18, 590284bd, da4396fd, f663935d, 7e2b6323, a3e75421, cf07c78a, 85225381). Expected values follow the Go tests of
// those commits.
import { describe, expect, it } from "vite-plus/test";
import {
  asString,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { MemorySignatureCache, withSignatureContext } from "../src/signature/cache.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";
import { claudeSignature } from "./support/claude-signature.ts";

const context = (model: string, originalRequest?: Json) => ({
  model,
  originalRequest,
  translatedRequest: undefined,
  state: makeTranslationState(),
});

const response = (body: Json): string => JSON.stringify({ response: body });

const candidate = (parts: Json[], finishReason?: string): JsonObject => ({
  candidates: [
    {
      content: { role: "model", parts },
      ...(finishReason !== undefined ? { finishReason } : {}),
    },
  ],
});

const openAIStream = (lines: string[]): Json[] => {
  const ctx = context("gemini-3-pro");

  return lines.flatMap((line) =>
    builtinTranslators
      .translateStream("openai", "antigravity", ctx, line)
      .map((chunk) => tryParseJson(chunk) as Json),
  );
};

const toolCallDeltas = (chunks: Json[]): Json[] =>
  chunks.flatMap((chunk) => {
    const calls = get(chunk, "choices.0.delta.tool_calls");

    return isJsonArray(calls) ? calls : [];
  });

const toolArguments = (chunks: Json[], index: number): string =>
  toolCallDeltas(chunks)
    .flatMap((call) =>
      get(call, "index") === index ? [asString(get(call, "function.arguments"))] : [],
    )
    .join("");

describe("Antigravity -> OpenAI chat stream", () => {
  it("announces a continued call once and streams its arguments into one object (fe571afe, 4df055de)", () => {
    const chunks = openAIStream([
      response(
        candidate([{ functionCall: { name: "search", args: { q: "a" }, willContinue: true } }]),
      ),
      response(candidate([{ functionCall: { args: { limit: 3 }, willContinue: false } }])),
      response(candidate([], "STOP")),
      "[DONE]",
    ]);

    const names = toolCallDeltas(chunks).flatMap((call) => {
      const name = get(call, "function.name");

      return name === undefined ? [] : [name];
    });

    expect(names).toEqual(["search"]);
    expect(tryParseJson(toolArguments(chunks, 0))).toEqual({ q: "a", limit: 3 });
  });

  it("sends a call without args as {} (28a00389)", () => {
    const chunks = openAIStream([
      response(candidate([{ functionCall: { name: "ping" } }], "STOP")),
      "[DONE]",
    ]);

    expect(toolArguments(chunks, 0)).toBe("{}");
  });

  it("finishes MAX_TOKENS as length in a terminal chunk with an empty delta (07290e18, 8cd6817b)", () => {
    const chunks = openAIStream([
      response(candidate([{ text: "partial" }])),
      response({ ...candidate([], "MAX_TOKENS"), usageMetadata: { promptTokenCount: 3 } }),
      "[DONE]",
    ]);

    const terminals = chunks.filter((chunk) => get(chunk, "choices.0.finish_reason") != null);
    expect(terminals).toHaveLength(1);
    expect(get(terminals[0], "choices.0.finish_reason")).toBe("length");
    expect(get(terminals[0], "choices.0.delta")).toEqual({});
  });
});

const claudeNonStream = (body: Json): Json =>
  tryParseJson(
    builtinTranslators.translateNonStream(
      "claude",
      "antigravity",
      context("claude-sonnet-4-5", { model: "claude-sonnet-4-5" }),
      JSON.stringify({ response: body }),
    ) ?? "",
  ) as Json;

describe("Antigravity -> Claude non-stream", () => {
  it("bills uncached input tokens and falls back to a generated message id (590284bd, da4396fd)", () => {
    const out = claudeNonStream({
      ...candidate([{ text: "hi" }], "STOP"),
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 5,
        totalTokenCount: 105,
      },
    });

    expect(get(out, "usage.input_tokens")).toBe(60);
    expect(get(out, "usage.cache_read_input_tokens")).toBe(40);
    expect(asString(get(out, "id"))).toMatch(/^msg_[0-9a-f]+_\d+$/);
  });

  it("keeps the upstream response id", () => {
    const out = claudeNonStream({ ...candidate([{ text: "hi" }], "STOP"), responseId: "resp-1" });

    expect(get(out, "id")).toBe("resp-1");
  });
});

describe("Antigravity -> Claude stream", () => {
  const claudeStream = (lines: string[]): string => {
    const ctx = context("claude-sonnet-4-5", { model: "claude-sonnet-4-5" });

    return lines
      .flatMap((line) => builtinTranslators.translateStream("claude", "antigravity", ctx, line))
      .join("");
  };

  const events = (text: string): Json[] =>
    text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => tryParseJson(line.slice(6)) as Json);

  it("does not end the message on an empty finishReason (7e2b6323)", () => {
    const out = events(
      claudeStream([
        response(candidate([{ text: "a" }], "")),
        response(candidate([{ text: "b" }], "STOP")),
        "[DONE]",
      ]),
    );

    const stops = out.filter((event) => get(event, "type") === "message_delta");
    expect(stops).toHaveLength(1);
    expect(
      out
        .filter((event) => get(event, "delta.type") === "text_delta")
        .map((event) => get(event, "delta.text")),
    ).toEqual(["a", "b"]);
  });

  it("skips an empty function call (f663935d)", () => {
    const out = events(
      claudeStream([response(candidate([{ functionCall: { name: "" } }, { text: "ok" }], "STOP"))]),
    );

    expect(out.some((event) => get(event, "content_block.type") === "tool_use")).toBe(false);
  });
});

describe("Antigravity -> Gemini alt array stream", () => {
  it("restores each item of an alt array (a3e75421)", () => {
    const original: Json = {
      tools: [{ functionDeclarations: [{ name: "do thing", parameters: { type: "object" } }] }],
    };

    const line = JSON.stringify([
      {
        response: {
          ...candidate([{ functionCall: { name: "do_thing", args: {} } }], "STOP"),
          cpaUsageMetadata: { promptTokenCount: 1 },
        },
      },
    ]);

    const [chunk] = builtinTranslators.translateStream(
      "gemini",
      "antigravity",
      { ...context("gemini-3-pro", original), alt: "json" },
      line,
    );

    const out = tryParseJson(chunk ?? "");

    expect(get(out, "0.candidates.0.content.parts.0.functionCall.name")).toBe("do thing");
    expect(get(out, "0.usageMetadata.promptTokenCount")).toBe(1);
  });
});

describe("Antigravity -> Claude malformed function calls (cf07c78a)", () => {
  const MODEL = "claude-sonnet-4-5";

  const claudeContext = () => ({
    model: MODEL,
    originalRequest: { model: MODEL },
    translatedRequest: { model: MODEL },
    state: makeTranslationState(),
  });

  const sseEvents = (text: string): string[] =>
    text
      .split("\n")
      .filter((line) => line.startsWith("event: "))
      .map((line) => line.slice(7));

  const streamOf = (lines: string[]): string => {
    const ctx = claudeContext();

    return lines
      .flatMap((line) => builtinTranslators.translateStream("claude", "antigravity", ctx, line))
      .join("");
  };

  const usage = { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 };

  it("ends a stream without visible output with an api_error and nothing after it", () => {
    const out = streamOf([
      response({ ...candidate([{ text: "thinking", thought: true }]) }),
      response({ ...candidate([], " malformed_function_call "), usageMetadata: usage }),
      "[DONE]",
    ]);

    const names = sseEvents(out);
    expect(names).toContain("error");
    expect(names).not.toContain("message_delta");
    expect(names).not.toContain("message_stop");
    expect(names.at(-1)).toBe("error");
    expect(out).toContain('"type":"api_error"');
  });

  it("raises the error on [DONE] when the finish frame had no usage", () => {
    const out = streamOf([response(candidate([], "MALFORMED_FUNCTION_CALL")), "[DONE]"]);

    expect(sseEvents(out).at(-1)).toBe("error");
  });

  it("keeps partial text and ends the stream as a refusal", () => {
    const out = streamOf([
      response(candidate([{ text: "partial" }])),
      response({ ...candidate([], "MALFORMED_FUNCTION_CALL"), usageMetadata: usage }),
      "[DONE]",
    ]);

    expect(sseEvents(out)).not.toContain("error");
    expect(out).toContain('"stop_reason":"refusal"');
  });

  const nonStreamOf = (body: Json): Json =>
    tryParseJson(
      builtinTranslators.translateNonStream(
        "claude",
        "antigravity",
        claudeContext(),
        JSON.stringify({ response: body }),
      ) ?? "",
    ) as Json;

  it("turns a non-stream reply without visible output into the error body", () => {
    const out = nonStreamOf(
      candidate([{ text: "  " }, { functionCall: { name: "" } }], "MALFORMED_FUNCTION_CALL"),
    );

    expect(out).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Gemini response finished with MALFORMED_FUNCTION_CALL",
      },
    });
  });

  it("keeps a non-stream reply with text as a refusal", () => {
    const out = nonStreamOf(candidate([{ text: "partial" }], "MALFORMED_FUNCTION_CALL"));

    expect(get(out, "stop_reason")).toBe("refusal");
    expect(get(out, "content.0.text")).toBe("partial");
  });
});

describe("Antigravity -> Claude non-stream signature cache (85225381)", () => {
  it("recovers a non-stream reply's signature on the next turn", () => {
    const MODEL = "claude-sonnet-4-5";
    const thought = "Let me think about the weather in Paris before I answer the question.";
    const signature = claudeSignature();
    const cache = new MemorySignatureCache();

    withSignatureContext({ cache }, () =>
      builtinTranslators.translateNonStream(
        "claude",
        "antigravity",
        {
          model: MODEL,
          originalRequest: { model: MODEL },
          translatedRequest: { model: MODEL },
          state: makeTranslationState(),
        },
        JSON.stringify({
          response: candidate(
            [
              { text: thought, thought: true },
              { text: "", thoughtSignature: signature },
              { text: "Sunny." },
            ],
            "STOP",
          ),
        }),
      ),
    );

    const next = withSignatureContext({ cache }, () =>
      builtinTranslators.translateRequest(
        "claude",
        "antigravity",
        {
          format: "claude",
          model: MODEL,
          stream: false,
          body: {
            thinking: { type: "enabled", budget_tokens: 2048 },
            messages: [
              { role: "user", content: "weather?" },
              {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: thought },
                  { type: "text", text: "Sunny." },
                ],
              },
              { role: "user", content: "thanks" },
            ],
          },
        },
        undefined,
      ),
    ).body;

    expect(get(next, "request.contents.1.parts.0.thought")).toBe(true);
    // Antigravity carries Claude signatures in their R form (base64 of the E form).
    expect(atob(asString(get(next, "request.contents.1.parts.0.thoughtSignature")))).toBe(
      signature,
    );
  });
});

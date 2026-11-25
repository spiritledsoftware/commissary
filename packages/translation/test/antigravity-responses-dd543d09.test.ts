// Antigravity response translators at CLIProxyAPI dd543d09 (SPI-1420; upstream fe571afe, 4df055de, 28a00389, 8cd6817b,
// 07290e18, 590284bd, da4396fd, f663935d, 7e2b6323, a3e75421). Expected values follow the Go tests of those commits.
import { describe, expect, it } from "vite-plus/test";
import {
  asString,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

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

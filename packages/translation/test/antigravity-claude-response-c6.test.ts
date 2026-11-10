// Antigravity -> Claude Messages responses (ticket C6; upstream 202b8b8c, e1fb2521, 912a038b, 24b04548).
// Expected values come from the Go tests of those commits (antigravity_claude_response_test.go).
import { describe, expect, it } from "vitest";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const context = (model: string, originalRequest: Json, translatedRequest: Json) => ({
  model,
  originalRequest,
  translatedRequest,
  state: makeTranslationState(),
});

const dataOf = (text: string): Json[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => tryParseJson(line.slice(6)) as Json);

const eventData = (text: string, type: string): Json | undefined =>
  dataOf(text).find((data) => get(data, "type") === type);

const stream = (model: string, original: Json, translated: Json, lines: Json[]): string => {
  const ctx = context(model, original, translated);

  return lines
    .flatMap((line) =>
      builtinTranslators.translateStream(
        "claude",
        "antigravity",
        ctx,
        typeof line === "string" ? line : JSON.stringify(line),
      ),
    )
    .join("");
};

const nonStream = (model: string, original: Json, translated: Json, body: Json): Json =>
  tryParseJson(
    builtinTranslators.translateNonStream(
      "claude",
      "antigravity",
      context(model, original, translated),
      JSON.stringify(body),
    ) ?? "",
  ) as Json;

const inputDeltas = (text: string): string =>
  dataOf(text)
    .filter((data) => get(data, "delta.type") === "input_json_delta")
    .map((data) => asString(get(data, "delta.partial_json")))
    .join("");

const response = (body: Json): Json => ({ response: body });

describe("tool arguments against the declared schemas (202b8b8c, e1fb2521)", () => {
  const original: Json = {
    model: "claude-sonnet-4-6",
    tools: [{ name: "EnterPlanMode", input_schema: { type: "object", properties: {} } }],
  };

  const translated: Json = { model: "gemini-3.8-flash-high" };

  const call = (args: Json, name?: string): Json =>
    response({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { ...(name === undefined ? {} : { name }), args } }],
          },
          finishReason: "STOP",
        },
      ],
      modelVersion: "gemini-3.8-flash-high",
      responseId: "resp-1",
    });

  it("strips the placeholder from a parameterless tool, streamed and not", () => {
    const body = call({ reason: "Switching to plan mode to inspect files" }, "EnterPlanMode");

    expect(
      get(nonStream("claude-sonnet-4-6", original, translated, body), "content.0.input"),
    ).toEqual({});

    expect(inputDeltas(stream("claude-sonnet-4-6", original, translated, [body]))).toBe("{}");
  });

  it("strips an executor-injected `_` using the sent schema", () => {
    const strict: Json = {
      model: "claude-sonnet-4-6",
      tools: [
        {
          name: "WrappedPlaceholder",
          input_schema: {
            type: "object",
            properties: { flag: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    };

    const sent = builtinTranslators.translateRequest(
      "claude",
      "antigravity",
      {
        format: "claude",
        model: "claude-sonnet-4-6",
        stream: false,
        body: structuredClone(strict),
      },
      undefined,
    ).body;

    const out = nonStream(
      "claude-sonnet-4-6",
      strict,
      sent,
      call({ flag: "x", _: true }, "WrappedPlaceholder"),
    );

    expect(get(out, "content.0.input")).toEqual({ flag: "x" });
  });

  it("does not duplicate the empty object when a parameterless call continues", () => {
    const text = stream("claude-sonnet-4-6", original, translated, [
      response({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "EnterPlanMode",
                    args: { reason: "Switching to plan mode" },
                  },
                },
              ],
            },
          },
        ],
        modelVersion: "gemini-3.8-flash-high",
        responseId: "resp-1",
      }),
      call({ reason: "more" }),
    ]);

    const starts = dataOf(text).filter(
      (data) =>
        get(data, "type") === "content_block_start" &&
        get(data, "content_block.type") === "tool_use",
    );

    expect(starts).toHaveLength(1);
    expect(inputDeltas(text)).toBe("{}");
    expect(text).not.toContain('"name":""');
  });

  it("keeps real arguments around an empty or placeholder part of an implicitly open schema", () => {
    const echo: Json = {
      model: "claude-sonnet-4-6",
      tools: [{ name: "echo", input_schema: { type: "object", properties: {} } }],
    };

    const first = response({
      candidates: [{ content: { parts: [{ functionCall: { name: "echo", args: {} } }] } }],
    });

    const second = response({
      candidates: [
        { content: { parts: [{ functionCall: { args: { user: "v" } } }] }, finishReason: "STOP" },
      ],
    });

    expect(inputDeltas(stream("claude-sonnet-4-6", echo, translated, [first, second]))).toBe(
      '{"user":"v"}',
    );
  });
});

describe("refusal finish reasons (24b04548)", () => {
  const request: Json = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] };

  it.each([
    ["SAFETY", "refusal"],
    ["RECITATION", "refusal"],
    ["PROHIBITED_CONTENT", "refusal"],
    ["SPII", "refusal"],
    ["BLOCKLIST", "refusal"],
    ["IMAGE_SAFETY", "refusal"],
    ["MALFORMED_RESPONSE", "refusal"],
    ["MALFORMED_FUNCTION_CALL", "refusal"],
    ["MAX_TOKENS", "max_tokens"],
    ["STOP", "end_turn"],
  ])("non-stream %s ends %s", (finishReason, stopReason) => {
    const out = nonStream(
      "claude-opus-5-5-high",
      request,
      request,
      response({
        candidates: [{ content: { role: "model", parts: [] }, finishReason }],
        usageMetadata: { promptTokenCount: 8149, totalTokenCount: 8149 },
        modelVersion: "claude-opus-5-5-high",
        responseId: "req_vrtx_test",
      }),
    );

    expect(get(out, "stop_reason")).toBe(stopReason);
  });

  it("lets a tool call win over SAFETY", () => {
    const tools: Json = {
      model: "claude-opus-5-5",
      tools: [
        { name: "echo", input_schema: { type: "object", properties: { x: { type: "string" } } } },
      ],
    };

    const out = nonStream(
      "claude-opus-5-5-high",
      tools,
      tools,
      response({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "echo", args: { x: "1" } } }],
            },
            finishReason: "SAFETY",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }),
    );

    expect(get(out, "stop_reason")).toBe("tool_use");
  });

  it("closes an empty SAFETY stream with a refusal and its usage", () => {
    const text = stream(
      "claude-opus-5-5-high",
      { model: "claude-opus-5-5" },
      { model: "claude-opus-5-5-high" },
      [
        response({
          candidates: [{ content: { role: "model", parts: [{ text: "" }] } }],
          modelVersion: "claude-opus-5-5-high",
          responseId: "req_vrtx",
          cpaUsageMetadata: { promptTokenCount: 8149, totalTokenCount: 8149 },
        }),
        response({
          candidates: [
            { content: { role: "model", parts: [{ text: "" }] }, finishReason: "SAFETY" },
          ],
          usageMetadata: { promptTokenCount: 8149, totalTokenCount: 8149 },
          modelVersion: "claude-opus-5-5-high",
          responseId: "req_vrtx",
        }),
        "[DONE]",
      ],
    );

    let last = -1;

    for (const name of [
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]) {
      const index = text.indexOf(`event: ${name}\n`);
      expect(index).toBeGreaterThan(last);
      last = index;
    }

    const delta = eventData(text, "message_delta");
    expect(get(delta, "delta.stop_reason")).toBe("refusal");
    expect(get(delta, "usage.input_tokens")).toBe(8149);
    expect(get(delta, "usage.output_tokens")).toBe(0);
  });

  it.each([
    "SAFETY",
    "RECITATION",
    "PROHIBITED_CONTENT",
    "SPII",
    "BLOCKLIST",
    "IMAGE_SAFETY",
    "MALFORMED_RESPONSE",
    "MALFORMED_FUNCTION_CALL",
  ])("%s survives a trailing chunk with an empty finishReason", (reason) => {
    for (const textPart of ["partial", ""]) {
      const text = stream(
        "claude-opus-5-5-high",
        { model: "claude-opus-5-5" },
        { model: "claude-opus-5-5" },
        [
          response({
            candidates: [
              { content: { role: "model", parts: [{ text: textPart }] }, finishReason: reason },
            ],
            modelVersion: "claude-opus-5-5-high",
            responseId: "req_vrtx_split",
          }),
          response({
            candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "" }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 },
            modelVersion: "claude-opus-5-5-high",
            responseId: "req_vrtx_split",
          }),
          "[DONE]",
        ],
      );

      expect(get(eventData(text, "message_delta"), "delta.stop_reason")).toBe("refusal");
    }
  });

  describe("web search", () => {
    const original: Json = {
      model: "gemini-3.1-flash-lite",
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    };

    const translated: Json = {
      model: "gemini-3.1-flash-lite",
      request: { tools: [{ googleSearch: {} }] },
    };

    it("drains buffered text on an empty finishReason", () => {
      const text = stream("gemini-3.1-flash-lite", original, translated, [
        response({
          modelVersion: "gemini-3.1-flash-lite",
          responseId: "resp-web-search-empty-finish",
          candidates: [
            {
              content: { parts: [{ text: "Direct answer without grounding." }] },
              finishReason: "",
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
        }),
        "[DONE]",
      ]);

      expect(text).toContain("Direct answer without grounding.");
      expect(get(eventData(text, "message_delta"), "delta.stop_reason")).toBe("end_turn");
    });

    it.each([
      ["SAFETY", "refusal"],
      ["MAX_TOKENS", "max_tokens"],
      ["STOP", "end_turn"],
    ])("non-stream grounding with %s ends %s", (finishReason, stopReason) => {
      const out = nonStream(
        "gemini-3.1-flash-lite",
        original,
        translated,
        response({
          modelVersion: "gemini-3.1-flash-lite",
          responseId: "resp-web-search-grounding-finish",
          candidates: [
            {
              content: { parts: [{ text: "Partial grounded text." }] },
              groundingMetadata: {
                webSearchQueries: ["query"],
                groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
              },
              finishReason,
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
        }),
      );

      expect(get(out, "stop_reason")).toBe(stopReason);
    });
  });
});

describe("cached tokens in the usage fallback (912a038b)", () => {
  it("does not count cached tokens as output when candidates are zero", () => {
    const request: Json = { model: "gemini-3.8-flash-high" };

    const text = stream("gemini-3.8-flash-high", request, request, [
      response({
        candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 142871,
          cachedContentTokenCount: 140830,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          totalTokenCount: 142871,
        },
        modelVersion: "gemini-3.8-flash-n",
        responseId: "resp_cached_zero_candidates",
      }),
      "[DONE]",
    ]);

    const delta = eventData(text, "message_delta");
    expect(get(delta, "usage.input_tokens")).toBe(2041);
    expect(get(delta, "usage.output_tokens")).toBe(0);
    expect(get(delta, "usage.cache_read_input_tokens")).toBe(140830);
  });

  it("clamps the prompt tokens at zero", () => {
    const request: Json = { model: "gemini-3.8-flash-high" };

    const text = stream("gemini-3.8-flash-high", request, request, [
      response({
        candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 10,
          cachedContentTokenCount: 25,
          candidatesTokenCount: 2,
          totalTokenCount: 12,
        },
      }),
      "[DONE]",
    ]);

    expect(get(eventData(text, "message_delta"), "usage.input_tokens")).toBe(0);
  });
});

// Gemini / Antigravity -> OpenAI Chat Completions responses (ticket C6; upstream 3f5d3a16, c5251b57, da21f1e5,
// 80aa2b1d, dfe0a0ef). Expected values come from the Go tests of those commits.
import { describe, expect, it } from "vitest";
import { get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const context = (model: string) => ({
  model,
  originalRequest: undefined,
  translatedRequest: undefined,
  state: makeTranslationState(),
});

/** Translates `lines` through one stream and parses every chunk. */
const stream = (provider: "gemini" | "antigravity", lines: string[]): Json[] => {
  const ctx = context("gemini-3-flash");

  return lines.flatMap((line) =>
    builtinTranslators
      .translateStream("openai", provider, ctx, line)
      .map((chunk) => tryParseJson(chunk) as Json),
  );
};

const nonStream = (provider: "gemini" | "antigravity", body: string): Json =>
  tryParseJson(
    builtinTranslators.translateNonStream("openai", provider, context("gemini-3-flash"), body) ??
      "",
  ) as Json;

const finishing = (chunks: Json[]): Json[] =>
  chunks.filter((chunk) => get(chunk, "choices.0.finish_reason") != null);

const FILTERED: ReadonlyArray<readonly [string, string]> = [
  ["MALFORMED_RESPONSE", "malformed_response"],
  ["MALFORMED_FUNCTION_CALL", "malformed_function_call"],
  ["SAFETY", "safety"],
  ["RECITATION", "recitation"],
  ["PROHIBITED_CONTENT", "prohibited_content"],
];

describe("Gemini chat: non-content finish reasons (3f5d3a16)", () => {
  it.each(FILTERED)(
    "%s maps to content_filter in a stream and a non-stream body",
    (upstream, native) => {
      const usage = { promptTokenCount: 481701, candidatesTokenCount: 16, totalTokenCount: 482881 };

      const chunks = stream("gemini", [
        JSON.stringify({
          candidates: [{ content: { role: "model" }, finishReason: upstream }],
          usageMetadata: { ...usage, cachedContentTokenCount: 479652, thoughtsTokenCount: 1164 },
          modelVersion: "gemini-4-argon",
          responseId: "r",
        }),
      ]);

      expect(chunks).toHaveLength(1);
      expect(get(chunks[0], "choices.0.finish_reason")).toBe("content_filter");
      expect(get(chunks[0], "choices.0.native_finish_reason")).toBe(native);

      const body = nonStream(
        "gemini",
        JSON.stringify({
          candidates: [{ content: { role: "model" }, finishReason: upstream }],
          usageMetadata: usage,
        }),
      );

      expect(get(body, "choices.0.finish_reason")).toBe("content_filter");
      expect(get(body, "choices.0.native_finish_reason")).toBe(native);
    },
  );

  it("emits one terminal chunk when usage arrives in a later usage-only chunk", () => {
    const chunks = stream("gemini", [
      JSON.stringify({
        candidates: [{ content: { role: "model" }, finishReason: "MALFORMED_RESPONSE" }],
        modelVersion: "gemini-4-argon",
        responseId: "resp-split-1",
      }),
      JSON.stringify({
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
        modelVersion: "gemini-4-argon",
        responseId: "resp-split-1",
      }),
      "[DONE]",
    ]);

    const terminals = finishing(chunks);
    expect(terminals).toHaveLength(1);
    expect(get(terminals[0], "choices.0.finish_reason")).toBe("content_filter");
    expect(get(terminals[0], "choices.0.native_finish_reason")).toBe("malformed_response");
    expect(get(terminals[0], "usage.prompt_tokens")).toBe(100);
  });

  it("finalizes on [DONE] with the pending cpaUsageMetadata, once", () => {
    const ctx = context("gemini-4-argon");

    const first = builtinTranslators.translateStream(
      "openai",
      "gemini",
      ctx,
      JSON.stringify({
        candidates: [{ content: { role: "model" }, finishReason: "MALFORMED_RESPONSE" }],
        cpaUsageMetadata: { promptTokenCount: 200, candidatesTokenCount: 8, totalTokenCount: 208 },
        modelVersion: "gemini-4-argon",
        responseId: "resp-done-1",
      }),
    );

    const done = builtinTranslators.translateStream("openai", "gemini", ctx, "[DONE]");

    const terminals = finishing([...first, ...done].map((chunk) => tryParseJson(chunk) as Json));
    expect(terminals).toHaveLength(1);
    expect(get(terminals[0], "choices.0.finish_reason")).toBe("content_filter");
    expect(get(terminals[0], "choices.0.native_finish_reason")).toBe("malformed_response");
    expect(get(terminals[0], "usage.prompt_tokens")).toBe(200);
    expect(builtinTranslators.translateStream("openai", "gemini", ctx, "[DONE]")).toEqual([]);
  });

  it("finalizes on [DONE] when no usage ever arrives", () => {
    const ctx = context("gemini-4-argon");

    builtinTranslators.translateStream(
      "openai",
      "gemini",
      ctx,
      JSON.stringify({
        candidates: [{ content: { role: "model" }, finishReason: "SAFETY" }],
        modelVersion: "gemini-4-argon",
        responseId: "resp-nousage-1",
      }),
    );

    const done = builtinTranslators.translateStream("openai", "gemini", ctx, "[DONE]");
    expect(done).toHaveLength(1);
    const chunk = tryParseJson(done[0] ?? "") as Json;
    expect(get(chunk, "choices.0.finish_reason")).toBe("content_filter");
    expect(get(chunk, "choices.0.native_finish_reason")).toBe("safety");
    expect(get(chunk, "id")).toBe("resp-nousage-1");
    expect(get(chunk, "model")).toBe("gemini-4-argon");
  });
});

describe("Antigravity chat: non-content finish reasons (3f5d3a16)", () => {
  it("maps SAFETY to content_filter on the final chunk", () => {
    const chunks = stream("antigravity", [
      JSON.stringify({
        response: {
          candidates: [{ content: { role: "model" }, finishReason: "SAFETY" }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
        },
      }),
    ]);

    expect(get(chunks[0], "choices.0.finish_reason")).toBe("content_filter");
    expect(get(chunks[0], "choices.0.native_finish_reason")).toBe("safety");
  });
});

describe("multi-part chunks (c5251b57)", () => {
  const parts = (value: Json[]) => JSON.stringify({ candidates: [{ content: { parts: value } }] });

  const wrapped = (value: Json[]) =>
    JSON.stringify({ response: { candidates: [{ content: { parts: value } }] } });

  const cases: ReadonlyArray<readonly [string, Json[], Json, Json]> = [
    [
      "thought then an empty thought signature part",
      [
        { thought: true, text: "Analyzing the request..." },
        { thought: true, text: "", thoughtSignature: "EjQK..." },
      ],
      "Analyzing the request...",
      null,
    ],
    [
      "thought then an empty non-thought signature part",
      [
        { thought: true, text: "Analyzing the request..." },
        { text: "", thoughtSignature: "EjQK..." },
      ],
      "Analyzing the request...",
      null,
    ],
    [
      "visible text then an empty signature part",
      [{ text: "Final answer" }, { text: "", thoughtSignature: "EjQK..." }],
      null,
      "Final answer",
    ],
    [
      "several thought and text parts",
      [
        { thought: true, text: "Step 1. " },
        { thought: true, text: "Step 2." },
        { text: "Hello " },
        { text: "world" },
      ],
      "Step 1. Step 2.",
      "Hello world",
    ],
  ];

  for (const provider of ["gemini", "antigravity"] as const) {
    it.each(cases)(`${provider}: %s`, (_name, value, reasoning, content) => {
      const [chunk] = stream(provider, [(provider === "gemini" ? parts : wrapped)(value)]);
      expect(get(chunk, "choices.0.delta.reasoning_content")).toBe(reasoning);
      expect(get(chunk, "choices.0.delta.content")).toBe(content);
      expect(get(chunk, "choices.0.delta.role")).toBe("assistant");
    });
  }

  it("gemini non-stream: a signature carrier with empty text adds no content", () => {
    const body = nonStream(
      "gemini",
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "Thinking..." },
                { text: "", thoughtSignature: "EjQK..." },
                { functionCall: { name: "get_time", args: { tz: "UTC" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );

    expect(get(body, "choices.0.message.reasoning_content")).toBe("Thinking...");
    expect(get(body, "choices.0.message.content")).toBeNull();
  });
});

describe("tool call indices and ids across chunks (da21f1e5, 80aa2b1d)", () => {
  const call = (name: string, args: Json, id?: string): Json => ({
    functionCall: { ...(id === undefined ? {} : { id }), name, args },
  });

  const toolCalls = (chunks: Json[]): Json[] =>
    chunks.flatMap((chunk) => {
      const calls = get(chunk, "choices.0.delta.tool_calls");

      return isJsonArray(calls) ? calls : [];
    });

  it("gemini: indexes calls stream-wide and keeps upstream ids", () => {
    const chunks = stream("gemini", [
      JSON.stringify({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [call("get_time", { tz: "UTC" }, "call_utc")] },
          },
        ],
        responseId: "resp-parallel-1",
      }),
      JSON.stringify({
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [
                call("get_time", { tz: "America/Santiago" }, "call_scl"),
                call("get_time", { tz: "Asia/Tokyo" }, "call_tyo"),
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        responseId: "resp-parallel-1",
      }),
    ]);

    const calls = toolCalls(chunks);
    expect(calls.map((c) => get(c, "index"))).toEqual([0, 1, 2]);
    expect(calls.map((c) => get(c, "id"))).toEqual(["call_utc", "call_scl", "call_tyo"]);
  });

  it("gemini non-stream: keeps an upstream id and generates one otherwise", () => {
    const body = nonStream(
      "gemini",
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [call("a", {}, "call_a"), call("b", {})],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );

    expect(get(body, "choices.0.message.tool_calls.0.id")).toBe("call_a");
    expect(get(body, "choices.0.message.tool_calls.1.id")).toMatch(/^b-\d+-\d+$/);
  });

  it("antigravity: indexes calls stream-wide and keeps upstream ids", () => {
    const wrap = (parts: Json[]) =>
      JSON.stringify({ response: { candidates: [{ content: { parts } }] } });

    const chunks = stream("antigravity", [
      wrap([call("a", { x: 1 }, "call_a")]),
      wrap([call("b", { x: 2 }, "call_b"), call("c", { x: 3 })]),
    ]);

    const calls = toolCalls(chunks);
    expect(calls.map((c) => get(c, "index"))).toEqual([0, 1, 2]);
    expect(calls.slice(0, 2).map((c) => get(c, "id"))).toEqual(["call_a", "call_b"]);
    expect(get(calls[2], "id")).toMatch(/^c-\d+-\d+$/);
  });
});

describe("antigravity streaming delta template (dfe0a0ef)", () => {
  const wrap = (response: Json): string => JSON.stringify({ response });

  it("omits tool_calls unless the chunk carries calls", () => {
    const ctx = context("gemini-3.5-flash-lite");

    const run = (response: Json): Json =>
      tryParseJson(
        builtinTranslators.translateStream("openai", "antigravity", ctx, wrap(response))[0] ?? "",
      ) as Json;

    const text = run({ candidates: [{ content: { parts: [{ text: "Hello world" }] } }] });

    expect(get(text, "choices.0.delta")).not.toHaveProperty("tool_calls");

    const thought = run({
      candidates: [{ content: { parts: [{ text: "thinking...", thought: true }] } }],
    });

    expect(get(thought, "choices.0.delta")).not.toHaveProperty("tool_calls");

    const tool = run({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "get_weather", args: { city: "Beijing" } } }],
          },
        },
      ],
    });

    expect(get(tool, "choices.0.delta.tool_calls.0.function.name")).toBe("get_weather");

    const final = run({
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    });

    expect(get(final, "choices.0.delta")).not.toHaveProperty("tool_calls");
  });

  it("omits tool_calls from the chunk synthesised on [DONE]", () => {
    const ctx = context("gemini-3.5-flash-lite");

    builtinTranslators.translateStream(
      "openai",
      "antigravity",
      ctx,
      wrap({ candidates: [{ content: { parts: [{ text: "Hello world" }] } }] }),
    );

    const [done] = builtinTranslators.translateStream("openai", "antigravity", ctx, "[DONE]");
    expect(get(tryParseJson(done ?? "") as Json, "choices.0.delta")).not.toHaveProperty(
      "tool_calls",
    );
  });
});

describe("Gemini Responses: non-content finish reasons end incomplete (3f5d3a16)", () => {
  const request: Json = { model: "gemini-4-argon" };

  const responsesContext = () => ({
    model: "gemini-4-argon",
    originalRequest: request,
    translatedRequest: undefined,
    state: makeTranslationState(),
  });

  const body = (reason: string): string =>
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: reason }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 },
      modelVersion: "gemini-4-argon",
      responseId: "resp_1",
    });

  it.each(FILTERED.map(([reason]) => reason))("%s", (reason) => {
    const events = builtinTranslators
      .translateStream("openai-response", "gemini", responsesContext(), `data: ${body(reason)}`)
      .flatMap((chunk) => {
        const [event, data] = chunk.split("\n");

        return [[event, tryParseJson((data ?? "").replace(/^data: /, ""))] as const];
      });

    const names = events.map(([event]) => event);
    expect(names).toContain("event: response.incomplete");
    expect(names).not.toContain("event: response.completed");
    const incomplete = events.find(([event]) => event === "event: response.incomplete")?.[1];
    expect(get(incomplete as Json, "response.status")).toBe("incomplete");
    expect(get(incomplete as Json, "response.incomplete_details.reason")).toBe("content_filter");

    const out = tryParseJson(
      builtinTranslators.translateNonStream(
        "openai-response",
        "gemini",
        responsesContext(),
        body(reason),
      ) ?? "",
    ) as Json;

    expect(get(out, "status")).toBe("incomplete");
    expect(get(out, "incomplete_details.reason")).toBe("content_filter");
  });
});

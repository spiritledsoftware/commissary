// Gemini -> Claude Messages responses (ticket C6; upstream 202b8b8c, e1fb2521, 58257007, 7f2f17d7, 3f5d3a16).
// Expected values come from the Go tests of those commits (gemini_claude_response_test.go).
import { describe, expect, it } from "vitest";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const MODEL = "gemini-3-flash";

const context = (originalRequest: Json, translatedRequest: Json = originalRequest) => ({
  model: MODEL,
  originalRequest,
  translatedRequest,
  state: makeTranslationState(),
});

/** The `data:` payloads of a translated Claude stream. */
const dataOf = (text: string): Json[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => tryParseJson(line.slice(6)) as Json);

const streamText = (request: Json, chunks: Json[], translated: Json = request): string => {
  const ctx = context(request, translated);

  return chunks
    .flatMap((chunk) =>
      builtinTranslators.translateStream("claude", "gemini", ctx, JSON.stringify(chunk)),
    )
    .join("");
};

const streamWithDone = (request: Json, chunks: Json[]): string => {
  const ctx = context(request);

  return [...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
    .flatMap((line) => builtinTranslators.translateStream("claude", "gemini", ctx, line))
    .join("");
};

const inputDeltas = (text: string): string =>
  dataOf(text)
    .filter((data) => get(data, "delta.type") === "input_json_delta")
    .map((data) => asString(get(data, "delta.partial_json")))
    .join("");

const nonStream = (request: Json, body: Json, translated: Json = request): Json =>
  tryParseJson(
    builtinTranslators.translateNonStream(
      "claude",
      "gemini",
      context(request, translated),
      JSON.stringify(body),
    ) ?? "",
  ) as Json;

const call = (name: string | undefined, args: Json): Json => ({
  functionCall: { ...(name === undefined ? {} : { name }), args },
});

const candidate = (parts: Json[], finishReason?: string): Json => ({
  candidates: [
    {
      content: { parts, role: "model" },
      ...(finishReason === undefined ? {} : { finishReason }),
    },
  ],
  modelVersion: MODEL,
  responseId: "resp",
});

const request = (tools: Json[]): Json => ({ model: MODEL, tools });

describe("tool arguments against the declared schemas (202b8b8c)", () => {
  const planMode = request([
    { name: "EnterPlanMode", input_schema: { type: "object", properties: {} } },
  ]);

  it("strips the placeholder from a parameterless tool, streamed and not", () => {
    const body = candidate([call("EnterPlanMode", { reason: "Plan mode switch" })], "STOP");

    expect(get(nonStream(planMode, body), "content.0.input")).toEqual({});
    expect(inputDeltas(streamText(planMode, [body]))).toBe("{}");
  });

  it("keeps an exact-name tool's arguments when canonical names collide", () => {
    const tools = request([
      { name: "Read", input_schema: { type: "object", properties: {} } },
      { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ]);

    const withArgs = candidate([call("read", { path: "/tmp/a" })], "STOP");
    const out = nonStream(tools, withArgs);
    expect(get(out, "content.0.input")).toEqual({ path: "/tmp/a" });
    expect(get(out, "content.0.name")).toBe("read");
    expect(inputDeltas(streamText(tools, [withArgs]))).toBe('{"path":"/tmp/a"}');

    const parameterless = candidate([call("Read", { reason: "x" })], "STOP");
    expect(get(nonStream(tools, parameterless), "content.0.input")).toEqual({});
  });

  it("keeps the upstream name and arguments when the canonical name is ambiguous", () => {
    const tools = request([
      { name: "Read", input_schema: { type: "object", properties: {} } },
      { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ]);

    const out = nonStream(tools, candidate([call("READ", { path: "/tmp/a" })], "STOP"));
    expect(get(out, "content.0.name")).toBe("READ");
    expect(get(out, "content.0.input")).toEqual({ path: "/tmp/a" });
  });

  it("keeps `reason` when the sent schema carries no placeholder", () => {
    const original = request([
      {
        name: "Bash",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ]);

    const translated = builtinTranslators.translateRequest(
      "claude",
      "gemini",
      { format: "claude", model: MODEL, stream: false, body: structuredClone(original) },
      undefined,
    ).body;

    const out = nonStream(
      original,
      candidate([call("Bash", { command: "ls", reason: "why" })], "STOP"),
      translated,
    );

    expect(get(out, "content.0.input")).toEqual({ command: "ls", reason: "why" });
  });

  it("does not duplicate the empty object when a parameterless call continues in a later chunk", () => {
    const text = streamText(planMode, [
      candidate([call("EnterPlanMode", { reason: "Plan mode switch" })]),
      candidate([call(undefined, { reason: "more" })], "STOP"),
    ]);

    expect(inputDeltas(text)).toBe("{}");
  });
});

describe("implicitly open empty object schemas (e1fb2521)", () => {
  const echo = request([{ name: "echo", input_schema: { type: "object", properties: {} } }]);

  it.each([
    ["empty then real args", {}, { user: "v" }, '{"user":"v"}'],
    ["placeholder then real args", { reason: "thinking" }, { user: "v" }, '{"user":"v"}'],
    ["real args then empty", { user: "v" }, {}, '{"user":"v"}'],
    ["real args then placeholder", { user: "v" }, { reason: "done" }, '{"user":"v"}'],
  ])("%s", (_name, first, continuation, want) => {
    const text = streamText(echo, [
      candidate([call("echo", first)]),
      candidate([call(undefined, continuation)], "STOP"),
    ]);

    expect(inputDeltas(text)).toBe(want);
  });

  it("normalises only closed empty schemas to {}", () => {
    const closed = request([
      {
        name: "noop",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    ]);

    const body = candidate([call("noop", { user: "v" })], "STOP");
    expect(get(nonStream(closed, body), "content.0.input")).toEqual({});
    expect(get(nonStream(echo, body), "content.0.input")).toEqual({ user: "v" });
  });
});

describe("tool_use ids across turns (58257007)", () => {
  it("never repeats an id between the stream and non-stream conversions", () => {
    const tools = request([]);
    const body = candidate([call("Bash", { command: "ls" })], "STOP");

    const streamed = dataOf(streamWithDone(tools, [body])).find(
      (data) => get(data, "content_block.type") === "tool_use",
    );

    const streamId = get(streamed, "content_block.id");
    const first = get(nonStream(tools, body), "content.0.id");
    const second = get(nonStream(tools, body), "content.0.id");

    expect(streamId).toBeTruthy();
    expect(first).not.toBe(streamId);
    expect(second).not.toBe(first);
  });
});

describe("MALFORMED_FUNCTION_CALL is an API error, not a refusal (7f2f17d7)", () => {
  const tools = request([{ name: "Bash", input_schema: { type: "object" } }]);

  it("ends a partless stream with an error event and no message_stop", () => {
    const text = streamWithDone(tools, [
      {
        candidates: [
          {
            content: { role: "model", parts: [] },
            index: 0,
            finishReason: "MALFORMED_FUNCTION_CALL",
          },
        ],
        modelVersion: "m",
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
      },
    ]);

    expect(text).toContain("event: error\n");
    expect(text).not.toContain('"stop_reason":"refusal"');
    expect(text).not.toContain("message_delta");
    expect(text).not.toContain("message_stop");
    const error = dataOf(text).find((data) => get(data, "type") === "error");
    expect(get(error, "error.type")).toBe("api_error");
    expect(get(error, "error.message")).toContain("MALFORMED_FUNCTION_CALL");
  });

  it("closes an open thinking block before the error", () => {
    const text = streamWithDone(tools, [
      {
        candidates: [
          {
            content: { role: "model", parts: [{ thought: true, text: "planning tool call" }] },
            index: 0,
          },
        ],
        modelVersion: "m",
      },
      {
        candidates: [
          {
            content: { role: "model", parts: [] },
            index: 0,
            finishReason: "MALFORMED_FUNCTION_CALL",
          },
        ],
        modelVersion: "m",
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 373 },
      },
    ]);

    expect(text.indexOf("event: content_block_stop\n")).toBeGreaterThan(-1);
    expect(text.indexOf("event: content_block_stop\n")).toBeLessThan(
      text.indexOf("event: error\n"),
    );
    expect(text).not.toContain("message_stop");
  });

  it("emits the error once and nothing after it", () => {
    const ctx = context(tools);

    const run = (chunk: Json): string =>
      builtinTranslators
        .translateStream(
          "claude",
          "gemini",
          ctx,
          typeof chunk === "string" ? chunk : JSON.stringify(chunk),
        )
        .join("");

    const first = run({
      candidates: [
        {
          content: { role: "model", parts: [] },
          index: 0,
          finishReason: "MALFORMED_FUNCTION_CALL",
        },
      ],
      modelVersion: "m",
    });

    const late = run({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "late text" }] },
          index: 0,
          finishReason: "MALFORMED_FUNCTION_CALL",
        },
      ],
      modelVersion: "m",
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
    });

    expect(first.split("event: error\n")).toHaveLength(2);
    expect(late).toBe("");
    expect(run("[DONE]")).toBe("");
  });

  it("keeps tool_use when the model also produced a tool call", () => {
    const body = candidate([call("Bash", { command: "ls" })], "MALFORMED_FUNCTION_CALL");
    const out = nonStream(tools, body);
    expect(get(out, "stop_reason")).toBe("tool_use");
  });

  it("answers a non-stream malformed call with the error payload", () => {
    const out = nonStream(tools, candidate([], "MALFORMED_FUNCTION_CALL"));
    expect(get(out, "type")).toBe("error");
    expect(get(out, "error.type")).toBe("api_error");
  });

  it("maps MALFORMED_RESPONSE to a refusal (3f5d3a16)", () => {
    const out = nonStream(tools, candidate([{ text: "x" }], "MALFORMED_RESPONSE"));
    expect(get(out, "stop_reason")).toBe("refusal");
  });
});

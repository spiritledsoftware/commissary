// SPI-1415 (Go cf07c78a, 7e82d0d1, f2efe2c4): zero-output abnormal terminations of Gemini responses. Cases follow
// gemini_zero_output_test.go at dd543d09.
import { type Json, tryParseJson } from "@commissary/json";
import { describe, expect, it } from "vite-plus/test";
import {
  inspectGeminiPayload,
  translatedClaudeError,
  type ZeroOutputAction,
  zeroOutputErrorMessage,
  zeroOutputFinishReason,
  ZeroOutputStreamGuard,
} from "../../src/executor/helps/gemini-zero-output.ts";

const finished = (parts: ReadonlyArray<Json>, finishReason?: string): Json => ({
  candidates: [
    {
      content: { role: "model", parts: [...parts] },
      ...(finishReason === undefined ? {} : { finishReason }),
    },
  ],
});

describe("inspectGeminiPayload", () => {
  const cases: ReadonlyArray<
    readonly [string, Json, boolean, { visible?: boolean; thought?: boolean; usage?: boolean }]
  > = [
    [
      "a wrapped abnormal finish with usage",
      {
        response: {
          // SAFETY: `finished` always builds an object literal; `Json` only widens its type for the spread.
          ...(finished([], "MALFORMED_FUNCTION_CALL") as object),
          usageMetadata: { promptTokenCount: 10 },
        },
      },
      true,
      { usage: true },
    ],
    [
      "blank text and a thought",
      finished([{ text: "   " }, { thought: true, text: "thinking" }], "UNEXPECTED_TOOL_CALL"),
      false,
      { thought: true },
    ],
    [
      "a named function call",
      finished([{ functionCall: { name: "bash", args: {} } }], "MALFORMED_FUNCTION_CALL"),
      false,
      { visible: true },
    ],
    [
      "inline data",
      finished([{ inlineData: { mimeType: "image/png", data: "AA==" } }], "MALFORMED_RESPONSE"),
      false,
      { visible: true },
    ],
    [
      "an empty function call",
      finished([{ functionCall: {} }], "MALFORMED_FUNCTION_CALL"),
      false,
      {},
    ],
    [
      "empty media and code parts",
      finished(
        [
          { inlineData: { mimeType: "image/png", data: "" } },
          { fileData: {} },
          { executableCode: {} },
          { codeExecutionResult: {} },
        ],
        "MALFORMED_RESPONSE",
      ),
      false,
      {},
    ],
    [
      "partial arguments",
      finished(
        [{ functionCall: { partialArgs: [{ jsonPath: "$.cmd", stringValue: "ls" }] } }],
        "MALFORMED_FUNCTION_CALL",
      ),
      false,
      { visible: true },
    ],
    [
      "partial text",
      finished([{ text: "partial answer" }], "MALFORMED_FUNCTION_CALL"),
      false,
      { visible: true },
    ],
    [
      "a signature-only part (f2efe2c4)",
      finished([{ text: "", thoughtSignature: "sig" }], "STOP"),
      false,
      {},
    ],
    [
      "a signature-only thought (f2efe2c4)",
      finished([{ thought: true, thought_signature: "sig" }], "STOP"),
      false,
      {},
    ],
    [
      "a thought image",
      finished(
        [{ thought: true, inlineData: { mimeType: "image/png", data: "AA==" } }],
        "MALFORMED_RESPONSE",
      ),
      false,
      { thought: true },
    ],
  ];

  for (const [name, payload, wrapped, want] of cases) {
    it(name, () => {
      const got = inspectGeminiPayload(payload, wrapped);

      expect(got.hasVisibleOutput).toBe(want.visible === true);
      expect(got.hasThoughtOutput).toBe(want.thought === true);
      expect(got.hasUsageMetadata).toBe(want.usage === true);
      expect(got.finishReason).not.toBe("");
    });
  }

  it("finds a zero-output finish in a complete response only without visible output", () => {
    expect(zeroOutputFinishReason(finished([], "MALFORMED_FUNCTION_CALL"))).toBe(
      "MALFORMED_FUNCTION_CALL",
    );
    expect(zeroOutputFinishReason(finished([{ text: "x" }], "MALFORMED_RESPONSE"))).toBeUndefined();
    expect(zeroOutputFinishReason(finished([], "STOP"))).toBeUndefined();
  });
});

describe("ZeroOutputStreamGuard", () => {
  const observe = (guard: ZeroOutputStreamGuard, frame: Json): ZeroOutputAction =>
    guard.observe(JSON.stringify(frame), frame);

  it("withholds leading shells and flushes them before content", () => {
    const guard = new ZeroOutputStreamGuard("openai");
    const shell = finished([]);

    expect(observe(guard, shell)).toEqual({ kind: "continue" });
    expect(observe(guard, finished([{ text: "hello" }]))).toEqual({
      kind: "emit",
      flush: [JSON.stringify(shell)],
    });
    expect(guard.finalize()).toEqual({ kind: "emit", flush: [] });
  });

  it("withholds a leading signature-only frame until content arrives (f2efe2c4)", () => {
    const guard = new ZeroOutputStreamGuard("openai");
    const signature = finished([{ text: "", thoughtSignature: "sig" }]);

    expect(observe(guard, signature)).toEqual({ kind: "continue" });
    expect(observe(guard, finished([{ text: "hello" }]))).toEqual({
      kind: "emit",
      flush: [JSON.stringify(signature)],
    });
  });

  it("fails a stream that closes holding only candidate or usage shells (f2efe2c4)", () => {
    for (const shell of [
      finished([{ text: "", thoughtSignature: "sig" }]),
      { usageMetadata: { promptTokenCount: 3 } },
    ]) {
      const guard = new ZeroOutputStreamGuard("openai");

      expect(observe(guard, shell)).toEqual({ kind: "continue" });
      expect(guard.finalize()).toEqual({ kind: "fail", finishReason: "" });
    }
  });

  it("flushes withheld frames without a candidate or usage at the end", () => {
    const guard = new ZeroOutputStreamGuard("openai");

    expect(observe(guard, { modelVersion: "gemini-2.5-pro" })).toEqual({ kind: "continue" });
    expect(guard.finalize()).toEqual({
      kind: "emit",
      flush: [JSON.stringify({ modelVersion: "gemini-2.5-pro" })],
    });
  });

  it("waits for the trailing usage of an abnormal finish, then fails", () => {
    const guard = new ZeroOutputStreamGuard("openai");

    expect(observe(guard, finished([{ text: "" }]))).toEqual({ kind: "continue" });
    expect(observe(guard, finished([], "MALFORMED_RESPONSE"))).toEqual({ kind: "continue" });
    expect(guard.hasAbnormalFinish).toBe(true);
    expect(observe(guard, { usageMetadata: { promptTokenCount: 120 } })).toEqual({
      kind: "fail",
      finishReason: "MALFORMED_RESPONSE",
    });
  });

  it("fails at the end of the stream without trailing usage", () => {
    const guard = new ZeroOutputStreamGuard("openai");

    observe(guard, finished([], "UNEXPECTED_TOOL_CALL"));

    expect(guard.finalize()).toEqual({ kind: "fail", finishReason: "UNEXPECTED_TOOL_CALL" });
  });

  it("emits a Claude client's error event when thoughts already went out", () => {
    const guard = new ZeroOutputStreamGuard("claude");
    const thought = finished([{ thought: true, text: "hmm" }]);

    expect(observe(guard, thought)).toEqual({ kind: "emit", flush: [] });
    guard.markEmitted();
    const abnormal = finished([], "MALFORMED_FUNCTION_CALL");

    expect(observe(guard, abnormal)).toEqual({ kind: "continue" });
    expect(observe(guard, { usageMetadata: { promptTokenCount: 10 } })).toEqual({
      kind: "emit-error-then-fail",
      frame: JSON.stringify(abnormal),
      finishReason: "MALFORMED_FUNCTION_CALL",
    });
  });

  it("lets an abnormal finish after visible output through", () => {
    const guard = new ZeroOutputStreamGuard("openai");

    observe(guard, finished([{ text: "partial" }]));
    guard.markEmitted();

    expect(observe(guard, finished([], "MALFORMED_FUNCTION_CALL"))).toEqual({
      kind: "emit",
      flush: [],
    });
  });
});

describe("zero-output errors (7e82d0d1)", () => {
  it("formats the message for Claude and other clients", () => {
    expect(tryParseJson(zeroOutputErrorMessage("claude", "malformed_function_call"))).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Gemini response finished with MALFORMED_FUNCTION_CALL",
      },
    });
    expect(zeroOutputErrorMessage("openai", "MALFORMED_RESPONSE")).toBe(
      "upstream returned zero output with finishReason MALFORMED_RESPONSE",
    );
  });

  it("names a stream closed with zero output when there is no reason (f2efe2c4)", () => {
    expect(tryParseJson(zeroOutputErrorMessage("claude", " "))).toEqual({
      type: "error",
      error: { type: "api_error", message: "Gemini stream closed with zero output" },
    });
    expect(zeroOutputErrorMessage("openai", "")).toBe("upstream stream closed with zero output");
  });

  it("keeps a malformed-call Claude error from cooling the credential", () => {
    const malformed = translatedClaudeError(
      zeroOutputErrorMessage("claude", "MALFORMED_FUNCTION_CALL"),
    );

    const other = translatedClaudeError(
      JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }),
    );

    expect(malformed).toMatchObject({ status: 502, code: "transient_transport" });
    expect(other.status).toBe(502);
    expect(other.code).toBeUndefined();
  });
});

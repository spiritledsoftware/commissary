// Gemini client -> Claude: tool results in user turns and Gemini-compatible thought signatures (ticket C8; upstream
// 55c05f70, Go tests claude_gemini_issue7279_test.go).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const MODEL = "claude-sonnet-4";

const convert = (contents: Json[], stream: boolean): Json =>
  builtinTranslators.translateRequest(
    "gemini",
    "claude",
    { format: "gemini", model: MODEL, stream, body: { contents } },
    undefined,
  ).body;

const arr = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);

describe("tool results use Claude user messages", () => {
  const read = (id?: string): Json => ({
    functionCall: { name: "read", ...(id === undefined ? {} : { id }), args: {} },
  });

  const result = (id?: string, key = "functionResponse"): Json => ({
    [key]: { name: "read", ...(id === undefined ? {} : { id }), response: { result: "one" } },
  });

  const ask: Json = { role: "user", parts: [{ text: "read file" }] };

  it.each<[string, Json[], string[]]>([
    [
      "model role with parallel responses",
      [
        { role: "user", parts: [{ text: "read files" }] },
        { role: "model", parts: [read("call-a"), read("call-b")] },
        {
          role: "model",
          parts: [
            { functionResponse: { name: "read", id: "call-a", response: { result: "one" } } },
            { functionResponse: { name: "read", id: "call-b", response: { result: "two" } } },
          ],
        },
      ],
      ["call-a", "call-b"],
    ],
    [
      "assistant role with snake case response",
      [
        ask,
        { role: "model", parts: [{ function_call: { name: "read", id: "call-a", args: {} } }] },
        { role: "assistant", parts: [result("call-a", "function_response")] },
      ],
      ["call-a"],
    ],
    [
      "call and response in one model turn",
      [ask, { role: "model", parts: [read("call-a"), result("call-a")] }],
      ["call-a"],
    ],
    [
      "ordinary user tool result",
      [
        ask,
        { role: "model", parts: [read("call-a")] },
        { role: "user", parts: [result("call-a")] },
      ],
      ["call-a"],
    ],
    [
      "model result without explicit tool id",
      [ask, { role: "model", parts: [read()] }, { role: "model", parts: [result()] }],
      ["toolu_gemini_0000000000000001"],
    ],
    [
      "missing result role",
      [ask, { role: "model", parts: [read("call-a")] }, { parts: [result("call-a")] }],
      ["call-a"],
    ],
  ])("%s", (_name, contents, wantIds) => {
    for (const stream of [false, true]) {
      const messages = arr(get(convert(contents, stream), "messages"));

      expect(messages).toHaveLength(3);
      expect(get(messages[1], "role")).toBe("assistant");
      expect(get(messages[2], "role")).toBe("user");
      const calls = arr(get(messages[1], "content"));
      const results = arr(get(messages[2], "content"));

      expect(calls.map((c) => [get(c, "type"), get(c, "id")])).toEqual(
        wantIds.map((id) => ["tool_use", id]),
      );
      expect(results.map((r) => [get(r, "type"), get(r, "tool_use_id")])).toEqual(
        wantIds.map((id) => ["tool_result", id]),
      );
    }
  });

  it.each<[string, Json[]]>([
    [
      "text and result in one turn",
      [
        ask,
        { role: "model", parts: [read("call-a")] },
        { role: "model", parts: [{ text: "continue" }, result("call-a")] },
      ],
    ],
    [
      "text before a separate result turn",
      [
        ask,
        { role: "model", parts: [read("call-a")] },
        { role: "user", parts: [{ text: "continue" }] },
        { role: "model", parts: [result("call-a")] },
      ],
    ],
  ])("puts the tool result before user text: %s", (_name, contents) => {
    const message = get(convert(contents, true), "messages.2");

    expect(get(message, "role")).toBe("user");
    expect(get(message, "content.0.type")).toBe("tool_result");
    expect(get(message, "content.0.tool_use_id")).toBe("call-a");
    expect(get(message, "content.1.text")).toBe("continue");
  });
});

describe("Claude thinking signatures become valid Gemini bytes", () => {
  const VALID = "EjQKMgEMOdbHO0Gd+c9Mxk4ELwPGbpCEcp2mFfYYLix2UVtBH3fL8GECc4+JITVnHF4qZDsA";

  const cases = [
    { name: "foreign Claude signature", signature: "foreign_claude_sig_123", want: "" },
    { name: "native Gemini signature", signature: `gemini#${VALID}`, want: VALID },
    {
      name: "unpadded native Gemini signature",
      signature: "gemini#EggKBgEMOdbHNA",
      want: "EggKBgEMOdbHNA==",
    },
  ];

  const events = (signature: string): Json[] => [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", signature } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "reasoning" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
  ];

  const parts = (out: string[]): Json[] =>
    out.flatMap((line) => arr(get(tryParseJson(line) as Json, "candidates.0.content.parts")));

  describe.each(cases)("$name", ({ signature, want }) => {
    const check = (found: Json[]) => {
      const text = found.flatMap((p) => {
        const thought = get(p, "thought") === true ? get(p, "text") : undefined;

        return typeof thought === "string" ? [thought] : [];
      });

      expect(text.join("")).toBe("reasoning");

      const signatures = found.flatMap((p) => {
        const signature = get(p, "thoughtSignature");

        return signature === undefined ? [] : [signature];
      });

      expect(signatures).not.toContain("skip_thought_signature_validator");

      for (const s of signatures)
        expect(typeof s === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(s)).toBe(true);

      if (want !== "") expect(signatures.at(-1)).toBe(want);
      else expect(signatures).toEqual([]);
    };

    it("stream", () => {
      const state = {
        model: MODEL,
        originalRequest: {},
        translatedRequest: {},
        state: makeTranslationState(),
      };

      const out = events(signature).flatMap((event) =>
        builtinTranslators.translateStream(
          "gemini",
          "claude",
          state,
          `data: ${JSON.stringify(event)}`,
        ),
      );

      check(parts(out));
    });

    it("non-stream", () => {
      const state = {
        model: MODEL,
        originalRequest: {},
        translatedRequest: {},
        state: makeTranslationState(),
      };

      const body = events(signature)
        .map((event) => `data: ${JSON.stringify(event)}`)
        .join("\n");

      const out = builtinTranslators.translateNonStream("gemini", "claude", state, body);

      check(parts(out === undefined ? [] : [out]));
    });
  });
});

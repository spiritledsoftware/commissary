// SPI-1415 (Go 7be2a678, b82d3d4e, 0286e5d1): the Gemini thought-signature sanitiser treats snake_case
// function_call/function_response parts like their camelCase forms, an empty signature field does not shadow a later
// valid one, and the signature cache groups model names case-insensitively. Cases follow those commits' Go tests.
import { get, type Json } from "@commissary/json";
import { describe, expect, it } from "vite-plus/test";
import { getModelGroup, hasValidSignature, MemorySignatureCache } from "../src/signature/cache.ts";
import { sanitizeGeminiRequestThoughtSignatures } from "../src/signature/gemini.ts";
import { sig } from "./support/gemini-signatures.ts";

const SENTINEL = "skip_thought_signature_validator";

const NATIVE = sig();

/** A bare-Tink payload under a key id that is not Vertex's: no known envelope, so the replay policy rejects it. */
const UNKNOWN = btoa(
  String.fromCharCode(
    ...Array.from({ length: 405 }, (_, i) =>
      i === 0 ? 0x01 : i < 5 ? [0x69, 0x14, 0x7d, 0x13][i - 1]! : 0xa0 + (i % 0x20),
    ),
  ),
);

const sanitize = (contents: ReadonlyArray<Json>): Json =>
  sanitizeGeminiRequestThoughtSignatures({ contents: [...contents] });

const at = (payload: Json, path: string): Json | undefined => get(payload, `contents.${path}`);

describe("snake_case function_call and function_response parts (Go 7be2a678)", () => {
  it("keeps the first call's sentinel and strips the response's signature", () => {
    const out = sanitize([
      { role: "model", parts: [{ function_call: { name: "w" }, thoughtSignature: SENTINEL }] },
      {
        role: "user",
        parts: [{ function_response: { name: "w", response: {} }, thoughtSignature: "abc" }],
      },
    ]);

    expect(at(out, "0.parts.0.thoughtSignature")).toBe(SENTINEL);
    expect(at(out, "1.parts.0.thoughtSignature")).toBeUndefined();
  });

  it("signs an unsigned first call and leaves its parallel sibling unsigned", () => {
    const out = sanitize([
      {
        role: "model",
        parts: [
          { function_call: { name: "first", args: {} } },
          { function_call: { name: "second", args: {} } },
        ],
      },
    ]);

    expect(at(out, "0.parts.0.thoughtSignature")).toBe(SENTINEL);
    expect(at(out, "0.parts.1.thoughtSignature")).toBeUndefined();
  });

  it("normalizes the first call's thought_signature and strips the sibling's bypass", () => {
    const out = sanitize([
      {
        role: "model",
        parts: [
          { function_call: { name: "first", args: {} }, thought_signature: SENTINEL },
          { function_call: { name: "second", args: {} }, thought_signature: SENTINEL },
        ],
      },
    ]);

    expect(at(out, "0.parts.0.thoughtSignature")).toBe(SENTINEL);
    expect(at(out, "0.parts.0.thought_signature")).toBeUndefined();
    expect(at(out, "0.parts.1.thoughtSignature")).toBeUndefined();
    expect(at(out, "0.parts.1.thought_signature")).toBeUndefined();
  });

  it("treats a camelCase call after a snake_case one as its parallel sibling", () => {
    const out = sanitize([
      {
        role: "model",
        parts: [
          { function_call: { name: "first", args: {} }, thoughtSignature: NATIVE },
          { functionCall: { name: "second", args: {} } },
        ],
      },
    ]);

    expect(at(out, "0.parts.0.thoughtSignature")).toBe(NATIVE);
    expect(at(out, "0.parts.1.thoughtSignature")).toBeUndefined();
  });

  it("replaces a nested function_call signature and removes the nested fields", () => {
    const out = sanitize([
      {
        role: "model",
        parts: [
          {
            function_call: {
              name: "f",
              args: {},
              thought_signature: UNKNOWN,
              thoughtSignature: UNKNOWN,
            },
          },
        ],
      },
    ]);

    expect(at(out, "0.parts.0.thoughtSignature")).toBe(SENTINEL);
    expect(at(out, "0.parts.0.function_call.thought_signature")).toBeUndefined();
    expect(at(out, "0.parts.0.function_call.thoughtSignature")).toBeUndefined();
  });

  it("strips top-level and nested function_response signatures", () => {
    const out = sanitize([
      {
        role: "user",
        parts: [
          {
            function_response: {
              name: "f",
              response: { result: "ok" },
              thoughtSignature: "bad1",
              thought_signature: "bad2",
            },
            thought_signature: "bad3",
          },
        ],
      },
    ]);

    for (const path of [
      "0.parts.0.thoughtSignature",
      "0.parts.0.thought_signature",
      "0.parts.0.function_response.thoughtSignature",
      "0.parts.0.function_response.thought_signature",
    ]) {
      expect(at(out, path), path).toBeUndefined();
    }
  });
});

describe("an empty signature field does not shadow a fallback (Go b82d3d4e)", () => {
  const call = { functionCall: { name: "get_weather", args: {} } };

  const cases: ReadonlyArray<readonly [string, Json, string]> = [
    [
      "empty string, extra_content fallback",
      { ...call, thoughtSignature: "", extra_content: { google: { thought_signature: NATIVE } } },
      "extra_content.google.thought_signature",
    ],
    [
      "whitespace, extra_content fallback",
      {
        ...call,
        thoughtSignature: "   ",
        extra_content: { google: { thought_signature: NATIVE } },
      },
      "extra_content.google.thought_signature",
    ],
    [
      "null, extra_content fallback",
      { ...call, thoughtSignature: null, extra_content: { google: { thought_signature: NATIVE } } },
      "extra_content.google.thought_signature",
    ],
    [
      "empty string, snake_case fallback",
      { ...call, thoughtSignature: "", thought_signature: NATIVE },
      "thought_signature",
    ],
    [
      "empty string, nested functionCall fallback",
      {
        functionCall: { name: "get_weather", args: {}, thoughtSignature: NATIVE },
        thoughtSignature: "",
      },
      "functionCall.thoughtSignature",
    ],
    [
      "empty string on a text part, extra_content fallback",
      {
        text: "previous answer",
        thoughtSignature: "",
        extra_content: { google: { thought_signature: NATIVE } },
      },
      "extra_content.google.thought_signature",
    ],
  ];

  for (const [name, part, fallback] of cases) {
    it(`promotes the fallback: ${name}`, () => {
      const out = sanitize([{ role: "model", parts: [structuredClone(part)] }]);

      expect(at(out, "0.parts.0.thoughtSignature")).toBe(NATIVE);
      expect(at(out, `0.parts.0.${fallback}`)).toBeUndefined();
    });
  }

  it("gives a first call with only empty fields the sentinel and clears them", () => {
    const out = sanitize([
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "f", args: {} },
            thoughtSignature: "",
            extra_content: { google: { thought_signature: "   " } },
          },
        ],
      },
    ]);

    expect(at(out, "0.parts.0.thoughtSignature")).toBe(SENTINEL);
    expect(at(out, "0.parts.0.extra_content.google.thought_signature")).toBeUndefined();
  });

  it("strips all-empty fields from a text part and a functionResponse", () => {
    const out = sanitize([
      {
        role: "model",
        parts: [{ text: "answer", thoughtSignature: "", thought_signature: null }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: { name: "f", response: { result: "ok" } },
            thoughtSignature: "",
            extra_content: { google: { thought_signature: "" } },
          },
        ],
      },
    ]);

    expect(at(out, "0.parts.0.thoughtSignature")).toBeUndefined();
    expect(at(out, "0.parts.0.thought_signature")).toBeUndefined();
    expect(at(out, "1.parts.0.thoughtSignature")).toBeUndefined();
    expect(at(out, "1.parts.0.extra_content.google.thought_signature")).toBeUndefined();
  });
});

describe("signature cache model groups are case-insensitive (Go 0286e5d1)", () => {
  it("groups mixed-case and padded names with their family", () => {
    expect(getModelGroup(" GPT-5 ")).toBe("gpt");
    expect(getModelGroup("Claude-Sonnet-4")).toBe("claude");
    expect(getModelGroup("Gemini-2.5-Pro")).toBe("gemini");
    expect(getModelGroup("Kimi-K2")).toBe("Kimi-K2");
  });

  it("shares entries across casings and keeps the Gemini sentinel valid", () => {
    const cache = new MemorySignatureCache();
    const signature = "s".repeat(64);

    expect(cache.set("Claude-Opus-4", "thinking", signature)).toBe(true);
    expect(cache.get("claude-sonnet-4", "thinking")).toBe(signature);
    expect(cache.get("GEMINI-3-PRO", "unseen")).toBe(SENTINEL);
    expect(hasValidSignature("Gemini-3-Pro", SENTINEL)).toBe(true);
  });
});

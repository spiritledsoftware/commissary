// Empty part objects in systemInstruction.parts (ticket C8; upstream 4c46f0aa, f42f5871): Cloud Code Assist and Vertex 400
// on a Part whose `data` oneof is unset, so `{}` parts are removed and an all-empty systemInstruction is dropped.
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import { sanitizeGeminiRequestThoughtSignatures } from "../src/signature/gemini.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";

const hi: Json = { role: "user", parts: [{ text: "hi" }] };

describe("sanitizeGeminiRequestThoughtSignatures: systemInstruction", () => {
  it("drops systemInstruction when all parts are empty objects", () => {
    const out = sanitizeGeminiRequestThoughtSignatures(
      { request: { systemInstruction: { parts: [{}] }, contents: [hi] } },
      "request.contents",
    );

    expect(get(out, "request.systemInstruction")).toBeUndefined();
    expect(get(out, "request.contents")).toEqual([hi]);
  });

  it("keeps the non-empty parts and the role", () => {
    const out = sanitizeGeminiRequestThoughtSignatures(
      {
        systemInstruction: { role: "user", parts: [{}, { text: "keep rule" }, {}] },
        contents: [hi],
      },
      "contents",
    );

    expect(get(out, "systemInstruction")).toEqual({ role: "user", parts: [{ text: "keep rule" }] });
  });

  it("cleans the snake_case key too", () => {
    const out = sanitizeGeminiRequestThoughtSignatures(
      { system_instruction: { parts: [{}, { text: "keep rule" }] }, contents: [hi] },
      "contents",
    );

    expect(get(out, "system_instruction.parts")).toEqual([{ text: "keep rule" }]);
  });

  it("leaves valid parts alone", () => {
    const input = { systemInstruction: { parts: [{ text: "keep rule" }] }, contents: [hi] };
    const out = sanitizeGeminiRequestThoughtSignatures(structuredClone(input), "contents");

    expect(out).toEqual(input);
  });
});

describe("Gemini -> Antigravity: systemInstruction parts", () => {
  const convert = (model: string, body: Json): Json =>
    builtinTranslators.translateRequest(
      "gemini",
      "antigravity",
      { format: "gemini", model, stream: true, body },
      undefined,
    ).body;

  describe.each(["gemini-3.8-flash", "claude-sonnet-4-5"])("%s", (model) => {
    it.each([
      ["camelCase systemInstruction", "systemInstruction"],
      ["snake_case system_instruction", "system_instruction"],
    ])("removes %s with a single empty part", (_name, key) => {
      const out = convert(model, {
        contents: [hi],
        [key]: { parts: [{}] },
        generationConfig: { temperature: 1 },
      });

      expect(get(out, "request.system_instruction")).toBeUndefined();
      expect(get(out, "request.systemInstruction")).toBeUndefined();
    });

    it("keeps the valid parts and the role of a mixed systemInstruction", () => {
      const out = convert(model, {
        contents: [hi],
        systemInstruction: { role: "user", parts: [{}, { text: "Be concise" }, {}] },
      });

      expect(get(out, "request.systemInstruction")).toEqual({
        role: "user",
        parts: [{ text: "Be concise" }],
      });
    });
  });
});

describe("Claude -> Antigravity: empty system text", () => {
  it.each(["claude-sonnet-4-5", "gemini-3.8-flash"])("%s sends no empty system part", (model) => {
    const out = builtinTranslators.translateRequest(
      "claude",
      "antigravity",
      {
        format: "claude",
        model,
        stream: false,
        body: {
          model,
          system: [{ type: "text", text: "" }],
          messages: [{ role: "user", content: "hi" }],
        },
      },
      undefined,
    ).body;

    expect(JSON.stringify(get(out, "request.systemInstruction") ?? null)).not.toContain("{}");
  });
});

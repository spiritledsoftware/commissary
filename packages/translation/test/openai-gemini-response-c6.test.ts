// OpenAI chat -> Gemini streaming (ticket C6; upstream bdde391d): a delta that carries content or reasoning together with
// a finish_reason still ends the candidate.
import { describe, expect, it } from "vitest";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const run = (lines: Json[]): Json[] => {
  const ctx = {
    model: "glm-test",
    originalRequest: undefined,
    translatedRequest: undefined,
    state: makeTranslationState(),
  };

  return lines.flatMap((line) =>
    builtinTranslators
      .translateStream("gemini", "openai", ctx, JSON.stringify(line))
      .map((chunk) => tryParseJson(chunk) as Json),
  );
};

describe("OpenAI -> Gemini stream: content with finish_reason (bdde391d)", () => {
  it("emits the text and STOP from one delta", () => {
    const out = run([
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
    ]);

    const text = out
      .map((chunk) => asString(get(chunk, "candidates.0.content.parts.0.text")))
      .find((value) => value !== "");

    const reason = out
      .map((chunk) => asString(get(chunk, "candidates.0.finishReason")))
      .find((value) => value !== "");

    expect(text).toBe("ok");
    expect(reason).toBe("STOP");
  });

  it("emits the thought and MAX_TOKENS from one reasoning delta", () => {
    const out = run([
      {
        choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: "length" }],
      },
    ]);

    const thought = out.find(
      (chunk) => get(chunk, "candidates.0.content.parts.0.thought") === true,
    );

    expect(get(thought, "candidates.0.content.parts.0.text")).toBe("thinking");

    expect(
      out
        .map((chunk) => asString(get(chunk, "candidates.0.finishReason")))
        .find((value) => value !== ""),
    ).toBe("MAX_TOKENS");
  });
});

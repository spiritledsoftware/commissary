// OpenAI chat -> Antigravity request (ticket C6; upstream 80aa2b1d): tool_choice none keeps the tool declarations, so a
// later turn's replayed history is not bound to the current tool policy.
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";

describe("OpenAI -> Antigravity: tool_choice none (80aa2b1d)", () => {
  it.each([
    ["string none", "none"],
    ["object none", { type: "none" }],
  ])("%s keeps the declarations with mode NONE", (_name, toolChoice) => {
    const body: Json = {
      model: "gemini-3-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
      ],
      tool_choice: toolChoice,
    };

    const out = builtinTranslators.translateRequest(
      "openai",
      "antigravity",
      { format: "openai", model: "gemini-3-flash", stream: false, body },
      undefined,
    ).body;

    expect(get(out, "request.toolConfig.functionCallingConfig.mode")).toBe("NONE");
    expect(get(out, "request.tools.0.functionDeclarations.0.name")).toBe("get_weather");
  });
});

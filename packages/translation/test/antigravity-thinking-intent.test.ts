// `RequestedAntigravityThinkingLevel` (internal/thinking/apply.go, antigravity_intent.go; CLIProxyAPI 2f86992c,
// ffa55112): the explicit level a request asks for, before defaults or clamping.
import { describe, expect, it } from "vite-plus/test";
import type { Json } from "@commissary/json";
import { requestedAntigravityThinkingLevel } from "../src/thinking/index.ts";

const level = (body: string, provider: string, model = "gemini-demo-ultra-low"): string =>
  requestedAntigravityThinkingLevel(JSON.parse(body) as Json, provider, model);

describe("requestedAntigravityThinkingLevel", () => {
  it("reads each client format's own thinking fields", () => {
    expect(
      level(`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"xhigh"}}}`, "gemini"),
    ).toBe("xhigh");
    expect(
      level(
        `{"thinking":{"type":"adaptive"},"output_config":{"effort":"xhigh"},"messages":[]}`,
        "claude",
      ),
    ).toBe("xhigh");
    expect(level(`{"thinking":{"type":"adaptive"},"messages":[]}`, "claude")).toBe("");
    expect(level(`{"reasoning":{"effort":"xhigh"},"input":"hi"}`, "openai-response")).toBe("xhigh");
  });

  it("follows the OpenAI Chat converter's precedence", () => {
    expect(
      level(
        `{"generation_config":{"thinking_config":{"thinking_level":"xhigh"}},"messages":[]}`,
        "openai",
      ),
    ).toBe("xhigh");
    // A nested snake_case level overrides reasoning_effort.
    expect(
      level(
        `{"reasoning_effort":"xhigh","generation_config":{"thinking_config":{"thinking_level":"low"}}}`,
        "openai",
      ),
    ).toBe("low");
    expect(level(`{"reasoning_effort":"high"}`, "openai")).toBe("high");
    expect(level(`{"reasoning_effort":"auto"}`, "openai")).toBe("");
    // ffa55112: extra_body.google.thinking_config is the last fallback.
    expect(
      level(`{"extra_body":{"google":{"thinking_config":{"thinking_level":"medium"}}}}`, "openai"),
    ).toBe("medium");
  });

  it("lets Interactions reasoning override the generation config", () => {
    expect(
      level(
        `{"reasoning":{"effort":"xhigh"},"generation_config":{"thinking_level":"low"}}`,
        "interactions",
      ),
    ).toBe("xhigh");
    expect(level(`{"reasoning":{"thinking_level":"xhigh"}}`, "interactions")).toBe("xhigh");
  });

  it("reads the snake_case Gemini container", () => {
    expect(
      level(`{"generationConfig":{"thinking_config":{"thinkingLevel":"LOW"}}}`, "gemini"),
    ).toBe("low");
  });

  it("lets a model suffix win, unknown levels and budgets included", () => {
    const body = `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"xhigh"}}}`;
    expect(level(body, "gemini", "claude-demo-ultra-xhigh(low)")).toBe("low");
    expect(level(body, "gemini", "gemini-3.8-flash-high(very-high)")).toBe("very-high");
    expect(level(body, "gemini", "gemini-demo-ultra-xhigh(1024)")).toBe("low");
    expect(level(body, "gemini", "gemini-demo(auto)")).toBe("");
  });

  it("maps a positive budget to its level and ignores none", () => {
    expect(level(`{"generationConfig":{"thinkingConfig":{"thinkingBudget":1024}}}`, "gemini")).toBe(
      "low",
    );
    expect(level(`{"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}`, "gemini")).toBe(
      "",
    );
    expect(level(`{"messages":[]}`, "openai")).toBe("");
  });
});

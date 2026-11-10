import { describe, expect, it } from "vitest";
import { get, type Json, tryParseJson } from "@commissary/json";
import type { ThinkingModelInfo } from "../src/thinking/index.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { withModelInfoLookup } from "../src/translator/model-info.ts";
import { summaryHooks } from "../src/translator/summary-hooks.ts";

// Request translators that read or write a thinking level around Claude: standalone `output_config.effort` (Go
// 009f8d7a, e6931d51) and the `hasLevel` / `dynamicAllowed` guards of ad9e456d.

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const translate = (from: string, to: string, model: string, body: string): Json =>
  builtinTranslators.translateRequest(
    from,
    to,
    { format: from, model, stream: false, body: parse(body) },
    summaryHooks,
  ).body;

const MESSAGES = `"messages":[{"role":"user","content":"hi"}]`;

describe("Claude request with output_config.effort and no thinking object", () => {
  const request = (extra: string): string => `{"model":"m","max_tokens":1024,${MESSAGES}${extra}}`;

  it.each([
    ["openai", "reasoning_effort"],
    ["codex", "reasoning.effort"],
  ])("reaches %s requests as a thinking level", (to, path) => {
    const out = translate(
      "claude",
      to,
      "gpt-6-astra",
      request(`,"output_config":{"effort":" High "}`),
    );

    expect(get(out, path)).toBe("high");
  });

  it("keeps the defaults when there is no effort", () => {
    expect(
      get(translate("claude", "openai", "m", request("")), "reasoning_effort"),
    ).toBeUndefined();
    expect(get(translate("claude", "codex", "m", request("")), "reasoning.effort")).toBe("medium");
  });

  it.each([
    ["disabled", `"thinking":{"type":"disabled"}`, "none"],
    ["adaptive with its own effort", `"thinking":{"type":"adaptive"}`, "high"],
    ["enabled with a budget", `"thinking":{"type":"enabled","budget_tokens":1}`, "minimal"],
  ])("loses to an explicit thinking object (%s)", (_name, thinking, want) => {
    const body = request(`,${thinking},"output_config":{"effort":"high"}`);

    // The adaptive object carries the effort itself, so it reads the same value.
    expect(get(translate("claude", "openai", "m", body), "reasoning_effort")).toBe(want);
    expect(get(translate("claude", "codex", "m", body), "reasoning.effort")).toBe(want);
  });

  it("is ignored when it is not a string", () => {
    const out = translate("claude", "openai", "m", request(`,"output_config":{"effort":3}`));

    expect(get(out, "reasoning_effort")).toBeUndefined();
  });
});

describe("OpenAI to Claude keeps a thinking level the model lists", () => {
  const opus: ThinkingModelInfo = {
    id: "claude-opus-5-5",
    type: "claude",
    thinking: {
      zeroAllowed: false,
      dynamicAllowed: true,
      levels: ["low", "medium", "high", "xhigh", "max"],
    },
  };

  const lookup = (id: string): ThinkingModelInfo | undefined =>
    id === "claude-opus-5-5" ? opus : undefined;

  it("on chat completions", () => {
    const out = withModelInfoLookup(lookup, () =>
      translate(
        "openai",
        "claude",
        "claude-opus-5-5",
        `{"model":"claude-opus-5-5",${MESSAGES},"reasoning_effort":"xhigh"}`,
      ),
    );

    expect(get(out, "thinking.type")).toBe("adaptive");
    expect(get(out, "output_config.effort")).toBe("xhigh");
  });

  it("on Responses", () => {
    const out = withModelInfoLookup(lookup, () =>
      translate(
        "openai-response",
        "claude",
        "claude-opus-5-5",
        `{"model":"claude-opus-5-5","input":"hi","reasoning":{"effort":"xhigh"}}`,
      ),
    );

    expect(get(out, "thinking.type")).toBe("adaptive");
    expect(get(out, "output_config.effort")).toBe("xhigh");
  });

  it("still maps a level the model does not list", () => {
    const noXhigh: ThinkingModelInfo = {
      ...opus,
      thinking: { levels: ["low", "medium", "high"] },
    };

    const out = withModelInfoLookup(
      () => noXhigh,
      () =>
        translate(
          "openai",
          "claude",
          "claude-opus-5-5",
          `{"model":"m",${MESSAGES},"reasoning_effort":"xhigh"}`,
        ),
    );

    expect(get(out, "output_config.effort")).toBe("high");
  });
});

describe("Gemini to Claude with a dynamic thinking budget or level", () => {
  const dynamic: ThinkingModelInfo = {
    id: "claude-opus-5-5",
    type: "claude",
    thinking: {
      zeroAllowed: false,
      dynamicAllowed: true,
      levels: ["low", "medium", "high", "xhigh", "max"],
    },
  };

  const gemini = (config: string): string =>
    `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":${config}}}`;

  it.each([
    ["thinkingBudget -1", `{"thinkingBudget":-1}`],
    ["thinkingLevel auto", `{"thinkingLevel":"auto"}`],
  ])("%s becomes adaptive thinking without an effort", (_name, config) => {
    const out = withModelInfoLookup(
      () => dynamic,
      () => translate("gemini", "claude", "claude-opus-5-5", gemini(config)),
    );

    expect(get(out, "thinking.type")).toBe("adaptive");
    expect(get(out, "output_config.effort")).toBeUndefined();
  });

  it("keeps mapping an explicit level, and a model without dynamic budgets", () => {
    const explicit = withModelInfoLookup(
      () => dynamic,
      () => translate("gemini", "claude", "claude-opus-5-5", gemini(`{"thinkingLevel":"xhigh"}`)),
    );

    expect(get(explicit, "output_config.effort")).toBe("xhigh");

    const fixed = withModelInfoLookup(
      () => ({ ...dynamic, thinking: { levels: ["low", "medium", "high"] } }),
      () => translate("gemini", "claude", "claude-opus-5-5", gemini(`{"thinkingBudget":-1}`)),
    );

    expect(get(fixed, "thinking.type")).toBe("adaptive");
    expect(get(fixed, "output_config.effort")).toBeDefined();
  });
});

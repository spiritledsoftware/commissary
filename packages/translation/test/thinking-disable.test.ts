import { describe, expect, it } from "vitest";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import {
  applyThinking,
  claudeEffortDirective,
  extractReasoningEffort,
  extractTranslatedReasoningEffort,
  type ThinkingModelInfo,
} from "../src/thinking/index.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { summaryHooks } from "../src/translator/summary-hooks.ts";
import { catalogLookup } from "./support/thinking.ts";

// Ports of the Go tests added with ad9e456d (internal/thinking/claude_issue_6698_test.go), 009f8d7a and e6931d51
// (standalone Claude output_config.effort), and fb30a9e8 (internal/thinking/claude_effort_directive_test.go).

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const levels = ["low", "medium", "high", "xhigh", "max"];

/** claude-sonnet-5-5: turns thinking off with `between_tools`. */
const sonnet55: ThinkingModelInfo = {
  id: "claude-sonnet-5-5",
  type: "claude",
  thinking: { zeroAllowed: true, dynamicAllowed: true, disableType: "between_tools", levels },
};

/** claude-opus-5-5, claude-fable-5, claude-fable-5-1: reject `disabled`. */
const adaptiveOnly = (id: string): ThinkingModelInfo => ({
  id,
  type: "claude",
  thinking: { zeroAllowed: false, dynamicAllowed: true, levels },
});

/** claude-opus-5 and the rest: accept `disabled`. */
const disableable = (id: string): ThinkingModelInfo => ({
  id,
  type: "claude",
  thinking: { zeroAllowed: true, dynamicAllowed: true, levels },
});

const apply = (body: string, model: string, info: ThinkingModelInfo) =>
  applyThinking(parse(body), {
    model,
    fromFormat: "claude",
    toFormat: "claude",
    providerKey: "claude",
    modelInfo: info,
    lookupModelInfo: catalogLookup,
  });

const MESSAGES = `"messages":[{"role":"user","content":"hi"}]`;

describe("Claude thinking off", () => {
  const sonnetCases: ReadonlyArray<readonly [string, string, string]> = [
    ["disabled", `{${MESSAGES},"thinking":{"type":"disabled"}}`, "claude-sonnet-5-5"],
    [
      "disabled with stale budget, display, block_binding and effort",
      `{${MESSAGES},"thinking":{"type":"disabled","budget_tokens":8000,"display":"omitted","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"xhigh"}}`,
      "claude-sonnet-5-5",
    ],
    [
      "suffix none overrides active thinking",
      `{${MESSAGES},"thinking":{"type":"adaptive","display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"max"}}`,
      "claude-sonnet-5-5(none)",
    ],
    [
      "suffix zero",
      `{${MESSAGES},"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`,
      "claude-sonnet-5-5(0)",
    ],
    [
      "zero budget with display and block_binding",
      `{${MESSAGES},"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`,
      "claude-sonnet-5-5",
    ],
  ];

  it.each(sonnetCases)("claude-sonnet-5-5 uses between_tools: %s", (_name, body, model) => {
    const { body: out, error } = apply(body, model, sonnet55);

    expect(error).toBeUndefined();
    expect(JSON.stringify(get(out, "thinking"))).toBe(`{"type":"between_tools"}`);
    expect(get(out, "output_config.effort")).toBeUndefined();
    expect(extractTranslatedReasoningEffort(out, "claude")).toBe("none");
  });

  const fallbackModels = ["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"];

  it.each(fallbackModels)("%s falls back to adaptive low with display omitted", (model) => {
    const body = `{"model":"${model}",${MESSAGES},"thinking":{"type":"disabled","budget_tokens":8000,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`;
    const { body: out, error } = apply(body, model, adaptiveOnly(model));

    expect(error).toBeUndefined();
    expect(get(out, "thinking.type")).toBe("adaptive");
    expect(get(out, "output_config.effort")).toBe("low");
    expect(get(out, "thinking.display")).toBe("omitted");
    expect(get(out, "thinking.budget_tokens")).toBeUndefined();
    expect(get(out, "thinking.block_binding")).toBeUndefined();
  });

  it.each(["claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5"])(
    "%s keeps a bare disabled block",
    (model) => {
      const body = `{"model":"${model}",${MESSAGES},"thinking":{"type":"disabled","budget_tokens":8000,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`;
      const { body: out } = apply(body, model, disableable(model));

      expect(JSON.stringify(get(out, "thinking"))).toBe(`{"type":"disabled"}`);
      expect(get(out, "output_config.effort")).toBeUndefined();
    },
  );

  const active = `{"model":"claude-opus-5-5",${MESSAGES},"thinking":{"type":"enabled","budget_tokens":8000,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`;

  it.each([
    ["suffix none", active, "claude-opus-5-5(none)"],
    ["suffix zero", active, "claude-opus-5-5(0)"],
    [
      "zero budget",
      `{"model":"claude-opus-5-5",${MESSAGES},"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`,
      "claude-opus-5-5",
    ],
  ])("an off request on a model that cannot be disabled: %s", (_name, body, model) => {
    const { body: out } = apply(body, model, adaptiveOnly("claude-opus-5-5"));

    expect(get(out, "thinking.budget_tokens")).toBeUndefined();
    expect(get(out, "thinking.block_binding")).toBeUndefined();
    expect(get(out, "thinking.type")).toBe("adaptive");
    expect(get(out, "output_config.effort")).toBe("low");
    expect(get(out, "thinking.display")).toBe("omitted");
  });

  it.each([
    ["high", "medium", "low"],
    ["auto", "high", "low"],
  ])("falls back to the lowest canonical level of %s", (...configured) => {
    const info: ThinkingModelInfo = {
      id: "claude-opus-5-5",
      type: "claude",
      thinking: { zeroAllowed: false, dynamicAllowed: true, levels: configured },
    };

    const { body: out } = apply(
      `{"model":"claude-opus-5-5",${MESSAGES},"thinking":{"type":"disabled"}}`,
      "claude-opus-5-5",
      info,
    );

    expect(get(out, "thinking.type")).toBe("adaptive");
    expect(get(out, "output_config.effort")).toBe("low");
  });

  it("reports between_tools as none when recording usage", () => {
    const body = parse(
      `{"thinking":{"type":"between_tools"},"output_config":{"effort":"high"},${MESSAGES}}`,
    );

    expect(extractReasoningEffort(body, "claude", "claude-sonnet-5-5")).toBe("none");
  });
});

describe("Claude output_config.effort without thinking", () => {
  const request = (extra: string): string => `{"model":"m","max_tokens":1024,${MESSAGES}${extra}}`;

  const translate = (to: string, body: string, model = "gpt-6-astra"): Json =>
    builtinTranslators.translateRequest(
      "claude",
      to,
      { format: "claude", model, stream: false, body: parse(body) },
      summaryHooks,
    ).body;

  it("reaches OpenAI chat requests as reasoning_effort", () => {
    const out = translate("openai", request(`,"output_config":{"effort":" High "}`));

    expect(get(out, "reasoning_effort")).toBe("high");
  });

  it("reaches Codex requests as reasoning.effort", () => {
    const out = translate("codex", request(`,"output_config":{"effort":"low"}`));

    expect(get(out, "reasoning.effort")).toBe("low");
  });

  it("keeps the defaults when no effort is given", () => {
    expect(get(translate("openai", request("")), "reasoning_effort")).toBeUndefined();
    expect(get(translate("codex", request("")), "reasoning.effort")).toBe("medium");
  });

  it("does not override an explicit disabled thinking object", () => {
    const body = request(`,"thinking":{"type":"disabled"},"output_config":{"effort":"high"}`);

    expect(get(translate("openai", body), "reasoning_effort")).toBe("none");
    expect(get(translate("codex", body), "reasoning.effort")).toBe("none");
  });

  it("is kept on native Claude requests, leaving the model's thinking default", () => {
    const { body: out, error } = apply(
      request(`,"output_config":{"effort":"max"}`),
      "claude-opus-5-5",
      adaptiveOnly("claude-opus-5-5"),
    );

    expect(error).toBeUndefined();
    expect(get(out, "thinking")).toBeUndefined();
    expect(get(out, "output_config.effort")).toBe("max");
  });

  it("is read as the request's effort by usage extraction", () => {
    const body = parse(request(`,"output_config":{"effort":"medium"}`));

    expect(extractReasoningEffort(body, "claude", "claude-opus-5-5")).toBe("medium");
  });

  it("still lets a suffix change native Claude thinking", () => {
    const { body: out } = apply(
      request(`,"output_config":{"effort":"max"}`),
      "claude-opus-5-5(low)",
      adaptiveOnly("claude-opus-5-5"),
    );

    expect(asString(get(out, "output_config.effort"))).toBe("low");
  });
});

describe("claudeEffortDirective", () => {
  const directive = (effort: string): string =>
    `{"role":"system","content":[],"output_config":{"effort":${JSON.stringify(effort)}}}`;

  const user = `{"role":"user","content":"hi"}`;

  it.each([
    ["no messages", `{"output_config":{"effort":"low"}}`, ""],
    ["no directive", `{"messages":[${user}]}`, ""],
    [
      "last directive wins",
      `{"messages":[${directive("medium")},${user},${directive(" HIGH ")}]}`,
      "high",
    ],
    ["empty directive is ignored", `{"messages":[${directive("max")},${directive("")}]}`, "max"],
    [
      "non-system output_config is ignored",
      `{"messages":[{"role":"user","content":"hi","output_config":{"effort":"high"}}]}`,
      "",
    ],
    [
      "disabled thinking ignores directives",
      `{"thinking":{"type":"disabled"},"messages":[${directive("high")}]}`,
      "",
    ],
    [
      "between_tools thinking ignores directives",
      `{"thinking":{"type":"between_tools"},"messages":[${directive("high")}]}`,
      "",
    ],
  ])("%s", (_name, body, want) => {
    expect(claudeEffortDirective(parse(body))).toBe(want);
  });

  const directives = `"messages":[${directive("low")},${user},${directive("high")}]`;

  it.each([
    [
      "directive overrides top-level placeholder",
      `{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"},${directives}}`,
      "high",
    ],
    [
      "last non-empty directive wins and is normalized",
      `{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"},"messages":[${directive("medium")},${user},${directive(" HIGH ")},${directive("   ")}]}`,
      "high",
    ],
    [
      "non-system output_config does not override top-level effort",
      `{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"},"messages":[{"role":"user","content":"hi","output_config":{"effort":"high"}}]}`,
      "low",
    ],
    [
      "top-level effort without directives",
      `{"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"},"messages":[${user}]}`,
      "medium",
    ],
    ["disabled thinking stays none", `{"thinking":{"type":"disabled"},${directives}}`, "none"],
    [
      "between_tools thinking stays none",
      `{"thinking":{"type":"between_tools"},${directives}}`,
      "none",
    ],
  ])("usage effort: %s", (_name, body, want) => {
    expect(extractReasoningEffort(parse(body), "claude", "claude-opus-5-5")).toBe(want);
    expect(extractTranslatedReasoningEffort(parse(body), "claude")).toBe(want);
  });

  it("lets a model suffix win over directives", () => {
    const body = parse(
      `{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"},${directives}}`,
    );

    expect(extractReasoningEffort(body, "claude", "claude-opus-5-5(medium)")).toBe("medium");
  });
});

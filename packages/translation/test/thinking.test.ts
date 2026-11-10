import { describe, expect, it } from "vitest";
import { asInt, asString, cloneJson, get, type Json, tryParseJson } from "@commissary/json";
import {
  applySummaryConfig,
  applySummaryConfigForModel,
  applySummaryConfigForProvider,
  applyThinking,
  type ApplyThinkingOptions,
  extractExplicitSummaryConfig,
  extractReasoningEffort,
  extractSummaryConfig,
  extractTranslatedReasoningEffort,
  type SummaryConfig,
  type SummaryMode,
  type ThinkingModelInfo,
  UNSPECIFIED_SUMMARY,
} from "../src/thinking/index.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { summaryHooks } from "../src/translator/summary-hooks.ts";
import { catalogLookup } from "./support/thinking.ts";

// Ports of the Go unit tests in internal/thinking (summary_test.go, claude_enabled_effort_test.go,
// kimi_max_clamp_repro_test.go, apply_codex_usage_test.go, apply_configured_api_key_test.go).

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const str = (body: Json | undefined, path: string): string => asString(get(body, path));

const exists = (body: Json | undefined, path: string): boolean => get(body, path) !== undefined;

const raw = (body: Json | undefined, path: string): string => JSON.stringify(get(body, path));

const summary = (mode: SummaryMode, detail = ""): SummaryConfig => ({ mode, detail });

/** `ApplyThinking` (registry lookup, default summary) as in Go. */
const applyPlain = (
  body: Json | undefined,
  model: string,
  from: string,
  to: string,
  providerKey: string,
) =>
  applyThinking(body, {
    model,
    fromFormat: from,
    toFormat: to,
    providerKey,
    lookupModelInfo: catalogLookup,
  });

/** `ApplyThinkingWithModelInfo`: summary resolved from the source body when present. */
const applyWithModelInfo = (
  body: Json | undefined,
  source: Json | undefined,
  model: string,
  from: string,
  to: string,
  providerKey: string,
  modelInfo: ThinkingModelInfo | null,
  extra: Partial<ApplyThinkingOptions> = {},
) =>
  applyThinking(body, {
    model,
    fromFormat: from,
    toFormat: to,
    providerKey,
    sourceBody: source,
    modelInfo,
    lookupModelInfo: catalogLookup,
    ...extra,
  });

describe("ExtractSummaryConfig", () => {
  const cases: ReadonlyArray<readonly [string, string, string, SummaryMode, string?]> = [
    ["chat effort enables", "openai", `{"reasoning_effort":"high"}`, "enabled", "auto"],
    ["chat none disables", "openai", `{"reasoning_effort":"none"}`, "disabled"],
    ["chat missing unspecified", "openai", `{}`, "unspecified"],
    ["chat null effort unspecified", "openai", `{"reasoning_effort":null}`, "unspecified"],
    ["chat non-string effort unspecified", "openai", `{"reasoning_effort":17}`, "unspecified"],
    [
      "chat google extension false overrides effort",
      "openai",
      `{"reasoning_effort":"high","extra_body":{"google":{"thinking_config":{"include_thoughts":false}}}}`,
      "disabled",
    ],
    [
      "chat google extension true",
      "openai",
      `{"extra_body":{"google":{"thinking_config":{"include_thoughts":true}}}}`,
      "enabled",
      "auto",
    ],
    [
      "chat exclude disables",
      "openai",
      `{"reasoning_effort":"high","reasoning":{"exclude":true}}`,
      "disabled",
    ],
    [
      "chat exclude false enables",
      "openai",
      `{"reasoning":{"effort":"high","exclude":false}}`,
      "enabled",
      "auto",
    ],
    [
      "chat legacy include_reasoning false disables",
      "openai",
      `{"reasoning_effort":"high","include_reasoning":false}`,
      "disabled",
    ],
    [
      "chat legacy include_reasoning true enables",
      "openai",
      `{"include_reasoning":true}`,
      "enabled",
      "auto",
    ],
    [
      "chat reasoning enabled false disables",
      "openai",
      `{"reasoning":{"enabled":false}}`,
      "disabled",
    ],
    [
      "chat reasoning enabled true enables",
      "openai",
      `{"reasoning":{"enabled":true}}`,
      "enabled",
      "auto",
    ],
    [
      "chat exclude wins over include_reasoning",
      "openai",
      `{"reasoning":{"exclude":true},"include_reasoning":true}`,
      "disabled",
    ],
    [
      "chat non-boolean include_reasoning unspecified",
      "openai",
      `{"include_reasoning":"false"}`,
      "unspecified",
    ],
    [
      "responses effort alone unspecified",
      "openai-response",
      `{"reasoning":{"effort":"high"}}`,
      "unspecified",
    ],
    [
      "responses summary auto",
      "openai-response",
      `{"reasoning":{"effort":"high","summary":"auto"}}`,
      "enabled",
      "auto",
    ],
    [
      "responses summary concise",
      "openai-response",
      `{"reasoning":{"summary":"concise"}}`,
      "enabled",
      "concise",
    ],
    ["responses summary null", "openai-response", `{"reasoning":{"summary":null}}`, "disabled"],
    [
      "responses boolean summary invalid",
      "openai-response",
      `{"reasoning":{"summary":true}}`,
      "unspecified",
    ],
    [
      "responses deprecated generate summary",
      "openai-response",
      `{"reasoning":{"generate_summary":"detailed"}}`,
      "enabled",
      "detailed",
    ],
    [
      "claude summarized",
      "claude",
      `{"thinking":{"type":"adaptive","display":"summarized"}}`,
      "enabled",
      "auto",
    ],
    [
      "claude updates",
      "claude",
      `{"thinking":{"type":"adaptive","display":"updates"}}`,
      "enabled",
      "auto",
    ],
    [
      "claude updates without type is invalid",
      "claude",
      `{"thinking":{"display":"updates"}}`,
      "unspecified",
    ],
    [
      "claude enabled updates without budget is valid",
      "claude",
      `{"thinking":{"type":"enabled","display":"updates"}}`,
      "enabled",
      "auto",
    ],
    [
      "claude enabled updates with zero budget is invalid",
      "claude",
      `{"thinking":{"type":"enabled","budget_tokens":0,"display":"updates"}}`,
      "unspecified",
    ],
    [
      "claude omitted",
      "claude",
      `{"thinking":{"type":"enabled","budget_tokens":2048,"display":"omitted"}}`,
      "disabled",
    ],
    [
      "claude display without type is invalid",
      "claude",
      `{"thinking":{"display":"summarized"}}`,
      "unspecified",
    ],
    [
      "claude display with auto type is invalid",
      "claude",
      `{"thinking":{"type":"auto","display":"summarized"}}`,
      "unspecified",
    ],
    // ApplySummaryConfig runs before ApplyThinking fills budget_tokens, so an absent budget is not inactive thinking.
    [
      "claude enabled display without budget is valid",
      "claude",
      `{"thinking":{"type":"enabled","display":"summarized"}}`,
      "enabled",
      "auto",
    ],
    [
      "claude enabled display with zero budget is invalid",
      "claude",
      `{"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized"}}`,
      "unspecified",
    ],
    [
      "claude auto compatibility budget summarized",
      "claude",
      `{"thinking":{"type":"enabled","budget_tokens":-1,"display":"summarized"}}`,
      "enabled",
      "auto",
    ],
    [
      "claude auto compatibility budget omitted",
      "claude",
      `{"thinking":{"type":"enabled","budget_tokens":-1,"display":"omitted"}}`,
      "disabled",
    ],
    [
      "gemini include true",
      "gemini",
      `{"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}`,
      "enabled",
      "auto",
    ],
    [
      "gemini include false",
      "gemini",
      `{"generationConfig":{"thinkingConfig":{"includeThoughts":false}}}`,
      "disabled",
    ],
    [
      "antigravity include true",
      "antigravity",
      `{"request":{"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}}`,
      "enabled",
      "auto",
    ],
    [
      "interactions auto",
      "interactions",
      `{"generation_config":{"thinking_summaries":"auto"}}`,
      "enabled",
      "auto",
    ],
    [
      "interactions none",
      "interactions",
      `{"generation_config":{"thinking_summaries":"none"}}`,
      "disabled",
    ],
    [
      "interactions nested snake include false",
      "interactions",
      `{"generation_config":{"thinking_config":{"include_thoughts":false}}}`,
      "disabled",
    ],
    [
      "interactions nested camel include true",
      "interactions",
      `{"generation_config":{"thinking_config":{"includeThoughts":true}}}`,
      "enabled",
      "auto",
    ],
    [
      "interactions camel config snake include true",
      "interactions",
      `{"generation_config":{"thinkingConfig":{"include_thoughts":true}}}`,
      "enabled",
      "auto",
    ],
    [
      "interactions camel config camel include false",
      "interactions",
      `{"generation_config":{"thinkingConfig":{"includeThoughts":false}}}`,
      "disabled",
    ],
    [
      "interactions enum wins over compatibility reasoning",
      "interactions",
      `{"generation_config":{"thinking_summaries":"none"},"reasoning":{"summary":"auto"}}`,
      "disabled",
    ],
    [
      "interactions compatibility reasoning auto",
      "interactions",
      `{"reasoning":{"summary":"auto"}}`,
      "enabled",
      "auto",
    ],
    [
      "interactions compatibility reasoning none",
      "interactions",
      `{"reasoning":{"summary":"none"}}`,
      "disabled",
    ],
    [
      "interactions enum wins over include alias",
      "interactions",
      `{"generation_config":{"thinking_summaries":"none","thinking_config":{"include_thoughts":true}}}`,
      "disabled",
    ],
    [
      "interactions string include alias is invalid",
      "interactions",
      `{"generation_config":{"thinking_config":{"include_thoughts":"false"}}}`,
      "unspecified",
    ],
    [
      "interactions detailed is invalid",
      "interactions",
      `{"generation_config":{"thinking_summaries":"detailed"}}`,
      "unspecified",
    ],
    [
      "interactions boolean is invalid",
      "interactions",
      `{"generation_config":{"thinking_summaries":true}}`,
      "unspecified",
    ],
    [
      "gemini string bool is invalid",
      "gemini",
      `{"generationConfig":{"thinkingConfig":{"includeThoughts":"true"}}}`,
      "unspecified",
    ],
  ];

  for (const [name, format, body, mode, detail] of cases) {
    it(name, () => {
      expect(extractSummaryConfig(parse(body), format)).toEqual(summary(mode, detail ?? ""));
    });
  }

  it("does not use Chat effort for explicit extraction", () => {
    expect(extractExplicitSummaryConfig(parse(`{"reasoning_effort":"high"}`), "openai").mode).toBe(
      "unspecified",
    );
    expect(
      extractExplicitSummaryConfig(
        parse(`{"reasoning_effort":"high","reasoning":{"exclude":true}}`),
        "openai",
      ).mode,
    ).toBe("disabled");
  });
});

describe("ApplySummaryConfig", () => {
  const cases: ReadonlyArray<readonly [string, string, string, SummaryConfig, string, string]> = [
    ["chat enabled invents no effort", "openai", `{}`, summary("enabled"), "reasoning_effort", ""],
    [
      "chat enabled preserves active effort",
      "openai",
      `{"reasoning_effort":"high"}`,
      summary("enabled"),
      "reasoning_effort",
      "high",
    ],
    [
      "chat enabled preserves disabled effort",
      "openai",
      `{"reasoning_effort":"none"}`,
      summary("enabled"),
      "reasoning_effort",
      "none",
    ],
    // Chat cannot express "reason but hide": disabling must not fall back to reasoning_effort "none".
    [
      "chat disabled preserves requested effort",
      "openai",
      `{"reasoning_effort":"high"}`,
      summary("disabled"),
      "reasoning_effort",
      "high",
    ],
    [
      "chat disabled sets openrouter exclude when present",
      "openai",
      `{"reasoning":{"effort":"high","exclude":false}}`,
      summary("disabled"),
      "reasoning.exclude",
      "true",
    ],
    [
      "chat enabled clears openrouter exclude when present",
      "openai",
      `{"reasoning":{"effort":"high","exclude":true}}`,
      summary("enabled"),
      "reasoning.exclude",
      "false",
    ],
    [
      "chat disabled updates legacy include_reasoning when present",
      "openai",
      `{"reasoning_effort":"high","include_reasoning":true}`,
      summary("disabled"),
      "include_reasoning",
      "false",
    ],
    [
      "chat disabled invents no openrouter field",
      "openai",
      `{"reasoning_effort":"high"}`,
      summary("disabled"),
      "reasoning",
      "",
    ],
    [
      "claude enabled",
      "claude",
      `{"thinking":{"type":"adaptive"}}`,
      summary("enabled"),
      "thinking.display",
      "summarized",
    ],
    [
      "claude enabled preserves existing updates",
      "claude",
      `{"thinking":{"type":"adaptive","display":"updates"}}`,
      summary("enabled"),
      "thinking.display",
      "updates",
    ],
    [
      "claude disabled",
      "claude",
      `{"thinking":{"type":"enabled","budget_tokens":2048}}`,
      summary("disabled"),
      "thinking.display",
      "omitted",
    ],
    [
      "claude disabled overrides existing updates",
      "claude",
      `{"thinking":{"type":"adaptive","display":"updates"}}`,
      summary("disabled"),
      "thinking.display",
      "omitted",
    ],
    [
      "gemini enabled",
      "gemini",
      `{}`,
      summary("enabled"),
      "generationConfig.thinkingConfig.includeThoughts",
      "true",
    ],
    [
      "gemini disabled",
      "gemini",
      `{}`,
      summary("disabled"),
      "generationConfig.thinkingConfig.includeThoughts",
      "false",
    ],
    [
      "antigravity enabled",
      "antigravity",
      `{}`,
      summary("enabled"),
      "request.generationConfig.thinkingConfig.includeThoughts",
      "true",
    ],
    [
      "interactions detail collapses to auto",
      "interactions",
      `{}`,
      summary("enabled", "detailed"),
      "generation_config.thinking_summaries",
      "auto",
    ],
    [
      "interactions disabled",
      "interactions",
      `{}`,
      summary("disabled"),
      "generation_config.thinking_summaries",
      "none",
    ],
    [
      "responses concise",
      "openai-response",
      `{}`,
      summary("enabled", "concise"),
      "reasoning.summary",
      "concise",
    ],
  ];

  for (const [name, format, body, config, path, want] of cases) {
    it(name, () => {
      expect(str(applySummaryConfig(parse(body), format, config), path)).toBe(want);
    });
  }

  describe("OpenAI Chat provider dialects", () => {
    const dialects: ReadonlyArray<
      readonly [string, string, string, SummaryMode, string, boolean, string]
    > = [
      ["OpenAI does not invent visibility", "openai", `{}`, "enabled", "", false, ""],
      ["OpenRouter enables visibility", "openrouter", `{}`, "enabled", "false", true, ""],
      ["OpenRouter disables visibility", "prod-openrouter", `{}`, "disabled", "true", true, ""],
      [
        "DeepSeek preserves documented effort",
        "deepseek",
        `{"reasoning_effort":"high"}`,
        "disabled",
        "",
        false,
        "high",
      ],
      [
        "Kimi preserves documented K3 effort",
        "kimi",
        `{"reasoning_effort":"max"}`,
        "enabled",
        "",
        false,
        "max",
      ],
      [
        "Moonshot does not invent visibility",
        "moonshot",
        `{"thinking":{"type":"enabled"}}`,
        "enabled",
        "",
        false,
        "",
      ],
      [
        "generic provider updates existing OpenRouter field",
        "openai-compatibility",
        `{"reasoning":{"exclude":false}}`,
        "disabled",
        "true",
        true,
        "",
      ],
    ];

    for (const [name, provider, body, mode, wantExclude, wantExisting, wantEffort] of dialects) {
      it(name, () => {
        const out = applySummaryConfigForProvider(
          parse(body),
          "openai",
          "model",
          provider,
          undefined,
          summary(mode),
        );

        expect(exists(out, "reasoning.exclude")).toBe(wantExisting);

        if (wantExisting) expect(str(out, "reasoning.exclude")).toBe(wantExclude);

        if (wantEffort === "") expect(exists(out, "reasoning_effort")).toBe(false);
        else expect(str(out, "reasoning_effort")).toBe(wantEffort);
      });
    }
  });

  it("normalizes target aliases", () => {
    const aliasCases: ReadonlyArray<readonly [string, string, string, string]> = [
      [
        "gemini",
        `{"generationConfig":{"thinkingConfig":{"include_thoughts":true}}}`,
        "generationConfig.thinkingConfig.includeThoughts",
        "generationConfig.thinkingConfig.include_thoughts",
      ],
      [
        "antigravity",
        `{"request":{"generationConfig":{"thinkingConfig":{"include_thoughts":true}}}}`,
        "request.generationConfig.thinkingConfig.includeThoughts",
        "request.generationConfig.thinkingConfig.include_thoughts",
      ],
      [
        "interactions",
        `{"generation_config":{"thinkingSummaries":"auto"}}`,
        "generation_config.thinking_summaries",
        "generation_config.thinkingSummaries",
      ],
    ];

    for (const [format, body, canonical, alias] of aliasCases) {
      const out = applySummaryConfig(parse(body), format, summary("enabled"));
      expect(exists(out, canonical), `${format} canonical`).toBe(true);
      expect(exists(out, alias), `${format} alias`).toBe(false);
    }
  });

  // Anthropic rejects display on a disabled block and requires thinking.type, so display is only written for
  // already-active thinking.
  it("never writes Claude display without active thinking", () => {
    const bodies = [
      `{}`,
      `{"messages":[{"role":"user","content":"hi"}]}`,
      `{"thinking":{"type":"disabled"}}`,
    ];

    for (const mode of ["enabled", "disabled"] as const) {
      for (const body of bodies) {
        const out = applySummaryConfig(parse(body), "claude", summary(mode));
        expect(exists(out, "thinking.display")).toBe(false);
        expect(out).toEqual(parse(body));
      }
    }
  });

  describe("ForModel: Claude enabled summary activates a valid thinking mode", () => {
    const modelCases = [
      {
        name: "adaptive model",
        model: "claude-opus-5",
        body: `{"model":"claude-opus-5","max_tokens":32000}`,
        type: "adaptive",
        budget: 0,
      },
      {
        name: "manual model",
        model: "claude-haiku-4-5-20251001",
        body: `{"model":"claude-haiku-4-5-20251001","max_tokens":32000}`,
        type: "enabled",
        budget: 1024,
      },
    ];

    for (const c of modelCases) {
      it(c.name, () => {
        const out = applySummaryConfigForModel(
          parse(c.body),
          "claude",
          c.model,
          summary("enabled"),
          catalogLookup,
        );

        expect(str(out, "thinking.type")).toBe(c.type);
        expect(str(out, "thinking.display")).toBe("summarized");

        if (c.budget > 0) expect(asInt(get(out, "thinking.budget_tokens"))).toBe(c.budget);
      });
    }
  });

  // Disabling summaries must not add a Claude thinking block: absence preserves the per-model default.
  it("ForModel: a disabled Claude summary does not enable thinking", () => {
    for (const model of ["claude-opus-5", "claude-haiku-4-5-20251001"]) {
      const body = parse(`{"model":"${model}","max_tokens":32000}`);

      const out = applySummaryConfigForModel(
        body,
        "claude",
        model,
        summary("disabled"),
        catalogLookup,
      );

      expect(exists(out, "thinking")).toBe(false);
    }
  });

  it("normalizes the deprecated Responses generate_summary", () => {
    const out = applySummaryConfig(
      parse(`{"reasoning":{"generate_summary":"detailed"}}`),
      "openai-response",
      summary("enabled", "detailed"),
    );

    expect(str(out, "reasoning.summary")).toBe("detailed");
    expect(exists(out, "reasoning.generate_summary")).toBe(false);
  });

  it("omits the Responses summary when disabled", () => {
    const out = applySummaryConfig(
      parse(`{"reasoning":{"effort":"high","summary":"auto"}}`),
      "openai-response",
      summary("disabled"),
    );

    expect(exists(out, "reasoning.summary")).toBe(false);
    expect(str(out, "reasoning.effort")).toBe("high");
  });

  it("drops an emptied Responses reasoning object", () => {
    const out = applySummaryConfig(
      parse(`{"model":"gpt-5.4","reasoning":{"summary":"auto"}}`),
      "openai-response",
      summary("disabled"),
    );

    expect(exists(out, "reasoning")).toBe(false);
  });

  it("leaves the body unchanged for an unspecified summary", () => {
    const body = parse(`{"thinking":{"type":"adaptive"}}`);
    expect(applySummaryConfig(body, "claude", UNSPECIFIED_SUMMARY)).toEqual(
      parse(`{"thinking":{"type":"adaptive"}}`),
    );
  });
});

describe("Claude enabled with output_config.effort routed to OpenAI", () => {
  const model = `"model":"custom-openai","messages":[{"role":"user","content":"hi"}]`;

  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      "explicit output_config effort is preserved without budget",
      `{${model},"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`,
      "high",
    ],
    [
      "legacy budget remains authoritative when both are present",
      `{${model},"thinking":{"type":"enabled","budget_tokens":8192},"output_config":{"effort":"high"}}`,
      "medium",
    ],
    [
      "enabled without budget or effort keeps auto default",
      `{${model},"thinking":{"type":"enabled"}}`,
      "auto",
    ],
    [
      "enabled with empty effort string falls back to auto",
      `{${model},"thinking":{"type":"enabled"},"output_config":{"effort":""}}`,
      "auto",
    ],
    [
      "enabled with whitespace-only effort falls back to auto",
      `{${model},"thinking":{"type":"enabled"},"output_config":{"effort":"   "}}`,
      "auto",
    ],
    [
      "enabled with non-string effort falls back to auto",
      `{${model},"thinking":{"type":"enabled"},"output_config":{"effort":123}}`,
      "auto",
    ],
  ];

  for (const [name, body, want] of cases) {
    it(name, () => {
      const result = applyPlain(parse(body), "custom-openai", "claude", "openai", "openai");
      expect(result.error).toBeUndefined();
      expect(str(result.body, "reasoning_effort")).toBe(want);
    });
  }

  it("keeps the effort when applied after translation with the source request", () => {
    // Go chains openaiclaude.ConvertClaudeRequestToOpenAI first; its output carries reasoning_effort "high".
    const source = parse(
      `{${model},"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`,
    );

    const translated = parse(`{${model},"reasoning_effort":"high"}`);

    const result = applyThinking(translated, {
      model: "custom-openai",
      fromFormat: "claude",
      toFormat: "openai",
      providerKey: "openai",
      sourceBody: source,
      summaryConfig: UNSPECIFIED_SUMMARY,
      lookupModelInfo: catalogLookup,
    });

    expect(result.error).toBeUndefined();
    expect(str(result.body, "reasoning_effort")).toBe("high");
  });
});

const kimiBody = (effort: string) =>
  parse(
    `{"model":"kimi","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"adaptive"},"output_config":{"effort":"${effort}"}}`,
  );

describe("Kimi through the Claude protocol", () => {
  it("K2.8 preserves effort=max because its levels include max", () => {
    const result = applyPlain(kimiBody("max"), "kimi-k2.8", "claude", "claude", "claude");
    expect(result.error).toBeUndefined();
    expect(str(result.body, "output_config.effort")).toBe("max");
  });

  it("K2.5 clamps effort=max to high", () => {
    const result = applyPlain(kimiBody("max"), "kimi-k2.5", "claude", "claude", "claude");
    expect(result.error).toBeUndefined();
    expect(str(result.body, "thinking.type")).toBe("adaptive");
    expect(str(result.body, "output_config.effort")).toBe("high");
  });
});

describe("Codex reasoning effort and configuration_update", () => {
  const astra = `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`;

  const cases: ReadonlyArray<readonly [string, string, string, string, string, string]> = [
    [
      "codex extracts configuration_update effort over top-level",
      "codex",
      "gpt-6-astra",
      astra,
      "low",
      "low",
    ],
    [
      "openai-response extracts configuration_update effort over top-level",
      "openai-response",
      "gpt-6-astra",
      astra,
      "low",
      "low",
    ],
    [
      "codex picks latest configuration_update when multiple are present",
      "codex",
      "gpt-6-astra",
      `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"second turn"},{"type":"configuration_update","reasoning":{"effort":"medium"}}]}`,
      "medium",
      "medium",
    ],
    [
      "codex falls back to top-level when configuration_update has no reasoning effort",
      "codex",
      "gpt-6-astra",
      `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","tools":[]}]}`,
      "xhigh",
      "xhigh",
    ],
    [
      "codex handles configuration_update effort none",
      "codex",
      "gpt-6-astra",
      `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"none"}}]}`,
      "none",
      "none",
    ],
    [
      "codex handles configuration_update effort auto",
      "codex",
      "gpt-6-astra",
      `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"auto"}}]}`,
      "auto",
      "auto",
    ],
    [
      "trailing configuration_update without reasoning effort preserves earlier effort",
      "codex",
      "gpt-6-astra",
      `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","tools":[]}]}`,
      "low",
      "low",
    ],
    [
      "codex falls back to top-level when input has no configuration_update",
      "codex",
      "gpt-6-astra",
      `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"role":"user","content":"hello"}]}`,
      "xhigh",
      "xhigh",
    ],
    [
      "source configuration_update takes precedence over suffix for request effort",
      "codex",
      "gpt-6-astra(high)",
      `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`,
      "low",
      "low",
    ],
    [
      "suffix takes precedence over top-level without updates",
      "openai-response",
      "gpt-6-astra(high)",
      `{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","tools":[]}]}`,
      "high",
      "xhigh",
    ],
  ];

  for (const [name, provider, model, body, wantRequest, wantTranslated] of cases) {
    it(name, () => {
      expect(extractReasoningEffort(parse(body), provider, model)).toBe(wantRequest);
      expect(extractTranslatedReasoningEffort(parse(body), provider)).toBe(wantTranslated);
    });
  }

  it("an invalid body returns an empty effort", () => {
    expect(extractReasoningEffort(undefined, "codex", "gpt-6-astra")).toBe("");
    expect(extractTranslatedReasoningEffort(undefined, "codex")).toBe("");
  });

  describe("target routing", () => {
    const source = `{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"medium"}},{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","reasoning":{"effort":null}},{"role":"user","content":"ok"}]}`;

    for (const supported of [true, false]) {
      it(supported ? "supported" : "unsupported", () => {
        const info: ThinkingModelInfo = {
          id: "opaque-route",
          type: "codex",
          supportConfigurationUpdate: supported,
          thinking: { levels: ["low", "high", "xhigh"] },
        };

        const result = applyWithModelInfo(
          parse(source),
          parse(source),
          "opaque-route(high)",
          "openai-response",
          "codex",
          "codex",
          info,
          {
            summaryConfig: UNSPECIFIED_SUMMARY,
          },
        );

        expect(result.error).toBeUndefined();
        expect(extractReasoningEffort(parse(source), "openai-response", "opaque-route(high)")).toBe(
          "low",
        );
        expect(extractTranslatedReasoningEffort(result.body, "codex")).toBe(
          supported ? "low" : "high",
        );
        expect(str(result.body, "reasoning.effort")).toBe("high");
        expect(str(result.body, "input.0.type") === "configuration_update").toBe(supported);
      });
    }
  });
});

describe("configuration_update routing", () => {
  const update = `{"type":"configuration_update","reasoning":{"effort":"low"}}`;
  const user = `{"role":"user","content":"ok"}`;

  const cases: ReadonlyArray<{
    name: string;
    body: string;
    format?: string;
    suffix?: string;
    supported?: boolean;
    noThinking?: boolean;
    wantEffort?: string;
    wantInput?: string;
    wantSame?: boolean;
    skipEffort?: boolean;
  }> = [
    {
      name: "supported native request preserves baseline and updates",
      body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[${update},${user}]}`,
      supported: true,
      wantEffort: "xhigh",
      wantInput: `[${update},${user}]`,
      wantSame: true,
    },
    {
      name: "supported no-effort request remains unchanged",
      body: `{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","tools":[]},${user}]}`,
      supported: true,
      wantInput: `[{"type":"configuration_update","tools":[]},${user}]`,
      wantSame: true,
    },
    {
      name: "supported native request without thinking metadata preserves baseline summary and updates",
      body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[${update},${user}]}`,
      supported: true,
      noThinking: true,
      wantEffort: "xhigh",
      wantInput: `[${update},${user}]`,
      wantSame: true,
    },
    {
      name: "supported native suffix still strips effort without thinking metadata",
      body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[${update},${user}]}`,
      supported: true,
      noThinking: true,
      suffix: "high",
      wantInput: `[${update},${user}]`,
    },
    {
      name: "supported suffix only rewrites the top-level effort",
      body: `{"reasoning":{"effort":"xhigh","summary":"auto","other":7},"input":[${update},${user}]}`,
      supported: true,
      suffix: "high",
      wantEffort: "high",
      wantInput: `[${update},${user}]`,
    },
    {
      name: "supported suffix keeps effective input effort for current turn",
      body: `{"reasoning":{"summary":"auto"},"input":[${update},${user}]}`,
      supported: true,
      suffix: "high",
      wantEffort: "high",
      wantInput: `[${update},${user}]`,
    },
    {
      name: "supported invalid suffix leaves native payload untouched",
      body: `{"reasoning":{"generate_summary":"auto"},"input":[${update},${user}]}`,
      supported: true,
      suffix: "invalid",
      wantInput: `[${update},${user}]`,
      wantSame: true,
    },
    {
      name: "unsupported latest nonempty update wins and other input order stays unchanged",
      body: `{"reasoning":{"effort":"xhigh","summary":"auto","other":7},"input":[{"role":"user","content":"first"},${update},{"type":"configuration_update","reasoning":{"effort":"  "}},{"role":"assistant","content":"reply"},{"type":"configuration_update","reasoning":{"effort":"medium"}},{"type":"configuration_update","tools":[]},{"role":"user","content":"last"}]}`,
      wantEffort: "medium",
      wantInput: `[{"role":"user","content":"first"},{"role":"assistant","content":"reply"},{"role":"user","content":"last"}]`,
    },
    {
      name: "unsupported ignores empty and nonstring efforts",
      body: `{"reasoning":{"summary":"auto"},"input":[${update},{"type":"configuration_update","reasoning":{"effort":42}},{"type":"configuration_update","reasoning":{"effort":null}},{"type":"configuration_update","reasoning":{"effort":"  "}},${user}]}`,
      wantEffort: "low",
      wantInput: `[${user}]`,
    },
    {
      name: "unsupported suffix takes precedence and still removes updates",
      body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[${update},${user}]}`,
      suffix: "high",
      wantEffort: "high",
      wantInput: `[${user}]`,
    },
    {
      name: "unsupported without top-level reasoning promotes the last update",
      body: `{"input":[${update},${user}]}`,
      wantEffort: "low",
      wantInput: `[${user}]`,
    },
    {
      name: "unsupported removes updates with no effort without inventing one",
      body: `{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","tools":[]},${user}]}`,
      wantEffort: "",
      wantInput: `[${user}]`,
    },
    {
      name: "unsupported without thinking support still removes updates",
      body: `{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","tools":[]},${user}]}`,
      noThinking: true,
      wantInput: `[${user}]`,
    },
    {
      name: "unsupported without thinking support strips effort but keeps summary",
      body: `{"reasoning":{"effort":"xhigh","summary":"auto","other":7},"input":[${update},${user}]}`,
      noThinking: true,
      wantInput: `[${user}]`,
    },
    {
      name: "unsupported openai-response alias removes updates",
      body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[${update},${user}]}`,
      format: "openai-response",
      wantEffort: "low",
      wantInput: `[${user}]`,
    },
    {
      name: "nonarray input is untouched",
      body: `{"reasoning":{"summary":"auto"},"input":{"type":"configuration_update","reasoning":{"effort":"low"}}}`,
      wantInput: `{"type":"configuration_update","reasoning":{"effort":"low"}}`,
      wantSame: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const format = c.format ?? "codex";

      const info: ThinkingModelInfo = {
        id: "configured-responses",
        type: "codex",
        supportConfigurationUpdate: c.supported === true,
        thinking:
          c.noThinking === true ? undefined : { levels: ["low", "medium", "high", "xhigh"] },
      };

      const body = parse(c.body);
      const original = cloneJson(body);
      const suffix = c.suffix === undefined ? "" : `(${c.suffix})`;

      // Go passes the same bytes as body and source; the port clones an aliased source.
      const result = applyWithModelInfo(
        body,
        body,
        `configured-responses${suffix}`,
        format,
        format,
        "codex",
        info,
      );

      expect(result.error).toBeUndefined();
      const applied = result.body;

      if (c.wantSame === true) expect(applied).toEqual(original);
      expect(str(applied, "reasoning.effort")).toBe(c.wantEffort ?? "");

      if (c.wantInput !== undefined) expect(raw(applied, "input")).toBe(c.wantInput);

      if (exists(original, "reasoning.summary"))
        expect(str(applied, "reasoning.summary")).toBe("auto");

      if (exists(original, "reasoning.other"))
        expect(asInt(get(applied, "reasoning.other"))).toBe(7);

      if (
        c.supported === true &&
        c.suffix !== undefined &&
        c.suffix !== "invalid" &&
        c.noThinking !== true
      ) {
        expect(extractTranslatedReasoningEffort(applied, format)).toBe("low");
      }
    });
  }

  it("an invalid body is untouched", () => {
    const info: ThinkingModelInfo = {
      id: "configured-responses",
      type: "codex",
      thinking: { levels: ["low", "high"] },
    };

    const result = applyWithModelInfo(
      undefined,
      undefined,
      "configured-responses",
      "codex",
      "codex",
      "codex",
      info,
    );

    expect(result.body).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("native Responses requests keep their body, baseline and in-turn updates (registry lookup and bound model)", () => {
    const bodies = [
      {
        body: `{"model":"gpt-6-sol","reasoning":{"effort":"high","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}},{"role":"user","content":"ok"}]}`,
        effort: "xhigh",
      },
      {
        body: `{"model":"gpt-6-sol","reasoning":{"effort":"high"},"input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}},{"type":"configuration_update","reasoning":{"effort":"max"}}]}`,
        effort: "max",
      },
      {
        body: `{"model":"gpt-6-sol","reasoning":{"effort":"high"},"input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}},{"type":"configuration_update","reasoning":{"effort":null}},{"type":"configuration_update","reasoning":{"effort":42}},{"type":"configuration_update","reasoning":{"effort":"  "}}]}`,
        effort: "xhigh",
      },
      {
        body: `{"model":"gpt-6-sol","reasoning":{"effort":"high"},"input":[{"role":"user","content":"ok"}]}`,
        effort: "high",
      },
      {
        body: `{"model":"gpt-6-sol","input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}}]}`,
        effort: "xhigh",
      },
      {
        body: `{"model":"gpt-6-sol","reasoning":{"effort":"high"},"input":[{"type":"configuration_update","reasoning":{"effort":"none"}}]}`,
        effort: "none",
      },
    ];

    for (const c of bodies) {
      for (const bound of [false, true]) {
        const body = parse(c.body);
        const original = cloneJson(body);
        const info = catalogLookup("gpt-6-sol", "codex");
        expect(
          info?.supportConfigurationUpdate,
          "gpt-6-sol must support configuration updates",
        ).toBe(true);

        const result = bound
          ? applyWithModelInfo(body, body, "gpt-6-sol", "codex", "codex", "codex", info ?? null)
          : applyPlain(body, "gpt-6-sol", "codex", "codex", "codex");

        expect(result.error).toBeUndefined();
        expect(result.body).toEqual(original);
        expect(extractTranslatedReasoningEffort(result.body, "codex")).toBe(c.effort);
      }
    }
  });

  it("preserves the Codex top-level baseline effort (prompt cache prefix)", () => {
    const body = parse(
      `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`,
    );

    const result = applyPlain(body, "gpt-6-astra", "codex", "codex", "codex");
    expect(result.error).toBeUndefined();
    expect(str(result.body, "reasoning.effort")).toBe("xhigh");
    expect(str(result.body, "reasoning.summary")).toBe("auto");
    expect(str(result.body, "input.0.reasoning.effort")).toBe("low");
    expect(extractTranslatedReasoningEffort(result.body, "codex")).toBe("low");
  });
});

describe("configured provider-key model definitions", () => {
  it("maps cross-family xhigh/max intent to a supported level", () => {
    const cases: ReadonlyArray<readonly [string, string, string[], string]> = [
      ["xhigh stays xhigh", "xhigh", ["high", "max", "xhigh"], "xhigh"],
      ["xhigh prefers max", "xhigh", ["high", "max"], "max"],
      ["xhigh falls back to high", "xhigh", ["high"], "high"],
      ["max stays max", "max", ["high", "xhigh", "max"], "max"],
      ["max prefers xhigh", "max", ["high", "xhigh"], "xhigh"],
      ["max falls back to high", "max", ["high"], "high"],
    ];

    for (const [name, source, levels, want] of cases) {
      const info: ThinkingModelInfo = {
        id: "claude-upstream",
        type: "claude",
        thinking: { levels },
      };

      const result = applyWithModelInfo(
        parse(`{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`),
        parse(`{"reasoning_effort":"${source}"}`),
        "claude-upstream",
        "openai",
        "claude",
        "claude",
        info,
      );

      expect(result.error, name).toBeUndefined();
      expect(str(result.body, "output_config.effort"), name).toBe(want);
    }
  });

  it("maps OpenAI-compatibility high intent", () => {
    const info: ThinkingModelInfo = {
      id: "compat-upstream",
      type: "openai-compatibility",
      thinking: { levels: ["high", "max"] },
    };

    const result = applyWithModelInfo(
      parse(`{"reasoning_effort":"high"}`),
      parse(`{"reasoning_effort":"xhigh"}`),
      "compat-upstream",
      "openai",
      "openai",
      "compat-provider",
      info,
    );

    expect(str(result.body, "reasoning_effort")).toBe("max");
  });

  it("maps Responses to Codex high intent", () => {
    const info: ThinkingModelInfo = {
      id: "codex-upstream",
      type: "codex",
      thinking: { levels: ["high", "xhigh"] },
    };

    const result = applyWithModelInfo(
      parse(`{"reasoning":{"effort":"high"}}`),
      parse(`{"reasoning":{"effort":"max"}}`),
      "codex-upstream",
      "openai-response",
      "codex",
      "codex",
      info,
    );

    expect(str(result.body, "reasoning.effort")).toBe("xhigh");
  });

  it("keeps same-family validation strict", () => {
    const info: ThinkingModelInfo = {
      id: "openai-upstream",
      type: "openai",
      thinking: { levels: ["low", "medium", "high"] },
    };

    const body = parse(`{"reasoning_effort":"xhigh"}`);

    const result = applyWithModelInfo(
      body,
      cloneJson(body),
      "openai-upstream",
      "openai",
      "openai",
      "openai",
      info,
    );

    expect(result.error?.code).toBe("LEVEL_NOT_SUPPORTED");
    expect(result.error?.statusCode).toBe(400);
    expect(result.error?.message).toBe(
      `level "xhigh" not supported, valid levels: low, medium, high`,
    );
  });

  it("applies enabled summary-only Claude visibility", () => {
    const info: ThinkingModelInfo = {
      id: "private-claude",
      type: "claude",
      thinking: { levels: ["high"] },
    };

    const result = applyWithModelInfo(
      parse(`{"model":"private-claude","max_tokens":32000}`),
      parse(`{"reasoning":{"summary":"auto"}}`),
      "private-claude",
      "openai-response",
      "claude",
      "claude",
      info,
    );

    expect(str(result.body, "thinking.type")).toBe("adaptive");
    expect(str(result.body, "thinking.display")).toBe("summarized");
  });

  it("drops an inferred Claude mode when the summary was removed", () => {
    const info: ThinkingModelInfo = {
      id: "private-manual-claude",
      type: "claude",
      thinking: { min: 1024, max: 16000 },
    };

    const result = applyWithModelInfo(
      parse(`{"model":"private-manual-claude","max_tokens":32000,"thinking":{"type":"adaptive"}}`),
      parse(`{"reasoning":{"summary":"auto"}}`),
      "private-manual-claude",
      "openai-response",
      "claude",
      "claude",
      info,
      { summaryConfig: UNSPECIFIED_SUMMARY },
    );

    expect(exists(result.body, "thinking")).toBe(false);
  });

  it("does not activate Claude for a disabled summary", () => {
    const info: ThinkingModelInfo = {
      id: "private-claude",
      type: "claude",
      thinking: { levels: ["high"] },
    };

    const result = applyWithModelInfo(
      parse(`{"model":"private-claude","max_tokens":32000}`),
      parse(`{"reasoning":{"summary":null}}`),
      "private-claude",
      "openai-response",
      "claude",
      "claude",
      info,
    );

    expect(exists(result.body, "thinking")).toBe(false);
  });

  it("summary-only requests do not invent OpenAI effort", () => {
    const info: ThinkingModelInfo = {
      id: "private-openai",
      type: "openai",
      thinking: { levels: ["high", "max"] },
    };

    const result = applyWithModelInfo(
      parse(`{"model":"private-openai","messages":[{"role":"user","content":"hi"}]}`),
      parse(`{"model":"private-openai","reasoning":{"summary":"auto"},"input":"hi"}`),
      "private-openai",
      "openai-response",
      "openai",
      "openai",
      info,
    );

    expect(result.error).toBeUndefined();
    expect(exists(result.body, "reasoning_effort")).toBe(false);
  });

  it("keeps the OpenAI Chat suffix none with an explicit summary", () => {
    const result = applyThinking(
      parse(`{"model":"private-openai","messages":[{"role":"user","content":"hi"}]}`),
      {
        model: "private-openai(none)",
        fromFormat: "openai-response",
        toFormat: "openai",
        providerKey: "openai",
        summaryConfig: summary("enabled", "auto"),
        lookupModelInfo: catalogLookup,
      },
    );

    expect(result.error).toBeUndefined();
    expect(str(result.body, "reasoning_effort")).toBe("none");
  });

  it("uses OpenRouter visibility", () => {
    const info: ThinkingModelInfo = {
      id: "openrouter-model",
      type: "openai-compatibility",
      thinking: { levels: ["high", "max"] },
    };

    const result = applyWithModelInfo(
      parse(`{"model":"openrouter-model","messages":[{"role":"user","content":"hi"}]}`),
      parse(`{"model":"openrouter-model","reasoning":{"summary":"auto"},"input":"hi"}`),
      "openrouter-model",
      "openai-response",
      "openai",
      "openrouter",
      info,
    );

    expect(get(result.body, "reasoning.exclude")).toBe(false);
    expect(exists(result.body, "reasoning_effort")).toBe(false);
  });

  it("uses the original Responses effort for Claude targets", () => {
    const info: ThinkingModelInfo = {
      id: "claude-upstream",
      type: "claude",
      thinking: { levels: ["high", "max"] },
    };

    const result = applyWithModelInfo(
      parse(`{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`),
      parse(`{"reasoning":{"effort":"xhigh"}}`),
      "claude-upstream",
      "openai-response",
      "claude",
      "claude",
      info,
    );

    expect(str(result.body, "output_config.effort")).toBe("max");
  });

  describe("configuration_update across protocols", () => {
    const source = `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"},{"type":"configuration_update","reasoning":{"effort":"high"}}]}`;

    const cases = [
      {
        name: "unsupported Responses source becomes OpenAI Chat effort",
        body: `{"messages":[{"role":"user","content":"ok"}],"reasoning_effort":"medium","other":true}`,
        model: "private-chat",
        format: "openai",
        type: "openai",
        supported: false,
        path: "reasoning_effort",
        want: "high",
      },
      {
        name: "supported updates cannot be sent to OpenAI Chat",
        body: `{"messages":[{"role":"user","content":"ok"}],"reasoning_effort":"medium","other":true}`,
        model: "private-chat",
        format: "openai",
        type: "openai",
        supported: true,
        path: "reasoning_effort",
        want: "high",
      },
      {
        name: "Responses source becomes Claude effort",
        body: `{"max_tokens":4096,"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"},"other":true}`,
        model: "private-claude",
        format: "claude",
        type: "claude",
        supported: false,
        path: "output_config.effort",
        want: "high",
      },
      {
        name: "model suffix overrides source updates",
        body: `{"messages":[{"role":"user","content":"ok"}],"reasoning_effort":"medium","other":true}`,
        model: "private-chat(low)",
        format: "openai",
        type: "openai",
        supported: false,
        path: "reasoning_effort",
        want: "low",
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const info: ThinkingModelInfo = {
          id: "private",
          type: c.type,
          supportConfigurationUpdate: c.supported,
          thinking: { levels: ["low", "medium", "high", "xhigh"] },
        };

        const result = applyWithModelInfo(
          parse(c.body),
          parse(source),
          c.model,
          "openai-response",
          c.format,
          c.format,
          info,
        );

        expect(result.error).toBeUndefined();
        expect(str(result.body, c.path)).toBe(c.want);
        expect(get(result.body, "other")).toBe(true);
      });
    }
  });

  describe("registry-resolved source entry", () => {
    const source = `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`;
    const target = `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"medium"}},{"role":"user","content":"ok"}]}`;

    const cases = [
      {
        name: "registry capability preserves native Responses without suffix",
        model: "gpt-6-astra",
        body: source,
        format: "codex",
        want: "xhigh",
        wantInput: `[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]`,
        same: true,
      },
      {
        name: "unknown gpt-6 model defaults to unsupported",
        model: "gpt-6-unknown-routed",
        body: source,
        format: "codex",
        want: "low",
        wantInput: `[{"role":"user","content":"ok"}]`,
        same: false,
      },
      {
        name: "source effort controls translated target",
        model: "gpt-6-unknown-routed",
        body: target,
        format: "codex",
        want: "low",
        wantInput: `[{"role":"user","content":"ok"}]`,
        same: false,
      },
      {
        name: "unknown model source update applies to OpenAI Chat",
        model: "gpt-6-unknown-routed",
        body: `{"reasoning_effort":"xhigh","messages":[{"role":"user","content":"ok"}]}`,
        format: "openai",
        want: "low",
        wantInput: undefined,
        same: false,
      },
      {
        name: "nonarray input remains unchanged",
        model: "gpt-6-unknown-routed",
        body: `{"reasoning":{"summary":"auto"},"input":{"type":"configuration_update"}}`,
        format: "codex",
        want: "low",
        wantInput: `{"type":"configuration_update"}`,
        same: false,
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const body = parse(c.body);

        const result = applyThinking(body, {
          model: c.model,
          fromFormat: "openai-response",
          toFormat: c.format,
          providerKey: c.format,
          sourceBody: parse(source),
          summaryConfig: extractSummaryConfig(parse(source), "openai-response"),
          lookupModelInfo: catalogLookup,
        });

        expect(result.error).toBeUndefined();
        expect(
          str(result.body, c.format === "openai" ? "reasoning_effort" : "reasoning.effort"),
        ).toBe(c.want);

        if (c.wantInput !== undefined) expect(raw(result.body, "input")).toBe(c.wantInput);

        if (c.same) expect(result.body).toEqual(parse(c.body));
      });
    }
  });

  describe("invalid targets", () => {
    const updateSource = parse(
      `{"reasoning":{"effort":"medium"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`,
    );

    const info: ThinkingModelInfo = {
      id: "private-codex",
      type: "codex",
      thinking: { levels: ["low", "medium", "high", "xhigh"] },
    };

    const cases = [
      {
        name: "bound model does not rebuild invalid target from source update",
        model: "private-codex",
        source: updateSource,
        bound: true,
        normalized: false,
        want: undefined,
      },
      {
        name: "unbound model does not rebuild invalid target from source update",
        model: "gpt-6-unknown-routed",
        source: updateSource,
        bound: false,
        normalized: false,
        want: undefined,
      },
      {
        name: "normalized updates cannot rebuild invalid target",
        model: "private-codex",
        source: updateSource,
        bound: true,
        normalized: true,
        want: undefined,
      },
      {
        name: "suffix alone still rebuilds invalid target",
        model: "private-codex(high)",
        source: undefined,
        bound: true,
        normalized: false,
        want: `{"reasoning":{"effort":"high"}}`,
      },
      {
        name: "suffix takes priority over source update for invalid target",
        model: "private-codex(high)",
        source: updateSource,
        bound: true,
        normalized: true,
        want: `{"reasoning":{"effort":"high"}}`,
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const result = applyThinking(undefined, {
          model: c.model,
          fromFormat: "codex",
          toFormat: "codex",
          providerKey: "codex",
          sourceBody: c.source,
          summaryConfig: UNSPECIFIED_SUMMARY,
          normalizedUpdatesChanged: c.normalized,
          lookupModelInfo: catalogLookup,
          ...(c.bound ? { modelInfo: info } : {}),
        });

        expect(result.error).toBeUndefined();
        expect(c.want === undefined ? result.body : JSON.stringify(result.body)).toBe(c.want);
      });
    }
  });

  it("a bound model without info uses no static support; user-defined models keep the source effort", () => {
    const body = `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`;

    const run = (info: ThinkingModelInfo | null, model: string) =>
      applyWithModelInfo(parse(body), parse(body), model, "codex", "codex", "codex", info, {
        summaryConfig: extractSummaryConfig(parse(body), "codex"),
      });

    const unresolved = run(null, "gpt-6-astra");
    expect(str(unresolved.body, "reasoning.effort")).toBe("low");
    expect((get(unresolved.body, "input") as Json[]).length).toBe(1);

    const userDefined = run({ id: "custom", userDefined: true }, "custom");
    expect(str(userDefined.body, "reasoning.effort")).toBe("low");
    expect((get(userDefined.body, "input") as Json[]).length).toBe(1);

    for (const [model, want] of [
      ["custom", "xhigh"],
      ["custom(high)", "high"],
    ] as const) {
      const native = run(
        { id: "custom", userDefined: true, supportConfigurationUpdate: true },
        model,
      );

      expect(native.error).toBeUndefined();
      expect(str(native.body, "reasoning.effort")).toBe(want);
      expect(str(native.body, "input.0.reasoning.effort")).toBe("low");
      expect(str(native.body, "reasoning.summary")).toBe("auto");
    }
  });
});

// ports of internal/thinking tests added with Go 13fdcc5e (thinking.display "updates")
describe("Claude thinking.display updates", () => {
  it("reaches Antigravity as includeThoughts", () => {
    const source = parse(
      `{"model":"gemini-3.8-flash-high","max_tokens":4096,"thinking":{"type":"adaptive","display":"updates"},"messages":[{"role":"user","content":"Hello, think first."}]}`,
    );

    const translated = builtinTranslators.translateRequest(
      "claude",
      "antigravity",
      { format: "claude", model: "gemini-3.8-flash-high", stream: false, body: source },
      summaryHooks,
    );

    expect(get(translated.body, "request.generationConfig.thinkingConfig.includeThoughts")).toBe(
      true,
    );
  });
});

import { describe, expect, it } from "vitest";
import type { Json } from "@commissary/json";
import {
  applySummaryConfig,
  applySummaryConfigForModel,
  applyThinking,
  applyTranslatedSummaryToClaude,
  type ApplyThinkingOptions,
  convertBudgetToLevel,
  convertLevelToBudget,
  extractExplicitSummaryConfig,
  extractReasoningEffort,
  extractSummaryConfig,
  extractTranslatedReasoningEffort,
  extractTranslatedSummaryConfig,
  getProviderApplier,
  getThinkingText,
  hasLevel,
  mapToClaudeEffort,
  parseLevelSuffix,
  parseNumericSuffix,
  parseSpecialSuffix,
  parseSuffix,
  stripThinkingConfig,
  validateConfig,
} from "../src/thinking/index.ts";
import {
  type ApplyFixture,
  bodyKey,
  catalogLookup,
  collectMismatches,
  decodeConfig,
  decodeFullConfig,
  encodeConfig,
  expectedKey,
  fixture,
  type ModelSpec,
  parseBody,
  resolveApplierModel,
} from "./support/thinking.ts";

// Golden cases generated from the real Go internal/thinking by `go run ./tools/fixturegen/thinking`.

const resolveModelInfo = (c: ApplyFixture): ModelSpec | null | undefined =>
  c.modelRef !== undefined ? fixture.synthetic[c.modelRef] : c.modelInfo;

describe("thinking golden fixtures", () => {
  it("covers every applier, validation branch and entry point with enough cases", () => {
    const variants = new Set(fixture.apply.map((c) => c.variant));
    expect([...variants].toSorted()).toEqual([
      "modelInfo",
      "modelInfoSummary",
      "plain",
      "source",
      "summary",
    ]);
    const targets = new Set(fixture.apply.map((c) => c.to));

    for (const target of [
      "claude",
      "gemini",
      "antigravity",
      "interactions",
      "openai",
      "codex",
      "xai",
      "kimi",
    ]) {
      expect(targets.has(target), target).toBe(true);
    }

    const codes = new Set(
      fixture.validate.flatMap((g) =>
        g.cases.flatMap((c) => (c.e === undefined ? [] : [c.e.split(":")[0]])),
      ),
    );

    expect([...codes].toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual([
      "BUDGET_OUT_OF_RANGE",
      "LEVEL_NOT_SUPPORTED",
      "THINKING_NOT_SUPPORTED",
      "UNKNOWN_LEVEL",
    ]);
    expect(fixture.apply.length).toBeGreaterThan(3000);
    expect(fixture.validate.reduce((n, g) => n + g.cases.length, 0)).toBeGreaterThan(5000);
  });

  it("parses suffixes like Go", () => {
    const failures = collectMismatches(fixture.suffix, (c) => {
      const result = parseSuffix(c.input);

      const actual = {
        parsed: [result.modelName, result.hasSuffix, result.rawSuffix],
        numeric: parseNumericSuffix(result.rawSuffix) ?? null,
        special: parseSpecialSuffix(result.rawSuffix) ?? "",
        level: parseLevelSuffix(result.rawSuffix) ?? "",
        effort: extractReasoningEffort(undefined, "openai", c.input),
      };

      const expected = {
        parsed: [c.modelName, c.hasSuffix, c.rawSuffix],
        numeric: c.numericOk ? c.numeric : null,
        special: c.specialOk ? c.special : "",
        level: c.levelOk ? c.level : "",
        effort: c.effort,
      };

      return JSON.stringify(actual) === JSON.stringify(expected)
        ? undefined
        : `${JSON.stringify(c.input)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
    });

    expect(failures).toEqual([]);
  });

  it("converts levels and budgets like Go", () => {
    expect(
      collectMismatches(fixture.convert.levelToBudget, (c) => {
        const budget = convertLevelToBudget(c.level);

        return (budget !== undefined) === c.ok && (budget ?? 0) === c.budget
          ? undefined
          : `level ${c.level}`;
      }),
    ).toEqual([]);
    expect(
      collectMismatches(fixture.convert.budgetToLevel, (c) => {
        const level = convertBudgetToLevel(c.budget);

        return (level !== undefined) === c.ok && (level ?? "") === c.level
          ? undefined
          : `budget ${c.budget}`;
      }),
    ).toEqual([]);
    expect(
      collectMismatches(fixture.convert.claudeEffort, (c) => {
        const effort = mapToClaudeEffort(c.level, c.supportsMax);

        return (effort !== undefined) === c.ok && (effort ?? "") === c.effort
          ? undefined
          : `effort ${c.level}`;
      }),
    ).toEqual([]);
    expect(
      collectMismatches(fixture.convert.hasLevel, (c) =>
        hasLevel(c.levels ?? undefined, c.target) === c.result ? undefined : `hasLevel ${c.target}`,
      ),
    ).toEqual([]);
  });

  describe("ValidateConfig", () => {
    for (const [index, group] of fixture.validate.entries()) {
      it(`model ${group.model?.id ?? "<none>"} (#${index})`, () => {
        const model = group.model ?? undefined;

        const failures = collectMismatches(group.cases, (c) => {
          const result = validateConfig(decodeConfig(c.c), model, c.f, c.t, c.s === true);

          const actual =
            result.error !== undefined
              ? `${result.error.code}: ${result.error.message}`
              : encodeConfig(result.config);

          const expected = c.e ?? c.o;

          return actual === expected
            ? undefined
            : `${c.c} ${c.f}->${c.t} suffix=${c.s === true}: ${actual} != ${expected}`;
        });

        expect(failures).toEqual([]);
      });
    }
  });

  describe("applyThinking", () => {
    const optionsFor = (c: ApplyFixture): ApplyThinkingOptions => {
      const source = c.source === undefined ? undefined : parseBody(c.source);
      const modelInfo = resolveModelInfo(c);

      return {
        model: c.model,
        fromFormat: c.from,
        toFormat: c.to,
        providerKey: c.providerKey,
        lookupModelInfo: catalogLookup,
        ...(c.variant === "source" || c.variant === "modelInfo" || c.variant === "modelInfoSummary"
          ? { sourceBody: source }
          : {}),
        ...(c.summary !== undefined ? { summaryConfig: c.summary } : {}),
        ...(c.normalizedUpdatesChanged === true ? { normalizedUpdatesChanged: true } : {}),
        ...(c.variant === "modelInfo" || c.variant === "modelInfoSummary"
          ? { modelInfo: modelInfo ?? null }
          : {}),
      };
    };

    const run = (c: ApplyFixture): string | undefined => {
      const result = applyThinking(parseBody(c.body), optionsFor(c));
      const expectedBody = c.same === true ? c.body : (c.out ?? "");
      const actual = `${bodyKey(result.body)} ${result.error?.code ?? ""} ${result.error?.message ?? ""}`;
      const expected = `${expectedKey(expectedBody)} ${c.error?.code ?? ""} ${c.error?.message ?? ""}`;

      if (actual === expected) return undefined;

      return `${c.name ?? `${c.variant} ${c.to} ${c.model} from=${c.from}`}\n  in:  ${c.body}\n  got: ${actual}\n  want:${expected}`;
    };

    const byTarget = new Map<string, ApplyFixture[]>();

    for (const c of fixture.apply) {
      const key = `${c.to}:${c.variant}`;
      byTarget.set(key, [...(byTarget.get(key) ?? []), c]);
    }

    for (const [key, cases] of [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      it(`${key} (${cases.length} cases)`, () => {
        expect(collectMismatches(cases, run, 5)).toEqual([]);
      });
    }
  });

  describe("provider appliers (called directly, without validation)", () => {
    const byApplier = new Map<string, (typeof fixture.applier)[number][]>();

    for (const c of fixture.applier)
      byApplier.set(c.applier, [...(byApplier.get(c.applier) ?? []), c]);

    for (const [name, cases] of byApplier) {
      it(`${name} (${cases.length} cases)`, () => {
        const applier = getProviderApplier(name);
        expect(applier, name).toBeDefined();

        const failures = collectMismatches(cases, (c) => {
          const out = applier?.apply(
            parseBody(c.body),
            decodeFullConfig(c.config),
            resolveApplierModel(c.model),
          );

          const expected = expectedKey(c.same === true ? c.body : (c.out ?? ""));

          return bodyKey(out) === expected
            ? undefined
            : `${name} model=${c.model ?? ""} ${c.config} ${c.body}: ${bodyKey(out)} != ${expected}`;
        });

        expect(failures).toEqual([]);
      });
    }
  });

  describe("reasoning summaries", () => {
    it("extracts summary intent", () => {
      const failures = collectMismatches(fixture.summaryExtract, (c) => {
        const body = parseBody(c.body);

        const actual = JSON.stringify([
          extractSummaryConfig(body, c.format),
          extractExplicitSummaryConfig(body, c.format),
          extractTranslatedSummaryConfig(body, c.format, c.target),
        ]);

        const expected = JSON.stringify([c.summary, c.explicit, c.translated]);

        return actual === expected ? undefined : `${c.format} ${c.body}: ${actual} != ${expected}`;
      });

      expect(failures).toEqual([]);
    });

    it("applies summary intent", () => {
      const failures = collectMismatches(fixture.summaryApply, (c) => {
        const body = parseBody(c.body);
        let out: Json | undefined;

        if (c.kind === "plain") out = applySummaryConfig(body, c.format, c.config);
        else if (c.kind === "model")
          out = applySummaryConfigForModel(body, c.format, c.model ?? "", c.config, catalogLookup);
        else
          out = applyTranslatedSummaryToClaude(
            body,
            parseBody(c.source ?? ""),
            c.format,
            c.model ?? "",
            catalogLookup,
          );
        const expected = expectedKey(c.same === true ? c.body : (c.out ?? ""));

        return bodyKey(out) === expected
          ? undefined
          : `${c.kind} ${c.format} ${c.model ?? ""} ${c.body} ${JSON.stringify(c.config)}: ${bodyKey(out)} != ${expected}`;
      });

      expect(failures).toEqual([]);
    });
  });

  it("strips thinking configuration like Go", () => {
    const failures = collectMismatches(fixture.strip, (c) => {
      const out = stripThinkingConfig(parseBody(c.body), c.provider);
      const expected = expectedKey(c.same === true ? c.body : (c.out ?? ""));

      return bodyKey(out) === expected
        ? undefined
        : `${c.provider} ${c.body}: ${bodyKey(out)} != ${expected}`;
    });

    expect(failures).toEqual([]);
  });

  it("extracts thinking text like Go", () => {
    const failures = collectMismatches(fixture.text, (c) =>
      getThinkingText(parseBody(c.part)) === c.text ? undefined : c.part,
    );

    expect(failures).toEqual([]);
  });

  it("extracts reasoning effort for usage reporting like Go", () => {
    const failures = collectMismatches(fixture.usage, (c) => {
      const body = parseBody(c.body);

      const actual = [
        extractReasoningEffort(body, c.provider, c.model),
        extractTranslatedReasoningEffort(body, c.provider),
      ];

      return actual[0] === c.request && actual[1] === c.translated
        ? undefined
        : `${c.provider} ${c.model} ${c.body}: ${JSON.stringify(actual)} != ${JSON.stringify([c.request, c.translated])}`;
    });

    expect(failures).toEqual([]);
  });
});

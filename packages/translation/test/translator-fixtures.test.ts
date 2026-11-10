// Golden translator fixtures generated from the Go registry by `go run ./tools/fixturegen/translator`.
// Every file under test/fixtures/translator is picked up automatically; provider slices only add corpus files. The
// executor-rewrite cases are Models' (packages/models/test/unit/translator-executor-fixtures.test.ts).
import { describe, expect, it } from "vitest";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { setModelInfoLookup } from "../src/translator/model-info.ts";
import { summaryHooks } from "../src/translator/summary-hooks.ts";
import {
  staleGoldenEditEntries,
  unusedMaxTokensAheadEntries,
  unusedParallelToolCallsAheadEntries,
  unusedResponseAheadEntries,
} from "./support/translator-ported-ahead.ts";
import { catalogLookup } from "./support/thinking.ts";
import { itTranslatorFixture, type TranslatorFixtureCase } from "./support/translator-fixtures.ts";

// Translators that consult the model registry (e.g. Claude adaptive thinking) use the Go static catalog.
setModelInfoLookup(catalogLookup);

const files = import.meta.glob<{ default: ReadonlyArray<TranslatorFixtureCase> }>(
  "./fixtures/translator/*.json",
  {
    eager: true,
  },
);

/** The cases that carry generated ids: `translator-fixtures-ids.test.ts` runs them. */
const idCaseKeys: ReadonlySet<string> = new Set(
  Object.values(files).flatMap((module) =>
    module.default
      .filter((c) => (c.needs ?? []).includes("id-normalization"))
      .map((c) => `${c.from}->${c.to} ${c.name}`),
  ),
);

describe("translator golden fixtures", () => {
  for (const [file, module] of Object.entries(files)) {
    describe(file.replace("./fixtures/translator/", ""), () => {
      for (const c of module.default) {
        itTranslatorFixture(c, (fixture, envelope) =>
          builtinTranslators.translateRequest(fixture.from, fixture.to, envelope, summaryHooks),
        );
      }
    });
  }

  it("consumed every ported-ahead entry", () => {
    expect(unusedMaxTokensAheadEntries()).toEqual([]);
    expect(unusedResponseAheadEntries()).toEqual([]);
    expect(unusedParallelToolCallsAheadEntries()).toEqual([]);
    expect(staleGoldenEditEntries((key) => !idCaseKeys.has(key))).toEqual([]);
  });

  it("found fixture files", () => {
    expect(Object.keys(files).length).toBeGreaterThan(0);
  });
});

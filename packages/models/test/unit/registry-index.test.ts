import { describe, expect, it } from "vitest";
import { MODEL_QUOTA_EXCEEDED_WINDOW_MS } from "../../src/registry/availability.ts";
import { sectionModels } from "../../src/registry/catalog.ts";
import type { ModelInfo } from "../../src/registry/model-info.ts";
import { ModelRegistryIndex } from "../../src/registry/registry.ts";
import {
  canonOf,
  catalogs,
  fixture,
  fixtureNow,
  fromGo,
  scenarioClients,
  scenarioIndex,
} from "../support/registry.ts";

describe("registry index parity with Go (model_registry.go)", () => {
  for (const scenario of fixture.scenarios) {
    describe(scenario.name, () => {
      const index = scenarioIndex(scenario);

      it("GetModelProviders", () => {
        for (const [model, providers] of Object.entries(scenario.registry.providers)) {
          expect(index.providersForModel(model), model).toEqual(providers);
        }

        expect(index.providersForModel("unknown-model")).toEqual([]);
      });

      it("GetModelInfo (provider specific, then last registered)", () => {
        for (const query of scenario.registry.infos) {
          expect(
            canonOf(index.modelInfo(query.model, query.provider)),
            `${query.model}@${query.provider}`,
          ).toEqual(canonOf(fromGo(query.info)));
        }
      });

      it("LookupModelInfo falls back to the static catalogs", () => {
        // Go looks Devin models up in the raw `devin` section, not the aggregated list the registry serves; the
        // catalog has the aggregated list only (ADR 0020), so those queries are not comparable.
        for (const query of scenario.registry.lookups.filter(
          (entry) => !entry.model.startsWith("devin/"),
        )) {
          expect(
            canonOf(index.lookupModelInfo(catalogs, query.model, query.provider)),
            `${query.model}@${query.provider}`,
          ).toEqual(canonOf(fromGo(query.info)));
        }

        expect(index.lookupModelInfo(catalogs, "   ")).toBeUndefined();
      });

      it("GetAvailableModelInfos", () => {
        const actual = index.availableModels(fixtureNow()).map((model) => canonOf(model));
        expect(actual).toEqual(scenario.registry.available.map((model) => canonOf(fromGo(model))));
      });

      it("GetFirstAvailableModel picks the newest available model", () => {
        // Go sorts with a comparator that is inconsistent for models without `created`, so its pick is arbitrary
        // among those; the Workers port is deterministic (newest first, ties by id).
        const available = index.availableModels(fixtureNow());
        const newest = Math.max(...available.map((model) => model.created));
        const first = index.firstAvailableModel(fixtureNow());
        expect(available.find((model) => model.id === first)?.created).toBe(newest);
        expect(scenario.registry.first).not.toBe("");
      });
    });
  }
});

describe("LookupStaticModelInfo", () => {
  it("finds a model of any provider catalog, additions included", () => {
    const empty = new ModelRegistryIndex([], fixtureNow());
    expect(empty.lookupModelInfo(catalogs, "gpt-image-2")?.id).toBe("gpt-image-2");
    expect(empty.lookupModelInfo(catalogs, "devin/swe-2")?.ownedBy).toBe("cognition");
    expect(empty.lookupModelInfo(catalogs, "gpt-5.6-terra", "codex")?.id).toBe("gpt-5.6-terra");
  });
});

describe("quota window", () => {
  const scenario = fixture.scenarios.find((candidate) => candidate.name === "quota-and-suspension");

  if (scenario === undefined) throw new Error("fixture scenario missing");
  const index = new ModelRegistryIndex(scenarioClients(scenario), fixtureNow());

  it("a quota-exceeded model stays listed while only that condition applies and is counted unavailable", () => {
    expect(index.availableModels(fixtureNow()).map((model) => model.id)).toContain("m-quota");
    expect(index.modelCount("m-quota", fixtureNow())).toBe(0);
    expect(index.modelCount("m-quota-two", fixtureNow())).toBe(1);
  });

  it("quota expires after five minutes", () => {
    const later = fixture.generatedAt + MODEL_QUOTA_EXCEEDED_WINDOW_MS + 1;
    expect(index.modelCount("m-quota", later)).toBe(1);
    // Suspensions for other reasons never expire on their own.
    expect(index.availableModels(later).map((model) => model.id)).not.toContain("m-other-susp");
  });
});

const model = (id: string, webSearch?: boolean): ModelInfo => ({
  id,
  object: "model",
  created: 1,
  ownedBy: "x",
  type: "x",
  ...(webSearch === undefined ? {} : { nativeCapabilities: { webSearch } }),
});

describe("native web search capability (GetResponsesWebSearchCapability)", () => {
  const index = new ModelRegistryIndex(
    [
      {
        id: "a",
        provider: "claude",
        models: [model("both", true), model("solo", true), model("unknown-flag")],
      },
      { id: "b", provider: "codex", models: [model("both", true)] },
      { id: "c", provider: "gemini", models: [model("gem", true), model("both", true)] },
      { id: "d", provider: "custom-provider", models: [model("custom", true)] },
      { id: "e", provider: "xai", models: [model("denied", false)] },
    ],
    fixtureNow(),
  );

  it("is true only when every route supports it explicitly", () => {
    expect(index.responsesWebSearchCapability("solo")).toBe(true);
  });

  it("a provider path that cannot search wins, as does an explicit model-level false", () => {
    expect(index.responsesWebSearchCapability("both")).toBe(false);
    expect(index.responsesWebSearchCapability("gem")).toBe(false);
    expect(index.responsesWebSearchCapability("denied")).toBe(false);
  });

  it("is unknown for missing flags, unknown providers and unregistered models", () => {
    expect(index.responsesWebSearchCapability("unknown-flag")).toBeUndefined();
    expect(index.responsesWebSearchCapability("custom")).toBeUndefined();
    expect(index.responsesWebSearchCapability("nope")).toBeUndefined();
    expect(index.responsesWebSearchCapability(" ")).toBeUndefined();
  });

  it("matches the catalog flags on a real Claude registration", () => {
    const claude = new ModelRegistryIndex(
      [{ id: "c", provider: "claude", models: sectionModels(catalogs, "claude") }],
      fixtureNow(),
    );

    expect(claude.responsesWebSearchCapability("claude-opus-5")).toBe(true);
    expect(claude.responsesWebSearchCapability("claude-sonnet-4-6")).toBeUndefined();
  });
});

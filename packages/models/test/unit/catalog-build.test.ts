// The model catalog's build (ADR 0020): the models.dev document trimmed to what Commissary reads, the provider catalogs
// built from it with the catalog additions, and the coverage of what the Go server serves
// (test/fixtures/go-catalog-served.json: the ids and thinking of every Go catalog section at the time the catalog moved
// to models.dev, pinned from the `sections` of test/fixtures/registry.json; it does not follow the reference checkout).
import { describe, expect, it } from "vitest";
import goServed from "../fixtures/go-catalog-served.json";
import { asString, get, type JsonObject, tryParseJson } from "@commissary/json";
import { parseCatalogAdditions } from "../../src/registry/catalog-additions.ts";
import {
  buildModelsCatalog,
  rawModelsDevThinking,
  SECTIONS,
  SOURCES,
  thinkingFromModelsDev,
} from "../../src/registry/catalog-build.ts";
import type { Section } from "../../src/registry/catalog-build.ts";
import {
  catalogAdditions,
  embeddedCatalogs,
  embeddedModelsDev,
  sectionModels,
} from "../../src/registry/catalog.ts";
import type { ModelInfo } from "../../src/registry/model-info.ts";
import type { ModelsDevModel } from "../../src/registry/models-dev.ts";
import { MODELS_DEV_PROVIDERS, trimModelsDev } from "../../src/registry/models-dev.ts";
import { applyThinking } from "@commissary/translation/thinking";
import { documentObject, documentText, mdModel } from "../support/models-dev.ts";

const trimmed = (text: string) => {
  const result = trimModelsDev(text);

  if (!result.ok) throw new Error(result.error);

  return result.value;
};

/** The additions with one provider replaced, parsed like the bundled file. */
const additionsWith = (providers: JsonObject) => {
  const parsed = parseCatalogAdditions({ version: 1, providers });

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
};

describe("trimModelsDev", () => {
  it("keeps what the catalog and the price lookup read and drops the rest", () => {
    const doc = trimmed(documentText());
    const model = doc.anthropic.models["claude-test"];

    expect(model).toMatchObject({
      id: "claude-test",
      name: "CLAUDE-TEST",
      release_date: "2026-01-01",
      reasoning: true,
    });
    expect(model?.cost).toEqual({ input: 1, output: 2, cache_read: 0.1 });
    expect(model).not.toHaveProperty("knowledge");
    expect(model).not.toHaveProperty("open_weights");
    expect(Object.keys(doc).toSorted()).toEqual([...MODELS_DEV_PROVIDERS].toSorted());
  });

  it("is idempotent: trimming a trimmed document changes nothing", () => {
    const once = JSON.stringify(trimmed(documentText()));

    expect(JSON.stringify(trimmed(once))).toBe(once);
  });

  it("keeps long-context tiers and drops the audio prices", () => {
    const tiers = [
      { input: 2.5, output: 15, cache_read: 0.25, tier: { type: "context", size: 200_000 } },
    ];

    const doc = trimmed(
      documentText({
        google: {
          "gemini-tiered": mdModel("gemini-tiered", {
            cost: {
              input: 1.25,
              output: 10,
              input_audio: 3,
              tiers,
              context_over_200k: { input: 2.5, output: 15 },
            },
          }),
        },
      }),
    );

    expect(doc.google.models["gemini-tiered"]?.cost).toEqual({
      input: 1.25,
      output: 10,
      tiers,
      context_over_200k: { input: 2.5, output: 15 },
    });
  });

  it("leaves a model in the catalog when its prices do not decode", () => {
    const result = trimModelsDev(
      documentText({
        anthropic: { "claude-odd": mdModel("claude-odd", { cost: { input: "free" } }) },
      }),
    );

    if (!result.ok) throw new Error(result.error);
    const model = result.value.anthropic.models["claude-odd"];

    expect(model?.id).toBe("claude-odd");
    expect(model).not.toHaveProperty("cost");
  });

  it("flags free models of the gateways from their prices", () => {
    const doc = trimmed(
      documentText({
        opencode: {
          "free-one": mdModel("free-one", { cost: { input: 0, output: 0 } }),
          "paid-one": mdModel("paid-one"),
        },
      }),
    );

    expect(doc.opencode.models["free-one"]?.free).toBe(true);
    expect(doc.opencode.models["paid-one"]?.free).toBeUndefined();
  });

  it("keeps a reasoning model whose reasoning_options is null, as one without options, and counts skipped entries", () => {
    const result = trimModelsDev(
      documentText({
        google: {
          "gemini-null": mdModel("gemini-null", { reasoning_options: null }),
          "gemini-bad": { id: 42 },
        },
      }),
    );

    if (!result.ok) throw new Error(result.error);

    expect(result.value.google.models["gemini-null"]?.reasoning_options).toEqual([]);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("rejects a document missing a provider or with a provider without models", () => {
    const { google: _, ...withoutGoogle } = documentObject();
    const empty = { ...documentObject(), google: { id: "google", models: {} } };

    expect(trimModelsDev(JSON.stringify(withoutGoogle))).toMatchObject({ ok: false });
    expect(trimModelsDev(JSON.stringify(empty))).toMatchObject({
      ok: false,
      error: "provider google has no usable models",
    });
    expect(trimModelsDev("{not json")).toMatchObject({ ok: false });
  });
});

describe("buildModelsCatalog", () => {
  const build = (models: Parameters<typeof documentText>[0] = {}, providers: JsonObject = {}) =>
    buildModelsCatalog(trimmed(documentText(models)), additionsWith(providers));

  it("serves the current text models and leaves out deprecated and non-text ones", () => {
    const catalog = build({
      anthropic: {
        "claude-old": mdModel("claude-old", { status: "deprecated" }),
        "claude-video": mdModel("claude-video", {
          modalities: { input: ["text"], output: ["video"] },
        }),
      },
    });

    const ids = catalog.claude.map((model) => model.id);

    expect(ids).toContain("claude-test");
    expect(ids).not.toContain("claude-old");
    expect(ids).not.toContain("claude-video");
  });

  it("serves an addition models.dev does not list, as it is", () => {
    const catalog = build(
      {},
      {
        antigravity: {
          models: [{ id: "private-model", ownedBy: "antigravity", type: "antigravity" }],
        },
        claude: {
          models: [{ id: "claude-private", displayName: "Private", ownedBy: "anthropic" }],
        },
      },
    );

    expect(catalog.antigravity.map((model) => model.id)).toEqual(["private-model"]);
    expect(catalog.claude.find((model) => model.id === "claude-private")).toMatchObject({
      displayName: "Private",
      ownedBy: "anthropic",
    });
  });

  it("an addition only fills what models.dev leaves empty", () => {
    const catalog = build(
      {},
      {
        claude: {
          facts: { "claude-test": { description: "From the additions", contextLength: 1 } },
        },
      },
    );

    const model = catalog.claude.find((entry) => entry.id === "claude-test");

    // models.dev has no description: filled. It has a context length (200000): kept.
    expect(model?.description).toBe("From the additions");
    expect(model?.contextLength).not.toBe(1);
    expect(model?.contextLength).toBe(200_000);
  });

  it("include and exclude patterns choose the models of a provider", () => {
    const catalog = build(
      { anthropic: { "claude-extra": mdModel("claude-extra") } },
      { claude: { exclude: ["claude-extra"] } },
    );

    expect(catalog.claude.map((model) => model.id)).toContain("claude-test");
    expect(catalog.claude.map((model) => model.id)).not.toContain("claude-extra");
  });

  describe("thinking", () => {
    const md = (extra: Record<string, unknown>): ModelsDevModel => {
      const doc = trimmed(documentText({ anthropic: { m: mdModel("m", extra) } }));
      const model = doc.anthropic.models["m"];

      if (model === undefined) throw new Error("model missing");

      return model;
    };

    it("a budget range does not allow zero unless its minimum is 0 or a toggle exists", () => {
      const budget = (min: number) => [{ type: "budget_tokens", min, max: 24_576 }];

      expect(thinkingFromModelsDev(md({ reasoning_options: budget(128) }))).not.toHaveProperty(
        "zeroAllowed",
      );
      expect(thinkingFromModelsDev(md({ reasoning_options: budget(0) }))?.zeroAllowed).toBe(true);
      expect(
        thinkingFromModelsDev(md({ reasoning_options: [{ type: "toggle" }, ...budget(1024)] }))
          ?.zeroAllowed,
      ).toBe(true);
      expect(
        thinkingFromModelsDev(
          md({ reasoning_options: [{ type: "effort", values: ["none", "low"] }] }),
        )?.zeroAllowed,
      ).toBe(true);
    });

    it("a reasoning model with an empty option list has no thinking settings of its own", () => {
      expect(thinkingFromModelsDev(md({ reasoning_options: [] }))).toBeUndefined();
      expect(thinkingFromModelsDev(md({ reasoning_options: null }))).toBeUndefined();
      // Facts still apply, and no defaults are invented around them.
      expect(thinkingFromModelsDev(md({ reasoning_options: [] }), [{ max: 100 }])).toEqual({
        max: 100,
      });
      // No options at all (not even an empty list): the standard levels.
      expect(thinkingFromModelsDev(md({}))?.levels).toEqual(["low", "medium", "high"]);
    });

    it("a model models.dev says does not reason has no thinking, whatever the additions say", () => {
      const model = md({ reasoning: false });

      expect(thinkingFromModelsDev(model, [{ min: 1, max: 2, levels: ["low"] }])).toBeUndefined();
    });

    it("the bundled catalog gives the models Commissary relies on the right thinking", () => {
      const catalogs = embeddedCatalogs();

      const find = (section: Section, id: string) =>
        sectionModels(catalogs, section).find((model) => model.id === id);

      expect(find("gemini", "gemini-2.5-pro")?.thinking?.zeroAllowed).toBeUndefined();
      expect(find("aistudio", "gemini-2.5-pro")?.thinking?.zeroAllowed).toBeUndefined();

      for (const id of ["grok-build-0.1", "grok-4.20-0309-reasoning"])
        expect(find("xai", id)?.thinking, id).toBeUndefined();
    });
  });

  it("an addition's thinking min and max fill what models.dev leaves out", () => {
    const catalogs = embeddedCatalogs();

    const aistudio = (id: string) =>
      sectionModels(catalogs, "aistudio").find((model) => model.id === id)?.thinking;

    expect(aistudio("gemini-3.1-pro-preview")).toMatchObject({ min: 128, max: 32_768 });
    expect(aistudio("gemini-3-flash-preview")).toMatchObject({ min: 128, max: 32_768 });
    expect(aistudio("gemini-flash-lite-latest")).toMatchObject({ min: 512, max: 24_576 });
    expect(aistudio("gemini-flash-latest")?.max).toBe(24_576);
    expect(
      sectionModels(catalogs, "claude").find((model) => model.id === "claude-opus-4-5-20251101")
        ?.thinking?.max,
    ).toBe(128_000);
  });

  it("Codex image models keep what they had: no tools, no web search", () => {
    const pro = sectionModels(embeddedCatalogs(), "codex-pro");

    for (const id of ["gpt-image-1.5", "gpt-image-2"]) {
      const model = pro.find((entry) => entry.id === id);

      expect(model, id).toBeDefined();
      expect(model?.supportedParameters, id).toBeUndefined();
      expect(model?.nativeCapabilities?.webSearch, id).toBeUndefined();
    }
  });

  it("builds every section", () => {
    const catalog = embeddedCatalogs().models;

    for (const section of SECTIONS) expect(catalog[section].length, section).toBeGreaterThan(0);
  });
});

describe("parseCatalogAdditions", () => {
  it("accepts the bundled additions", () => {
    expect(catalogAdditions().providers).toBeDefined();
  });

  it("names what is wrong", () => {
    const error = (providers: JsonObject): string => {
      const result = parseCatalogAdditions({ version: 1, providers });

      return result.ok ? "" : result.error;
    };

    expect(error({ claude: { models: [{ id: "a" }, { id: "a" }] } })).toContain(
      "duplicate model a",
    );
    expect(error({ claude: { models: [{ id: " padded" }] } })).toContain("empty or padded");
    expect(error({ claude: { plans: { free: ["x"] } } })).toContain("plans exist for codex only");
    expect(error({ codex: { plans: { gold: ["x"] } } })).toContain("unknown plan gold");
    expect(error({ claude: { models: [{ id: "a" }], facts: { a: {} } } })).toContain(
      "both a full record and facts",
    );
    expect(parseCatalogAdditions({ version: 2, providers: {} }).ok).toBe(false);
  });
});

describe("coverage of what the Go server serves", () => {
  const served = goServed as Record<string, ReadonlyArray<{ readonly id: string }>>;
  const catalogs = embeddedCatalogs();
  /** The sections the Go server never had: System One's providers (ADR 0032). */
  const NOT_IN_GO: ReadonlySet<Section> = new Set(["typesafe", "subq", "opencode-zen"]);
  const goSections = SECTIONS.filter((section) => !NOT_IN_GO.has(section));

  it("every section serves every model id Go served when the catalog moved to models.dev", () => {
    for (const section of goSections) {
      const have = new Set(sectionModels(catalogs, section).map((model) => model.id));

      const missing = (served[section] ?? [])
        .map((model) => model.id)
        .filter((id) => !have.has(id));

      expect(served[section]?.length, section).toBeGreaterThan(0);
      expect(missing, section).toEqual([]);
    }
  });

  type Pinned = {
    readonly id: string;
    readonly thinking?: NonNullable<ModelInfo["thinking"]>;
    readonly supportsWebSearch?: boolean;
    readonly supportConfigurationUpdate?: boolean;
    readonly nativeCapabilities?: { readonly webSearch?: boolean };
    readonly overrideHeader?: Record<string, string>;
    readonly supportedGenerationMethods?: ReadonlyArray<string>;
  };

  const THINKING_FIELDS = ["min", "max", "zeroAllowed", "dynamicAllowed", "levels"] as const;

  /** The models.dev entry a section's model comes from (Codex plans read `openai`; Antigravity and Devin none). */
  const modelsDevEntry = (section: Section, id: string): ModelsDevModel | undefined => {
    const doc = embeddedModelsDev();

    if (section.startsWith("codex-")) return doc.openai.models[id];
    const spec = SOURCES[section as keyof typeof SOURCES];

    if (spec === undefined) return undefined;
    const mapId = "mapId" in spec ? spec.mapId : (value: string) => value;

    return Object.values(doc[spec.source].models).find((model) => mapId(model.id) === id);
  };

  it("every pinned runtime field is still served, unless models.dev has its own value for it", () => {
    const differences: string[] = [];

    for (const section of goSections) {
      const have = new Map(sectionModels(catalogs, section).map((model) => [model.id, model]));

      for (const pinned of served[section] as ReadonlyArray<Pinned>) {
        const model = have.get(pinned.id);

        if (model === undefined) continue;
        const entry = modelsDevEntry(section, pinned.id);
        const own = entry === undefined ? {} : rawModelsDevThinking(entry).thinking;

        // models.dev saying the model does not reason is its own value for the whole thinking support.
        for (const field of entry?.reasoning === false ? [] : THINKING_FIELDS) {
          if (own[field] !== undefined) continue;
          const want = JSON.stringify(pinned.thinking?.[field]);
          const got = JSON.stringify(model.thinking?.[field]);

          if (want !== got)
            differences.push(`${section}/${pinned.id} thinking.${field}: Go ${want}, now ${got}`);
        }

        const flat = {
          supportsWebSearch: [pinned.supportsWebSearch, model.supportsWebSearch],
          supportConfigurationUpdate: [
            pinned.supportConfigurationUpdate,
            model.supportConfigurationUpdate,
          ],
          webSearch: [pinned.nativeCapabilities?.webSearch, model.nativeCapabilities?.webSearch],
          overrideHeader: [pinned.overrideHeader, model.config?.overrideHeader],
          supportedGenerationMethods: [
            pinned.supportedGenerationMethods,
            model.supportedGenerationMethods,
          ],
        };

        for (const [field, [want, got]] of Object.entries(flat))
          // A default models.dev and Go agree to lack may be filled in; what Go had must stay.
          if (want !== undefined && JSON.stringify(want) !== JSON.stringify(got))
            differences.push(
              `${section}/${pinned.id} ${field}: Go ${JSON.stringify(want)}, now ${JSON.stringify(got)}`,
            );
      }
    }

    expect(differences).toEqual([]);
  });

  it("Antigravity and Devin serve exactly what Go served", () => {
    for (const section of ["antigravity", "devin"] as const)
      for (const pinned of served[section] as ReadonlyArray<Pinned>) {
        const model = sectionModels(catalogs, section).find((entry) => entry.id === pinned.id);

        expect(model?.thinking, `${section}/${pinned.id}`).toEqual(pinned.thinking);
      }
  });

  it("Codex plan models report the context limit models.dev gives", () => {
    const limit = embeddedModelsDev().openai.models["gpt-5.5"]?.limit?.context;

    expect(limit).toBeGreaterThan(0);

    for (const plan of ["free", "team", "plus", "pro"] as const)
      expect(
        sectionModels(catalogs, `codex-${plan}`).find((model) => model.id === "gpt-5.5")
          ?.contextLength,
        plan,
      ).toBe(limit);
  });

  it("a Codex plan model accepts effort none and forwards it upstream (no longer lowered to low)", () => {
    const info = sectionModels(catalogs, "codex-pro").find((model) => model.id === "gpt-5.5");

    expect(info?.thinking?.levels).toContain("none");
    expect(info?.thinking?.zeroAllowed).toBe(true);

    const result = applyThinking(
      tryParseJson(`{"model":"gpt-5.5","reasoning":{"effort":"none"},"input":"hi"}`),
      {
        model: "gpt-5.5",
        fromFormat: "openai-response",
        toFormat: "codex",
        providerKey: "codex",
        modelInfo: info ?? null,
      },
    );

    expect(result.error).toBeUndefined();
    expect(asString(get(result.body, "reasoning.effort"))).toBe("none");
  });

  it("the bundled models.dev document has every provider the catalog reads", () => {
    expect(Object.keys(embeddedModelsDev()).toSorted()).toEqual(
      [...MODELS_DEV_PROVIDERS].toSorted(),
    );
  });
});

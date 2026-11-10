import { describe, expect, it } from "vitest";
import {
  embeddedCatalogs,
  embeddedModelsDev,
  lookupStaticModelInfo,
  lookupStaticModelInfoByChannel,
  sectionModels,
  staticModelsByChannel,
  validateCodexClientModels,
} from "../src/registry/catalog.ts";
import { catalogsFromText } from "../src/registry/catalog-store.ts";
import codexClient from "../src/registry/catalog/codex_client_models.json";
import { documentText, mdModel } from "./support/models-dev.ts";

const codexEntry = (overrides: Record<string, unknown> = {}) => ({
  slug: "gpt-5.5",
  display_name: "GPT",
  description: "d",
  base_instructions: "b",
  minimal_client_version: "0.1.0",
  visibility: "list",
  priority: 0,
  context_window: 10,
  max_context_window: 20,
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low" }],
  ...overrides,
});

describe("codex client catalog validation", () => {
  it("accepts the embedded catalog", () => {
    expect(validateCodexClientModels(codexClient).ok).toBe(true);
  });

  it.each([
    ["no models", { models: [] }],
    ["missing default template", { models: [codexEntry({ slug: "other" })] }],
    ["duplicate slug", { models: [codexEntry(), codexEntry()] }],
    ["context window above max", { models: [codexEntry({ context_window: 30 })] }],
    ["unlisted default level", { models: [codexEntry({ default_reasoning_level: "high" })] }],
    [
      "duplicate effort",
      {
        models: [
          codexEntry({ supported_reasoning_levels: [{ effort: "low" }, { effort: "low" }] }),
        ],
      },
    ],
    ["negative priority", { models: [codexEntry({ priority: -1 })] }],
    ["blank description", { models: [codexEntry({ description: " " })] }],
  ])("rejects %s", (_name, payload) => {
    expect(validateCodexClientModels(payload).ok).toBe(false);
  });

  it("accepts a minimal valid catalog", () => {
    expect(validateCodexClientModels({ models: [codexEntry()] }).ok).toBe(true);
  });
});

describe("catalogsFromText (KV contents -> catalogs)", () => {
  it("uses the bundled catalogs when nothing is stored", () => {
    const { catalogs, warning } = catalogsFromText(null);
    expect(catalogs).toBe(embeddedCatalogs());
    expect(warning).toBeUndefined();
  });

  it("builds the catalogs from a valid stored document, keeping the bundled additions and Codex client catalog", () => {
    const { catalogs, warning } = catalogsFromText(
      documentText({ anthropic: { "stored-claude": mdModel("stored-claude") } }),
    );

    expect(warning).toBeUndefined();
    expect(catalogs.models.claude.some((model) => model.id === "stored-claude")).toBe(true);
    // Additions-only records (no longer listed by models.dev) are still served.
    expect(catalogs.models.antigravity.length).toBe(embeddedCatalogs().models.antigravity.length);
    expect(catalogs.models.devin.length).toBe(embeddedCatalogs().models.devin.length);
    expect(catalogs.codexClient).toBe(embeddedCatalogs().codexClient);
  });

  it("falls back to the bundled catalogs and warns when the stored text is invalid", () => {
    for (const text of ["{not json", JSON.stringify({ anthropic: { models: {} } })]) {
      const { catalogs, warning } = catalogsFromText(text);
      expect(catalogs).toBe(embeddedCatalogs());
      expect(warning).toContain("rejected");
    }
  });
});

describe("static lookups", () => {
  const catalogs = embeddedCatalogs();

  it("channels map to their sections", () => {
    expect(staticModelsByChannel(catalogs, "Grok")?.map((model) => model.id)).toEqual(
      sectionModels(catalogs, "xai").map((model) => model.id),
    );
    expect(staticModelsByChannel(catalogs, "kimi.com")?.length).toBe(catalogs.models.kimi.length);
    expect(staticModelsByChannel(catalogs, "nope")).toBeUndefined();
  });

  it("finds a model by channel and by any section", () => {
    expect(lookupStaticModelInfoByChannel(catalogs, "devin/swe-2", "devin")?.ownedBy).toBe(
      "cognition",
    );
    expect(lookupStaticModelInfoByChannel(catalogs, "devin/swe-2", "claude")).toBeUndefined();
    expect(lookupStaticModelInfo(catalogs, "devin/swe-2")?.id).toBe("devin/swe-2");
    expect(lookupStaticModelInfo(catalogs, "")).toBeUndefined();
  });

  it("dated and bracketed Claude variants share their catalog entry", () => {
    for (const id of [
      "claude-sonnet-5-5[1m]",
      "claude-sonnet-5-5-20261001",
      "claude-sonnet-5-5-20261001[1m]",
    ]) {
      expect(lookupStaticModelInfo(catalogs, id)?.id, id).toBe("claude-sonnet-5-5");
      expect(lookupStaticModelInfoByChannel(catalogs, id, "claude")?.id, id).toBe(
        "claude-sonnet-5-5",
      );
    }

    expect(
      lookupStaticModelInfoByChannel(catalogs, "claude-sonnet-5-5[1m]", "gemini"),
    ).toBeUndefined();
    expect(lookupStaticModelInfo(catalogs, "claude-nope-1[1m]")).toBeUndefined();
    expect(lookupStaticModelInfo(catalogs, "gpt-6-astra[1m]")).toBeUndefined();
  });

  it("an exact id wins over its family", () => {
    // claude-opus-4-5-20251101 and claude-opus-4-5 are both catalog entries: neither answers for the other.
    expect(lookupStaticModelInfo(catalogs, "claude-opus-4-5-20251101")?.id).toBe(
      "claude-opus-4-5-20251101",
    );

    expect(lookupStaticModelInfoByChannel(catalogs, "claude-opus-4-5-20251101", "claude")?.id).toBe(
      "claude-opus-4-5-20251101",
    );

    expect(lookupStaticModelInfo(catalogs, "claude-opus-4-5")?.id).toBe("claude-opus-4-5");
  });

  it("the bundled models.dev snapshot is valid", () => {
    expect(Object.keys(embeddedModelsDev().anthropic.models).length).toBeGreaterThan(5);
  });
});

import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { embeddedModelsDev, modelsDevFromText } from "../src/registry/catalog.ts";
import { CATALOG_KEYS } from "../src/registry/catalog-store.ts";
import {
  currentOpenCodeCatalog,
  defaultCatalogModels,
  openCodeCatalogFromText,
  resetOpenCodeCatalogCache,
} from "../src/registry/opencode-catalog.ts";
import { FakeKv, workerEnv } from "./support/registry-refresh.ts";
import { documentText, mdModel } from "./support/models-dev.ts";

const catalog = (() => {
  const parsed = modelsDevFromText(documentText());

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
})();

describe("default registered models", () => {
  it("Zen registers non-deprecated, non-free models with the catalog limits and protocol types", () => {
    const models = defaultCatalogModels(catalog, "opencode-zen");
    expect(models.map((info) => info.id).toSorted()).toEqual(["claude-z", "gpt-9"]);
    const claude = models.find((info) => info.id === "claude-z");
    expect(claude).toMatchObject({
      type: "claude",
      displayName: "CLAUDE-Z",
      contextLength: 200_000,
      maxCompletionTokens: 32_000,
      supportedInputModalities: ["text", "image"],
    });
    expect(models.find((info) => info.id === "gpt-9")?.type).toBe("openai");
  });

  it("Go keeps its free models", () => {
    expect(
      defaultCatalogModels(catalog, "opencode-go")
        .map((info) => info.id)
        .toSorted(),
    ).toEqual(["go-free", "kimi-q"]);
  });

  it("adds the gateway's catalog additions whatever their price, ahead of a models.dev entry with the same id", () => {
    const parsed = modelsDevFromText(
      documentText({
        opencode: {
          "jev-1.13-free": mdModel("jev-1.13-free", { cost: { input: 0, output: 0 } }),
        },
      }),
    );

    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.opencode.models["jev-1.13-free"]?.free).toBe(true);

    const jev = {
      id: "jev-1.13-free",
      object: "model",
      created: 0,
      ownedBy: "opencode",
      type: "systemone",
    };

    const models = defaultCatalogModels(parsed.value, "opencode-zen", [jev]);
    expect(models.map((info) => info.id).toSorted()).toEqual([
      "claude-z",
      "gpt-9",
      "jev-1.13-free",
    ]);
    expect(models.find((info) => info.id === "jev-1.13-free")?.type).toBe("systemone");
  });

  it("the bundled snapshot has models for both gateways", () => {
    const bundled = embeddedModelsDev();
    expect(Object.keys(bundled.opencode.models).length).toBeGreaterThan(10);
    expect(Object.keys(bundled["opencode-go"].models).length).toBeGreaterThan(5);
    expect(defaultCatalogModels(bundled, "opencode-zen").length).toBeGreaterThan(5);
  });
});

describe("request-path catalog", () => {
  beforeEach(resetOpenCodeCatalogCache);

  it("reads the KV copy when valid", async () => {
    const kv = new FakeKv();
    kv.data.set(
      CATALOG_KEYS.modelsDev,
      documentText({ opencode: { "fresh-model": mdModel("fresh-model") } }),
    );

    const fresh = await Effect.runPromise(
      currentOpenCodeCatalog.pipe(Effect.provide(workerEnv(kv))),
    );

    expect(fresh.opencode.models["fresh-model"]).toBeDefined();
  });

  it("falls back to the bundled snapshot when KV is empty or invalid", async () => {
    const empty = await Effect.runPromise(
      currentOpenCodeCatalog.pipe(Effect.provide(workerEnv(new FakeKv()))),
    );

    expect(empty).toEqual(embeddedModelsDev());

    resetOpenCodeCatalogCache();
    const kv = new FakeKv();
    kv.data.set(CATALOG_KEYS.modelsDev, "{broken");

    const invalid = await Effect.runPromise(
      currentOpenCodeCatalog.pipe(Effect.provide(workerEnv(kv))),
    );

    expect(invalid).toEqual(embeddedModelsDev());
    expect(openCodeCatalogFromText("{broken").warning).toContain("rejected");
    expect(openCodeCatalogFromText(null).warning).toBeUndefined();
  });

  it("without Worker bindings it is the bundled snapshot", async () => {
    expect(await Effect.runPromise(currentOpenCodeCatalog)).toEqual(embeddedModelsDev());
  });
});

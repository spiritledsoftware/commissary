// The Codex client catalog's `supports_search_tool` for Claude models (native tool search): true only when the org
// switch is on and every credential serving the model is a Claude one that takes native tool search for it (Go:
// internal/client/codex/models/models_test.go, sdk/cliproxy/auth/native_tool_search_capability_test.go; upstream
// 58c0f6a2, 11f04c20). The snapshot's wiring of the same bit runs in workerd (`registry-routes.test.ts`).
import { describe, expect, it } from "vitest";
import { asString, type JsonObject } from "@commissary/json";
import { buildCodexClientModels } from "../../src/registry/codex-client-models.ts";
import { lookupStaticModelInfo } from "../../src/registry/catalog.ts";
import type { ModelInfo } from "../../src/registry/model-info.ts";
import { sourceTakesNativeToolSearch } from "../../src/registry/native-tool-search.ts";
import { type ClientRegistration, ModelRegistryIndex } from "../../src/registry/registry.ts";
import type { ModelSource } from "../../src/registry/source.ts";
import { catalogs } from "../support/registry.ts";
import { claudeKeySource, configOf, source } from "../support/registry-sources.ts";

const GATE = "upstream:\n  claude:\n    tool-search: true\n";

const NOW = 1_800_000_000_000;

/** What a credential registers: its source and the models it serves (assembly itself runs in workerd). */
interface Registered {
  readonly source: ModelSource;
  readonly models: ModelInfo[];
}

const info = (id: string, upstream = id): ModelInfo => {
  const known = lookupStaticModelInfo(catalogs, upstream);

  if (known === undefined) throw new Error(`no catalog entry for ${upstream}`);

  return { ...known, id, metadataModelId: upstream };
};

const SONNET = "claude-sonnet-4-5-20250929";

/** `slug -> supports_search_tool` of the catalog a Codex client gets from `registered`. */
const advertised = (yaml: string, registered: Registered[]): Map<string, unknown> => {
  const config = configOf(yaml);

  const clients: ClientRegistration[] = registered.map(({ source: model, models }) => ({
    id: model.id,
    provider: model.executor,
    models,
    nativeToolSearch: (candidate) => sourceTakesNativeToolSearch(config, model, candidate),
  }));

  const index = new ModelRegistryIndex(clients, NOW);

  const payload = buildCodexClientModels({
    catalog: catalogs.codexClient,
    models: index.availableModels(NOW),
    providersForModel: (id) => index.providersForModel(id),
    lookupModelInfo: (id, provider = "") => index.lookupModelInfo(catalogs, id, provider),
    toolSearchCapability: (id) => index.nativeToolSearchCapability(id),
    optimizeMultiAgentV2: false,
    clientVersion: "0.150.0",
  });

  return new Map(
    ((payload.models ?? []) as JsonObject[]).map((entry) => [
      asString(entry.slug),
      entry.supports_search_tool,
    ]),
  );
};

const claude = (id: string, attributes: Record<string, string> = {}, models = [info(SONNET)]) => ({
  source: claudeKeySource(id, attributes),
  models,
});

const GATEWAY = { base_url: "https://gateway.test" };

describe("native tool search in the Codex catalog", () => {
  it("is true only with the gate on, every provider Claude and every credential native", () => {
    expect(advertised(GATE, [claude("claude-a")]).get(SONNET)).toBe(true);
    expect(advertised("", [claude("claude-a")]).get(SONNET)).toBe(false);
  });

  it("derives the origin from the credential: Anthropic's API, or a custom base URL with the key's flag", () => {
    const anthropic = claude("claude-a", { base_url: "https://api.anthropic.com" });
    expect(advertised(GATE, [anthropic]).get(SONNET)).toBe(true);
    expect(advertised(GATE, [claude("gw", GATEWAY)]).get(SONNET)).toBe(false);

    const flagged = claude("gw", { ...GATEWAY, native_tool_search: "true" });
    expect(advertised(GATE, [flagged]).get(SONNET)).toBe(true);
  });

  it("is false for one credential that is not native", () => {
    expect(advertised(GATE, [claude("claude-a"), claude("claude-b", GATEWAY)]).get(SONNET)).toBe(
      false,
    );
  });

  it("is false for a model that predates tool search, judged on its upstream model", () => {
    const aliased = claude("claude-a", {}, [
      info("legacy-fast", "claude-opus-4-1-20250805"),
      info("modern-fast", SONNET),
    ]);

    const result = advertised(GATE, [aliased]);
    expect(result.get("legacy-fast")).toBe(false);
    expect(result.get("modern-fast")).toBe(true);
  });

  it("is false for a model that Claude and another provider both serve", () => {
    const codex = { source: source("codex-a", "codex"), models: [info("shared-model", "gpt-5.5")] };
    const both = claude("claude-a", {}, [info("shared-model", SONNET)]);
    expect(advertised(GATE, [both, codex]).get("shared-model")).toBe(false);
  });

  it("is false for a delegating executor and for an empty registry", () => {
    const delegating = {
      ...claude("kimi-a"),
      source: claudeKeySource("kimi-a", {}, { executor: "kimi" }),
    };

    expect(advertised(GATE, [delegating]).get(SONNET)).toBeFalsy();
    expect(advertised(GATE, []).size).toBe(0);
  });
});

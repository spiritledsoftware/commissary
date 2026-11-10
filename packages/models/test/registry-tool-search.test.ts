// The Codex client catalog's `supports_search_tool` for Claude models (native tool search): true only when the org
// switch is on and every credential serving the model is a Claude one that takes native tool search for it (Go:
// internal/client/codex/models/models_test.go, sdk/cliproxy/auth/native_tool_search_capability_test.go; upstream
// 58c0f6a2, 11f04c20).
import { describe, expect, it } from "vitest";
import { asString, type JsonObject } from "@commissary/json";
import { buildCodexClientModels } from "../src/registry/codex-client-models.ts";
import { buildSnapshot } from "../src/registry/service.ts";
import type { ModelSource } from "../src/registry/source.ts";
import { catalogs } from "./support/registry.ts";
import { configOf, source } from "./support/registry-sources.ts";

const GATE = "upstream:\n  claude:\n    tool-search: true\n";

const NOW = 1_800_000_000_000;

/** `slug -> supports_search_tool` of the catalog a Codex client gets from `sources`. */
const advertised = (yaml: string, sources: ModelSource[]): Map<string, unknown> => {
  const snapshot = buildSnapshot({ sources, config: configOf(yaml), catalogs, now: NOW });

  const payload = buildCodexClientModels({
    catalog: catalogs.codexClient,
    models: snapshot.availableModels(),
    providersForModel: snapshot.providersForModel,
    lookupModelInfo: (id, provider = "") => snapshot.lookupModelInfo(id, provider),
    toolSearchCapability: snapshot.nativeToolSearchCapability,
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

const claude = (id: string, overrides: Partial<ModelSource> = {}): ModelSource =>
  source(id, "claude", { nativeToolSearchOrigin: true, ...overrides });

const SONNET = "claude-sonnet-4-5-20250929";

describe("native tool search in the Codex catalog", () => {
  it("is true only with the gate on, every provider Claude and every credential native", () => {
    expect(advertised(GATE, [claude("claude-a")]).get(SONNET)).toBe(true);
    expect(advertised("", [claude("claude-a")]).get(SONNET)).toBe(false);
  });

  it("is false for one credential that is not native", () => {
    const sources = [claude("claude-a"), claude("claude-b", { nativeToolSearchOrigin: false })];
    expect(advertised(GATE, sources).get(SONNET)).toBe(false);
  });

  it("is false for a model that predates tool search, judged after aliasing", () => {
    const yaml = `${GATE}oauth:
  model-alias:
    claude:
      - { name: claude-opus-4-1-20250805, alias: legacy-fast }
      - { name: ${SONNET}, alias: modern-fast }
`;

    const result = advertised(yaml, [claude("claude-a")]);
    expect(result.get("legacy-fast")).toBe(false);
    expect(result.get("modern-fast")).toBe(true);
  });

  it("is false for a model that Claude and another provider both serve", () => {
    const yaml = `${GATE}oauth:
  model-alias:
    claude:
      - { name: ${SONNET}, alias: shared-model }
    codex:
      - { name: gpt-5.5, alias: shared-model }
`;

    const result = advertised(yaml, [claude("claude-a"), source("codex-a", "codex")]);
    expect(result.get("shared-model")).toBe(false);
  });

  it("is false for a delegating executor and for an empty registry", () => {
    const delegating = claude("kimi-a", { executor: "kimi" });
    expect(advertised(GATE, [delegating]).get(SONNET)).toBeFalsy();
    expect(advertised(GATE, []).size).toBe(0);
  });

  it("leaves a disabled credential out", () => {
    const disabled = claude("claude-c", { disabled: true, nativeToolSearchOrigin: false });
    expect(advertised(GATE, [claude("claude-a"), disabled]).get(SONNET)).toBe(true);
  });
});

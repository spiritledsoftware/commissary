import { describe, expect, it } from "vite-plus/test";
import { buildCodexClientModels } from "../../src/registry/codex-client-models.ts";
import type { ModelInfo } from "../../src/registry/model-info.ts";
import type { JsonObject } from "@commissary/json";

// Go: internal/client/codex/models/models_test.go (Issue6769, Issue7209): non-Codex and mixed routes advertise direct
// tools and no Responses-Lite, reasoning-effort updates or original image detail; pure Codex templates keep theirs.

const template = (slug: string): JsonObject => ({
  slug,
  display_name: slug,
  description: "d",
  base_instructions: "Full instructions",
  visibility: "list",
  context_window: 1000,
  max_context_window: 1000,
  priority: 0,
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
  prefer_websockets: true,
  apply_patch_tool_type: "freeform",
  tool_mode: "code_mode_only",
  use_responses_lite: true,
  supports_reasoning_effort_updates: true,
  supports_image_detail_original: true,
  input_modalities: ["text", "image"],
  supports_search_tool: true,
  service_tiers: [{ id: "priority" }],
  upgrade: null,
  availability_nux: { message: "nux" },
});

const catalog: JsonObject = { models: [template("gpt-5.5"), template("gpt-6-astra")] };

const info = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  object: "model",
  created: 0,
  ownedBy: "test",
  type: "test",
  supportedInputModalities: ["text", "image"],
  ...extra,
});

const providers = new Map<string, string[]>(
  Object.entries({
    "gpt-6-astra": ["codex"],
    "claude-opus-5-5": ["claude"],
    "kimi-k3": ["kimi"],
    "mixed-astra": ["claude", "codex"],
  }),
);

const models = [
  info("gpt-6-astra"),
  info("claude-opus-5-5"),
  info("kimi-k3"),
  info("mixed-astra", { metadataModelId: "gpt-6-astra", explicitInputModalities: true }),
];

const build = (): Record<string, JsonObject> => {
  const result = buildCodexClientModels({
    catalog,
    models,
    providersForModel: (id) => providers.get(id) ?? [],
    lookupModelInfo: (id) => models.find((model) => model.id === id),
    optimizeMultiAgentV2: false,
    clientVersion: "0.166.0",
  });

  return Object.fromEntries(
    ((result.models ?? []) as JsonObject[]).map((entry) => [entry.slug as string, entry]),
  );
};

describe("Codex client catalog capability flags on non-Codex routes", () => {
  const bySlug = build();

  it("keeps the template's tool mode, Responses-Lite, effort updates and image detail on a pure Codex route", () => {
    expect(bySlug["gpt-6-astra"]).toMatchObject({
      tool_mode: "code_mode_only",
      use_responses_lite: true,
      supports_reasoning_effort_updates: true,
      supports_image_detail_original: true,
    });
  });

  it.each(["claude-opus-5-5", "kimi-k3", "mixed-astra"])(
    "advertises direct tools and no lite or original-detail support for %s",
    (slug) => {
      expect(bySlug[slug]).toMatchObject({
        tool_mode: "direct",
        use_responses_lite: false,
        supports_reasoning_effort_updates: false,
        supports_image_detail_original: false,
        input_modalities: ["text", "image"],
      });
    },
  );
});

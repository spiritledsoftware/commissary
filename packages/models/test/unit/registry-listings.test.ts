import { describe, expect, it } from "vitest";
import {
  buildCodexClientModels,
  supportsApplyPatchProviders,
} from "../../src/registry/codex-client-models.ts";
import {
  resolveClaudeModelIdPrefix,
  ensureClaudeModelIdPrefix,
} from "../../src/registry/listings.ts";
import { asString, type JsonObject } from "@commissary/json";
import {
  respondGeminiDetail,
  respondGeminiList,
  respondModels,
} from "../../src/registry/models-api.ts";
import {
  catalogs,
  fixture,
  fixtureNow,
  type FixtureRequest,
  goCompactBytes,
  scenarioIndex,
  sortedBody,
} from "../support/registry.ts";

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const replyFor = (scenario: (typeof fixture.scenarios)[number], request: FixtureRequest) => {
  const index = scenarioIndex(scenario);
  const models = index.availableModels(fixtureNow());
  const headers = request.headers ?? {};

  const info = {
    userAgent: headers["User-Agent"] ?? "",
    anthropicVersion: headers["Anthropic-Version"] ?? "",
    clientVersion: undefined,
  };

  const options = { disableCloaking: scenario.disableCloaking === true, codexClient: () => ({}) };

  if (request.path.startsWith("/v1beta/models/")) {
    return respondGeminiDetail(models, request.path.slice("/v1beta/models/".length));
  }

  if (request.path === "/v1beta/models") return respondGeminiList(models);

  const rest = request.path.startsWith("/v1/models/")
    ? request.path.slice("/v1/models/".length)
    : undefined;

  return respondModels(models, info, options, rest);
};

/** Lists whose order is Go map-iteration order are compared after sorting. */
const UNORDERED = new Map([
  ["openai list", { data: "id" }],
  ["gemini list", { models: "name" }],
]);

describe("listing parity with the Go handlers", () => {
  for (const scenario of fixture.scenarios) {
    describe(scenario.name, () => {
      it.each(scenario.requests.map((request) => [request.name, request] as const))(
        "%s",
        (_name, request) => {
          const reply = replyFor(scenario, request);
          expect(reply.status).toBe(request.status);
          const sort = UNORDERED.get(request.name);

          // Structural: key order and HTML escaping are not part of the contract.
          expect(sortedBody(reply.body, sort ?? {})).toEqual(sortedBody(request.body, sort ?? {}));
        },
      );
    });
  }
});

describe("Claude ID cloaking", () => {
  it("cloaks ids without the claude- prefix and reverses by code points", () => {
    expect(ensureClaudeModelIdPrefix("gpt-5")).toBe("claude-fable-5-dd-5-tpg");
    expect(ensureClaudeModelIdPrefix("claude-opus")).toBe("claude-opus");
    expect(ensureClaudeModelIdPrefix("")).toBe("");
    expect(ensureClaudeModelIdPrefix("模型-1")).toBe("claude-fable-5-dd-1-型模");
  });

  it("resolves cloaked ids and keeps a thinking suffix", () => {
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-5-tpg")).toBe("gpt-5");
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-5-tpg(high)")).toBe("gpt-5(high)");
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-")).toBe("claude-fable-5-dd-");
    expect(resolveClaudeModelIdPrefix("gpt-5")).toBe("gpt-5");
  });
});

describe("Codex client catalog (client_version) parity with Go", () => {
  const SUMMARY_KEYS = [
    "slug",
    "priority",
    "display_name",
    "description",
    "supported_reasoning_levels",
    "default_reasoning_level",
    "input_modalities",
    "supports_image_detail_original",
    "visibility",
    "apply_patch_tool_type",
    "supports_search_tool",
    "prefer_websockets",
    "multi_agent_version",
    "cpa_capabilities",
    "context_window",
    "max_context_window",
    "max_tokens",
    "service_tiers",
    "available_in_plans",
    "upgrade",
    "availability_nux",
  ];

  for (const scenario of fixture.scenarios) {
    describe(scenario.name, () => {
      const index = scenarioIndex(scenario);

      const build = (variant: string, clientVersion: string) =>
        buildCodexClientModels({
          catalog: catalogs.codexClient,
          models: index.availableModels(fixtureNow()),
          providersForModel: (id) => index.providersForModel(id),
          lookupModelInfo: (id, provider = "") => index.lookupModelInfo(catalogs, id, provider),
          webSearchCapability: (id) => index.responsesWebSearchCapability(id),
          // The Go harness has no auth manager: the flag makes every model unsupported.
          ...(variant === "apply-patch-flag" ? { applyPatchCapability: () => false } : {}),
          optimizeMultiAgentV2: variant === "multi-agent-v2",
          clientVersion,
        });

      it.each(
        scenario.codexClient.map(
          (result) => [`${result.variant} ${result.version || "(empty)"}`, result] as const,
        ),
      )("%s", async (_name, result) => {
        expect(result.status).toBe(200);
        const payload = build(result.variant, result.version);
        const entries = (payload.models ?? []) as JsonObject[];
        const actualHashes: Record<string, string> = {};

        for (const entry of entries)
          actualHashes[entry.slug as string] = await sha256Hex(goCompactBytes(entry));

        // Readable first: per-model summaries where the fixture keeps them.
        if ((result.models ?? []).length > 0) {
          const summary = entries.map((entry) =>
            Object.fromEntries(
              SUMMARY_KEYS.map((key) => [key, entry[key] === undefined ? "<absent>" : entry[key]]),
            ),
          );

          expect(
            summary.toSorted((a, b) => asString(a.slug).localeCompare(asString(b.slug))),
          ).toEqual(
            (result.models ?? []).toSorted((a, b) => String(a.slug).localeCompare(String(b.slug))),
          );
        }

        expect(actualHashes).toEqual(result.entries);

        const priorities = entries.map((entry) =>
          typeof entry.priority === "number" ? entry.priority : 100,
        );

        expect(priorities).toEqual(priorities.toSorted((a, b) => a - b));

        // Ties follow Go's map iteration order; scenarios without ties must match the whole body.
        if (scenario.name !== "catalog-all") {
          expect(await sha256Hex(goCompactBytes(payload))).toBe(result.sha256);
          expect(new TextEncoder().encode(goCompactBytes(payload)).length).toBe(result.size);
        }
      });
    });
  }

  it("answers the client_version route with the compact catalog and exposes apply_patch support rules", () => {
    expect(supportsApplyPatchProviders(["codex", "claude"])).toBe(true);
    expect(supportsApplyPatchProviders(["codex", "aistudio"])).toBe(false);
    expect(supportsApplyPatchProviders([])).toBe(false);
    expect(supportsApplyPatchProviders(["openai-compatible-foo"])).toBe(true);
  });
});

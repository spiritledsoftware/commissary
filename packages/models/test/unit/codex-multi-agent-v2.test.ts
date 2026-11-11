// Codex multi-agent v2 / orphan delegation rewriting against the real Go functions
// (`go run ./tools/fixturegen/multiagent`).
import { describe, expect, it } from "vitest";
import {
  hasCodexMultiAgentV2NamespaceConflict,
  optimizeCodexMultiAgentV2RequestForAuth,
  optimizeCodexMultiAgentV2Request,
  prepareCodexMultiAgentV2Tools,
  restoreCodexMultiAgentV2Response,
  rewriteCodexMultiAgentV2Input,
  rewriteCodexOrphanDelegationInputForConfig,
  type SpawnAgentSource,
} from "../../src/executor/helps/codex-multi-agent-v2.ts";
import type { Json } from "@commissary/json";
import codexClientCatalog from "../../src/registry/catalog/codex_client_models.json";
import fixture from "../fixtures/multiagent.json";
import { configOf } from "../support/registry-sources.ts";
import { structuralBody } from "@commissary/translation/testing";

interface Combo {
  readonly userAgent: string;
  readonly subagent: string;
  readonly optimize: boolean;
  readonly orphan: boolean;
  readonly compat: boolean;
}

interface Result {
  readonly case: string;
  readonly combo: Combo;
  readonly orphan: string;
  readonly input: string;
  readonly prepare: string;
  readonly prepared: boolean;
  readonly optimize: string;
  readonly optimized: boolean;
  readonly forAuth: string;
  readonly forAuthOptimized: boolean;
  readonly conflict: boolean;
}

const blobs = fixture.blobs as Record<string, Json>;

const cases = fixture.cases as Record<string, Json>;

const source: SpawnAgentSource = {
  availableModels: fixture.available.map((model) => ({
    id: model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
  })),
  catalog: codexClientCatalog,
  lookupModel: (id) => {
    const found = (fixture.lookups as Record<string, { description?: string; levels?: string[] }>)[
      id
    ];

    return found === undefined
      ? undefined
      : {
          ...(found.description === undefined ? {} : { description: found.description }),
          thinking: { levels: found.levels ?? [] },
        };
  },
};

const configFor = (combo: Combo) =>
  configOf(
    `client:\n  codex:\n    optimize-multi-agent-v2: ${combo.optimize}\nupstream:\n  codex:\n    orphan-delegation-compatibility: ${combo.orphan}\n`,
  );

const headersFor = (combo: Combo): Headers => {
  const headers = new Headers();

  if (combo.userAgent !== "") headers.set("User-Agent", combo.userAgent);

  if (combo.subagent !== "") headers.set("X-Openai-Subagent", combo.subagent);

  return headers;
};

/** The Go output for a blob reference ("" = the input unchanged); compared order-sensitively. */
const expectSame = (actual: Json, ref: string, input: Json, label: string): void => {
  const expected = ref === "" ? input : (blobs[ref] as Json);
  expect(actual, label).toEqual(expected);
  expect(JSON.stringify(actual), `${label} key order`).toBe(JSON.stringify(expected));
};

describe("Codex multi-agent v2 rewriting (Go parity)", () => {
  it("rewrites orphan delegations, agent messages, tool definitions and namespaces like Go", () => {
    expect(fixture.results.length).toBeGreaterThan(800);

    for (const result of fixture.results as unknown as Result[]) {
      const input = cases[result.case] as Json;
      const copy = (): Json => structuredClone(input);
      const config = configFor(result.combo);
      const headers = headersFor(result.combo);
      const label = `${result.case} ${JSON.stringify(result.combo)}`;

      expectSame(
        rewriteCodexOrphanDelegationInputForConfig(headers, copy(), config),
        result.orphan,
        input,
        `${label} orphan`,
      );
      expectSame(
        rewriteCodexMultiAgentV2Input(headers, copy(), config, result.combo.compat),
        result.input,
        input,
        `${label} input`,
      );

      const prepared = prepareCodexMultiAgentV2Tools(
        headers,
        copy(),
        result.combo.optimize,
        source,
      );

      expectSame(prepared.payload, result.prepare, input, `${label} prepare`);
      expect(prepared.prepared, `${label} prepared`).toBe(result.prepared);
      const optimized = optimizeCodexMultiAgentV2Request(headers, copy(), config, { source });
      expectSame(optimized.payload, result.optimize, input, `${label} optimize`);
      expect(optimized.optimized, `${label} optimized`).toBe(result.optimized);

      const forAuth = optimizeCodexMultiAgentV2RequestForAuth(
        headers,
        copy(),
        config,
        result.combo.compat,
        { source },
      );

      expectSame(forAuth.payload, result.forAuth, input, `${label} forAuth`);
      expect(forAuth.optimized, `${label} forAuth optimized`).toBe(result.forAuthOptimized);
      expect(hasCodexMultiAgentV2NamespaceConflict(copy()), `${label} conflict`).toBe(
        result.conflict,
      );
    }
  });

  it("restores the collaboration namespace in upstream payloads like Go", () => {
    for (const restore of fixture.restores) {
      // Structural: Go re-marshals with sorted keys and HTML escaping, Commissary keeps the payload's order.
      expect(
        structuralBody(restoreCodexMultiAgentV2Response(restore.input, true)),
        restore.case,
      ).toEqual(structuralBody(restore.restored));
      expect(
        restoreCodexMultiAgentV2Response(restore.input, false),
        `${restore.case} (disabled)`,
      ).toBe(restore.input);
    }
  });

  it("lists the available models in the spawn_agent description (template models first, then by display name)", () => {
    const combo: Combo = {
      userAgent: "codex-tui/0.150.0",
      subagent: "",
      optimize: true,
      orphan: false,
      compat: false,
    };

    const payload = structuredClone(cases["collaboration-tools"]) as {
      tools: Array<{ name: string; description: string }>;
    };

    prepareCodexMultiAgentV2Tools(headersFor(combo), payload, true, source);
    const description = payload.tools[0]?.description ?? "";
    expect(description).toContain(
      "Available model overrides (optional; inherited parent model is preferred):",
    );
    expect(description).not.toContain("`older`");
    expect(description.indexOf("Spawns an agent")).toBeGreaterThan(
      description.indexOf("Available model overrides"),
    );
    expect(description).toMatch(
      /- `custom-b`: custom-b\. Reasoning efforts: low, medium \(default\), high\./,
    );
  });
});

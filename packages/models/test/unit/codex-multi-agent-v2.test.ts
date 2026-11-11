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

/**
 * Ported ahead of the fixture. B6 (#366) refreshes the bundled `codex_client_models.json` (CLIProxyAPI 19398539), which
 * the `spawn_agent` model list reads: `gpt-5.5` moved and the non-Codex fallback levels changed. Only the
 * `collaboration-tools` payloads that list the models differ (40 results x prepare/optimize/forAuth, two distinct
 * outputs). Each row maps the fixture's blob reference to the SHA-256 of `JSON.stringify` of the blob Go now produces.
 * Recipe (also in the comment on #388): unpack the fixture's upstream base, `git archive 67465884` of CLIProxyAPI, apply
 * 8df4e42a, a1eeb60e and 19398539 (the models.go edits and the new `codex_client_models.json`), then from a go.work over
 * that tree and `tools/fixturegen` run `go run ./tools/fixturegen/multiagent -out /tmp/multiagent.json`. The fixture
 * stays untouched: F2 (#388) regenerates it and deletes this table.
 */
const AHEAD_OF_FIXTURE = new Map([
  ["47d5808dc495895e", "6023210e1fab4c0b2b3cabe61e78871859f40e2405d07a37e301bffb0f963a12"],
  ["f65d87182b62398c", "dcffa6fd9e335a52f870aedf426d0d7e83dee4325e81770103023e26b9437d20"],
]);

const usedAhead = new Set<string>();

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The Go output for a blob reference ("" = the input unchanged); compared order-sensitively. */
const expectSame = async (actual: Json, ref: string, input: Json, label: string): Promise<void> => {
  const ahead = AHEAD_OF_FIXTURE.get(ref);

  if (ahead !== undefined) {
    usedAhead.add(ref);
    // The fixture's blob must still differ from what Go answers now, or the row is stale.
    expect(await sha256Hex(JSON.stringify(blobs[ref])), `${label} stale`).not.toBe(ahead);
    expect(await sha256Hex(JSON.stringify(actual)), label).toBe(ahead);

    return;
  }

  const expected = ref === "" ? input : (blobs[ref] as Json);
  expect(actual, label).toEqual(expected);
  expect(JSON.stringify(actual), `${label} key order`).toBe(JSON.stringify(expected));
};

describe("Codex multi-agent v2 rewriting (Go parity)", () => {
  it("rewrites orphan delegations, agent messages, tool definitions and namespaces like Go", async () => {
    expect(fixture.results.length).toBeGreaterThan(800);

    for (const result of fixture.results as unknown as Result[]) {
      const input = cases[result.case] as Json;
      const copy = (): Json => structuredClone(input);
      const config = configFor(result.combo);
      const headers = headersFor(result.combo);
      const label = `${result.case} ${JSON.stringify(result.combo)}`;

      await expectSame(
        rewriteCodexOrphanDelegationInputForConfig(headers, copy(), config),
        result.orphan,
        input,
        `${label} orphan`,
      );
      await expectSame(
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

      await expectSame(prepared.payload, result.prepare, input, `${label} prepare`);
      expect(prepared.prepared, `${label} prepared`).toBe(result.prepared);
      const optimized = optimizeCodexMultiAgentV2Request(headers, copy(), config, { source });
      await expectSame(optimized.payload, result.optimize, input, `${label} optimize`);
      expect(optimized.optimized, `${label} optimized`).toBe(result.optimized);

      const forAuth = optimizeCodexMultiAgentV2RequestForAuth(
        headers,
        copy(),
        config,
        result.combo.compat,
        { source },
      );

      await expectSame(forAuth.payload, result.forAuth, input, `${label} forAuth`);
      expect(forAuth.optimized, `${label} forAuth optimized`).toBe(result.forAuthOptimized);
      expect(hasCodexMultiAgentV2NamespaceConflict(copy()), `${label} conflict`).toBe(
        result.conflict,
      );
    }
  });

  it("consumed every ahead-of-fixture blob", () => {
    expect([...AHEAD_OF_FIXTURE.keys()].filter((ref) => !usedAhead.has(ref))).toEqual([]);
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

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { CatalogStore } from "../src/registry/catalog-store.ts";
import { lookupStaticModelInfo } from "../src/registry/catalog.ts";
import { ModelRegistry, ModelRegistryError, SNAPSHOT_TTL_MS } from "../src/registry/service.ts";
import type { ModelSource } from "../src/registry/source.ts";
import {
  applyThinking,
  type ModelInfoLookup,
  type ThinkingModelInfo,
} from "@commissary/translation/thinking";
import { catalogs, canonOf } from "./support/registry.ts";
import { FakeKv, fakeConfig } from "./support/registry-refresh.ts";
import { source } from "./support/registry-sources.ts";
import { thinkingFixture } from "@commissary/translation/testing";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { envContext } from "./support/context.ts";

/** An env whose ControlPlane stub serves `sources()`; counts the RPCs. */
const fakeControlPlane = (sources: () => ReadonlyArray<ModelSource>, calls: { count: number }) =>
  Layer.succeedContext(
    envContext({
      CACHE: new FakeKv() as unknown as KVNamespace,
      CONTROL_PLANE: {
        getByName: () => ({
          models: () => ({
            listModelSources: async () => {
              calls.count += 1;

              return sources();
            },
            grantTable: () => ({ version: 1, grants: [], teams: [] }),
          }),
        }),
      },
    } as unknown as Cloudflare.Env),
  );

const serviceLayer = (yaml = "") =>
  ModelRegistry.layer.pipe(Layer.provide(Layer.mergeAll(fakeConfig(yaml), CatalogStore.layer)));

describe("ModelRegistry service", () => {
  it.effect("builds a snapshot from ControlPlane sources and caches it for the TTL", () => {
    const calls = { count: 0 };
    let credentials: ModelSource[] = [source("claude-a.json", "claude")];

    return Effect.gen(function* () {
      const registry = yield* ModelRegistry;
      const first = yield* registry.snapshot;
      assert.deepStrictEqual(first.providersForModel("claude-sonnet-4-5-20250929"), ["claude"]);
      assert.deepStrictEqual(first.providersForModel("CLAUDE-SONNET-4-5-20250929"), ["claude"]);
      assert.deepStrictEqual(first.providersForModel("gpt-5.5"), []);
      assert.isDefined(first.modelsForCredential("claude-a.json").length);
      assert.isTrue(first.credentialSupportsModel("claude-a.json", "Claude-Sonnet-4-5-20250929"));

      credentials = [source("codex-a.json", "codex", { planType: "pro" })];
      yield* TestClock.adjust(SNAPSHOT_TTL_MS - 1);
      assert.strictEqual(yield* registry.snapshot, first);
      assert.strictEqual(calls.count, 1);

      yield* TestClock.adjust(2);
      const second = yield* registry.snapshot;
      assert.notStrictEqual(second, first);
      assert.deepStrictEqual(second.providersForModel("gpt-5.5"), ["codex"]);
      assert.deepStrictEqual(second.providersForModel("claude-sonnet-4-5-20250929"), []);
      assert.strictEqual(second.firstAvailableModel() !== undefined, true);
    }).pipe(
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
      Effect.provide(serviceLayer()),
      Effect.provide(fakeControlPlane(() => credentials, calls)),
    );
  });

  it.effect(
    "fresh rebuilds inside the TTL, keeps the sources and replaces the cached snapshot",
    () => {
      const calls = { count: 0 };
      let credentials: ModelSource[] = [source("claude-a.json", "claude")];

      return Effect.gen(function* () {
        const registry = yield* ModelRegistry;
        const first = yield* registry.snapshot;
        assert.deepStrictEqual(
          first.sources.map((entry) => entry.id),
          ["claude-a.json"],
        );
        assert.strictEqual(first.configVersion, 1);

        credentials = [source("codex-b.json", "codex", { planType: "pro" }), ...credentials];
        assert.strictEqual(yield* registry.snapshot, first);

        const fresh = yield* registry.fresh;
        assert.notStrictEqual(fresh, first);
        assert.strictEqual(calls.count, 2);
        assert.deepStrictEqual(
          fresh.sources.map((entry) => entry.id),
          ["claude-a.json", "codex-b.json"],
        );
        assert.deepStrictEqual(fresh.providersForModel("gpt-5.5"), ["codex"]);
        // The normal reader now serves the fresh build within the TTL.
        assert.strictEqual(yield* registry.snapshot, fresh);
        assert.strictEqual(calls.count, 2);
      }).pipe(
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
        Effect.provide(serviceLayer()),
        Effect.provide(fakeControlPlane(() => credentials, calls)),
      );
    },
  );

  it.effect("fresh reports a failure instead of serving the cached snapshot", () => {
    const calls = { count: 0 };
    let failing = false;

    const sources = () => {
      if (failing) throw new Error("do unreachable");

      return [source("claude-a.json", "claude")];
    };

    return Effect.gen(function* () {
      const registry = yield* ModelRegistry;
      const first = yield* registry.snapshot;
      failing = true;
      const error = yield* registry.fresh.pipe(Effect.flip);
      assert.instanceOf(error, ModelRegistryError);
      assert.strictEqual(yield* registry.snapshot, first);
    }).pipe(
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
      Effect.provide(serviceLayer()),
      Effect.provide(fakeControlPlane(sources, calls)),
    );
  });

  it.effect(
    "serves the previous snapshot when the ControlPlane fails, and fails without one",
    () => {
      const calls = { count: 0 };
      let failing = false;

      const sources = () => {
        if (failing) throw new Error("do unreachable");

        return [source("claude-a.json", "claude")];
      };

      return Effect.gen(function* () {
        const registry = yield* ModelRegistry;
        failing = true;
        const error = yield* registry.snapshot.pipe(Effect.flip);
        assert.instanceOf(error, ModelRegistryError);

        failing = false;
        const first = yield* registry.snapshot;
        failing = true;
        yield* TestClock.adjust(SNAPSHOT_TTL_MS + 1);
        assert.strictEqual(yield* registry.snapshot, first);
      }).pipe(
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
        Effect.provide(serviceLayer()),
        Effect.provide(fakeControlPlane(sources, calls)),
      );
    },
  );

  it.effect("model records satisfy the thinking pipeline's lookup and drive applyThinking", () => {
    const calls = { count: 0 };

    return Effect.gen(function* () {
      const registry = yield* ModelRegistry;
      const snapshot = yield* registry.snapshot;
      const lookup: ModelInfoLookup = snapshot.lookupModelInfo;
      const info = lookup("claude-sonnet-4-5-20250929", "claude");
      expect(info?.thinking).toMatchObject({ min: 1024, max: 128000, zeroAllowed: true });

      const apply = (budget: number) =>
        applyThinking(
          {
            model: "claude-sonnet-4-5-20250929",
            messages: [],
            max_tokens: 4096,
            thinking: { type: "enabled", budget_tokens: budget },
          },
          {
            model: "claude-sonnet-4-5-20250929",
            fromFormat: "claude",
            toFormat: "claude",
            lookupModelInfo: lookup,
          },
        );

      expect(apply(2048).error).toBeUndefined();
      // The registry's capabilities (min 1024) reject a budget below the range.
      expect(apply(100).error?.code).toBe("BUDGET_OUT_OF_RANGE");
      // Unregistered models fall back to the static catalogs, unknown ones stay unknown.
      expect(lookup("gemini-2.5-pro", "gemini")?.id).toBe("gemini-2.5-pro");
      expect(lookup("no-such-model", "claude")).toBeUndefined();
      expect(snapshot.modelOverrideHeaders("gpt-5.6-luna", "codex")).toMatchObject({
        originator: "codex-tui",
      });
      expect(snapshot.modelOverrideHeaders("claude-sonnet-4-5-20250929", "claude")).toBeUndefined();
      expect(snapshot.responsesWebSearchCapability("claude-sonnet-4-5-20250929")).toBeUndefined();
    }).pipe(
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
      Effect.provide(serviceLayer()),
      Effect.provide(fakeControlPlane(() => [source("claude-a.json", "claude")], calls)),
    );
  });
});

/** The thinking capabilities of a model (the fixture also records web search support, for translation's tests). */
const thinkingFields = (info: ThinkingModelInfo | undefined) => ({
  id: info?.id,
  type: info?.type,
  userDefined: info?.userDefined,
  supportConfigurationUpdate: info?.supportConfigurationUpdate,
  maxCompletionTokens: info?.maxCompletionTokens,
  thinking: info?.thinking,
});

describe("static lookups agree with the thinking fixtures' Go catalog", () => {
  it("returns the same capabilities for every catalog model", () => {
    const ids = Object.keys(thinkingFixture.catalog);
    expect(ids.length).toBeGreaterThan(100);

    // Go resolves Devin models from the raw section; the catalog has the aggregated list only (ADR 0020).
    for (const id of ids.filter((entry) => !entry.startsWith("devin/"))) {
      const expected = thinkingFixture.catalog[id];
      const actual = lookupStaticModelInfo(catalogs, id);
      expect(actual, id).toBeDefined();

      expect(canonOf(thinkingFields(actual)), id).toEqual(canonOf(thinkingFields(expected)));
    }
  });
});

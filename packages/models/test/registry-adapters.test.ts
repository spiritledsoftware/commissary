// Adapters between the pipeline services and the model registry snapshot.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ExecutionError } from "../src/executor/errors.ts";
import { ModelCapabilities } from "../src/handlers/model-capabilities.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import { embeddedCatalogs } from "../src/registry/catalog.ts";
import { buildSnapshot, ModelRegistry, ModelRegistryError } from "../src/registry/service.ts";
import { configOf, source } from "./support/registry-sources.ts";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { get } from "@commissary/json";
import { applyThinking } from "@commissary/translation/thinking";
import { envContext } from "./support/context.ts";

const snapshot = (yaml = "") =>
  buildSnapshot({
    sources: [
      source("claude-a.json", "claude"),
      source("codex-a.json", "codex", { planType: "pro" }),
    ],
    config: configOf(yaml),
    catalogs: embeddedCatalogs(),
    now: 1_800_000_000_000,
  });

const registryLayer = (yaml = "") =>
  Layer.succeed(
    ModelRegistry,
    ModelRegistry.of({
      snapshot: Effect.succeed(snapshot(yaml)),
      fresh: Effect.succeed(snapshot(yaml)),
    }),
  );

const unavailable = Effect.fail(new ModelRegistryError({ message: "no control plane" }));

const failingRegistry = Layer.succeed(
  ModelRegistry,
  ModelRegistry.of({ snapshot: unavailable, fresh: unavailable }),
);

const env = Layer.succeedContext(envContext({} as Cloudflare.Env));

describe("ModelProviders.registryLayer", () => {
  it.effect("resolves providers and the auto model from the registry snapshot", () =>
    Effect.gen(function* () {
      const models = yield* ModelProviders;
      assert.deepStrictEqual(yield* models.providersFor("claude-sonnet-4-5-20250929"), ["claude"]);
      assert.deepStrictEqual(yield* models.providersFor("CLAUDE-SONNET-4-5-20250929"), ["claude"]);
      assert.deepStrictEqual(yield* models.providersFor("no-such-model"), []);
      assert.isDefined(yield* models.firstAvailableModel);
    }).pipe(
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
      Effect.provide(ModelProviders.registryLayer),
      Effect.provide(registryLayer()),
      Effect.provide(env),
    ),
  );

  it.effect("a registry failure becomes a 503", () =>
    Effect.gen(function* () {
      const models = yield* ModelProviders;
      const error = yield* Effect.flip(models.providersFor("x"));
      assert.instanceOf(error, ExecutionError);
      assert.strictEqual(error.status, 503);
    }).pipe(
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
      Effect.provide(ModelProviders.registryLayer),
      Effect.provide(failingRegistry),
      Effect.provide(env),
    ),
  );
});

describe("ModelCapabilities.registryLayer", () => {
  const credential = (id: string, provider: string) => ({
    id,
    provider,
    kind: "oauth" as const,
    attributes: {},
    metadata: {},
  });

  it.effect(
    "resolves the model definition of the credential and hands out the registry lookup",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* ModelCapabilities;

        const claude = yield* capabilities.thinking(
          "claude-sonnet-4-5-20250929",
          credential("claude-a.json", "claude"),
        );

        assert.strictEqual(claude.modelInfo?.id, "claude-sonnet-4-5-20250929");
        assert.isDefined(claude.modelInfo?.thinking);
        assert.isDefined(claude.lookup);
        assert.strictEqual(
          claude.lookup?.("claude-sonnet-4-5-20250929", "claude")?.id,
          "claude-sonnet-4-5-20250929",
        );
      }).pipe(
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
        Effect.provide(ModelCapabilities.registryLayer),
        Effect.provide(registryLayer()),
        Effect.provide(env),
      ),
  );

  it.effect(
    "falls back to the catalog lookup for credentials the registry does not know, and to unknown",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* ModelCapabilities;

        const stranger = yield* capabilities.thinking(
          "claude-sonnet-4-5-20250929",
          credential("claude-gone.json", "claude"),
        );

        assert.strictEqual(stranger.modelInfo?.id, "claude-sonnet-4-5-20250929");

        const unknown = yield* capabilities.thinking(
          "no-such-model",
          credential("claude-a.json", "claude"),
        );

        assert.isUndefined(unknown.modelInfo);
      }).pipe(
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
        Effect.provide(ModelCapabilities.registryLayer),
        Effect.provide(registryLayer()),
        Effect.provide(env),
      ),
  );

  it.effect(
    "the catalog says how each Claude variant turns thinking off, so disabled requests do not 400",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* ModelCapabilities;

        const turnOff = (model: string) =>
          Effect.gen(function* () {
            const resolved = yield* capabilities.thinking(
              model,
              credential("claude-a.json", "claude"),
            );

            const result = applyThinking(
              { model, messages: [], thinking: { type: "disabled" } },
              {
                model,
                fromFormat: "claude",
                toFormat: "claude",
                providerKey: "claude",
                ...(resolved.modelInfo === undefined ? {} : { modelInfo: resolved.modelInfo }),
                ...(resolved.lookup === undefined ? {} : { lookupModelInfo: resolved.lookup }),
              },
            );

            assert.isUndefined(result.error);

            return result.body;
          });

        // claude-sonnet-5-5 rejects `disabled`: its dated and context variants share its catalog entry.
        for (const model of [
          "claude-sonnet-5-5",
          "claude-sonnet-5-5[1m]",
          "claude-sonnet-5-5-20261001",
        ])
          assert.deepStrictEqual(
            get(yield* turnOff(model), "thinking"),
            { type: "between_tools" },
            model,
          );

        // claude-opus-5-5 cannot be turned off at all: adaptive at the lowest level, nothing displayed.
        for (const model of ["claude-opus-5-5", "claude-opus-5-5[1m]"]) {
          const body = yield* turnOff(model);
          assert.deepStrictEqual(
            get(body, "thinking"),
            { type: "adaptive", display: "omitted" },
            model,
          );
          assert.strictEqual(get(body, "output_config.effort"), "low", model);
        }

        assert.deepStrictEqual(get(yield* turnOff("claude-opus-5"), "thinking"), {
          type: "disabled",
        });
      }).pipe(
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
        Effect.provide(ModelCapabilities.registryLayer),
        Effect.provide(registryLayer()),
        Effect.provide(env),
      ),
  );

  it.effect("a registry failure degrades to unknown capabilities (no validation)", () =>
    Effect.gen(function* () {
      const capabilities = yield* ModelCapabilities;
      const resolved = yield* capabilities.thinking("m", credential("claude-a.json", "claude"));
      assert.deepStrictEqual(resolved, { modelInfo: undefined, lookup: undefined });
    }).pipe(
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
      Effect.provide(ModelCapabilities.registryLayer),
      Effect.provide(failingRegistry),
      Effect.provide(env),
    ),
  );
});

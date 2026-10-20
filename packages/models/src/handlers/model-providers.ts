/**
 * Model -> provider lookup used by model resolution.
 *
 * Go source: internal/registry/model_registry.go (GetModelProviders, GetFirstAvailableModel). The model registry
 * slice replaces the config-backed implementation below with the full catalog (static models, OAuth credentials,
 * availability/quota state); the service interface stays the same.
 */
import { Context, Effect, Layer, Option } from "effect";
import { AccessPrincipal } from "@commissary/auth";
import { ConfigReader } from "../config/reader.ts";
import { configCredentials, openAICompatModelIds } from "../executor/config-credentials.ts";
import { ExecutionError } from "../executor/errors.ts";
import type { SpawnAgentSource } from "../executor/helps/codex-multi-agent-v2.ts";
import type { CurrentOrg } from "@commissary/core";
import { callerView, runModelFilter } from "../registry/caller-view.ts";
import { ModelRegistry } from "../registry/service.ts";
import type { ModelsEnv } from "../env.ts";

/** The base of a model name as clients send it: without its thinking suffix, case aside. */
export class ModelProviders extends Context.Service<
  ModelProviders,
  {
    /** Providers able to serve exactly this model id, in preference order (Go `GetModelProviders`). */
    readonly providersFor: (
      model: string,
    ) => Effect.Effect<ReadonlyArray<string>, ExecutionError, ModelsEnv | CurrentOrg>;
    /** First available model of any provider (Go `GetFirstAvailableModel("")`), used for `auto`. */
    readonly firstAvailableModel: Effect.Effect<
      string | undefined,
      ExecutionError,
      ModelsEnv | CurrentOrg
    >;
    /**
     * Registry type of `model` (`registry.LookupModelInfo(model).Type`, e.g. `openai-image`); `undefined` when the
     * model is unknown. Optional so test doubles that only route models need not implement it.
     */
    readonly modelType?: (
      model: string,
    ) => Effect.Effect<string | undefined, ExecutionError, ModelsEnv | CurrentOrg>;
    /**
     * The registry data behind the `spawn_agent` model list of Codex multi-agent v2 requests (available models, the
     * Codex client catalog, model lookups). Optional like `modelType`.
     */
    readonly spawnAgentSource?: Effect.Effect<
      SpawnAgentSource,
      ExecutionError,
      ModelsEnv | CurrentOrg
    >;
  }
>()("commissary/handlers/ModelProviders") {
  /**
   * The model registry: every credential's catalog (prefixes, aliases, exclusions, cooling state) as of the current
   * snapshot (requires `ModelRegistry`).
   */
  static readonly registryLayer = Layer.effect(
    ModelProviders,
    Effect.gen(function* () {
      const registry = yield* ModelRegistry;

      const snapshot = registry.snapshot.pipe(
        Effect.mapError(
          (cause) =>
            new ExecutionError({ status: 503, message: "model registry unavailable", cause }),
        ),
      );

      // What the caller may use (ADR 0023): the registry as their grants and private credentials leave it, so a
      // model they cannot reach has no provider and answers like an unknown one. A shared agent's run (#227, ADR 0040)
      // acts as the agent, whose reach is its definition: the org's shared credentials, whatever the grants.
      const visible = Effect.gen(function* () {
        const principal = Option.getOrUndefined(yield* Effect.serviceOption(AccessPrincipal));

        return callerView(yield* snapshot, principal);
      });

      // An agent run reaches its definition's model alone (ADR 0040): any other, `auto` included, has no provider.
      const reachable = Effect.map(Effect.serviceOption(AccessPrincipal), (principal) =>
        runModelFilter(Option.getOrUndefined(principal)),
      );

      return ModelProviders.of({
        providersFor: (model) =>
          Effect.gen(function* () {
            const only = yield* reachable;

            if (only !== undefined && !only(model)) return [];

            return (yield* visible).providersForModel(model);
          }),
        firstAvailableModel: Effect.gen(function* () {
          if ((yield* reachable) !== undefined) return undefined;

          return (yield* visible).firstAvailableModel();
        }),
        modelType: (model) =>
          Effect.map(snapshot, (current) => current.lookupModelInfo(model, "")?.type),
        // The model list a request may name: a private credential's models are its owner's (ADR 0023).
        spawnAgentSource: Effect.gen(function* () {
          const current = yield* visible;

          return {
            availableModels: current.availableModels().map((model) => ({
              id: model.id,
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
            })),
            catalog: current.catalogs.codexClient,
            lookupModel: (modelId) => current.lookupModelInfo(modelId, ""),
          } satisfies SpawnAgentSource;
        }),
      });
    }),
  );

  /** Models declared under `api-keys.openai-compatibility` (requires `ConfigReader`); tests without a registry. */
  static readonly configLayer = Layer.effect(
    ModelProviders,
    Effect.gen(function* () {
      const reader = yield* ConfigReader;

      const imageModels = reader.get.pipe(
        Effect.mapError(
          (cause) => new ExecutionError({ status: 503, message: "config unavailable", cause }),
        ),
        Effect.map(({ config }) => {
          const ids = new Set<string>();

          for (const group of config["api-keys"]["openai-compatibility"]) {
            if (group.disabled === true) continue;
            const images = new Set((group.models ?? []).filter((entry) => entry.image === true));

            for (const id of openAICompatModelIds(
              { ...group, models: [...images] },
              config.routing["force-model-prefix"],
            )) {
              ids.add(id);
            }
          }

          return ids;
        }),
      );

      const index = reader.get.pipe(
        Effect.mapError(
          (cause) => new ExecutionError({ status: 503, message: "config unavailable", cause }),
        ),
        Effect.map(({ config }) => {
          const byModel = new Map<string, string[]>();

          for (const entry of configCredentials(config)) {
            for (const model of entry.models) {
              const providers = byModel.get(model) ?? [];

              if (!providers.includes(entry.credential.provider))
                providers.push(entry.credential.provider);
              byModel.set(model, providers);
            }
          }

          return byModel;
        }),
      );

      return ModelProviders.of({
        providersFor: (model) => Effect.map(index, (byModel) => byModel.get(model) ?? []),
        firstAvailableModel: Effect.map(index, (byModel) => byModel.keys().next().value),
        modelType: (model) =>
          Effect.map(imageModels, (ids) => (ids.has(model) ? "openai-image" : undefined)),
      });
    }),
  );
}

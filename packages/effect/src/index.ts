import {
  Agent,
  commissary,
  type AgentDefinition,
  type ArtifactStore,
  type CommissaryInstance,
  type Driver,
  type ThreadStore,
} from "@commissary/core";
import { modelEnvironment } from "@commissary/core/internal";
import { Context, Effect, Layer } from "effect";

export interface EffectCommissaryConfiguration<Agents extends readonly AgentDefinition[]> {
  readonly threadStore: ThreadStore;
  readonly artifactStore?: ArtifactStore;
  readonly agents: Agents;
  readonly driver?: Driver;
}

export class Commissary extends Context.Service<Commissary, CommissaryInstance>()(
  "@commissary/effect/Commissary",
) {}

type Requirements<Agents extends readonly AgentDefinition[]> = Agent.Requirements<Agents[number]>;

function make<const Agents extends readonly AgentDefinition[]>(
  configuration: EffectCommissaryConfiguration<Agents>,
): Effect.Effect<CommissaryInstance<Agents>, never, Requirements<Agents>> {
  return Effect.context<Requirements<Agents>>().pipe(
    Effect.map((environment) =>
      commissary({
        threadStore: configuration.threadStore,
        ...(configuration.artifactStore === undefined
          ? {}
          : { artifactStore: configuration.artifactStore }),
        agents: configuration.agents,
        ...(configuration.driver === undefined ? {} : { driver: configuration.driver }),
        [modelEnvironment]: environment,
      }),
    ),
  );
}

function layer<const Agents extends readonly AgentDefinition[]>(
  configuration: EffectCommissaryConfiguration<Agents>,
): Layer.Layer<Commissary, never, Requirements<Agents>> {
  return Layer.effect(Commissary, make(configuration));
}

export const EffectCommissary = {
  make,
  layer,
};

import { Agent, type ThreadStore } from "@commissary/core";
import { Context, Effect, Layer } from "effect";
import { LanguageModel, Model as AiModel } from "effect/unstable/ai";
import { expect, expectTypeOf, it } from "vitest";

import { EffectAi } from "../src/ai.js";
import {
  Commissary,
  EffectCommissary,
  type EffectCommissaryInstance,
  type EffectAgentClient,
} from "../src/index.js";

class ModelDependency extends Context.Service<ModelDependency, { readonly value: string }>()(
  "commissary/test/ModelDependency",
) {}

const service = {} as LanguageModel.Service;
const layer = Layer.effect(LanguageModel.LanguageModel, Effect.as(ModelDependency, service));
const model = AiModel.make("example", "example-model", layer);
const fragment = EffectAi.model(model);
const agent = Agent.define({ id: "effect-agent", fragments: fragment });

const threadStore = {} as ThreadStore;
const construction = EffectCommissary.make({
  threadStore,
});
const commissaryLayer = EffectCommissary.layer({
  threadStore,
});
const installation = Effect.flatMap(construction, (instance) => instance.agent(agent));

it("preserves open Effect Model requirements through lazy Agent installation", async () => {
  expect(fragment).toBeDefined();
  expectTypeOf<Agent.Requirements<typeof agent>>().toEqualTypeOf<ModelDependency>();
  expectTypeOf(construction).toEqualTypeOf<Effect.Effect<EffectCommissaryInstance, never>>();
  expectTypeOf(commissaryLayer).toEqualTypeOf<Layer.Layer<Commissary>>();
  expectTypeOf(installation).toEqualTypeOf<
    Effect.Effect<EffectAgentClient<typeof agent>, unknown, ModelDependency>
  >();
  const instance = await Effect.runPromise(construction);
  const client = await Effect.runPromise(
    instance.agent(agent).pipe(Effect.provideService(ModelDependency, { value: "available" })),
  );
  expect(client.reference.id).toBe("effect-agent");
});

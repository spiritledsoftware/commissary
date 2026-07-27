import { Agent, type CommissaryInstance, type ThreadStore } from "@commissary/core";
import { Context, Effect, Layer } from "effect";
import { LanguageModel, Model as AiModel } from "effect/unstable/ai";
import { expect, expectTypeOf, it } from "vitest";

import { EffectAi } from "../src/ai.js";
import { Commissary, EffectCommissary } from "../src/index.js";

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
  agents: [agent] as const,
});
const commissaryLayer = EffectCommissary.layer({
  threadStore,
  agents: [agent] as const,
});

it("preserves open Effect Model requirements through Agent composition", () => {
  expect(fragment).toBeDefined();
  expectTypeOf<Agent.Requirements<typeof agent>>().toEqualTypeOf<ModelDependency>();
  expectTypeOf(construction).toMatchTypeOf<
    Effect.Effect<CommissaryInstance<readonly [typeof agent]>, never, ModelDependency>
  >();
  expectTypeOf(commissaryLayer).toMatchTypeOf<Layer.Layer<Commissary, never, ModelDependency>>();
});

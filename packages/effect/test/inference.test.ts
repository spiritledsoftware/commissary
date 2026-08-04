import {
  Agent,
  Codec,
  HookPoints,
  RunId,
  Tool,
  ToolCallId,
  type AgentCreateRunInput,
  type AgentInstallationError,
  type AgentRegistrationError,
  type AgentCreateRunResult,
  type AgentResumeRunResult,
  type AgentRunId,
  type ModelSchema,
  type ThreadStore,
} from "@commissary/core";
import { EffectAi } from "@commissary/effect/ai";
import {
  Commissary,
  EffectCommissary,
  type EffectAgentClient,
  type EffectCommissaryStartError,
  type EffectCommissaryInstance,
  type EffectExecution,
} from "@commissary/effect";
import type { StoreError } from "@commissary/store";
import { Context, Effect, Layer } from "effect";
import { LanguageModel, Model as AiModel } from "effect/unstable/ai";
import { expect, expectTypeOf, it } from "vitest";

class ModelDependency extends Context.Service<ModelDependency, { readonly value: string }>()(
  "commissary/test/ModelDependency",
) {}

const stringSchema: ModelSchema<string, string> = {
  "~standard": {
    version: 1,
    vendor: "commissary-effect-test",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
    jsonSchema: {
      input: () => ({ type: "string" }),
      output: () => ({ type: "string" }),
    },
  },
};

const numberSchema: ModelSchema<number, number> = {
  "~standard": {
    version: 1,
    vendor: "commissary-effect-test",
    validate: (value) =>
      typeof value === "number" ? { value } : { issues: [{ message: "Expected a number" }] },
    jsonSchema: {
      input: () => ({ type: "number" }),
      output: () => ({ type: "number" }),
    },
  },
};

const firstFailureSchema: ModelSchema<{ readonly code: "first" }, { readonly code: "first" }> = {
  "~standard": {
    version: 1,
    vendor: "commissary-effect-test",
    validate: (value) =>
      typeof value === "object" && value !== null && "code" in value && value.code === "first"
        ? { value: { code: "first" as const } }
        : { issues: [{ message: "Expected first failure" }] },
    jsonSchema: {
      input: () => ({ type: "object", properties: { code: { const: "first" } } }),
      output: () => ({ type: "object", properties: { code: { const: "first" } } }),
    },
  },
};

const firstEventSchema: ModelSchema<{ readonly percent: number }, { readonly percent: number }> = {
  "~standard": {
    version: 1,
    vendor: "commissary-effect-test",
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "percent" in value &&
      typeof value.percent === "number"
        ? { value: { percent: value.percent } }
        : { issues: [{ message: "Expected progress" }] },
    jsonSchema: {
      input: () => ({ type: "object", properties: { percent: { type: "number" } } }),
      output: () => ({ type: "object", properties: { percent: { type: "number" } } }),
    },
  },
};
const secondFailureSchema: ModelSchema<{ readonly code: "second" }, { readonly code: "second" }> = {
  "~standard": {
    version: 1,
    vendor: "commissary-effect-test",
    validate: (value) =>
      typeof value === "object" && value !== null && "code" in value && value.code === "second"
        ? { value: { code: "second" as const } }
        : { issues: [{ message: "Expected second failure" }] },
    jsonSchema: {
      input: () => ({ type: "object", properties: { code: { const: "second" } } }),
      output: () => ({ type: "object", properties: { code: { const: "second" } } }),
    },
  },
};

const secondEventSchema: ModelSchema<{ readonly message: string }, { readonly message: string }> = {
  "~standard": {
    version: 1,
    vendor: "commissary-effect-test",
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "message" in value &&
      typeof value.message === "string"
        ? { value: { message: value.message } }
        : { issues: [{ message: "Expected message" }] },
    jsonSchema: {
      input: () => ({ type: "object", properties: { message: { type: "string" } } }),
      output: () => ({ type: "object", properties: { message: { type: "string" } } }),
    },
  },
};

const continuation = Codec.define({
  encode: (value: string) => value,
  decode(value) {
    if (typeof value !== "string") {
      throw new Error("Expected an Effect string continuation");
    }
    return value;
  },
});

const firstTool = Tool.define({
  name: "first-effect-tool",
  input: stringSchema,
  output: numberSchema,
  failure: firstFailureSchema,
  event: firstEventSchema,
  handler: (input) => input.length,
  suspension: {
    resumeInput: stringSchema,
    continuation,
    resume: ({ input, continuation: state }) => state.length + input.length,
  },
});

const secondTool = Tool.define({
  name: "second-effect-tool",
  input: numberSchema,
  output: stringSchema,
  failure: secondFailureSchema,
  event: secondEventSchema,
  handler: (input) => String(input),
  suspension: {
    resumeInput: numberSchema,
    continuation,
    resume: ({ input, continuation: state }) => `${state}:${input}`,
  },
});

const dynamicProvider = Tool.dynamic({ id: "effect-dynamic", resolve: () => [] });
const service = {} as LanguageModel.Service;
const layer = Layer.effect(LanguageModel.LanguageModel, Effect.as(ModelDependency, service));
const model = AiModel.make("example", "example-model", layer);
const fragment = EffectAi.model(model);
const agent = Agent.define({
  id: "effect-agent",
  fragments: Agent.combine(fragment, firstTool, secondTool, dynamicProvider),
});
const otherAgent = Agent.define({ id: "other-effect-agent", fragments: fragment });

const threadStore = {} as ThreadStore;
const construction = EffectCommissary.make({
  threadStore,
});
const commissaryLayer = EffectCommissary.layer({
  threadStore,
});
const installation = Effect.flatMap(construction, (instance) => instance.agent(agent));

declare const client: EffectAgentClient<typeof agent>;
declare const otherClient: EffectAgentClient<typeof otherAgent>;
declare const createInput: AgentCreateRunInput;

it("preserves open Effect Model requirements through lazy Agent installation", async () => {
  expect(fragment).toBeDefined();
  expectTypeOf<Agent.Requirements<typeof agent>>().toEqualTypeOf<ModelDependency>();
  expectTypeOf(construction).toEqualTypeOf<Effect.Effect<EffectCommissaryInstance, never>>();
  expectTypeOf(commissaryLayer).toEqualTypeOf<Layer.Layer<Commissary>>();
  expectTypeOf(installation).toEqualTypeOf<
    Effect.Effect<
      EffectAgentClient<typeof agent>,
      AgentInstallationError | AgentRegistrationError,
      ModelDependency
    >
  >();
  const instance = await Effect.runPromise(construction);
  const installed = await Effect.runPromise(
    instance.agent(agent).pipe(Effect.provideService(ModelDependency, { value: "available" })),
  );
  expect(installed.reference.id).toBe("effect-agent");
});

it("mirrors the complete typed core Agent client", () => {
  const checkContracts = async () => {
    const created = client.createRun(createInput);
    expectTypeOf(created).toEqualTypeOf<
      Effect.Effect<AgentCreateRunResult<typeof agent>, StoreError>
    >();
    const accepted = await Effect.runPromise(created);
    if (accepted.type === "accepted") {
      const execution = client.execute(accepted.runId);
      expectTypeOf(execution).toEqualTypeOf<
        Effect.Effect<
          EffectExecution<
            Agent.Tools<typeof agent>,
            Agent.Failure<typeof agent>,
            AgentRunId<typeof agent>
          >,
          EffectCommissaryStartError
        >
      >();
      // @ts-expect-error bound Run IDs cannot cross Effect Agent clients
      void otherClient.execute(accepted.runId);
    }

    const runId = RunId.decode("effect-stored-run");
    void client.execute(runId);
    void client.readRunSnapshot(runId);
    void client.readResult(runId);
    void client.steer({
      runId,
      message: { role: "user", content: [] },
    });
    void client.redirect({
      runId,
      message: { role: "user", content: [] },
    });
    void client.abort(runId);
    const resumed = client.resumeRun({
      runId,
      items: [
        {
          toolName: "first-effect-tool",
          toolCallId: ToolCallId.decode("effect-static-call"),
          input: "continue",
        },
      ],
    });
    expectTypeOf(resumed).toEqualTypeOf<
      Effect.Effect<AgentResumeRunResult<typeof agent>, StoreError>
    >();
    void client.resumeRun({
      runId,
      items: [
        {
          dynamic: true,
          providerId: "effect-dynamic",
          toolName: "remote",
          toolCallId: ToolCallId.decode("effect-dynamic-call"),
          input: true,
        },
      ],
    });
    void client.resumeRun({
      runId,
      items: [
        // @ts-expect-error the dynamic provider does not widen static Tool names
        {
          toolName: "remote",
          toolCallId: ToolCallId.decode("effect-unmarked-call"),
          input: true,
        },
      ],
    });
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "tool-event" && event.dynamic !== true) {
        if (event.toolName === "first-effect-tool") {
          expectTypeOf(event.event).toEqualTypeOf<{ readonly percent: number }>();
        } else {
          expectTypeOf(event.toolName).toEqualTypeOf<"second-effect-tool">();
          expectTypeOf(event.event).toEqualTypeOf<{ readonly message: string }>();
        }
      }
      return undefined;
    });
  };
  expectTypeOf(checkContracts).returns.toEqualTypeOf<Promise<void>>();
});

import {
  Agent,
  Codec,
  Model,
  RunId,
  Tool,
  type AgentClient,
  type AgentRunId,
  type ModelSchema,
} from "@commissary/core";
import type { EffectAgentClient } from "@commissary/effect";
import { execute as executeJavaScript, type StreamExecution } from "@commissary/stream";
import { execute as executeEffect, type EffectStreamExecution } from "@commissary/stream/effect";
import { Context, Effect } from "effect";
import { expectTypeOf, it } from "vitest";

class StreamDependency extends Context.Service<StreamDependency, { readonly value: string }>()(
  "commissary/test/StreamDependency",
) {}

const stringSchema: ModelSchema<string, string> = {
  "~standard": {
    version: 1,
    vendor: "commissary-stream-test",
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
    vendor: "commissary-stream-test",
    validate: (value) =>
      typeof value === "number" ? { value } : { issues: [{ message: "Expected a number" }] },
    jsonSchema: {
      input: () => ({ type: "number" }),
      output: () => ({ type: "number" }),
    },
  },
};

const stringFailureSchema: ModelSchema<{ readonly code: "string" }, { readonly code: "string" }> = {
  "~standard": {
    version: 1,
    vendor: "commissary-stream-test",
    validate: (value) =>
      typeof value === "object" && value !== null && "code" in value && value.code === "string"
        ? { value: { code: "string" as const } }
        : { issues: [{ message: "Expected string failure" }] },
    jsonSchema: {
      input: () => ({ type: "object", properties: { code: { const: "string" } } }),
      output: () => ({ type: "object", properties: { code: { const: "string" } } }),
    },
  },
};

const numberFailureSchema: ModelSchema<{ readonly code: "number" }, { readonly code: "number" }> = {
  "~standard": {
    version: 1,
    vendor: "commissary-stream-test",
    validate: (value) =>
      typeof value === "object" && value !== null && "code" in value && value.code === "number"
        ? { value: { code: "number" as const } }
        : { issues: [{ message: "Expected number failure" }] },
    jsonSchema: {
      input: () => ({ type: "object", properties: { code: { const: "number" } } }),
      output: () => ({ type: "object", properties: { code: { const: "number" } } }),
    },
  },
};

const continuation = Codec.define({
  encode: (value: string) => value,
  decode: (value) => String(value),
});

const stringTool = Tool.define({
  name: "stream-string",
  input: stringSchema,
  output: numberSchema,
  failure: stringFailureSchema,
  event: numberSchema,
  handler: (input) => input.length,
  suspension: {
    resumeInput: numberSchema,
    continuation,
    resume: ({ input, continuation: state }) => state.length + input,
  },
});
const numberTool = Tool.define({
  name: "stream-number",
  input: numberSchema,
  output: stringSchema,
  failure: numberFailureSchema,
  event: stringSchema,
  handler: (input) => String(input),
});
const dynamicProvider = Tool.dynamic({ id: "stream-dynamic", resolve: () => [] });
const model = Model.define<"stream-contract-model", StreamDependency>({
  id: "stream-contract-model",
  async *invoke() {
    yield {
      type: "finish" as const,
      response: {
        message: { role: "assistant" as const, content: [] },
        finishReason: "stop" as const,
      },
    };
  },
});
const agent = Agent.define({
  id: "stream-contract-agent",
  fragments: Agent.combine(model, stringTool, numberTool, dynamicProvider),
});
const otherAgent = Agent.define({ id: "other-stream-agent", fragments: model });

declare const coreClient: AgentClient<typeof agent>;
declare const effectClient: EffectAgentClient<typeof agent>;
declare const otherRunId: AgentRunId<typeof otherAgent>;

it("preserves Agent contracts in JavaScript and Effect streams", () => {
  expectTypeOf<Agent.Requirements<typeof agent>>().toEqualTypeOf<StreamDependency>();
  expectTypeOf<Tool.FailureValue<typeof stringTool>>().toEqualTypeOf<{
    readonly code: "string";
  }>();
  expectTypeOf<Tool.FailureValue<typeof numberTool>>().toEqualTypeOf<{
    readonly code: "number";
  }>();
  expectTypeOf<Tool.ResumeInput<typeof stringTool>>().toEqualTypeOf<number>();
  const checkContracts = async () => {
    const runId = RunId.decode("stream-run");
    const javaScriptExecution = executeJavaScript(coreClient, runId);
    expectTypeOf(javaScriptExecution).toEqualTypeOf<
      Promise<
        StreamExecution<
          Agent.Tools<typeof agent>,
          Agent.Failure<typeof agent>,
          AgentRunId<typeof agent>
        >
      >
    >();
    const streamed = await javaScriptExecution;
    for await (const event of streamed.events) {
      if (
        event.type === "tool-event" &&
        event.dynamic !== true &&
        event.toolName === "stream-string"
      ) {
        expectTypeOf(event.event).toEqualTypeOf<number>();
      }
    }

    const fromCore = executeEffect(coreClient, runId);
    const fromEffect = executeEffect(effectClient, runId);
    expectTypeOf(fromCore).toEqualTypeOf<
      Effect.Effect<
        EffectStreamExecution<
          Agent.Tools<typeof agent>,
          Agent.Failure<typeof agent>,
          AgentRunId<typeof agent>
        >,
        unknown
      >
    >();
    expectTypeOf(fromEffect).toEqualTypeOf<typeof fromCore>();

    // @ts-expect-error a Run ID bound to another Agent is rejected by the stream adapter
    executeJavaScript(coreClient, otherRunId);
    // @ts-expect-error the Effect stream keeps the same Agent-bound Run ID rule
    executeEffect(effectClient, otherRunId);
  };
  expectTypeOf(checkContracts).returns.toEqualTypeOf<Promise<void>>();
});

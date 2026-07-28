import { expectTypeOf, it } from "vitest";
import { Agent, Codec, Hook, Model, Tool } from "../src/index.js";
import { numberSchema, stringSchema, testSchema } from "./support.js";

const failureSchema = testSchema(
  (value): value is { readonly code: "unavailable" } =>
    typeof value === "object" && value !== null && "code" in value && value.code === "unavailable",
  {
    type: "object",
    properties: { code: { const: "unavailable" } },
    required: ["code"],
  },
);

const progressSchema = testSchema(
  (value): value is { readonly percent: number } =>
    typeof value === "object" &&
    value !== null &&
    "percent" in value &&
    typeof value.percent === "number",
  {
    type: "object",
    properties: { percent: { type: "number" } },
    required: ["percent"],
  },
);

const resumeInput = testSchema((value): value is boolean => typeof value === "boolean", {
  type: "boolean",
});

const continuation = Codec.define({
  encode(value: number) {
    return value;
  },
  decode(value) {
    if (typeof value !== "number") {
      throw new TypeError("expected number");
    }
    return value;
  },
});

const calculate = Tool.define({
  name: "calculate",
  input: stringSchema,
  output: numberSchema,
  failure: failureSchema,
  event: progressSchema,
  handler(input, context) {
    expectTypeOf(input).toEqualTypeOf<string>();
    expectTypeOf(context.emit).parameter(0).toEqualTypeOf<{
      readonly percent: number;
    }>();
    return input.length;
  },
  suspension: {
    resumeInput,
    continuation,
    resume(value) {
      expectTypeOf(value.input).toEqualTypeOf<boolean>();
      expectTypeOf(value.continuation).toEqualTypeOf<number>();
      return value.input ? value.continuation : 0;
    },
  },
});

const dynamicProvider = Tool.dynamic({
  id: "mcp",
  resolve: () => [],
});

const model = Model.define({
  id: "model",
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
  id: "typed-agent",
  fragments: Agent.combine(calculate, model),
});

it("preserves value-driven Tool and Agent inference", () => {
  expectTypeOf<Tool.Input<typeof calculate>>().toEqualTypeOf<string>();
  expectTypeOf<Tool.Output<typeof calculate>>().toEqualTypeOf<number>();
  expectTypeOf<Tool.Failure<typeof calculate>>().toEqualTypeOf<{
    readonly code: "unavailable";
  }>();
  expectTypeOf<Tool.ResumeInput<typeof calculate>>().toEqualTypeOf<boolean>();
  expectTypeOf<Agent.Tools<typeof agent>>().toEqualTypeOf<typeof calculate>();
  expectTypeOf<Agent.Events<typeof agent>>().toEqualTypeOf<{
    readonly percent: number;
  }>();
  expectTypeOf<Agent.FragmentTools<typeof dynamicProvider>>().not.toBeNever();
  expectTypeOf(agent.id).toEqualTypeOf<"typed-agent">();
});

it("requires notification Hooks to return exactly undefined", () => {
  Hook.onModelEvent(() => undefined);
  // @ts-expect-error notification Hooks cannot accidentally return a patch
  Hook.onModelEvent(() => ({ request: undefined }));
});

it("keeps provider capabilities out of core Tool constructors", () => {
  // @ts-expect-error provider-executed capabilities belong to Model adapters
  void Tool.provider;
  // @ts-expect-error provider callback capabilities use ordinary Tool definitions
  void Tool.providerCallback;
});

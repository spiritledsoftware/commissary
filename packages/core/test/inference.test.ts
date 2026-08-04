import {
  Agent,
  Codec,
  Hook,
  HookPoints,
  Model,
  RunId,
  Tool,
  ToolCallId,
  type AbortResult,
  type AgentClient,
  type AgentClientRunId,
  type AgentCreateRunInput,
  type AgentCreateRunResult,
  type AgentResumeRunResult,
  type AgentRunId,
  type BranchId,
  type DecodedRunId,
  type HookFragment,
  type JsonValue,
  type StandardSchema,
  type ThreadId,
  type ToolResumeItem,
} from "@commissary/core";
import { expectTypeOf, it } from "vitest";

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

const formatFailureSchema = testSchema(
  (value): value is { readonly code: "invalid-format" } =>
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "invalid-format",
  {
    type: "object",
    properties: { code: { const: "invalid-format" } },
    required: ["code"],
  },
);

const formatEventSchema = testSchema(
  (value): value is { readonly message: string } =>
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string",
  {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
);

const formatContinuation = Codec.define({
  encode: (value: string) => value,
  decode(value) {
    if (typeof value !== "string") {
      throw new Error("Expected a format string continuation");
    }
    return value;
  },
});

const format = Tool.define({
  name: "format",
  input: numberSchema,
  output: stringSchema,
  failure: formatFailureSchema,
  event: formatEventSchema,
  handler: (input) => String(input),
  suspension: {
    resumeInput: stringSchema,
    continuation: formatContinuation,
    resume: ({ input, continuation: state }) => `${state}:${input}`,
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

const reusableBroadHook = Hook.onExecutionEvent(() => undefined);

const agent = Agent.define({
  id: "typed-agent",
  fragments: Agent.combine(calculate, model),
});

const hostAgent = Agent.define({
  id: "host-agent",
  fragments: Agent.combine(calculate, format, dynamicProvider, model, reusableBroadHook),
  hooks: (hooks) =>
    hooks.onExecutionEvent(({ event }) => {
      if (event.type === "tool-event" && event.dynamic !== true) {
        if (event.toolName === "calculate") {
          expectTypeOf(event.event).toEqualTypeOf<{ readonly percent: number }>();
        } else {
          expectTypeOf(event.toolName).toEqualTypeOf<"format">();
          expectTypeOf(event.event).toEqualTypeOf<{ readonly message: string }>();
        }
      }
      return undefined;
    }),
});

const otherAgent = Agent.define({ id: "other-agent", fragments: model });

declare const hostClient: AgentClient<typeof hostAgent>;
declare const otherClient: AgentClient<typeof otherAgent>;
declare const createInput: AgentCreateRunInput;
declare const dateOutputSchema: StandardSchema<unknown, Date>;
declare const dateResumeInputSchema: StandardSchema<Date, boolean>;

it("preserves value-driven Tool and Agent inference", () => {
  expectTypeOf<Codec.Value<typeof continuation>>().toEqualTypeOf<number>();
  expectTypeOf<Codec.Encoded<typeof continuation>>().toEqualTypeOf<number>();
  expectTypeOf<Tool.Name<typeof calculate>>().toEqualTypeOf<"calculate">();
  expectTypeOf<Tool.RequestedInput<typeof calculate>>().toEqualTypeOf<string>();
  expectTypeOf<Tool.Input<typeof calculate>>().toEqualTypeOf<string>();
  expectTypeOf<Tool.Output<typeof calculate>>().toEqualTypeOf<number>();
  expectTypeOf<Tool.FailureValue<typeof calculate>>().toEqualTypeOf<{
    readonly code: "unavailable";
  }>();
  expectTypeOf<Tool.Failure<typeof calculate>>().toEqualTypeOf<{
    readonly type: "tool-failure";
    readonly dynamic?: false;
    readonly providerId?: never;
    readonly toolName: "calculate";
    readonly toolCallId: ToolCallId;
    readonly value: { readonly code: "unavailable" };
  }>();
  expectTypeOf<Tool.ResumeInput<typeof calculate>>().toEqualTypeOf<boolean>();
  expectTypeOf<Agent.Tools<typeof agent>>().toEqualTypeOf<typeof calculate>();
  expectTypeOf<Agent.Events<typeof agent>>().toEqualTypeOf<{
    readonly percent: number;
  }>();
  expectTypeOf<Agent.FragmentTools<typeof dynamicProvider>>().not.toBeNever();
  expectTypeOf(agent.id).toEqualTypeOf<"typed-agent">();
  expectTypeOf(reusableBroadHook).toEqualTypeOf<HookFragment<typeof HookPoints.onExecutionEvent>>();
});

it("preserves bound host contracts and rejects cross-Agent or malformed commands", () => {
  const checkContracts = async () => {
    const created = await hostClient.createRun(createInput);
    expectTypeOf(created).toEqualTypeOf<AgentCreateRunResult<typeof hostAgent>>();
    if (created.type === "accepted") {
      expectTypeOf(created.runId).toEqualTypeOf<AgentRunId<typeof hostAgent>>();
      await hostClient.execute(created.runId);
      // @ts-expect-error an Agent-bound Run ID cannot cross to another Agent client
      await otherClient.execute(created.runId);
    } else if (created.type === "run-conflict") {
      const decodedRunId: DecodedRunId = created.runId;
      // @ts-expect-error a conflict does not prove Agent ownership
      const boundRunId: AgentRunId<typeof hostAgent> = created.runId;
      void [decodedRunId, boundRunId];
    }
    const runId = RunId.decode("stored-run");
    await hostClient.execute(runId);
    await otherClient.execute(runId);
    const resumed = await hostClient.resumeRun({
      runId,
      items: [
        {
          toolName: "calculate",
          toolCallId: ToolCallId.decode("calculate-call"),
          input: true,
        },
      ],
    });
    expectTypeOf(resumed).toEqualTypeOf<AgentResumeRunResult<typeof hostAgent>>();
    if (resumed.type === "accepted") {
      expectTypeOf(resumed.runId).toEqualTypeOf<AgentRunId<typeof hostAgent>>();
    } else {
      expectTypeOf(resumed.runId).toEqualTypeOf<AgentClientRunId<typeof hostAgent>>();
    }
    await hostClient.resumeRun({
      runId,
      items: [
        {
          toolName: "format",
          toolCallId: ToolCallId.decode("format-call"),
          input: "resume",
        },
      ],
    });
    await hostClient.resumeRun({
      runId,
      items: [
        {
          dynamic: true,
          providerId: "mcp",
          toolName: "remote",
          toolCallId: ToolCallId.decode("remote-call"),
          input: { approved: true },
        },
      ],
    });
    const staticResumeItem: ToolResumeItem = {
      toolName: "open-static",
      toolCallId: ToolCallId.decode("open-static-call"),
      input: true,
    };
    const dynamicResumeItem: ToolResumeItem = {
      dynamic: true,
      providerId: "open-dynamic",
      toolName: "remote",
      toolCallId: ToolCallId.decode("open-dynamic-call"),
      input: true,
    };
    // @ts-expect-error dynamic resume items require a provider ID
    const missingDynamicProvider: ToolResumeItem = {
      dynamic: true,
      toolName: "remote",
      toolCallId: ToolCallId.decode("missing-provider-call"),
      input: true,
    };
    // @ts-expect-error static resume items cannot include a provider ID
    const staticProvider: ToolResumeItem = {
      dynamic: false,
      providerId: "unexpected",
      toolName: "open-static",
      toolCallId: ToolCallId.decode("static-provider-call"),
      input: true,
    };
    void [staticResumeItem, dynamicResumeItem, missingDynamicProvider, staticProvider];
    await hostClient.resumeRun({
      runId,
      items: [
        // @ts-expect-error calculate resume input is boolean
        {
          toolName: "calculate",
          toolCallId: ToolCallId.decode("wrong-calculate-call"),
          input: "wrong",
        },
      ],
    });
    await hostClient.resumeRun({
      runId,
      items: [
        // @ts-expect-error an unknown static name does not widen through the dynamic provider
        {
          toolName: "remote",
          toolCallId: ToolCallId.decode("unmarked-remote-call"),
          input: true,
        },
      ],
    });

    const snapshot = await hostClient.readRunSnapshot(runId);
    if (snapshot !== undefined) {
      for (const call of snapshot.toolCalls) {
        if (call.dynamic === true) {
          expectTypeOf(call.providerId).toEqualTypeOf<string>();
          expectTypeOf(call.requestedInput).not.toBeAny();
          void (call.requestedInput satisfies JsonValue);
        } else if (call.toolName === "calculate") {
          expectTypeOf(call.requestedInput).not.toBeAny();
          void (call.requestedInput satisfies string);
          if (call.result?.type === "failure") {
            void (call.result.failure satisfies Tool.Failure<typeof calculate>);
          }
        } else {
          expectTypeOf(call.toolName).toEqualTypeOf<"format">();
          expectTypeOf(call.requestedInput).not.toBeAny();
          void (call.requestedInput satisfies number);
        }
      }
      for (const suspension of snapshot.suspensions) {
        if (suspension.dynamic === true) {
          expectTypeOf(suspension.providerId).toEqualTypeOf<string>();
        } else if (suspension.toolName === "calculate") {
          void (suspension satisfies Tool.Suspension<typeof calculate>);
        } else {
          void (suspension satisfies Tool.Suspension<typeof format>);
        }
      }
    }

    const aborted = await hostClient.abort(runId);
    expectTypeOf(aborted).toEqualTypeOf<
      AbortResult<
        Agent.Failure<typeof hostAgent>,
        Agent.Tools<typeof hostAgent>,
        AgentRunId<typeof hostAgent>
      >
    >();

    hostClient.on(HookPoints.beforeSettlement, ({ result }) => {
      expectTypeOf(result).toEqualTypeOf<Agent.ExecutionResults<typeof hostAgent>>();
      return undefined;
    });
    hostClient.on(HookPoints.onSettlement, ({ result }) => {
      expectTypeOf(result).toEqualTypeOf<Agent.ExecutionResults<typeof hostAgent>>();
      return undefined;
    });

    hostClient.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "tool-event" && event.dynamic !== true) {
        if (event.toolName === "calculate") {
          expectTypeOf(event.event).toEqualTypeOf<{ readonly percent: number }>();
        } else {
          expectTypeOf(event.event).toEqualTypeOf<{ readonly message: string }>();
        }
      }
      return undefined;
    });

    const threadId: ThreadId = createInput.threadId;
    // @ts-expect-error distinct ID brands do not assign across contracts
    const branchId: BranchId = threadId;
    void branchId;

    Tool.define({
      name: "non-json-output",
      input: stringSchema,
      // @ts-expect-error durable Tool output schemas must decode to JSON
      output: dateOutputSchema,
      // @ts-expect-error a non-JSON output cannot satisfy the handler contract
      handler: () => new Date(),
    });
    Tool.define({
      name: "non-json-failure",
      input: stringSchema,
      // @ts-expect-error durable Tool Failure schemas must decode to JSON
      failure: dateOutputSchema,
      // @ts-expect-error a non-JSON Failure cannot satisfy the handler contract
      handler: () => Tool.failure(new Date()),
    });
    Tool.define({
      name: "non-json-resume-input",
      input: stringSchema,
      output: stringSchema,
      handler: () => Tool.suspend(1),
      suspension: {
        // @ts-expect-error submitted resume schema inputs must be JSON
        resumeInput: dateResumeInputSchema,
        continuation,
        resume: () => "done",
      },
    });
  };
  expectTypeOf(checkContracts).returns.toEqualTypeOf<Promise<void>>();
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

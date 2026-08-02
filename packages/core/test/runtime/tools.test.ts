import { MemoryThreadStore } from "@commissary/store-memory";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Codec,
  Content,
  ExecutionUnavailableError,
  Hook,
  HookPoints,
  Model,
  RunId,
  Tool,
  commissary,
  type AgentClient,
  type Loop,
  type ModelMessage,
  type ModelSchema,
  ToolCallId,
} from "@commissary/core";
import { numberSchema, stringSchema, testSchema } from "../support.js";
import { completingModel, fixture, submitStart } from "./support.js";

describe("Runtime Tools", () => {
  it("commits Tool Calls before attempts and fixes transformed input once", async () => {
    let client!: AgentClient<typeof agent>;
    let hookCalls = 0;
    const observedRequests: (readonly ModelMessage[])[] = [];
    let invocations = 0;
    const echo = Tool.define({
      name: "echo",
      input: stringSchema,
      output: stringSchema,
      async handler(input, context) {
        const snapshot = await client.readRunSnapshot(RunId.decode(context.runId));
        expect(snapshot?.toolCalls).toMatchObject([
          {
            toolCallId: context.toolCallId,
            status: "pending",
            requestedInput: "raw",
            effectiveInput: `${input}`,
          },
        ]);
        return input;
      },
    });
    const model = Model.define({
      id: "tool-model",
      async *invoke(request) {
        observedRequests.push(request.messages);
        invocations += 1;
        if (invocations === 1) {
          const call = Content.toolCall(ToolCallId.decode("call-echo"), "echo", "raw");
          yield {
            type: "finish" as const,
            response: {
              message: { role: "assistant" as const, content: [call] },
              finishReason: "tool-calls" as const,
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("done")] },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "tool-agent",
      fragments: Agent.combine(
        model,
        echo,
        Hook.beforeToolExecution(({ input }) => {
          hookCalls += 1;
          return { input: `${input}!` };
        }),
      ),
    });
    const built = await fixture(agent);
    client = built.client;

    const submission = await submitStart(client, built.branch);
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });

    expect(hookCalls).toBe(1);
    expect(observedRequests[1]?.at(-1)).toMatchObject({
      role: "tool",
      content: [{ output: "raw!" }],
    });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      toolCalls: [
        {
          toolCallId: "call-echo",
          status: "succeeded",
          requestedInput: "raw",
          effectiveInput: "raw!",
          result: { type: "success", output: "raw!" },
        },
      ],
    });
  });

  it("stores JSON Tool output with ordered model-visible content", async () => {
    const requests: Array<readonly ModelMessage[]> = [];
    let invocations = 0;
    const rich = Tool.define({
      name: "rich-result",
      input: stringSchema,
      handler: (input) =>
        Tool.success(
          { echoed: input },
          { content: [Content.text("extra text"), Content.reasoning("extra reason")] },
        ),
    });
    const model = Model.define({
      id: "rich-result-model",
      async *invoke(request) {
        requests.push(request.messages);
        invocations += 1;
        if (invocations === 1) {
          yield {
            type: "finish" as const,
            response: {
              message: {
                role: "assistant" as const,
                content: [Content.toolCall(ToolCallId.decode("rich-call"), "rich-result", "value")],
              },
              finishReason: "tool-calls" as const,
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("done")] },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "rich-result-agent",
      fragments: Agent.combine(model, rich),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(requests[1]?.at(-1)).toEqual({
      role: "tool",
      content: [
        Content.toolResult(ToolCallId.decode("rich-call"), "rich-result", { echoed: "value" }),
        Content.text("extra text"),
        Content.reasoning("extra reason"),
      ],
    });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      toolCalls: [
        {
          result: {
            type: "success",
            output: { echoed: "value" },
            content: [Content.text("extra text"), Content.reasoning("extra reason")],
          },
        },
      ],
    });
  });

  it("decodes stored effective JSON for every recovered Tool attempt", async () => {
    const decodedInput: ModelSchema<{ readonly value: string }, string> = {
      "~standard": {
        version: 1,
        vendor: "commissary-test",
        validate(value) {
          return typeof value === "string"
            ? { value: { value } }
            : { issues: [{ message: "Expected a string" }] };
        },
        jsonSchema: {
          input: () => ({ type: "string" }),
          output: () => ({ type: "string" }),
        },
      },
    };
    let modelCalls = 0;
    let hookCalls = 0;
    let handlerCalls = 0;
    const decodedValues: Array<{ readonly value: string }> = [];
    const tool = Tool.define({
      name: "decoded-input",
      input: decodedInput,
      output: stringSchema,
      handler(input) {
        handlerCalls += 1;
        decodedValues.push(input);
        if (handlerCalls === 1) {
          throw new Error("stop after effective input");
        }
        return input.value;
      },
    });
    const model = Model.define({
      id: "decoded-input-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response:
            modelCalls === 1
              ? {
                  message: {
                    role: "assistant" as const,
                    content: [
                      Content.toolCall(
                        ToolCallId.decode("decoded-input-call"),
                        "decoded-input",
                        "requested",
                      ),
                    ],
                  },
                  finishReason: "tool-calls" as const,
                }
              : {
                  message: {
                    role: "assistant" as const,
                    content: [Content.text("done")],
                  },
                  finishReason: "stop" as const,
                },
        };
      },
    });
    const agent = Agent.define({
      id: "decoded-input-agent",
      fragments: Agent.combine(
        model,
        tool,
        Hook.beforeToolExecution(() => {
          hookCalls += 1;
          return { input: "effective" };
        }),
      ),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
    });
    const afterFailure = await client.readRunSnapshot(submission.runId);
    expect(afterFailure).toMatchObject({
      toolCalls: [
        {
          requestedInput: "requested",
          effectiveInput: "effective",
        },
      ],
    });
    expect(afterFailure?.toolCalls[0]).not.toHaveProperty("result");
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(hookCalls).toBe(1);
    expect(handlerCalls).toBe(2);
    expect(decodedValues).toEqual([{ value: "effective" }, { value: "effective" }]);
    expect(decodedValues[0]).not.toBe(decodedValues[1]);
  });

  it("does not persist a Hook input that its Tool schema rejects", async () => {
    const tool = Tool.define({
      name: "invalid-effective-input",
      input: stringSchema,
      output: stringSchema,
      handler: (input) => input,
    });
    const model = Model.define({
      id: "invalid-effective-input-model",
      async *invoke() {
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [
                Content.toolCall(
                  ToolCallId.decode("invalid-effective-input-call"),
                  "invalid-effective-input",
                  "requested",
                ),
              ],
            },
            finishReason: "tool-calls" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "invalid-effective-input-agent",
      fragments: Agent.combine(
        model,
        tool,
        Hook.beforeToolExecution(() => ({ input: 1 })),
      ),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
    });
    const snapshot = await client.readRunSnapshot(submission.runId);
    expect(snapshot?.toolCalls[0]).toMatchObject({
      requestedInput: "requested",
    });
    expect(snapshot?.toolCalls[0]).not.toHaveProperty("effectiveInput");
  });

  it("stores submitted resume JSON and decodes it only for the resume callback", async () => {
    const resumeInput: ModelSchema<{ readonly approved: boolean }, boolean> = {
      "~standard": {
        version: 1,
        vendor: "commissary-test",
        validate(value) {
          return typeof value === "boolean"
            ? { value: { approved: value } }
            : { issues: [{ message: "Expected a boolean" }] };
        },
        jsonSchema: {
          input: () => ({ type: "boolean" }),
          output: () => ({ type: "boolean" }),
        },
      },
    };
    const continuation = Codec.define({
      encode: (value: string) => value,
      decode: (value) => {
        if (typeof value !== "string") {
          throw new Error("Expected continuation state");
        }
        return value;
      },
    });
    let modelCalls = 0;
    let receivedResumeInput: { readonly approved: boolean } | undefined;
    const tool = Tool.define({
      name: "approval",
      input: stringSchema,
      output: stringSchema,
      handler: () => Tool.suspend("state"),
      suspension: {
        resumeInput,
        continuation,
        resume({ input, continuation: state }) {
          receivedResumeInput = input;
          return `${state}:${input.approved ? "approved" : "denied"}`;
        },
      },
    });
    const model = Model.define({
      id: "approval-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response:
            modelCalls === 1
              ? {
                  message: {
                    role: "assistant" as const,
                    content: [
                      Content.toolCall(ToolCallId.decode("approval-call"), "approval", "start"),
                    ],
                  },
                  finishReason: "tool-calls" as const,
                }
              : {
                  message: {
                    role: "assistant" as const,
                    content: [Content.text("done")],
                  },
                  finishReason: "stop" as const,
                },
        };
      },
    });
    const agent = Agent.define({
      id: "approval-agent",
      fragments: Agent.combine(model, tool),
    });
    const { branch, client, store } = await fixture(agent);
    const submission = await submitStart(client, branch);
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "suspended",
    });

    await expect(
      client.resumeRun({
        runId: submission.runId,
        items: [
          {
            toolName: "approval",
            toolCallId: ToolCallId.decode("approval-call"),
            input: true,
          },
        ],
      }),
    ).resolves.toMatchObject({ type: "accepted" });
    const context = await store.readToolResumeContext({
      agent: client.reference,
      runId: submission.runId,
    });
    expect(context?.toolCalls[0]?.suspension?.resumeInput).toBe(true);
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(receivedResumeInput).toEqual({ approved: true });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      toolCalls: [
        {
          result: { type: "success", output: "state:approved" },
        },
      ],
    });
  });

  it("tags a terminal Tool failure with its exact static identity", async () => {
    const failureSchema = testSchema(
      (value): value is { readonly code: "denied" } =>
        typeof value === "object" && value !== null && "code" in value && value.code === "denied",
      {
        type: "object",
        properties: { code: { const: "denied" } },
        required: ["code"],
      },
    );
    const tool = Tool.define({
      name: "failing-tool",
      input: stringSchema,
      output: stringSchema,
      failure: failureSchema,
      handler: () => Tool.failure({ code: "denied" }),
    });
    let modelCalls = 0;
    const model = Model.define({
      id: "failing-tool-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response:
            modelCalls === 1
              ? {
                  message: {
                    role: "assistant" as const,
                    content: [
                      Content.toolCall(
                        ToolCallId.decode("failing-tool-call"),
                        "failing-tool",
                        "input",
                      ),
                    ],
                  },
                  finishReason: "tool-calls" as const,
                }
              : {
                  message: {
                    role: "assistant" as const,
                    content: [Content.text("done")],
                  },
                  finishReason: "stop" as const,
                },
        };
      },
    });
    const agent = Agent.define({
      id: "failing-tool-agent",
      fragments: Agent.combine(model, tool),
    });
    const { branch, client } = await fixture(agent);
    const finished: unknown[] = [];
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "tool-finished") {
        finished.push(event);
      }
      return undefined;
    });
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    const expectedFailure = {
      type: "tool-failure",
      toolName: "failing-tool",
      toolCallId: "failing-tool-call",
      value: { code: "denied" },
    };
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      toolCalls: [
        {
          toolName: "failing-tool",
          result: { type: "failure", failure: expectedFailure },
        },
      ],
    });
    expect(finished).toContainEqual({
      type: "tool-finished",
      toolName: "failing-tool",
      toolCallId: "failing-tool-call",
      result: { type: "failure", failure: expectedFailure },
    });
    expect(finished[0]).not.toHaveProperty("dynamic");
    expect(finished[0]).not.toHaveProperty("providerId");
  });

  it("suspends and resumes multiple Tool Calls in one atomic command", async () => {
    const continuation = Codec.define({
      encode: (value: string) => value,
      decode: (value) => {
        if (typeof value !== "string") {
          throw new Error("invalid continuation");
        }
        return value;
      },
    });
    const first = Tool.define({
      name: "first",
      input: stringSchema,
      output: stringSchema,
      handler: () => Tool.suspend("first-state"),
      suspension: {
        resumeInput: numberSchema,
        continuation,
        resume: ({ input, continuation: state }) => `${state}:${input}`,
      },
    });
    const second = Tool.define({
      name: "second",
      input: stringSchema,
      output: stringSchema,
      handler: () => Tool.suspend("second-state"),
      suspension: {
        resumeInput: numberSchema,
        continuation,
        resume: ({ input, continuation: state }) => `${state}:${input}`,
      },
    });
    let invocation = 0;
    const model = Model.define({
      id: "multi-suspension-model",
      async *invoke() {
        invocation += 1;
        if (invocation === 1) {
          yield {
            type: "finish" as const,
            response: {
              message: {
                role: "assistant" as const,
                content: [
                  Content.toolCall(ToolCallId.decode("call-first"), "first", "a"),
                  Content.toolCall(ToolCallId.decode("call-second"), "second", "b"),
                ],
              },
              finishReason: "tool-calls" as const,
              usage: { input: { total: 1 }, output: { total: 2 }, totalTokens: 3 },
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("done")] },
            finishReason: "stop" as const,
            usage: { input: { total: 4 }, output: { total: 5 }, totalTokens: 9 },
          },
        };
      },
    });
    const agent = Agent.define({
      id: "multi-suspension-agent",
      fragments: Agent.combine(model, first, second),
    });
    const foreignFirst = Tool.define({
      name: "first",
      input: stringSchema,
      output: stringSchema,
      handler: () => Tool.suspend("foreign-state"),
      suspension: {
        resumeInput: stringSchema,
        continuation,
        resume: ({ input, continuation: state }) => `${state}:${input}`,
      },
    });
    const foreignAgent = Agent.define({
      id: "foreign-resume-agent",
      fragments: Agent.combine(completingModel, foreignFirst),
    });
    const { app, branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    const suspended = await (await client.execute(submission.runId)).result;
    expect(suspended).toMatchObject({
      type: "suspended",
      usage: {
        total: { input: { total: 1 }, output: { total: 2 }, totalTokens: 3 },
        models: [
          {
            modelId: "multi-suspension-model",
            calls: 1,
            reportedCalls: 1,
            usage: { input: { total: 1 }, output: { total: 2 }, totalTokens: 3 },
          },
        ],
      },
      suspensions: [
        { toolName: "first", toolCallId: "call-first" },
        { toolName: "second", toolCallId: "call-second" },
      ],
    });
    await expect(
      client.steer({
        runId: submission.runId,
        steeringRequestId: "while-suspended",
        message: { role: "user", content: [Content.text("continue after tools")] },
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
    await expect(
      client.steer({
        runId: submission.runId,
        steeringRequestId: "while-suspended",
        message: { role: "user", content: [Content.text("continue after tools")] },
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: false });
    const foreignClient = app.agent(foreignAgent);
    await expect(
      foreignClient.resumeRun({
        runId: RunId.decode(submission.runId),
        items: [{ toolName: "first", toolCallId: ToolCallId.decode("call-first"), input: "wrong" }],
      }),
    ).resolves.toMatchObject({
      type: "tool-resume-conflict",
      toolCallIds: ["call-first"],
    });
    await expect(
      client.resumeRun({
        runId: submission.runId,
        toolResumeRequestId: "resume-first",
        items: [{ toolName: "first", toolCallId: ToolCallId.decode("call-first"), input: 1 }],
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "suspended",
      suspensions: [{ toolName: "second", toolCallId: "call-second" }],
    });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      run: { status: "suspended" },
      suspensions: [{ toolName: "second", toolCallId: "call-second" }],
      toolCalls: [
        { status: "succeeded", result: { output: "first-state:1" } },
        { status: "suspended" },
      ],
    });
    await expect(
      client.resumeRun({
        runId: submission.runId,
        toolResumeRequestId: "resume-second",
        items: [{ toolName: "second", toolCallId: ToolCallId.decode("call-second"), input: 2 }],
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      usage: {
        total: { input: { total: 5 }, output: { total: 7 }, totalTokens: 12 },
        models: [
          {
            modelId: "multi-suspension-model",
            calls: 2,
            reportedCalls: 2,
            usage: { input: { total: 5 }, output: { total: 7 }, totalTokens: 12 },
          },
        ],
      },
    });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      run: { status: "completed" },
      suspensions: [],
      toolCalls: [
        { status: "succeeded", result: { output: "first-state:1" } },
        { status: "succeeded", result: { output: "second-state:2" } },
      ],
    });
  });

  it("rejects execution through a different Agent revision", async () => {
    const continuation = Codec.define({
      encode: (value: string) => value,
      decode: (value) => String(value),
    });
    const oldTool = Tool.define({
      name: "revisioned-tool",
      input: stringSchema,
      output: stringSchema,
      handler: () => Tool.suspend("old-state"),
      suspension: {
        resumeInput: stringSchema,
        continuation,
        resume: ({ input, continuation: state }) => `${state}:${input}`,
      },
    });
    let resumedByNewAgent = 0;
    const newTool = Tool.define({
      name: "revisioned-tool",
      input: stringSchema,
      output: stringSchema,
      handler: () => Tool.suspend("new-state"),
      suspension: {
        resumeInput: stringSchema,
        continuation,
        resume: ({ input, continuation: state }) => {
          resumedByNewAgent += 1;
          return `${state}:${input}`;
        },
      },
    });
    let modelInvocations = 0;
    const model = Model.define({
      id: "revisioned-model",
      async *invoke() {
        modelInvocations += 1;
        yield {
          type: "finish" as const,
          response:
            modelInvocations === 1
              ? {
                  message: {
                    role: "assistant" as const,
                    content: [
                      Content.toolCall(
                        ToolCallId.decode("revisioned-call"),
                        "revisioned-tool",
                        "start",
                      ),
                    ],
                  },
                  finishReason: "tool-calls" as const,
                }
              : {
                  message: { role: "assistant" as const, content: [Content.text("done")] },
                  finishReason: "stop" as const,
                },
        };
      },
    });
    const oldAgent = Agent.define({
      id: "revisioned-agent",
      fragments: Agent.combine(model, oldTool),
    });
    const newAgent = Agent.define({
      id: "revisioned-agent",
      fragments: Agent.combine(
        model,
        newTool,
        Hook.beforeModelRequest(() => undefined),
      ),
    });
    const store = MemoryThreadStore.make();
    const oldApp = commissary({ threadStore: store });
    const thread = await oldApp.createThread();
    const branch = await oldApp.createBranch({ threadId: thread.id, name: "main" });
    const oldClient = oldApp.agent(oldAgent);
    const submission = await submitStart(oldClient, branch);
    await expect((await oldClient.execute(submission.runId)).result).resolves.toMatchObject({
      type: "suspended",
    });
    await expect(
      oldClient.resumeRun({
        runId: submission.runId,
        items: [
          {
            toolName: "revisioned-tool",
            toolCallId: ToolCallId.decode("revisioned-call"),
            input: "resume",
          },
        ],
      }),
    ).resolves.toMatchObject({ type: "accepted" });

    const newClient = commissary({ threadStore: store }).agent(newAgent);
    expect(newClient.reference.revision).not.toBe(oldClient.reference.revision);
    await expect(newClient.execute(submission.runId)).rejects.toEqual(
      new ExecutionUnavailableError(submission.runId, "wrong-agent"),
    );
    expect(resumedByNewAgent).toBe(0);
  });

  it("records delegated children and reuses their stable result", async () => {
    let childAttempts = 0;
    const decodedChildInput: ModelSchema<{ readonly value: number }, number> = {
      "~standard": {
        version: 1,
        vendor: "commissary-test",
        validate(value) {
          return typeof value === "number"
            ? { value: { value } }
            : { issues: [{ message: "Expected a number" }] };
        },
        jsonSchema: {
          input: () => ({ type: "number" }),
          output: () => ({ type: "object" }),
        },
      },
    };
    const child = Tool.define({
      name: "child",
      input: decodedChildInput,
      output: numberSchema,
      handler(input) {
        childAttempts += 1;
        return input.value * 2;
      },
    });
    const parent = Tool.define({
      name: "parent",
      input: numberSchema,
      output: numberSchema,
      async handler(input, context) {
        const first = await context.invoke(child, input, { key: "double" });
        const second = await context.invoke(child, input, { key: "double" });
        if (first.type === "failure" || second.type === "failure") {
          return 0;
        }
        return first.output + second.output;
      },
    });
    let invocation = 0;
    const model = Model.define({
      id: "delegation-model",
      async *invoke() {
        invocation += 1;
        yield {
          type: "finish" as const,
          response:
            invocation === 1
              ? {
                  message: {
                    role: "assistant" as const,
                    content: [Content.toolCall(ToolCallId.decode("parent-call"), "parent", 3)],
                  },
                  finishReason: "tool-calls" as const,
                }
              : {
                  message: { role: "assistant" as const, content: [Content.text("done")] },
                  finishReason: "stop" as const,
                },
        };
      },
    });
    const agent = Agent.define({
      id: "delegation-agent",
      fragments: Agent.combine(model, parent, child),
    });
    let generated = 0;
    const store = MemoryThreadStore.make();
    const app = commissary({
      threadStore: store,
      generateId: () => `generated-${(generated += 1)}`,
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(childAttempts).toBe(1);
    const snapshot = await client.readRunSnapshot(submission.runId);
    expect(snapshot?.toolCalls).toHaveLength(2);
    expect(snapshot?.toolCalls[1]).toMatchObject({
      toolName: "child",
      parentToolCallId: "parent-call",
      result: { type: "success", output: 6 },
    });
    expect(snapshot?.toolCalls[1]?.toolCallId).toMatch(/^generated-/);
    expect(snapshot?.toolCalls[0]).toMatchObject({ result: { output: 12 } });
  });

  it("delegates through an installed dynamic Tool Provider", async () => {
    let dynamicAttempts = 0;
    const provider = Tool.dynamic({
      id: "runtime-tools",
      resolve: () => [
        {
          type: "dynamic-tool" as const,
          name: "square",
          input: numberSchema,
          execute(input: unknown) {
            dynamicAttempts += 1;
            if (typeof input !== "number") {
              throw new Error("Expected a number");
            }
            return input * input;
          },
        },
      ],
    });
    const parent = Tool.define({
      name: "dynamic-parent",
      input: numberSchema,
      output: numberSchema,
      async handler(input, context) {
        const result = await context.invoke(
          provider,
          { toolName: "square", input },
          { key: "square" },
        );
        return result.type === "success" && typeof result.output === "number" ? result.output : 0;
      },
    });
    let invocation = 0;
    const model = Model.define({
      id: "dynamic-delegation-model",
      async *invoke() {
        invocation += 1;
        yield {
          type: "finish" as const,
          response:
            invocation === 1
              ? {
                  message: {
                    role: "assistant" as const,
                    content: [
                      Content.toolCall(
                        ToolCallId.decode("dynamic-parent-call"),
                        "dynamic-parent",
                        4,
                      ),
                    ],
                  },
                  finishReason: "tool-calls" as const,
                }
              : {
                  message: {
                    role: "assistant" as const,
                    content: [Content.text("done")],
                  },
                  finishReason: "stop" as const,
                },
        };
      },
    });
    const agent = Agent.define({
      id: "dynamic-delegation-agent",
      fragments: Agent.combine(model, parent, provider),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(dynamicAttempts).toBe(1);
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      toolCalls: [
        { toolName: "dynamic-parent", result: { output: 16 } },
        {
          toolName: "square",
          parentToolCallId: "dynamic-parent-call",
          result: { output: 16 },
        },
      ],
    });
  });

  it("interrupts recovered Dynamic Tool work when its current contract is missing", async () => {
    let available = true;
    let executionCalls = 0;
    let modelCalls = 0;
    let toolCalls = 0;
    const provider = Tool.dynamic({
      id: "recoverable-tools",
      resolve: () =>
        available
          ? [
              {
                type: "dynamic-tool" as const,
                name: "recoverable-echo",
                input: stringSchema,
                execute(input: unknown) {
                  toolCalls += 1;
                  return input;
                },
              },
            ]
          : [],
    });
    const model = Model.define({
      id: "dynamic-recovery-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [
                Content.toolCall(
                  ToolCallId.decode("dynamic-recovery-call"),
                  "recoverable-echo",
                  "value",
                ),
              ],
            },
            finishReason: "tool-calls" as const,
          },
        };
      },
    });
    const loop: Loop = {
      async execute(context) {
        executionCalls += 1;
        const work = await context.runtime.prepare(context.runId);
        if (work.type === "tools") {
          for (const call of work.calls) {
            await context.runtime.executeTool(work, call);
          }
          throw new Error("Recovered Dynamic Tool work did not interrupt");
        }
        const invocation = await context.runtime.invokeModel(work);
        if (executionCalls === 1) {
          throw new Error("process stopped after Model commit");
        }
        return context.runtime.settle(work, invocation);
      },
    };
    const store = MemoryThreadStore.make();
    const app = commissary({ threadStore: store, loop });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({
      id: "dynamic-recovery-agent",
      fragments: Agent.combine(model, provider),
    });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
    });
    available = false;
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "interrupted",
      interruption: {
        type: "stale-agent",
        toolName: "recoverable-echo",
      },
    });
    expect(modelCalls).toBe(1);
    expect(toolCalls).toBe(0);
  });

  it("resumes a Dynamic Tool through its current suspension contract", async () => {
    const continuation = Codec.define<unknown, string>({
      encode: (value: unknown) => {
        if (typeof value !== "string") {
          throw new Error("Expected string continuation state");
        }
        return value;
      },
      decode: (value) => String(value),
    });
    const provider = Tool.dynamic({
      id: "suspending-tools",
      resolve: () => [
        {
          type: "dynamic-tool" as const,
          name: "dynamic-suspension",
          input: stringSchema,
          output: stringSchema,
          execute: () => Tool.suspend("dynamic-state"),
          suspension: {
            resumeInput: stringSchema,
            continuation,
            resume: ({ input, continuation: state }) => {
              if (typeof input !== "string" || typeof state !== "string") {
                throw new Error("Expected decoded Dynamic Tool suspension state");
              }
              return `${state}:${input}`;
            },
          },
        },
      ],
    });
    let modelCalls = 0;
    const model = Model.define({
      id: "dynamic-suspension-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response:
            modelCalls === 1
              ? {
                  message: {
                    role: "assistant" as const,
                    content: [
                      Content.toolCall(
                        ToolCallId.decode("dynamic-suspension-call"),
                        "dynamic-suspension",
                        "start",
                      ),
                    ],
                  },
                  finishReason: "tool-calls" as const,
                }
              : {
                  message: {
                    role: "assistant" as const,
                    content: [Content.text("complete")],
                  },
                  finishReason: "stop" as const,
                },
        };
      },
    });
    const agent = Agent.define({
      id: "dynamic-suspension-agent",
      fragments: Agent.combine(model, provider),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "suspended",
      suspensions: [{ toolName: "dynamic-suspension" }],
    });
    await expect(
      client.resumeRun({
        runId: submission.runId,
        items: [
          {
            dynamic: true,
            providerId: "suspending-tools",
            toolName: "dynamic-suspension",
            toolCallId: ToolCallId.decode("dynamic-suspension-call"),
            input: 1 as never,
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      run: { status: "suspended" },
      suspensions: [{ toolName: "dynamic-suspension" }],
    });
    await expect(
      client.resumeRun({
        runId: submission.runId,
        items: [
          {
            dynamic: true,
            providerId: "suspending-tools",
            toolName: "dynamic-suspension",
            toolCallId: ToolCallId.decode("dynamic-suspension-call"),
            input: "resume",
          },
        ],
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      toolCalls: [
        {
          toolName: "dynamic-suspension",
          result: { type: "success", output: "dynamic-state:resume" },
        },
      ],
    });
  });

  it("durably aborts a suspended Run and its unresolved Tool graph", async () => {
    const continuation = Codec.define({
      encode: (value: string) => value,
      decode: (value) => String(value),
    });
    const waiting = Tool.define({
      name: "waiting",
      input: stringSchema,
      output: stringSchema,
      handler: () => Tool.suspend("waiting"),
      suspension: {
        resumeInput: stringSchema,
        continuation,
        resume: ({ input }) => input,
      },
    });
    const model = Model.define({
      id: "abort-model",
      async *invoke() {
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.toolCall(ToolCallId.decode("waiting-call"), "waiting", "go")],
            },
            finishReason: "tool-calls" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "abort-agent",
      fragments: Agent.combine(model, waiting),
    });
    const { branch, client, app } = await fixture(agent);
    const submission = await submitStart(client, branch);
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "suspended",
    });

    await expect(client.abort(submission.runId, "stop")).resolves.toEqual({
      type: "accepted",
      runId: submission.runId,
    });
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "aborted",
      reason: "stop",
    });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      run: { status: "aborted" },
      toolCalls: [{ status: "aborted", result: { type: "aborted" } }],
    });
    const path = await app.readBranchHistory({
      threadId: branch.threadId,
      branchId: branch.id,
    });
    expect(path.at(-1)?.message).toMatchObject({
      role: "tool",
      content: [{ output: { type: "aborted" }, isFailure: true }],
    });
  });
});

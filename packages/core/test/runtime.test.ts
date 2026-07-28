import { MemoryThreadStore } from "@commissary/store-memory";
import { describe, expect, it } from "vitest";

import {
  Agent,
  Codec,
  Content,
  ExecutionClaimLostError,
  Hook,
  ThreadStoreError,
  Model,
  Tool,
  UnexpectedExecutionError,
  commissary,
  type AgentClient,
  type AgentDefinition,
  type ClaimRenewalResult,
  type Clock,
  type ExecutionClaim,
  type Loop,
  type ModelMessage,
  type RunId,
  type ResolvedExecution,
  type ToolCallId,
} from "../src/index.js";
import { numberSchema, stringSchema } from "./support.js";

const completingModel = Model.define({
  id: "completing-model",
  async *invoke() {
    yield { type: "text-delta" as const, delta: "hello" };
    yield {
      type: "finish" as const,
      response: {
        message: { role: "assistant" as const, content: [Content.text("hello")] },
        finishReason: "stop" as const,
      },
    };
  },
});

async function fixture<Definition extends AgentDefinition>(agent: Definition) {
  const store = new MemoryThreadStore();
  const app = commissary({ threadStore: store });
  const thread = await app.createThread();
  const branch = await app.createBranch({ threadId: thread.id, name: "main" });
  const client = app.agent(agent);
  return { app, store, thread, branch, client };
}

async function submitStart<Definition extends AgentDefinition>(
  client: AgentClient<Definition>,
  branch: {
    readonly id: import("../src/index.js").BranchId;
    readonly threadId: import("../src/index.js").ThreadId;
  },
  message = "start",
) {
  const submission = await client.submit({
    type: "start",
    threadId: branch.threadId,
    branchId: branch.id,
    message: { role: "user", content: [Content.text(message)] },
  });
  if (submission.type !== "submitted") {
    throw new Error(`Unexpected submission result '${submission.type}'`);
  }
  return submission;
}

describe("durable Runtime", () => {
  it("submits, executes, observes, snapshots, and reads one completed Run", async () => {
    const settled: unknown[] = [];
    const agent = Agent.define({
      id: "assistant",
      fragments: Agent.combine(
        completingModel,
        Hook.onSettlement(({ result }) => {
          settled.push(result);
          return undefined;
        }),
      ),
    });
    const { branch, client } = await fixture(agent);
    const events: unknown[] = [];
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        events.push(event);
        return undefined;
      }),
    );

    const submission = await submitStart(client, branch, "Hi");
    const execution = await client.execute(submission.runId);
    const result = await execution.result;

    expect(execution.id).toBeTypeOf("string");
    expect(result).toMatchObject({ type: "completed", runId: submission.runId });
    expect(events).toContainEqual({
      type: "model-event",
      event: { type: "text-delta", delta: "hello" },
    });
    await expect(client.readResult(submission.runId)).resolves.toEqual(result);
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      status: "completed",
      result,
      toolCalls: [],
      suspensions: [],
    });
    expect(settled).toEqual([result]);
  });

  it("lets a custom Loop orchestrate work only through Runtime Operations", async () => {
    const store = new MemoryThreadStore();
    const loop: Loop = {
      async execute(context) {
        const prepared = await context.runtime.prepare(context.runId);
        const invocation = await context.runtime.invokeModel(prepared);
        if (invocation.type !== "response") {
          throw new Error(`Unexpected Model result '${invocation.type}'`);
        }
        return context.runtime.settle(prepared, invocation);
      },
    };
    const app = commissary({ threadStore: store, loop });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({ id: "custom-loop-agent", fragments: completingModel });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("hello")] } },
    });
  });

  it("lets a custom Loop continue after durable Tool results", async () => {
    let modelCalls = 0;
    const echo = Tool.define({
      name: "loop-echo",
      input: stringSchema,
      output: stringSchema,
      handler: (input) => input,
    });
    const model = Model.define({
      id: "custom-loop-tool-model",
      async *invoke() {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield {
            type: "finish" as const,
            response: {
              message: {
                role: "assistant" as const,
                content: [Content.toolCall("custom-loop-call" as ToolCallId, "loop-echo", "value")],
              },
              finishReason: "tool-calls" as const,
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text("complete")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const loop: Loop = {
      async execute(context) {
        while (true) {
          const prepared = await context.runtime.prepare(context.runId);
          const invocation = await context.runtime.invokeModel(prepared);
          if (invocation.type === "response" && invocation.toolCalls.length > 0) {
            for (const call of invocation.toolCalls) {
              await context.runtime.executeTool(prepared, call);
            }
            continue;
          }
          return context.runtime.settle(prepared, invocation);
        }
      },
    };
    const store = new MemoryThreadStore();
    const app = commissary({ threadStore: store, loop });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({
      id: "custom-loop-tool-agent",
      fragments: Agent.combine(model, echo),
    });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("complete")] } },
    });
    expect(modelCalls).toBe(2);
  });

  it("rejects a custom Loop result that was not created by Runtime Operations", async () => {
    const store = new MemoryThreadStore();
    const loop: Loop = {
      async execute(context) {
        return {
          value: {
            type: "failed",
            runId: context.runId,
            failure: {
              type: "model-failure",
              reason: "other",
              message: "forged",
            },
          },
        } as ResolvedExecution;
      },
    };
    const app = commissary({ threadStore: store, loop });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({ id: "custom-loop-agent", fragments: completingModel });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
      phase: "loop",
      cause: { name: "RuntimeInvariantError" },
    });
  });

  it("uses the injected generator for core-owned IDs", async () => {
    let sequence = 0;
    const app = commissary({
      threadStore: new MemoryThreadStore(),
      generateId: () => `generated-${++sequence}`,
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({ id: "generated-id-agent", fragments: completingModel });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);

    expect(thread.id).toBe("generated-1");
    expect(branch.id).toBe("generated-2");
    expect(submission.runId).toBe("generated-3");
    expect(execution.id).toBe("generated-6");
    await expect(execution.result).resolves.toMatchObject({ type: "completed" });
  });

  it("uses a caller Run ID as an idempotent start key", async () => {
    const agent = Agent.define({ id: "idempotent-agent", fragments: completingModel });
    const { branch, client } = await fixture(agent);
    const runId = "run-fixed" as RunId;
    const command = {
      type: "start" as const,
      runId,
      threadId: branch.threadId,
      branchId: branch.id,
      message: { role: "user" as const, content: [Content.text("same")] },
    };

    await expect(client.submit(command)).resolves.toMatchObject({
      type: "submitted",
      admitted: true,
      runId,
    });
    await expect(client.submit(command)).resolves.toMatchObject({
      type: "submitted",
      admitted: false,
      runId,
    });
    await expect(
      client.submit({
        ...command,
        message: { role: "user", content: [Content.text("different")] },
      }),
    ).resolves.toEqual({ type: "run-conflict", runId });
  });

  it("captures static and dynamic Hooks in stable order for each Execution", async () => {
    const order: string[] = [];
    const agent = Agent.define({
      id: "hook-agent",
      fragments: Agent.combine(
        completingModel,
        Hook.beforeModelRequest(() => {
          order.push("static");
          return undefined;
        }),
      ),
    });
    const { branch, client } = await fixture(agent);
    const unsubscribeFirst = client.subscribe(
      Hook.beforeModelRequest(() => {
        order.push("dynamic-1");
        return undefined;
      }),
    );
    const unsubscribeSecond = client.subscribe(
      Hook.beforeModelRequest(() => {
        order.push("dynamic-2");
        return undefined;
      }),
    );
    const first = await submitStart(client, branch, "first");
    const execution = await client.execute(first.runId);
    unsubscribeFirst();
    unsubscribeFirst();
    client.subscribe(
      Hook.beforeModelRequest(() => {
        order.push("late");
        return undefined;
      }),
    );

    await execution.result;
    expect(order).toEqual(["static", "dynamic-1", "dynamic-2"]);

    unsubscribeSecond();
    order.length = 0;
    const snapshot = await client.readRunSnapshot(first.runId);
    const second = await client.submit({
      type: "start",
      threadId: branch.threadId,
      branchId: branch.id,
      expectedHead: snapshot?.head,
      message: { role: "user", content: [Content.text("second")] },
    });
    if (second.type !== "submitted") {
      throw new Error(`Unexpected submission result '${second.type}'`);
    }
    await (
      await client.execute(second.runId)
    ).result;
    expect(order).toEqual(["static", "late"]);
  });

  it("isolates notification errors and reports them to other Event observers", async () => {
    const agent = Agent.define({ id: "observer-agent", fragments: completingModel });
    const { branch, client } = await fixture(agent);
    const received: unknown[] = [];
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        if (event.type === "model-event") {
          throw new Error("observer failed");
        }
        return undefined;
      }),
    );
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        received.push(event);
        return undefined;
      }),
    );

    const submission = await submitStart(client, branch);
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(
      received.some(
        (event) =>
          typeof event === "object" && event !== null && "type" in event && event.type === "error",
      ),
    ).toBe(true);
  });

  it("does not publish a recursive Error Event during Error Event delivery", async () => {
    const defectiveModel = Model.define({
      id: "observer-error-model",
      invoke() {
        throw new Error("model failed");
      },
    });
    const agent = Agent.define({ id: "observer-error-agent", fragments: defectiveModel });
    const { branch, client } = await fixture(agent);
    let throwingObserverErrors = 0;
    let receivingObserverErrors = 0;
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        if (event.type === "error") {
          throwingObserverErrors += 1;
          throw new Error("error observer failed");
        }
        return undefined;
      }),
    );
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        if (event.type === "error") {
          receivingObserverErrors += 1;
        }
        return undefined;
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toBeInstanceOf(
      UnexpectedExecutionError,
    );
    expect(throwingObserverErrors).toBe(1);
    expect(receivingObserverErrors).toBe(1);
  });

  it("classifies a malformed transformation Hook result as a Hook Defect", async () => {
    const agent = Agent.define({
      id: "malformed-hook-agent",
      fragments: Agent.combine(
        completingModel,
        Hook.beforeModelRequest(() => 1 as never),
      ),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
      phase: "hook",
    });
  });

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
        const snapshot = await client.readRunSnapshot(context.runId);
        expect(snapshot?.toolCalls).toMatchObject([
          { toolCallId: context.toolCallId, status: "pending", input: `${input}` },
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
          const call = Content.toolCall("call-echo" as ToolCallId, "echo", "raw");
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
          input: "raw!",
          result: { type: "success", output: "raw!" },
        },
      ],
    });
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
                  Content.toolCall("call-first" as ToolCallId, "first", "a"),
                  Content.toolCall("call-second" as ToolCallId, "second", "b"),
                ],
              },
              finishReason: "tool-calls" as const,
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("done")] },
            finishReason: "stop" as const,
            usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
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
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
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
      foreignClient.submit({
        type: "resume",
        runId: submission.runId,
        items: [{ toolName: "first", toolCallId: "call-first" as ToolCallId, input: "wrong" }],
      }),
    ).resolves.toMatchObject({
      type: "tool-resume-conflict",
      toolCallIds: ["call-first"],
    });
    await expect(
      client.submit({
        type: "resume",
        runId: submission.runId,
        toolResumeRequestId: "resume-both",
        items: [
          { toolName: "first", toolCallId: "call-first" as ToolCallId, input: 1 },
          { toolName: "second", toolCallId: "call-second" as ToolCallId, input: 2 },
        ],
      }),
    ).resolves.toMatchObject({ type: "submitted", admitted: true });
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      status: "completed",
      suspensions: [],
      toolCalls: [
        { status: "succeeded", result: { output: "first-state:1" } },
        { status: "succeeded", result: { output: "second-state:2" } },
      ],
    });
  });

  it("interrupts resumed Tool state created by a different Agent revision", async () => {
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
                      Content.toolCall("revisioned-call" as ToolCallId, "revisioned-tool", "start"),
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
    const store = new MemoryThreadStore();
    const oldApp = commissary({ threadStore: store });
    const thread = await oldApp.createThread();
    const branch = await oldApp.createBranch({ threadId: thread.id, name: "main" });
    const oldClient = oldApp.agent(oldAgent);
    const submission = await submitStart(oldClient, branch);
    await expect((await oldClient.execute(submission.runId)).result).resolves.toMatchObject({
      type: "suspended",
    });
    await expect(
      oldClient.submit({
        type: "resume",
        runId: submission.runId,
        items: [
          {
            toolName: "revisioned-tool",
            toolCallId: "revisioned-call" as ToolCallId,
            input: "resume",
          },
        ],
      }),
    ).resolves.toMatchObject({ type: "submitted" });

    const newClient = commissary({ threadStore: store }).agent(newAgent);
    expect(newClient.reference.revision).not.toBe(oldClient.reference.revision);
    await expect((await newClient.execute(submission.runId)).result).resolves.toMatchObject({
      type: "interrupted",
      interruption: {
        type: "stale-agent",
        expected: oldClient.reference,
        installed: newClient.reference,
      },
    });
    expect(resumedByNewAgent).toBe(0);
  });

  it("records delegated children and reuses their stable result", async () => {
    let childAttempts = 0;
    const child = Tool.define({
      name: "child",
      input: numberSchema,
      output: numberSchema,
      handler(input) {
        childAttempts += 1;
        return input * 2;
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
                    content: [Content.toolCall("parent-call" as ToolCallId, "parent", 3)],
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
    const store = new MemoryThreadStore();
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
          definition: {
            name: "square",
            inputSchema: { type: "number" },
          },
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
                      Content.toolCall("dynamic-parent-call" as ToolCallId, "dynamic-parent", 4),
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
              content: [Content.toolCall("waiting-call" as ToolCallId, "waiting", "go")],
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
      status: "aborted",
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

  it("continues from steering accepted during terminal Model finalization", async () => {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    const model = Model.define({
      id: "steering-race-model",
      async *invoke() {
        invocations += 1;
        if (invocations === 1) {
          started();
          await gate;
        }
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text(invocations === 1 ? "first" : "second")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({ id: "steering-race-agent", fragments: model });
    const { app, branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);
    await modelStarted;

    const steering = {
      runId: submission.runId,
      steeringRequestId: "during-finalization",
      message: { role: "user" as const, content: [Content.text("steer")] },
    };
    await expect(client.steer(steering)).resolves.toMatchObject({
      type: "accepted",
      admitted: true,
    });
    release();

    await expect(execution.result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("second")] } },
    });
    expect(invocations).toBe(2);
    await expect(client.steer(steering)).resolves.toMatchObject({
      type: "accepted",
      admitted: false,
    });
    const history = await app.readBranchHistory({
      threadId: branch.threadId,
      branchId: branch.id,
    });
    expect(history.map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("continues from steering accepted before a terminal Model Failure", async () => {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    const model = Model.define({
      id: "steering-failure-race-model",
      async *invoke() {
        invocations += 1;
        if (invocations === 1) {
          started();
          await gate;
          yield {
            type: "failure" as const,
            failure: {
              type: "model-failure" as const,
              reason: "content-policy" as const,
              provider: "test",
              message: "blocked",
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("recovered")] },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({ id: "steering-failure-race-agent", fragments: model });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);
    await modelStarted;

    await expect(
      client.steer({
        runId: submission.runId,
        message: { role: "user", content: [Content.text("recover")] },
      }),
    ).resolves.toMatchObject({ type: "accepted" });
    release();

    await expect(execution.result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("recovered")] } },
    });
    expect(invocations).toBe(2);
  });

  it("rejects the Execution result with the same reported Claim loss error", async () => {
    class LosingStore extends MemoryThreadStore {
      override renewExecutionClaim(): PromiseLike<ClaimRenewalResult> {
        return Promise.resolve({ type: "claim-lost" });
      }
    }
    const store = new LosingStore();
    const waitingModel = Model.define({
      id: "waiting-model",
      async *invoke(_request, context) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        });
        yield { type: "text-delta" as const, delta: "unreachable" };
      },
    });
    const agent = Agent.define({ id: "claim-agent", fragments: waitingModel });
    const app = commissary({
      threadStore: store,
      executionClaims: { leaseDurationMs: 10 },
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(agent);
    let reported: unknown;
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        if (event.type === "error") {
          reported = event.error;
        }
        return undefined;
      }),
    );
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);

    await expect(execution.result).rejects.toBeInstanceOf(ExecutionClaimLostError);
    expect(reported).toBeInstanceOf(ExecutionClaimLostError);
  });

  it("routes through a declared child Model and applies Model Hooks only to the leaf", async () => {
    let beforeCalls = 0;
    const child = Model.define({
      id: "routed-child",
      async *invoke() {
        yield { type: "text-delta" as const, delta: "child" };
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text("child")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const composite = Model.composite({
      id: "router",
      children: [child],
      invoke(request, context) {
        return context.forward(child, request, { key: "selected" });
      },
    });
    const agent = Agent.define({
      id: "composite-agent",
      fragments: Agent.combine(
        composite,
        Hook.beforeModelRequest(() => {
          beforeCalls += 1;
          return undefined;
        }),
      ),
    });
    const { branch, client } = await fixture(agent);
    const events: unknown[] = [];
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        events.push(event);
        return undefined;
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("child")] } },
    });
    expect(beforeCalls).toBe(1);
    expect(events).toContainEqual({
      type: "model-event",
      event: { type: "text-delta", delta: "child" },
    });
  });

  it("can consume one child result and forward a fallback without leaking Events", async () => {
    const primary = Model.define({
      id: "primary-child",
      async *invoke() {
        yield { type: "text-delta" as const, delta: "hidden" };
        yield {
          type: "interruption" as const,
          interruption: {
            type: "model-output" as const,
            provider: "primary",
            detail: "Primary output was unusable",
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        };
      },
    });
    const fallback = Model.define({
      id: "fallback-child",
      async *invoke() {
        yield { type: "text-delta" as const, delta: "visible" };
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text("visible")],
            },
            finishReason: "stop" as const,
            usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
          },
        };
      },
    });
    const composite = Model.composite({
      id: "fallback",
      children: [primary, fallback],
      async invoke(request, context) {
        const result = await context.invoke(primary, request, { key: "primary" });
        return result.type === "response"
          ? Model.events(result)
          : context.forward(fallback, request, { key: "fallback" });
      },
    });
    const agent = Agent.define({ id: "fallback-agent", fragments: composite });
    const { branch, client } = await fixture(agent);
    const deltas: string[] = [];
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        if (event.type === "model-event" && event.event.type === "text-delta") {
          deltas.push(event.event.delta);
        }
        return undefined;
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
      response: { message: { content: [Content.text("visible")] } },
    });
    expect(deltas).toEqual(["visible"]);
  });

  it("retries a declared Model Interruption only when a decision Hook requests it", async () => {
    let invocations = 0;
    const model = Model.define({
      id: "retry-model",
      async *invoke() {
        invocations += 1;
        if (invocations === 1) {
          yield {
            type: "interruption" as const,
            interruption: {
              type: "model-output" as const,
              provider: "test",
              detail: "retry",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("done")] },
            finishReason: "stop" as const,
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          },
        };
      },
    });
    const agent = Agent.define({
      id: "retry-agent",
      fragments: Agent.combine(
        model,
        Hook.afterModelInvocation(({ invocation }) =>
          invocation.type === "interruption" ? { type: "retry", delayMs: 25 } : undefined,
        ),
      ),
    });
    const sleeps: number[] = [];
    const clock: Clock = {
      now: () => 0,
      sleep(milliseconds, signal) {
        sleeps.push(milliseconds);
        if (milliseconds === 25) {
          return Promise.resolve();
        }
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };
    const store = new MemoryThreadStore();
    const app = commissary({ threadStore: store, clock });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(invocations).toBe(2);
    expect(sleeps).toEqual([30_000, 25]);
  });

  it("emits a specific Error Event when Claim release fails", async () => {
    class FailingReleaseStore extends MemoryThreadStore {
      override releaseExecutionClaim(_claim: ExecutionClaim): PromiseLike<boolean> {
        return Promise.reject(new Error("release failed"));
      }
    }

    const store = new FailingReleaseStore();
    const app = commissary({ threadStore: store });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({ id: "release-failure-agent", fragments: completingModel });
    const client = app.agent(agent);
    const events: unknown[] = [];
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        events.push(event);
        return undefined;
      }),
    );
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);

    const error = await execution.result.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ThreadStoreError);
    expect(events).toContainEqual({ type: "error", error });
  });

  it("wraps undeclared exceptions and emits the same terminal Error Event", async () => {
    const model = Model.define({
      id: "defect-model",
      invoke() {
        throw new Error("broken provider");
      },
    });
    const agent = Agent.define({ id: "defect-agent", fragments: model });
    const { branch, client } = await fixture(agent);
    let reported: unknown;
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        if (event.type === "error") {
          reported = event.error;
        }
        return undefined;
      }),
    );
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);

    await expect(execution.result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
      phase: "model",
    });
    expect(reported).toBeInstanceOf(UnexpectedExecutionError);
  });
});

import { MemoryThreadStore } from "@commissary/store-memory";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Context,
  Content,
  Model,
  Tool,
  commissary,
  type ExecutionClaim,
  type Loop,
  type ModelMessage,
  type ResolvedExecution,
  ToolCallId,
} from "@commissary/core";
import { stringSchema } from "../support.js";
import { completingModel, fixture, submitStart, toolCallId } from "./support.js";

describe("Runtime Loops", () => {
  it("lets a custom Loop orchestrate work only through Runtime Operations", async () => {
    const store = MemoryThreadStore.make();
    const loop: Loop = {
      async execute(context) {
        const prepared = await context.runtime.prepare(context.runId);
        if (prepared.type !== "model") {
          throw new Error("Unexpected Tool work");
        }
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
                content: [
                  Content.toolCall(ToolCallId.decode("custom-loop-call"), "loop-echo", "value"),
                ],
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
          if (prepared.type === "tools") {
            for (const call of prepared.calls) {
              await context.runtime.executeTool(prepared, call);
            }
            continue;
          }
          const invocation = await context.runtime.invokeModel(prepared);
          if (invocation.type === "response" && invocation.toolCalls.length > 0) {
            continue;
          }
          return context.runtime.settle(prepared, invocation);
        }
      },
    };
    const store = MemoryThreadStore.make();
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

  it("commits concurrent Tool results in durable call order", async () => {
    let modelCalls = 0;
    let releaseTools!: () => void;
    const toolsReady = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    let enteredTools = 0;
    const echo = Tool.define({
      name: "concurrent-echo",
      input: stringSchema,
      output: stringSchema,
      async handler(input) {
        enteredTools += 1;
        if (enteredTools === 2) {
          releaseTools();
        }
        await toolsReady;
        return input;
      },
    });
    let secondRequest: readonly ModelMessage[] = [];
    const model = Model.define({
      id: "concurrent-tool-model",
      async *invoke(request) {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield {
            type: "finish" as const,
            response: {
              message: {
                role: "assistant" as const,
                content: [
                  Content.toolCall(
                    ToolCallId.decode("concurrent-call-1"),
                    "concurrent-echo",
                    "one",
                  ),
                  Content.toolCall(
                    ToolCallId.decode("concurrent-call-2"),
                    "concurrent-echo",
                    "two",
                  ),
                ],
              },
              finishReason: "tool-calls" as const,
            },
          };
          return;
        }
        secondRequest = request.messages;
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
          if (prepared.type === "tools") {
            await Promise.all(
              prepared.calls.map((call) => context.runtime.executeTool(prepared, call)),
            );
            continue;
          }
          const invocation = await context.runtime.invokeModel(prepared);
          if (invocation.type === "response" && invocation.toolCalls.length > 0) {
            continue;
          }
          return context.runtime.settle(prepared, invocation);
        }
      },
    };
    const store = MemoryThreadStore.make();
    const app = commissary({ threadStore: store, loop });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({
      id: "concurrent-tool-agent",
      fragments: Agent.combine(model, echo),
    });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(
      secondRequest
        .filter((message) => message.role === "tool")
        .flatMap((message) => message.content)
        .filter((part) => part.type === "tool-result")
        .map((part) => [part.toolCallId, part.output]),
    ).toEqual([
      ["concurrent-call-1", "one"],
      ["concurrent-call-2", "two"],
    ]);
  });

  it("executes a Model-requested Tool batch concurrently by default", async () => {
    let firstActive = false;
    let overlapped = false;
    const echo = Tool.define({
      name: "parallel-default-echo",
      input: stringSchema,
      output: stringSchema,
      async handler(input) {
        if (input === "one") {
          firstActive = true;
          await new Promise((resolve) => setTimeout(resolve, 25));
          firstActive = false;
        } else {
          overlapped = firstActive;
        }
        return input;
      },
    });
    let modelCalls = 0;
    const model = Model.define({
      id: "parallel-default-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content:
                modelCalls === 1
                  ? [
                      Content.toolCall(
                        toolCallId("parallel-call-1"),
                        "parallel-default-echo",
                        "one",
                      ),
                      Content.toolCall(
                        toolCallId("parallel-call-2"),
                        "parallel-default-echo",
                        "two",
                      ),
                    ]
                  : [Content.text("complete")],
            },
            finishReason: modelCalls === 1 ? ("tool-calls" as const) : ("stop" as const),
          },
        };
      },
    });
    const { branch, client } = await fixture(
      Agent.define({
        id: "parallel-default-agent",
        fragments: Agent.combine(model, echo),
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(overlapped).toBe(true);
  });

  it("executes the complete Tool batch sequentially when one Tool requires it", async () => {
    let firstCompleted = false;
    let secondObservedCompletion = false;
    const first = Tool.define({
      name: "sequential-first",
      input: stringSchema,
      output: stringSchema,
      async handler(input) {
        await Promise.resolve();
        firstCompleted = true;
        return input;
      },
    });
    const second = Tool.define({
      name: "sequential-second",
      executionMode: "sequential",
      input: stringSchema,
      output: stringSchema,
      handler(input) {
        secondObservedCompletion = firstCompleted;
        return input;
      },
    });
    let modelCalls = 0;
    const model = Model.define({
      id: "sequential-tool-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content:
                modelCalls === 1
                  ? [
                      Content.toolCall(toolCallId("sequential-call-1"), "sequential-first", "one"),
                      Content.toolCall(toolCallId("sequential-call-2"), "sequential-second", "two"),
                    ]
                  : [Content.text("complete")],
            },
            finishReason: modelCalls === 1 ? ("tool-calls" as const) : ("stop" as const),
          },
        };
      },
    });
    const { branch, client } = await fixture(
      Agent.define({
        id: "sequential-tool-agent",
        fragments: Agent.combine(model, first, second),
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(secondObservedCompletion).toBe(true);
  });

  it("skips Context and unrelated Dynamic Tool resolution during Tool Work", async () => {
    let contextRenders = 0;
    let providerResolutions = 0;
    const context = Context.define({
      id: "model-only-context",
      render() {
        contextRenders += 1;
        return [];
      },
    });
    const provider = Tool.dynamic({
      id: "unrelated-provider",
      resolve() {
        providerResolutions += 1;
        return [
          {
            type: "dynamic-tool",
            name: "unrelated-dynamic-tool",
            input: stringSchema,
            execute: (input: unknown) => input,
          },
        ];
      },
    });
    const echo = Tool.define({
      name: "static-preparation-echo",
      input: stringSchema,
      output: stringSchema,
      handler: (input) => input,
    });
    let modelCalls = 0;
    const model = Model.define({
      id: "preparation-scope-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content:
                modelCalls === 1
                  ? [
                      Content.toolCall(
                        toolCallId("preparation-scope-call"),
                        "static-preparation-echo",
                        "value",
                      ),
                    ]
                  : [Content.text("complete")],
            },
            finishReason: modelCalls === 1 ? ("tool-calls" as const) : ("stop" as const),
          },
        };
      },
    });
    const { branch, client } = await fixture(
      Agent.define({
        id: "preparation-scope-agent",
        fragments: Agent.combine(context, provider, model, echo),
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(contextRenders).toBe(2);
    expect(providerResolutions).toBe(2);
  });

  it("resolves Dynamic Tool Providers and Context contributions concurrently in order", async () => {
    let firstProviderActive = false;
    let secondProviderOverlapped = false;
    let firstContextActive = false;
    let secondContextOverlapped = false;
    const firstProvider = Tool.dynamic({
      id: "concurrent-provider-first",
      async resolve() {
        firstProviderActive = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        firstProviderActive = false;
        return [
          {
            type: "dynamic-tool",
            name: "concurrent-provider-tool-first",
            input: stringSchema,
            execute: (input: unknown) => input,
          },
        ];
      },
    });
    const secondProvider = Tool.dynamic({
      id: "concurrent-provider-second",
      resolve() {
        secondProviderOverlapped = firstProviderActive;
        return [
          {
            type: "dynamic-tool",
            name: "concurrent-provider-tool-second",
            input: stringSchema,
            execute: (input: unknown) => input,
          },
        ];
      },
    });
    const firstContext = Context.define({
      id: "concurrent-context-first",
      async render() {
        firstContextActive = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        firstContextActive = false;
        return [];
      },
    });
    const secondContext = Context.define({
      id: "concurrent-context-second",
      render() {
        secondContextOverlapped = firstContextActive;
        return [];
      },
    });
    let contextIds: readonly string[] = [];
    let toolNames: readonly string[] = [];
    const model = Model.define({
      id: "concurrent-preparation-model",
      async *invoke(request) {
        contextIds = request.context.map((node) => node.id);
        toolNames = request.tools.map((tool) => tool.name);
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
    const { branch, client } = await fixture(
      Agent.define({
        id: "concurrent-preparation-agent",
        fragments: Agent.combine(firstProvider, secondProvider, firstContext, secondContext, model),
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(secondProviderOverlapped).toBe(true);
    expect(secondContextOverlapped).toBe(true);
    expect(toolNames).toEqual([
      "concurrent-provider-tool-first",
      "concurrent-provider-tool-second",
    ]);
    expect(contextIds).toEqual(["concurrent-context-first", "concurrent-context-second"]);
  });

  it("observes concurrent Context failures while Providers are still resolving", async () => {
    const contextFailure = new Error("Context rendering failed");
    const slowProvider = Tool.dynamic({
      id: "slow-failing-preparation-provider",
      async resolve() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [];
      },
    });
    const failingContext = Context.define({
      id: "failing-concurrent-context",
      render() {
        throw contextFailure;
      },
    });
    let modelCalls = 0;
    const model = Model.define({
      id: "failing-concurrent-preparation-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text("unexpected")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const { branch, client } = await fixture(
      Agent.define({
        id: "failing-concurrent-preparation-agent",
        fragments: Agent.combine(slowProvider, failingContext, model),
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
      phase: "prepare",
      cause: contextFailure,
    });
    expect(modelCalls).toBe(0);
  });

  it("loads each prepared Tool Call without reloading the full Execution", async () => {
    let executionLoads = 0;
    let toolCallLoads = 0;
    const baseStore = MemoryThreadStore.make();
    const store = new Proxy(baseStore, {
      get(target, property, receiver) {
        if (property === "loadExecution") {
          return async (claim: ExecutionClaim) => {
            executionLoads += 1;
            return target.loadExecution(claim);
          };
        }
        if (property === "loadToolCall") {
          return async (claim: ExecutionClaim, id: ToolCallId) => {
            toolCallLoads += 1;
            return target.loadToolCall(claim, id);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const echo = Tool.define({
      name: "narrow-load-echo",
      input: stringSchema,
      output: stringSchema,
      handler: (input) => input,
    });
    let modelCalls = 0;
    const model = Model.define({
      id: "narrow-load-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content:
                modelCalls === 1
                  ? [
                      Content.toolCall(toolCallId("narrow-call-1"), "narrow-load-echo", "one"),
                      Content.toolCall(toolCallId("narrow-call-2"), "narrow-load-echo", "two"),
                    ]
                  : [Content.text("complete")],
            },
            finishReason: modelCalls === 1 ? ("tool-calls" as const) : ("stop" as const),
          },
        };
      },
    });
    const app = commissary({ threadStore: store });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({
      id: "narrow-load-agent",
      fragments: Agent.combine(model, echo),
    });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(toolCallLoads).toBe(2);
    expect(executionLoads).toBe(5);
  });

  it("recovers committed Tool work after an Execution stops", async () => {
    let executionCalls = 0;
    let modelCalls = 0;
    let toolCalls = 0;
    const echo = Tool.define({
      name: "recovery-echo",
      input: stringSchema,
      output: stringSchema,
      handler: (input) => {
        toolCalls += 1;
        return input;
      },
    });
    const model = Model.define({
      id: "recovery-model",
      async *invoke() {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield {
            type: "finish" as const,
            response: {
              message: {
                role: "assistant" as const,
                content: [
                  Content.toolCall(ToolCallId.decode("recovery-call"), "recovery-echo", "value"),
                ],
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
              content: [Content.text("recovered")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const loop: Loop = {
      async execute(context) {
        executionCalls += 1;
        while (true) {
          const work = await context.runtime.prepare(context.runId);
          if (work.type === "tools") {
            for (const call of work.calls) {
              await context.runtime.executeTool(work, call);
            }
            continue;
          }
          const invocation = await context.runtime.invokeModel(work);
          if (executionCalls === 1) {
            throw new Error("process stopped after Model commit");
          }
          return context.runtime.settle(work, invocation);
        }
      },
    };
    const store = MemoryThreadStore.make();
    const app = commissary({ threadStore: store, loop });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({
      id: "recovery-agent",
      fragments: Agent.combine(model, echo),
    });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
    });
    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("recovered")] } },
    });
    expect(modelCalls).toBe(2);
    expect(toolCalls).toBe(1);
  });

  it("rejects a custom Loop result that was not created by Runtime Operations", async () => {
    const store = MemoryThreadStore.make();
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
});

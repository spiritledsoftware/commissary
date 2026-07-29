import { MemoryThreadStore } from "@commissary/store-memory";
import { describe, expect, it } from "vitest";

import {
  Agent,
  Codec,
  Context,
  Content,
  ExecutionClaimLostError,
  ExecutionEventStoreError,
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
  type ExecutionEventRecord,
  type ExecutionEventStore,
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

function recordingEventStore(
  batches: Array<readonly ExecutionEventRecord[]>,
  order?: string[],
): ExecutionEventStore {
  const sequenceByRun = new Map<RunId, number>();
  return {
    append(events) {
      const records = events.map((event) => {
        const sequence = (sequenceByRun.get(event.runId) ?? 0) + 1;
        sequenceByRun.set(event.runId, sequence);
        return Object.freeze({ ...event, sequence });
      });
      batches.push(records);
      if (order !== undefined) {
        order.push(`store:${records[0]?.event.type}`);
      }
    },
  };
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

function toolCallId(value: string): ToolCallId {
  // SAFETY: Tests use deterministic unique strings at the Tool Call ID boundary.
  return value as ToolCallId;
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

  it("durably appends ordered Event batches before local observation", async () => {
    const order: string[] = [];
    const batches: Array<readonly ExecutionEventRecord[]> = [];
    const store = new MemoryThreadStore();
    const app = commissary({
      threadStore: store,
      executionEventStore: recordingEventStore(batches, order),
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const model = Model.define({
      id: "durable-event-model",
      async *invoke() {
        yield { type: "text-delta" as const, delta: "a" };
        yield { type: "text-delta" as const, delta: "b" };
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("ab")] },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "durable-event-agent",
      fragments: Agent.combine(
        model,
        Hook.onExecutionEvent(({ event }) => {
          order.push(`hook:${event.type}`);
        }),
      ),
    });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(batches[0]?.map((record) => record.event)).toEqual([
      { type: "model-event", event: { type: "text-delta", delta: "ab" } },
    ]);
    expect(order.slice(0, 2)).toEqual(["store:model-event", "hook:model-event"]);
    expect(
      batches.flatMap((batch) => batch).every((record) => record.runId === submission.runId),
    ).toBe(true);
  });

  it("flushes accumulated streamed text by UTF-8 byte size", async () => {
    const batches: Array<readonly ExecutionEventRecord[]> = [];
    const chunk = "😀".repeat(8_192);
    const store = new MemoryThreadStore();
    const app = commissary({
      threadStore: store,
      executionEventStore: recordingEventStore(batches),
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const model = Model.define({
      id: "utf8-event-buffer-model",
      async *invoke() {
        yield { type: "text-delta" as const, delta: chunk };
        yield { type: "text-delta" as const, delta: chunk };
        yield { type: "text-delta" as const, delta: chunk };
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("complete")] },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const client = app.agent(
      Agent.define({
        id: "utf8-event-buffer-agent",
        fragments: model,
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    const persistedDeltaLengths = batches
      .flatMap((batch) => batch)
      .flatMap((record) =>
        record.event.type === "model-event" && record.event.event.type === "text-delta"
          ? [record.event.event.delta.length]
          : [],
      );
    expect(persistedDeltaLengths).toEqual([chunk.length * 2, chunk.length]);
  });

  it("durably appends observer Error Events before their local delivery", async () => {
    const batches: Array<readonly ExecutionEventRecord[]> = [];
    let observedErrors = 0;
    const store = new MemoryThreadStore();
    const app = commissary({
      threadStore: store,
      executionEventStore: recordingEventStore(batches),
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({
      id: "durable-observer-error-agent",
      fragments: Agent.combine(
        completingModel,
        Hook.onExecutionEvent(({ event }) => {
          if (event.type === "model-event") {
            throw new Error("observer failed");
          }
          return undefined;
        }),
        Hook.onExecutionEvent(({ event }) => {
          if (event.type === "error") {
            const persisted = batches
              .flatMap((batch) => batch)
              .some((record) => record.event === event);
            expect(persisted).toBe(true);
            observedErrors += 1;
          }
          return undefined;
        }),
      ),
    });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(observedErrors).toBeGreaterThan(0);
    const sequences = batches.flatMap((batch) => batch.map((record) => record.sequence));
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  });

  it("rejects an Execution when durable Event append fails", async () => {
    const store = new MemoryThreadStore();
    const app = commissary({
      threadStore: store,
      executionEventStore: {
        append() {
          throw new Error("event storage unavailable");
        },
      },
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(
      Agent.define({ id: "event-failure-agent", fragments: completingModel }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toBeInstanceOf(
      ExecutionEventStoreError,
    );
    await expect(client.readResult(submission.runId)).resolves.toBeUndefined();
  });

  it("lets a custom Loop orchestrate work only through Runtime Operations", async () => {
    const store = new MemoryThreadStore();
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
                  Content.toolCall("concurrent-call-1" as ToolCallId, "concurrent-echo", "one"),
                  Content.toolCall("concurrent-call-2" as ToolCallId, "concurrent-echo", "two"),
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
    const store = new MemoryThreadStore();
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
    class CountingStore extends MemoryThreadStore {
      executionLoads = 0;
      toolCallLoads = 0;

      override loadExecution(claim: ExecutionClaim) {
        this.executionLoads += 1;
        return super.loadExecution(claim);
      }

      override loadToolCall(claim: ExecutionClaim, toolCallId: ToolCallId) {
        this.toolCallLoads += 1;
        return super.loadToolCall(claim, toolCallId);
      }
    }

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
    const store = new CountingStore();
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
    expect(store.toolCallLoads).toBe(2);
    expect(store.executionLoads).toBe(5);
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
                  Content.toolCall("recovery-call" as ToolCallId, "recovery-echo", "value"),
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
    const store = new MemoryThreadStore();
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

  it("keeps colon-delimited command request identities separate", async () => {
    const agent = Agent.define({ id: "request-key-agent", fragments: completingModel });
    const { app, thread, branch, client } = await fixture(agent);
    const secondBranch = await app.createBranch({
      threadId: thread.id,
      name: "second",
    });
    await client.submit({
      type: "start",
      runId: "run:one" as RunId,
      threadId: branch.threadId,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("first")] },
    });
    await client.submit({
      type: "start",
      runId: "run" as RunId,
      threadId: secondBranch.threadId,
      branchId: secondBranch.id,
      message: { role: "user", content: [Content.text("second")] },
    });

    await expect(
      client.redirect({
        runId: "run:one" as RunId,
        redirectRequestId: "redirect",
        message: { role: "user", content: [Content.text("first redirect")] },
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
    await expect(
      client.redirect({
        runId: "run" as RunId,
        redirectRequestId: "one:redirect",
        message: { role: "user", content: [Content.text("second redirect")] },
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
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

  it.each([
    [
      "Failure Event",
      {
        type: "failure",
        failure: {
          type: "model-failure",
          reason: "content-policy",
          message: "blocked",
        },
      },
    ],
    [
      "Interruption Event",
      {
        type: "interruption",
        interruption: {
          type: "provider-unavailable",
          provider: "provider",
          reason: "unknown",
        },
      },
    ],
    [
      "rich Content",
      {
        type: "finish",
        response: {
          message: {
            role: "assistant",
            content: [
              {
                type: "file",
                artifact: { id: "artifact", mediaType: 1 },
              },
            ],
          },
          finishReason: "stop",
        },
      },
    ],
  ] as const)("rejects malformed transformed %s", async (label, event) => {
    const agent = Agent.define({
      id: `malformed-${label.toLowerCase().replaceAll(" ", "-")}`,
      fragments: Agent.combine(
        completingModel,
        Hook.transformModelEvent(() => ({ event }) as never),
      ),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
      phase: "hook",
    });
  });

  it("lets beforeModelRequest hide installed Tools without changing their contracts", async () => {
    let advertisedTools: readonly string[] = [];
    const hidden = Tool.define({
      name: "hidden-tool",
      input: stringSchema,
      handler: (input) => input,
    });
    const model = Model.define({
      id: "hidden-tool-model",
      async *invoke(request) {
        advertisedTools = request.tools.map((tool) => tool.name);
        yield {
          type: "finish" as const,
          response: {
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
      id: "hidden-tool-agent",
      fragments: Agent.combine(
        model,
        hidden,
        Hook.beforeModelRequest(({ request }) => ({
          request: { ...request, tools: [] },
        })),
      ),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(advertisedTools).toEqual([]);
  });

  it("publishes only transformed root Model Events and the final replacement", async () => {
    const observed: unknown[] = [];
    const model = Model.define({
      id: "model-transform",
      async *invoke() {
        yield { type: "text-delta" as const, delta: "preview" };
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text("source")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "model-transform-agent",
      fragments: Agent.combine(
        model,
        Hook.transformModelEvent(({ event }) =>
          event.type === "text-delta"
            ? { event: { type: "text-delta", delta: event.delta.toUpperCase() } }
            : undefined,
        ),
        Hook.afterModelInvocation(({ invocation }) =>
          invocation.type === "response"
            ? {
                invocation: {
                  type: "response",
                  response: {
                    message: {
                      role: "assistant",
                      content: [Content.text("replacement")],
                    },
                    finishReason: "stop",
                  },
                },
              }
            : undefined,
        ),
      ),
    });
    const { branch, client } = await fixture(agent);
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        if (event.type === "model-event") {
          observed.push(event.event);
        }
        return undefined;
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      response: {
        message: { content: [Content.text("replacement")] },
      },
    });
    expect(observed).toEqual([
      { type: "text-delta", delta: "PREVIEW" },
      {
        type: "finish",
        response: {
          message: {
            role: "assistant",
            content: [Content.text("replacement")],
          },
          finishReason: "stop",
        },
      },
    ]);
  });

  it("validates and saves replacements from afterToolExecution", async () => {
    const requests: Array<readonly ModelMessage[]> = [];
    let modelCalls = 0;
    const echo = Tool.define({
      name: "replace-tool-result",
      input: stringSchema,
      output: stringSchema,
      handler: (input) => input,
    });
    const model = Model.define({
      id: "replace-tool-result-model",
      async *invoke(request) {
        requests.push(request.messages);
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
                        "replace-tool-result-call" as ToolCallId,
                        "replace-tool-result",
                        "source",
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
      id: "replace-tool-result-agent",
      fragments: Agent.combine(
        model,
        echo,
        Hook.afterToolExecution(({ result }) =>
          result.type === "success"
            ? {
                result: {
                  type: "success",
                  output: "replacement",
                  content: [Content.text("extra")],
                },
              }
            : undefined,
        ),
      ),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(requests[1]?.at(-1)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "replace-tool-result",
          toolCallId: "replace-tool-result-call",
          output: "replacement",
        },
        Content.text("extra"),
      ],
    });
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      toolCalls: [
        {
          result: {
            type: "success",
            output: "replacement",
            content: [Content.text("extra")],
          },
        },
      ],
    });
  });

  it("limits durable settlement continuations to 32 Steps", async () => {
    let modelCalls = 0;
    const model = Model.define({
      id: "settlement-continuation-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text(`turn-${modelCalls}`)],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "settlement-continuation-agent",
      fragments: Agent.combine(
        model,
        Hook.beforeSettlement(() => ({
          type: "continue",
          instruction: {
            role: "user",
            content: [Content.text("continue")],
          },
        })),
      ),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      response: {
        message: { content: [Content.text("turn-33")] },
      },
    });
    expect(modelCalls).toBe(33);
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      settlementContinuations: 32,
    });
  });

  it("lets Redirect win a race with settlement continuation", async () => {
    let client!: AgentClient<typeof agent>;
    let modelCalls = 0;
    const requests: Array<readonly ModelMessage[]> = [];
    const model = Model.define({
      id: "settlement-redirect-model",
      async *invoke(request) {
        requests.push(request.messages);
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text(`candidate-${modelCalls}`)],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "settlement-redirect-agent",
      fragments: Agent.combine(
        model,
        Hook.beforeSettlement(async ({ run }) => {
          if (modelCalls !== 1) {
            return undefined;
          }
          await client.redirect({
            runId: run.runId,
            message: {
              role: "user",
              content: [Content.text("redirect")],
            },
          });
          return {
            type: "continue",
            instruction: {
              role: "user",
              content: [Content.text("gate")],
            },
          };
        }),
      ),
    });
    const built = await fixture(agent);
    client = built.client;
    const submission = await submitStart(client, built.branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      response: {
        message: { content: [Content.text("candidate-2")] },
      },
    });
    expect(requests[1]).toEqual([
      { role: "user", content: [Content.text("start")] },
      { role: "user", content: [Content.text("redirect")] },
    ]);
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      settlementContinuations: 0,
    });
  });

  it("lets Steering replace a raced settlement continuation", async () => {
    let client!: AgentClient<typeof agent>;
    let modelCalls = 0;
    const requests: Array<readonly ModelMessage[]> = [];
    const model = Model.define({
      id: "settlement-steering-model",
      async *invoke(request) {
        requests.push(request.messages);
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text(`candidate-${modelCalls}`)],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "settlement-steering-agent",
      fragments: Agent.combine(
        model,
        Hook.beforeSettlement(async ({ run }) => {
          if (modelCalls !== 1) {
            return undefined;
          }
          await client.steer({
            runId: run.runId,
            message: {
              role: "user",
              content: [Content.text("steer")],
            },
          });
          return {
            type: "continue",
            instruction: {
              role: "user",
              content: [Content.text("gate")],
            },
          };
        }),
      ),
    });
    const built = await fixture(agent);
    client = built.client;
    const submission = await submitStart(client, built.branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      response: {
        message: { content: [Content.text("candidate-2")] },
      },
    });
    expect(requests[1]).toEqual([
      { role: "user", content: [Content.text("start")] },
      {
        role: "assistant",
        content: [Content.text("candidate-1")],
      },
      { role: "user", content: [Content.text("steer")] },
    ]);
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      settlementContinuations: 0,
    });
  });

  it("times out one settlement gate and runs the remaining gates", async () => {
    let laterGateCalls = 0;
    let reported: unknown;
    let timedOutSignal: AbortSignal | undefined;
    const agent = Agent.define({
      id: "settlement-timeout-agent",
      fragments: Agent.combine(
        completingModel,
        Hook.beforeSettlement(({ signal }) => {
          timedOutSignal = signal;
          return new Promise<never>(() => undefined);
        }),
        Hook.beforeSettlement(() => {
          laterGateCalls += 1;
          return undefined;
        }),
      ),
    });
    const clock: Clock = {
      now: () => 0,
      sleep(milliseconds, signal) {
        if (milliseconds === 30_000) {
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
    client.subscribe(
      Hook.onExecutionEvent(({ event }) => {
        if (event.type === "error") {
          reported = event.error;
        }
        return undefined;
      }),
    );
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(laterGateCalls).toBe(1);
    expect(reported).toBeInstanceOf(UnexpectedExecutionError);
    expect(timedOutSignal?.aborted).toBe(true);
  });

  it("records detailed per-Model Usage and calls without reported Usage", async () => {
    let modelCalls = 0;
    const model = Model.define({
      id: "detailed-usage-model",
      async *invoke() {
        modelCalls += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text(`usage-${modelCalls}`)],
            },
            finishReason: "stop" as const,
            ...(modelCalls === 1
              ? {
                  usage: {
                    input: {
                      total: 10,
                      uncached: 6,
                      cacheRead: 4,
                      cacheWrite: 2,
                    },
                    output: {
                      total: 5,
                      text: 3,
                      reasoning: 2,
                    },
                    totalTokens: 17,
                  },
                }
              : {}),
          },
        };
      },
    });
    const agent = Agent.define({
      id: "detailed-usage-agent",
      fragments: Agent.combine(
        model,
        Hook.beforeSettlement(() =>
          modelCalls === 1
            ? {
                type: "continue",
                instruction: {
                  role: "user",
                  content: [Content.text("one more")],
                },
              }
            : undefined,
        ),
      ),
    });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
      usage: {
        total: {
          input: {
            total: 10,
            uncached: 6,
            cacheRead: 4,
            cacheWrite: 2,
          },
          output: {
            total: 5,
            text: 3,
            reasoning: 2,
          },
          totalTokens: 17,
        },
        models: [
          {
            modelId: "detailed-usage-model",
            calls: 2,
            reportedCalls: 1,
            usage: {
              input: {
                total: 10,
                uncached: 6,
                cacheRead: 4,
                cacheWrite: 2,
              },
              output: {
                total: 5,
                text: 3,
                reasoning: 2,
              },
              totalTokens: 17,
            },
          },
        ],
      },
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
                content: [Content.toolCall("rich-call" as ToolCallId, "rich-result", "value")],
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
        Content.toolResult("rich-call" as ToolCallId, "rich-result", { echoed: "value" }),
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
                  "dynamic-recovery-call" as ToolCallId,
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
    const store = new MemoryThreadStore();
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
                        "dynamic-suspension-call" as ToolCallId,
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
      client.submit({
        type: "resume",
        runId: submission.runId,
        items: [
          {
            toolName: "dynamic-suspension",
            toolCallId: "dynamic-suspension-call" as ToolCallId,
            input: 1 as never,
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      status: "suspended",
      suspensions: [{ toolName: "dynamic-suspension" }],
    });
    await expect(
      client.submit({
        type: "resume",
        runId: submission.runId,
        items: [
          {
            toolName: "dynamic-suspension",
            toolCallId: "dynamic-suspension-call" as ToolCallId,
            input: "resume",
          },
        ],
      }),
    ).resolves.toMatchObject({ type: "submitted", admitted: true });
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

  it("redirects active Model work without saving its partial response", async () => {
    let firstStarted!: () => void;
    const firstModelStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const secondModelStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const requests: ModelMessage[][] = [];
    let invocations = 0;
    const model = Model.define({
      id: "redirect-model",
      async *invoke(request, context) {
        requests.push([...request.messages]);
        invocations += 1;
        if (invocations === 1) {
          yield { type: "text-delta" as const, delta: "discarded" };
          firstStarted();
          await new Promise<void>((_resolve, reject) => {
            if (context.signal.aborted) {
              reject(context.signal.reason);
              return;
            }
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true,
            });
          });
          return;
        }
        secondStarted();
        await secondGate;
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("redirected")] },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({ id: "redirect-agent", fragments: model });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);
    await firstModelStarted;
    const message = { role: "user" as const, content: [Content.text("new direction")] };
    const redirect = {
      runId: submission.runId,
      redirectRequestId: "redirect-once",
      message,
    };

    await expect(client.redirect(redirect)).resolves.toMatchObject({
      type: "accepted",
      admitted: true,
    });
    await secondModelStarted;
    await expect(client.redirect(redirect)).resolves.toMatchObject({
      type: "accepted",
      admitted: false,
    });
    releaseSecond();

    await expect(execution.result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("redirected")] } },
    });
    expect(invocations).toBe(2);
    expect(requests[1]).toContainEqual(message);
    expect(requests[1]).not.toContainEqual({
      role: "assistant",
      content: [Content.text("discarded")],
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

  it("applies Model Hooks once around the root Composite invocation", async () => {
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
            usage: { input: { total: 1 }, output: { total: 2 }, totalTokens: 3 },
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
            usage: { input: { total: 4 }, output: { total: 5 }, totalTokens: 9 },
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
      usage: {
        total: { input: { total: 5 }, output: { total: 7 }, totalTokens: 12 },
        models: [
          {
            modelId: "primary-child",
            calls: 1,
            reportedCalls: 1,
            usage: { input: { total: 1 }, output: { total: 2 }, totalTokens: 3 },
          },
          {
            modelId: "fallback-child",
            calls: 1,
            reportedCalls: 1,
            usage: { input: { total: 4 }, output: { total: 5 }, totalTokens: 9 },
          },
        ],
      },
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
              usage: { input: { total: 1 }, output: { total: 1 }, totalTokens: 2 },
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("done")] },
            finishReason: "stop" as const,
            usage: { input: { total: 2 }, output: { total: 3 }, totalTokens: 5 },
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
      usage: {
        total: { input: { total: 3 }, output: { total: 4 }, totalTokens: 7 },
        models: [
          {
            modelId: "retry-model",
            calls: 2,
            reportedCalls: 2,
            usage: { input: { total: 3 }, output: { total: 4 }, totalTokens: 7 },
          },
        ],
      },
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

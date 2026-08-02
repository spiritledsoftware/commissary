import { MemoryThreadStore } from "@commissary/store-memory";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Content,
  Hook,
  HookPoints,
  Model,
  RunId,
  Tool,
  UnexpectedExecutionError,
  commissary,
  type AgentClient,
  type Clock,
  type ModelMessage,
  ToolCallId,
} from "@commissary/core";
import { stringSchema } from "../support.js";
import { completingModel, fixture, submitStart } from "./support.js";

describe("Runtime Hooks", () => {
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
    const unsubscribeFirst = client.on(HookPoints.beforeModelRequest, () => {
      order.push("dynamic-1");
      return undefined;
    });
    const unsubscribeSecond = client.on(HookPoints.beforeModelRequest, () => {
      order.push("dynamic-2");
      return undefined;
    });
    const first = await submitStart(client, branch, "first");
    const execution = await client.execute(first.runId);
    unsubscribeFirst();
    unsubscribeFirst();
    client.on(HookPoints.beforeModelRequest, () => {
      order.push("late");
      return undefined;
    });

    await execution.result;
    expect(order).toEqual(["static", "dynamic-1", "dynamic-2"]);

    unsubscribeSecond();
    order.length = 0;
    const snapshot = await client.readRunSnapshot(first.runId);
    if (snapshot === undefined) {
      throw new Error("Expected the first Run snapshot");
    }
    const second = await client.createRun({
      threadId: branch.threadId,
      branchId: branch.id,
      expectedHead: snapshot.head,
      message: { role: "user", content: [Content.text("second")] },
    });
    if (second.type !== "accepted") {
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
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "model-event") {
        throw new Error("observer failed");
      }
      return undefined;
    });
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      received.push(event);
      return undefined;
    });

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
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "error") {
        throwingObserverErrors += 1;
        throw new Error("error observer failed");
      }
      return undefined;
    });
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "error") {
        receivingObserverErrors += 1;
      }
      return undefined;
    });
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
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "model-event") {
        observed.push(event.event);
      }
      return undefined;
    });
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
                        ToolCallId.decode("replace-tool-result-call"),
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
      run: { settlementContinuations: 32 },
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
            runId: RunId.decode(run.runId),
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
      run: { settlementContinuations: 0 },
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
            runId: RunId.decode(run.runId),
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
      run: { settlementContinuations: 0 },
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
    const store = MemoryThreadStore.make();
    const app = commissary({ threadStore: store, clock });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(agent);
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "error") {
        reported = event.error;
      }
      return undefined;
    });
    const submission = await submitStart(client, branch);

    await expect((await client.execute(submission.runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    expect(laterGateCalls).toBe(1);
    expect(reported).toBeInstanceOf(UnexpectedExecutionError);
    expect(timedOutSignal?.aborted).toBe(true);
  });
});

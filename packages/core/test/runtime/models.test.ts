import { MemoryThreadStore } from "@commissary/store-memory";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Content,
  Hook,
  HookPoints,
  Model,
  commissary,
  type Clock,
  type ModelMessage,
} from "@commissary/core";
import { fixture, submitStart } from "./support.js";

describe("Runtime Models", () => {
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
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      events.push(event);
      return undefined;
    });
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
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "model-event" && event.event.type === "text-delta") {
        deltas.push(event.event.delta);
      }
      return undefined;
    });
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
    const store = MemoryThreadStore.make();
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
});

import { MemoryThreadStore } from "@commissary/store-memory";
import {
  Agent,
  Content,
  Hook,
  Model,
  UnexpectedExecutionError,
  commissary,
} from "@commissary/core";
import { EffectCommissary } from "@commissary/effect";
import { execute as executeEffect } from "@commissary/stream/effect";
import { Effect, Stream } from "effect";
import { expect, it } from "vitest";

import { StreamAlreadyConsumedError, execute, text, type StreamEvent } from "../src/index.js";

async function clientFor(model: ReturnType<typeof Model.define>) {
  const agent = Agent.define({ id: "stream-test-agent", fragments: model });
  const app = commissary({ threadStore: new MemoryThreadStore() });
  const thread = await app.createThread();
  const branch = await app.createBranch({ threadId: thread.id, name: "main" });
  const client = app.agent(agent);
  const submission = await client.createRun({
    threadId: thread.id,
    branchId: branch.id,
    message: { role: "user", content: [Content.text("start")] },
  });
  if (submission.type !== "accepted") {
    throw new Error(`Unexpected submission result '${submission.type}'`);
  }
  return { client, runId: submission.runId };
}

async function collect<Value>(values: AsyncIterable<Value>): Promise<Value[]> {
  const result: Value[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

it("bounds Events, discards the oldest values, and combines the loss count", async () => {
  const model = Model.define({
    id: "bounded",
    async *invoke() {
      for (const delta of ["1", "2", "3", "4", "5"]) {
        yield { type: "text-delta" as const, delta };
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
  const { client, runId } = await clientFor(model);
  const streamed = await execute(client, runId, { capacity: 3 });
  await streamed.execution.result;

  const events = await collect(streamed.events);
  expect(events[0]).toEqual({ type: "events-dropped", count: 4 });
  expect(events.slice(1)).toMatchObject([
    { type: "model-event", event: { type: "text-delta", delta: "5" } },
    { type: "model-event", event: { type: "finish" } },
  ]);
});

it("keeps a large Event burst bounded in arrival order", async () => {
  const eventCount = 4_096;
  const capacity = 1_024;
  const droppedCount = eventCount + 1 - (capacity - 1);
  const model = Model.define({
    id: "large-bounded",
    async *invoke() {
      for (let index = 0; index < eventCount; index += 1) {
        yield { type: "text-delta" as const, delta: String(index) };
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
  const { client, runId } = await clientFor(model);
  const streamed = await execute(client, runId, { capacity });
  await streamed.execution.result;

  const events = await collect(streamed.events);
  expect(events).toHaveLength(capacity);
  expect(events[0]).toEqual({
    type: "events-dropped",
    count: droppedCount,
  });
  expect(events[1]).toMatchObject({
    type: "model-event",
    event: { type: "text-delta", delta: String(droppedCount) },
  });
  expect(events.at(-1)).toMatchObject({
    type: "model-event",
    event: { type: "finish" },
  });
});

it("reserves terminal capacity for the Error Event", async () => {
  const model = Model.define({
    id: "error",
    async *invoke() {
      yield { type: "text-delta" as const, delta: "discarded" };
      throw new Error("provider failed");
    },
  });
  const { client, runId } = await clientFor(model);
  const streamed = await execute(client, runId, { capacity: 1 });
  let rejected: unknown;
  try {
    await streamed.execution.result;
  } catch (cause) {
    rejected = cause;
  }

  const events = await collect(streamed.events);
  expect(events[0]).toEqual({ type: "events-dropped", count: 1 });
  expect(events[1]).toMatchObject({ type: "error" });
  if (events[1]?.type !== "error") {
    throw new Error("Expected terminal Error Event");
  }
  expect(events[1].error).toBe(rejected);
  expect(rejected).toBeInstanceOf(UnexpectedExecutionError);
});

it("keeps streaming after an isolated observer error", async () => {
  const model = Model.define({
    id: "observer-error",
    async *invoke() {
      yield { type: "text-delta" as const, delta: "before" };
      yield {
        type: "finish" as const,
        response: {
          message: { role: "assistant" as const, content: [Content.text("after")] },
          finishReason: "stop" as const,
        },
      };
    },
  });
  const agent = Agent.define({
    id: "observer-error-agent",
    fragments: Agent.combine(
      model,
      Hook.onModelEvent(() => {
        throw new Error("observer failed");
      }),
    ),
  });
  const app = commissary({ threadStore: new MemoryThreadStore() });
  const thread = await app.createThread();
  const branch = await app.createBranch({ threadId: thread.id, name: "main" });
  const client = app.agent(agent);
  const submission = await client.createRun({
    threadId: thread.id,
    branchId: branch.id,
    message: { role: "user", content: [Content.text("start")] },
  });
  if (submission.type !== "accepted") {
    throw new Error(`Unexpected submission result '${submission.type}'`);
  }

  const streamed = await execute(client, submission.runId);
  await expect(streamed.execution.result).resolves.toMatchObject({ type: "completed" });
  const events = await collect(streamed.events);
  const observerError = events.findIndex((event) => event.type === "error");
  const finish = events.findIndex(
    (event) => event.type === "model-event" && event.event.type === "finish",
  );
  expect(observerError).toBeGreaterThanOrEqual(0);
  expect(finish).toBeGreaterThan(observerError);
});

it("permits only one consumer and projects canonical text deltas", async () => {
  const model = Model.define({
    id: "text",
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
  const { client, runId } = await clientFor(model);
  const streamed = await execute(client, runId);

  await expect(collect(text(streamed.events))).resolves.toEqual(["hello"]);
  await expect(collect(streamed.events)).rejects.toBeInstanceOf(StreamAlreadyConsumedError);
});

it("provides the same bounded stream through Effect", async () => {
  const model = Model.define({
    id: "effect",
    async *invoke() {
      yield { type: "text-delta" as const, delta: "effect" };
      yield {
        type: "finish" as const,
        response: {
          message: { role: "assistant" as const, content: [Content.text("effect")] },
          finishReason: "stop" as const,
        },
      };
    },
  });
  const { client, runId } = await clientFor(model);
  const streamed = await Effect.runPromise(executeEffect(client, runId));
  const values = await Effect.runPromise(Stream.runCollect(streamed.events));
  const events = Array.from(values) as StreamEvent[];

  expect(events).toContainEqual({
    type: "model-event",
    event: { type: "text-delta", delta: "effect" },
  });
  await expect(Effect.runPromise(streamed.result)).resolves.toMatchObject({ type: "completed" });
});

it("accepts an Effect Agent Client directly", async () => {
  const model = Model.define({
    id: "effect-client-stream",
    async *invoke() {
      yield { type: "text-delta" as const, delta: "direct" };
      yield {
        type: "finish" as const,
        response: {
          message: { role: "assistant" as const, content: [Content.text("direct")] },
          finishReason: "stop" as const,
        },
      };
    },
  });
  const agent = Agent.define({ id: "effect-client-stream-agent", fragments: model });
  const app = await Effect.runPromise(
    EffectCommissary.make({ threadStore: new MemoryThreadStore() }),
  );
  const thread = await Effect.runPromise(app.createThread());
  const branch = await Effect.runPromise(app.createBranch({ threadId: thread.id, name: "main" }));
  const client = await Effect.runPromise(app.agent(agent));
  const accepted = await Effect.runPromise(
    client.createRun({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("start")] },
    }),
  );
  if (accepted.type !== "accepted") {
    throw new Error(`Unexpected submission result '${accepted.type}'`);
  }

  const streamed = await Effect.runPromise(executeEffect(client, accepted.runId));
  const events = Array.from(await Effect.runPromise(Stream.runCollect(streamed.events)));
  expect(events).toContainEqual({
    type: "model-event",
    event: { type: "text-delta", delta: "direct" },
  });
  await expect(Effect.runPromise(streamed.result)).resolves.toMatchObject({
    type: "completed",
  });
});

import { MemoryThreadStore } from "@commissary/store-memory";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Content,
  ExecutionEventStoreError,
  Hook,
  Model,
  commissary,
  type ExecutionEventRecord,
} from "@commissary/core";
import { completingModel, recordingEventStore, submitStart } from "./support.js";

describe("Runtime Events", () => {
  it("durably appends ordered Event batches before local observation", async () => {
    const order: string[] = [];
    const batches: Array<readonly ExecutionEventRecord[]> = [];
    const store = MemoryThreadStore.make();
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
    const store = MemoryThreadStore.make();
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
    const store = MemoryThreadStore.make();
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
    const store = MemoryThreadStore.make();
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
});

import { MemoryThreadStore } from "@commissary/store-memory";

import {
  Content,
  Model,
  commissary,
  RunId,
  ToolCallId,
  type AgentClient,
  type AgentDefinition,
  type ExecutionEventRecord,
  type ExecutionEventStore,
} from "@commissary/core";

export const completingModel = Model.define({
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

export async function fixture<Definition extends AgentDefinition>(agent: Definition) {
  const store = new MemoryThreadStore();
  const app = commissary({ threadStore: store });
  const thread = await app.createThread();
  const branch = await app.createBranch({ threadId: thread.id, name: "main" });
  const client = app.agent(agent);
  return { app, store, thread, branch, client };
}

export function recordingEventStore(
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

export async function submitStart<Definition extends AgentDefinition>(
  client: AgentClient<Definition>,
  branch: {
    readonly id: import("@commissary/core").BranchId;
    readonly threadId: import("@commissary/core").ThreadId;
  },
  message = "start",
) {
  const submission = await client.createRun({
    threadId: branch.threadId,
    branchId: branch.id,
    message: { role: "user", content: [Content.text(message)] },
  });
  if (submission.type !== "accepted") {
    throw new Error(`Unexpected submission result '${submission.type}'`);
  }
  return submission;
}

export function toolCallId(value: string): ToolCallId {
  return ToolCallId.decode(value);
}

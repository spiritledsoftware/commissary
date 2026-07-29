import {
  type AgentRevision,
  type BranchId,
  type CommitId,
  Content,
  type ExecutionId,
  type MessageEntryId,
  type RunId,
  type ThreadId,
  type ToolCallId,
} from "@commissary/core";
import { expect, it } from "vitest";

import { MemoryThreadStore } from "../src/index.js";

function testId<Id extends string>(value: string): Id {
  // SAFETY: Store tests use deterministic unique strings at branded ID boundaries.
  return value as Id;
}

it("uses its backend clock for claim expiry", async () => {
  let now = 100;
  const store = MemoryThreadStore.make({
    clock: { now: () => now },
  });
  const threadId = "thread" as ThreadId;
  const branchId = "branch" as BranchId;
  const runId = "run" as RunId;
  await store.createThread({ id: threadId });
  await store.createBranch({
    branch: { id: branchId, threadId, name: "main" },
  });
  const append = {
    threadId,
    branchId,
    commitId: "append" as CommitId,
    entries: [
      {
        id: "seed-entry" as MessageEntryId,
        message: {
          role: "user" as const,
          content: [Content.text("seed")],
        },
      },
    ],
  };
  await store.appendMessages(append);
  await store.appendMessages(append);
  await expect(store.readBranchHistory({ threadId, branchId })).resolves.toHaveLength(1);

  await store.submitRun({
    runId,
    entryId: "entry" as MessageEntryId,
    commitId: "commit" as CommitId,
    agent: { id: "agent", revision: "revision" as AgentRevision },
    threadId,
    branchId,
    message: { role: "user", content: [Content.text("start")] },
  });

  const first = await store.acquireExecutionClaim({
    runId,
    executionId: "execution-1" as ExecutionId,
    leaseDurationMs: 50,
  });
  expect(first).toMatchObject({
    type: "acquired",
    claim: { fence: 1, expiresAt: 150 },
  });

  now = 151;
  const second = await store.acquireExecutionClaim({
    runId,
    executionId: "execution-2" as ExecutionId,
    leaseDurationMs: 50,
  });
  expect(second).toMatchObject({
    type: "acquired",
    claim: { fence: 2, expiresAt: 201 },
  });
});

it("keeps large Tool Call graphs ordered and reuses delegation keys", async () => {
  const store = MemoryThreadStore.make();
  const threadId = testId<ThreadId>("graph-thread");
  const branchId = testId<BranchId>("graph-branch");
  const runId = testId<RunId>("graph-run");
  const parentToolCallId = testId<ToolCallId>("graph-parent");
  await store.createThread({ id: threadId });
  await store.createBranch({
    branch: { id: branchId, threadId, name: "main" },
  });
  const submission = await store.submitRun({
    runId,
    entryId: testId<MessageEntryId>("graph-entry"),
    commitId: testId<CommitId>("graph-start"),
    agent: { id: "graph-agent", revision: testId<AgentRevision>("graph-revision") },
    threadId,
    branchId,
    message: { role: "user", content: [Content.text("start")] },
  });
  if (submission.type !== "submitted") {
    throw new Error(`Unexpected Run submission '${submission.type}'`);
  }
  const acquired = await store.acquireExecutionClaim({
    runId,
    executionId: testId<ExecutionId>("graph-execution"),
    leaseDurationMs: 60_000,
  });
  if (acquired.type !== "acquired") {
    throw new Error(`Unexpected claim result '${acquired.type}'`);
  }
  await store.commitModelInvocation({
    claim: acquired.claim,
    expectedHead: submission.head,
    commitId: testId<CommitId>("graph-model"),
    entry: {
      id: testId<MessageEntryId>("graph-model-entry"),
      message: {
        role: "assistant",
        content: [Content.toolCall(parentToolCallId, "graph-parent-tool", {})],
      },
    },
    toolCalls: [
      {
        toolCallId: parentToolCallId,
        toolName: "graph-parent-tool",
        input: {},
      },
    ],
  });

  const delegatedCount = 5_000;
  for (let index = 0; index < delegatedCount; index += 1) {
    await store.recordDelegatedToolCall({
      claim: acquired.claim,
      parentToolCallId,
      toolCallId: testId<ToolCallId>(`graph-child-${index}`),
      toolName: "graph-child-tool",
      key: `key-${index}`,
      input: index,
    });
  }
  const reused = await store.recordDelegatedToolCall({
    claim: acquired.claim,
    parentToolCallId,
    toolCallId: testId<ToolCallId>("graph-unused-id"),
    toolName: "graph-child-tool",
    key: "key-0",
    input: 0,
  });
  expect(reused).toMatchObject({
    type: "committed",
    value: {
      toolCallId: "graph-child-0",
      sequence: 2,
    },
  });
  const snapshot = await store.loadExecution(acquired.claim);
  expect(snapshot?.toolCalls).toHaveLength(delegatedCount + 1);
  expect(snapshot?.toolCalls.at(-1)).toMatchObject({
    toolCallId: `graph-child-${delegatedCount - 1}`,
    sequence: delegatedCount + 1,
  });
});

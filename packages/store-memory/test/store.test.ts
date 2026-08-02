import {
  AgentRevision,
  BranchId,
  CommitId,
  Content,
  ExecutionId,
  MessageEntryId,
  RunId,
  ThreadId,
  ToolCallId,
} from "@commissary/core";
import { expect, it } from "vitest";

import { MemoryThreadStore } from "../src/index.js";

it("uses its backend clock for claim expiry", async () => {
  let now = 100;
  const store = MemoryThreadStore.make({
    clock: { now: () => now },
  });
  const threadId = ThreadId.decode("thread");
  const branchId = BranchId.decode("branch");
  const runId = RunId.decode("run");
  await store.createThread({ id: threadId });
  await store.createBranch({
    branch: { id: branchId, threadId, name: "main" },
  });
  const append = {
    threadId,
    branchId,
    commitId: CommitId.decode("append"),
    entries: [
      {
        id: MessageEntryId.decode("seed-entry"),
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
    entryId: MessageEntryId.decode("entry"),
    commitId: CommitId.decode("commit"),
    agent: { id: "agent", revision: AgentRevision.decode("revision") },
    threadId,
    branchId,
    message: { role: "user", content: [Content.text("start")] },
  });

  const agent = { id: "agent", revision: AgentRevision.decode("revision") };
  const first = await store.acquireExecutionClaim({
    runId,
    agent,
    executionId: ExecutionId.decode("execution-1"),
    leaseDurationMs: 50,
  });
  expect(first).toMatchObject({
    type: "acquired",
    claim: { fence: 1, expiresAt: 150 },
  });

  now = 151;
  const second = await store.acquireExecutionClaim({
    runId,
    agent,
    executionId: ExecutionId.decode("execution-2"),
    leaseDurationMs: 50,
  });
  expect(second).toMatchObject({
    type: "acquired",
    claim: { fence: 2, expiresAt: 201 },
  });
});

it("keeps large Tool Call graphs ordered and reuses delegation keys", async () => {
  const store = MemoryThreadStore.make();
  const threadId = ThreadId.decode("graph-thread");
  const branchId = BranchId.decode("graph-branch");
  const runId = RunId.decode("graph-run");
  const parentToolCallId = ToolCallId.decode("graph-parent");
  await store.createThread({ id: threadId });
  await store.createBranch({
    branch: { id: branchId, threadId, name: "main" },
  });
  const submission = await store.submitRun({
    runId,
    entryId: MessageEntryId.decode("graph-entry"),
    commitId: CommitId.decode("graph-start"),
    agent: { id: "graph-agent", revision: AgentRevision.decode("graph-revision") },
    threadId,
    branchId,
    message: { role: "user", content: [Content.text("start")] },
  });
  if (submission.type !== "accepted") {
    throw new Error(`Unexpected Run submission '${submission.type}'`);
  }
  const acquired = await store.acquireExecutionClaim({
    runId,
    agent: { id: "graph-agent", revision: AgentRevision.decode("graph-revision") },
    executionId: ExecutionId.decode("graph-execution"),
    leaseDurationMs: 600_000,
  });
  if (acquired.type !== "acquired") {
    throw new Error(`Unexpected claim result '${acquired.type}'`);
  }
  await store.commitModelInvocation({
    claim: acquired.claim,
    expectedHead: submission.head,
    commitId: CommitId.decode("graph-model"),
    entry: {
      id: MessageEntryId.decode("graph-model-entry"),
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

  const delegatedCount = 500;
  for (let index = 0; index < delegatedCount; index += 1) {
    await store.recordDelegatedToolCall({
      claim: acquired.claim,
      parentToolCallId,
      toolCallId: ToolCallId.decode(`graph-child-${index}`),
      toolName: "graph-child-tool",
      key: `key-${index}`,
      input: index,
    });
  }
  const reused = await store.recordDelegatedToolCall({
    claim: acquired.claim,
    parentToolCallId,
    toolCallId: ToolCallId.decode("graph-unused-id"),
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
  await store.collections.toolCall.update({
    where: (fields, operators) =>
      operators.eq(fields.toolCallId, ToolCallId.decode("graph-child-0")),
    set: { requestedInput: 999 },
  });
  await expect(
    store.recordDelegatedToolCall({
      claim: acquired.claim,
      parentToolCallId,
      toolCallId: ToolCallId.decode("graph-second-unused-id"),
      toolName: "graph-child-tool",
      key: "key-0",
      input: 0,
    }),
  ).rejects.toThrow("Delegation key 'key-0' was reused with different data");
  const snapshot = await store.loadExecution(acquired.claim);
  expect(snapshot?.toolCalls).toHaveLength(delegatedCount + 1);
  expect(snapshot?.toolCalls.at(-1)).toMatchObject({
    toolCallId: `graph-child-${delegatedCount - 1}`,
    sequence: delegatedCount + 1,
  });
});

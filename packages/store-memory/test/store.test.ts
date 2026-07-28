import {
  type AgentRevision,
  type BranchId,
  type CommitId,
  Content,
  type ExecutionId,
  type MessageEntryId,
  type RunId,
  type ThreadId,
} from "@commissary/core";
import { expect, it } from "vitest";

import { MemoryThreadStore } from "../src/index.js";

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

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
import { type FieldSchema, type JsonValue } from "@commissary/store";
import { expect, expectTypeOf, it } from "vitest";

import { MemoryThreadStore } from "../src/index.js";

type SchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

function fieldSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SchemaResult<Output>,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-thread-store-integration-test",
      validate,
    },
  };
}

const stringField = fieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

const runStatusField = fieldSchema<"active" | "aborted", "active" | "aborted">((value) =>
  value === "active" || value === "aborted"
    ? { value }
    : { issues: [{ message: "Expected an active or aborted Run" }] },
);

const toolStatusField = fieldSchema<"pending" | "aborted", "pending" | "aborted">((value) =>
  value === "pending" || value === "aborted"
    ? { value }
    : { issues: [{ message: "Expected a pending or aborted Tool Call" }] },
);

it("uses raw Collection state in specialized Thread Store operations", async () => {
  const store = MemoryThreadStore.make();
  const threadId = ThreadId.decode("raw-thread");
  const branchId = BranchId.decode("raw-branch");
  const runId = RunId.decode("raw-run");

  await store.collections.thread.create({ id: threadId });
  await store.collections.branch.create({
    id: branchId,
    threadId,
    name: "main",
  });

  await expect(
    store.submitRun({
      runId,
      entryId: MessageEntryId.decode("raw-entry"),
      commitId: CommitId.decode("raw-commit"),
      agent: { id: "raw-agent", revision: AgentRevision.decode("raw-revision") },
      threadId,
      branchId,
      message: { role: "user", content: [Content.text("start")] },
    }),
  ).resolves.toMatchObject({ type: "accepted", runId });

  await expect(store.collections.run.find()).resolves.toEqual([
    expect.objectContaining({ id: runId, threadId, branchId, status: "active" }),
  ]);
});

it("preserves effective Records at the Run Snapshot boundary", async () => {
  const store = MemoryThreadStore.make({
    records: {
      branch: {
        fields: {
          tenantId: stringField,
        },
      },
      run: {
        fields: {
          tenantId: stringField,
          head: stringField,
          status: runStatusField,
        },
      },
      toolCall: {
        fields: {
          traceId: stringField,
          dynamic: stringField,
          status: toolStatusField,
        },
      },
      executionClaim: {
        fields: {
          traceId: stringField,
        },
      },
    },
    hooks: {
      toolCall: {
        beforeCreate: ({ draft }) => ({
          ...draft,
          traceId: "tool-trace",
          dynamic: "host-dynamic",
        }),
      },
      executionClaim: {
        beforeCreate: ({ draft }) => ({
          ...draft,
          traceId: "claim-trace",
        }),
      },
    },
  });
  const threadId = ThreadId.decode("custom-thread");
  const branchId = BranchId.decode("custom-branch");
  const runId = RunId.decode("custom-run");
  const toolCallId = ToolCallId.decode("custom-tool-call");
  const agent = {
    id: "custom-agent",
    revision: AgentRevision.decode("custom-revision"),
  };

  await store.createThread({ id: threadId });
  await store.createBranch({
    branch: { id: branchId, threadId, name: "main", tenantId: "tenant-1" },
  });
  const submission = await store.submitRun({
    runId,
    entryId: MessageEntryId.decode("custom-entry"),
    commitId: CommitId.decode("custom-submit"),
    agent,
    threadId,
    branchId,
    message: { role: "user", content: [Content.text("start")] },
    fields: {
      tenantId: "tenant-1",
      head: "host-head",
    },
  });
  if (submission.type !== "accepted") {
    throw new Error(`Unexpected Run submission '${submission.type}'`);
  }
  const acquired = await store.acquireExecutionClaim({
    runId,
    agent,
    executionId: ExecutionId.decode("custom-execution"),
    leaseDurationMs: 60_000,
  });
  if (acquired.type !== "acquired") {
    throw new Error(`Unexpected claim result '${acquired.type}'`);
  }
  const modelCommit = await store.commitModelInvocation({
    claim: acquired.claim,
    expectedHead: submission.head,
    commitId: CommitId.decode("custom-model"),
    entry: {
      id: MessageEntryId.decode("custom-model-entry"),
      message: {
        role: "assistant",
        content: [Content.toolCall(toolCallId, "custom-tool", {})],
      },
    },
    toolCalls: [
      {
        toolCallId,
        toolName: "custom-tool",
        providerId: "host-provider",
        input: {},
      },
    ],
  });
  if (modelCommit.type !== "committed") {
    throw new Error(`Unexpected Model commit '${modelCommit.type}'`);
  }
  expect(modelCommit.value.tenantId).toBe("tenant-1");
  await expect(store.collections.modelCommitOutcome.find()).resolves.toEqual([
    expect.objectContaining({
      outcome: expect.objectContaining({
        type: "committed",
        value: expect.objectContaining({ tenantId: "tenant-1" }),
      }),
    }),
  ]);
  await expect(
    store.finalizeRun({
      claim: acquired.claim,
      expectedHead: modelCommit.value.head!,
      commitId: CommitId.decode("custom-finalize"),
      entries: [],
      abortUnresolvedTools: true,
      result: {
        type: "aborted",
        runId,
        threadId,
        branchId,
        head: modelCommit.value.head!,
        agent,
      },
    }),
  ).resolves.toMatchObject({ type: "committed" });

  const snapshot = await store.readRunSnapshot({ agent, runId });
  expect(snapshot).toBeDefined();
  if (snapshot === undefined) {
    throw new Error("Expected a Run Snapshot");
  }
  expect(snapshot.head).toBe(modelCommit.value.head);
  expect(snapshot.run).toMatchObject({
    id: runId,
    tenantId: "tenant-1",
    head: "host-head",
    status: "aborted",
  });
  expect(snapshot.toolCalls).toEqual([
    expect.objectContaining({
      toolCallId,
      traceId: "tool-trace",
      dynamic: "host-dynamic",
      status: "aborted",
    }),
  ]);
  expect(snapshot).not.toHaveProperty("runId");
  expect(snapshot).not.toHaveProperty("threadId");
  expect(snapshot).not.toHaveProperty("status");
  expectTypeOf(snapshot.run.tenantId).toEqualTypeOf<string>();
  expectTypeOf(snapshot.run.status).toEqualTypeOf<"active" | "aborted">();
  expectTypeOf(snapshot.toolCalls[0]?.traceId).toEqualTypeOf<string | undefined>();
  expectTypeOf(snapshot.toolCalls[0]?.status).toEqualTypeOf<"pending" | "aborted" | undefined>();

  await expect(store.collections.executionClaim.find()).resolves.toEqual([]);
});

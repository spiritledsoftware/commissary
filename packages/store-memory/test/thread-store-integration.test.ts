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
  createThreadStore,
  composeThreadStoreRecordDefinitions,
} from "@commissary/core";
import type {
  RecordDefinitions,
  Store,
  StoreOperatorTypes,
  TransactionStore,
} from "@commissary/store";
import { type FieldSchema, type JsonValue } from "@commissary/store";
import { expect, expectTypeOf, it } from "vitest";

import { MemoryStore, MemoryThreadStore } from "../src/index.js";

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

const runStatusField = fieldSchema<
  "active" | "suspended" | "completed" | "failed" | "aborted",
  "active" | "aborted"
>((value) =>
  value === "active" || value === "aborted"
    ? { value }
    : { issues: [{ message: "Expected an active or aborted Run" }] },
);

const toolStatusField = fieldSchema<
  "pending" | "running" | "suspended" | "succeeded" | "failed" | "aborted",
  "pending" | "aborted"
>((value) =>
  value === "pending" || value === "aborted"
    ? { value }
    : { issues: [{ message: "Expected a pending or aborted Tool Call" }] },
);

const recordedCollectionOperationNames = ["find", "create", "update", "delete", "count"] as const;

type StoreCollectionOperation = (typeof recordedCollectionOperationNames)[number];

interface StoreCollectionAccess {
  readonly collection: string;
  readonly operation: StoreCollectionOperation;
}

const recordedCollectionOperations: ReadonlySet<string> = new Set(recordedCollectionOperationNames);

function recordStoreCollectionAccess<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes,
>(
  store: Store<Definitions, Operators>,
  accesses: StoreCollectionAccess[],
): Store<Definitions, Operators> {
  const cache = new Map<PropertyKey, object>();
  const collections = new Proxy(
    { ...store.collections },
    {
      get(target, property, receiver) {
        const collection: unknown = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof collection !== "object" || collection === null) {
          return collection;
        }
        const cached = cache.get(property);
        if (cached !== undefined) {
          return cached;
        }
        const recorded = new Proxy(
          {},
          {
            get(_target, operation) {
              const method: unknown = Reflect.get(collection, operation, collection);
              if (
                typeof operation !== "string" ||
                !recordedCollectionOperations.has(operation) ||
                typeof method !== "function"
              ) {
                return method;
              }
              return (...args: readonly unknown[]): unknown => {
                accesses.push({
                  collection: property,
                  // SAFETY: StoreCollectionOperation is derived from recordedCollectionOperationNames.
                  operation: operation as StoreCollectionOperation,
                });
                return Reflect.apply(method, collection, args);
              };
            },
          },
        );
        cache.set(property, recorded);
        return recorded;
      },
    },
  );
  return { collections };
}

function recordTransactionStoreAccess<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes,
>(
  backend: TransactionStore<Definitions, Operators>,
  accesses: StoreCollectionAccess[],
): TransactionStore<Definitions, Operators> {
  const recorded = recordStoreCollectionAccess(backend, accesses);
  return {
    collections: recorded.collections,
    transaction: (use) =>
      backend.transaction((transaction) => use(recordStoreCollectionAccess(transaction, accesses))),
  };
}

function expectAccessedCollections(
  accesses: readonly StoreCollectionAccess[],
  expected: readonly string[],
): void {
  expect([...new Set(accesses.map((access) => access.collection))].sort()).toEqual(
    [...expected].sort(),
  );
}

function expectCollectionMutations(
  accesses: readonly StoreCollectionAccess[],
  expected: readonly StoreCollectionAccess[],
): void {
  expect(
    accesses.filter(
      (access) =>
        access.operation === "create" ||
        access.operation === "update" ||
        access.operation === "delete",
    ),
  ).toEqual(expected);
}

it("scopes Core operations to relevant Collections and changed Records", async () => {
  const definitions = composeThreadStoreRecordDefinitions({
    records: {},
    overrides: {
      branch: {
        fields: {
          tenantId: stringField,
        },
      },
    },
  });
  const backend = MemoryStore.make({ records: definitions });
  const accesses: StoreCollectionAccess[] = [];
  const store = createThreadStore({
    backend: recordTransactionStoreAccess(backend, accesses),
  });
  const threadId = ThreadId.decode("scoped-thread");
  const branchId = BranchId.decode("scoped-branch");
  const untouchedBranchId = BranchId.decode("scoped-untouched-branch");
  const runId = RunId.decode("scoped-run");
  const toolCallId = ToolCallId.decode("scoped-tool-call");
  const agent = {
    id: "scoped-agent",
    revision: AgentRevision.decode("scoped-revision"),
  };

  await store.createThread({ id: threadId });
  expectAccessedCollections(accesses, ["thread"]);

  accesses.length = 0;
  await store.createBranch({
    branch: { id: branchId, threadId, name: "main", tenantId: "tenant-1" },
  });
  await store.createBranch({
    branch: {
      id: untouchedBranchId,
      threadId,
      name: "untouched",
      tenantId: "tenant-2",
    },
  });
  expectAccessedCollections(accesses, ["branch", "message", "thread"]);

  accesses.length = 0;
  await store.renameBranch({ threadId, branchId, name: "renamed" });
  expect(accesses).toEqual([
    { collection: "branch", operation: "find" },
    { collection: "branch", operation: "update" },
  ]);
  await expect(backend.collections.branch.find()).resolves.toEqual([
    expect.objectContaining({
      id: branchId,
      name: "renamed",
      tenantId: "tenant-1",
    }),
    expect.objectContaining({
      id: untouchedBranchId,
      name: "untouched",
      tenantId: "tenant-2",
    }),
  ]);

  accesses.length = 0;
  const submission = await store.submitRun({
    runId,
    entryId: MessageEntryId.decode("scoped-entry"),
    commitId: CommitId.decode("scoped-submit"),
    agent,
    threadId,
    branchId,
    message: { role: "user", content: [Content.text("start")] },
  });
  if (submission.type !== "accepted") {
    throw new Error(`Unexpected Run submission '${submission.type}'`);
  }
  expectAccessedCollections(accesses, ["branch", "commit", "message", "run", "runSubmission"]);

  accesses.length = 0;
  const acquired = await store.acquireExecutionClaim({
    runId,
    agent,
    executionId: ExecutionId.decode("scoped-execution"),
    leaseDurationMs: 60_000,
  });
  if (acquired.type !== "acquired") {
    throw new Error(`Unexpected claim result '${acquired.type}'`);
  }
  expectAccessedCollections(accesses, ["executionClaim", "executionFence", "run", "toolCall"]);

  accesses.length = 0;
  await expect(store.loadToolCall(acquired.claim, toolCallId)).resolves.toBeUndefined();
  expect(accesses).toEqual([
    { collection: "executionClaim", operation: "find" },
    { collection: "run", operation: "find" },
    { collection: "toolCall", operation: "find" },
  ]);

  accesses.length = 0;
  await expect(store.releaseExecutionClaim(acquired.claim)).resolves.toBe(true);
  expect(accesses).toEqual([
    { collection: "executionClaim", operation: "find" },
    { collection: "executionClaim", operation: "delete" },
  ]);

  accesses.length = 0;
  const reacquired = await store.acquireExecutionClaim({
    runId,
    agent,
    executionId: ExecutionId.decode("scoped-execution-2"),
    leaseDurationMs: 60_000,
  });
  if (reacquired.type !== "acquired") {
    throw new Error(`Unexpected reacquisition result '${reacquired.type}'`);
  }
  const claim = reacquired.claim;

  accesses.length = 0;
  const modelCommit = await store.commitModelInvocation({
    claim,
    expectedHead: submission.head,
    commitId: CommitId.decode("scoped-model"),
    entry: {
      id: MessageEntryId.decode("scoped-model-entry"),
      message: {
        role: "assistant",
        content: [Content.toolCall(toolCallId, "scoped-tool", {})],
      },
    },
    toolCalls: [
      {
        toolCallId,
        toolName: "scoped-tool",
        input: {},
      },
    ],
  });
  if (modelCommit.type !== "committed") {
    throw new Error(`Unexpected Model commit '${modelCommit.type}'`);
  }
  const modelHead = modelCommit.value.head;
  if (modelHead === undefined) {
    throw new Error("Expected the Model commit to advance the Branch head");
  }
  expectAccessedCollections(accesses, [
    "branch",
    "commit",
    "executionClaim",
    "message",
    "modelCommitOutcome",
    "pendingRedirect",
    "run",
    "toolCall",
    "toolCallSequence",
  ]);
  expectCollectionMutations(accesses, [
    { collection: "commit", operation: "create" },
    { collection: "modelCommitOutcome", operation: "create" },
    { collection: "branch", operation: "update" },
    { collection: "message", operation: "create" },
    { collection: "toolCall", operation: "create" },
    { collection: "toolCallSequence", operation: "create" },
  ]);

  accesses.length = 0;
  await expect(
    store.suspendRun({
      claim,
      expectedHead: modelHead,
      result: {
        type: "suspended",
        runId,
        threadId,
        branchId,
        head: modelHead,
        agent,
        suspensions: [],
      },
    }),
  ).resolves.toMatchObject({ type: "committed" });
  expectAccessedCollections(accesses, ["branch", "executionClaim", "run", "toolCall"]);
  expectCollectionMutations(accesses, [{ collection: "run", operation: "update" }]);

  accesses.length = 0;
  await store.recordToolInput({
    claim,
    toolCallId,
    input: { prompt: "recorded" },
  });
  expectAccessedCollections(accesses, ["executionClaim", "run", "toolCall"]);

  accesses.length = 0;
  await store.acceptSteering({
    agent,
    runId,
    message: { role: "user", content: [Content.text("continue")] },
  });
  expectAccessedCollections(accesses, [
    "pendingSteering",
    "run",
    "runCommandSequence",
    "steeringRequest",
  ]);

  accesses.length = 0;
  await store.finalizeRun({
    claim,
    expectedHead: modelHead,
    commitId: CommitId.decode("scoped-finalize"),
    entries: [],
    abortUnresolvedTools: true,
    result: {
      type: "aborted",
      runId,
      threadId,
      branchId,
      head: modelHead,
      agent,
    },
  });
  expectAccessedCollections(accesses, [
    "branch",
    "commit",
    "executionClaim",
    "finalizationOutcome",
    "message",
    "pendingRedirect",
    "pendingSteering",
    "run",
    "toolCall",
  ]);
  expectCollectionMutations(accesses, [
    { collection: "commit", operation: "create" },
    { collection: "finalizationOutcome", operation: "create" },
    { collection: "executionClaim", operation: "delete" },
    { collection: "run", operation: "update" },
    { collection: "toolCall", operation: "update" },
  ]);
});

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
    records: {},
    overrides: {
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

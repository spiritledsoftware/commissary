import {
  TransactionConflictError,
  TransactionRollbackError,
  type BaseStoreOperatorTypes,
  type FieldSchema,
  type JsonValue,
  type TransactionStore,
} from "@commissary/store";
import {
  AgentRevision,
  BranchId,
  CommitId,
  Content,
  ExecutionId,
  MessageEntryId,
  RunId,
  ThreadId,
  coreRecordDefinitions,
  createThreadStore,
  type CoreRecordDefinitions,
} from "@commissary/core";
import { expect, it, vi } from "vitest";

import { MemoryStore } from "../src/index.js";

type SchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

function fieldSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SchemaResult<Output>,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-transaction-test",
      validate,
    },
  };
}

const stringField = fieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

const numberField = fieldSchema<number, number>((value) =>
  typeof value === "number" && Number.isFinite(value)
    ? { value }
    : { issues: [{ message: "Expected a finite number" }] },
);

const records = {
  accounts: {
    fields: {
      id: stringField,
      balance: numberField,
    },
  },
  audit: {
    fields: {
      id: stringField,
      message: stringField,
    },
  },
} as const;

it("serializes overlapping transactions without a lost update", async () => {
  const store = MemoryStore.make({ records });
  await store.collections.accounts.create({ id: "one", balance: 0 });
  let releaseFirst = (): void => undefined;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstEntered = (): void => undefined;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  let secondEntered = false;

  const first = store.transaction(async (transaction) => {
    markFirstEntered();
    await holdFirst;
    await transaction.collections.accounts.update({
      set: (fields, operators) => ({
        balance: operators.add(fields.balance, 1),
      }),
    });
  });
  await firstEntered;
  const second = store.transaction(async (transaction) => {
    secondEntered = true;
    await transaction.collections.accounts.update({
      set: (fields, operators) => ({
        balance: operators.add(fields.balance, 1),
      }),
    });
  });
  await Promise.resolve();
  expect(secondEntered).toBe(false);

  releaseFirst();
  await Promise.all([first, second]);
  await expect(store.collections.accounts.find()).resolves.toEqual([{ id: "one", balance: 2 }]);
});

it("serializes concurrent mutations inside one transaction view", async () => {
  let delaySelect = false;
  let releaseSelect = (): void => undefined;
  const holdSelect = new Promise<void>((resolve) => {
    releaseSelect = resolve;
  });
  let markSelectStarted = (): void => undefined;
  const selectStarted = new Promise<void>((resolve) => {
    markSelectStarted = resolve;
  });
  const delayedStringField: FieldSchema<string, string> = {
    "~standard": {
      version: 1,
      vendor: "commissary-transaction-serialization-test",
      async validate(value) {
        if (delaySelect && value === "one") {
          markSelectStarted();
          await holdSelect;
        }
        return typeof value === "string"
          ? { value }
          : { issues: [{ message: "Expected a string" }] };
      },
    },
  };
  const store = MemoryStore.make({
    records: {
      accounts: {
        fields: {
          id: delayedStringField,
          balance: numberField,
        },
      },
    },
  });
  await store.collections.accounts.create({ id: "one", balance: 0 });
  await store.collections.accounts.create({ id: "two", balance: 0 });
  delaySelect = true;

  await store.transaction(async (transaction) => {
    const update = transaction.collections.accounts.update({
      where: (fields, operators) => operators.eq(fields.id, "one"),
      set: { balance: 1 },
    });
    await selectStarted;
    let deleteBuilderCalls = 0;
    const deletion = transaction.collections.accounts.delete({
      where: (fields, operators) => {
        deleteBuilderCalls += 1;
        return operators.eq(fields.id, "two");
      },
    });
    await Promise.resolve();
    expect(deleteBuilderCalls).toBe(0);

    releaseSelect();
    await Promise.all([update, deletion]);
    expect(deleteBuilderCalls).toBe(1);
  });

  await expect(store.collections.accounts.find()).resolves.toEqual([{ id: "one", balance: 1 }]);
});

it("rolls back every Collection and preserves callback failure identity", async () => {
  const store = MemoryStore.make({ records });
  await store.collections.accounts.create({ id: "one", balance: 4 });
  const callbackFailure = { type: "callback-failure" };
  let callbackCount = 0;

  const result = store.transaction(async (transaction) => {
    callbackCount += 1;
    expect(transaction).not.toHaveProperty("transaction");
    const staticTransactionView = () => {
      // @ts-expect-error transaction callbacks cannot start nested transactions
      void transaction.transaction;
    };
    expect(staticTransactionView).toBeTypeOf("function");
    const invalidTransactionCalls = () => {
      const signal = new AbortController().signal;
      // @ts-expect-error transaction accepts no cancellation options
      void store.transaction(async () => undefined, { signal });
    };
    expect(invalidTransactionCalls).toBeTypeOf("function");
    await transaction.collections.accounts.update({ set: { balance: 0 } });
    await transaction.collections.audit.create({ id: "one", message: "changed" });
    throw callbackFailure;
  });

  expect(result).toBeInstanceOf(Promise);
  expect(result.catch).toBeTypeOf("function");
  expect(result.finally).toBeTypeOf("function");
  await expect(result).rejects.toBe(callbackFailure);
  expect(callbackCount).toBe(1);
  await expect(store.collections.accounts.find()).resolves.toEqual([{ id: "one", balance: 4 }]);
  await expect(store.collections.audit.find()).resolves.toEqual([]);
});

it("isolates base CRUD from an active transaction", async () => {
  const store = MemoryStore.make({ records });
  const transactionFailure = { type: "transaction-failure" };
  let releaseTransaction = (): void => undefined;
  const holdTransaction = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let markTransactionEntered = (): void => undefined;
  const transactionEntered = new Promise<void>((resolve) => {
    markTransactionEntered = resolve;
  });

  const transaction = store.transaction(async (view) => {
    await view.collections.audit.create({ id: "inside", message: "roll back" });
    markTransactionEntered();
    await holdTransaction;
    throw transactionFailure;
  });
  await transactionEntered;

  let outsideCreateFinished = false;
  const outsideCreate = store.collections.audit
    .create({ id: "outside", message: "keep" })
    .then(() => {
      outsideCreateFinished = true;
    });
  await Promise.resolve();
  expect(outsideCreateFinished).toBe(false);

  releaseTransaction();
  await expect(transaction).rejects.toBe(transactionFailure);
  await outsideCreate;
  await expect(store.collections.audit.find()).resolves.toEqual([
    { id: "outside", message: "keep" },
  ]);
});

it("keeps a safely bound capability on the transaction view", async () => {
  const memory = MemoryStore.make({ records });
  type InvalidTransactionCapability = TransactionStore<
    typeof records,
    BaseStoreOperatorTypes,
    // @ts-expect-error transaction capabilities cannot expose a nested transaction
    { readonly transaction: () => Promise<void> }
  >;
  const invalidCapability = (): InvalidTransactionCapability | undefined => undefined;
  expect(invalidCapability).toBeTypeOf("function");
  const marker = Symbol("transaction-marker");
  const store: TransactionStore<
    typeof records,
    BaseStoreOperatorTypes,
    { readonly marker: typeof marker }
  > = {
    collections: memory.collections,
    transaction: async (use) =>
      memory.transaction((transaction) =>
        use({
          collections: transaction.collections,
          marker,
        }),
      ),
  };

  await store.transaction(async (transaction) => {
    expect(transaction.marker).toBe(marker);
    expect(transaction).not.toHaveProperty("transaction");
  });
});

it("reports both failures when Memory rollback fails", async () => {
  const store = MemoryStore.make({ records });
  const callbackFailure = { type: "callback-failure" };
  const rollbackFailure = { type: "rollback-failure" };
  const originalSplice = Array.prototype.splice;
  const splice = vi.spyOn(Array.prototype, "splice").mockImplementation(function (
    this: unknown[],
    start: number,
    deleteCount?: number,
    ...items: unknown[]
  ) {
    if (
      deleteCount === 1 &&
      items.length === 0 &&
      this.some(
        (item) =>
          typeof item === "object" && item !== null && Reflect.get(item, "id") === "rollback-write",
      )
    ) {
      throw rollbackFailure;
    }
    return Reflect.apply(originalSplice, this, [start, deleteCount, ...items]) as unknown[];
  });

  try {
    const operation = store.transaction(async (transaction) => {
      await transaction.collections.audit.create({
        id: "rollback-write",
        message: "can remain",
      });
      throw callbackFailure;
    });
    await expect(operation).rejects.toMatchObject({
      callbackFailure,
      rollbackFailure,
      writesMayRemain: true,
    });
  } finally {
    splice.mockRestore();
  }
  await expect(store.collections.audit.find()).resolves.toEqual([
    { id: "rollback-write", message: "can remain" },
  ]);
});

it("prevents a write-skew result across overlapping transactions", async () => {
  const store = MemoryStore.make({ records });
  await store.collections.accounts.create({ id: "one", balance: 1 });
  await store.collections.accounts.create({ id: "two", balance: 1 });
  let releaseFirst = (): void => undefined;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstEntered = (): void => undefined;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });

  const first = store.transaction(async (transaction) => {
    markFirstEntered();
    await holdFirst;
    const accounts = await transaction.collections.accounts.find();
    if (accounts.find((account) => account.id === "two")?.balance === 1) {
      await transaction.collections.accounts.update({
        where: (fields, operators) => operators.eq(fields.id, "one"),
        set: { balance: 0 },
      });
    }
  });
  await firstEntered;
  const second = store.transaction(async (transaction) => {
    const accounts = await transaction.collections.accounts.find();
    if (accounts.find((account) => account.id === "one")?.balance === 1) {
      await transaction.collections.accounts.update({
        where: (fields, operators) => operators.eq(fields.id, "two"),
        set: { balance: 0 },
      });
    }
  });
  releaseFirst();
  await Promise.all([first, second]);

  const accounts = await store.collections.accounts.find();
  expect(accounts.reduce((total, account) => total + account.balance, 0)).toBe(1);
});

function conflictBackend(conflictCount: number): {
  readonly backend: TransactionStore<CoreRecordDefinitions>;
  readonly attempts: () => number;
} {
  const memory = MemoryStore.make({ records: coreRecordDefinitions });
  let attempts = 0;
  const backend: TransactionStore<CoreRecordDefinitions> = {
    collections: memory.collections,
    transaction: async (use) =>
      memory.transaction(async (transaction) => {
        attempts += 1;
        const value = await use(transaction);
        if (attempts <= conflictCount) {
          throw new TransactionConflictError();
        }
        return value;
      }),
  };
  return { backend, attempts: () => attempts };
}

it("retries Core storage work and before-create hooks at most three times", async () => {
  const succeeds = conflictBackend(2);
  let successfulHookCalls = 0;
  const successfulStore = createThreadStore({
    backend: succeeds.backend,
    hooks: {
      thread: {
        beforeCreate: ({ draft }) => {
          successfulHookCalls += 1;
          return draft;
        },
      },
    },
  });
  const successfulResult = successfulStore.createThread({
    id: ThreadId.decode("retry-success"),
  });
  expect(successfulResult).toBeInstanceOf(Promise);
  await expect(successfulResult).resolves.toMatchObject({ id: "retry-success" });
  expect(succeeds.attempts()).toBe(3);
  expect(successfulHookCalls).toBe(3);
  await expect(successfulStore.collections.thread.find()).resolves.toHaveLength(1);

  const fails = conflictBackend(3);
  let failedHookCalls = 0;
  const failedStore = createThreadStore({
    backend: fails.backend,
    hooks: {
      thread: {
        beforeCreate: ({ draft }) => {
          failedHookCalls += 1;
          return draft;
        },
      },
    },
  });
  await expect(
    failedStore.createThread({ id: ThreadId.decode("retry-failure") }),
  ).rejects.toBeInstanceOf(TransactionConflictError);
  expect(fails.attempts()).toBe(3);
  expect(failedHookCalls).toBe(3);
  await expect(failedStore.collections.thread.find()).resolves.toEqual([]);
});

it("registers a control waiter only after transaction retries commit", async () => {
  const memory = MemoryStore.make({ records: coreRecordDefinitions });
  const setupStore = createThreadStore({ backend: memory });
  const threadId = ThreadId.decode("waiter-thread");
  const branchId = BranchId.decode("waiter-branch");
  const runId = RunId.decode("waiter-run");
  const agent = { id: "waiter-agent", revision: AgentRevision.decode("waiter-revision") };
  await setupStore.createThread({ id: threadId });
  await setupStore.createBranch({
    branch: { id: branchId, threadId, name: "main" },
  });
  const submission = await setupStore.submitRun({
    runId,
    entryId: MessageEntryId.decode("waiter-entry"),
    commitId: CommitId.decode("waiter-submit"),
    agent,
    threadId,
    branchId,
    message: { role: "user", content: [Content.text("wait")] },
  });
  if (submission.type !== "accepted") {
    throw new Error(`Unexpected Run submission '${submission.type}'`);
  }
  const acquired = await setupStore.acquireExecutionClaim({
    agent,
    runId,
    executionId: ExecutionId.decode("waiter-execution"),
    leaseDurationMs: 60_000,
  });
  if (acquired.type !== "acquired") {
    throw new Error(`Unexpected claim result '${acquired.type}'`);
  }

  let attempts = 0;
  let markWaitReadCommitted = (): void => undefined;
  const waitReadCommitted = new Promise<void>((resolve) => {
    markWaitReadCommitted = resolve;
  });
  const conflictingBackend: TransactionStore<CoreRecordDefinitions> = {
    collections: memory.collections,
    transaction: (use) =>
      memory.transaction(async (transaction) => {
        attempts += 1;
        const value = await use(transaction);
        if (attempts <= 2) {
          throw new TransactionConflictError();
        }
        markWaitReadCommitted();
        return value;
      }),
  };
  const store = createThreadStore({ backend: conflictingBackend });
  const controller = new AbortController();
  const addEventListener = vi.spyOn(controller.signal, "addEventListener");
  if (store.waitForExecutionControl === undefined) {
    throw new Error("Expected Memory Thread Store control waiting");
  }
  const waiting = store.waitForExecutionControl({
    claim: acquired.claim,
    signal: controller.signal,
  });
  await waitReadCommitted;
  for (let turn = 0; turn < 20 && addEventListener.mock.calls.length === 0; turn += 1) {
    await Promise.resolve();
  }

  expect(attempts).toBe(3);
  expect(addEventListener).toHaveBeenCalledTimes(1);
  await expect(store.requestAbort({ agent, runId, reason: "stop" })).resolves.toMatchObject({
    type: "accepted",
  });
  await expect(waiting).resolves.toEqual({ type: "abort-requested", reason: "stop" });
});

it("does not retry a rollback failure", async () => {
  const memory = MemoryStore.make({ records: coreRecordDefinitions });
  const callbackFailure = { type: "callback-failure" };
  const rollbackFailure = { type: "rollback-failure" };
  let attempts = 0;
  const backend: TransactionStore<CoreRecordDefinitions> = {
    collections: memory.collections,
    transaction: async (use) =>
      memory.transaction(async (transaction) => {
        attempts += 1;
        await use(transaction);
        throw new TransactionRollbackError({
          callbackFailure,
          rollbackFailure,
        });
      }),
  };
  const store = createThreadStore({ backend });

  await expect(
    store.createThread({ id: ThreadId.decode("rollback-failure") }),
  ).rejects.toMatchObject({
    callbackFailure,
    rollbackFailure,
    writesMayRemain: true,
  });
  expect(attempts).toBe(1);
  await expect(store.collections.thread.find()).resolves.toEqual([]);
});

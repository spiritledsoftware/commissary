import {
  TransactionConflictError,
  TransactionRollbackError,
  type BaseStoreOperatorTypes,
  type FieldSchema,
  type JsonValue,
  type TransactionStore,
} from "@commissary/store";
import {
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

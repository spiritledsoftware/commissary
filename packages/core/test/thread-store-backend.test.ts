import { MemoryStore } from "@commissary/store-memory";
import { TransactionConflictError, type Store, type TransactionStore } from "@commissary/store";
import { expect, it } from "vitest";

import {
  ThreadId,
  coreRecordDefinitions,
  createThreadStore,
  type CoreRecordDefinitions,
} from "@commissary/core";

function makePlainCoreBackend(): Store<CoreRecordDefinitions> {
  const memory = MemoryStore.make({ records: coreRecordDefinitions });
  return Object.freeze({ collections: memory.collections });
}

it("serializes complete Thread Store operations over a plain Store", async () => {
  const backend = makePlainCoreBackend();
  const originalThread = backend.collections.thread;
  let findCalls = 0;
  let releaseFirstFind!: () => void;
  let reportFirstFindStarted!: () => void;
  const firstFindStarted = new Promise<void>((resolve) => {
    reportFirstFindStarted = resolve;
  });
  const holdFirstFind = new Promise<void>((resolve) => {
    releaseFirstFind = resolve;
  });
  const find: typeof originalThread.find = async (options) => {
    findCalls += 1;
    if (findCalls === 1) {
      reportFirstFindStarted();
      await holdFirstFind;
    }
    return originalThread.find(options);
  };
  const store = createThreadStore({
    backend: Object.freeze({
      collections: Object.freeze({
        ...backend.collections,
        thread: Object.freeze({ ...originalThread, find }),
      }),
    }),
  });

  const first = store.readThread(ThreadId.decode("plain-first"));
  await firstFindStarted;
  const second = store.readThread(ThreadId.decode("plain-second"));
  await Promise.resolve();

  expect(findCalls).toBe(1);
  releaseFirstFind();
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  expect(findCalls).toBe(2);
});

it("makes one attempt when a plain Store operation conflicts", async () => {
  const backend = makePlainCoreBackend();
  const originalThread = backend.collections.thread;
  const conflict = new TransactionConflictError();
  let findCalls = 0;
  const find: typeof originalThread.find = (options) => {
    findCalls += 1;
    if (findCalls === 1) {
      return Promise.reject(conflict);
    }
    return originalThread.find(options);
  };
  const store = createThreadStore({
    backend: Object.freeze({
      collections: Object.freeze({
        ...backend.collections,
        thread: Object.freeze({ ...originalThread, find }),
      }),
    }),
  });

  await expect(store.readThread(ThreadId.decode("plain-conflict"))).rejects.toBe(conflict);
  expect(findCalls).toBe(1);
  await expect(store.readThread(ThreadId.decode("plain-next"))).resolves.toBeUndefined();
  expect(findCalls).toBe(2);
});

it("retains bounded conflict retries for a Transaction Store", async () => {
  const memory = MemoryStore.make({ records: coreRecordDefinitions });
  let transactionCalls = 0;
  const transaction: TransactionStore<CoreRecordDefinitions>["transaction"] = async (use) => {
    transactionCalls += 1;
    if (transactionCalls < 3) {
      throw new TransactionConflictError();
    }
    return memory.transaction(use);
  };
  const backend: TransactionStore<CoreRecordDefinitions> = Object.freeze({
    collections: memory.collections,
    transaction,
  });
  const store = createThreadStore({ backend });

  await expect(store.readThread(ThreadId.decode("transaction-retry"))).resolves.toBeUndefined();
  expect(transactionCalls).toBe(3);
});

it("stops Transaction Store retries after three conflicts", async () => {
  const memory = MemoryStore.make({ records: coreRecordDefinitions });
  const conflict = new TransactionConflictError();
  let transactionCalls = 0;
  const transaction: TransactionStore<CoreRecordDefinitions>["transaction"] = async () => {
    transactionCalls += 1;
    throw conflict;
  };
  const backend: TransactionStore<CoreRecordDefinitions> = Object.freeze({
    collections: memory.collections,
    transaction,
  });
  const store = createThreadStore({ backend });

  await expect(store.readThread(ThreadId.decode("transaction-exhausted"))).rejects.toBe(conflict);
  expect(transactionCalls).toBe(3);
});

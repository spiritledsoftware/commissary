import { TransactionClosedError, TransactionUnsettledOperationError } from "@commissary/store";
import {
  runTransactionCallback,
  type TrackTransactionOperation,
} from "@commissary/store/transaction-adapter";
import { expect, it } from "vitest";

interface TestTransactionView {
  readonly run: TrackTransactionOperation;
}

function makeTestView(track: TrackTransactionOperation): TestTransactionView {
  return { run: track };
}

it("returns a native Promise and calls the transaction callback once", async () => {
  let calls = 0;
  const result = runTransactionCallback(makeTestView, (_view) => {
    calls += 1;
    return Promise.resolve("committed");
  });

  expect(result).toBeInstanceOf(Promise);
  await expect(result).resolves.toBe("committed");
  expect(calls).toBe(1);
});

it("closes the transaction View after the callback", async () => {
  let closedOperation: (() => Promise<string>) | undefined;
  await runTransactionCallback(makeTestView, (view) => {
    closedOperation = () => view.run(() => Promise.resolve("late"));
    return Promise.resolve();
  });

  expect(closedOperation).toBeDefined();
  let result: Promise<string>;
  expect(() => {
    result = (closedOperation as () => Promise<string>)();
  }).not.toThrow();
  await expect(result!).rejects.toBeInstanceOf(TransactionClosedError);
});

it("drains unawaited work and rejects a successful callback", async () => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let operationFinished = false;
  const transaction = runTransactionCallback(makeTestView, (view) => {
    void view
      .run(() => held)
      .then(() => {
        operationFinished = true;
      });
    return Promise.resolve("unsafe success");
  });
  let settled = false;
  void transaction
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);

  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await expect(transaction).rejects.toBeInstanceOf(TransactionUnsettledOperationError);
  expect(operationFinished).toBe(true);
});

it("preserves callback failure identity while active work drains", async () => {
  const callbackFailure = { type: "callback-failure" };
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = runTransactionCallback(makeTestView, (view) => {
    void view.run(() => held);
    return Promise.reject(callbackFailure);
  });
  let settled = false;
  void transaction
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);

  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await expect(transaction).rejects.toBe(callbackFailure);
});

it("rejects with a caught operation failure after a successful callback", async () => {
  const operationFailure = { type: "operation-failure" };
  const transaction = runTransactionCallback(makeTestView, async (view) => {
    await view.run(() => Promise.reject(operationFailure)).catch(() => undefined);
  });

  await expect(transaction).rejects.toBe(operationFailure);
});

it("reports failed operations in call order rather than settlement order", async () => {
  const firstFailure = { type: "first-failure" };
  const secondFailure = { type: "second-failure" };
  let rejectFirst = (_cause: unknown): void => undefined;
  let rejectSecond = (_cause: unknown): void => undefined;
  const first = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const second = new Promise<never>((_resolve, reject) => {
    rejectSecond = reject;
  });
  const transaction = runTransactionCallback(makeTestView, async (view) => {
    const firstOperation = view.run(() => first);
    const secondOperation = view.run(() => second);
    rejectSecond(secondFailure);
    await secondOperation.catch(() => undefined);
    rejectFirst(firstFailure);
    await firstOperation.catch(() => undefined);
  });

  await expect(transaction).rejects.toBe(firstFailure);
});

it("gives unsettled work priority over completed operation failures", async () => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = runTransactionCallback(makeTestView, async (view) => {
    await view.run(() => Promise.reject(new Error("completed failure"))).catch(() => undefined);
    void view.run(() => held);
  });

  await Promise.resolve();
  release();
  await expect(transaction).rejects.toBeInstanceOf(TransactionUnsettledOperationError);
});

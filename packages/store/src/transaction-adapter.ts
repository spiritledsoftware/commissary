import { TransactionClosedError, TransactionUnsettledOperationError } from "./store-errors.js";

/** Start and track one complete Transaction View operation. */
export type TrackTransactionOperation = <Value>(start: () => Promise<Value>) => Promise<Value>;

interface TransactionOperationFailure {
  readonly cause: unknown;
  readonly order: number;
}

/**
 * Run one public transaction callback against a tracked View.
 *
 * This helper closes the View and drains active work. The adapter still owns the physical
 * transaction, commit, rollback, and resource release.
 */
export function runTransactionCallback<View, Value>(
  makeView: (track: TrackTransactionOperation) => View,
  use: (view: View) => Promise<Value>,
): Promise<Value> {
  return Promise.resolve().then(async () => {
    let closed = false;
    let nextOperationOrder = 0;
    const activeOperations = new Set<Promise<void>>();
    const operationFailures: TransactionOperationFailure[] = [];

    const track: TrackTransactionOperation = <OperationValue>(
      start: () => Promise<OperationValue>,
    ): Promise<OperationValue> => {
      if (closed) {
        return Promise.reject(new TransactionClosedError());
      }

      const order = nextOperationOrder;
      nextOperationOrder += 1;
      const operation = Promise.resolve().then(start);
      let settlement: Promise<void>;
      settlement = operation.then(
        () => {
          activeOperations.delete(settlement);
        },
        (cause: unknown) => {
          operationFailures.push({ cause, order });
          activeOperations.delete(settlement);
        },
      );
      activeOperations.add(settlement);
      return operation;
    };

    const view = makeView(track);
    let callbackFailed = false;
    let callbackFailure: unknown;
    let callbackValue!: Value;
    try {
      callbackValue = await use(view);
    } catch (cause) {
      callbackFailed = true;
      callbackFailure = cause;
    }

    const hadUnsettledOperations = !callbackFailed && activeOperations.size > 0;
    closed = true;
    await Promise.all(activeOperations);

    if (callbackFailed) {
      throw callbackFailure;
    }
    if (hadUnsettledOperations) {
      throw new TransactionUnsettledOperationError();
    }
    operationFailures.sort((left, right) => left.order - right.order);
    const firstOperationFailure = operationFailures[0];
    if (firstOperationFailure !== undefined) {
      throw firstOperationFailure.cause;
    }
    return callbackValue;
  });
}

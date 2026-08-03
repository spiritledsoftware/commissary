import {
  StoreAdapterContractError,
  StoreAdapterError,
  StoreError,
  StoreHookError,
  StoreValidationError,
  TransactionConflictError,
  TransactionRollbackError,
  UnsupportedStoreOperationError,
} from "@commissary/store";
import { describe, expect, it } from "vitest";

describe("Store errors", () => {
  it("separates operational failures from adapter contract defects", () => {
    const validation = new StoreValidationError({
      collection: "jobs",
      operation: "create",
      phase: "create",
      field: "status",
      issues: [{ message: "Invalid status", path: ["status"] }],
    });
    const contract = new StoreAdapterContractError({
      collection: "jobs",
      operation: "find",
      violation: "invalid-selected-record",
      field: "status",
    });

    expect(validation).toBeInstanceOf(StoreError);
    expect(contract).not.toBeInstanceOf(StoreError);
    expect(validation).toMatchObject({
      collection: "jobs",
      operation: "create",
      phase: "create",
      field: "status",
    });
    expect(contract).toMatchObject({
      collection: "jobs",
      operation: "find",
      violation: "invalid-selected-record",
      field: "status",
    });
  });

  it("describes adapter failures with and without a Collection", () => {
    const cause = { type: "adapter-failure" };
    const collectionFailure = new StoreAdapterError({
      collection: "jobs",
      operation: "find",
      cause,
    });
    const transactionFailure = new StoreAdapterError({
      operation: "transaction",
      cause,
    });

    expect(collectionFailure).toMatchObject({
      message: "Store adapter failed for Collection 'jobs' during find",
      collection: "jobs",
      operation: "find",
      cause,
    });
    expect(transactionFailure).toMatchObject({
      message: "Store adapter failed during transaction",
      operation: "transaction",
      cause,
    });
    expect(transactionFailure).not.toHaveProperty("collection");
  });

  it("exposes hook and unsupported operation details", () => {
    const cause = { type: "hook-failure" };
    expect(new StoreHookError("jobs", cause)).toMatchObject({
      message: "Store before-create hook failed for Collection 'jobs'",
      hook: "beforeCreate",
      collection: "jobs",
      cause,
    });
    expect(
      new UnsupportedStoreOperationError({
        collection: "jobs",
        operation: "find",
        feature: "find.limit",
      }),
    ).toMatchObject({
      message: "Store feature 'find.limit' is unavailable for Collection 'jobs' during find",
      collection: "jobs",
      operation: "find",
      feature: "find.limit",
    });
  });

  it("omits an absent transaction conflict cause", () => {
    expect(new TransactionConflictError()).toMatchObject({
      message: "Store transaction conflicted",
    });
    expect(new TransactionConflictError()).not.toHaveProperty("cause");
  });

  it("preserves transaction failure causes without retry metadata", () => {
    const conflictCause = { type: "conflict" };
    const callbackFailure = { type: "callback" };
    const rollbackFailure = { type: "rollback" };
    const conflict = new TransactionConflictError(conflictCause);

    expect(conflict).toMatchObject({
      cause: conflictCause,
    });
    expect(conflict).not.toHaveProperty("writesMayRemain");
    expect(new TransactionRollbackError({ callbackFailure, rollbackFailure })).toMatchObject({
      callbackFailure,
      rollbackFailure,
      writesMayRemain: true,
      cause: rollbackFailure,
    });
  });
});

import {
  StoreAdapterContractError,
  StoreError,
  StoreValidationError,
  TransactionConflictError,
  TransactionRollbackError,
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

  it("preserves transaction failure causes without retry metadata", () => {
    const conflictCause = { type: "conflict" };
    const callbackFailure = { type: "callback" };
    const rollbackFailure = { type: "rollback" };

    expect(new TransactionConflictError(conflictCause)).toMatchObject({
      cause: conflictCause,
    });
    expect(new TransactionRollbackError({ callbackFailure, rollbackFailure })).toMatchObject({
      callbackFailure,
      rollbackFailure,
      writesMayRemain: true,
      cause: rollbackFailure,
    });
  });
});

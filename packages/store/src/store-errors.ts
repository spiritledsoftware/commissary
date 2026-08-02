/** One normalized issue reported by a Store Field Schema. */
export interface StoreValidationIssue {
  /** Diagnostic schema message. It can contain application data and is not safe default telemetry. */
  readonly message: string;
  /** Field-local issue path with symbols normalized to strings. */
  readonly path: readonly (string | number)[];
}

/** A Collection operation that can reject with a Store error. */
export type StoreCollectionOperation = "find" | "create" | "update" | "delete" | "count";

/** A Store operation, including transaction boundaries. */
export type StoreOperation = StoreCollectionOperation | "transaction";

/** The validation stage that rejected Store input or output. */
export type StoreValidationPhase = "query" | "create" | "update";

/** Base class for expected Store operational failures. */
export abstract class StoreError extends Error {}

/** Configuration for one caller-facing Store validation failure. */
export interface StoreValidationErrorOptions {
  /** Collection that rejected the value. */
  readonly collection: string;
  /** Collection operation that rejected the value. */
  readonly operation: StoreCollectionOperation;
  /** Validation phase that rejected the value. */
  readonly phase: StoreValidationPhase;
  /** Top-level Field that failed, when one Field caused the failure. */
  readonly field?: string;
  /** Normalized schema issues. */
  readonly issues: readonly StoreValidationIssue[];
}

/** Expected failure for invalid Store query, create, or update data. */
export class StoreValidationError extends StoreError {
  /** Stable error class name. */
  override readonly name = "StoreValidationError";
  /** Collection that rejected the value. */
  readonly collection: string;
  /** Collection operation that rejected the value. */
  readonly operation: StoreCollectionOperation;
  /** Validation phase that rejected the value. */
  readonly phase: StoreValidationPhase;
  /** Top-level Field that failed, when present. */
  readonly field?: string;
  /** Normalized schema issues. */
  readonly issues: readonly StoreValidationIssue[];

  /** Create one validation failure from normalized metadata. */
  constructor(options: StoreValidationErrorOptions) {
    super(
      `Store validation failed for Collection '${options.collection}' during ${options.operation}`,
    );
    this.collection = options.collection;
    this.operation = options.operation;
    this.phase = options.phase;
    this.issues = options.issues;
    if (options.field !== undefined) {
      this.field = options.field;
    }
  }
}

/** Expected failure raised when one before-create hook throws. */
export class StoreHookError extends StoreError {
  /** Stable error class name. */
  override readonly name = "StoreHookError";
  /** Hook point that failed. */
  readonly hook = "beforeCreate";
  /** Collection whose hook failed. */
  readonly collection: string;
  /** Original hook failure. */
  override readonly cause: unknown;

  /** Create one before-create hook failure. */
  constructor(collection: string, cause: unknown) {
    super(`Store before-create hook failed for Collection '${collection}'`, { cause });
    this.collection = collection;
    this.cause = cause;
  }
}

/** Configuration for an input-dependent unsupported Store operation. */
export interface UnsupportedStoreOperationErrorOptions {
  /** Collection that cannot support the feature. */
  readonly collection: string;
  /** Collection operation that cannot support the feature. */
  readonly operation: StoreCollectionOperation;
  /** Stable feature identifier that is unavailable. */
  readonly feature: string;
}

/** Expected failure when an operation cannot support the supplied input or state. */
export class UnsupportedStoreOperationError extends StoreError {
  /** Stable error class name. */
  override readonly name = "UnsupportedStoreOperationError";
  /** Collection that cannot support the feature. */
  readonly collection: string;
  /** Collection operation that cannot support the feature. */
  readonly operation: StoreCollectionOperation;
  /** Stable feature identifier that is unavailable. */
  readonly feature: string;

  /** Create one unsupported-operation failure. */
  constructor(options: UnsupportedStoreOperationErrorOptions) {
    super(
      `Store feature '${options.feature}' is unavailable for Collection '${options.collection}' during ${options.operation}`,
    );
    this.collection = options.collection;
    this.operation = options.operation;
    this.feature = options.feature;
  }
}

/** Configuration for one adapter I/O or backend failure. */
export interface StoreAdapterErrorOptions {
  /** Collection that failed, when the failure belongs to one Collection. */
  readonly collection?: string;
  /** Store operation that failed. */
  readonly operation: StoreOperation;
  /** Original adapter or backend failure. */
  readonly cause: unknown;
}

/** Expected Store failure caused by an adapter or backend operation. */
export class StoreAdapterError extends StoreError {
  /** Stable error class name. */
  override readonly name = "StoreAdapterError";
  /** Original adapter or backend failure. */
  override readonly cause: unknown;
  /** Collection that failed, when present. */
  readonly collection?: string;
  /** Store operation that failed. */
  readonly operation: StoreOperation;

  /** Create one adapter failure. */
  constructor(options: StoreAdapterErrorOptions) {
    super(
      options.collection === undefined
        ? `Store adapter failed during ${options.operation}`
        : `Store adapter failed for Collection '${options.collection}' during ${options.operation}`,
      { cause: options.cause },
    );
    this.cause = options.cause;
    this.operation = options.operation;
    if (options.collection !== undefined) {
      this.collection = options.collection;
    }
  }
}

/** Expected transaction conflict that an adapter does not retry. */
export class TransactionConflictError extends StoreError {
  /** Stable error class name. */
  override readonly name = "TransactionConflictError";
  /** Optional adapter conflict detail. */
  override readonly cause?: unknown;

  /** Create one transaction conflict. */
  constructor(cause?: unknown) {
    super("Store transaction conflicted", ...(cause === undefined ? [] : [{ cause }]));
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Configuration for a failed rollback after a transaction callback failure. */
export interface TransactionRollbackErrorOptions {
  /** Original transaction callback failure. */
  readonly callbackFailure: unknown;
  /** Failure raised while the adapter tried to roll back. */
  readonly rollbackFailure: unknown;
}

/** Expected failure when a transaction callback and its rollback both fail. */
export class TransactionRollbackError extends StoreError {
  /** Stable error class name. */
  override readonly name = "TransactionRollbackError";
  /** Original transaction callback failure. */
  readonly callbackFailure: unknown;
  /** Failure raised while the adapter tried to roll back. */
  readonly rollbackFailure: unknown;
  /** True because a failed rollback cannot prove that all writes were removed. */
  readonly writesMayRemain = true;

  /** Create one rollback failure. */
  constructor(options: TransactionRollbackErrorOptions) {
    super("Store transaction rollback failed", { cause: options.rollbackFailure });
    this.callbackFailure = options.callbackFailure;
    this.rollbackFailure = options.rollbackFailure;
  }
}

/** Adapter output or behavior that violates the public Store contract. */
export type StoreAdapterContractViolation =
  | "unknown-record-key"
  | "invalid-selected-record"
  | "generated-value-overwrite"
  | "invalid-expression-result"
  | "transaction-contract";

/** Configuration for one adapter contract defect. */
export interface StoreAdapterContractErrorOptions {
  /** Collection involved in the violation, when applicable. */
  readonly collection?: string;
  /** Store operation during which the adapter violated the contract. */
  readonly operation: StoreOperation;
  /** Stable contract violation code. */
  readonly violation: StoreAdapterContractViolation;
  /** Top-level Field involved in the violation, when applicable. */
  readonly field?: string;
  /** Original defect detail. */
  readonly cause?: unknown;
}

/** Adapter contract defect. This intentionally does not extend StoreError. */
export class StoreAdapterContractError extends Error {
  /** Stable error class name. */
  override readonly name = "StoreAdapterContractError";
  /** Original defect detail. */
  override readonly cause?: unknown;
  /** Collection involved in the violation, when present. */
  readonly collection?: string;
  /** Store operation during which the adapter violated the contract. */
  readonly operation: StoreOperation;
  /** Stable contract violation code. */
  readonly violation: StoreAdapterContractViolation;
  /** Top-level Field involved in the violation, when present. */
  readonly field?: string;

  /** Create one adapter contract defect. */
  constructor(options: StoreAdapterContractErrorOptions) {
    super(
      `Store adapter violated '${options.violation}' during ${options.operation}`,
      ...(options.cause === undefined ? [] : [{ cause: options.cause }]),
    );
    this.operation = options.operation;
    this.violation = options.violation;
    if (options.collection !== undefined) {
      this.collection = options.collection;
    }
    if (options.field !== undefined) {
      this.field = options.field;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

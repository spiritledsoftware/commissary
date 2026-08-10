import { StoreError } from "../store-errors.js";

/** The direct SQL operation that owns one Statement or execution failure. */
export type SqlOperation = "query" | "execute";

/** Configuration for one caller-facing SQL Statement failure. */
export type SqlStatementErrorOptions = {
  /** Direct SQL operation that rejected the Statement. */
  readonly operation: SqlOperation;
} & (
  | { readonly reason: "invalid-statement" }
  | {
      readonly reason: "unsupported-parameter";
      readonly parameterPosition: number;
    }
  | {
      readonly reason: "invalid-parameter";
      readonly parameterPosition: number;
      readonly cause?: unknown;
    }
);

/** Expected failure while checking or compiling one SQL Statement. */
export class SqlStatementError extends StoreError {
  /** Stable error class name. */
  override readonly name = "SqlStatementError";
  /** Statement rejection occurs before the driver call. */
  readonly writesMayRemain = false;
  /** Direct SQL operation that rejected the Statement. */
  readonly operation: SqlOperation;
  /** Stable Statement failure classification. */
  readonly reason: SqlStatementErrorOptions["reason"];
  /** Zero-based parameter position, when one parameter caused the failure. */
  declare readonly parameterPosition?: number;
  /** Original parameter-processing failure, when one callback threw. */
  declare readonly cause?: unknown;

  /** Create one Statement failure without retaining SQL text or parameter values. */
  constructor(options: SqlStatementErrorOptions) {
    const hasCause = options.reason === "invalid-parameter" && Object.hasOwn(options, "cause");
    super(
      `SQL Statement failed during ${options.operation}: ${options.reason}`,
      ...(hasCause ? [{ cause: options.cause }] : []),
    );
    this.operation = options.operation;
    this.reason = options.reason;
    if (options.reason !== "invalid-statement") {
      this.parameterPosition = options.parameterPosition;
    }
    if (hasCause) {
      this.cause = options.cause;
    }
  }
}

/** Configuration for one failed SQL driver operation or unsupported result mode. */
export type SqlExecutionErrorOptions = {
  /** Direct SQL operation that failed. */
  readonly operation: SqlOperation;
} & (
  | {
      readonly reason: "execution-failed";
      readonly executionMayHaveOccurred: boolean;
      readonly cause: unknown;
    }
  | {
      readonly reason: "multiple-results";
      readonly executionMayHaveOccurred: true;
    }
);

/** Expected failure while submitting valid SQL or selecting one result mode. */
export class SqlExecutionError extends StoreError {
  /** Stable error class name. */
  override readonly name = "SqlExecutionError";
  /** Direct SQL operation that failed. */
  readonly operation: SqlOperation;
  /** Stable execution failure classification. */
  readonly reason: SqlExecutionErrorOptions["reason"];
  /** Whether the driver statement call started or its outcome is uncertain. */
  readonly executionMayHaveOccurred: boolean;
  /** A started SQL operation can leave a write when the transaction does not roll back. */
  readonly writesMayRemain: boolean;
  /** Original driver failure, only for execution failures. */
  declare readonly cause?: unknown;

  /** Create one SQL execution failure without retaining SQL text or parameter values. */
  constructor(options: SqlExecutionErrorOptions) {
    const hasCause = options.reason === "execution-failed";
    super(
      `SQL execution failed during ${options.operation}: ${options.reason}`,
      ...(hasCause ? [{ cause: options.cause }] : []),
    );
    this.operation = options.operation;
    this.reason = options.reason;
    this.executionMayHaveOccurred = options.executionMayHaveOccurred;
    this.writesMayRemain = options.executionMayHaveOccurred;
    if (hasCause) {
      this.cause = options.cause;
    }
  }
}

import {
  compileSqlStatement,
  type CompiledSqlStatement,
  type SqlStatementCompilerOptions,
} from "./adapter.js";
import { SqlExecutionError, SqlStatementError, type SqlOperation } from "./errors.js";
import type { BaseStoreOperatorTypes, StoreOperatorTypes } from "../store-expressions.js";
import type { RecordDefinitions } from "../record.js";
import type { SqlParameterValue, SqlStatement } from "./statement.js";
import { StoreAdapterContractError } from "../store-errors.js";
import type {
  DefaultStoreCreateInputs,
  Store,
  StoreCollections,
  StoreCreateInputMap,
} from "../store.js";
export {
  SqlExecutionError,
  SqlStatementError,
  type SqlExecutionErrorOptions,
  type SqlOperation,
  type SqlStatementErrorOptions,
} from "./errors.js";

/** Stable command metadata plus the exact public driver result. */
export interface SqlCommandResult<out DriverResult = unknown> {
  /** Verified direct affected-row count, when the adapter can provide one. */
  readonly affectedRows: number | undefined;
  /** Exact public result returned by the driver. */
  readonly driverResult: DriverResult;
}

/** Store capability for parameter-safe direct SQL query and command execution. */
export interface SqlStore<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  out DriverResult = unknown,
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> extends Store<Definitions, Operators, CreateInputs> {
  /** Return one unchecked caller-typed row array without copying it. */
  readonly query: <Row = unknown>(
    statement: SqlStatement<SqlParameterValue>,
  ) => Promise<readonly Row[]>;

  /** Execute one row-free command and retain the exact driver result. */
  readonly execute: (
    statement: SqlStatement<SqlParameterValue>,
  ) => Promise<SqlCommandResult<DriverResult>>;
}

/** Adapter-normalized outcome of one row-producing driver call. */
export type SqlQueryOutcome =
  | { readonly kind: "rows"; readonly rows: unknown }
  | { readonly kind: "multiple-results" };

/** Adapter callbacks and Collection Map used to construct one SQL Store. */
export interface SqlStoreAdapterOptions<
  Definitions extends RecordDefinitions,
  DriverParameter,
  DriverResult,
  QueryDriverResult = unknown,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> {
  /** Collection operations backed by the same database. */
  readonly collections: StoreCollections<Definitions, Operators, CreateInputs>;
  /** Pure Statement compiler callbacks for the adapter dialect and driver. */
  readonly compiler: SqlStatementCompilerOptions<SqlParameterValue, DriverParameter>;
  /** Prepare one row-producing driver statement call without invoking it. */
  readonly prepareQuery: (
    compiled: CompiledSqlStatement<DriverParameter>,
  ) => () => Promise<QueryDriverResult>;
  /** Prepare one row-free driver statement call without invoking it. */
  readonly prepareExecute: (
    compiled: CompiledSqlStatement<DriverParameter>,
  ) => () => Promise<DriverResult>;
  /** Classify one successful row-producing driver result. */
  readonly readQueryOutcome: (driverResult: QueryDriverResult) => SqlQueryOutcome;
  /** Read an affected-row candidate from an exact successful command result. */
  readonly readAffectedRows: (driverResult: DriverResult) => unknown;
}

function sqlContractError(
  operation: SqlOperation,
  violation: "invalid-sql-compilation" | "invalid-sql-result",
  writesMayRemain: boolean,
  causeOptions?: { readonly cause: unknown },
): StoreAdapterContractError {
  return new StoreAdapterContractError({
    operation,
    violation,
    writesMayRemain,
    ...(causeOptions === undefined ? {} : { cause: causeOptions.cause }),
  });
}

function reclassifySqlStatementError(
  operation: SqlOperation,
  error: SqlStatementError,
): SqlStatementError {
  if (error.reason === "invalid-statement") {
    return new SqlStatementError({ operation, reason: error.reason });
  }
  if (error.reason === "unsupported-parameter") {
    return new SqlStatementError({
      operation,
      reason: error.reason,
      parameterPosition: error.parameterPosition as number,
    });
  }
  return new SqlStatementError({
    operation,
    reason: error.reason,
    parameterPosition: error.parameterPosition as number,
    ...(Object.hasOwn(error, "cause") ? { cause: error.cause } : {}),
  });
}

function compileSqlStoreStatement<DriverParameter>(
  operation: SqlOperation,
  statement: SqlStatement<SqlParameterValue>,
  compiler: SqlStatementCompilerOptions<SqlParameterValue, DriverParameter>,
): CompiledSqlStatement<DriverParameter> {
  try {
    return compileSqlStatement(statement, compiler);
  } catch (cause) {
    if (cause instanceof SqlStatementError) {
      throw reclassifySqlStatementError(operation, cause);
    }
    if (
      cause instanceof StoreAdapterContractError &&
      cause.violation === "invalid-sql-compilation"
    ) {
      throw sqlContractError(
        operation,
        cause.violation,
        false,
        Object.hasOwn(cause, "cause") ? { cause: cause.cause } : undefined,
      );
    }
    throw sqlContractError(operation, "invalid-sql-compilation", false, { cause });
  }
}

function prepareSqlDriverCall<Result>(
  operation: SqlOperation,
  prepare: () => unknown,
): () => Promise<Result> {
  let call: unknown;
  try {
    call = prepare();
  } catch (cause) {
    throw new SqlExecutionError({
      operation,
      reason: "execution-failed",
      executionMayHaveOccurred: false,
      cause,
    });
  }
  if (typeof call !== "function") {
    throw sqlContractError(operation, "invalid-sql-compilation", false);
  }
  return call as () => Promise<Result>;
}

async function callSqlDriver<Result>(
  operation: SqlOperation,
  call: () => Promise<Result>,
): Promise<Result> {
  try {
    return await call();
  } catch (cause) {
    throw new SqlExecutionError({
      operation,
      reason: "execution-failed",
      executionMayHaveOccurred: true,
      cause,
    });
  }
}

function readSqlQueryRows<QueryDriverResult>(
  driverResult: QueryDriverResult,
  readOutcome: (result: QueryDriverResult) => SqlQueryOutcome,
): readonly unknown[] {
  let outcome: unknown;
  try {
    outcome = readOutcome(driverResult);
  } catch (cause) {
    throw sqlContractError(
      "query",
      "invalid-sql-result",
      true,
      cause === driverResult ? undefined : { cause },
    );
  }
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    throw sqlContractError("query", "invalid-sql-result", true);
  }
  let kind: unknown;
  let rows: unknown;
  try {
    kind = Reflect.get(outcome, "kind");
    rows = Reflect.get(outcome, "rows");
  } catch (cause) {
    throw sqlContractError("query", "invalid-sql-result", true, { cause });
  }
  if (kind === "multiple-results") {
    throw new SqlExecutionError({
      operation: "query",
      reason: "multiple-results",
      executionMayHaveOccurred: true,
    });
  }
  if (kind !== "rows" || !Array.isArray(rows)) {
    throw sqlContractError("query", "invalid-sql-result", true);
  }
  return rows;
}

function readSqlAffectedRows<DriverResult>(
  driverResult: DriverResult,
  readAffectedRows: (result: DriverResult) => unknown,
): number | undefined {
  let affectedRows: unknown;
  try {
    affectedRows = readAffectedRows(driverResult);
  } catch (cause) {
    throw sqlContractError(
      "execute",
      "invalid-sql-result",
      true,
      cause === driverResult ? undefined : { cause },
    );
  }
  if (
    affectedRows !== undefined &&
    (typeof affectedRows !== "number" || !Number.isSafeInteger(affectedRows) || affectedRows < 0)
  ) {
    throw sqlContractError("execute", "invalid-sql-result", true);
  }
  return affectedRows;
}

/** Construct one SQL Store without exposing adapter callbacks or test controls. */
export function createSqlStore<
  Definitions extends RecordDefinitions,
  DriverParameter,
  DriverResult,
  QueryDriverResult = unknown,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
>(
  options: SqlStoreAdapterOptions<
    Definitions,
    DriverParameter,
    DriverResult,
    QueryDriverResult,
    Operators,
    CreateInputs
  >,
): SqlStore<Definitions, Operators, DriverResult, CreateInputs> {
  const query: SqlStore<Definitions, Operators, DriverResult, CreateInputs>["query"] = <
    Row = unknown,
  >(
    statement: SqlStatement<SqlParameterValue>,
  ): Promise<readonly Row[]> =>
    Promise.resolve().then(async () => {
      const compiled = compileSqlStoreStatement("query", statement, options.compiler);
      const call = prepareSqlDriverCall<QueryDriverResult>("query", () =>
        options.prepareQuery(compiled),
      );
      const driverResult = await callSqlDriver("query", call);
      return readSqlQueryRows(driverResult, options.readQueryOutcome) as readonly Row[];
    });

  const execute: SqlStore<Definitions, Operators, DriverResult, CreateInputs>["execute"] = (
    statement,
  ) =>
    Promise.resolve().then(async () => {
      const compiled = compileSqlStoreStatement("execute", statement, options.compiler);
      const call = prepareSqlDriverCall<DriverResult>("execute", () =>
        options.prepareExecute(compiled),
      );
      const driverResult = await callSqlDriver("execute", call);
      return {
        affectedRows: readSqlAffectedRows(driverResult, options.readAffectedRows),
        driverResult,
      };
    });

  return Object.freeze({
    collections: options.collections,
    query,
    execute,
  });
}

import { compileSqlStatement } from "./adapter.js";
import { SqlRecord } from "./record.js";
import { SqlExecutionError, SqlStatementError, type SqlOperation, type SqlStore } from "./store.js";
import { sql, type SqlParameterValue, type SqlStatement } from "./statement.js";
import {
  StoreAdapterContractError,
  TransactionClosedError,
  TransactionRollbackError,
  TransactionUnsettledOperationError,
} from "../store-errors.js";
import type { BaseStoreOperatorTypes } from "../store-expressions.js";
import type { TransactionStore } from "../store.js";
import type { FieldSchema } from "../record.js";
import type { JsonValue } from "../json.js";

type SchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

function sqlConformanceFieldSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SchemaResult<Output>,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-sql-conformance",
      validate,
    },
  };
}

const sqlConformanceStringField = sqlConformanceFieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);
const sqlConformanceNumberField = sqlConformanceFieldSchema<number, number>((value) =>
  typeof value === "number" && Number.isFinite(value)
    ? { value }
    : { issues: [{ message: "Expected a finite number" }] },
);

/** Fixed portable Record catalog used by SQL Store conformance suites. */
export const sqlStoreConformanceRecordDefinitions = {
  jobs: SqlRecord.define({
    table: sql.table({ name: "commissary_conformance_jobs", primaryKey: ["id"] }),
    fields: {
      id: {
        select: sqlConformanceStringField,
        column: sql.column({ name: "id", type: sql.text(), notNull: true }),
      },
      label: {
        select: sqlConformanceStringField,
        column: sql.column({ name: "label", type: sql.text(), notNull: true }),
      },
      rank: {
        select: sqlConformanceNumberField,
        column: sql.column({ name: "rank", type: sql.number(), notNull: true }),
      },
    },
  }),
} as const;

/** Expected dialect compilation of the fixed `SELECT` Statement used by the shared suite. */
export interface SqlStoreConformanceProfile<DriverParameter> {
  /** Stable adapter name used in scenario output. */
  readonly adapter: string;
  /** Exact compiler output for `SELECT ${sql.param("conformance")}`. */
  readonly expectedCompilation: {
    readonly text: string;
    readonly parameters: readonly DriverParameter[];
    readonly segments: readonly string[];
  };
}

/** One observed SQL driver statement call. */
export interface SqlStoreConformanceDriverCall<DriverParameter> {
  readonly operation: SqlOperation;
  readonly text: string;
  readonly parameters: readonly DriverParameter[];
  readonly segments: readonly string[];
}

/** One queued test-driver outcome consumed by a SQL Store fixture. */
export type SqlStoreConformanceOutcome<DriverResult> =
  | { readonly kind: "query"; readonly rows: readonly unknown[] }
  | {
      readonly kind: "command";
      readonly affectedRows: number | undefined;
      readonly driverResult: DriverResult;
    }
  | {
      readonly kind: "failure";
      readonly stage: "before-statement-call" | "statement-call";
      readonly cause: unknown;
    }
  | { readonly kind: "multiple-results" }
  | {
      readonly kind: "invalid-query-result";
      readonly shape: "non-array" | "result-check-failure";
      readonly cause?: unknown;
    };

/** Test-only SQL driver controls. */
export interface SqlStoreConformanceControls<DriverParameter, DriverResult> {
  readonly driverCalls: readonly SqlStoreConformanceDriverCall<DriverParameter>[];
  readonly enqueueOutcome: (outcome: SqlStoreConformanceOutcome<DriverResult>) => void;
}

/** One isolated SQL Store and its test-driver controls. */
export interface SqlStoreConformanceFixture<DriverParameter, DriverResult> {
  readonly store: SqlStore<
    typeof sqlStoreConformanceRecordDefinitions,
    BaseStoreOperatorTypes,
    DriverResult
  >;
  readonly controls: SqlStoreConformanceControls<DriverParameter, DriverResult>;
}

/** One adapter factory accepted by the shared SQL Store suite. */
export interface SqlStoreConformanceAdapter<DriverParameter, DriverResult> {
  readonly profile: SqlStoreConformanceProfile<DriverParameter>;
  readonly makeFixture: () =>
    | SqlStoreConformanceFixture<DriverParameter, DriverResult>
    | Promise<SqlStoreConformanceFixture<DriverParameter, DriverResult>>;
}

/** Statements that perform the combined suite's physical job writes. */
export interface SqlTransactionStoreConformanceStatements {
  readonly insertJob: (job: {
    readonly id: string;
    readonly label: string;
    readonly rank: number;
  }) => SqlStatement<SqlParameterValue>;
  readonly deleteJob: (id: string) => SqlStatement<SqlParameterValue>;
}

/** One controlled active operation used to prove transaction draining. */
export interface HeldTransactionConformanceOperation {
  readonly started: Promise<void>;
  readonly release: () => void;
}

/** Test-only physical transaction controls. */
export interface TransactionConformanceControls {
  readonly beginCount: number;
  readonly commitCount: number;
  readonly rollbackCount: number;
  readonly holdNextOperation: () => HeldTransactionConformanceOperation;
  readonly failNextRollback: (cause: unknown) => void;
}

/** SQL and Collection capabilities exposed by a combined Transaction Store. */
export type SqlTransactionStoreConformanceStore<DriverResult> = SqlStore<
  typeof sqlStoreConformanceRecordDefinitions,
  BaseStoreOperatorTypes,
  DriverResult
> &
  TransactionStore<
    typeof sqlStoreConformanceRecordDefinitions,
    BaseStoreOperatorTypes,
    Pick<
      SqlStore<typeof sqlStoreConformanceRecordDefinitions, BaseStoreOperatorTypes, DriverResult>,
      "query" | "execute"
    >
  >;

/** One isolated combined SQL and Collection Transaction Store fixture. */
export interface SqlTransactionStoreConformanceFixture<DriverParameter, DriverResult> {
  readonly store: SqlTransactionStoreConformanceStore<DriverResult>;
  readonly sqlControls: SqlStoreConformanceControls<DriverParameter, DriverResult>;
  readonly transactionControls: TransactionConformanceControls;
  readonly statements: SqlTransactionStoreConformanceStatements;
}

/** One combined SQL and Collection Transaction Store adapter factory. */
export interface SqlTransactionStoreConformanceAdapter<DriverParameter, DriverResult> {
  readonly profile: SqlStoreConformanceProfile<DriverParameter>;
  readonly makeFixture: () =>
    | SqlTransactionStoreConformanceFixture<DriverParameter, DriverResult>
    | Promise<SqlTransactionStoreConformanceFixture<DriverParameter, DriverResult>>;
}

/** One independently executable SQL conformance scenario. */
export interface SqlConformanceScenario {
  readonly name: string;
  readonly run: () => Promise<void>;
}

function assertSqlConformance(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`SQL Store conformance failure: ${message}`);
  }
}

function assertSqlConformanceValues(
  actual: readonly unknown[],
  expected: readonly unknown[],
  message: string,
): void {
  assertSqlConformance(actual.length === expected.length, `${message}: item count`);
  expected.forEach((value, position) => {
    assertSqlConformance(Object.is(actual[position], value), `${message}: item ${position}`);
  });
}

async function captureSqlConformanceFailure(start: () => Promise<unknown>): Promise<unknown> {
  try {
    await start();
  } catch (cause) {
    return cause;
  }
  throw new Error("SQL Store conformance failure: expected operation to reject");
}

function assertSafeSqlError(error: unknown): asserts error is Error {
  assertSqlConformance(error instanceof Error, "expected an Error");
  for (const key of ["text", "sql", "parameter", "parameters", "value", "values"]) {
    assertSqlConformance(!Object.hasOwn(error, key), `error must omit ${key}`);
  }
}

const fixedSqlConformanceStatement = sql`SELECT ${sql.param("conformance")}`;

/** Build the package-owned SQL Statement scenarios. Run this suite once in `@commissary/store`. */
export function createSqlStatementConformanceSuite(): readonly SqlConformanceScenario[] {
  return Object.freeze([
    {
      name: "Statement composition preserves segments and fresh parameters",
      run: async () => {
        const statement = sql`${sql.raw("SELECT ")}${sql.identifier("job_id")} = ${sql.param([
          1, 2,
        ])}`;
        const options = {
          quoteIdentifier: (name: string) => `"${name}"`,
          makePlaceholder: (position: number) => `$${position + 1}`,
          isParameter: (value: unknown): value is readonly number[] => Array.isArray(value),
          convertParameter: (value: readonly number[]) => value,
        };
        const first = compileSqlStatement(statement, options);
        const second = compileSqlStatement(statement, options);
        assertSqlConformance(first.text === 'SELECT "job_id" = $1', "compiled text");
        assertSqlConformance(
          first.segments.join("|") === 'SELECT "job_id" = |',
          "compiled segments",
        );
        assertSqlConformance(first.parameters !== second.parameters, "fresh parameter arrays");
        assertSqlConformance(
          first.parameters[0] === second.parameters[0],
          "array is one parameter",
        );
      },
    },
    {
      name: "Statement compilation stops at the first invalid parameter",
      run: async () => {
        const calls: unknown[] = [];
        const statement = sql`${sql.param("first", {
          encode: (value) => {
            calls.push(value);
            return "invalid";
          },
        })}${sql.param("second", {
          encode: (value) => {
            calls.push(value);
            return 2;
          },
        })}`;
        const failure = await captureSqlConformanceFailure(() =>
          Promise.resolve().then(() =>
            compileSqlStatement(statement, {
              quoteIdentifier: (name) => name,
              makePlaceholder: () => "?",
              isParameter: (value): value is number => typeof value === "number",
              convertParameter: (value) => value,
            }),
          ),
        );
        assertSqlConformance(failure instanceof SqlStatementError, "Statement error type");
        assertSqlConformance(failure.reason === "unsupported-parameter", "failure reason");
        assertSqlConformance(failure.parameterPosition === 0, "failure position");
        assertSqlConformance(
          calls.length === 1 && calls[0] === "first",
          "first failure stops work",
        );
      },
    },
    {
      name: "Statement compilation rejects counterfeit values safely",
      run: async () => {
        const failure = await captureSqlConformanceFailure(() =>
          Promise.resolve().then(() =>
            compileSqlStatement({} as SqlStatement<never>, {
              quoteIdentifier: (name) => name,
              makePlaceholder: () => "?",
              isParameter: (_value): _value is never => false,
              convertParameter: (value) => value,
            }),
          ),
        );
        assertSqlConformance(failure instanceof SqlStatementError, "counterfeit error type");
        assertSqlConformance(failure.reason === "invalid-statement", "counterfeit reason");
        assertSafeSqlError(failure);
      },
    },
  ]);
}

/** Build the reusable runtime scenarios for one SQL Store adapter. */
export function createSqlStoreConformanceSuite<DriverParameter, DriverResult>(
  adapter: SqlStoreConformanceAdapter<DriverParameter, DriverResult>,
): readonly SqlConformanceScenario[] {
  const scenario = (
    name: string,
    run: (fixture: SqlStoreConformanceFixture<DriverParameter, DriverResult>) => Promise<void>,
  ): SqlConformanceScenario => ({
    name: `${adapter.profile.adapter}: ${name}`,
    run: async () => run(await adapter.makeFixture()),
  });

  return Object.freeze([
    scenario(
      "returns native Promises and compiles the fixed Statement",
      async ({ store, controls }) => {
        controls.enqueueOutcome({ kind: "query", rows: [] });
        let queryResult: Promise<readonly unknown[]>;
        let executeResult: Promise<unknown>;
        try {
          queryResult = store.query(fixedSqlConformanceStatement);
          executeResult = store.execute(fixedSqlConformanceStatement);
        } catch {
          throw new Error("SQL Store conformance failure: SQL operation threw synchronously");
        }
        assertSqlConformance(queryResult instanceof Promise, "query must return a native Promise");
        assertSqlConformance(
          executeResult instanceof Promise,
          "execute must return a native Promise",
        );
        await Promise.all([queryResult, executeResult]);
        assertSqlConformance(controls.driverCalls.length === 2, "fixed Statement call count");
        const [queryCall, executeCall] = controls.driverCalls;
        assertSqlConformance(queryCall?.operation === "query", "fixed query operation");
        assertSqlConformance(executeCall?.operation === "execute", "fixed execute operation");
        for (const call of controls.driverCalls) {
          assertSqlConformance(
            call.text === adapter.profile.expectedCompilation.text,
            "fixed Statement text",
          );
          assertSqlConformanceValues(
            call.parameters,
            adapter.profile.expectedCompilation.parameters,
            "fixed Statement parameters",
          );
          assertSqlConformanceValues(
            call.segments,
            adapter.profile.expectedCompilation.segments,
            "fixed Statement segments",
          );
        }
      },
    ),
    scenario("accepts every portable parameter value", async ({ store, controls }) => {
      const values: readonly SqlParameterValue[] = [null, false, true, 0, -1.5, "", "portable"];
      for (const value of values) {
        controls.enqueueOutcome({ kind: "query", rows: [] });
        await store.query(sql`${sql.param(value)}`);
      }
      assertSqlConformance(controls.driverCalls.length === values.length, "portable call count");
    }),
    scenario("rejects invalid parameters before driver work", async ({ store, controls }) => {
      const invalidValues: readonly unknown[] = [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        {},
        [],
      ];
      for (const value of invalidValues) {
        const statement = sql.param(value) as SqlStatement<SqlParameterValue>;
        const failure = await captureSqlConformanceFailure(() => store.query(statement));
        assertSqlConformance(failure instanceof SqlStatementError, "invalid parameter error");
        assertSqlConformance(failure.parameterPosition === 0, "invalid parameter position");
      }
      assertSqlConformance(controls.driverCalls.length === 0, "invalid values reached driver");
    }),
    scenario("reports exact later parameter positions", async ({ store, controls }) => {
      const statement =
        sql`${sql.param("valid")}, ${sql.param({})}` as SqlStatement<SqlParameterValue>;
      const failure = await captureSqlConformanceFailure(() => store.execute(statement));
      assertSqlConformance(failure instanceof SqlStatementError, "later parameter error");
      assertSqlConformance(failure.parameterPosition === 1, "later parameter position");
      assertSqlConformance(controls.driverCalls.length === 0, "partial compilation reached driver");
    }),
    scenario("preserves failures before and during driver calls", async ({ store, controls }) => {
      const beforeCause = new Error("before statement call");
      controls.enqueueOutcome({
        kind: "failure",
        stage: "before-statement-call",
        cause: beforeCause,
      });
      const beforeFailure = await captureSqlConformanceFailure(() =>
        store.query(fixedSqlConformanceStatement),
      );
      assertSqlConformance(beforeFailure instanceof SqlExecutionError, "before-call error type");
      assertSqlConformance(!beforeFailure.executionMayHaveOccurred, "before-call execution state");
      assertSqlConformance(beforeFailure.cause === beforeCause, "before-call cause");

      const duringCause = new Error("statement call");
      controls.enqueueOutcome({ kind: "failure", stage: "statement-call", cause: duringCause });
      const duringFailure = await captureSqlConformanceFailure(() =>
        store.execute(fixedSqlConformanceStatement),
      );
      assertSqlConformance(duringFailure instanceof SqlExecutionError, "during-call error type");
      assertSqlConformance(duringFailure.executionMayHaveOccurred, "during-call execution state");
      assertSqlConformance(duringFailure.cause === duringCause, "during-call cause");
    }),
    scenario("makes one call with no retry and permits empty SQL", async ({ store, controls }) => {
      controls.enqueueOutcome({ kind: "query", rows: [] });
      await store.query(sql.raw(""));
      const driverResult = Object.freeze({ result: "identity" }) as DriverResult;
      controls.enqueueOutcome({ kind: "command", affectedRows: 0, driverResult });
      const result = await store.execute(sql.raw(""));
      assertSqlConformance(controls.driverCalls.length === 2, "empty SQL call count");
      assertSqlConformance(controls.driverCalls[0]?.text === "", "empty query text");
      assertSqlConformance(controls.driverCalls[1]?.text === "", "empty execute text");
      assertSqlConformance(result.driverResult === driverResult, "driver result identity");
    }),
    scenario(
      "returns unchecked query rows without Collection parsing",
      async ({ store, controls }) => {
        const row = Object.freeze({ direct: "row", unknownRecordKey: true });
        controls.enqueueOutcome({ kind: "query", rows: [] });
        const empty = await store.query<typeof row>(sql.raw("SELECT empty"));
        assertSqlConformance(empty.length === 0, "empty query rows");
        const driverRows = Object.freeze([row]);
        controls.enqueueOutcome({ kind: "query", rows: driverRows });
        const rows = await store.query<typeof row>(sql.raw("SELECT row"));
        assertSqlConformance(rows === driverRows, "query row container identity");
        assertSqlConformance(rows[0] === row, "unchecked row identity");
      },
    ),
    scenario(
      "normalizes affected rows and preserves driver results",
      async ({ store, controls }) => {
        const unavailableResult = Object.freeze({ kind: "unavailable" }) as DriverResult;
        controls.enqueueOutcome({
          kind: "command",
          affectedRows: undefined,
          driverResult: unavailableResult,
        });
        const unavailable = await store.execute(fixedSqlConformanceStatement);
        assertSqlConformance(unavailable.affectedRows === undefined, "unavailable affected rows");
        assertSqlConformance(
          unavailable.driverResult === unavailableResult,
          "unavailable identity",
        );

        const definedResult = Object.freeze({ kind: "defined" }) as DriverResult;
        controls.enqueueOutcome({ kind: "command", affectedRows: 3, driverResult: definedResult });
        const defined = await store.execute(fixedSqlConformanceStatement);
        assertSqlConformance(defined.affectedRows === 3, "defined affected rows");
        assertSqlConformance(defined.driverResult === definedResult, "defined identity");
      },
    ),
    scenario("rejects invalid and multiple query results", async ({ store, controls }) => {
      controls.enqueueOutcome({ kind: "invalid-query-result", shape: "non-array" });
      const nonArray = await captureSqlConformanceFailure(() =>
        store.query(fixedSqlConformanceStatement),
      );
      assertSqlConformance(nonArray instanceof StoreAdapterContractError, "non-array error type");
      assertSqlConformance(nonArray.violation === "invalid-sql-result", "non-array violation");
      assertSqlConformance(nonArray.writesMayRemain, "non-array write state");

      const checkCause = new Error("result check");
      controls.enqueueOutcome({
        kind: "invalid-query-result",
        shape: "result-check-failure",
        cause: checkCause,
      });
      const checkFailure = await captureSqlConformanceFailure(() =>
        store.query(fixedSqlConformanceStatement),
      );
      assertSqlConformance(
        checkFailure instanceof StoreAdapterContractError,
        "result-check error type",
      );
      assertSqlConformance(checkFailure.cause === checkCause, "result-check cause");

      controls.enqueueOutcome({ kind: "multiple-results" });
      const multiple = await captureSqlConformanceFailure(() =>
        store.query(fixedSqlConformanceStatement),
      );
      assertSqlConformance(multiple instanceof SqlExecutionError, "multiple-result error type");
      assertSqlConformance(multiple.reason === "multiple-results", "multiple-result reason");
    }),
    scenario("keeps SQL text and parameter values out of errors", async ({ store, controls }) => {
      const statement = sql`secret ${sql.param("sensitive")}`;
      const compileFailure = await captureSqlConformanceFailure(() =>
        store.query(sql.param({}) as SqlStatement<SqlParameterValue>),
      );
      assertSafeSqlError(compileFailure);
      controls.enqueueOutcome({
        kind: "failure",
        stage: "statement-call",
        cause: new Error("driver failure"),
      });
      const executionFailure = await captureSqlConformanceFailure(() => store.execute(statement));
      assertSafeSqlError(executionFailure);
      assertSqlConformance(
        !executionFailure.message.includes("secret") &&
          !executionFailure.message.includes("sensitive"),
        "error message contains SQL data",
      );
    }),
  ]);
}

/** Build the reusable mixed SQL and Collection transaction scenarios. */
export function createSqlTransactionStoreConformanceSuite<DriverParameter, DriverResult>(
  adapter: SqlTransactionStoreConformanceAdapter<DriverParameter, DriverResult>,
): readonly SqlConformanceScenario[] {
  const scenario = (
    name: string,
    run: (
      fixture: SqlTransactionStoreConformanceFixture<DriverParameter, DriverResult>,
    ) => Promise<void>,
  ): SqlConformanceScenario => ({
    name: `${adapter.profile.adapter}: ${name}`,
    run: async () => run(await adapter.makeFixture()),
  });
  const one = Object.freeze({ id: "one", label: "First", rank: 1 });
  const two = Object.freeze({ id: "two", label: "Second", rank: 2 });

  return Object.freeze([
    scenario(
      "commits mixed SQL and Collection writes",
      async ({ store, statements, transactionControls }) => {
        let callbackCount = 0;
        await store.transaction(async (transaction) => {
          callbackCount += 1;
          await transaction.execute(statements.insertJob(one));
          const inserted = await transaction.collections.jobs.find();
          assertSqlConformance(
            inserted.length === 1 && inserted[0]?.id === "one",
            "SQL insert visibility",
          );
          await transaction.collections.jobs.create(two);
          await transaction.execute(statements.deleteJob("one"));
        });
        const jobs = await store.collections.jobs.find();
        assertSqlConformance(jobs.length === 1 && jobs[0]?.id === "two", "committed mixed state");
        assertSqlConformance(callbackCount === 1, "transaction callback count");
        assertSqlConformance(transactionControls.beginCount === 1, "physical begin count");
        assertSqlConformance(transactionControls.commitCount === 1, "physical commit count");
        assertSqlConformance(transactionControls.rollbackCount === 0, "unexpected rollback");
      },
    ),
    scenario(
      "rolls back mixed SQL and Collection writes",
      async ({ store, statements, transactionControls }) => {
        const callbackFailure = new Error("mixed rollback");
        const failure = await captureSqlConformanceFailure(() =>
          store.transaction(async (transaction) => {
            await transaction.execute(statements.insertJob(one));
            await transaction.collections.jobs.create(two);
            throw callbackFailure;
          }),
        );
        assertSqlConformance(failure === callbackFailure, "callback failure identity");
        assertSqlConformance((await store.collections.jobs.find()).length === 0, "rollback state");
        assertSqlConformance(transactionControls.beginCount === 1, "rollback begin count");
        assertSqlConformance(transactionControls.commitCount === 0, "rollback commit count");
        assertSqlConformance(transactionControls.rollbackCount === 1, "rollback count");
      },
    ),
    scenario("omits nested transactions from the View", async ({ store }) => {
      await store.transaction(async (transaction) => {
        assertSqlConformance(!("transaction" in transaction), "nested transaction method");
      });
    }),
    scenario("closes SQL and Collection View methods", async ({ store }) => {
      let closedSqlOperation: (() => Promise<unknown>) | undefined;
      let closedCollectionOperation: (() => Promise<unknown>) | undefined;
      await store.transaction(async (transaction) => {
        closedSqlOperation = () => transaction.query(sql.raw("SELECT closed"));
        closedCollectionOperation = () => transaction.collections.jobs.find();
      });
      assertSqlConformance(closedSqlOperation !== undefined, "captured SQL method");
      assertSqlConformance(closedCollectionOperation !== undefined, "captured Collection method");
      const sqlFailure = await captureSqlConformanceFailure(closedSqlOperation);
      const collectionFailure = await captureSqlConformanceFailure(closedCollectionOperation);
      assertSqlConformance(sqlFailure instanceof TransactionClosedError, "closed SQL error");
      assertSqlConformance(
        collectionFailure instanceof TransactionClosedError,
        "closed Collection error",
      );
    }),
    scenario(
      "drains active work before rollback",
      async ({ store, statements, transactionControls }) => {
        const held = transactionControls.holdNextOperation();
        const transaction = store.transaction(async (view) => {
          void view.execute(statements.insertJob(one)).catch(() => undefined);
          await held.started;
        });
        await held.started;
        await Promise.resolve();
        const rollbackCountBeforeDrain = transactionControls.rollbackCount;
        assertSqlConformance(rollbackCountBeforeDrain === 0, "rollback began before drain");
        held.release();
        const failure = await captureSqlConformanceFailure(() => transaction);
        assertSqlConformance(
          failure instanceof TransactionUnsettledOperationError,
          "unsettled operation error",
        );
        const rollbackCountAfterDrain = transactionControls.rollbackCount;
        assertSqlConformance(rollbackCountAfterDrain === 1, "rollback after drain");
      },
    ),
    scenario(
      "preserves callback identity while active work drains",
      async ({ store, statements, transactionControls }) => {
        const held = transactionControls.holdNextOperation();
        const callbackFailure = new Error("callback identity");
        const transaction = store.transaction(async (view) => {
          void view.execute(statements.insertJob(one)).catch(() => undefined);
          await held.started;
          throw callbackFailure;
        });
        await held.started;
        await Promise.resolve();
        assertSqlConformance(transactionControls.rollbackCount === 0, "early callback rollback");
        held.release();
        const failure = await captureSqlConformanceFailure(() => transaction);
        assertSqlConformance(failure === callbackFailure, "drained callback identity");
      },
    ),
    scenario("rolls back after a caught operation failure", async ({ store, sqlControls }) => {
      const operationCause = new Error("caught operation");
      sqlControls.enqueueOutcome({
        kind: "failure",
        stage: "statement-call",
        cause: operationCause,
      });
      const failure = await captureSqlConformanceFailure(() =>
        store.transaction(async (view) => {
          try {
            await view.query(fixedSqlConformanceStatement);
          } catch {
            // The transaction runner still owns the rejected operation.
          }
        }),
      );
      assertSqlConformance(failure instanceof SqlExecutionError, "caught operation error type");
      assertSqlConformance(failure.cause === operationCause, "caught operation cause");
    }),
    scenario("reports the first failed operation in call order", async ({ store, sqlControls }) => {
      const firstCause = new Error("first operation");
      const secondCause = new Error("second operation");
      sqlControls.enqueueOutcome({ kind: "failure", stage: "statement-call", cause: firstCause });
      sqlControls.enqueueOutcome({ kind: "failure", stage: "statement-call", cause: secondCause });
      const failure = await captureSqlConformanceFailure(() =>
        store.transaction(async (view) => {
          await Promise.allSettled([
            view.query(fixedSqlConformanceStatement),
            view.execute(fixedSqlConformanceStatement),
          ]);
        }),
      );
      assertSqlConformance(failure instanceof SqlExecutionError, "first operation error type");
      assertSqlConformance(failure.cause === firstCause, "first operation cause");
    }),
    scenario(
      "gives callback failure priority over operation failure",
      async ({ store, sqlControls }) => {
        const operationCause = new Error("operation priority");
        const callbackCause = new Error("callback priority");
        sqlControls.enqueueOutcome({
          kind: "failure",
          stage: "statement-call",
          cause: operationCause,
        });
        const failure = await captureSqlConformanceFailure(() =>
          store.transaction(async (view) => {
            await view.query(fixedSqlConformanceStatement).catch(() => undefined);
            throw callbackCause;
          }),
        );
        assertSqlConformance(failure === callbackCause, "callback priority");
      },
    ),
    scenario(
      "gives unsettled work priority over completed operation failures",
      async ({ store, statements, sqlControls, transactionControls }) => {
        const operationCause = new Error("completed operation");
        sqlControls.enqueueOutcome({
          kind: "failure",
          stage: "statement-call",
          cause: operationCause,
        });
        const held = transactionControls.holdNextOperation();
        const transaction = store.transaction(async (view) => {
          await view.query(fixedSqlConformanceStatement).catch(() => undefined);
          void view.execute(statements.insertJob(one)).catch(() => undefined);
          await held.started;
        });
        await held.started;
        held.release();
        const failure = await captureSqlConformanceFailure(() => transaction);
        assertSqlConformance(
          failure instanceof TransactionUnsettledOperationError,
          "unsettled-work priority",
        );
      },
    ),
    scenario("preserves callback and rollback failures", async ({ store, transactionControls }) => {
      const callbackFailure = new Error("callback failure");
      const rollbackFailure = new Error("rollback failure");
      transactionControls.failNextRollback(rollbackFailure);
      const failure = await captureSqlConformanceFailure(() =>
        store.transaction(() => Promise.reject(callbackFailure)),
      );
      assertSqlConformance(failure instanceof TransactionRollbackError, "rollback error type");
      assertSqlConformance(
        failure.callbackFailure === callbackFailure,
        "rollback callback failure",
      );
      assertSqlConformance(
        failure.rollbackFailure === rollbackFailure,
        "rollback failure identity",
      );
    }),
    scenario(
      "allows adapters to serialize overlapping View calls",
      async ({ store, statements, transactionControls }) => {
        const held = transactionControls.holdNextOperation();
        await store.transaction(async (view) => {
          const first = view.execute(statements.insertJob(one));
          const second = view.execute(statements.insertJob(two));
          await held.started;
          held.release();
          await Promise.all([first, second]);
        });
        const jobs = await store.collections.jobs.find();
        assertSqlConformance(jobs.length === 2, "overlapping View calls");
      },
    ),
  ]);
}

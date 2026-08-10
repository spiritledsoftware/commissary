import {
  createSqlTransactionStoreConformanceSuite,
  sqlStoreConformanceRecordDefinitions,
  type HeldTransactionConformanceOperation,
  type SqlStoreConformanceDriverCall,
  type SqlStoreConformanceOutcome,
  type SqlTransactionStoreConformanceStore,
  type TransactionConformanceControls,
} from "@commissary/store/sql/conformance";
import {
  TransactionRollbackError,
  type Collection,
  type StoreCollections,
} from "@commissary/store";
import {
  createSqlStore,
  sql,
  type SqlParameterValue,
  type SqlStatement,
} from "@commissary/store/sql";
import {
  runTransactionCallback,
  type TrackTransactionOperation,
} from "@commissary/store/transaction-adapter";
import { describe, it } from "vitest";

type Job = {
  readonly id: string;
  readonly label: string;
  readonly rank: number;
};
type DriverResult = unknown;
type QueryDriverResult =
  | { readonly kind: "query"; readonly rows: readonly unknown[] }
  | { readonly kind: "multiple-results" }
  | {
      readonly kind: "invalid-query-result";
      readonly shape: "non-array" | "result-check-failure";
      readonly cause?: unknown;
    };

function isPortableParameter(value: unknown): value is SqlParameterValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function makeCombinedFixture() {
  let jobs: Job[] = [];
  const outcomes: SqlStoreConformanceOutcome<DriverResult>[] = [];
  const driverCalls: SqlStoreConformanceDriverCall<SqlParameterValue>[] = [];
  const affectedRows = new Map<DriverResult, number | undefined>();
  let beginCount = 0;
  let commitCount = 0;
  let rollbackCount = 0;
  let rollbackFailure: unknown;
  let hasRollbackFailure = false;
  let nextHold:
    | {
        readonly started: Promise<void>;
        readonly markStarted: () => void;
        readonly gate: Promise<void>;
        readonly release: () => void;
      }
    | undefined;

  const holdNextOperation = (): HeldTransactionConformanceOperation => {
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    nextHold = { started, markStarted, gate, release };
    return { started, release };
  };

  const waitForOperationControl = async (): Promise<void> => {
    const hold = nextHold;
    if (hold === undefined) {
      return;
    }
    nextHold = undefined;
    hold.markStarted();
    await hold.gate;
  };

  const makeCollections = (
    track: TrackTransactionOperation,
  ): StoreCollections<typeof sqlStoreConformanceRecordDefinitions> => {
    // SAFETY: The test Collection projects exactly the explicitly selected Job fields.
    const find = ((options?: { readonly select?: Readonly<Record<string, true>> }) =>
      track(async () => {
        await waitForOperationControl();
        if (options?.select === undefined) {
          return jobs.map((job) => ({ ...job }));
        }
        return jobs.map((job) =>
          Object.fromEntries(
            Object.keys(options.select ?? {}).map((field) => [field, Reflect.get(job, field)]),
          ),
        );
      })) as unknown as Collection<(typeof sqlStoreConformanceRecordDefinitions)["jobs"]>["find"];
    const collection: Collection<(typeof sqlStoreConformanceRecordDefinitions)["jobs"]> = {
      find,
      create: (input) =>
        track(async () => {
          await waitForOperationControl();
          const job = { ...input };
          jobs.push(job);
          return job;
        }),
      update: () =>
        track(async () => {
          await waitForOperationControl();
          return 0;
        }),
      delete: () =>
        track(async () => {
          await waitForOperationControl();
          return 0;
        }),
      count: () =>
        track(async () => {
          await waitForOperationControl();
          return jobs.length;
        }),
    };
    return Object.freeze({ jobs: collection });
  };

  const makeSqlCapabilities = (track: TrackTransactionOperation) => {
    const collections = makeCollections(track);
    const store = createSqlStore({
      collections,
      compiler: {
        quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
        makePlaceholder: () => "?",
        isParameter: isPortableParameter,
        convertParameter: (value) => value,
      },
      prepareQuery: (compiled) => {
        const outcome = outcomes.shift();
        if (outcome?.kind === "failure" && outcome.stage === "before-statement-call") {
          throw outcome.cause;
        }
        return async () => {
          await waitForOperationControl();
          driverCalls.push({
            operation: "query",
            text: compiled.text,
            parameters: compiled.parameters,
            segments: compiled.segments,
          });
          if (outcome?.kind === "failure") {
            throw outcome.cause;
          }
          if (outcome?.kind === "query") {
            return { kind: "query", rows: outcome.rows } as const;
          }
          if (outcome?.kind === "multiple-results") {
            return { kind: "multiple-results" } as const;
          }
          if (outcome?.kind === "invalid-query-result") {
            return outcome;
          }
          return { kind: "query", rows: [] } as const;
        };
      },
      prepareExecute: (compiled) => {
        const outcome = outcomes.shift();
        if (outcome?.kind === "failure" && outcome.stage === "before-statement-call") {
          throw outcome.cause;
        }
        return async () => {
          await waitForOperationControl();
          driverCalls.push({
            operation: "execute",
            text: compiled.text,
            parameters: compiled.parameters,
            segments: compiled.segments,
          });
          if (outcome?.kind === "failure") {
            throw outcome.cause;
          }
          if (outcome?.kind === "command") {
            affectedRows.set(outcome.driverResult, outcome.affectedRows);
            return outcome.driverResult;
          }

          let count = 0;
          if (compiled.text === "INSERT_JOB ?, ?, ?") {
            const [id, label, rank] = compiled.parameters;
            if (typeof id === "string" && typeof label === "string" && typeof rank === "number") {
              jobs.push({ id, label, rank });
              count = 1;
            }
          } else if (compiled.text === "DELETE_JOB ?") {
            const [id] = compiled.parameters;
            const before = jobs.length;
            jobs = jobs.filter((job) => job.id !== id);
            count = before - jobs.length;
          }
          const driverResult = Object.freeze({ command: compiled.text, count });
          affectedRows.set(driverResult, count);
          return driverResult;
        };
      },
      readQueryOutcome: (result: QueryDriverResult) => {
        if (result.kind === "query") {
          return { kind: "rows", rows: result.rows };
        }
        if (result.kind === "multiple-results") {
          return result;
        }
        if (result.shape === "result-check-failure") {
          throw result.cause;
        }
        return { kind: "rows", rows: {} };
      },
      readAffectedRows: (result) => affectedRows.get(result),
    });

    return Object.freeze({
      collections,
      query: <Row = unknown>(statement: SqlStatement<SqlParameterValue>) =>
        track(() => store.query<Row>(statement)),
      execute: (statement: SqlStatement<SqlParameterValue>) =>
        track(() => store.execute(statement)),
    });
  };

  const runDirect: TrackTransactionOperation = (start) => Promise.resolve().then(start);
  const rootCapabilities = makeSqlCapabilities(runDirect);
  const transaction = <Value>(
    use: (view: ReturnType<typeof makeSqlCapabilities>) => Promise<Value>,
  ): Promise<Value> =>
    Promise.resolve().then(async () => {
      beginCount += 1;
      const snapshot = jobs.map((job) => ({ ...job }));
      try {
        const value = await runTransactionCallback(makeSqlCapabilities, use);
        commitCount += 1;
        return value;
      } catch (callbackFailure) {
        rollbackCount += 1;
        if (hasRollbackFailure) {
          hasRollbackFailure = false;
          throw new TransactionRollbackError({ callbackFailure, rollbackFailure });
        }
        jobs = snapshot;
        throw callbackFailure;
      }
    });

  // SAFETY: The root contains the fixed catalog, SQL capabilities, and the one matching View callback.
  const store = Object.freeze({
    ...rootCapabilities,
    transaction,
  }) as SqlTransactionStoreConformanceStore<DriverResult>;

  const transactionControls: TransactionConformanceControls = {
    get beginCount() {
      return beginCount;
    },
    get commitCount() {
      return commitCount;
    },
    get rollbackCount() {
      return rollbackCount;
    },
    holdNextOperation,
    failNextRollback: (cause) => {
      rollbackFailure = cause;
      hasRollbackFailure = true;
    },
  };

  return {
    store,
    sqlControls: {
      driverCalls,
      enqueueOutcome: (outcome: SqlStoreConformanceOutcome<DriverResult>) => {
        outcomes.push(outcome);
      },
    },
    transactionControls,
    statements: {
      insertJob: (job: Job) => sqlStatement("INSERT_JOB ", [job.id, job.label, job.rank]),
      deleteJob: (id: string) => sqlStatement("DELETE_JOB ", [id]),
    },
  };
}

function sqlStatement(
  prefix: string,
  parameters: readonly SqlParameterValue[],
): SqlStatement<SqlParameterValue> {
  const parts: SqlStatement<SqlParameterValue>[] = [
    // The raw prefix is fixed by this test adapter, not supplied by a caller.
    sql.raw(prefix),
  ];
  parameters.forEach((parameter, position) => {
    if (position > 0) {
      parts.push(sql.raw(", "));
    }
    parts.push(sql.param(parameter));
  });
  return sql.join(parts);
}

describe("combined SQL and Collection transaction conformance", () => {
  const adapter = {
    profile: {
      adapter: "shared transaction callback runner",
      expectedCompilation: {
        text: "SELECT ?",
        parameters: ["conformance"],
        segments: ["SELECT ", ""],
      },
    },
    makeFixture: makeCombinedFixture,
  } as const;

  for (const scenario of createSqlTransactionStoreConformanceSuite(adapter)) {
    it(scenario.name, scenario.run);
  }
});

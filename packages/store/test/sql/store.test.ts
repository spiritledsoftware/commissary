import {
  createSqlStatementConformanceSuite,
  createSqlStoreConformanceSuite,
  sqlStoreConformanceRecordDefinitions,
  type SqlStoreConformanceDriverCall,
  type SqlStoreConformanceOutcome,
} from "@commissary/store/sql/conformance";
import {
  StoreAdapterContractError,
  type BaseStoreOperatorTypes,
  type Collection,
  type CreateInput,
  type StoreCollections,
  type TransactionStore,
} from "@commissary/store";
import { createSqlStore, sql, type SqlParameterValue } from "@commissary/store/sql";
import { describe, expect, expectTypeOf, it } from "vitest";

type DriverResult = unknown;
type QueryDriverResult =
  | { readonly kind: "query"; readonly rows: readonly unknown[] }
  | { readonly kind: "multiple-results" }
  | {
      readonly kind: "invalid-query-result";
      readonly shape: "non-array" | "result-check-failure";
      readonly cause?: unknown;
    };

const jobsCollection: Collection<(typeof sqlStoreConformanceRecordDefinitions)["jobs"]> = {
  find: () => Promise.resolve([]),
  create: (input) => Promise.resolve(input),
  update: () => Promise.resolve(0),
  delete: () => Promise.resolve(0),
  count: () => Promise.resolve(0),
};

const collections = Object.freeze({
  jobs: jobsCollection,
}) satisfies StoreCollections<typeof sqlStoreConformanceRecordDefinitions>;

function isPortableParameter(value: unknown): value is SqlParameterValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function makeSqlStoreFixture(
  options: {
    readonly readAffectedRows?: (result: DriverResult) => unknown;
  } = {},
) {
  const outcomes: SqlStoreConformanceOutcome<DriverResult>[] = [];
  const driverCalls: SqlStoreConformanceDriverCall<SqlParameterValue>[] = [];
  const affectedRows = new Map<DriverResult, number | undefined>();

  const takeOutcome = (): SqlStoreConformanceOutcome<DriverResult> | undefined => outcomes.shift();
  const store = createSqlStore({
    collections,
    compiler: {
      quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
      makePlaceholder: () => "?",
      isParameter: isPortableParameter,
      convertParameter: (value) => value,
    },
    prepareQuery: (compiled) => {
      const outcome = takeOutcome();
      if (outcome?.kind === "failure" && outcome.stage === "before-statement-call") {
        throw outcome.cause;
      }
      return () => {
        driverCalls.push({
          operation: "query",
          text: compiled.text,
          parameters: compiled.parameters,
          segments: compiled.segments,
        });
        if (outcome?.kind === "failure") {
          return Promise.reject(outcome.cause);
        }
        if (outcome?.kind === "query") {
          return Promise.resolve({ kind: "query", rows: outcome.rows } as const);
        }
        if (outcome?.kind === "multiple-results") {
          return Promise.resolve({ kind: "multiple-results" } as const);
        }
        if (outcome?.kind === "invalid-query-result") {
          return Promise.resolve(outcome);
        }
        return Promise.resolve({ kind: "query", rows: [] } as const);
      };
    },
    prepareExecute: (compiled) => {
      const outcome = takeOutcome();
      if (outcome?.kind === "failure" && outcome.stage === "before-statement-call") {
        throw outcome.cause;
      }
      return () => {
        driverCalls.push({
          operation: "execute",
          text: compiled.text,
          parameters: compiled.parameters,
          segments: compiled.segments,
        });
        if (outcome?.kind === "failure") {
          return Promise.reject(outcome.cause);
        }
        const driverResult =
          outcome?.kind === "command" ? outcome.driverResult : Object.freeze({ kind: "command" });
        affectedRows.set(
          driverResult,
          outcome?.kind === "command" ? outcome.affectedRows : undefined,
        );
        return Promise.resolve(driverResult);
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
    readAffectedRows: options.readAffectedRows ?? ((result) => affectedRows.get(result)),
  });

  return {
    store,
    controls: {
      driverCalls,
      enqueueOutcome: (outcome: SqlStoreConformanceOutcome<DriverResult>) => {
        outcomes.push(outcome);
      },
    },
  };
}

describe("SQL Statement conformance", () => {
  for (const scenario of createSqlStatementConformanceSuite()) {
    it(scenario.name, scenario.run);
  }
});

describe("SQL Store conformance", () => {
  const adapter = {
    profile: {
      adapter: "shared SQL Store runtime",
      expectedCompilation: {
        text: "SELECT ?",
        parameters: ["conformance"],
        segments: ["SELECT ", ""],
      },
    },
    makeFixture: makeSqlStoreFixture,
  } as const;

  for (const scenario of createSqlStoreConformanceSuite(adapter)) {
    it(scenario.name, scenario.run);
  }

  it("keeps caller-selected query row types unchecked", () => {
    const store = makeSqlStoreFixture().store;
    expectTypeOf(store.query<{ readonly arbitrary: Date }>).returns.toEqualTypeOf<
      Promise<readonly { readonly arbitrary: Date }[]>
    >();
  });

  it("rejects invalid affected-row metadata after the driver call", async () => {
    const fixture = makeSqlStoreFixture();
    fixture.controls.enqueueOutcome({
      kind: "command",
      affectedRows: -1,
      driverResult: Object.freeze({ invalid: "affected rows" }),
    });

    await expect(fixture.store.execute(sql.raw("UPDATE jobs"))).rejects.toMatchObject({
      operation: "execute",
      violation: "invalid-sql-result",
      writesMayRemain: true,
    } satisfies Partial<StoreAdapterContractError>);
  });

  it("omits returned driver data from result-check error causes", async () => {
    const queryFixture = makeSqlStoreFixture();
    const returnedQueryData: {
      readonly kind: "invalid-query-result";
      readonly shape: "result-check-failure";
      cause?: unknown;
    } = {
      kind: "invalid-query-result",
      shape: "result-check-failure",
    };
    returnedQueryData.cause = returnedQueryData;
    queryFixture.controls.enqueueOutcome(returnedQueryData);

    let queryFailure: unknown;
    try {
      await queryFixture.store.query(sql.raw("SELECT sensitive"));
    } catch (cause) {
      queryFailure = cause;
    }
    expect(queryFailure).toBeInstanceOf(StoreAdapterContractError);
    expect(queryFailure).not.toHaveProperty("cause");

    const commandFixture = makeSqlStoreFixture({
      readAffectedRows: (result) => {
        throw result;
      },
    });
    const returnedCommandData = Object.freeze({ sensitive: "command result" });
    commandFixture.controls.enqueueOutcome({
      kind: "command",
      affectedRows: undefined,
      driverResult: returnedCommandData,
    });

    let commandFailure: unknown;
    try {
      await commandFixture.store.execute(sql.raw("UPDATE sensitive"));
    } catch (cause) {
      commandFailure = cause;
    }
    expect(commandFailure).toBeInstanceOf(StoreAdapterContractError);
    expect(commandFailure).not.toHaveProperty("cause");
  });

  it("preserves custom create inputs on the Store and Transaction View", () => {
    type CustomCreateInputs = {
      readonly jobs: {
        readonly source: string;
        readonly payload: Uint8Array;
      };
    };
    type CustomTransactionStore = TransactionStore<
      typeof sqlStoreConformanceRecordDefinitions,
      BaseStoreOperatorTypes,
      {},
      CustomCreateInputs
    >;
    type CustomTransactionView = Parameters<
      Parameters<CustomTransactionStore["transaction"]>[0]
    >[0];

    expectTypeOf<
      Parameters<CustomTransactionStore["collections"]["jobs"]["create"]>[0]
    >().toEqualTypeOf<CustomCreateInputs["jobs"]>();
    expectTypeOf<
      Parameters<CustomTransactionView["collections"]["jobs"]["create"]>[0]
    >().toEqualTypeOf<CustomCreateInputs["jobs"]>();

    type DefaultTransactionStore = TransactionStore<typeof sqlStoreConformanceRecordDefinitions>;
    type DefaultTransactionView = Parameters<
      Parameters<DefaultTransactionStore["transaction"]>[0]
    >[0];
    type DefaultJobsCreateInput = CreateInput<
      (typeof sqlStoreConformanceRecordDefinitions)["jobs"]
    >;
    expectTypeOf<
      Parameters<DefaultTransactionStore["collections"]["jobs"]["create"]>[0]
    >().toEqualTypeOf<DefaultJobsCreateInput>();
    expectTypeOf<
      Parameters<DefaultTransactionView["collections"]["jobs"]["create"]>[0]
    >().toEqualTypeOf<DefaultJobsCreateInput>();
  });
});

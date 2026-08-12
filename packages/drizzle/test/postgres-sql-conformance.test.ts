import { createSqlStore, sql, type SqlParameterValue } from "@commissary/store/sql";
import {
  createSqlStoreConformanceSuite,
  sqlStoreConformanceRecordDefinitions,
  type SqlStoreConformanceDriverCall,
  type SqlStoreConformanceOutcome,
} from "@commissary/store/sql/conformance";
import {
  StoreAdapterContractError,
  type Collection,
  type StoreCollections,
} from "@commissary/store";
import { expect, test } from "vitest";

import {
  postgresAffectedRows,
  postgresDrizzleSql,
  postgresQueryOutcome,
  postgresSqlCompiler,
} from "../src/postgres-sql.js";

type DriverResult = unknown;

type SqlConformanceJobsDefinition = (typeof sqlStoreConformanceRecordDefinitions)["jobs"];

const emptyJobsCollection: Collection<SqlConformanceJobsDefinition> = Object.freeze({
  find: () => Promise.resolve([]),
  create: (input: Parameters<Collection<SqlConformanceJobsDefinition>["create"]>[0]) =>
    Promise.resolve(input),
  update: () => Promise.resolve(0),
  delete: () => Promise.resolve(0),
  count: () => Promise.resolve(0),
});

const emptyCollections: StoreCollections<typeof sqlStoreConformanceRecordDefinitions> =
  Object.freeze({ jobs: emptyJobsCollection });

function makePostgresSqlConformanceFixture() {
  const outcomes: SqlStoreConformanceOutcome<DriverResult>[] = [];
  const driverCalls: SqlStoreConformanceDriverCall<SqlParameterValue>[] = [];
  const affectedRows = new Map<DriverResult, number | undefined>();
  const takeOutcome = () => outcomes.shift();
  const store = createSqlStore({
    collections: emptyCollections,
    compiler: postgresSqlCompiler,
    prepareQuery: (compiled) => {
      const outcome = takeOutcome();
      if (outcome?.kind === "failure" && outcome.stage === "before-statement-call") {
        throw outcome.cause;
      }
      const statement = postgresDrizzleSql(compiled);
      return () => {
        driverCalls.push({
          operation: "query",
          text: compiled.text,
          parameters: compiled.parameters,
          segments: compiled.segments,
        });
        void statement;
        if (outcome?.kind === "failure") return Promise.reject(outcome.cause);
        if (outcome?.kind === "query") return Promise.resolve(outcome.rows);
        if (outcome?.kind === "multiple-results") return Promise.resolve({ rows: {} });
        if (outcome?.kind === "invalid-query-result") {
          if (outcome.shape === "result-check-failure") {
            return Promise.resolve(
              Object.defineProperty({}, "rows", {
                get() {
                  throw outcome.cause;
                },
              }),
            );
          }
          return Promise.resolve({ rows: {} });
        }
        return Promise.resolve([]);
      };
    },
    prepareExecute: (compiled) => {
      const outcome = takeOutcome();
      if (outcome?.kind === "failure" && outcome.stage === "before-statement-call") {
        throw outcome.cause;
      }
      const statement = postgresDrizzleSql(compiled);
      return () => {
        driverCalls.push({
          operation: "execute",
          text: compiled.text,
          parameters: compiled.parameters,
          segments: compiled.segments,
        });
        void statement;
        if (outcome?.kind === "failure") return Promise.reject(outcome.cause);
        if (outcome?.kind === "command") {
          affectedRows.set(outcome.driverResult, outcome.affectedRows);
          return Promise.resolve(outcome.driverResult);
        }
        return Promise.resolve({ rows: [] });
      };
    },
    readQueryOutcome: postgresQueryOutcome,
    readAffectedRows: (result) =>
      affectedRows.has(result) ? affectedRows.get(result) : postgresAffectedRows(result),
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

for (const scenario of createSqlStoreConformanceSuite({
  profile: {
    adapter: "Drizzle PostgreSQL",
    expectedCompilation: {
      text: "SELECT $1",
      parameters: ["conformance"],
      segments: ["SELECT ", ""],
    },
  },
  makeFixture: makePostgresSqlConformanceFixture,
})) {
  // Common PgDatabase.execute returns one result container, so it has no public multiple-result
  // discriminator for the shared suite's synthetic multiple-results outcome.
  if (scenario.name.includes("invalid and multiple query results")) continue;
  test(`SQL Store conformance: ${scenario.name}`, scenario.run);
}

test("keeps raw placeholder-like PostgreSQL text separate from ordered parameters", async () => {
  const fixture = makePostgresSqlConformanceFixture();
  fixture.controls.enqueueOutcome({ kind: "query", rows: [] });

  await fixture.store.query(sql`SELECT '$1 ? :name', ${1}, ${"two"}`);

  expect(fixture.controls.driverCalls[0]).toMatchObject({
    text: "SELECT '$1 ? :name', $1, $2",
    parameters: [1, "two"],
    segments: ["SELECT '$1 ? :name', ", ", ", ""],
  });
});

test("rejects a successful PostgreSQL result without a row array", async () => {
  const fixture = makePostgresSqlConformanceFixture();
  fixture.controls.enqueueOutcome({ kind: "invalid-query-result", shape: "non-array" });

  const failure = await fixture.store
    .query(sql.raw("SELECT malformed"))
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(StoreAdapterContractError);
  expect(failure).toMatchObject({
    operation: "query",
    violation: "invalid-sql-result",
    writesMayRemain: true,
  });
});

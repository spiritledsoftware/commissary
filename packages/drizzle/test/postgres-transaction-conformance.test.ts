import { PGlite } from "@electric-sql/pglite";
import type { SqlParameterValue } from "@commissary/store/sql";
import { sql } from "@commissary/store/sql";
import {
  createSqlTransactionStoreConformanceSuite,
  sqlStoreConformanceRecordDefinitions,
  type HeldTransactionConformanceOperation,
  type SqlStoreConformanceOutcome,
  type SqlTransactionStoreConformanceFixture,
} from "@commissary/store/sql/conformance";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, test } from "vitest";

import { DrizzlePostgresStore, bindPostgresStore } from "../src/postgres.js";

const definition = DrizzlePostgresStore.define({
  records: sqlStoreConformanceRecordDefinitions,
});

const openClients: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

interface MutableTransactionCounts {
  begin: number;
  commit: number;
  rollback: number;
}

interface HeldOperationState extends HeldTransactionConformanceOperation {
  readonly start: () => void;
  readonly waitForRelease: Promise<void>;
}

function createHeldOperation(): HeldOperationState {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, start, release, waitForRelease };
}

async function makePostgresTransactionConformanceFixture(): Promise<
  SqlTransactionStoreConformanceFixture<SqlParameterValue, unknown>
> {
  const client = new PGlite();
  openClients.push(client);
  await client.exec(`
    CREATE TABLE commissary_conformance_jobs (
      id text PRIMARY KEY,
      label text NOT NULL,
      rank double precision NOT NULL
    )
  `);
  const database = drizzle(client, { schema: definition.schema });
  const counts: MutableTransactionCounts = { begin: 0, commit: 0, rollback: 0 };
  const outcomes: SqlStoreConformanceOutcome<unknown>[] = [];
  let active = false;
  let heldOperation: HeldOperationState | undefined;
  let rollbackFailure: unknown;
  let hasRollbackFailure = false;

  const wrapExecute = (target: object): void => {
    const execute = Reflect.get(target, "execute");
    if (typeof execute !== "function") throw new TypeError("Expected PostgreSQL execute method");
    Object.defineProperty(target, "execute", {
      configurable: true,
      value: (query: unknown) =>
        Promise.resolve().then(async () => {
          const held = heldOperation;
          if (held !== undefined) {
            heldOperation = undefined;
            held.start();
            await held.waitForRelease;
          }
          const outcome = outcomes.shift();
          if (outcome?.kind === "failure") throw outcome.cause;
          return await Reflect.apply(execute, target, [query]);
        }),
    });
  };

  const transaction = database.transaction.bind(database);
  const instrumentedTransaction: typeof database.transaction = async (use, config) => {
    if (!active) return await transaction(use, config);
    counts.begin += 1;
    try {
      const value = await transaction(async (view) => {
        wrapExecute(view);
        return use(view);
      }, config);
      counts.commit += 1;
      return value;
    } catch (cause) {
      counts.rollback += 1;
      if (hasRollbackFailure) {
        hasRollbackFailure = false;
        throw rollbackFailure;
      }
      throw cause;
    }
  };
  Object.defineProperty(database, "transaction", {
    configurable: true,
    value: instrumentedTransaction,
  });

  const bound = await bindPostgresStore({ definition, database, transaction: true });
  active = true;
  wrapExecute(database);

  // SAFETY: The definition is the shared conformance catalog and literal transaction binding adds matching SQL capabilities.
  const store = bound as unknown as SqlTransactionStoreConformanceFixture<
    SqlParameterValue,
    unknown
  >["store"];
  return {
    store,
    sqlControls: {
      driverCalls: [],
      enqueueOutcome: (outcome) => {
        outcomes.push(outcome);
      },
    },
    transactionControls: {
      get beginCount() {
        return counts.begin;
      },
      get commitCount() {
        return counts.commit;
      },
      get rollbackCount() {
        return counts.rollback;
      },
      holdNextOperation: () => {
        const held = createHeldOperation();
        heldOperation = held;
        return held;
      },
      failNextRollback: (cause) => {
        rollbackFailure = cause;
        hasRollbackFailure = true;
      },
    },
    statements: {
      insertJob: (job) =>
        sql`INSERT INTO commissary_conformance_jobs (id, label, rank) VALUES (${job.id}, ${job.label}, ${job.rank})`,
      deleteJob: (id) => sql`DELETE FROM commissary_conformance_jobs WHERE id = ${id}`,
    },
  };
}

for (const scenario of createSqlTransactionStoreConformanceSuite({
  profile: {
    adapter: "Drizzle PostgreSQL",
    expectedCompilation: {
      text: "SELECT $1",
      parameters: ["conformance"],
      segments: ["SELECT ", ""],
    },
  },
  makeFixture: makePostgresTransactionConformanceFixture,
})) {
  test(`SQL transaction conformance: ${scenario.name}`, scenario.run, 15_000);
}

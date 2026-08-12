import type { FieldSchema } from "@commissary/store";
import {
  StoreAdapterError,
  TransactionConflictError,
  TransactionRollbackError,
} from "@commissary/store";
import { SqlRecord, sql } from "@commissary/store/sql";
import { expect, test } from "vitest";

import { DrizzlePostgresStore, bindPostgresStore } from "../src/postgres.js";
import { createTestPostgresDatabase } from "./postgres-test-database.js";

const stringField: FieldSchema<string, string> = {
  "~standard": {
    version: 1,
    vendor: "commissary-test",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] },
  },
};

const definition = DrizzlePostgresStore.define({
  records: {
    job: SqlRecord.define({
      table: sql.table({ name: "jobs", primaryKey: ["id"] }),
      fields: {
        id: {
          select: stringField,
          column: sql.column({ type: sql.text(), notNull: true }),
        },
      },
    }),
  },
});

test.each(["40001", "40P01"])(
  "maps PostgreSQL SQLSTATE %s to a transaction conflict",
  async (code) => {
    const conflict = Object.assign(new Error("transaction conflict"), { code });
    const controls = createTestPostgresDatabase({
      script: (call) => {
        if (call.transaction && call.sql === "SELECT conflict") throw conflict;
        return { rows: [] };
      },
    });
    const store = await bindPostgresStore({
      definition,
      database: controls.database,
      transaction: true,
    });

    const failure = await store
      .transaction((transaction) => transaction.query(sql.raw("SELECT conflict")))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransactionConflictError);
    expect(failure).toMatchObject({ writesMayRemain: false });
    if (!(failure instanceof TransactionConflictError)) {
      throw new TypeError("Expected a transaction conflict");
    }
    expect(failure.cause).toMatchObject({ cause: conflict });
  },
);

test("finds a PostgreSQL conflict behind a non-SQLSTATE wrapper code", async () => {
  const conflict = Object.assign(new Error("serialization conflict"), { code: "40001" });
  const wrapper = Object.assign(new Error("connection wrapper", { cause: conflict }), {
    code: "ECONNRESET",
  });
  const controls = createTestPostgresDatabase({
    script: (call) => {
      if (call.transaction && call.sql === "SELECT wrapped_conflict") throw wrapper;
      return { rows: [] };
    },
  });
  const store = await bindPostgresStore({
    definition,
    database: controls.database,
    transaction: true,
  });

  const failure = await store
    .transaction((transaction) => transaction.query(sql.raw("SELECT wrapped_conflict")))
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(TransactionConflictError);
  if (!(failure instanceof TransactionConflictError)) {
    throw new TypeError("Expected a transaction conflict");
  }
  expect(failure.cause).toMatchObject({ cause: wrapper });
});

test("reports a distinct rollback failure after a callback failure", async () => {
  const callbackFailure = Object.freeze({ type: "callback-failure" });
  const rollbackFailure = new Error("rollback failure");
  const controls = createTestPostgresDatabase();
  const originalTransaction = controls.database.transaction.bind(controls.database);
  Object.defineProperty(controls.database, "transaction", {
    value: async (...arguments_: Parameters<typeof originalTransaction>) => {
      try {
        return await originalTransaction(...arguments_);
      } catch {
        throw rollbackFailure;
      }
    },
  });
  const store = await bindPostgresStore({
    definition,
    database: controls.database,
    transaction: true,
  });

  const failure = await store
    .transaction(async () => {
      throw callbackFailure;
    })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(TransactionRollbackError);
  expect(failure).toMatchObject({ callbackFailure, rollbackFailure, writesMayRemain: true });
});

test("keeps non-conflict transaction infrastructure failures as Store adapter failures", async () => {
  const cause = new Error("commit unavailable");
  const controls = createTestPostgresDatabase();
  const originalTransaction = controls.database.transaction.bind(controls.database);
  let calls = 0;
  Object.defineProperty(controls.database, "transaction", {
    value: async (...arguments_: Parameters<typeof originalTransaction>) => {
      calls += 1;
      if (calls === 1) return await originalTransaction(...arguments_);
      await originalTransaction(...arguments_);
      throw cause;
    },
  });
  const store = await bindPostgresStore({
    definition,
    database: controls.database,
    transaction: true,
  });

  const failure = await store.transaction(async () => undefined).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(StoreAdapterError);
  expect(failure).toMatchObject({ cause, operation: "transaction" });
});

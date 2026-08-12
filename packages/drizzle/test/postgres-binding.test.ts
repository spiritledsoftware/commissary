import { SqlRecord, sql } from "@commissary/store/sql";
import type { FieldSchema } from "@commissary/store";
import { expect, test } from "vitest";

import {
  DrizzlePostgresBindingError,
  DrizzlePostgresStore,
  bindPostgresStore,
} from "../src/postgres.js";
import { createTestPostgresDatabase } from "./postgres-test-database.js";

const requiredString: FieldSchema<string, string> = {
  "~standard": {
    version: 1,
    vendor: "commissary-test",
    validate(value: unknown) {
      return typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] };
    },
  },
};

const jobRecord = SqlRecord.define({
  table: sql.table({ name: "jobs", primaryKey: ["id"] }),
  fields: {
    id: { select: requiredString, column: sql.column({ type: sql.text(), notNull: true }) },
    status: { select: requiredString, column: sql.column({ type: sql.text(), notNull: true }) },
  },
});

const definition = DrizzlePostgresStore.define({ records: { job: jobRecord } });

test("binds PostgreSQL 15 without probing transactions", async () => {
  const controls = createTestPostgresDatabase();
  const store = await bindPostgresStore({ definition, database: controls.database });

  expect("transaction" in store).toBe(false);
  expect(controls.transactionConfigs).toHaveLength(0);
  expect(controls.calls.map((call) => call.sql)).toEqual(["SHOW server_version_num"]);
});

test("rejects old PostgreSQL versions with the normalized version", async () => {
  const controls = createTestPostgresDatabase({ version: 149_999 });
  const failure = await bindPostgresStore({
    definition,
    database: controls.database,
  }).catch((error: unknown) => error);

  expect(failure).toMatchObject({
    name: "DrizzlePostgresBindingError",
    reason: "unsupported-postgres-version",
    version: 149_999,
  });
});

test.each([
  {
    name: "a failed version probe",
    controls: () => createTestPostgresDatabase({ versionFailure: new Error("probe failed") }),
    reason: "probe-failed",
  },
  {
    name: "a malformed version result",
    controls: () => createTestPostgresDatabase({ versionResult: { rows: [] } }),
    reason: "invalid-version-result",
  },
] as const)("rejects $name", async ({ controls: makeControls, reason }) => {
  const controls = makeControls();

  await expect(
    bindPostgresStore({ definition, database: controls.database }),
  ).rejects.toMatchObject({
    name: "DrizzlePostgresBindingError",
    reason,
  });
});

test("returns a native Promise before rejecting an invalid database", async () => {
  const binding = bindPostgresStore({
    definition,
    // @ts-expect-error Runtime validation rejects counterfeit PostgreSQL database values.
    database: {},
  });

  expect(binding).toBeInstanceOf(Promise);
  await expect(binding).rejects.toMatchObject({
    name: "DrizzlePostgresBindingError",
    reason: "invalid-database",
  });
});

test("requires effective read-only serializable transaction settings", async () => {
  const accepted = createTestPostgresDatabase();
  const store = await bindPostgresStore({
    definition,
    database: accepted.database,
    transaction: true,
  });
  expect("transaction" in store).toBe(true);
  expect(accepted.transactionConfigs[0]).toEqual({
    isolationLevel: "serializable",
    accessMode: "read only",
  });

  const ignored = createTestPostgresDatabase({ ignoreTransactionOptions: true });
  await expect(
    bindPostgresStore({ definition, database: ignored.database, transaction: true }),
  ).rejects.toMatchObject({
    name: "DrizzlePostgresBindingError",
    reason: "transaction-unavailable",
  });
});

test("rejects an inherited unsupported transaction path", async () => {
  const controls = createTestPostgresDatabase({ transactionUnavailable: true });
  await expect(
    bindPostgresStore({ definition, database: controls.database, transaction: true }),
  ).rejects.toBeInstanceOf(DrizzlePostgresBindingError);
});

test("preserves Statement segments, query rows, and exact command results", async () => {
  const queryRows = [{ id: "job-1" }];
  const commandResult = { rows: [], rowCount: 2, command: "UPDATE" };
  const controls = createTestPostgresDatabase({
    script: (call) => (call.sql.startsWith("SELECT") ? queryRows : commandResult),
  });
  const store = await bindPostgresStore({ definition, database: controls.database });
  const statement = sql`SELECT '$1 ? :name' AS raw_value, ${42} AS bound_value`;

  const rows = await store.query<{ readonly id: string }>(statement);
  const command = await store.execute(sql`UPDATE jobs SET status = ${"done"}`);

  expect(rows).toBe(queryRows);
  expect(command).toEqual({ affectedRows: 2, driverResult: commandResult });
  expect(command.driverResult).toBe(commandResult);
  expect(controls.calls.slice(1).map(({ sql: text, params }) => ({ text, params }))).toEqual([
    { text: "SELECT '$1 ? :name' AS raw_value, $1 AS bound_value", params: [42] },
    { text: "UPDATE jobs SET status = $1", params: ["done"] },
  ]);
});

test("returns the exact rows array from an object PostgreSQL result", async () => {
  const rows = [{ id: "job-1" }];
  const controls = createTestPostgresDatabase({
    script: () => ({ rows }),
  });
  const store = await bindPostgresStore({ definition, database: controls.database });

  const selected = await store.query(sql.raw("SELECT id FROM jobs"));

  expect(selected).toBe(rows);
});

test("preserves literal and runtime transaction capability inference", async () => {
  const controls = createTestPostgresDatabase();
  const base = await bindPostgresStore({ definition, database: controls.database });
  // @ts-expect-error Base binding exposes no transaction capability.
  void base.transaction;

  const transactional = await bindPostgresStore({
    definition,
    database: controls.database,
    transaction: true,
  });
  await transactional.transaction(async (transaction) => {
    const result = await transaction.execute(sql.raw("SELECT 1"));
    expect(result.driverResult.rows).toBeDefined();
  });

  const runtimeBoolean = Boolean("runtime-selected");
  const possible = await bindPostgresStore({
    definition,
    database: controls.database,
    transaction: runtimeBoolean,
  });
  // @ts-expect-error Runtime Boolean requires capability narrowing.
  void possible.transaction;
  if ("transaction" in possible) await possible.transaction(async () => undefined);
});

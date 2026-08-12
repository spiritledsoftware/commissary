import type { RecordDefinition, RecordDefinitions } from "@commissary/store";
import type { SqlLiteralValue, SqlStatement } from "@commissary/store/sql";
import type {
  SqliteRecordResolution,
  SqliteResolvedColumn,
  SqliteResolvedColumnType,
} from "@commissary/store/sql/sqlite/adapter";
import { resolveSqliteRecords } from "@commissary/store/sql/sqlite/adapter";
import { getTableColumns, is, type SQL } from "drizzle-orm";
import {
  SQLiteColumnBuilder,
  SQLiteTable,
  customType,
  getTableConfig as getSqliteTableConfig,
  integer,
  primaryKey,
  sqliteTable,
  type AnySQLiteTable,
  type SQLiteColumnBuilderBase,
} from "drizzle-orm/sqlite-core";

import {
  createDrizzleRecordReference,
  type DrizzleDefinitionDialectAdapter,
  type GeneratedDrizzleTable,
} from "./definition-runtime.js";
import {
  drizzleDefinitionSql,
  drizzleDefinitionSqlText,
  quoteSqliteIdentifier,
} from "./drizzle-sql.js";

interface RuntimeSqliteBuilder {
  notNull(): RuntimeSqliteBuilder;
  default(value: unknown): RuntimeSqliteBuilder;
  generatedAlwaysAs(
    value: SQL,
    options?: { readonly mode: "virtual" | "stored" },
  ): RuntimeSqliteBuilder;
  primaryKey(options?: { readonly autoIncrement?: boolean }): RuntimeSqliteBuilder;
}

function sqliteTypeSql(type: SqliteResolvedColumnType): string {
  if (type.kind === "custom") {
    return drizzleDefinitionSqlText(type.type, quoteSqliteIdentifier);
  }
  switch (type.type) {
    case "boolean":
    case "timestamp-seconds":
    case "timestamp-milliseconds":
      return "integer";
    case "json":
      return "text";
    case "json-blob":
    case "bigint-blob":
      return "blob";
    case "numeric-number":
      return "numeric";
    default:
      return type.type;
  }
}

function sqliteDefault(value: SqlLiteralValue | SqlStatement<never>): unknown {
  if (typeof value !== "object" || value === null) return value;
  // SAFETY: SqlStatement is the only non-null object member of the resolved default union.
  return drizzleDefinitionSql(value as SqlStatement<never>, quoteSqliteIdentifier);
}

function sqliteColumnBuilder(
  column: SqliteResolvedColumn<import("@commissary/store").FieldDefinition>,
): SQLiteColumnBuilderBase {
  let builder: RuntimeSqliteBuilder;
  if (column.rowid !== undefined) {
    builder = integer(column.name).primaryKey({
      autoIncrement: column.rowid.reuse === "forbidden",
    });
  } else {
    const typeSql = sqliteTypeSql(column.type);
    const makeCustom = customType<{ data: unknown; driverData: unknown }>({
      dataType: () => typeSql,
      // SAFETY: The resolver's erased Field generic still owns the runtime encoder for this exact column.
      toDriver: (value) => column.encode(value as never),
      fromDriver: (value) => column.decode(value),
    });
    // SAFETY: Public SQLite custom builders implement the common builder modifier methods.
    builder = makeCustom(column.name) as unknown as RuntimeSqliteBuilder;
  }
  if (column.notNull && column.rowid === undefined) builder = builder.notNull();
  if (column.default !== undefined) builder = builder.default(sqliteDefault(column.default));
  if (column.generated !== undefined) {
    builder = builder.generatedAlwaysAs(
      drizzleDefinitionSql(column.generated.expression, quoteSqliteIdentifier),
      { mode: column.generated.mode },
    );
  }
  // SAFETY: The runtime value originated from a public SQLite builder and modifiers preserve that family.
  return builder as unknown as SQLiteColumnBuilderBase;
}

function generateSqliteTable(
  recordName: string,
  definition: RecordDefinition,
  builderOverrides: Readonly<Record<string, unknown>>,
): GeneratedDrizzleTable {
  // SAFETY: This adapter erases only catalog literals; the resolver preserves every supplied Record key.
  const resolve = resolveSqliteRecords as unknown as (options: {
    readonly records: RecordDefinitions;
  }) => SqliteRecordResolution<RecordDefinitions>;
  const resolution = resolve({ records: { [recordName]: definition } });
  const table = resolution.tables[recordName];
  if (table === undefined) throw new TypeError(`SQLite Record '${recordName}' did not resolve`);
  const builders: Record<string, SQLiteColumnBuilderBase> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    const override = Reflect.get(builderOverrides, fieldName);
    builders[fieldName] = is(override, SQLiteColumnBuilder)
      ? override
      : sqliteColumnBuilder(column);
  }
  for (const [fieldName, override] of Object.entries(builderOverrides)) {
    if (!Object.hasOwn(builders, fieldName) && is(override, SQLiteColumnBuilder)) {
      builders[fieldName] = override;
    }
  }
  const hasRowidPrimaryKey = Object.values(table.columns).some(
    (column) => column.rowid !== undefined,
  );
  const finalTable = sqliteTable(table.name, builders, (columns) => {
    if (table.primaryKey.length === 0 || hasRowidPrimaryKey) return [];
    const primaryColumns = table.primaryKey.flatMap((column) => {
      const logical = Object.entries(table.columns).find(([, value]) => value === column)?.[0];
      return logical === undefined ? [] : [Reflect.get(columns, logical)];
    });
    // SAFETY: Every primary-key member was resolved from this exact table's logical column map.
    return [primaryKey({ columns: primaryColumns as never })];
  });
  return { table: finalTable };
}

/** SQLite mechanics for the shared connection-free definition lifecycle. */
export const sqliteDefinitionAdapter: DrizzleDefinitionDialectAdapter = {
  dialect: "sqlite",
  label: "SQLite",
  isTable: (value) => is(value, SQLiteTable),
  isColumnBuilder: (value) => is(value, SQLiteColumnBuilder),
  // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
  getColumns: (table) => getTableColumns(table as AnySQLiteTable),
  generateTable: generateSqliteTable,
  createRecordReference: (table) => {
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    const sqliteValue = table as AnySQLiteTable;
    const config = getSqliteTableConfig(sqliteValue);
    return createDrizzleRecordReference([config.name], getTableColumns(sqliteValue));
  },
  getPrimaryKeyFields: (table) => {
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    const sqliteValue = table as AnySQLiteTable;
    const config = getSqliteTableConfig(sqliteValue);
    const columns = getTableColumns(sqliteValue);
    const primaryColumns =
      config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
    return primaryColumns.flatMap((column) => {
      const entry = Object.entries(columns).find(([, value]) => value === column);
      return entry === undefined ? [] : [entry[0]];
    });
  },
  getTableIdentity: (table) => [
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    getSqliteTableConfig(table as AnySQLiteTable).name,
  ],
};

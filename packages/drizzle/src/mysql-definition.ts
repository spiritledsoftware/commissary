import type { RecordDefinition, RecordDefinitions } from "@commissary/store";
import type {
  MysqlRecordResolution,
  MysqlResolvedColumn,
  MysqlResolvedColumnType,
  MysqlResolvedTable,
} from "@commissary/store/sql/mysql/adapter";
import { resolveMysqlRecords } from "@commissary/store/sql/mysql/adapter";
import type { SqlLiteralValue, SqlStatement } from "@commissary/store/sql";
import { getTableColumns, is, type SQL } from "drizzle-orm";
import {
  MySqlColumnBuilder,
  MySqlTable,
  bigint,
  customType,
  getTableConfig as getMysqlTableConfig,
  int,
  mediumint,
  mysqlDatabase,
  mysqlTable,
  primaryKey,
  serial,
  smallint,
  timestamp,
  tinyint,
  type AnyMySqlTable,
  type MySqlColumnBuilderBase,
} from "drizzle-orm/mysql-core";

import { DrizzleDefinitionError, drizzleDefinitionIssue } from "./definition-contracts.js";
import {
  createDrizzleRecordReference,
  type DrizzleDefinitionDialectAdapter,
  type GeneratedDrizzleTable,
} from "./definition-runtime.js";
import {
  drizzleDefinitionSql,
  drizzleDefinitionSqlText,
  quoteMysqlIdentifier,
} from "./drizzle-sql.js";

interface RuntimeMysqlBuilder {
  notNull(): RuntimeMysqlBuilder;
  default(value: unknown): RuntimeMysqlBuilder;
  generatedAlwaysAs(
    value: SQL,
    options?: { readonly mode: "virtual" | "stored" },
  ): RuntimeMysqlBuilder;
  autoincrement(): RuntimeMysqlBuilder;
  onUpdateNow(): RuntimeMysqlBuilder;
}

function mysqlTypeSql(type: MysqlResolvedColumnType): string {
  if (type.kind === "enum") {
    return `enum(${type.values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",")})`;
  }
  if (type.kind === "custom") {
    return drizzleDefinitionSqlText(type.type, quoteMysqlIdentifier);
  }
  const options = type.options;
  switch (type.type) {
    case "tinyint":
    case "smallint":
    case "mediumint":
    case "int":
    case "bigint":
      return `${type.type}${options !== undefined && "unsigned" in options && options.unsigned ? " unsigned" : ""}`;
    case "decimal":
    case "float":
    case "double":
    case "real": {
      const precision =
        options !== undefined && "precision" in options ? options.precision : undefined;
      const scale = options !== undefined && "scale" in options ? options.scale : undefined;
      const size =
        precision === undefined
          ? ""
          : scale === undefined
            ? `(${precision})`
            : `(${precision},${scale})`;
      const unsigned =
        options !== undefined && "unsigned" in options && options.unsigned ? " unsigned" : "";
      return `${type.type}${size}${unsigned}`;
    }
    case "char":
    case "varchar":
    case "binary":
    case "varbinary":
      return options !== undefined && "length" in options && options.length !== undefined
        ? `${type.type}(${options.length})`
        : type.type;
    case "datetime":
    case "time":
    case "timestamp":
      return options !== undefined && "fsp" in options && options.fsp !== undefined
        ? `${type.type}(${options.fsp})`
        : type.type;
    default:
      return type.type;
  }
}

function mysqlDefault(value: SqlLiteralValue | SqlStatement<never>): unknown {
  if (typeof value !== "object" || value === null) return value;
  // SAFETY: SqlStatement is the only non-null object member of the resolved default union.
  return drizzleDefinitionSql(value as SqlStatement<never>, quoteMysqlIdentifier);
}

function autoIncrementMysqlBuilder(
  column: MysqlResolvedColumn<import("@commissary/store").FieldDefinition>,
): RuntimeMysqlBuilder {
  const type = column.type.kind === "direct" ? column.type.type : undefined;
  const unsigned =
    column.type.kind === "direct" &&
    column.type.options !== undefined &&
    "unsigned" in column.type.options &&
    column.type.options.unsigned === true;
  const builder =
    type === "tinyint"
      ? tinyint(column.name, { unsigned })
      : type === "smallint"
        ? smallint(column.name, { unsigned })
        : type === "mediumint"
          ? mediumint(column.name, { unsigned })
          : type === "int"
            ? int(column.name, { unsigned })
            : type === "serial"
              ? serial(column.name).$type<string>()
              : bigint(column.name, { mode: "bigint", unsigned }).$type<string>();
  // SAFETY: Every selected MySQL integer builder implements the shared modifier surface.
  return builder as unknown as RuntimeMysqlBuilder;
}

function mysqlColumnBuilder(
  column: MysqlResolvedColumn<import("@commissary/store").FieldDefinition>,
): MySqlColumnBuilderBase {
  let builder: RuntimeMysqlBuilder;
  if (column.autoIncrement !== undefined) {
    builder = autoIncrementMysqlBuilder(column);
  } else if (column.onUpdate === "current-timestamp") {
    const fsp =
      column.type.kind === "direct" &&
      column.type.options !== undefined &&
      "fsp" in column.type.options
        ? column.type.options.fsp
        : undefined;
    // SAFETY: The timestamp builder supports automatic update; later modifiers use only its shared methods.
    builder = timestamp(column.name, {
      mode: "string",
      ...(fsp === undefined ? {} : { fsp }),
    }) as unknown as RuntimeMysqlBuilder;
  } else {
    const typeSql = mysqlTypeSql(column.type);
    const makeCustom = customType<{ data: unknown; driverData: unknown }>({
      dataType: () => typeSql,
      // SAFETY: The resolver's erased Field generic still owns the runtime encoder for this exact column.
      toDriver: (value) => column.encode(value as never),
      fromDriver: (value) => column.decode(value),
    });
    // SAFETY: Public MySQL custom builders implement the common builder modifier methods.
    builder = makeCustom(column.name) as unknown as RuntimeMysqlBuilder;
  }
  if (column.notNull && column.autoIncrement === undefined) builder = builder.notNull();
  if (column.default !== undefined) builder = builder.default(mysqlDefault(column.default));
  if (column.generated !== undefined) {
    builder = builder.generatedAlwaysAs(
      drizzleDefinitionSql(column.generated.expression, quoteMysqlIdentifier),
      { mode: column.generated.mode },
    );
  }
  if (
    column.autoIncrement !== undefined &&
    column.type.kind === "direct" &&
    column.type.type !== "serial"
  ) {
    builder = builder.autoincrement();
  }
  if (column.onUpdate === "current-timestamp") builder = builder.onUpdateNow();
  // SAFETY: The runtime value originated from a public MySQL builder and modifiers preserve that family.
  return builder as unknown as MySqlColumnBuilderBase;
}

function installMysqlAutoIncrementCodec(
  finalTable: AnyMySqlTable,
  resolvedTable: MysqlRecordResolution<RecordDefinitions>["tables"][string],
): void {
  const finalColumns = getTableColumns(finalTable);
  for (const [fieldName, column] of Object.entries(resolvedTable.columns)) {
    if (column.autoIncrement === undefined) continue;
    const finalColumn = Reflect.get(finalColumns, fieldName);
    if (finalColumn === undefined) continue;
    Object.defineProperties(finalColumn, {
      mapFromDriverValue: {
        configurable: true,
        value: (value: unknown) => column.decode(value),
      },
      mapToDriverValue: {
        configurable: true,
        // SAFETY: The resolver's erased Field generic still owns the runtime encoder for this exact column.
        value: (value: unknown) => column.encode(value as never),
      },
    });
  }
}

function assertMysqlRepresentable(
  recordName: string,
  table: MysqlResolvedTable<RecordDefinition>,
): void {
  const issues = Object.entries(table.columns).flatMap(([fieldName, column]) =>
    column.onUpdate === "current-timestamp" &&
    column.type.kind === "direct" &&
    column.type.type === "datetime"
      ? [
          drizzleDefinitionIssue(
            "incompatible-drizzle-column",
            ["records", recordName, "fields", fieldName, "column", "mysql", "onUpdate"],
            "Drizzle cannot represent MySQL DATETIME with ON UPDATE CURRENT_TIMESTAMP",
          ),
        ]
      : [],
  );
  if (issues.length > 0) throw new DrizzleDefinitionError(issues);
}

function generateMysqlTable(
  recordName: string,
  definition: RecordDefinition,
  builderOverrides: Readonly<Record<string, unknown>>,
): GeneratedDrizzleTable {
  // SAFETY: This adapter erases only catalog literals; the resolver preserves every supplied Record key.
  const resolve = resolveMysqlRecords as unknown as (options: {
    readonly records: RecordDefinitions;
  }) => MysqlRecordResolution<RecordDefinitions>;
  const resolution = resolve({ records: { [recordName]: definition } });
  const table = resolution.tables[recordName];
  if (table === undefined) throw new TypeError(`MySQL Record '${recordName}' did not resolve`);
  assertMysqlRepresentable(recordName, table);
  const builders: Record<string, MySqlColumnBuilderBase> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    const override = Reflect.get(builderOverrides, fieldName);
    builders[fieldName] = is(override, MySqlColumnBuilder) ? override : mysqlColumnBuilder(column);
  }
  for (const [fieldName, override] of Object.entries(builderOverrides)) {
    if (!Object.hasOwn(builders, fieldName) && is(override, MySqlColumnBuilder)) {
      builders[fieldName] = override;
    }
  }
  const extraConfig = (columns: Readonly<Record<string, unknown>>) => {
    if (table.primaryKey.length === 0) return [];
    const primaryColumns = table.primaryKey.flatMap((column) => {
      const logical = Object.entries(table.columns).find(([, value]) => value === column)?.[0];
      return logical === undefined ? [] : [Reflect.get(columns, logical)];
    });
    // SAFETY: Every primary-key member was resolved from this exact table's logical column map.
    return [primaryKey({ columns: primaryColumns as never })];
  };
  // SAFETY: The callback returns only public MySQL extra-config entities built from this table's columns.
  const finalTable =
    table.database === undefined
      ? mysqlTable(table.name, builders, extraConfig as never)
      : mysqlDatabase(table.database).table(table.name, builders, extraConfig as never);
  installMysqlAutoIncrementCodec(finalTable, table);
  return { table: finalTable };
}

/** MySQL mechanics for the shared connection-free definition lifecycle. */
export const mysqlDefinitionAdapter: DrizzleDefinitionDialectAdapter = {
  dialect: "mysql",
  label: "MySQL",
  isTable: (value) => is(value, MySqlTable),
  isColumnBuilder: (value) => is(value, MySqlColumnBuilder),
  // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
  getColumns: (table) => getTableColumns(table as AnyMySqlTable),
  generateTable: generateMysqlTable,
  createRecordReference: (table) => {
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    const mysqlValue = table as AnyMySqlTable;
    const config = getMysqlTableConfig(mysqlValue);
    const database = config.schema;
    return createDrizzleRecordReference(
      database === undefined ? [config.name] : [database, config.name],
      getTableColumns(mysqlValue),
    );
  },
  getPrimaryKeyFields: (table) => {
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    const mysqlValue = table as AnyMySqlTable;
    const config = getMysqlTableConfig(mysqlValue);
    const columns = getTableColumns(mysqlValue);
    const primaryColumns =
      config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
    return primaryColumns.flatMap((column) => {
      const entry = Object.entries(columns).find(([, value]) => value === column);
      return entry === undefined ? [] : [entry[0]];
    });
  },
  getTableIdentity: (table) => {
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    const config = getMysqlTableConfig(table as AnyMySqlTable);
    return config.schema === undefined ? [config.name] : [config.schema, config.name];
  },
};

import type { RecordDefinition, RecordDefinitions } from "@commissary/store";
import type { SqlLiteralValue, SqlRecordReferences, SqlStatement } from "@commissary/store/sql";
import { resolvePostgresRecords } from "@commissary/store/sql/postgres/adapter";
import type {
  PostgresRecordResolution,
  PostgresResolvedColumn,
  PostgresResolvedColumnType,
  PostgresResolvedTable,
} from "@commissary/store/sql/postgres/adapter";
import { getTableColumns, is, type SQL } from "drizzle-orm";
import {
  PgColumnBuilder,
  PgTable,
  bigint,
  customType,
  integer,
  isPgEnum,
  getTableConfig as getPostgresTableConfig,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  type AnyPgTable,
  type PgColumnBuilderBase,
  type PgEnum,
} from "drizzle-orm/pg-core";

import { DrizzleDefinitionError, drizzleDefinitionIssue } from "./definition-contracts.js";
import {
  createDrizzleRecordReference,
  type DrizzleDefinitionDialectAdapter,
  type GeneratedDrizzleTable,
} from "./definition-runtime.js";
import {
  drizzleDefinitionSql,
  drizzleDefinitionSqlText,
  quotePostgresIdentifier,
} from "./drizzle-sql.js";

interface RuntimePostgresBuilder {
  notNull(): RuntimePostgresBuilder;
  default(value: unknown): RuntimePostgresBuilder;
  generatedAlwaysAs(value: SQL): RuntimePostgresBuilder;
  generatedAlwaysAsIdentity(options?: Readonly<Record<string, unknown>>): RuntimePostgresBuilder;
  generatedByDefaultAsIdentity(options?: Readonly<Record<string, unknown>>): RuntimePostgresBuilder;
}

function resolvedPostgresTypeSql(type: PostgresResolvedColumnType): string {
  switch (type.kind) {
    case "enum":
      return type.enum.schema === undefined
        ? quotePostgresIdentifier(type.enum.name)
        : `${quotePostgresIdentifier(type.enum.schema)}.${quotePostgresIdentifier(type.enum.name)}`;
    case "array":
      return `${resolvedPostgresTypeSql(type.element)}[]`;
    case "custom": {
      const base =
        type.type.schema === undefined
          ? quotePostgresIdentifier(type.type.name)
          : `${quotePostgresIdentifier(type.type.schema)}.${quotePostgresIdentifier(type.type.name)}`;
      return type.modifier === undefined
        ? base
        : `${base}${drizzleDefinitionSqlText(type.modifier, quotePostgresIdentifier)}`;
    }
    case "direct": {
      const options = type.options;
      switch (type.type) {
        case "numeric": {
          if (options === undefined || !("precision" in options)) return "numeric";
          const precision = options.precision;
          const scale = "scale" in options ? options.scale : undefined;
          return scale === undefined ? `numeric(${precision})` : `numeric(${precision},${scale})`;
        }
        case "char":
        case "varchar":
          return options !== undefined && "length" in options && options.length !== undefined
            ? `${type.type}(${options.length})`
            : type.type;
        case "time":
        case "timestamp": {
          const precision =
            options !== undefined && "precision" in options && options.precision !== undefined
              ? `(${options.precision})`
              : "";
          const zone =
            options !== undefined && "withTimezone" in options && options.withTimezone === true
              ? " with time zone"
              : " without time zone";
          return `${type.type}${precision}${zone}`;
        }
        case "interval": {
          const fields =
            options !== undefined && "fields" in options && options.fields !== undefined
              ? ` ${String(options.fields).replaceAll("-", " to ")}`
              : "";
          const precision =
            options !== undefined && "precision" in options && options.precision !== undefined
              ? `(${options.precision})`
              : "";
          return `interval${fields}${precision}`;
        }
        case "double-precision":
          return "double precision";
        default:
          return type.type;
      }
    }
  }
}

function postgresDefault(value: SqlLiteralValue | SqlStatement<never>): unknown {
  if (typeof value !== "object" || value === null) return value;
  // SAFETY: SqlStatement is the only non-null object member of the resolved default union.
  return drizzleDefinitionSql(value as SqlStatement<never>, quotePostgresIdentifier);
}

function postgresEnumEntity(
  type: Extract<PostgresResolvedColumnType, { readonly kind: "enum" }>,
): PgEnum<[string, ...string[]]> {
  // SAFETY: The resolver guarantees a frozen nonempty enum tuple.
  const values = [...type.enum.values] as [string, ...string[]];
  return type.enum.schema === undefined
    ? pgEnum(type.enum.name, values)
    : pgSchema(type.enum.schema).enum(type.enum.name, values);
}

function postgresIdentityBuilder(column: PostgresResolvedColumn): RuntimePostgresBuilder {
  const type = column.type.kind === "direct" ? column.type.type : undefined;
  const builder =
    type === "smallint"
      ? smallint(column.name)
      : type === "integer"
        ? integer(column.name)
        : bigint(column.name, { mode: "bigint" }).$type<string>();
  // SAFETY: Every PostgreSQL integer builder implements the shared runtime modifier surface.
  return builder as unknown as RuntimePostgresBuilder;
}

function postgresColumnBuilder(
  column: PostgresResolvedColumn,
  enums: Map<object, PgEnum<[string, ...string[]]>>,
): PgColumnBuilderBase {
  let builder: RuntimePostgresBuilder;
  if (column.identity !== undefined) {
    builder = postgresIdentityBuilder(column);
  } else if (column.type.kind === "enum") {
    let enumValue = enums.get(column.type.enum);
    if (enumValue === undefined) {
      enumValue = postgresEnumEntity(column.type);
      enums.set(column.type.enum, enumValue);
    }
    // SAFETY: Every public PgEnum call returns a PostgreSQL column builder.
    builder = enumValue(column.name) as unknown as RuntimePostgresBuilder;
  } else {
    const dataType = resolvedPostgresTypeSql(column.type);
    const makeCustom = customType<{ data: unknown; driverData: unknown }>({
      dataType: () => dataType,
      // SAFETY: The resolver's erased Field generic still owns the runtime encoder for this exact column.
      toDriver: (value) => column.encode(value as never),
      fromDriver: (value) => column.decode(value),
    });
    // SAFETY: Public PostgreSQL custom builders implement the common builder modifier methods.
    builder = makeCustom(column.name) as unknown as RuntimePostgresBuilder;
  }
  if (column.notNull && column.identity === undefined) builder = builder.notNull();
  if (column.default !== undefined) builder = builder.default(postgresDefault(column.default));
  if (column.generated !== undefined) {
    builder = builder.generatedAlwaysAs(
      drizzleDefinitionSql(column.generated.expression, quotePostgresIdentifier),
    );
  }
  if (column.identity !== undefined) {
    const sequence = column.identity.sequence;
    const sequenceName = sequence?.name;
    const options = {
      ...(sequenceName === undefined ? {} : { name: sequenceName.name }),
      ...(sequence?.startWith === undefined ? {} : { startWith: sequence.startWith }),
      ...(sequence?.incrementBy === undefined ? {} : { increment: sequence.incrementBy }),
      ...(sequence?.minValue === undefined ? {} : { minValue: sequence.minValue }),
      ...(sequence?.maxValue === undefined ? {} : { maxValue: sequence.maxValue }),
      ...(sequence?.cache === undefined ? {} : { cache: sequence.cache }),
      ...(sequence?.cycle === undefined ? {} : { cycle: sequence.cycle }),
    };
    builder =
      column.identity.mode === "always"
        ? builder.generatedAlwaysAsIdentity(options)
        : builder.generatedByDefaultAsIdentity(options);
  }
  // SAFETY: The runtime value originated from a public PostgreSQL builder and modifiers preserve that family.
  return builder as unknown as PgColumnBuilderBase;
}

function installPostgresIdentityCodec(
  finalTable: AnyPgTable,
  resolvedTable: PostgresRecordResolution<RecordDefinitions>["tables"][string],
): void {
  const finalColumns = getTableColumns(finalTable);
  for (const [fieldName, column] of Object.entries(resolvedTable.columns)) {
    if (column.identity === undefined) continue;
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

function assertPostgresIdentityQualification(
  recordName: string,
  table: PostgresResolvedTable<RecordDefinition>,
): void {
  const issues = Object.entries(table.columns).flatMap(([fieldName, column]) => {
    const sequenceName = column.identity?.sequence?.name;
    if (
      sequenceName === undefined ||
      sequenceName.schema === table.schema ||
      (sequenceName.schema === undefined && table.schema === undefined)
    ) {
      return [];
    }
    return [
      drizzleDefinitionIssue(
        "incompatible-drizzle-column",
        [
          "records",
          recordName,
          "fields",
          fieldName,
          "column",
          "postgres",
          "identity",
          "sequence",
          "name",
          "schema",
        ],
        "Drizzle cannot represent an explicit PostgreSQL identity sequence whose schema qualification differs from its table",
      ),
    ];
  });
  if (issues.length > 0) throw new DrizzleDefinitionError(issues);
}

function generatePostgresTable(
  recordName: string,
  definition: RecordDefinition,
  builderOverrides: Readonly<Record<string, unknown>>,
): GeneratedDrizzleTable {
  // SAFETY: This adapter erases only catalog literals; the resolver preserves every supplied Record key.
  const resolve = resolvePostgresRecords as unknown as (options: {
    readonly records: RecordDefinitions;
  }) => PostgresRecordResolution<RecordDefinitions>;
  const resolution = resolve({ records: { [recordName]: definition } });
  const table = resolution.tables[recordName];
  if (table === undefined) throw new TypeError(`PostgreSQL Record '${recordName}' did not resolve`);
  assertPostgresIdentityQualification(recordName, table);
  const enumValues = new Map<object, PgEnum<[string, ...string[]]>>();
  const builders: Record<string, PgColumnBuilderBase> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    const override = Reflect.get(builderOverrides, fieldName);
    builders[fieldName] = is(override, PgColumnBuilder)
      ? override
      : postgresColumnBuilder(column, enumValues);
  }
  for (const [fieldName, override] of Object.entries(builderOverrides)) {
    if (Object.hasOwn(builders, fieldName)) continue;
    if (is(override, PgColumnBuilder)) builders[fieldName] = override;
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
  // SAFETY: The callback returns only public PostgreSQL extra-config entities built from this table's columns.
  const finalTable =
    table.schema === undefined
      ? pgTable(table.name, builders, extraConfig as never)
      : pgSchema(table.schema).table(table.name, builders, extraConfig as never);
  installPostgresIdentityCodec(finalTable, table);
  const assets = [...enumValues].map(([resolvedEnum, entity]) => {
    const value = resolution.enums.find((candidate) => candidate === resolvedEnum);
    const key = value?.schema === undefined ? value?.name : `${value.schema}.${value.name}`;
    return [key ?? entity.enumName, entity] as const;
  });
  return { table: finalTable, assets };
}

function postgresEnumKey(value: PgEnum<[string, ...string[]]>): string {
  return value.schema === undefined ? value.enumName : `${value.schema}.${value.enumName}`;
}

function finishPostgresAssets(
  tables: Readonly<Record<string, unknown>>,
  options: Readonly<Record<string, unknown>>,
  generatedAssets: readonly (readonly [string, object])[],
  issues: import("./definition-contracts.js").DrizzleDefinitionIssue[],
): readonly (readonly [string, object])[] {
  const enumInput = Reflect.get(options, "enums");
  const enumInputIsMap =
    typeof enumInput === "object" && enumInput !== null && !Array.isArray(enumInput);
  // SAFETY: enumInputIsMap proves the input is an ordinary string-keyed runtime map.
  const supplied = enumInputIsMap ? (enumInput as Readonly<Record<string, unknown>>) : {};
  if (enumInput !== undefined && supplied !== enumInput) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-drizzle-enum",
        ["enums"],
        "PostgreSQL enums must be an object",
      ),
    );
  }
  const suppliedByIdentity = new Map<object, string>();
  for (const [key, value] of Object.entries(supplied)) {
    if (!isPgEnum(value)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-enum",
          ["enums", key],
          `PostgreSQL enum map value '${key}' is invalid`,
        ),
      );
      continue;
    }
    const physicalKey = postgresEnumKey(value);
    if (physicalKey !== key) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-enum",
          ["enums", key],
          `PostgreSQL enum map key '${key}' must equal physical key '${physicalKey}'`,
        ),
      );
    }
    suppliedByIdentity.set(value, key);
  }
  const generatedByIdentity = new Map<object, string>(
    generatedAssets.map(([key, value]) => [value, key]),
  );
  const used = new Set<object>();
  const materializedByPhysicalKey = new Map<string, PgEnum<[string, ...string[]]>>();
  const result: Array<readonly [string, object]> = [];
  for (const [recordName, table] of Object.entries(tables)) {
    // SAFETY: finishAssets receives only tables retained after the PostgreSQL adapter table guard.
    for (const [fieldName, column] of Object.entries(getTableColumns(table as AnyPgTable))) {
      const enumValue = Reflect.get(column, "enum");
      if (typeof enumValue !== "function" || used.has(enumValue)) continue;
      used.add(enumValue);
      const key = suppliedByIdentity.get(enumValue) ?? generatedByIdentity.get(enumValue);
      if (key === undefined) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-drizzle-enum",
            ["records", recordName, "fields", fieldName],
            `PostgreSQL enum used by '${recordName}.${fieldName}' is missing from enums`,
          ),
        );
      } else {
        const materialized = materializedByPhysicalKey.get(key);
        if (materialized === undefined) {
          materializedByPhysicalKey.set(key, enumValue);
          result.push([key, enumValue]);
        } else if (
          materialized.enumValues.length !== enumValue.enumValues.length ||
          materialized.enumValues.some((value, index) => enumValue.enumValues[index] !== value)
        ) {
          result.push([key, enumValue]);
        }
      }
    }
  }
  for (const [value, key] of suppliedByIdentity) {
    if (!used.has(value)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-enum",
          ["enums", key],
          `PostgreSQL enum map value '${key}' is not referenced by a final column`,
        ),
      );
    }
  }
  return result;
}

/** PostgreSQL mechanics for the shared connection-free definition lifecycle. */
export const postgresDefinitionAdapter: DrizzleDefinitionDialectAdapter = {
  dialect: "postgres",
  label: "PostgreSQL",
  isTable: (value) => is(value, PgTable),
  isColumnBuilder: (value) => is(value, PgColumnBuilder),
  // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
  getColumns: (table) => getTableColumns(table as AnyPgTable),
  generateTable: generatePostgresTable,
  createRecordReference: (table, definition) => {
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    const pgValue = table as AnyPgTable;
    const config = getPostgresTableConfig(pgValue);
    const schema = config.schema;
    return createDrizzleRecordReference(
      schema === undefined ? [config.name] : [schema, config.name],
      getTableColumns(pgValue),
    ) as SqlRecordReferences<{ readonly record: typeof definition }>["record"];
  },
  getPrimaryKeyFields: (table) => {
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    const pgValue = table as AnyPgTable;
    const config = getPostgresTableConfig(pgValue);
    const columns = getTableColumns(pgValue);
    const primaryColumns =
      config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
    return primaryColumns.flatMap((column) => {
      const entry = Object.entries(columns).find(([, value]) => value === column);
      return entry === undefined ? [] : [entry[0]];
    });
  },
  getTableIdentity: (table) => {
    // SAFETY: Shared lifecycle calls adapter methods only after this adapter's isTable check succeeds.
    const config = getPostgresTableConfig(table as AnyPgTable);
    return config.schema === undefined ? [config.name] : [config.schema, config.name];
  },
  finishAssets: finishPostgresAssets,
};

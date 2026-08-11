import {
  applyRecordOverrides,
  type ApplyOverrides,
  type CompatibleRecordOverrides,
  type RecordDefinition,
  type RecordDefinitions,
  type RecordOverrides,
  type RoundTripRecordDefinitions,
} from "../../record.js";
import { isSqlContractObject } from "../contract-object.js";
import { validateSqlDefinitionStatement } from "../definition-statement.js";
import {
  createSqlFieldReference as fieldReference,
  freezeSqlRecordMap,
  iterateSqlRecordCatalog,
  iterateSqlRecordFields,
  readSqlOverrideValue as ownNullableOverride,
  resolveSqlPrimaryKey,
  selectSqlFieldSchema as selectedSchema,
  sqlDefinitionIssue as issue,
  sqlDefinitionSourcePath as sourcePath,
  validateSqlPrimaryKeyStructure,
} from "../record-catalog-resolver.js";
import {
  readSqlLiteralFormat,
  reflectSqlSelectStorage,
  SqlDefinitionError,
  type SqlLiteralValue,
  type SqlRecordReference,
} from "../record.js";
import type { SqlStatement } from "../statement.js";
import {
  formatIssuePath,
  resolveDefault,
  resolveGenerated,
  resolveRowid,
  winningColumnTail,
  winningTableTail,
} from "./column-resolution.js";
import { resolvePhysicalType } from "./column-type-resolver.js";
import { readSqliteMetadata, recordReference } from "./metadata.js";
import { isValidSqliteName } from "./record.js";
import type {
  ResolutionState,
  RuntimeColumn,
  RuntimeTable,
  SqliteRecordResolution,
} from "./resolution-types.js";

function foldSqliteName(value: string): string {
  let folded = "";
  for (const character of value) {
    folded += character >= "A" && character <= "Z" ? character.toLowerCase() : character;
  }
  return folded;
}

function validPrimaryKeyShape(
  value: unknown,
  resolvedFields: readonly string[],
): value is readonly string[] {
  return Array.isArray(value) && value.length === resolvedFields.length;
}

function resolveSqlitePrimaryKey(
  fields: readonly string[],
  columns: Readonly<Record<string, RuntimeColumn>>,
  path: readonly (string | number)[],
  issues: ResolutionState["issues"],
): readonly RuntimeColumn[] {
  const primaryKey = resolveSqlPrimaryKey(fields, columns, path, issues);
  let hasGeneratedColumn = false;
  fields.forEach((fieldName, index) => {
    const column = columns[fieldName];
    if (column === undefined || !primaryKey.includes(column) || column.generated === undefined) {
      return;
    }
    hasGeneratedColumn = true;
    issues.push(
      issue(
        "invalid-primary-key",
        [...path, index],
        `SQLite primary-key field '${fieldName}' must not be generated`,
      ),
    );
  });
  return hasGeneratedColumn
    ? Object.freeze(primaryKey.filter((column) => column.generated === undefined))
    : primaryKey;
}

function resolveRuntime(
  definitions: RecordDefinitions,
  overrides: unknown,
): SqliteRecordResolution<RecordDefinitions> {
  const state: ResolutionState = { issues: [] };
  const tables = new Map<string, RuntimeTable>();
  const records = new Map<string, SqlRecordReference<RecordDefinition>>();
  const tableNames = new Map<
    string,
    { readonly path: readonly (string | number)[]; readonly owner: string }
  >();

  for (const record of iterateSqlRecordCatalog(definitions, overrides, state.issues)) {
    const { recordName, definition, table } = record;

    const sqliteTableValue = table === undefined ? undefined : Reflect.get(table, "sqlite");
    if (isSqlContractObject(sqliteTableValue) && Object.hasOwn(sqliteTableValue, "name")) {
      const candidate = Reflect.get(sqliteTableValue, "name");
      if (candidate !== null && !isValidSqliteName(candidate)) {
        state.issues.push(
          issue(
            "invalid-name",
            sourcePath(overrides, recordName, undefined, ["table", "sqlite", "name"]),
            "SQLite table name is invalid",
          ),
        );
      }
    }
    const sqliteTable = readSqliteMetadata(
      "table",
      sqliteTableValue,
      sourcePath(overrides, recordName, undefined, ["table", "sqlite"]),
      state.issues,
    );
    const nameValue = ownNullableOverride(sqliteTable, table, "name") ?? recordName;
    const tableNamePath = sourcePath(
      overrides,
      recordName,
      undefined,
      winningTableTail(sqliteTable, "name"),
    );
    const tableNameValid = isValidSqliteName(nameValue);
    if (
      !tableNameValid &&
      (!isSqlContractObject(sqliteTableValue) ||
        !Object.hasOwn(sqliteTableValue, "name") ||
        Reflect.get(sqliteTableValue, "name") !== nameValue)
    ) {
      state.issues.push(issue("invalid-name", tableNamePath, "SQLite table name is invalid"));
    }
    const tableNameReserved = tableNameValid && foldSqliteName(nameValue).startsWith("sqlite_");
    if (tableNameReserved) {
      state.issues.push(
        issue("invalid-name", tableNamePath, "SQLite table name uses the reserved sqlite_ prefix"),
      );
    }

    const primaryKeyValue = table?.primaryKey;
    const primaryKeyPath = sourcePath(overrides, recordName, undefined, ["table", "primaryKey"]);
    const primaryKeyFields = validateSqlPrimaryKeyStructure(
      primaryKeyValue,
      definition,
      primaryKeyPath,
      state.issues,
    );

    const columns = new Map<string, RuntimeColumn>();
    const fieldStatements = new Map<string, SqlStatement<never>>();
    const columnNameAssets: Array<{
      readonly name: string;
      readonly fieldName: string;
      readonly path: readonly (string | number)[];
    }> = [];
    const rowidAssets: Array<{
      readonly fieldName: string;
      readonly path: readonly (string | number)[];
    }> = [];
    const generatedAssets: Array<{
      readonly fieldName: string;
      readonly path: readonly (string | number)[];
    }> = [];

    for (const fieldEntry of iterateSqlRecordFields(record, state.issues)) {
      const { fieldName, field, column } = fieldEntry;

      const sqliteColumnValue = column === undefined ? undefined : Reflect.get(column, "sqlite");
      if (isSqlContractObject(sqliteColumnValue) && Object.hasOwn(sqliteColumnValue, "name")) {
        const candidate = Reflect.get(sqliteColumnValue, "name");
        if (candidate !== null && !isValidSqliteName(candidate)) {
          state.issues.push(
            issue(
              "invalid-name",
              sourcePath(overrides, recordName, fieldName, ["column", "sqlite", "name"]),
              `SQLite column '${fieldName}' name is invalid`,
            ),
          );
        }
      }
      const sqliteColumn = readSqliteMetadata(
        "column",
        sqliteColumnValue,
        sourcePath(overrides, recordName, fieldName, ["column", "sqlite"]),
        state.issues,
      );
      const propertyPath = (key: string): readonly (string | number)[] =>
        sourcePath(overrides, recordName, fieldName, winningColumnTail(sqliteColumn, key));

      const columnName = ownNullableOverride(sqliteColumn, column, "name") ?? fieldName;
      const columnNamePath = propertyPath("name");
      const columnNameValid = isValidSqliteName(columnName);
      if (
        !columnNameValid &&
        (!isSqlContractObject(sqliteColumnValue) ||
          !Object.hasOwn(sqliteColumnValue, "name") ||
          Reflect.get(sqliteColumnValue, "name") !== columnName)
      ) {
        state.issues.push(
          issue("invalid-name", columnNamePath, `SQLite column '${fieldName}' name is invalid`),
        );
      }

      const evidence = reflectSqlSelectStorage(selectedSchema(field));
      const typeValue = ownNullableOverride(sqliteColumn, column, "type");
      const typePath = propertyPath("type");
      const physical = resolvePhysicalType(typeValue, evidence, typePath, state);

      const defaultValue = ownNullableOverride(sqliteColumn, column, "default");
      const defaultPath = propertyPath("default");
      let resolvedDefault: SqlLiteralValue | SqlStatement<never> | undefined;
      if (physical !== undefined) {
        resolvedDefault = resolveDefault(defaultValue, physical, defaultPath, state.issues);
      } else if (defaultValue !== undefined && readSqlLiteralFormat(defaultValue) === undefined) {
        validateSqlDefinitionStatement(
          defaultValue,
          defaultPath,
          state.issues,
          "SQLite column default",
        );
      }

      const selectedNull = evidence?.selectedNull ?? false;
      const selectedPresence = evidence?.presence ?? "unknown";
      const explicitNotNull = ownNullableOverride(sqliteColumn, column, "notNull");
      const notNullPath = propertyPath("notNull");
      if (explicitNotNull !== undefined && typeof explicitNotNull !== "boolean") {
        state.issues.push(
          issue(
            "invalid-database-options",
            notNullPath,
            `SQLite column '${fieldName}' notNull option is invalid`,
          ),
        );
      }
      let notNull =
        typeof explicitNotNull === "boolean"
          ? explicitNotNull
          : selectedPresence === "required" && (physical?.application === "json" || !selectedNull);
      if (notNull && selectedNull && physical?.application !== "json") {
        state.issues.push(
          issue(
            "invalid-database-options",
            notNullPath,
            `SQLite column '${fieldName}' Select Schema permits SQL NULL`,
          ),
        );
      }

      const rowidValue =
        sqliteColumn === undefined
          ? undefined
          : ownNullableOverride(sqliteColumn, undefined, "rowid");
      const rowidPath = sourcePath(overrides, recordName, fieldName, ["column", "sqlite", "rowid"]);
      const rowid = resolveRowid(
        rowidValue,
        physical,
        rowidPath,
        sourcePath(overrides, recordName, fieldName, ["column", "sqlite", "rowid", "reuse"]),
        state.issues,
      );
      if (rowid !== undefined) {
        notNull = true;
        rowidAssets.push({ fieldName, path: rowidPath });
        if (explicitNotNull === false) {
          state.issues.push(
            issue(
              "invalid-database-options",
              rowidPath,
              `SQLite ROWID conflicts with notNull false at ${formatIssuePath(notNullPath)}`,
            ),
          );
        } else if (selectedNull && physical?.application !== "json") {
          state.issues.push(
            issue(
              "invalid-database-options",
              rowidPath,
              `SQLite ROWID conflicts with nullable Select Schema at ${formatIssuePath(notNullPath)}`,
            ),
          );
        }
        if (defaultValue !== undefined) {
          state.issues.push(
            issue(
              "invalid-database-options",
              rowidPath,
              `SQLite ROWID conflicts with default at ${formatIssuePath(defaultPath)}`,
            ),
          );
        }
      }

      const generatedValue =
        sqliteColumn === undefined
          ? undefined
          : ownNullableOverride(sqliteColumn, undefined, "generated");
      const generatedPath = sourcePath(overrides, recordName, fieldName, [
        "column",
        "sqlite",
        "generated",
      ]);
      const generated = resolveGenerated(
        generatedValue,
        generatedPath,
        sourcePath(overrides, recordName, fieldName, [
          "column",
          "sqlite",
          "generated",
          "expression",
        ]),
        sourcePath(overrides, recordName, fieldName, ["column", "sqlite", "generated", "mode"]),
        state.issues,
      );
      if (generated !== undefined) {
        generatedAssets.push({ fieldName, path: generatedPath });
        if (defaultValue !== undefined) {
          state.issues.push(
            issue(
              "invalid-database-options",
              generatedPath,
              `SQLite generated column conflicts with default at ${formatIssuePath(defaultPath)}`,
            ),
          );
        }
        if (rowid !== undefined) {
          state.issues.push(
            issue(
              "invalid-database-options",
              generatedPath,
              `SQLite generated column conflicts with ROWID at ${formatIssuePath(rowidPath)}`,
            ),
          );
        }
      }

      if (!columnNameValid || physical === undefined) continue;
      const reference = fieldReference(columnName);
      const resolvedColumn = Object.freeze({
        name: columnName,
        reference,
        schema: selectedSchema(field),
        type: physical.resolved,
        notNull,
        ...(resolvedDefault === undefined ? {} : { default: resolvedDefault }),
        ...(rowid === undefined ? {} : { rowid }),
        ...(generated === undefined ? {} : { generated }),
        encode: physical.encode,
        decode: physical.decode,
      });
      // SAFETY: Resolution preserves this Field's selected value contract in both codec directions.
      columns.set(fieldName, resolvedColumn as RuntimeColumn);
      fieldStatements.set(fieldName, reference);
      columnNameAssets.push({ name: columnName, fieldName, path: columnNamePath });
    }

    const frozenColumns = freezeSqlRecordMap(columns);
    let primaryKey = resolveSqlitePrimaryKey(
      primaryKeyFields,
      frozenColumns,
      primaryKeyPath,
      state.issues,
    );

    rowidAssets.slice(1).forEach((asset) => {
      state.issues.push(
        issue(
          "invalid-database-options",
          asset.path,
          `SQLite ROWID field '${asset.fieldName}' conflicts with '${rowidAssets[0]?.fieldName}'`,
        ),
      );
    });
    if (rowidAssets.length === 1) {
      const rowidAsset = rowidAssets[0];
      const rowidColumn =
        rowidAsset === undefined ? undefined : frozenColumns[rowidAsset.fieldName];
      if (primaryKeyValue === undefined && rowidColumn !== undefined) {
        primaryKey = Object.freeze([rowidColumn]);
      } else if (
        validPrimaryKeyShape(primaryKeyValue, primaryKeyFields) &&
        (primaryKeyFields.length !== 1 || primaryKeyFields[0] !== rowidAsset?.fieldName)
      ) {
        state.issues.push(
          issue(
            "invalid-database-options",
            rowidAsset?.path ?? primaryKeyPath,
            `SQLite ROWID field '${rowidAsset?.fieldName}' conflicts with primary key at ${formatIssuePath(primaryKeyPath)}`,
          ),
        );
      }
    }

    if (
      columns.size > 0 &&
      columns.size === Object.keys(definition.fields).length &&
      generatedAssets.length === columns.size
    ) {
      const lastGenerated = generatedAssets.at(-1);
      state.issues.push(
        issue(
          "invalid-database-options",
          lastGenerated?.path ?? primaryKeyPath,
          "SQLite table requires at least one non-generated column",
        ),
      );
    }

    const seenColumnNames = new Map<string, string>();
    for (const asset of columnNameAssets) {
      const foldedName = foldSqliteName(asset.name);
      const earlier = seenColumnNames.get(foldedName);
      if (earlier === undefined) {
        seenColumnNames.set(foldedName, asset.fieldName);
      } else {
        state.issues.push(
          issue(
            "duplicate-name",
            asset.path,
            `SQLite column '${asset.name}' conflicts with field '${earlier}'`,
          ),
        );
      }
    }

    if (!tableNameValid || tableNameReserved) continue;
    const tableName = nameValue;
    const reference = recordReference<RecordDefinition>(
      tableName,
      freezeSqlRecordMap(fieldStatements),
    );
    const resolvedTable = Object.freeze({
      name: tableName,
      reference,
      definition,
      columns: frozenColumns,
      primaryKey,
    });
    // SAFETY: All generic Record and Field keys are preserved in the frozen resolver assets.
    tables.set(recordName, resolvedTable as RuntimeTable);
    records.set(recordName, reference);

    const tableKey = foldSqliteName(tableName);
    const earlierTable = tableNames.get(tableKey);
    if (earlierTable === undefined) {
      tableNames.set(tableKey, { path: tableNamePath, owner: recordName });
    } else {
      state.issues.push(
        issue(
          "duplicate-name",
          tableNamePath,
          `SQLite table '${tableName}' conflicts with Record '${earlierTable.owner}'`,
        ),
      );
    }
  }

  if (state.issues.length > 0) throw new SqlDefinitionError(state.issues);
  // SAFETY: Successful resolution preserves every catalog key in both frozen mapped outputs.
  return Object.freeze({
    records: freezeSqlRecordMap(records),
    tables: freezeSqlRecordMap(tables),
  }) as SqliteRecordResolution<RecordDefinitions>;
}

/** Resolve effective SQL Records into immutable SQLite adapter assets without I/O. */
export function resolveSqliteRecords<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions> = {},
>(options: {
  readonly records: Definitions & RoundTripRecordDefinitions<Definitions>;
  readonly overrides?: Overrides & CompatibleRecordOverrides<Definitions, Overrides>;
}): SqliteRecordResolution<ApplyOverrides<Definitions, Overrides>> {
  const overrides =
    options.overrides ?? ({} as Overrides & CompatibleRecordOverrides<Definitions, Overrides>);
  let definitions: ApplyOverrides<Definitions, Overrides>;
  try {
    definitions = applyRecordOverrides<Definitions, Overrides>(options.records, overrides);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown override structure";
    throw new SqlDefinitionError(
      [issue("invalid-override", ["overrides"], `SQLite Record override is invalid: ${message}`)],
      { cause },
    );
  }
  // SAFETY: applyRecordOverrides and the resolver preserve every generic Record and Field key.
  return resolveRuntime(definitions, overrides) as SqliteRecordResolution<
    ApplyOverrides<Definitions, Overrides>
  >;
}

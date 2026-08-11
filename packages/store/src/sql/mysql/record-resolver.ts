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
  autoIncrementEncoder,
  formatIssuePath,
  resolveAutoIncrement,
  resolveDefault,
  resolveGenerated,
  resolveOnUpdate,
  winningColumnTail,
  winningTableTail,
} from "./column-resolution.js";
import { resolvePhysicalType } from "./column-type-resolver.js";
import { readMysqlMetadata, recordReference } from "./metadata.js";
import { foldMysqlName } from "./name-folding.js";
import { isValidMysqlName } from "./record.js";
import {
  type MysqlRecordResolution,
  type ResolutionState,
  type RuntimeColumn,
  type RuntimeTable,
} from "./resolution-types.js";

function resolveRuntime(
  definitions: RecordDefinitions,
  overrides: unknown,
): MysqlRecordResolution<RecordDefinitions> {
  const state: ResolutionState = { issues: [] };
  const tables = new Map<string, RuntimeTable>();
  const records = new Map<string, SqlRecordReference<RecordDefinition>>();
  const databaseSpellings = new Map<
    string,
    {
      readonly spelling: string;
      readonly path: readonly (string | number)[];
      readonly owner: string;
    }
  >();
  const tableNames = new Map<
    string,
    { readonly path: readonly (string | number)[]; readonly owner: string }
  >();

  for (const record of iterateSqlRecordCatalog(definitions, overrides, state.issues)) {
    const { recordName, definition, table } = record;

    const mysqlTableValue = table === undefined ? undefined : Reflect.get(table, "mysql");
    if (isSqlContractObject(mysqlTableValue)) {
      for (const key of ["database", "name"] as const) {
        if (!Object.hasOwn(mysqlTableValue, key)) continue;
        const candidate = Reflect.get(mysqlTableValue, key);
        if (candidate !== null && !isValidMysqlName(candidate)) {
          state.issues.push(
            issue(
              "invalid-name",
              sourcePath(overrides, recordName, undefined, ["table", "mysql", key]),
              `MySQL table ${key} is invalid`,
            ),
          );
        }
      }
    }
    const mysqlTable = readMysqlMetadata(
      "table",
      mysqlTableValue,
      sourcePath(overrides, recordName, undefined, ["table", "mysql"]),
      state.issues,
    );
    const databaseValue = ownNullableOverride(mysqlTable, undefined, "database");
    const nameValue = ownNullableOverride(mysqlTable, table, "name") ?? recordName;
    const databasePath = sourcePath(
      overrides,
      recordName,
      undefined,
      winningTableTail(mysqlTable, "database"),
    );
    const tableNamePath = sourcePath(
      overrides,
      recordName,
      undefined,
      winningTableTail(mysqlTable, "name"),
    );
    const databaseValid = databaseValue === undefined || isValidMysqlName(databaseValue);
    const tableNameValid = isValidMysqlName(nameValue);
    if (
      !databaseValid &&
      (!isSqlContractObject(mysqlTableValue) ||
        !Object.hasOwn(mysqlTableValue, "database") ||
        Reflect.get(mysqlTableValue, "database") !== databaseValue)
    ) {
      state.issues.push(issue("invalid-name", databasePath, "MySQL table database is invalid"));
    }
    if (
      !tableNameValid &&
      (!isSqlContractObject(mysqlTableValue) ||
        !Object.hasOwn(mysqlTableValue, "name") ||
        Reflect.get(mysqlTableValue, "name") !== nameValue)
    ) {
      state.issues.push(issue("invalid-name", tableNamePath, "MySQL table name is invalid"));
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
    const automaticIncrementAssets: Array<{
      readonly fieldName: string;
      readonly path: readonly (string | number)[];
      readonly intrinsic: boolean;
    }> = [];

    for (const fieldEntry of iterateSqlRecordFields(record, state.issues)) {
      const { fieldName, field, column } = fieldEntry;

      const mysqlColumnValue = column === undefined ? undefined : Reflect.get(column, "mysql");
      if (isSqlContractObject(mysqlColumnValue) && Object.hasOwn(mysqlColumnValue, "name")) {
        const candidate = Reflect.get(mysqlColumnValue, "name");
        if (candidate !== null && !isValidMysqlName(candidate)) {
          state.issues.push(
            issue(
              "invalid-name",
              sourcePath(overrides, recordName, fieldName, ["column", "mysql", "name"]),
              `MySQL column '${fieldName}' name is invalid`,
            ),
          );
        }
      }
      const mysqlColumn = readMysqlMetadata(
        "column",
        mysqlColumnValue,
        sourcePath(overrides, recordName, fieldName, ["column", "mysql"]),
        state.issues,
      );
      const propertyPath = (key: string): readonly (string | number)[] =>
        sourcePath(overrides, recordName, fieldName, winningColumnTail(mysqlColumn, key));

      const columnName = ownNullableOverride(mysqlColumn, column, "name") ?? fieldName;
      const columnNamePath = propertyPath("name");
      const columnNameValid = isValidMysqlName(columnName);
      if (
        !columnNameValid &&
        (!isSqlContractObject(mysqlColumnValue) ||
          !Object.hasOwn(mysqlColumnValue, "name") ||
          Reflect.get(mysqlColumnValue, "name") !== columnName)
      ) {
        state.issues.push(
          issue("invalid-name", columnNamePath, `MySQL column '${fieldName}' name is invalid`),
        );
      }

      const evidence = reflectSqlSelectStorage(selectedSchema(field));
      const typeValue = ownNullableOverride(mysqlColumn, column, "type");
      const typePath = propertyPath("type");
      const physical = resolvePhysicalType(typeValue, evidence, typePath, state);

      const defaultValue = ownNullableOverride(mysqlColumn, column, "default");
      const defaultPath = propertyPath("default");
      let resolvedDefault: SqlLiteralValue | SqlStatement<never> | undefined;
      if (physical !== undefined) {
        resolvedDefault = resolveDefault(defaultValue, physical, defaultPath, state.issues);
      } else if (defaultValue !== undefined && readSqlLiteralFormat(defaultValue) === undefined) {
        validateSqlDefinitionStatement(
          defaultValue,
          defaultPath,
          state.issues,
          "MySQL column default",
        );
      }

      const selectedNull = evidence?.selectedNull ?? false;
      const selectedPresence = evidence?.presence ?? "unknown";
      const explicitNotNull = ownNullableOverride(mysqlColumn, column, "notNull");
      const notNullPath = propertyPath("notNull");
      if (explicitNotNull !== undefined && typeof explicitNotNull !== "boolean") {
        state.issues.push(
          issue(
            "invalid-database-options",
            notNullPath,
            `MySQL column '${fieldName}' notNull option is invalid`,
          ),
        );
      }
      let notNull =
        typeof explicitNotNull === "boolean"
          ? explicitNotNull
          : selectedPresence === "required" && (physical?.application === "json" || !selectedNull);
      const intrinsicAutoIncrement = physical?.intrinsicAutoIncrement === true;
      if (intrinsicAutoIncrement) {
        notNull = true;
        if (explicitNotNull === false) {
          state.issues.push(
            issue(
              "invalid-database-options",
              notNullPath,
              `MySQL serial type conflicts with notNull false at ${formatIssuePath(typePath)}`,
            ),
          );
        }
      }
      if (
        notNull &&
        selectedNull &&
        physical?.application !== "json" &&
        !(intrinsicAutoIncrement && explicitNotNull === false)
      ) {
        state.issues.push(
          issue(
            "invalid-database-options",
            notNullPath,
            `MySQL column '${fieldName}' Select Schema permits SQL NULL`,
          ),
        );
      }

      const autoIncrementValue =
        mysqlColumn === undefined
          ? undefined
          : ownNullableOverride(mysqlColumn, undefined, "autoIncrement");
      const autoIncrementPath = sourcePath(overrides, recordName, fieldName, [
        "column",
        "mysql",
        "autoIncrement",
      ]);
      const autoIncrement =
        physical === undefined
          ? undefined
          : resolveAutoIncrement(autoIncrementValue, physical, autoIncrementPath, state.issues);
      if (
        physical === undefined &&
        autoIncrementValue !== undefined &&
        typeof autoIncrementValue !== "boolean"
      ) {
        state.issues.push(
          issue(
            "invalid-database-options",
            autoIncrementPath,
            "MySQL autoIncrement option is invalid",
          ),
        );
      }
      if (autoIncrement !== undefined) {
        notNull = true;
        automaticIncrementAssets.push({
          fieldName,
          path: intrinsicAutoIncrement ? typePath : autoIncrementPath,
          intrinsic: intrinsicAutoIncrement,
        });
        if (!intrinsicAutoIncrement && explicitNotNull === false) {
          state.issues.push(
            issue(
              "invalid-database-options",
              autoIncrementPath,
              `MySQL autoIncrement conflicts with notNull false at ${formatIssuePath(notNullPath)}`,
            ),
          );
        } else if (!intrinsicAutoIncrement && selectedNull && physical?.application !== "json") {
          state.issues.push(
            issue(
              "invalid-database-options",
              autoIncrementPath,
              `MySQL autoIncrement conflicts with nullable Select Schema at ${formatIssuePath(notNullPath)}`,
            ),
          );
        }
        if (intrinsicAutoIncrement && autoIncrementValue === false) {
          state.issues.push(
            issue(
              "invalid-database-options",
              autoIncrementPath,
              `MySQL serial type at ${formatIssuePath(typePath)} conflicts with autoIncrement false`,
            ),
          );
        }
        if (defaultValue !== undefined) {
          const conflictPath = intrinsicAutoIncrement ? defaultPath : autoIncrementPath;
          const otherPath = intrinsicAutoIncrement ? typePath : defaultPath;
          state.issues.push(
            issue(
              "invalid-database-options",
              conflictPath,
              `MySQL automatic increment conflicts with ${formatIssuePath(otherPath)}`,
            ),
          );
        }
      }

      const generatedValue =
        mysqlColumn === undefined
          ? undefined
          : ownNullableOverride(mysqlColumn, undefined, "generated");
      const generatedPath = sourcePath(overrides, recordName, fieldName, [
        "column",
        "mysql",
        "generated",
      ]);
      const generated = resolveGenerated(
        generatedValue,
        generatedPath,
        sourcePath(overrides, recordName, fieldName, [
          "column",
          "mysql",
          "generated",
          "expression",
        ]),
        sourcePath(overrides, recordName, fieldName, ["column", "mysql", "generated", "mode"]),
        state.issues,
      );
      if (generated !== undefined && defaultValue !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            generatedPath,
            `MySQL generated column conflicts with default at ${formatIssuePath(defaultPath)}`,
          ),
        );
      }
      if (generated !== undefined && autoIncrement !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            generatedPath,
            `MySQL generated column conflicts with automatic increment at ${formatIssuePath(
              intrinsicAutoIncrement ? typePath : autoIncrementPath,
            )}`,
          ),
        );
      }

      const onUpdateValue =
        mysqlColumn === undefined
          ? undefined
          : ownNullableOverride(mysqlColumn, undefined, "onUpdate");
      const onUpdatePath = sourcePath(overrides, recordName, fieldName, [
        "column",
        "mysql",
        "onUpdate",
      ]);
      const onUpdate =
        physical === undefined
          ? undefined
          : resolveOnUpdate(onUpdateValue, physical, onUpdatePath, state.issues);
      if (
        physical === undefined &&
        onUpdateValue !== undefined &&
        onUpdateValue !== "current-timestamp"
      ) {
        state.issues.push(
          issue("invalid-database-options", onUpdatePath, "MySQL onUpdate option is invalid"),
        );
      }
      if (onUpdate !== undefined && defaultValue === undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            onUpdatePath,
            "MySQL current-timestamp update requires an explicit default",
          ),
        );
      }
      if (onUpdate !== undefined && autoIncrement !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            onUpdatePath,
            `MySQL automatic update conflicts with automatic increment at ${formatIssuePath(
              intrinsicAutoIncrement ? typePath : autoIncrementPath,
            )}`,
          ),
        );
      }
      if (onUpdate !== undefined && generated !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            onUpdatePath,
            `MySQL automatic update conflicts with generation at ${formatIssuePath(generatedPath)}`,
          ),
        );
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
        ...(autoIncrement === undefined ? {} : { autoIncrement }),
        ...(generated === undefined ? {} : { generated }),
        ...(onUpdate === undefined ? {} : { onUpdate }),
        encode: autoIncrement === undefined ? physical.encode : autoIncrementEncoder(physical),
        decode: physical.decode,
      });
      // SAFETY: Resolution preserves this Field's selected value contract in both codec directions.
      columns.set(fieldName, resolvedColumn as RuntimeColumn);
      fieldStatements.set(fieldName, reference);
      columnNameAssets.push({ name: columnName, fieldName, path: columnNamePath });
    }

    const frozenColumns = freezeSqlRecordMap(columns);
    const primaryKey = resolveSqlPrimaryKey(
      primaryKeyFields,
      frozenColumns,
      primaryKeyPath,
      state.issues,
    );

    automaticIncrementAssets.slice(1).forEach((asset) => {
      state.issues.push(
        issue(
          "invalid-database-options",
          asset.path,
          `MySQL automatic-increment field '${asset.fieldName}' conflicts with '${automaticIncrementAssets[0]?.fieldName}'`,
        ),
      );
    });
    automaticIncrementAssets.forEach((asset) => {
      const primaryPosition = primaryKeyFields.indexOf(asset.fieldName);
      if (primaryPosition > 0) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...primaryKeyPath, primaryPosition],
            `MySQL primary key must start with automatic-increment field '${asset.fieldName}'`,
          ),
        );
      }
    });

    const seenColumnNames = new Map<string, string>();
    for (const asset of columnNameAssets) {
      const foldedName = foldMysqlName(asset.name);
      const earlier = seenColumnNames.get(foldedName);
      if (earlier === undefined) {
        seenColumnNames.set(foldedName, asset.fieldName);
      } else {
        state.issues.push(
          issue(
            "duplicate-name",
            asset.path,
            `MySQL column '${asset.name}' conflicts with field '${earlier}'`,
          ),
        );
      }
    }

    if (!databaseValid || !tableNameValid) continue;
    const database = databaseValue;
    const tableName = nameValue;
    const reference = recordReference<RecordDefinition>(
      database,
      tableName,
      freezeSqlRecordMap(fieldStatements),
    );
    const resolvedTable = Object.freeze({
      ...(database === undefined ? {} : { database }),
      name: tableName,
      reference,
      definition,
      columns: frozenColumns,
      primaryKey,
    });
    // SAFETY: All generic Record and Field keys are preserved in the frozen resolver assets.
    tables.set(recordName, resolvedTable as RuntimeTable);
    records.set(recordName, reference);

    if (database !== undefined) {
      const foldedDatabase = foldMysqlName(database);
      const earlier = databaseSpellings.get(foldedDatabase);
      if (earlier === undefined) {
        databaseSpellings.set(foldedDatabase, {
          spelling: database,
          path: databasePath,
          owner: recordName,
        });
      } else if (earlier.spelling !== database) {
        state.issues.push(
          issue(
            "duplicate-name",
            databasePath,
            `MySQL database '${database}' conflicts with spelling '${earlier.spelling}' from '${earlier.owner}'`,
          ),
        );
      }
    }

    const databaseKey =
      database === undefined ? "unqualified" : `database\u0000${foldMysqlName(database)}`;
    const tableKey = `${databaseKey}\u0000${foldMysqlName(tableName)}`;
    const earlierTable = tableNames.get(tableKey);
    if (earlierTable === undefined) {
      tableNames.set(tableKey, { path: tableNamePath, owner: recordName });
    } else {
      state.issues.push(
        issue(
          "duplicate-name",
          tableNamePath,
          `MySQL table '${tableName}' conflicts with Record '${earlierTable.owner}'`,
        ),
      );
    }
  }

  if (state.issues.length > 0) throw new SqlDefinitionError(state.issues);
  // SAFETY: Successful resolution preserves every catalog key in both frozen mapped outputs.
  return Object.freeze({
    records: freezeSqlRecordMap(records),
    tables: freezeSqlRecordMap(tables),
  }) as MysqlRecordResolution<RecordDefinitions>;
}

/** Resolve effective SQL Records into immutable MySQL adapter assets without I/O. */
export function resolveMysqlRecords<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions> = {},
>(options: {
  readonly records: Definitions & RoundTripRecordDefinitions<Definitions>;
  readonly overrides?: Overrides & CompatibleRecordOverrides<Definitions, Overrides>;
}): MysqlRecordResolution<ApplyOverrides<Definitions, Overrides>> {
  const overrides =
    options.overrides ?? ({} as Overrides & CompatibleRecordOverrides<Definitions, Overrides>);
  let definitions: ApplyOverrides<Definitions, Overrides>;
  try {
    definitions = applyRecordOverrides<Definitions, Overrides>(options.records, overrides);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown override structure";
    throw new SqlDefinitionError(
      [issue("invalid-override", ["overrides"], `MySQL Record override is invalid: ${message}`)],
      { cause },
    );
  }
  // SAFETY: applyRecordOverrides and the resolver preserve every generic Record and Field key.
  return resolveRuntime(definitions, overrides) as MysqlRecordResolution<
    ApplyOverrides<Definitions, Overrides>
  >;
}

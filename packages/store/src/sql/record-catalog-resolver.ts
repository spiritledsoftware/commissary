import type {
  FieldDefinition,
  FieldSchema,
  RecordDefinition,
  RecordDefinitions,
} from "../record.js";
import {
  reflectSqlSelectStorage,
  type SqlDefinitionIssue,
  type SqlLiteralValue,
  type SqlPortableTypeName,
  type SqlRecordReference,
} from "./record.js";
import { sql, type SqlStatement } from "./statement.js";

/** One lazily validated Record catalog entry. */
export interface SqlRecordCatalogEntry {
  readonly recordName: string;
  readonly definition: RecordDefinition;
  readonly tableValue: unknown;
  readonly table: Readonly<Record<PropertyKey, unknown>> | undefined;
  readonly path: (tail: readonly string[]) => readonly (string | number)[];
  readonly fieldPath: (fieldName: string, tail: readonly string[]) => readonly (string | number)[];
}

/** One lazily validated Field catalog entry. */
export interface SqlFieldCatalogEntry extends SqlRecordCatalogEntry {
  readonly fieldName: string;
  readonly field: FieldDefinition;
  readonly columnValue: unknown;
  readonly column: Readonly<Record<PropertyKey, unknown>> | undefined;
}

/** Test whether a value can own SQL Record metadata. */
export function isSqlRecordContainer(
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test whether a Field is directly represented by its Select Schema. */
export function isSqlFieldSchema(value: unknown): value is FieldSchema {
  if (!isSqlRecordContainer(value) || !Object.hasOwn(value, "~standard")) return false;
  const standard = Reflect.get(value, "~standard");
  return (
    isSqlRecordContainer(standard) &&
    Reflect.get(standard, "version") === 1 &&
    typeof Reflect.get(standard, "validate") === "function"
  );
}

/** Select the effective read Schema from either supported Field form. */
export function selectSqlFieldSchema(field: FieldDefinition): FieldSchema {
  return isSqlFieldSchema(field) ? field : field.select;
}

/** Create one SQL definition issue with safe metadata only. */
export function sqlDefinitionIssue(
  code: SqlDefinitionIssue["code"],
  path: readonly (string | number)[],
  message: string,
): SqlDefinitionIssue {
  return { code, path, message };
}

/** Create one physical-column SQL identifier reference. */
export function createSqlFieldReference(name: string): SqlStatement<never> {
  return sql.identifier(name);
}

/** Read one nullable database refinement over portable metadata. */
export function readSqlOverrideValue(
  refinement: Readonly<Record<PropertyKey, unknown>> | undefined,
  portable: Readonly<Record<PropertyKey, unknown>> | undefined,
  key: string,
): unknown {
  if (refinement !== undefined && Object.hasOwn(refinement, key)) {
    const value = Reflect.get(refinement, key);
    return value === null ? undefined : value;
  }
  return portable !== undefined && Object.hasOwn(portable, key)
    ? Reflect.get(portable, key)
    : undefined;
}

/** Check a portable literal against one resolved application family. */
export function sqlLiteralMatchesApplication(
  value: SqlLiteralValue,
  application:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "json"
    | "point"
    | "line"
    | "array"
    | "custom",
): boolean {
  switch (application) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
    case "custom":
      return true;
    case "point":
    case "line":
    case "array":
      return false;
  }
}

function requiredSqlEvidenceCategory(
  application:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "json"
    | "point"
    | "line"
    | "array"
    | "custom",
): SqlPortableTypeName | undefined {
  switch (application) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "json":
    case "point":
    case "line":
    case "array":
      return "json";
    case "custom":
      return undefined;
  }
}

/** Check reflected Select storage against one resolved application family. */
export function sqlEvidenceMatchesApplication(
  evidence: ReturnType<typeof reflectSqlSelectStorage>,
  application:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "json"
    | "point"
    | "line"
    | "array"
    | "custom",
): boolean {
  if (evidence === undefined) return true;
  const required = requiredSqlEvidenceCategory(application);
  if (required === undefined) return true;
  if (required === "number") return evidence.type === "number" || evidence.type === "integer";
  return evidence.type === required;
}

function hasNestedOwnValue(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined;
  let current = value;
  for (const key of path) {
    if (!isSqlRecordContainer(current) || !Object.hasOwn(current, key)) return false;
    current = Reflect.get(current, key);
  }
  return true;
}

/** Point an issue at the winning override or original Record contribution. */
export function sqlDefinitionSourcePath(
  overrides: unknown,
  recordName: string,
  fieldName: string | undefined,
  tail: readonly string[],
): readonly (string | number)[] {
  const recordOverride =
    isSqlRecordContainer(overrides) && Object.hasOwn(overrides, recordName)
      ? Reflect.get(overrides, recordName)
      : undefined;
  const fieldOverrides =
    isSqlRecordContainer(recordOverride) &&
    isSqlRecordContainer(Reflect.get(recordOverride, "fields"))
      ? Reflect.get(recordOverride, "fields")
      : undefined;
  const candidate =
    fieldName === undefined
      ? recordOverride
      : isSqlRecordContainer(fieldOverrides) && Object.hasOwn(fieldOverrides, fieldName)
        ? Reflect.get(fieldOverrides, fieldName)
        : undefined;
  if (hasNestedOwnValue(candidate, tail)) {
    return fieldName === undefined
      ? ["overrides", recordName, ...tail]
      : ["overrides", recordName, "fields", fieldName, ...tail];
  }
  return fieldName === undefined
    ? ["records", recordName, ...tail]
    : ["records", recordName, "fields", fieldName, ...tail];
}

/** Traverse Records and validate only shared table-container structure. */
export function* iterateSqlRecordCatalog(
  definitions: RecordDefinitions,
  overrides: unknown,
  issues: SqlDefinitionIssue[],
): Generator<SqlRecordCatalogEntry> {
  for (const [recordName, definition] of Object.entries(definitions)) {
    const path = (tail: readonly string[]): readonly (string | number)[] =>
      sqlDefinitionSourcePath(overrides, recordName, undefined, tail);
    const fieldPath = (fieldName: string, tail: readonly string[]): readonly (string | number)[] =>
      sqlDefinitionSourcePath(overrides, recordName, fieldName, tail);
    const tableValue = Object.hasOwn(definition, "table")
      ? Reflect.get(definition, "table")
      : undefined;
    const table =
      tableValue === undefined
        ? undefined
        : isSqlRecordContainer(tableValue)
          ? tableValue
          : undefined;
    if (tableValue !== undefined && table === undefined) {
      issues.push(
        sqlDefinitionIssue(
          "invalid-definition",
          path(["table"]),
          "SQL Record table metadata must be an object",
        ),
      );
    }
    yield { recordName, definition, tableValue, table, path, fieldPath };
  }
}

/** Traverse Fields and validate only shared column-container structure. */
export function* iterateSqlRecordFields(
  record: SqlRecordCatalogEntry,
  issues: SqlDefinitionIssue[],
): Generator<SqlFieldCatalogEntry> {
  for (const [fieldName, field] of Object.entries(record.definition.fields)) {
    const columnValue =
      isSqlFieldSchema(field) || !Object.hasOwn(field, "column")
        ? undefined
        : Reflect.get(field, "column");
    const column =
      columnValue === undefined
        ? undefined
        : isSqlRecordContainer(columnValue)
          ? columnValue
          : undefined;
    if (columnValue !== undefined && column === undefined) {
      issues.push(
        sqlDefinitionIssue(
          "invalid-definition",
          record.fieldPath(fieldName, ["column"]),
          `SQL Record field '${fieldName}' column metadata must be an object`,
        ),
      );
    }
    yield { ...record, fieldName, field, columnValue, column };
  }
}

/** Validate primary-key tuple shape and known Field names. */
export function validateSqlPrimaryKeyStructure(
  value: unknown,
  definition: RecordDefinition,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(
      sqlDefinitionIssue(
        "invalid-primary-key",
        path,
        "SQL Record primary key must be a nonempty field tuple",
      ),
    );
    return Object.freeze([]);
  }
  const result: string[] = [];
  const names = new Set<string>();
  value.forEach((fieldName, index) => {
    if (typeof fieldName !== "string" || fieldName.length === 0 || names.has(fieldName)) {
      issues.push(
        sqlDefinitionIssue(
          "invalid-primary-key",
          [...path, index],
          "SQL Record primary-key field is invalid or repeated",
        ),
      );
      return;
    }
    names.add(fieldName);
    if (!Object.hasOwn(definition.fields, fieldName)) {
      issues.push(
        sqlDefinitionIssue(
          "invalid-primary-key",
          [...path, index],
          `SQL Record primary key names unknown field '${fieldName}'`,
        ),
      );
      return;
    }
    result.push(fieldName);
  });
  return Object.freeze(result);
}

/** Resolve validated primary-key names to present, non-null columns. */
export function resolveSqlPrimaryKey<Column extends { readonly notNull: boolean }>(
  fields: readonly string[],
  columns: Readonly<Record<string, Column>>,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): readonly Column[] {
  const result: Column[] = [];
  fields.forEach((fieldName, index) => {
    const column = columns[fieldName];
    if (column === undefined) return;
    if (!column.notNull) {
      issues.push(
        sqlDefinitionIssue(
          "invalid-primary-key",
          [...path, index],
          `SQL Record primary-key field '${fieldName}' can be SQL NULL`,
        ),
      );
      return;
    }
    result.push(column);
  });
  return Object.freeze(result);
}

/** Freeze a key-preserving map as a plain resolver asset. */
export function freezeSqlRecordMap<Value>(
  values: ReadonlyMap<string, Value>,
): Readonly<Record<string, Value>> {
  return Object.freeze(Object.fromEntries(values));
}

/** Attach a frozen Field reference map to an opaque table Statement. */
export function createSqlRecordReference<Definition extends RecordDefinition>(
  statement: SqlStatement<never>,
  fields: Readonly<Record<string, SqlStatement<never>>>,
): SqlRecordReference<Definition> {
  // SAFETY: The compatible Statement and frozen Field map provide the opaque reference contract.
  return Object.freeze({ ...statement, fields }) as SqlRecordReference<Definition>;
}

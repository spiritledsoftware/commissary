import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import type { SqlStatement } from "./statement.js";

import { isJsonValue, type JsonValue } from "../json.js";
import {
  applyRecordOverrides,
  StoreRecord,
  type ApplyOverrides,
  type CompatibleRecordOverrides,
  type FieldDefinition,
  type FieldOutput,
  type FieldSchema,
  type RecordDefinition,
  type RecordDefinitions,
  type RecordOverrides,
  type RoundTripFieldDefinitions,
  type RoundTripRecordDefinitions,
  type SelectFieldSchema,
} from "../record.js";

/** A scalar value that can be used as a portable SQL literal default. */
export type SqlLiteralValue = string | number | boolean;

/** A driver-independent scalar that a custom SQL column encoder can produce. */
export type SqlCustomEncodedValue = string | number | boolean | Uint8Array;

/** An opaque package-owned SQL column storage and conversion contract. */
export interface SqlColumnType<in Value extends JsonValue> {
  readonly "~commissary/sql-column-type"?: (value: Value) => void;
}

/** An opaque package-owned portable SQL literal default. */
export interface SqlLiteral<out Value extends SqlLiteralValue> {
  readonly "~commissary/sql-literal"?: () => Value;
}

/** Portable table metadata attached to one SQL Record Definition. */
export interface SqlTableDefinition {
  /** Exact physical table name; the catalog key is used when omitted. */
  readonly name?: string;
  /** Logical Record field names in primary-key column order. */
  readonly primaryKey?: readonly [string, ...string[]];
  /** PostgreSQL refinement interpreted only by the PostgreSQL resolver. */
  readonly postgres?: object;
  /** MySQL refinement interpreted only by the MySQL resolver. */
  readonly mysql?: object;
  /** SQLite refinement interpreted only by the SQLite resolver. */
  readonly sqlite?: object;
}

/** Portable column metadata attached to one SQL Field Definition. */
export interface SqlColumnDefinition<Value extends JsonValue> {
  /** Exact physical column name; the Record field key is used when omitted. */
  readonly name?: string;
  /** Explicit portable storage type, which takes precedence over Select Schema reflection. */
  readonly type?: SqlColumnType<Value>;
  /** Portable scalar database default. */
  readonly default?: SqlLiteral<Extract<Value, SqlLiteralValue>>;
  /** Explicit SQL nullability override. */
  readonly notNull?: boolean;
  /** PostgreSQL refinement interpreted only by the PostgreSQL resolver. */
  readonly postgres?: object;
  /** MySQL refinement interpreted only by the MySQL resolver. */
  readonly mysql?: object;
  /** SQLite refinement interpreted only by the SQLite resolver. */
  readonly sqlite?: object;
}

/** Add optional SQL column intent to one operation-specific Field Definition. */
export type SqlFieldDefinition<Field extends FieldDefinition> = Field extends FieldSchema
  ? Field
  : Field & {
      readonly column?: SqlColumnDefinition<
        Exclude<FieldOutput<SelectFieldSchema<Field>>, undefined>
      >;
    };

type SqlTableForDefinition<Definition extends RecordDefinition> = Omit<
  SqlTableDefinition,
  "primaryKey"
> & {
  readonly primaryKey?: readonly [
    Extract<keyof Definition["fields"], string>,
    ...Extract<keyof Definition["fields"], string>[],
  ];
};

/** One base Record Definition widened with portable and database-specific SQL intent. */
export type SqlRecordDefinition<Definition extends RecordDefinition> = Omit<
  Definition,
  "fields"
> & {
  readonly table?: SqlTableForDefinition<Definition>;
  readonly fields: {
    readonly [Name in keyof Definition["fields"]]: SqlFieldDefinition<Definition["fields"][Name]>;
  };
};

/** Stable code for one SQL Record definition issue. */
export type SqlDefinitionIssueCode =
  | "invalid-definition"
  | "invalid-name"
  | "duplicate-name"
  | "conflicting-contribution"
  | "column-type-required"
  | "invalid-column-type"
  | "invalid-column-default"
  | "invalid-database-options"
  | "invalid-override"
  | "incompatible-override"
  | "invalid-primary-key";

/** One normalized issue found while defining SQL Records. */
export interface SqlDefinitionIssue {
  /** Stable issue classification. */
  readonly code: SqlDefinitionIssueCode;
  /** Definition-local path to the invalid value. */
  readonly path: readonly (string | number)[];
  /** Searchable diagnostic that does not contain complete Record data. */
  readonly message: string;
}

/** Expected aggregate failure for invalid SQL Record definitions. */
export class SqlDefinitionError extends Error {
  /** Stable error class name. */
  override readonly name = "SqlDefinitionError";
  /** All independent definition issues in deterministic traversal order. */
  readonly issues: readonly SqlDefinitionIssue[];

  /** Create one immutable aggregate SQL definition failure. */
  constructor(issues: readonly SqlDefinitionIssue[]) {
    super(
      `SQL Record definition failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    );
    this.issues = Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          code: issue.code,
          path: Object.freeze([...issue.path]),
          message: issue.message,
        }),
      ),
    );
  }
}

/** Opaque resolved SQL column identifier. */
export interface SqlFieldReference extends SqlStatement<never> {}

/** Opaque resolved SQL table identifier and its field identifiers. */
export interface SqlRecordReference<
  Definition extends RecordDefinition,
> extends SqlStatement<never> {
  /** Resolved physical column identifiers keyed by logical Record field name. */
  readonly fields: {
    readonly [Name in keyof Definition["fields"]]: SqlFieldReference;
  };
}

/** Resolved SQL table and column references keyed by Record catalog name. */
export type SqlRecordReferences<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: SqlRecordReference<Definitions[Name]>;
};

/** Final adapter-facing expression and storage mode for one generated SQL column. */
export interface SqlResolvedGeneratedColumn {
  readonly expression: SqlStatement<never>;
  readonly mode: "virtual" | "stored";
}
const sqlOpaqueFormatSymbol = Symbol.for("@commissary/store/sql-opaque-format");
const sqlOpaqueFormat = "commissary-sql-opaque@1";

/** Portable SQL storage families inferred from Select Schema output. */
export type SqlPortableTypeName = "text" | "number" | "integer" | "boolean" | "json";

/** Cross-copy runtime format for an opaque SQL column type. */
export interface SqlColumnTypeFormat {
  readonly format: typeof sqlOpaqueFormat;
  readonly kind: "column-type";
  readonly dialect: "portable" | "postgres" | "mysql" | "sqlite";
  readonly type: string;
  readonly identity?: symbol;
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Compatible cross-copy runtime format for one opaque SQL literal. */
export interface SqlLiteralFormat {
  readonly format: typeof sqlOpaqueFormat;
  readonly kind: "literal";
  readonly value: SqlLiteralValue;
}

function isRecordContainer(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldSchemaValue(value: unknown): value is FieldSchema {
  if (!isRecordContainer(value) || !Object.hasOwn(value, "~standard")) {
    return false;
  }
  const standard = Reflect.get(value, "~standard");
  return (
    isRecordContainer(standard) &&
    Reflect.get(standard, "version") === 1 &&
    typeof Reflect.get(standard, "validate") === "function"
  );
}

function snapshotSqlContainerValue(value: unknown): unknown {
  if (isFieldSchemaValue(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(snapshotSqlContainerValue));
  }
  if (!isRecordContainer(value)) {
    return value;
  }
  return Object.freeze(
    Object.fromEntries(
      Reflect.ownKeys(value).map((key) => [
        key,
        snapshotSqlContainerValue(Reflect.get(value, key)),
      ]),
    ),
  );
}

function createSqlOpaqueValue(format: SqlColumnTypeFormat | SqlLiteralFormat): object {
  return Object.freeze({
    [sqlOpaqueFormatSymbol]: Object.freeze(format),
  });
}

/** Create one compatible package-owned SQL column type for a database helper. */
export function createSqlColumnType<Value extends JsonValue>(
  format: Omit<SqlColumnTypeFormat, "format" | "kind">,
): SqlColumnType<Value> {
  return createSqlOpaqueValue({
    format: sqlOpaqueFormat,
    kind: "column-type",
    ...format,
  });
}

/** Read and validate the compatible cross-copy format of one SQL column type. */
export function readSqlColumnTypeFormat(value: unknown): SqlColumnTypeFormat | undefined {
  if (!isRecordContainer(value) || !Object.isFrozen(value)) {
    return undefined;
  }
  const format = Reflect.get(value, sqlOpaqueFormatSymbol);
  if (
    !isRecordContainer(format) ||
    !Object.isFrozen(format) ||
    Reflect.get(format, "format") !== sqlOpaqueFormat ||
    Reflect.get(format, "kind") !== "column-type"
  ) {
    return undefined;
  }
  const dialect = Reflect.get(format, "dialect");
  const type = Reflect.get(format, "type");
  if (
    (dialect !== "portable" &&
      dialect !== "postgres" &&
      dialect !== "mysql" &&
      dialect !== "sqlite") ||
    typeof type !== "string" ||
    type.length === 0
  ) {
    return undefined;
  }
  const identity = Reflect.get(format, "identity");
  const options = Reflect.get(format, "options");
  if (
    (identity !== undefined && typeof identity !== "symbol") ||
    (options !== undefined && (!isRecordContainer(options) || !Object.isFrozen(options)))
  ) {
    return undefined;
  }
  return format as unknown as SqlColumnTypeFormat;
}

/** Read and validate the compatible cross-copy format of one SQL literal. */
export function readSqlLiteralFormat(value: unknown): SqlLiteralFormat | undefined {
  if (!isRecordContainer(value) || !Object.isFrozen(value)) {
    return undefined;
  }
  const format = Reflect.get(value, sqlOpaqueFormatSymbol);
  if (
    !isRecordContainer(format) ||
    !Object.isFrozen(format) ||
    Reflect.get(format, "format") !== sqlOpaqueFormat ||
    Reflect.get(format, "kind") !== "literal"
  ) {
    return undefined;
  }
  const literal = Reflect.get(format, "value");
  return isValidSqlLiteralValue(literal) ? (format as unknown as SqlLiteralFormat) : undefined;
}

function isValidSqlName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isValidSqlLiteralValue(value: unknown): value is SqlLiteralValue {
  if (typeof value === "string") {
    return !value.includes("\0");
  }
  if (typeof value === "boolean") {
    return true;
  }
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  );
}

function assertMetadataObject(owner: string, key: string, value: unknown): void {
  if (!isRecordContainer(value)) {
    throw new TypeError(`SQL ${owner} helper option '${key}' must be an object`);
  }
}

function defineSqlTable<const Table extends SqlTableDefinition>(table: Table): Readonly<Table> {
  if (!isRecordContainer(table)) {
    throw new TypeError("SQL table helper requires an options object");
  }
  if (Object.hasOwn(table, "name") && !isValidSqlName(Reflect.get(table, "name"))) {
    throw new TypeError("SQL table helper option 'name' must be a nonempty NUL-free string");
  }
  if (Object.hasOwn(table, "primaryKey")) {
    const primaryKey = Reflect.get(table, "primaryKey");
    if (!Array.isArray(primaryKey) || primaryKey.length === 0) {
      throw new TypeError("SQL table helper option 'primaryKey' must be a nonempty string tuple");
    }
    const names = new Set<string>();
    for (const field of primaryKey) {
      if (typeof field !== "string" || field.length === 0 || names.has(field)) {
        throw new TypeError(
          "SQL table helper option 'primaryKey' must contain unique nonempty field names",
        );
      }
      names.add(field);
    }
  }
  for (const database of ["postgres", "mysql", "sqlite"] as const) {
    if (Object.hasOwn(table, database)) {
      assertMetadataObject("table", database, Reflect.get(table, database));
    }
  }
  return snapshotSqlContainerValue(table) as Readonly<Table>;
}

/** Internal shape accepted by the portable SQL column helper. */
export interface SqlColumnHelperOptions {
  readonly name?: string;
  readonly type?: SqlColumnType<never>;
  readonly default?: SqlLiteral<SqlLiteralValue>;
  readonly notNull?: boolean;
  readonly postgres?: object;
  readonly mysql?: object;
  readonly sqlite?: object;
}

/** Infer the selected value family from one portable SQL column helper input. */
export type SqlColumnHelperValue<Column extends SqlColumnHelperOptions> = Column extends {
  readonly type: SqlColumnType<infer Value extends JsonValue>;
}
  ? Value
  : JsonValue;

/** Reject a portable SQL literal default that conflicts with its explicit column type. */
export type CompatibleSqlColumnHelper<Column extends SqlColumnHelperOptions> = Column extends {
  readonly default: SqlLiteral<infer Default>;
}
  ? Default extends Extract<SqlColumnHelperValue<Column>, SqlLiteralValue>
    ? unknown
    : never
  : unknown;

function defineSqlColumn<const Column extends SqlColumnHelperOptions>(
  column: Column & CompatibleSqlColumnHelper<Column>,
): Readonly<Column> {
  if (!isRecordContainer(column)) {
    throw new TypeError("SQL column helper requires an options object");
  }
  if (Object.hasOwn(column, "name") && !isValidSqlName(Reflect.get(column, "name"))) {
    throw new TypeError("SQL column helper option 'name' must be a nonempty NUL-free string");
  }
  if (
    Object.hasOwn(column, "type") &&
    readSqlColumnTypeFormat(Reflect.get(column, "type")) === undefined
  ) {
    throw new TypeError("SQL column helper option 'type' has an incompatible opaque format");
  }
  if (
    Object.hasOwn(column, "default") &&
    readSqlLiteralFormat(Reflect.get(column, "default")) === undefined
  ) {
    throw new TypeError("SQL column helper option 'default' has an incompatible opaque format");
  }
  if (Object.hasOwn(column, "notNull") && typeof Reflect.get(column, "notNull") !== "boolean") {
    throw new TypeError("SQL column helper option 'notNull' must be a boolean");
  }
  for (const database of ["postgres", "mysql", "sqlite"] as const) {
    if (Object.hasOwn(column, database)) {
      assertMetadataObject("column", database, Reflect.get(column, database));
    }
  }
  return snapshotSqlContainerValue(column) as Readonly<Column>;
}

const portableTextType = createSqlColumnType<string | null>({
  dialect: "portable",
  type: "text",
});
const portableNumberType = createSqlColumnType<number | null>({
  dialect: "portable",
  type: "number",
});
const portableIntegerType = createSqlColumnType<number | null>({
  dialect: "portable",
  type: "integer",
});
const portableBooleanType = createSqlColumnType<boolean | null>({
  dialect: "portable",
  type: "boolean",
});
const portableJsonType = createSqlColumnType<JsonValue>({
  dialect: "portable",
  type: "json",
});

function defineSqlLiteral<const Value extends SqlLiteralValue>(value: Value): SqlLiteral<Value> {
  if (!isValidSqlLiteralValue(value)) {
    throw new TypeError("SQL literal helper requires a NUL-free string, finite number, or boolean");
  }
  return createSqlOpaqueValue({
    format: sqlOpaqueFormat,
    kind: "literal",
    value,
  });
}

/** Portable SQL metadata, type, and literal constructors used by the public SQL helper. */
export const sqlRecordHelpers = Object.freeze({
  /** Snapshot portable table metadata. */
  table: defineSqlTable,
  /** Snapshot portable column metadata. */
  column: defineSqlColumn,
  /** Accept selected strings and selected null. */
  text: (): SqlColumnType<string | null> => portableTextType,
  /** Accept finite selected JavaScript numbers and selected null. */
  number: (): SqlColumnType<number | null> => portableNumberType,
  /** Accept safe selected JavaScript integers and selected null. */
  integer: (): SqlColumnType<number | null> => portableIntegerType,
  /** Accept selected booleans and selected null. */
  boolean: (): SqlColumnType<boolean | null> => portableBooleanType,
  /** Accept JSON values while preserving selected JSON null separately from SQL NULL. */
  json: (): SqlColumnType<JsonValue> => portableJsonType,
  /** Create one portable scalar database default. */
  literal: defineSqlLiteral,
});

function makeSqlDefinitionIssue(
  code: SqlDefinitionIssueCode,
  path: readonly (string | number)[],
  message: string,
): SqlDefinitionIssue {
  return { code, path, message };
}
function hasSqlColumnMetadata(field: FieldDefinition): boolean {
  return !isFieldSchemaValue(field) && Object.hasOwn(field, "column");
}

function sqlColumnMetadata(field: FieldDefinition): unknown {
  return hasSqlColumnMetadata(field) ? Reflect.get(field, "column") : undefined;
}

function validateDatabaseMetadataObjects(
  value: Readonly<Record<PropertyKey, unknown>>,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): void {
  for (const database of ["postgres", "mysql", "sqlite"] as const) {
    if (Object.hasOwn(value, database) && !isRecordContainer(Reflect.get(value, database))) {
      issues.push(
        makeSqlDefinitionIssue(
          "invalid-database-options",
          [...path, database],
          `SQL Record database options '${database}' must be an object`,
        ),
      );
    }
  }
}

function validateSqlRecordMetadata(
  definition: RecordDefinition,
  path: readonly (string | number)[],
): SqlDefinitionIssue[] {
  const issues: SqlDefinitionIssue[] = [];
  let table: Readonly<Record<PropertyKey, unknown>> | undefined;
  if (Object.hasOwn(definition, "table")) {
    const candidate = Reflect.get(definition, "table");
    if (!isRecordContainer(candidate)) {
      issues.push(
        makeSqlDefinitionIssue(
          "invalid-definition",
          [...path, "table"],
          "SQL Record table metadata must be an object",
        ),
      );
    } else {
      table = candidate;
      if (Object.hasOwn(table, "name") && !isValidSqlName(Reflect.get(table, "name"))) {
        issues.push(
          makeSqlDefinitionIssue(
            "invalid-name",
            [...path, "table", "name"],
            "SQL Record table name must be a nonempty NUL-free string",
          ),
        );
      }
      validateDatabaseMetadataObjects(table, [...path, "table"], issues);
    }
  }

  const columnNames = new Map<string, string>();
  for (const fieldName of Object.keys(definition.fields)) {
    const field = definition.fields[fieldName];
    if (field === undefined) {
      continue;
    }
    const columnPath = [...path, "fields", fieldName, "column"] as const;
    if (!hasSqlColumnMetadata(field)) {
      if (!isValidSqlName(fieldName)) {
        issues.push(
          makeSqlDefinitionIssue(
            "invalid-name",
            [...columnPath, "name"],
            `SQL Record field '${String(fieldName)}' does not provide a valid physical column name`,
          ),
        );
      } else {
        const earlier = columnNames.get(fieldName);
        if (earlier === undefined) {
          columnNames.set(fieldName, fieldName);
        } else {
          issues.push(
            makeSqlDefinitionIssue(
              "duplicate-name",
              [...columnPath, "name"],
              `SQL Record column name '${fieldName}' conflicts with field '${earlier}'`,
            ),
          );
        }
      }
      continue;
    }
    const candidate = sqlColumnMetadata(field);
    if (!isRecordContainer(candidate)) {
      issues.push(
        makeSqlDefinitionIssue(
          "invalid-definition",
          columnPath,
          `SQL Record field '${fieldName}' column metadata must be an object`,
        ),
      );
      continue;
    }
    const physicalName = Object.hasOwn(candidate, "name")
      ? Reflect.get(candidate, "name")
      : fieldName;
    if (!isValidSqlName(physicalName)) {
      issues.push(
        makeSqlDefinitionIssue(
          "invalid-name",
          [...columnPath, "name"],
          `SQL Record field '${fieldName}' column name must be a nonempty NUL-free string`,
        ),
      );
    } else {
      const earlier = columnNames.get(physicalName);
      if (earlier === undefined) {
        columnNames.set(physicalName, fieldName);
      } else {
        issues.push(
          makeSqlDefinitionIssue(
            "duplicate-name",
            [...columnPath, "name"],
            `SQL Record column name '${physicalName}' conflicts with field '${earlier}'`,
          ),
        );
      }
    }
    if (
      Object.hasOwn(candidate, "type") &&
      readSqlColumnTypeFormat(Reflect.get(candidate, "type")) === undefined
    ) {
      issues.push(
        makeSqlDefinitionIssue(
          "invalid-column-type",
          [...columnPath, "type"],
          `SQL Record field '${fieldName}' has an incompatible column type format`,
        ),
      );
    }
    if (
      Object.hasOwn(candidate, "default") &&
      readSqlLiteralFormat(Reflect.get(candidate, "default")) === undefined
    ) {
      issues.push(
        makeSqlDefinitionIssue(
          "invalid-column-default",
          [...columnPath, "default"],
          `SQL Record field '${fieldName}' has an incompatible portable default format`,
        ),
      );
    }
    if (
      Object.hasOwn(candidate, "notNull") &&
      typeof Reflect.get(candidate, "notNull") !== "boolean"
    ) {
      issues.push(
        makeSqlDefinitionIssue(
          "invalid-database-options",
          [...columnPath, "notNull"],
          `SQL Record field '${fieldName}' notNull option must be a boolean`,
        ),
      );
    }
    validateDatabaseMetadataObjects(candidate, columnPath, issues);
  }

  if (table !== undefined && Object.hasOwn(table, "primaryKey")) {
    const primaryKey = Reflect.get(table, "primaryKey");
    const primaryKeyPath = [...path, "table", "primaryKey"] as const;
    if (!Array.isArray(primaryKey) || primaryKey.length === 0) {
      issues.push(
        makeSqlDefinitionIssue(
          "invalid-primary-key",
          primaryKeyPath,
          "SQL Record primary key must be a nonempty field-name tuple",
        ),
      );
    } else {
      const names = new Set<string>();
      for (const [index, fieldName] of primaryKey.entries()) {
        if (typeof fieldName !== "string" || fieldName.length === 0) {
          issues.push(
            makeSqlDefinitionIssue(
              "invalid-primary-key",
              [...primaryKeyPath, index],
              "SQL Record primary-key entries must be nonempty field names",
            ),
          );
          continue;
        }
        if (names.has(fieldName)) {
          issues.push(
            makeSqlDefinitionIssue(
              "invalid-primary-key",
              [...primaryKeyPath, index],
              `SQL Record primary key repeats field '${fieldName}'`,
            ),
          );
          continue;
        }
        names.add(fieldName);
        const field = definition.fields[fieldName];
        if (field === undefined) {
          issues.push(
            makeSqlDefinitionIssue(
              "invalid-primary-key",
              [...primaryKeyPath, index],
              `SQL Record primary key names unknown field '${fieldName}'`,
            ),
          );
          continue;
        }
        const hasColumn = hasSqlColumnMetadata(field);
        const columnValue = sqlColumnMetadata(field);
        if (hasColumn && !isRecordContainer(columnValue)) {
          continue;
        }
        const column = isRecordContainer(columnValue) ? columnValue : undefined;
        const explicitNotNull =
          column !== undefined && Object.hasOwn(column, "notNull")
            ? Reflect.get(column, "notNull")
            : undefined;
        if (explicitNotNull === false) {
          issues.push(
            makeSqlDefinitionIssue(
              "invalid-primary-key",
              [...primaryKeyPath, index],
              `SQL Record primary-key field '${fieldName}' explicitly allows SQL NULL`,
            ),
          );
          continue;
        }
        if (explicitNotNull === true) {
          continue;
        }
        const explicitType =
          column !== undefined && Object.hasOwn(column, "type")
            ? Reflect.get(column, "type")
            : undefined;
        if (explicitType !== undefined && portableTypeName(explicitType) === undefined) {
          continue;
        }
        const evidence = reflectSqlSelectStorage(isFieldSchemaValue(field) ? field : field.select);
        const type = explicitType === undefined ? evidence?.type : portableTypeName(explicitType);
        const notNull =
          evidence !== undefined &&
          evidence.presence === "required" &&
          (type === "json" || !evidence.selectedNull);
        if (!notNull) {
          issues.push(
            makeSqlDefinitionIssue(
              "invalid-primary-key",
              [...primaryKeyPath, index],
              `SQL Record primary-key field '${fieldName}' can remain missing or SQL NULL`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

function defineSqlRecord<Definition extends RecordDefinition>(
  definition: Definition &
    SqlRecordDefinition<Definition> & {
      readonly fields: RoundTripFieldDefinitions<Definition["fields"]>;
    },
): Readonly<Definition & SqlRecordDefinition<Definition>> {
  let snapshot: Definition;
  try {
    snapshot = StoreRecord.define(definition);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown Record structure";
    throw new SqlDefinitionError([
      makeSqlDefinitionIssue(
        "invalid-definition",
        [],
        `SQL Record definition is invalid: ${message}`,
      ),
    ]);
  }
  const issues = validateSqlRecordMetadata(snapshot, []);
  if (issues.length > 0) {
    throw new SqlDefinitionError(issues);
  }
  // SAFETY: StoreRecord.define snapshots the same definition without removing SQL metadata.
  return snapshot as Readonly<Definition & SqlRecordDefinition<Definition>>;
}

/** Constructor for immutable, unbound SQL Record Definitions. */
export const SqlRecord = Object.freeze({
  /** Snapshot SQL metadata and package-owned containers without freezing Field Schemas. */
  define: defineSqlRecord,
});

type JsonSchemaCategory = SqlPortableTypeName | "null" | "unknown";

interface ReducedJsonSchema {
  readonly categories: ReadonlySet<JsonSchemaCategory>;
  readonly valid: boolean;
}

/** Clear portable storage evidence reflected from one Select Field Schema. */
export interface SqlSelectStorageEvidence {
  readonly type: SqlPortableTypeName;
  readonly selectedNull: boolean;
  readonly presence: "required" | "unknown";
}

function jsonSchemaCategory(value: JsonValue): JsonSchemaCategory {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return "text";
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? "integer" : "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "json";
}

function isJsonValueArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value) && value.every(isJsonValue);
}

function unionJsonSchemaCategories(members: readonly ReducedJsonSchema[]): ReducedJsonSchema {
  if (members.some((member) => !member.valid)) {
    return { categories: new Set(), valid: false };
  }
  const categories = new Set<JsonSchemaCategory>();
  for (const member of members) {
    for (const category of member.categories) {
      categories.add(category);
    }
  }
  return { categories, valid: categories.size > 0 };
}

function intersectJsonSchemaCategory(
  left: JsonSchemaCategory,
  right: JsonSchemaCategory,
): JsonSchemaCategory | undefined {
  if (left === "unknown") {
    return right;
  }
  if (right === "unknown") {
    return left;
  }
  if (left === right) {
    return left;
  }
  if ((left === "integer" && right === "number") || (left === "number" && right === "integer")) {
    return "integer";
  }
  return undefined;
}

function intersectJsonSchemaCategories(members: readonly ReducedJsonSchema[]): ReducedJsonSchema {
  if (members.some((member) => !member.valid)) {
    return { categories: new Set(), valid: false };
  }
  let categories = new Set<JsonSchemaCategory>(["unknown"]);
  for (const member of members) {
    const intersection = new Set<JsonSchemaCategory>();
    for (const left of categories) {
      for (const right of member.categories) {
        const category = intersectJsonSchemaCategory(left, right);
        if (category !== undefined) {
          intersection.add(category);
        }
      }
    }
    categories = intersection;
    if (categories.size === 0) {
      return { categories, valid: false };
    }
  }
  return { categories, valid: true };
}

function resolveLocalJsonSchemaReference(
  root: JsonValue,
  reference: string,
): JsonValue | undefined {
  if (!reference.startsWith("#")) {
    return undefined;
  }
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  if (pointer.length === 0) {
    return root;
  }
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  let current: JsonValue = root;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) {
        return undefined;
      }
      const next = current[Number(segment)];
      if (next === undefined) {
        return undefined;
      }
      current = next;
      continue;
    }
    if (!isRecordContainer(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = Reflect.get(current, segment) as JsonValue;
  }
  return current;
}

function reduceJsonSchema(
  schema: JsonValue,
  root: JsonValue,
  activeReferences: ReadonlySet<string>,
): ReducedJsonSchema {
  if (typeof schema === "boolean") {
    return schema
      ? { categories: new Set(["unknown"]), valid: true }
      : { categories: new Set(), valid: false };
  }
  if (!isRecordContainer(schema)) {
    return { categories: new Set(), valid: false };
  }

  const constraints: ReducedJsonSchema[] = [];
  if (Object.hasOwn(schema, "$ref")) {
    const reference = Reflect.get(schema, "$ref");
    if (typeof reference !== "string" || activeReferences.has(reference)) {
      return { categories: new Set(), valid: false };
    }
    const target = resolveLocalJsonSchemaReference(root, reference);
    if (target === undefined) {
      return { categories: new Set(), valid: false };
    }
    constraints.push(reduceJsonSchema(target, root, new Set([...activeReferences, reference])));
  }

  if (Object.hasOwn(schema, "type")) {
    const value = Reflect.get(schema, "type");
    const types: readonly unknown[] = Array.isArray(value) ? value : [value];
    const members: ReducedJsonSchema[] = [];
    for (const type of types) {
      let category: JsonSchemaCategory | undefined;
      switch (type) {
        case "string":
          category = "text";
          break;
        case "number":
          category = "number";
          break;
        case "integer":
          category = "integer";
          break;
        case "boolean":
          category = "boolean";
          break;
        case "object":
        case "array":
          category = "json";
          break;
        case "null":
          category = "null";
          break;
      }
      if (category === undefined) {
        return { categories: new Set(), valid: false };
      }
      members.push({ categories: new Set([category]), valid: true });
    }
    constraints.push(unionJsonSchemaCategories(members));
  }

  if (Object.hasOwn(schema, "const")) {
    const value = Reflect.get(schema, "const");
    if (!isJsonValue(value)) {
      return { categories: new Set(), valid: false };
    }
    constraints.push({ categories: new Set([jsonSchemaCategory(value)]), valid: true });
  }

  if (Object.hasOwn(schema, "enum")) {
    const values = Reflect.get(schema, "enum");
    if (!isJsonValueArray(values) || values.length === 0) {
      return { categories: new Set(), valid: false };
    }
    constraints.push({
      categories: new Set(values.map(jsonSchemaCategory)),
      valid: true,
    });
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!Object.hasOwn(schema, keyword)) {
      continue;
    }
    const alternatives = Reflect.get(schema, keyword);
    if (!isJsonValueArray(alternatives) || alternatives.length === 0) {
      return { categories: new Set(), valid: false };
    }
    constraints.push(
      unionJsonSchemaCategories(
        alternatives.map((alternative) => reduceJsonSchema(alternative, root, activeReferences)),
      ),
    );
  }

  if (Object.hasOwn(schema, "allOf")) {
    const alternatives = Reflect.get(schema, "allOf");
    if (!isJsonValueArray(alternatives)) {
      return { categories: new Set(), valid: false };
    }
    constraints.push(
      intersectJsonSchemaCategories(
        alternatives.map((alternative) => reduceJsonSchema(alternative, root, activeReferences)),
      ),
    );
  }

  return constraints.length === 0
    ? { categories: new Set(["unknown"]), valid: true }
    : intersectJsonSchemaCategories(constraints);
}

function normalizeReflectedStorageEvidence(
  converted: unknown,
): SqlSelectStorageEvidence | undefined {
  if (!isJsonValue(converted) || converted === null || Array.isArray(converted)) {
    return undefined;
  }
  const reduced = reduceJsonSchema(converted, converted, new Set());
  if (!reduced.valid || reduced.categories.has("unknown")) {
    return undefined;
  }
  const selectedNull = reduced.categories.has("null");
  const families = new Set(reduced.categories);
  families.delete("null");
  if (families.has("integer") && families.has("number")) {
    families.delete("integer");
  }
  if (families.size !== 1) {
    return undefined;
  }
  const [type] = families;
  if (type === undefined || type === "null" || type === "unknown") {
    return undefined;
  }
  return Object.freeze({ type, selectedNull, presence: "required" });
}

function standardJsonSchemaOutputConverter(
  schema: FieldSchema,
): StandardJSONSchemaV1.Converter | undefined {
  const standard = schema["~standard"];
  const converter = Reflect.get(standard, "jsonSchema");
  if (!isRecordContainer(converter)) {
    return undefined;
  }
  const output = Reflect.get(converter, "output");
  return typeof output === "function"
    ? (converter as unknown as StandardJSONSchemaV1.Converter)
    : undefined;
}

/** Reflect one clear portable storage family from a Select Field Schema output converter. */
export function reflectSqlSelectStorage(schema: FieldSchema): SqlSelectStorageEvidence | undefined {
  const converter = standardJsonSchemaOutputConverter(schema);
  if (converter === undefined) {
    return undefined;
  }
  for (const target of ["draft-2020-12", "draft-07"] as const) {
    try {
      const evidence = normalizeReflectedStorageEvidence(converter.output({ target }));
      if (evidence !== undefined) {
        return evidence;
      }
    } catch {
      // A converter can reject one target. The required fallback is attempted below.
    }
  }
  return undefined;
}

function portableTypeName(value: unknown): SqlPortableTypeName | undefined {
  const format = readSqlColumnTypeFormat(value);
  if (format === undefined || format.dialect !== "portable") {
    return undefined;
  }
  switch (format.type) {
    case "text":
    case "number":
    case "integer":
    case "boolean":
    case "json":
      return format.type;
    default:
      return undefined;
  }
}

type AnyPortableSqlColumnType =
  | SqlColumnType<string | null>
  | SqlColumnType<number | null>
  | SqlColumnType<boolean | null>
  | SqlColumnType<JsonValue>;

function portableTypeValue(type: SqlPortableTypeName): AnyPortableSqlColumnType {
  switch (type) {
    case "text":
      return portableTextType;
    case "number":
      return portableNumberType;
    case "integer":
      return portableIntegerType;
    case "boolean":
      return portableBooleanType;
    case "json":
      return portableJsonType;
  }
}

function literalMatchesPortableType(value: SqlLiteralValue, type: SqlPortableTypeName): boolean {
  switch (type) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
      return true;
  }
}

/** Adapter-facing portable facts for one resolved SQL Record field. */
export interface SqlPortableFieldResolution<Field extends FieldDefinition = FieldDefinition> {
  readonly name: string;
  readonly schema: SelectFieldSchema<Field>;
  readonly type: SqlColumnType<Exclude<FieldOutput<SelectFieldSchema<Field>>, undefined>>;
  readonly portableType: SqlPortableTypeName;
  readonly default?: SqlLiteral<
    Extract<Exclude<FieldOutput<SelectFieldSchema<Field>>, undefined>, SqlLiteralValue>
  >;
  readonly notNull: boolean;
  readonly selectedNull: boolean;
  readonly selectedPresence: "required" | "unknown";
}

/** Adapter-facing portable facts for one resolved SQL Record. */
export interface SqlPortableRecordResolution<Definition extends RecordDefinition> {
  readonly name: string;
  readonly definition: Definition;
  readonly fields: {
    readonly [Name in keyof Definition["fields"]]: SqlPortableFieldResolution<
      Definition["fields"][Name]
    >;
  };
  readonly primaryKey: readonly (keyof Definition["fields"] & string)[];
}

/** Adapter-facing portable facts for one effective SQL Record catalog. */
export interface SqlPortableRecordsResolution<Definitions extends RecordDefinitions> {
  readonly definitions: Definitions;
  readonly records: {
    readonly [Name in keyof Definitions]: SqlPortableRecordResolution<Definitions[Name]>;
  };
}

interface RuntimeSqlPortableFieldResolution {
  readonly name: string;
  readonly schema: FieldSchema;
  readonly type: AnyPortableSqlColumnType;
  readonly portableType: SqlPortableTypeName;
  readonly default?: SqlLiteral<SqlLiteralValue>;
  readonly notNull: boolean;
  readonly selectedNull: boolean;
  readonly selectedPresence: "required" | "unknown";
}

interface RuntimeSqlPortableRecordResolution {
  readonly name: string;
  readonly definition: RecordDefinition;
  readonly fields: Readonly<Record<string, RuntimeSqlPortableFieldResolution>>;
  readonly primaryKey: readonly string[];
}

interface RuntimeSqlPortableRecordsResolution {
  readonly definitions: RecordDefinitions;
  readonly records: Readonly<Record<string, RuntimeSqlPortableRecordResolution>>;
}

function resolvePortableSqlRecordsRuntime(
  definitions: RecordDefinitions,
): RuntimeSqlPortableRecordsResolution {
  const issues: SqlDefinitionIssue[] = [];
  const records = new Map<string, RuntimeSqlPortableRecordResolution>();
  const tableNames = new Map<string, string>();

  for (const [recordName, definition] of Object.entries(definitions)) {
    const recordPath = ["records", recordName] as const;
    issues.push(...validateSqlRecordMetadata(definition, recordPath));
    const tableValue = Object.hasOwn(definition, "table")
      ? Reflect.get(definition, "table")
      : undefined;
    const table = isRecordContainer(tableValue) ? tableValue : undefined;
    const tableName =
      table !== undefined && Object.hasOwn(table, "name") ? Reflect.get(table, "name") : recordName;
    if (!isValidSqlName(tableName)) {
      continue;
    }

    const resolvedFields = new Map<string, RuntimeSqlPortableFieldResolution>();
    for (const [fieldName, field] of Object.entries(definition.fields)) {
      const fieldPath = [...recordPath, "fields", fieldName] as const;
      const hasColumn = hasSqlColumnMetadata(field);
      const columnValue = sqlColumnMetadata(field);
      if (hasColumn && !isRecordContainer(columnValue)) {
        continue;
      }
      const column = isRecordContainer(columnValue) ? columnValue : undefined;
      const columnName =
        column !== undefined && Object.hasOwn(column, "name")
          ? Reflect.get(column, "name")
          : fieldName;
      if (!isValidSqlName(columnName)) {
        continue;
      }

      const explicitType =
        column !== undefined && Object.hasOwn(column, "type")
          ? Reflect.get(column, "type")
          : undefined;
      let type: SqlPortableTypeName | undefined;
      const evidence = reflectSqlSelectStorage(isFieldSchemaValue(field) ? field : field.select);
      if (explicitType !== undefined) {
        const format = readSqlColumnTypeFormat(explicitType);
        if (format !== undefined) {
          type = portableTypeName(explicitType);
          if (type === undefined) {
            issues.push(
              makeSqlDefinitionIssue(
                "invalid-column-type",
                [...fieldPath, "column", "type"],
                `SQL Record field '${fieldName}' does not provide a portable column type`,
              ),
            );
          }
        }
      } else {
        type = evidence?.type;
        if (type === undefined) {
          issues.push(
            makeSqlDefinitionIssue(
              "column-type-required",
              [...fieldPath, "column", "type"],
              `SQL Record field '${fieldName}' requires an explicit SQL column type`,
            ),
          );
        }
      }
      if (type === undefined) {
        continue;
      }

      let resolvedDefault: SqlLiteral<SqlLiteralValue> | undefined;
      if (column !== undefined && Object.hasOwn(column, "default")) {
        const defaultValue = Reflect.get(column, "default");
        const format = readSqlLiteralFormat(defaultValue);
        if (format !== undefined) {
          if (!literalMatchesPortableType(format.value, type)) {
            issues.push(
              makeSqlDefinitionIssue(
                "invalid-column-default",
                [...fieldPath, "column", "default"],
                `SQL Record field '${fieldName}' default does not match portable type '${type}'`,
              ),
            );
          } else {
            // SAFETY: readSqlLiteralFormat accepted the package-owned opaque literal format.
            resolvedDefault = defaultValue as SqlLiteral<SqlLiteralValue>;
          }
        }
      }

      const explicitNotNull =
        column !== undefined && Object.hasOwn(column, "notNull")
          ? Reflect.get(column, "notNull")
          : undefined;
      const selectedNull = evidence?.selectedNull ?? false;
      const selectedPresence = evidence?.presence ?? "unknown";
      const inferredNotNull = selectedPresence === "required" && (type === "json" || !selectedNull);
      const notNull = typeof explicitNotNull === "boolean" ? explicitNotNull : inferredNotNull;
      if (explicitNotNull === true && selectedNull && type !== "json") {
        issues.push(
          makeSqlDefinitionIssue(
            "invalid-database-options",
            [...fieldPath, "column", "notNull"],
            `SQL Record field '${fieldName}' Select Schema permits null but the column is NOT NULL`,
          ),
        );
        continue;
      }

      const resolution = Object.freeze({
        name: columnName,
        schema: isFieldSchemaValue(field) ? field : field.select,
        type: portableTypeValue(type),
        portableType: type,
        notNull,
        selectedNull,
        selectedPresence,
        ...(resolvedDefault === undefined ? {} : { default: resolvedDefault }),
      });
      resolvedFields.set(fieldName, resolution);
    }

    const primaryKeyValue = table?.primaryKey;
    const primaryKey = Array.isArray(primaryKeyValue)
      ? primaryKeyValue.filter((field): field is string => typeof field === "string")
      : [];

    const earlierTable = tableNames.get(tableName);
    if (earlierTable === undefined) {
      tableNames.set(tableName, recordName);
    } else {
      issues.push(
        makeSqlDefinitionIssue(
          "duplicate-name",
          [...recordPath, "table", "name"],
          `SQL Record table name '${tableName}' conflicts with Record '${earlierTable}'`,
        ),
      );
    }
    records.set(
      recordName,
      Object.freeze({
        name: tableName,
        definition,
        fields: Object.freeze(Object.fromEntries(resolvedFields)),
        primaryKey: Object.freeze(primaryKey),
      }),
    );
  }

  if (issues.length > 0) {
    throw new SqlDefinitionError(issues);
  }
  return Object.freeze({
    definitions,
    records: Object.freeze(Object.fromEntries(records)),
  });
}

/** Resolve portable SQL facts after Store-neutral contributions and overrides compose. */
export function resolvePortableSqlRecords<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions> = {},
>(options: {
  readonly records: Definitions & RoundTripRecordDefinitions<Definitions>;
  readonly overrides?: Overrides & CompatibleRecordOverrides<Definitions, Overrides>;
}): SqlPortableRecordsResolution<ApplyOverrides<Definitions, Overrides>> {
  let definitions: RecordDefinitions;
  try {
    const overrides =
      options.overrides ?? ({} as Overrides & CompatibleRecordOverrides<Definitions, Overrides>);
    definitions = applyRecordOverrides<Definitions, Overrides>(options.records, overrides);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown override structure";
    throw new SqlDefinitionError([
      makeSqlDefinitionIssue(
        "invalid-override",
        ["overrides"],
        `SQL Record override is invalid: ${message}`,
      ),
    ]);
  }
  // SAFETY: applyRecordOverrides and the resolver preserve every generic Record and Field key.
  return resolvePortableSqlRecordsRuntime(definitions) as unknown as SqlPortableRecordsResolution<
    ApplyOverrides<Definitions, Overrides>
  >;
}

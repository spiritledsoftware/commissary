import type { JsonValue } from "../../json.js";
import { hasOnlySqlContractKeys, isSqlContractObject } from "../contract-object.js";
import { defineSqlMetadataFormat } from "../opaque-format.js";
import {
  createSqlColumnType,
  readSqlColumnTypeFormat,
  readSqlLiteralFormat,
  type SqlColumnType,
  type SqlCustomEncodedValue,
  type SqlLiteral,
  type SqlLiteralValue,
} from "../record.js";
import {
  hasSqlStatementStructure,
  readSqlStatementFragments,
  type SqlStatement,
} from "../statement.js";
import {
  sqliteColumnOptionKeys,
  sqliteCustomTypeOptionKeys,
  sqliteGeneratedOptionKeys,
  sqliteRowidOptionKeys,
  sqliteTableOptionKeys,
} from "./sqlite-contract.js";

/** An opaque package-owned SQLite storage and conversion contract. */
export interface SqliteColumnType<in Value extends JsonValue> extends SqlColumnType<Value> {
  readonly "~commissary/sqlite-column-type"?: (value: Value) => void;
}

/** SQLite table-name refinements for one SQL Record. */
export interface SqliteTableDefinition {
  readonly name?: string | null;
}

/** SQLite ROWID reuse behavior for one `INTEGER PRIMARY KEY` column. */
export interface SqliteRowid {
  readonly reuse?: "allowed" | "forbidden";
}

/** SQLite generated-column expression and storage mode. */
export interface SqliteGenerated {
  readonly expression: SqlStatement<never>;
  readonly mode: "virtual" | "stored";
}

/** SQLite column refinements for one SQL Record Field. */
export interface SqliteColumnDefinition<Value extends JsonValue> {
  readonly name?: string | null;
  readonly type?: SqliteColumnType<Value> | null;
  readonly default?: SqlLiteral<Extract<Value, SqlLiteralValue>> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly rowid?: SqliteRowid | null;
  readonly generated?: SqliteGenerated | null;
}

/** One external SQLite type and its synchronous scalar converters. */
export interface SqliteCustomTypeOptions<Value extends JsonValue> {
  readonly type: SqlStatement<never>;
  readonly encode: (value: Value) => SqlCustomEncodedValue;
  readonly decode: (value: unknown) => Value;
}

type SqliteColumnHelperOptions = {
  readonly name?: string | null;
  readonly type?: SqliteColumnType<never> | null;
  readonly default?: SqlLiteral<SqlLiteralValue> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly rowid?: SqliteRowid | null;
  readonly generated?: SqliteGenerated | null;
};

type SqliteColumnHelperValue<Options extends SqliteColumnHelperOptions> = Options extends {
  readonly type: SqliteColumnType<infer Value extends JsonValue>;
}
  ? Value
  : JsonValue;

type CompatibleSqliteColumnHelper<Options extends SqliteColumnHelperOptions> = Options extends {
  readonly default: SqlLiteral<infer Default>;
}
  ? Default extends Extract<SqliteColumnHelperValue<Options>, SqlLiteralValue>
    ? unknown
    : never
  : unknown;

type SqliteMetadataKind = "sqlite-table" | "sqlite-column";

const sqliteMetadata = defineSqlMetadataFormat<SqliteMetadataKind>({
  format: "commissary-sqlite-metadata@1",
  kinds: new Set<SqliteMetadataKind>(["sqlite-table", "sqlite-column"]),
  owner: "SQLite",
});

/** Test one exact SQLite table or column name. */
export function isValidSqliteName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}

function assertOptionalLocalName(owner: string, value: unknown): void {
  if (value !== undefined && value !== null && !isValidSqliteName(value)) {
    throw new TypeError(`SQLite ${owner} helper option 'name' must be nonempty NUL-free Unicode`);
  }
}

/** Read one compatible package-owned SQLite metadata marker. */
export function readSqliteMetadataKind(value: unknown): SqliteMetadataKind | undefined {
  return sqliteMetadata.read(value);
}

function assertParameterFreeStatement(owner: string, key: string, value: unknown): void {
  const fragments = readSqlStatementFragments(value);
  if (
    fragments === undefined ||
    fragments.some((fragment) => fragment.kind === "parameter") ||
    !hasSqlStatementStructure(fragments)
  ) {
    throw new TypeError(
      `SQLite ${owner} helper option '${key}' requires a nonempty parameter-free SQL Statement`,
    );
  }
}

function assertRowid(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isSqlContractObject(value)) {
    throw new TypeError("SQLite column helper option 'rowid' must be an object");
  }
  if (!hasOnlySqlContractKeys(value, sqliteRowidOptionKeys)) {
    throw new TypeError("SQLite rowid helper received an unknown option");
  }
  if (
    Object.hasOwn(value, "reuse") &&
    Reflect.get(value, "reuse") !== "allowed" &&
    Reflect.get(value, "reuse") !== "forbidden"
  ) {
    throw new TypeError("SQLite ROWID reuse must be 'allowed' or 'forbidden'");
  }
}

function assertGenerated(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isSqlContractObject(value)) {
    throw new TypeError("SQLite column helper option 'generated' must be an object");
  }
  if (!hasOnlySqlContractKeys(value, sqliteGeneratedOptionKeys)) {
    throw new TypeError("SQLite generated helper received an unknown option");
  }
  assertParameterFreeStatement("generated", "expression", Reflect.get(value, "expression"));
  const mode = Reflect.get(value, "mode");
  if (mode !== "virtual" && mode !== "stored") {
    throw new TypeError("SQLite generated column mode must be 'virtual' or 'stored'");
  }
}

function defineSqliteTable<const Options extends SqliteTableDefinition>(
  options: Options,
): Readonly<Options> {
  if (!isSqlContractObject(options)) {
    throw new TypeError("SQLite table helper requires an options object");
  }
  if (!hasOnlySqlContractKeys(options, sqliteTableOptionKeys)) {
    throw new TypeError("SQLite table helper received an unknown option");
  }
  assertOptionalLocalName("table", Reflect.get(options, "name"));
  return sqliteMetadata.create("sqlite-table", options);
}

function defineSqliteColumn<const Options extends SqliteColumnHelperOptions>(
  options: Options & CompatibleSqliteColumnHelper<NoInfer<Options>>,
): Readonly<Options> {
  if (!isSqlContractObject(options)) {
    throw new TypeError("SQLite column helper requires an options object");
  }
  if (!hasOnlySqlContractKeys(options, sqliteColumnOptionKeys)) {
    throw new TypeError("SQLite column helper received an unknown option");
  }
  assertOptionalLocalName("column", Reflect.get(options, "name"));
  if (Object.hasOwn(options, "type")) {
    const type = Reflect.get(options, "type");
    const format = type === null ? undefined : readSqlColumnTypeFormat(type);
    if (type !== null && (format === undefined || format.dialect !== "sqlite")) {
      throw new TypeError(
        "SQLite column helper option 'type' requires a compatible SQLite column type",
      );
    }
  }
  if (Object.hasOwn(options, "default")) {
    const value = Reflect.get(options, "default");
    if (value !== null && readSqlLiteralFormat(value) === undefined) {
      assertParameterFreeStatement("column", "default", value);
    }
  }
  if (
    Object.hasOwn(options, "notNull") &&
    Reflect.get(options, "notNull") !== null &&
    typeof Reflect.get(options, "notNull") !== "boolean"
  ) {
    throw new TypeError("SQLite column helper option 'notNull' must be a boolean or null");
  }
  assertRowid(Reflect.get(options, "rowid"));
  assertGenerated(Reflect.get(options, "generated"));
  return sqliteMetadata.create("sqlite-column", options);
}

function directType<Value extends JsonValue>(type: string): SqliteColumnType<Value> {
  return createSqlColumnType<Value>({ dialect: "sqlite", type });
}

const directTypes = Object.freeze({
  integer: directType<number>("integer"),
  boolean: directType<boolean>("boolean"),
  timestampSeconds: directType<string>("timestamp-seconds"),
  timestampMilliseconds: directType<string>("timestamp-milliseconds"),
  real: directType<number>("real"),
  text: directType<string>("text"),
  json: directType<JsonValue>("json"),
  blob: directType<string>("blob"),
  jsonBlob: directType<JsonValue>("json-blob"),
  bigintBlob: directType<string>("bigint-blob"),
  numeric: directType<string>("numeric"),
  numericNumber: directType<number>("numeric-number"),
});

function defineCustom<Value extends JsonValue>(
  options: SqliteCustomTypeOptions<Value>,
): SqliteColumnType<Value> {
  if (!isSqlContractObject(options)) {
    throw new TypeError("SQLite custom helper requires an options object");
  }
  if (!hasOnlySqlContractKeys(options, sqliteCustomTypeOptionKeys)) {
    throw new TypeError("SQLite custom helper received an unknown option");
  }
  assertParameterFreeStatement("custom", "type", Reflect.get(options, "type"));
  if (typeof options.encode !== "function" || typeof options.decode !== "function") {
    throw new TypeError("SQLite custom helper requires encode and decode functions");
  }
  return createSqlColumnType<Value>({
    dialect: "sqlite",
    type: "custom",
    options: Object.freeze({ type: options.type, encode: options.encode, decode: options.decode }),
  });
}

/** SQLite Record-refinement and column-type constructors. */
export const sqlite = Object.freeze({
  table: defineSqliteTable,
  column: defineSqliteColumn,
  integer: (): SqliteColumnType<number> => directTypes.integer,
  boolean: (): SqliteColumnType<boolean> => directTypes.boolean,
  timestampSeconds: (): SqliteColumnType<string> => directTypes.timestampSeconds,
  timestampMilliseconds: (): SqliteColumnType<string> => directTypes.timestampMilliseconds,
  real: (): SqliteColumnType<number> => directTypes.real,
  text: (): SqliteColumnType<string> => directTypes.text,
  json: (): SqliteColumnType<JsonValue> => directTypes.json,
  blob: (): SqliteColumnType<string> => directTypes.blob,
  jsonBlob: (): SqliteColumnType<JsonValue> => directTypes.jsonBlob,
  bigintBlob: (): SqliteColumnType<string> => directTypes.bigintBlob,
  numeric: (): SqliteColumnType<string> => directTypes.numeric,
  numericNumber: (): SqliteColumnType<number> => directTypes.numericNumber,
  custom: defineCustom,
});

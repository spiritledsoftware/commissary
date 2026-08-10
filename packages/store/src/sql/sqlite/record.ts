import type { JsonValue } from "../../json.js";
import {
  createSqlColumnType,
  readSqlColumnTypeFormat,
  readSqlLiteralFormat,
  type SqlColumnType,
  type SqlCustomEncodedValue,
  type SqlLiteral,
  type SqlLiteralValue,
} from "../record.js";
import { readSqlStatementFragments, type SqlStatement } from "../statement.js";
import {
  hasSqliteStatementStructure,
  sqlOpaqueFormatSymbol,
  sqliteColumnOptionKeys,
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

const sqliteMetadataFormat = "commissary-sqlite-metadata@1";

interface SqliteMetadataFormat {
  readonly format: typeof sqliteMetadataFormat;
  readonly kind: "sqlite-table" | "sqlite-column";
}

function isRecordContainer(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOwnKeys(
  owner: string,
  value: Readonly<Record<PropertyKey, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`SQLite ${owner} helper received an unknown option`);
  }
}

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

function snapshotValue(value: unknown, snapshots = new Map<object, object>()): unknown {
  if (Array.isArray(value)) {
    const existing = snapshots.get(value);
    if (existing !== undefined) return existing;
    const snapshot: unknown[] = [];
    snapshots.set(value, snapshot);
    snapshot.push(...value.map((item) => snapshotValue(item, snapshots)));
    return Object.freeze(snapshot);
  }
  if (!isRecordContainer(value)) return value;
  const existing = snapshots.get(value);
  if (existing !== undefined) return existing;
  const snapshot: Record<PropertyKey, unknown> = {};
  snapshots.set(value, snapshot);
  for (const key of Reflect.ownKeys(value)) {
    Reflect.set(snapshot, key, snapshotValue(Reflect.get(value, key), snapshots));
  }
  return Object.freeze(snapshot);
}

function createMetadataValue<Options extends object>(
  kind: SqliteMetadataFormat["kind"],
  options: Options,
): Readonly<Options> {
  const snapshot = snapshotValue(options);
  if (!isRecordContainer(snapshot)) {
    throw new TypeError(`SQLite ${kind} helper requires an options object`);
  }
  return Object.freeze({
    ...snapshot,
    [sqlOpaqueFormatSymbol]: Object.freeze({ format: sqliteMetadataFormat, kind }),
  }) as Readonly<Options>;
}

/** Read one compatible package-owned SQLite metadata marker. */
export function readSqliteMetadataKind(value: unknown): SqliteMetadataFormat["kind"] | undefined {
  try {
    if (!isRecordContainer(value) || !Object.isFrozen(value)) return undefined;
    const format = Reflect.get(value, sqlOpaqueFormatSymbol);
    if (
      !isRecordContainer(format) ||
      !Object.isFrozen(format) ||
      Reflect.get(format, "format") !== sqliteMetadataFormat
    ) {
      return undefined;
    }
    const kind = Reflect.get(format, "kind");
    return kind === "sqlite-table" || kind === "sqlite-column" ? kind : undefined;
  } catch {
    return undefined;
  }
}

function assertParameterFreeStatement(owner: string, key: string, value: unknown): void {
  const fragments = readSqlStatementFragments(value);
  if (
    fragments === undefined ||
    fragments.some((fragment) => fragment.kind === "parameter") ||
    !hasSqliteStatementStructure(fragments)
  ) {
    throw new TypeError(
      `SQLite ${owner} helper option '${key}' requires a nonempty parameter-free SQL Statement`,
    );
  }
}

function assertRowid(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isRecordContainer(value)) {
    throw new TypeError("SQLite column helper option 'rowid' must be an object");
  }
  assertOwnKeys("rowid", value, new Set(["reuse"]));
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
  if (!isRecordContainer(value)) {
    throw new TypeError("SQLite column helper option 'generated' must be an object");
  }
  assertOwnKeys("generated", value, new Set(["expression", "mode"]));
  assertParameterFreeStatement("generated", "expression", Reflect.get(value, "expression"));
  const mode = Reflect.get(value, "mode");
  if (mode !== "virtual" && mode !== "stored") {
    throw new TypeError("SQLite generated column mode must be 'virtual' or 'stored'");
  }
}

function defineSqliteTable<const Options extends SqliteTableDefinition>(
  options: Options,
): Readonly<Options> {
  if (!isRecordContainer(options)) {
    throw new TypeError("SQLite table helper requires an options object");
  }
  assertOwnKeys("table", options, sqliteTableOptionKeys);
  assertOptionalLocalName("table", Reflect.get(options, "name"));
  return createMetadataValue("sqlite-table", options);
}

function defineSqliteColumn<const Options extends SqliteColumnHelperOptions>(
  options: Options & CompatibleSqliteColumnHelper<NoInfer<Options>>,
): Readonly<Options> {
  if (!isRecordContainer(options)) {
    throw new TypeError("SQLite column helper requires an options object");
  }
  assertOwnKeys("column", options, sqliteColumnOptionKeys);
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
  return createMetadataValue("sqlite-column", options);
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
  if (!isRecordContainer(options)) {
    throw new TypeError("SQLite custom helper requires an options object");
  }
  assertOwnKeys("custom", options, new Set(["type", "encode", "decode"]));
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

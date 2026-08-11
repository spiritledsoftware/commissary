import type { JsonValue } from "../../json.js";
import {
  hasOnlySqlContractKeys,
  isSqlContractObject as isRecordContainer,
} from "../contract-object.js";
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
import { readSqlStatementFragments, type SqlStatement } from "../statement.js";
import {
  isPostgresCharacterLengthOption,
  isPostgresIntervalFieldOption,
  isPostgresIntervalPrecisionCompatible,
  isPostgresNumericPrecisionOption,
  isPostgresNumericScaleCompatible,
  isPostgresNumericScaleOption,
  isPostgresTemporalPrecisionOption,
  isPostgresTimeZoneOption,
  type PostgresIntervalField,
} from "./postgres-type-options.js";

/** An opaque package-owned PostgreSQL storage and conversion contract. */
export interface PostgresColumnType<in Value extends JsonValue> extends SqlColumnType<Value> {
  readonly "~commissary/postgres-column-type"?: (value: Value) => void;
}

/** PostgreSQL table-name refinements for one SQL Record. */
export interface PostgresTableDefinition {
  readonly schema?: string | null;
  readonly name?: string | null;
}

/** One separately quoted PostgreSQL object name. */
export interface PostgresQualifiedName {
  readonly schema?: string;
  readonly name: string;
}

/** PostgreSQL identity-sequence controls. */
export interface PostgresIdentitySequence {
  readonly name?: PostgresQualifiedName;
  readonly startWith?: number | bigint;
  readonly incrementBy?: number | bigint;
  readonly minValue?: number | bigint;
  readonly maxValue?: number | bigint;
  readonly cache?: number | bigint;
  readonly cycle?: boolean;
}

/** PostgreSQL identity generation mode and optional sequence controls. */
export interface PostgresIdentity {
  readonly mode: "always" | "by-default";
  readonly sequence?: PostgresIdentitySequence;
}

/** PostgreSQL column refinements for one SQL Record Field. */
export interface PostgresColumnDefinition<Value extends JsonValue> {
  readonly name?: string | null;
  readonly type?: PostgresColumnType<Value> | null;
  readonly default?: SqlLiteral<Extract<Value, SqlLiteralValue>> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly identity?: PostgresIdentity | null;
  readonly generated?: SqlStatement<never> | null;
}

/** Precision and scale for a PostgreSQL NUMERIC column. */
export interface PostgresNumericOptions {
  readonly precision?: number;
  readonly scale?: number;
}

/** Length for a PostgreSQL character column. */
export interface PostgresCharacterOptions {
  readonly length?: number;
}

/** Supported PostgreSQL temporal fractional-second precision. */
export type PostgresTemporalPrecision = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Precision and time-zone mode for PostgreSQL TIME or TIMESTAMP. */
export interface PostgresTemporalOptions {
  readonly precision?: PostgresTemporalPrecision;
  readonly withTimezone?: boolean;
}

/** Supported PostgreSQL INTERVAL field range. */
export type PostgresIntervalFields = PostgresIntervalField;

/** Field range and fractional-second precision for PostgreSQL INTERVAL. */
export interface PostgresIntervalOptions {
  readonly fields?: PostgresIntervalFields;
  readonly precision?: PostgresTemporalPrecision;
}

/** A reusable definition-owned PostgreSQL enum type with literal physical identity. */
export interface PostgresEnum<
  Values extends readonly [string, ...string[]],
  Name extends string = string,
  Schema extends string | undefined = string | undefined,
> extends PostgresColumnType<Values[number]> {
  readonly "~commissary/postgres-enum"?: () => {
    readonly values: Values;
    readonly name: Name;
    readonly schema: Schema;
  };
}

/** One external PostgreSQL type and its synchronous scalar converters. */
export interface PostgresCustomTypeOptions<Value extends JsonValue> {
  readonly type: PostgresQualifiedName & {
    readonly modifier?: SqlStatement<never>;
  };
  readonly encode: (value: Value) => SqlCustomEncodedValue;
  readonly decode: (value: unknown) => Value;
}

type PostgresColumnHelperOptions = {
  readonly name?: string | null;
  readonly type?: PostgresColumnType<never> | null;
  readonly default?: SqlLiteral<SqlLiteralValue> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly identity?: PostgresIdentity | null;
  readonly generated?: SqlStatement<never> | null;
};

type PostgresColumnHelperValue<Options extends PostgresColumnHelperOptions> = Options extends {
  readonly type: PostgresColumnType<infer Value extends JsonValue>;
}
  ? Value
  : JsonValue;

type CompatiblePostgresColumnHelper<Options extends PostgresColumnHelperOptions> = Options extends {
  readonly default: SqlLiteral<infer Default>;
}
  ? Default extends Extract<PostgresColumnHelperValue<Options>, SqlLiteralValue>
    ? unknown
    : never
  : unknown;

const postgresMetadataFormat = "commissary-postgres-metadata@1";
const postgresNameEncoder = new TextEncoder();

type PostgresMetadataKind = "postgres-table" | "postgres-column";

const postgresMetadata = defineSqlMetadataFormat({
  format: postgresMetadataFormat,
  kinds: new Set<PostgresMetadataKind>(["postgres-table", "postgres-column"]),
  owner: "PostgreSQL",
});

function assertOwnKeys(
  owner: string,
  value: Readonly<Record<PropertyKey, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  if (!hasOnlySqlContractKeys(value, allowed)) {
    throw new TypeError(`PostgreSQL ${owner} helper received an unknown option`);
  }
}

function isValidLocalName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    postgresNameEncoder.encode(value).byteLength <= 63
  );
}

function assertOptionalLocalName(owner: string, key: string, value: unknown): void {
  if (value !== undefined && value !== null && !isValidLocalName(value)) {
    throw new TypeError(
      `PostgreSQL ${owner} helper option '${key}' must be a nonempty NUL-free name of at most 63 UTF-8 bytes`,
    );
  }
}

function assertQualifiedName(
  owner: string,
  value: unknown,
): asserts value is PostgresQualifiedName {
  if (!isRecordContainer(value) || !isValidLocalName(Reflect.get(value, "name"))) {
    throw new TypeError(`PostgreSQL ${owner} requires a valid qualified type name`);
  }
  if (Object.hasOwn(value, "schema") && !isValidLocalName(Reflect.get(value, "schema"))) {
    throw new TypeError(`PostgreSQL ${owner} schema must be a valid local name`);
  }
}

/** Read one compatible package-owned PostgreSQL metadata marker. */
export function readPostgresMetadataKind(value: unknown): PostgresMetadataKind | undefined {
  return postgresMetadata.read(value);
}

function assertOptionalStatement(owner: string, key: string, value: unknown): void {
  if (value !== undefined && value !== null && readSqlStatementFragments(value) === undefined) {
    throw new TypeError(
      `PostgreSQL ${owner} helper option '${key}' requires a compatible SQL Statement`,
    );
  }
}

function assertIdentity(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecordContainer(value)) {
    throw new TypeError("PostgreSQL column helper option 'identity' must be an object");
  }
  assertOwnKeys("identity", value, new Set(["mode", "sequence"]));
  const mode = Reflect.get(value, "mode");
  if (mode !== "always" && mode !== "by-default") {
    throw new TypeError("PostgreSQL identity mode must be 'always' or 'by-default'");
  }
  if (!Object.hasOwn(value, "sequence")) {
    return;
  }
  const sequence = Reflect.get(value, "sequence");
  if (!isRecordContainer(sequence)) {
    throw new TypeError("PostgreSQL identity sequence must be an object");
  }
  assertOwnKeys(
    "identity sequence",
    sequence,
    new Set(["name", "startWith", "incrementBy", "minValue", "maxValue", "cache", "cycle"]),
  );
  if (Object.hasOwn(sequence, "name")) {
    if (isRecordContainer(Reflect.get(sequence, "name"))) {
      assertOwnKeys(
        "identity sequence name",
        Reflect.get(sequence, "name") as Readonly<Record<PropertyKey, unknown>>,
        new Set(["schema", "name"]),
      );
    }
    assertQualifiedName("identity sequence", Reflect.get(sequence, "name"));
  }
  for (const key of ["startWith", "incrementBy", "minValue", "maxValue", "cache"] as const) {
    if (!Object.hasOwn(sequence, key)) {
      continue;
    }
    const option = Reflect.get(sequence, key);
    if (
      typeof option !== "bigint" &&
      !(typeof option === "number" && Number.isSafeInteger(option))
    ) {
      throw new TypeError(`PostgreSQL identity sequence option '${key}' must be an exact integer`);
    }
    if (
      (key === "incrementBy" && option === 0) ||
      (key === "incrementBy" && option === 0n) ||
      (key === "cache" &&
        ((typeof option === "number" && option < 1) || (typeof option === "bigint" && option < 1n)))
    ) {
      throw new TypeError(
        `PostgreSQL identity sequence option '${key}' is outside its valid range`,
      );
    }
  }
  if (Object.hasOwn(sequence, "cycle") && typeof Reflect.get(sequence, "cycle") !== "boolean") {
    throw new TypeError("PostgreSQL identity sequence option 'cycle' must be a boolean");
  }
}

function definePostgresTable<const Options extends PostgresTableDefinition>(
  options: Options,
): Readonly<Options> {
  if (!isRecordContainer(options)) {
    throw new TypeError("PostgreSQL table helper requires an options object");
  }
  assertOwnKeys("table", options, new Set(["schema", "name"]));
  assertOptionalLocalName("table", "schema", Reflect.get(options, "schema"));
  assertOptionalLocalName("table", "name", Reflect.get(options, "name"));
  return postgresMetadata.create("postgres-table", options);
}

function definePostgresColumn<const Options extends PostgresColumnHelperOptions>(
  options: Options & CompatiblePostgresColumnHelper<NoInfer<Options>>,
): Readonly<Options> {
  if (!isRecordContainer(options)) {
    throw new TypeError("PostgreSQL column helper requires an options object");
  }
  assertOwnKeys(
    "column",
    options,
    new Set(["name", "type", "default", "notNull", "identity", "generated"]),
  );
  assertOptionalLocalName("column", "name", Reflect.get(options, "name"));
  if (Object.hasOwn(options, "type")) {
    const type = Reflect.get(options, "type");
    const format = type === null ? undefined : readSqlColumnTypeFormat(type);
    if (type !== null && (format === undefined || format.dialect !== "postgres")) {
      throw new TypeError(
        "PostgreSQL column helper option 'type' requires a compatible PostgreSQL column type",
      );
    }
  }
  if (Object.hasOwn(options, "default")) {
    const value = Reflect.get(options, "default");
    if (
      value !== null &&
      readSqlStatementFragments(value) === undefined &&
      readSqlLiteralFormat(value) === undefined
    ) {
      throw new TypeError(
        "PostgreSQL column helper option 'default' requires a compatible SQL literal or Statement",
      );
    }
  }
  if (
    Object.hasOwn(options, "notNull") &&
    Reflect.get(options, "notNull") !== null &&
    typeof Reflect.get(options, "notNull") !== "boolean"
  ) {
    throw new TypeError("PostgreSQL column helper option 'notNull' must be a boolean or null");
  }
  assertIdentity(Reflect.get(options, "identity"));
  assertOptionalStatement("column", "generated", Reflect.get(options, "generated"));
  return postgresMetadata.create("postgres-column", options);
}

function directType<Value extends JsonValue>(
  type: string,
  options?: Readonly<Record<string, unknown>>,
): PostgresColumnType<Value> {
  return createSqlColumnType<Value>({
    dialect: "postgres",
    type,
    ...(options === undefined ? {} : { options: Object.freeze({ ...options }) }),
  });
}

const directTypes = Object.freeze({
  smallint: directType<number>("smallint"),
  integer: directType<number>("integer"),
  bigint: directType<string>("bigint"),
  real: directType<number>("real"),
  doublePrecision: directType<number>("double-precision"),
  boolean: directType<boolean>("boolean"),
  text: directType<string>("text"),
  uuid: directType<string>("uuid"),
  json: directType<JsonValue>("json"),
  jsonb: directType<JsonValue>("jsonb"),
  bytea: directType<string>("bytea"),
  date: directType<string>("date"),
  inet: directType<string>("inet"),
  cidr: directType<string>("cidr"),
  macaddr: directType<string>("macaddr"),
  macaddr8: directType<string>("macaddr8"),
  point: directType<{ readonly x: number; readonly y: number }>("point"),
  line: directType<{ readonly a: number; readonly b: number; readonly c: number }>("line"),
});

function defineNumeric(options?: PostgresNumericOptions): PostgresColumnType<string> {
  if (options === undefined) {
    return directType<string>("numeric");
  }
  if (!isRecordContainer(options)) {
    throw new TypeError("PostgreSQL numeric helper options must be an object");
  }
  assertOwnKeys("numeric", options, new Set(["precision", "scale"]));
  const precision = Reflect.get(options, "precision");
  const scale = Reflect.get(options, "scale");
  if (!isPostgresNumericPrecisionOption(precision)) {
    throw new TypeError("PostgreSQL numeric option 'precision' must be 1 through 1000");
  }
  if (!isPostgresNumericScaleOption(scale)) {
    throw new TypeError("PostgreSQL numeric option 'scale' must be -1000 through 1000");
  }
  if (!isPostgresNumericScaleCompatible(precision, scale)) {
    throw new TypeError("PostgreSQL numeric option 'scale' requires 'precision'");
  }
  return directType<string>("numeric", options);
}

function defineCharacter(
  type: "char" | "varchar",
  options?: PostgresCharacterOptions,
): PostgresColumnType<string> {
  if (options === undefined) {
    return directType<string>(type);
  }
  if (!isRecordContainer(options)) {
    throw new TypeError(`PostgreSQL ${type} helper options must be an object`);
  }
  assertOwnKeys(type, options, new Set(["length"]));
  if (!isPostgresCharacterLengthOption(Reflect.get(options, "length"))) {
    throw new TypeError(`PostgreSQL ${type} option 'length' must be 1 through 10485760`);
  }
  return directType<string>(type, options);
}

function defineTemporal(
  type: "time" | "timestamp",
  options?: PostgresTemporalOptions,
): PostgresColumnType<string> {
  if (options === undefined) {
    return directType<string>(type);
  }
  if (!isRecordContainer(options)) {
    throw new TypeError(`PostgreSQL ${type} helper options must be an object`);
  }
  assertOwnKeys(type, options, new Set(["precision", "withTimezone"]));
  if (!isPostgresTemporalPrecisionOption(Reflect.get(options, "precision"))) {
    throw new TypeError(`PostgreSQL ${type} option 'precision' must be 0 through 6`);
  }
  if (!isPostgresTimeZoneOption(Reflect.get(options, "withTimezone"))) {
    throw new TypeError(`PostgreSQL ${type} option 'withTimezone' must be a boolean`);
  }
  return directType<string>(type, options);
}

function defineInterval(options?: PostgresIntervalOptions): PostgresColumnType<string> {
  if (options === undefined) {
    return directType<string>("interval");
  }
  if (!isRecordContainer(options)) {
    throw new TypeError("PostgreSQL interval helper options must be an object");
  }
  assertOwnKeys("interval", options, new Set(["fields", "precision"]));
  const fields = Reflect.get(options, "fields");
  const precision = Reflect.get(options, "precision");
  if (!isPostgresIntervalFieldOption(fields)) {
    throw new TypeError("PostgreSQL interval option 'fields' is invalid");
  }
  if (!isPostgresTemporalPrecisionOption(precision)) {
    throw new TypeError("PostgreSQL interval option 'precision' must be 0 through 6");
  }
  if (!isPostgresIntervalPrecisionCompatible(fields, precision)) {
    throw new TypeError("PostgreSQL interval precision requires a field range containing seconds");
  }
  return directType<string>("interval", options);
}

function defineEnum<
  const Values extends readonly [string, ...string[]],
  const Name extends string,
  const Schema extends string | undefined = undefined,
>(options: {
  readonly schema?: Schema;
  readonly name: Name;
  readonly values: Values;
}): PostgresEnum<Values, Name, Schema> {
  if (!isRecordContainer(options)) {
    throw new TypeError("PostgreSQL enum helper requires an options object");
  }
  assertOwnKeys("enum", options, new Set(["schema", "name", "values"]));
  assertQualifiedName("enum", options);
  if (!Array.isArray(options.values) || options.values.length === 0) {
    throw new TypeError("PostgreSQL enum helper requires a nonempty values tuple");
  }
  const values = new Set<string>();
  for (const value of options.values) {
    if (!isValidLocalName(value) || values.has(value)) {
      throw new TypeError(
        "PostgreSQL enum values must be unique NUL-free strings of at most 63 UTF-8 bytes",
      );
    }
    values.add(value);
  }
  const identity = Symbol("commissary-postgres-enum");
  return directType<Values[number]>("enum", {
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    name: options.name,
    values: Object.freeze([...options.values]),
    identity,
  }) as PostgresEnum<Values, Name, Schema>;
}

function defineArray<Value extends JsonValue>(
  element: PostgresColumnType<Value>,
): PostgresColumnType<readonly Value[]> {
  const format = readSqlColumnTypeFormat(element);
  if (format === undefined || format.dialect !== "postgres") {
    throw new TypeError("PostgreSQL array helper requires a compatible PostgreSQL column type");
  }
  return directType<readonly Value[]>("array", { element });
}

function defineCustom<Value extends JsonValue>(
  options: PostgresCustomTypeOptions<Value>,
): PostgresColumnType<Value> {
  if (!isRecordContainer(options)) {
    throw new TypeError("PostgreSQL custom helper requires an options object");
  }
  assertOwnKeys("custom", options, new Set(["type", "encode", "decode"]));
  if (isRecordContainer(options.type)) {
    assertOwnKeys("custom type", options.type, new Set(["schema", "name", "modifier"]));
  }
  assertQualifiedName("custom type", options.type);
  assertOptionalStatement("custom type", "modifier", Reflect.get(options.type, "modifier"));
  if (typeof options.encode !== "function" || typeof options.decode !== "function") {
    throw new TypeError("PostgreSQL custom helper requires encode and decode functions");
  }
  return directType<Value>("custom", {
    type: Object.freeze({
      ...(options.type.schema === undefined ? {} : { schema: options.type.schema }),
      name: options.type.name,
      ...(options.type.modifier === undefined ? {} : { modifier: options.type.modifier }),
    }),
    encode: options.encode,
    decode: options.decode,
  });
}

/** PostgreSQL Record-refinement and column-type constructors. */
export const pg = Object.freeze({
  table: definePostgresTable,
  column: definePostgresColumn,

  smallint: (): PostgresColumnType<number> => directTypes.smallint,
  integer: (): PostgresColumnType<number> => directTypes.integer,
  bigint: (): PostgresColumnType<string> => directTypes.bigint,
  numeric: defineNumeric,
  real: (): PostgresColumnType<number> => directTypes.real,
  doublePrecision: (): PostgresColumnType<number> => directTypes.doublePrecision,

  boolean: (): PostgresColumnType<boolean> => directTypes.boolean,
  char: (options?: PostgresCharacterOptions): PostgresColumnType<string> =>
    defineCharacter("char", options),
  varchar: (options?: PostgresCharacterOptions): PostgresColumnType<string> =>
    defineCharacter("varchar", options),
  text: (): PostgresColumnType<string> => directTypes.text,
  uuid: (): PostgresColumnType<string> => directTypes.uuid,
  json: (): PostgresColumnType<JsonValue> => directTypes.json,
  jsonb: (): PostgresColumnType<JsonValue> => directTypes.jsonb,
  bytea: (): PostgresColumnType<string> => directTypes.bytea,

  date: (): PostgresColumnType<string> => directTypes.date,
  time: (options?: PostgresTemporalOptions): PostgresColumnType<string> =>
    defineTemporal("time", options),
  timestamp: (options?: PostgresTemporalOptions): PostgresColumnType<string> =>
    defineTemporal("timestamp", options),
  interval: defineInterval,

  inet: (): PostgresColumnType<string> => directTypes.inet,
  cidr: (): PostgresColumnType<string> => directTypes.cidr,
  macaddr: (): PostgresColumnType<string> => directTypes.macaddr,
  macaddr8: (): PostgresColumnType<string> => directTypes.macaddr8,
  point: (): PostgresColumnType<{ readonly x: number; readonly y: number }> => directTypes.point,
  line: (): PostgresColumnType<{
    readonly a: number;
    readonly b: number;
    readonly c: number;
  }> => directTypes.line,

  enum: defineEnum,
  array: defineArray,
  custom: defineCustom,
});

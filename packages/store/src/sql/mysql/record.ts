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
  isValidMysqlEnumValue,
  mysqlColumnOptionKeys,
  mysqlTableOptionKeys,
} from "./mysql-contract.js";
import {
  isMysqlDecimalPrecisionOption,
  isMysqlDecimalScaleCompatible,
  isMysqlDecimalScaleOption,
  isMysqlFloatPrecisionOption,
  isMysqlFloatScaleCompatible,
  isMysqlFloatScaleOption,
  isMysqlFractionalSecondsOption,
  isMysqlOptionalLengthOption,
  isMysqlRequiredLengthOption,
  isMysqlUnsignedOption,
} from "./mysql-type-options.js";

/** An opaque package-owned MySQL storage and conversion contract. */
export interface MysqlColumnType<in Value extends JsonValue> extends SqlColumnType<Value> {
  readonly "~commissary/mysql-column-type"?: (value: Value) => void;
}

/** MySQL table-name refinements for one SQL Record. */
export interface MysqlTableDefinition {
  readonly database?: string | null;
  readonly name?: string | null;
}

/** MySQL generated-column expression and storage mode. */
export interface MysqlGenerated {
  readonly expression: SqlStatement<never>;
  readonly mode: "virtual" | "stored";
}

/** MySQL column refinements for one SQL Record Field. */
export interface MysqlColumnDefinition<Value extends JsonValue> {
  readonly name?: string | null;
  readonly type?: MysqlColumnType<Value> | null;
  readonly default?: SqlLiteral<Extract<Value, SqlLiteralValue>> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly autoIncrement?: boolean | null;
  readonly generated?: MysqlGenerated | null;
  readonly onUpdate?: "current-timestamp" | null;
}

/** Optional UNSIGNED mode for a MySQL integer column. */
export interface MysqlIntegerOptions {
  readonly unsigned?: boolean;
}

/** Precision, scale, and legacy UNSIGNED mode for MySQL DECIMAL. */
export interface MysqlDecimalOptions {
  readonly precision?: number;
  readonly scale?: number;
  /** @deprecated MySQL 8.4 deprecates UNSIGNED on DECIMAL. */
  readonly unsigned?: boolean;
}

/** Precision, scale, and legacy UNSIGNED mode for MySQL FLOAT. */
export interface MysqlFloatOptions {
  readonly precision?: number;
  /** @deprecated MySQL 8.4 deprecates FLOAT(M,D). Supplying scale selects this form. */
  readonly scale?: number;
  /** @deprecated MySQL 8.4 deprecates UNSIGNED on FLOAT. */
  readonly unsigned?: boolean;
}

/** Legacy precision, scale, and UNSIGNED options for MySQL DOUBLE. */
export interface MysqlDoubleOptions {
  /** @deprecated MySQL 8.4 deprecates DOUBLE(M,D). */
  readonly precision?: number;
  /** @deprecated MySQL 8.4 deprecates DOUBLE(M,D). */
  readonly scale?: number;
  /** @deprecated MySQL 8.4 deprecates UNSIGNED on DOUBLE. */
  readonly unsigned?: boolean;
}

/** Legacy precision and scale options for MySQL REAL. */
export interface MysqlRealOptions {
  /** @deprecated MySQL 8.4 deprecates REAL(M,D). */
  readonly precision?: number;
  /** @deprecated MySQL 8.4 deprecates REAL(M,D). */
  readonly scale?: number;
}

/** Optional length for a MySQL CHAR or BINARY column. */
export interface MysqlOptionalLengthOptions {
  readonly length?: number;
}

/** Required length for a MySQL VARCHAR or VARBINARY column. */
export interface MysqlLengthOptions {
  readonly length: number;
}

/** Supported MySQL fractional-seconds precision. */
export type MysqlFractionalSecondsPrecision = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Fractional-seconds precision for a MySQL temporal column. */
export interface MysqlTemporalOptions {
  readonly fsp?: MysqlFractionalSecondsPrecision;
}

/** One inline MySQL enum column type. */
export interface MysqlEnum<Values extends readonly [string, ...string[]]> extends MysqlColumnType<
  Values[number]
> {
  readonly "~commissary/mysql-enum"?: () => Values;
}

/** One external MySQL type Statement and its synchronous scalar converters. */
export interface MysqlCustomTypeOptions<Value extends JsonValue> {
  readonly type: SqlStatement<never>;
  readonly encode: (value: Value) => SqlCustomEncodedValue;
  readonly decode: (value: unknown) => Value;
}

type MysqlColumnHelperOptions = {
  readonly name?: string | null;
  readonly type?: MysqlColumnType<never> | null;
  readonly default?: SqlLiteral<SqlLiteralValue> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly autoIncrement?: boolean | null;
  readonly generated?: MysqlGenerated | null;
  readonly onUpdate?: "current-timestamp" | null;
};

type MysqlColumnHelperValue<Options extends MysqlColumnHelperOptions> = Options extends {
  readonly type: MysqlColumnType<infer Value extends JsonValue>;
}
  ? Value
  : JsonValue;

type CompatibleMysqlColumnHelper<Options extends MysqlColumnHelperOptions> = Options extends {
  readonly default: SqlLiteral<infer Default>;
}
  ? Default extends Extract<MysqlColumnHelperValue<Options>, SqlLiteralValue>
    ? unknown
    : never
  : unknown;

type MysqlMetadataKind = "mysql-table" | "mysql-column";

const mysqlMetadata = defineSqlMetadataFormat({
  format: "commissary-mysql-metadata@1",
  kinds: new Set<MysqlMetadataKind>(["mysql-table", "mysql-column"]),
  owner: "MySQL",
});

/** Test one MySQL database, table, or column identifier without normalizing it. */
export function isValidMysqlName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.endsWith(" ")
  ) {
    return false;
  }
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint > 0xffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return false;
    }
    length += 1;
    if (length > 64) return false;
  }
  return true;
}

function assertOptionalLocalName(owner: string, key: string, value: unknown): void {
  if (value !== undefined && value !== null && !isValidMysqlName(value)) {
    throw new TypeError(
      `MySQL ${owner} helper option '${key}' must be a valid name of at most 64 BMP code points`,
    );
  }
}

/** Read one compatible package-owned MySQL metadata marker. */
export function readMysqlMetadataKind(value: unknown): MysqlMetadataKind | undefined {
  return mysqlMetadata.read(value);
}

function assertParameterFreeStatement(owner: string, key: string, value: unknown): void {
  const fragments = readSqlStatementFragments(value);
  if (
    fragments === undefined ||
    fragments.some((fragment) => fragment.kind === "parameter") ||
    !hasSqlStatementStructure(fragments)
  ) {
    throw new TypeError(
      `MySQL ${owner} helper option '${key}' requires a nonempty parameter-free SQL Statement`,
    );
  }
}

function assertGenerated(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isSqlContractObject(value)) {
    throw new TypeError("MySQL column helper option 'generated' must be an object");
  }
  if (!hasOnlySqlContractKeys(value, new Set(["expression", "mode"]))) {
    throw new TypeError("MySQL generated helper received an unknown option");
  }
  assertParameterFreeStatement("generated", "expression", Reflect.get(value, "expression"));
  const mode = Reflect.get(value, "mode");
  if (mode !== "virtual" && mode !== "stored") {
    throw new TypeError("MySQL generated column mode must be 'virtual' or 'stored'");
  }
}

function defineMysqlTable<const Options extends MysqlTableDefinition>(
  options: Options,
): Readonly<Options> {
  if (!isSqlContractObject(options)) {
    throw new TypeError("MySQL table helper requires an options object");
  }
  if (!hasOnlySqlContractKeys(options, mysqlTableOptionKeys)) {
    throw new TypeError("MySQL table helper received an unknown option");
  }
  assertOptionalLocalName("table", "database", Reflect.get(options, "database"));
  assertOptionalLocalName("table", "name", Reflect.get(options, "name"));
  return mysqlMetadata.create("mysql-table", options);
}

function defineMysqlColumn<const Options extends MysqlColumnHelperOptions>(
  options: Options & CompatibleMysqlColumnHelper<NoInfer<Options>>,
): Readonly<Options> {
  if (!isSqlContractObject(options)) {
    throw new TypeError("MySQL column helper requires an options object");
  }
  if (!hasOnlySqlContractKeys(options, mysqlColumnOptionKeys)) {
    throw new TypeError("MySQL column helper received an unknown option");
  }
  assertOptionalLocalName("column", "name", Reflect.get(options, "name"));
  if (Object.hasOwn(options, "type")) {
    const type = Reflect.get(options, "type");
    const format = type === null ? undefined : readSqlColumnTypeFormat(type);
    if (type !== null && (format === undefined || format.dialect !== "mysql")) {
      throw new TypeError(
        "MySQL column helper option 'type' requires a compatible MySQL column type",
      );
    }
  }
  if (Object.hasOwn(options, "default")) {
    const value = Reflect.get(options, "default");
    if (value !== null && readSqlLiteralFormat(value) === undefined) {
      assertParameterFreeStatement("column", "default", value);
    }
  }
  for (const key of ["notNull", "autoIncrement"] as const) {
    if (
      Object.hasOwn(options, key) &&
      Reflect.get(options, key) !== null &&
      typeof Reflect.get(options, key) !== "boolean"
    ) {
      throw new TypeError(`MySQL column helper option '${key}' must be a boolean or null`);
    }
  }
  assertGenerated(Reflect.get(options, "generated"));
  if (
    Object.hasOwn(options, "onUpdate") &&
    Reflect.get(options, "onUpdate") !== null &&
    Reflect.get(options, "onUpdate") !== "current-timestamp"
  ) {
    throw new TypeError(
      "MySQL column helper option 'onUpdate' must be 'current-timestamp' or null",
    );
  }
  return mysqlMetadata.create("mysql-column", options);
}

function directType<Value extends JsonValue>(
  type: string,
  options?: Readonly<Record<string, unknown>>,
): MysqlColumnType<Value> {
  return createSqlColumnType<Value>({
    dialect: "mysql",
    type,
    ...(options === undefined ? {} : { options: Object.freeze({ ...options }) }),
  });
}

const directTypes = Object.freeze({
  tinyint: directType<number>("tinyint"),
  smallint: directType<number>("smallint"),
  mediumint: directType<number>("mediumint"),
  int: directType<number>("int"),
  bigint: directType<string>("bigint"),
  decimal: directType<string>("decimal"),
  float: directType<number>("float"),
  double: directType<number>("double"),
  real: directType<number>("real"),
  boolean: directType<boolean>("boolean"),
  char: directType<string>("char"),
  binary: directType<string>("binary"),
  text: directType<string>("text"),
  tinytext: directType<string>("tinytext"),
  mediumtext: directType<string>("mediumtext"),
  longtext: directType<string>("longtext"),
  json: directType<JsonValue>("json"),
  date: directType<string>("date"),
  datetime: directType<string>("datetime"),
  time: directType<string>("time"),
  timestamp: directType<string>("timestamp"),
  year: directType<number>("year"),
  serial: directType<string>("serial"),
});

type MysqlIntegerTypeName = "tinyint" | "smallint" | "mediumint" | "int" | "bigint";

type MysqlIntegerValue<Type extends MysqlIntegerTypeName> = Type extends "bigint" ? string : number;

function defineInteger<const Type extends MysqlIntegerTypeName>(
  type: Type,
  options?: MysqlIntegerOptions,
): MysqlColumnType<MysqlIntegerValue<Type>> {
  if (options !== undefined) {
    if (!isSqlContractObject(options)) {
      throw new TypeError(`MySQL ${type} helper options must be an object`);
    }
    if (!hasOnlySqlContractKeys(options, new Set(["unsigned"]))) {
      throw new TypeError(`MySQL ${type} helper received an unknown option`);
    }
    if (!isMysqlUnsignedOption(Reflect.get(options, "unsigned"))) {
      throw new TypeError(`MySQL ${type} option 'unsigned' must be a boolean`);
    }
  }
  return directType<MysqlIntegerValue<Type>>(type, options);
}

function defineDecimal(options?: MysqlDecimalOptions): MysqlColumnType<string> {
  if (options === undefined) return directTypes.decimal;
  if (!isSqlContractObject(options)) {
    throw new TypeError("MySQL decimal helper options must be an object");
  }
  if (!hasOnlySqlContractKeys(options, new Set(["precision", "scale", "unsigned"]))) {
    throw new TypeError("MySQL decimal helper received an unknown option");
  }
  const precision = Reflect.get(options, "precision");
  const scale = Reflect.get(options, "scale");
  if (!isMysqlDecimalPrecisionOption(precision)) {
    throw new TypeError("MySQL decimal option 'precision' must be 1 through 65");
  }
  if (!isMysqlDecimalScaleOption(scale)) {
    throw new TypeError("MySQL decimal option 'scale' must be 0 through 30");
  }
  if (!isMysqlDecimalScaleCompatible(precision, scale)) {
    throw new TypeError("MySQL decimal option 'scale' requires compatible 'precision'");
  }
  if (!isMysqlUnsignedOption(Reflect.get(options, "unsigned"))) {
    throw new TypeError("MySQL decimal option 'unsigned' must be a boolean");
  }
  return directType<string>("decimal", options);
}

function defineFloating(
  type: "float" | "double" | "real",
  options?: MysqlFloatOptions | MysqlDoubleOptions | MysqlRealOptions,
): MysqlColumnType<number> {
  if (options === undefined) return directTypes[type];
  if (!isSqlContractObject(options)) {
    throw new TypeError(`MySQL ${type} helper options must be an object`);
  }
  const allowed =
    type === "real" ? new Set(["precision", "scale"]) : new Set(["precision", "scale", "unsigned"]);
  if (!hasOnlySqlContractKeys(options, allowed)) {
    throw new TypeError(`MySQL ${type} helper received an unknown option`);
  }
  const precision = Reflect.get(options, "precision");
  const scale = Reflect.get(options, "scale");
  if (!isMysqlFloatPrecisionOption(type, precision, scale)) {
    throw new TypeError(`MySQL ${type} option 'precision' is outside its valid range`);
  }
  if (!isMysqlFloatScaleOption(scale)) {
    throw new TypeError(`MySQL ${type} option 'scale' must be 0 through 30`);
  }
  if (!isMysqlFloatScaleCompatible(precision, scale)) {
    throw new TypeError(`MySQL ${type} option 'scale' requires compatible 'precision'`);
  }
  if (type !== "real" && !isMysqlUnsignedOption(Reflect.get(options, "unsigned"))) {
    throw new TypeError(`MySQL ${type} option 'unsigned' must be a boolean`);
  }
  return directType<number>(type, options);
}

function defineOptionalLength(
  type: "char" | "binary",
  options?: MysqlOptionalLengthOptions,
): MysqlColumnType<string> {
  if (options === undefined) return directTypes[type];
  if (!isSqlContractObject(options)) {
    throw new TypeError(`MySQL ${type} helper options must be an object`);
  }
  if (!hasOnlySqlContractKeys(options, new Set(["length"]))) {
    throw new TypeError(`MySQL ${type} helper received an unknown option`);
  }
  if (!isMysqlOptionalLengthOption(Reflect.get(options, "length"))) {
    throw new TypeError(`MySQL ${type} option 'length' must be 0 through 255`);
  }
  return directType<string>(type, options);
}

function defineRequiredLength(
  type: "varchar" | "varbinary",
  options: MysqlLengthOptions,
): MysqlColumnType<string> {
  if (!isSqlContractObject(options)) {
    throw new TypeError(`MySQL ${type} helper options must be an object`);
  }
  if (!hasOnlySqlContractKeys(options, new Set(["length"]))) {
    throw new TypeError(`MySQL ${type} helper received an unknown option`);
  }
  if (!isMysqlRequiredLengthOption(Reflect.get(options, "length"))) {
    throw new TypeError(`MySQL ${type} option 'length' must be 0 through 65535`);
  }
  return directType<string>(type, options);
}

function defineTemporal(
  type: "datetime" | "time" | "timestamp",
  options?: MysqlTemporalOptions,
): MysqlColumnType<string> {
  if (options === undefined) return directTypes[type];
  if (!isSqlContractObject(options)) {
    throw new TypeError(`MySQL ${type} helper options must be an object`);
  }
  if (!hasOnlySqlContractKeys(options, new Set(["fsp"]))) {
    throw new TypeError(`MySQL ${type} helper received an unknown option`);
  }
  if (!isMysqlFractionalSecondsOption(Reflect.get(options, "fsp"))) {
    throw new TypeError(`MySQL ${type} option 'fsp' must be 0 through 6`);
  }
  return directType<string>(type, options);
}

function defineEnum<const Values extends readonly [string, ...string[]]>(options: {
  readonly values: Values;
}): MysqlEnum<Values> {
  if (!isSqlContractObject(options)) {
    throw new TypeError("MySQL enum helper requires an options object");
  }
  if (!hasOnlySqlContractKeys(options, new Set(["values"]))) {
    throw new TypeError("MySQL enum helper received an unknown option");
  }
  if (
    !Array.isArray(options.values) ||
    options.values.length === 0 ||
    options.values.length > 65_535
  ) {
    throw new TypeError("MySQL enum helper requires 1 through 65535 values");
  }
  const values = new Set<string>();
  for (const value of options.values) {
    if (!isValidMysqlEnumValue(value) || values.has(value)) {
      throw new TypeError(
        "MySQL enum values must be unique nonempty strings of at most 255 Unicode code points without trailing spaces",
      );
    }
    values.add(value);
  }
  return directType<Values[number]>("enum", {
    values: Object.freeze([...options.values]),
  }) as MysqlEnum<Values>;
}

function defineCustom<Value extends JsonValue>(
  options: MysqlCustomTypeOptions<Value>,
): MysqlColumnType<Value> {
  if (!isSqlContractObject(options)) {
    throw new TypeError("MySQL custom helper requires an options object");
  }
  if (!hasOnlySqlContractKeys(options, new Set(["type", "encode", "decode"]))) {
    throw new TypeError("MySQL custom helper received an unknown option");
  }
  assertParameterFreeStatement("custom", "type", Reflect.get(options, "type"));
  if (typeof options.encode !== "function" || typeof options.decode !== "function") {
    throw new TypeError("MySQL custom helper requires encode and decode functions");
  }
  return directType<Value>("custom", {
    type: options.type,
    encode: options.encode,
    decode: options.decode,
  });
}

/** MySQL Record-refinement and column-type constructors. */
export const mysql = Object.freeze({
  table: defineMysqlTable,
  column: defineMysqlColumn,

  tinyint: (options?: MysqlIntegerOptions): MysqlColumnType<number> =>
    defineInteger("tinyint", options),
  smallint: (options?: MysqlIntegerOptions): MysqlColumnType<number> =>
    defineInteger("smallint", options),
  mediumint: (options?: MysqlIntegerOptions): MysqlColumnType<number> =>
    defineInteger("mediumint", options),
  int: (options?: MysqlIntegerOptions): MysqlColumnType<number> => defineInteger("int", options),
  bigint: (options?: MysqlIntegerOptions): MysqlColumnType<string> =>
    defineInteger("bigint", options),
  decimal: defineDecimal,
  float: (options?: MysqlFloatOptions): MysqlColumnType<number> => defineFloating("float", options),
  double: (options?: MysqlDoubleOptions): MysqlColumnType<number> =>
    defineFloating("double", options),
  real: (options?: MysqlRealOptions): MysqlColumnType<number> => defineFloating("real", options),

  boolean: (): MysqlColumnType<boolean> => directTypes.boolean,
  char: (options?: MysqlOptionalLengthOptions): MysqlColumnType<string> =>
    defineOptionalLength("char", options),
  varchar: (options: MysqlLengthOptions): MysqlColumnType<string> =>
    defineRequiredLength("varchar", options),
  binary: (options?: MysqlOptionalLengthOptions): MysqlColumnType<string> =>
    defineOptionalLength("binary", options),
  varbinary: (options: MysqlLengthOptions): MysqlColumnType<string> =>
    defineRequiredLength("varbinary", options),
  text: (): MysqlColumnType<string> => directTypes.text,
  tinytext: (): MysqlColumnType<string> => directTypes.tinytext,
  mediumtext: (): MysqlColumnType<string> => directTypes.mediumtext,
  longtext: (): MysqlColumnType<string> => directTypes.longtext,
  json: (): MysqlColumnType<JsonValue> => directTypes.json,

  date: (): MysqlColumnType<string> => directTypes.date,
  datetime: (options?: MysqlTemporalOptions): MysqlColumnType<string> =>
    defineTemporal("datetime", options),
  time: (options?: MysqlTemporalOptions): MysqlColumnType<string> =>
    defineTemporal("time", options),
  timestamp: (options?: MysqlTemporalOptions): MysqlColumnType<string> =>
    defineTemporal("timestamp", options),
  year: (): MysqlColumnType<number> => directTypes.year,

  serial: (): MysqlColumnType<string> => directTypes.serial,
  enum: defineEnum,
  custom: defineCustom,
});

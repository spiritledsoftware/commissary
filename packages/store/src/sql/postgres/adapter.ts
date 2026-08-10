import { isJsonValue, type JsonValue } from "../../json.js";
import {
  applyRecordOverrides,
  type ApplyOverrides,
  type CompatibleRecordOverrides,
  type FieldDefinition,
  type FieldOutput,
  type FieldSchema,
  type RecordDefinition,
  type RecordDefinitions,
  type RecordOverrides,
  type RoundTripRecordDefinitions,
  type SelectFieldSchema,
} from "../../record.js";
import {
  readSqlColumnTypeFormat,
  readSqlLiteralFormat,
  reflectSqlSelectStorage,
  SqlDefinitionError,
  type SqlColumnTypeFormat,
  type SqlCustomEncodedValue,
  type SqlDefinitionIssue,
  type SqlLiteralValue,
  type SqlPortableTypeName,
  type SqlRecordReference,
  type SqlRecordReferences,
  type SqlResolvedGeneratedColumn,
} from "../record.js";
import {
  readSqlStatementFragments,
  sql,
  type SqlStatement,
  type SqlStatementFragment,
} from "../statement.js";
import {
  readPostgresMetadataKind,
  type PostgresCharacterOptions,
  type PostgresIntervalOptions,
  type PostgresNumericOptions,
  type PostgresQualifiedName,
  type PostgresTemporalOptions,
} from "./record.js";
import {
  isPostgresCharacterLengthOption,
  isPostgresIntervalFieldOption,
  isPostgresIntervalPrecisionCompatible,
  isPostgresNumericPrecisionOption,
  isPostgresNumericScaleCompatible,
  isPostgresNumericScaleOption,
  isPostgresTemporalPrecisionOption,
  isPostgresTimeZoneOption,
} from "./postgres-type-options.js";

/** One driver-independent value produced by a resolved PostgreSQL column encoder. */
export type PostgresEncodedValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | { readonly [key: string]: JsonValue }
  | readonly PostgresEncodedValue[];

/** PostgreSQL array data plus the lower bound of each application dimension. */
export interface PostgresArrayDriverValue {
  readonly values: readonly unknown[];
  readonly lowerBounds: readonly number[];
}

/** Final supported PostgreSQL direct physical type name. */
export type PostgresDirectTypeName =
  | "smallint"
  | "integer"
  | "bigint"
  | "numeric"
  | "real"
  | "double-precision"
  | "boolean"
  | "char"
  | "varchar"
  | "text"
  | "uuid"
  | "json"
  | "jsonb"
  | "bytea"
  | "date"
  | "time"
  | "timestamp"
  | "interval"
  | "inet"
  | "cidr"
  | "macaddr"
  | "macaddr8"
  | "point"
  | "line";

/** Final physical facts for one direct PostgreSQL column type. */
export interface PostgresResolvedDirectType {
  readonly kind: "direct";
  readonly type: PostgresDirectTypeName;
  readonly options?: Readonly<
    | PostgresNumericOptions
    | PostgresCharacterOptions
    | PostgresTemporalOptions
    | PostgresIntervalOptions
  >;
}

/** One immutable definition-owned PostgreSQL enum asset. */
export interface PostgresResolvedEnum {
  readonly schema?: string;
  readonly name: string;
  readonly values: readonly [string, ...string[]];
  readonly reference: SqlStatement<never>;
}

/** Final physical facts for one PostgreSQL enum column. */
export interface PostgresResolvedEnumType {
  readonly kind: "enum";
  readonly enum: PostgresResolvedEnum;
}

/** Final physical facts for one PostgreSQL array column. */
export interface PostgresResolvedArrayType {
  readonly kind: "array";
  readonly element: PostgresResolvedColumnType;
}

/** Final physical facts for one external PostgreSQL custom type. */
export interface PostgresResolvedCustomType {
  readonly kind: "custom";
  readonly type: Readonly<PostgresQualifiedName>;
  readonly modifier?: SqlStatement<never>;
}

/** Final physical PostgreSQL type for one resolved column. */
export type PostgresResolvedColumnType =
  | PostgresResolvedDirectType
  | PostgresResolvedEnumType
  | PostgresResolvedArrayType
  | PostgresResolvedCustomType;

/** Normalized PostgreSQL identity-sequence controls. */
export interface PostgresResolvedIdentitySequence {
  readonly name?: Readonly<PostgresQualifiedName>;
  readonly reference?: SqlStatement<never>;
  readonly startWith?: string;
  readonly incrementBy?: string;
  readonly minValue?: string;
  readonly maxValue?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
}

/** Final PostgreSQL identity generation facts. */
export interface PostgresResolvedIdentity {
  readonly mode: "always" | "by-default";
  readonly sequence?: PostgresResolvedIdentitySequence;
}

/** Adapter-facing facts and conversion functions for one PostgreSQL column. */
export interface PostgresResolvedColumn<Field extends FieldDefinition = FieldDefinition> {
  readonly name: string;
  readonly reference: SqlStatement<never>;
  readonly schema: SelectFieldSchema<Field>;
  readonly type: PostgresResolvedColumnType;
  readonly notNull: boolean;
  readonly default?: SqlLiteralValue | SqlStatement<never>;
  readonly identity?: PostgresResolvedIdentity;
  readonly generated?: SqlResolvedGeneratedColumn;
  readonly encode: (
    value: Exclude<FieldOutput<SelectFieldSchema<Field>>, null | undefined>,
  ) => PostgresEncodedValue;
  readonly decode: (value: unknown) => Exclude<FieldOutput<SelectFieldSchema<Field>>, undefined>;
}

/** Adapter-facing final PostgreSQL table facts for one Record. */
export interface PostgresResolvedTable<Definition extends RecordDefinition = RecordDefinition> {
  readonly schema?: string;
  readonly name: string;
  readonly reference: SqlRecordReference<Definition>;
  readonly definition: Definition;
  readonly columns: {
    readonly [Name in keyof Definition["fields"]]: PostgresResolvedColumn<
      Definition["fields"][Name]
    >;
  };
  readonly primaryKey: readonly PostgresResolvedColumn<
    Definition["fields"][keyof Definition["fields"]]
  >[];
}

/** Final PostgreSQL tables keyed by Record catalog name. */
export type PostgresResolvedTables<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: PostgresResolvedTable<Definitions[Name]>;
};

/** Complete immutable PostgreSQL Record resolution for one effective catalog. */
export interface PostgresRecordResolution<Definitions extends RecordDefinitions> {
  readonly records: SqlRecordReferences<Definitions>;
  readonly tables: PostgresResolvedTables<Definitions>;
  readonly enums: readonly PostgresResolvedEnum[];
}

type RuntimeColumn = PostgresResolvedColumn<FieldDefinition>;
type RuntimeTable = PostgresResolvedTable<RecordDefinition>;

type RuntimePhysicalType = {
  readonly resolved: PostgresResolvedColumnType;
  readonly application:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "json"
    | "point"
    | "line"
    | "array"
    | "custom";
  readonly encode: (value: unknown) => PostgresEncodedValue;
  readonly decode: (value: unknown) => JsonValue;
  readonly enumIdentity?: symbol;
};

interface PendingEnum {
  readonly identity: symbol;
  readonly asset: PostgresResolvedEnum;
  readonly path: readonly (string | number)[];
}

interface ResolutionState {
  readonly issues: SqlDefinitionIssue[];
  readonly enums: PendingEnum[];
  readonly enumByIdentity: Map<symbol, PostgresResolvedEnum>;
}

const postgresNameEncoder = new TextEncoder();
const directTypes = new Set<PostgresDirectTypeName>([
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double-precision",
  "boolean",
  "char",
  "varchar",
  "text",
  "uuid",
  "json",
  "jsonb",
  "bytea",
  "date",
  "time",
  "timestamp",
  "interval",
  "inet",
  "cidr",
  "macaddr",
  "macaddr8",
  "point",
  "line",
]);

function isRecordContainer(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldSchema(value: unknown): value is FieldSchema {
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

function selectedSchema(field: FieldDefinition): FieldSchema {
  return isFieldSchema(field) ? field : field.select;
}

function issue(
  code: SqlDefinitionIssue["code"],
  path: readonly (string | number)[],
  message: string,
): SqlDefinitionIssue {
  return { code, path, message };
}

function isValidPostgresName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    postgresNameEncoder.encode(value).byteLength <= 63
  );
}

function qualifiedReference(name: PostgresQualifiedName): SqlStatement<never> {
  return name.schema === undefined
    ? sql.identifier(name.name)
    : sql`${sql.identifier(name.schema)}.${sql.identifier(name.name)}`;
}

function fieldReference(name: string): SqlStatement<never> {
  return sql.identifier(name);
}

function recordReference<Definition extends RecordDefinition>(
  name: PostgresQualifiedName,
  fields: Readonly<Record<string, SqlStatement<never>>>,
): SqlRecordReference<Definition> {
  const statement = qualifiedReference(name);
  return Object.freeze({ ...statement, fields }) as SqlRecordReference<Definition>;
}

function readPostgresMetadata(
  owner: "table" | "column",
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): Readonly<Record<PropertyKey, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecordContainer(value)) {
    issues.push(
      issue("invalid-database-options", path, `PostgreSQL ${owner} refinement must be an object`),
    );
    return undefined;
  }
  const expected = owner === "table" ? "postgres-table" : "postgres-column";
  if (readPostgresMetadataKind(value) !== expected) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        `PostgreSQL ${owner} refinement has an incompatible opaque format`,
      ),
    );
    return undefined;
  }
  return value;
}

function ownNullableOverride(
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

function validStatement(
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
  owner: string,
  code: SqlDefinitionIssue["code"] = "invalid-column-default",
): SqlStatement<never> | undefined {
  const fragments = readSqlStatementFragments(value);
  if (fragments === undefined) {
    issues.push(issue(code, path, `${owner} requires a compatible SQL Statement`));
    return undefined;
  }
  if (fragments.length === 0 || !hasStatementStructure(fragments)) {
    issues.push(issue(code, path, `${owner} requires nonempty SQL structure`));
    return undefined;
  }
  if (fragments.some((fragment) => fragment.kind === "parameter")) {
    issues.push(issue(code, path, `${owner} must not contain SQL parameters`));
    return undefined;
  }
  return value as SqlStatement<never>;
}

function validDatabaseStatement(
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
  owner: string,
): SqlStatement<never> | undefined {
  return validStatement(value, path, issues, owner, "invalid-database-options");
}

function hasStatementStructure(fragments: readonly SqlStatementFragment[]): boolean {
  return fragments.some(
    (fragment) =>
      fragment.kind === "identifier" || (fragment.kind === "raw" && fragment.text.length > 0),
  );
}

function normalizeExactInteger(value: unknown): bigint | undefined {
  if (typeof value === "bigint") {
    return value;
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

function literalMatchesApplication(
  value: SqlLiteralValue,
  application: RuntimePhysicalType["application"],
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
      return true;
    case "point":
    case "line":
    case "array":
      return false;
    case "custom":
      return true;
  }
}

function requiredEvidenceCategory(
  application: RuntimePhysicalType["application"],
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

function evidenceCompatible(
  evidence: ReturnType<typeof reflectSqlSelectStorage>,
  application: RuntimePhysicalType["application"],
): boolean {
  if (evidence === undefined) {
    return true;
  }
  const required = requiredEvidenceCategory(application);
  if (required === undefined) {
    return true;
  }
  if (required === "number") {
    return evidence.type === "number" || evidence.type === "integer";
  }
  return evidence.type === required;
}

function directResolved(
  type: PostgresDirectTypeName,
  options?: Readonly<Record<string, unknown>>,
): PostgresResolvedDirectType {
  return Object.freeze({
    kind: "direct",
    type,
    ...(options === undefined ? {} : { options: Object.freeze({ ...options }) }),
  });
}

function invalidValue(type: string): never {
  throw new TypeError(`PostgreSQL ${type} codec received an invalid value`);
}

function finiteNumber(value: unknown, type: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : invalidValue(type);
}

function boundedInteger(value: unknown, type: string, minimum: number, maximum: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : invalidValue(type);
}

function isExactIntegerText(value: string, minimum: bigint, maximum: bigint): boolean {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value) || value === "-0") {
    return false;
  }
  const parsed = BigInt(value);
  return parsed >= minimum && parsed <= maximum;
}

function safeIntegerCodec(): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "integer",
    encode: (value) =>
      String(boundedInteger(value, "bigint", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
    decode: (value) => {
      if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
        return invalidValue("bigint");
      }
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : invalidValue("bigint");
    },
  };
}

function stringCodec(
  type: string,
  validate: (value: string) => boolean = () => true,
  decode: (value: string) => string = (value) => value,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "string",
    encode: (value) => (typeof value === "string" && validate(value) ? value : invalidValue(type)),
    decode: (value) => {
      if (typeof value !== "string") return invalidValue(type);
      const decoded = decode(value);
      return validate(decoded) ? decoded : invalidValue(type);
    },
  };
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalidValue("bytea");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = base64Alphabet.indexOf(value[index] ?? "");
    const b = base64Alphabet.indexOf(value[index + 1] ?? "");
    const c = value[index + 2] === "=" ? 0 : base64Alphabet.indexOf(value[index + 2] ?? "");
    const d = value[index + 3] === "=" ? 0 : base64Alphabet.indexOf(value[index + 3] ?? "");
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 16) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = bits & 0xff;
  }
  return output;
}

function encodeBase64(value: Uint8Array): string {
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const a = value[index] ?? 0;
    const b = value[index + 1] ?? 0;
    const c = value[index + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    output += base64Alphabet[(bits >> 18) & 63];
    output += base64Alphabet[(bits >> 12) & 63];
    output += index + 1 < value.length ? base64Alphabet[(bits >> 6) & 63] : "=";
    output += index + 2 < value.length ? base64Alphabet[bits & 63] : "=";
  }
  return output;
}

function leapYear(year: bigint): boolean {
  return year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
}

interface PostgresDateParts {
  readonly year: bigint;
  readonly yearWidth: number;
  readonly forceSign: boolean;
  readonly month: number;
  readonly day: number;
}

interface PostgresTimeParts {
  readonly hour: number;
  readonly minute: number;
  readonly second: string;
  readonly fraction: string;
  readonly offsetMinutes?: number;
}

function postgresDaysInMonth(year: bigint, month: number): number {
  return [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function parsePostgresDate(value: string): PostgresDateParts | undefined {
  const match = /^([+-]?)(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const sign = match[1] ?? "";
  const yearDigits = match[2] ?? "0";
  const year = BigInt(`${sign}${yearDigits}`);
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > postgresDaysInMonth(year, month)) {
    return undefined;
  }
  return {
    year,
    yearWidth: yearDigits.length,
    forceSign: sign.length > 0,
    month,
    day,
  };
}

function validDate(value: string): boolean {
  return parsePostgresDate(value) !== undefined;
}

function parsePostgresTimeZone(value: string): number | undefined {
  if (value === "Z") return 0;
  const match = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(value);
  if (match === null) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (hours > 15 || minutes > 59) return undefined;
  const offset = hours * 60 + minutes;
  return match[1] === "-" ? -offset : offset;
}

function parsePostgresTime(
  value: string,
  withTimezone: boolean,
  allowOffset: boolean,
): PostgresTimeParts | undefined {
  const match = /^(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const zone = match[5];
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (!withTimezone && zone !== undefined) return undefined;
  if (withTimezone && (zone === undefined || (!allowOffset && zone !== "Z"))) return undefined;
  const offsetMinutes = zone === undefined ? undefined : parsePostgresTimeZone(zone);
  if (zone !== undefined && offsetMinutes === undefined) return undefined;
  return {
    hour,
    minute,
    second: match[3] ?? "00",
    fraction: match[4] ?? "",
    ...(offsetMinutes === undefined ? {} : { offsetMinutes }),
  };
}

function validTime(value: string, withTimezone: boolean): boolean {
  return parsePostgresTime(value, withTimezone, false) !== undefined;
}

function normalizePostgresClock(parts: PostgresTimeParts): {
  readonly time: string;
  readonly dayOffset: number;
} {
  const shiftedMinutes = parts.hour * 60 + parts.minute - (parts.offsetMinutes ?? 0);
  const dayOffset = Math.floor(shiftedMinutes / (24 * 60));
  const normalizedMinutes = ((shiftedMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(normalizedMinutes / 60);
  const minute = normalizedMinutes % 60;
  return {
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${parts.second}${parts.fraction}`,
    dayOffset,
  };
}

function formatPostgresDate(parts: PostgresDateParts): string {
  const absoluteYear = parts.year < 0n ? -parts.year : parts.year;
  const digits = absoluteYear.toString().padStart(parts.yearWidth, "0");
  const sign = parts.year < 0n ? "-" : parts.forceSign ? "+" : "";
  return `${sign}${digits}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function shiftPostgresDate(parts: PostgresDateParts, dayOffset: number): PostgresDateParts {
  let { year, month, day } = parts;
  if (dayOffset < 0) {
    day -= 1;
    if (day === 0) {
      month -= 1;
      if (month === 0) {
        year -= 1n;
        month = 12;
      }
      day = postgresDaysInMonth(year, month);
    }
  } else if (dayOffset > 0) {
    day += 1;
    if (day > postgresDaysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month === 13) {
        year += 1n;
        month = 1;
      }
    }
  }
  return { ...parts, year, month, day };
}

function normalizePostgresTime(value: string, withTimezone: boolean): string | undefined {
  const parts = parsePostgresTime(value, withTimezone, true);
  if (parts === undefined) return undefined;
  if (!withTimezone) return value;
  return `${normalizePostgresClock(parts).time}Z`;
}

function validTimestamp(value: string, withTimezone: boolean): boolean {
  const separator = value.indexOf("T");
  return (
    separator > 0 &&
    parsePostgresDate(value.slice(0, separator)) !== undefined &&
    parsePostgresTime(value.slice(separator + 1), withTimezone, false) !== undefined
  );
}

function normalizePostgresTimestamp(value: string, withTimezone: boolean): string | undefined {
  const match = /^(.+?)[T ](.+)$/.exec(value);
  if (match === null) return undefined;
  const dateText = match[1] ?? "";
  const timeText = match[2] ?? "";
  const date = parsePostgresDate(dateText);
  const time = parsePostgresTime(timeText, withTimezone, true);
  if (date === undefined || time === undefined) return undefined;
  if (!withTimezone) return `${dateText}T${timeText}`;
  const normalized = normalizePostgresClock(time);
  return `${formatPostgresDate(shiftPostgresDate(date, normalized.dayOffset))}T${normalized.time}Z`;
}

function temporalCodec(
  type: "date" | "time" | "timestamp",
  validateInput: (value: string) => boolean,
  normalizeOutput: (value: string) => string | undefined,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "string",
    encode: (value) =>
      typeof value === "string" && validateInput(value) ? value : invalidValue(type),
    decode: (value) => {
      if (value instanceof Date || typeof value !== "string") return invalidValue(type);
      return normalizeOutput(value) ?? invalidValue(type);
    },
  };
}

function validInterval(value: string): boolean {
  return /^-?P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d{1,6})?S)?)?$/.test(
    value,
  );
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function validMac(value: string, octets: number): boolean {
  return new RegExp(`^(?:[0-9a-f]{2}:){${octets - 1}}[0-9a-f]{2}$`).test(value);
}

function numericCodec(
  options: Readonly<Record<string, unknown>> | undefined,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const valid = (value: string): boolean => {
    if (value === "NaN" || value === "Infinity" || value === "-Infinity") return true;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
    const precision = options?.precision;
    if (typeof precision !== "number") return true;
    const scale = typeof options?.scale === "number" ? options.scale : 0;
    const unsigned = value.startsWith("-") ? value.slice(1) : value;
    const [whole = "0"] = unsigned.split(".");
    return whole.replace(/^0+/, "").length <= precision - scale;
  };
  return stringCodec("numeric", valid);
}

function pointCodec(
  type: "point" | "line",
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const keys = type === "point" ? (["x", "y"] as const) : (["a", "b", "c"] as const);
  const convert = (value: unknown): JsonValue => {
    if (!isRecordContainer(value) || Reflect.ownKeys(value).length !== keys.length) {
      return invalidValue(type);
    }
    const entries: [string, number][] = [];
    for (const key of keys) {
      const part = Reflect.get(value, key);
      if (typeof part !== "number" || !Number.isFinite(part)) return invalidValue(type);
      entries.push([key, Object.is(part, -0) ? 0 : part]);
    }
    return Object.freeze(Object.fromEntries(entries)) as JsonValue;
  };
  return { application: type, encode: convert, decode: convert };
}

function jsonCodec(
  type: "json" | "jsonb",
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const convert = (value: unknown): JsonValue => (isJsonValue(value) ? value : invalidValue(type));
  return { application: "json", encode: convert, decode: convert };
}

function directCodec(
  type: PostgresDirectTypeName,
  options?: Readonly<Record<string, unknown>>,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  switch (type) {
    case "smallint":
      return {
        application: "integer",
        encode: (value) => boundedInteger(value, type, -32_768, 32_767),
        decode: (value) => boundedInteger(value, type, -32_768, 32_767),
      };
    case "integer":
      return {
        application: "integer",
        encode: (value) => boundedInteger(value, type, -2_147_483_648, 2_147_483_647),
        decode: (value) => boundedInteger(value, type, -2_147_483_648, 2_147_483_647),
      };
    case "bigint":
      return stringCodec(type, (value) =>
        isExactIntegerText(value, -9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n),
      );
    case "numeric":
      return numericCodec(options);
    case "real":
    case "double-precision":
      return {
        application: "number",
        encode: (value) => finiteNumber(value, type),
        decode: (value) => {
          const number = finiteNumber(value, type);
          return Object.is(number, -0) ? 0 : number;
        },
      };
    case "boolean":
      return {
        application: "boolean",
        encode: (value) => (typeof value === "boolean" ? value : invalidValue(type)),
        decode: (value) => (typeof value === "boolean" ? value : invalidValue(type)),
      };
    case "char":
      return stringCodec(
        type,
        (value) => !value.endsWith(" "),
        (value) => value.replace(/ +$/, ""),
      );
    case "varchar":
    case "text":
      return stringCodec(type);
    case "uuid":
      return stringCodec(type, validUuid);
    case "json":
    case "jsonb":
      return jsonCodec(type);
    case "bytea":
      return {
        application: "string",
        encode: (value) => (typeof value === "string" ? decodeBase64(value) : invalidValue(type)),
        decode: (value) => (value instanceof Uint8Array ? encodeBase64(value) : invalidValue(type)),
      };
    case "date":
      return temporalCodec(type, validDate, (value) => (validDate(value) ? value : undefined));
    case "time": {
      const withTimezone = options?.withTimezone === true;
      return temporalCodec(
        type,
        (value) => validTime(value, withTimezone),
        (value) => normalizePostgresTime(value, withTimezone),
      );
    }
    case "timestamp": {
      const withTimezone = options?.withTimezone === true;
      return temporalCodec(
        type,
        (value) => validTimestamp(value, withTimezone),
        (value) => normalizePostgresTimestamp(value, withTimezone),
      );
    }
    case "interval":
      return stringCodec(type, validInterval);
    case "inet":
    case "cidr":
      return stringCodec(type, (value) => value.length > 0 && !value.includes(" "));
    case "macaddr":
      return stringCodec(type, (value) => validMac(value, 6));
    case "macaddr8":
      return stringCodec(type, (value) => validMac(value, 8));
    case "point":
    case "line":
      return pointCodec(type);
  }
}

function dimensions(value: readonly unknown[], depth = 0): readonly number[] | undefined {
  if (depth >= 6) return undefined;
  const childArrays = value.filter(Array.isArray);
  if (childArrays.length === 0) return Object.freeze([value.length]);
  if (childArrays.length !== value.length) return undefined;
  const first = dimensions(childArrays[0] ?? [], depth + 1);
  if (first === undefined) return undefined;
  for (const child of childArrays.slice(1)) {
    const shape = dimensions(child, depth + 1);
    if (
      shape === undefined ||
      shape.length !== first.length ||
      shape.some((size, index) => size !== first[index])
    ) {
      return undefined;
    }
  }
  return Object.freeze([value.length, ...first]);
}

function arrayCodec(
  element: RuntimePhysicalType,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const readInput = (value: unknown, checkBounds: boolean): readonly unknown[] => {
    const input =
      checkBounds && isRecordContainer(value) && Array.isArray(Reflect.get(value, "values"))
        ? Reflect.get(value, "values")
        : value;
    if (!Array.isArray(input)) return invalidValue("array");
    const shape = dimensions(input);
    if (shape === undefined || shape.length > 6) return invalidValue("array");
    if (checkBounds && isRecordContainer(value) && Object.hasOwn(value, "lowerBounds")) {
      const lowerBounds = Reflect.get(value, "lowerBounds");
      if (
        !Array.isArray(lowerBounds) ||
        lowerBounds.length !== shape.length ||
        lowerBounds.some((bound) => bound !== 1)
      ) {
        return invalidValue("array lower bound");
      }
    }
    return input;
  };
  const encodeItems = (items: readonly unknown[]): readonly PostgresEncodedValue[] =>
    Object.freeze(items.map((item) => (item === null ? null : element.encode(item))));
  const decodeItems = (items: readonly unknown[]): readonly JsonValue[] =>
    Object.freeze(items.map((item) => (item === null ? null : element.decode(item))));
  return {
    application: "array",
    encode: (value) => encodeItems(readInput(value, false)),
    decode: (value) => decodeItems(readInput(value, true)),
  };
}

function readTypeOptions(
  format: SqlColumnTypeFormat,
): Readonly<Record<string, unknown>> | undefined {
  return format.options;
}

function validateDirectOptions(
  type: PostgresDirectTypeName,
  options: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (options === undefined) return true;
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => typeof key !== "string")) return false;
  switch (type) {
    case "numeric": {
      if (!keys.every((key) => key === "precision" || key === "scale")) return false;
      const precision = options.precision;
      const scale = options.scale;
      return (
        isPostgresNumericPrecisionOption(precision) &&
        isPostgresNumericScaleOption(scale) &&
        isPostgresNumericScaleCompatible(precision, scale)
      );
    }
    case "char":
    case "varchar":
      return (
        keys.every((key) => key === "length") && isPostgresCharacterLengthOption(options.length)
      );
    case "time":
    case "timestamp":
      return (
        keys.every((key) => key === "precision" || key === "withTimezone") &&
        isPostgresTemporalPrecisionOption(options.precision) &&
        isPostgresTimeZoneOption(options.withTimezone)
      );
    case "interval": {
      if (!keys.every((key) => key === "fields" || key === "precision")) return false;
      const fields = options.fields;
      const precision = options.precision;
      return (
        isPostgresIntervalFieldOption(fields) &&
        isPostgresTemporalPrecisionOption(precision) &&
        isPostgresIntervalPrecisionCompatible(fields, precision)
      );
    }
    default:
      return keys.length === 0;
  }
}

function resolvePortableType(type: SqlPortableTypeName): RuntimePhysicalType {
  switch (type) {
    case "text": {
      const codec = stringCodec("text");
      return Object.freeze({ resolved: directResolved("text"), ...codec });
    }
    case "number": {
      const codec = directCodec("double-precision");
      return Object.freeze({ resolved: directResolved("double-precision"), ...codec });
    }
    case "integer": {
      const codec = safeIntegerCodec();
      return Object.freeze({ resolved: directResolved("bigint"), ...codec });
    }
    case "boolean": {
      const codec = directCodec("boolean");
      return Object.freeze({ resolved: directResolved("boolean"), ...codec });
    }
    case "json": {
      const codec = directCodec("json");
      return Object.freeze({ resolved: directResolved("json"), ...codec });
    }
  }
}

function portableType(format: SqlColumnTypeFormat): SqlPortableTypeName | undefined {
  if (format.dialect !== "portable") return undefined;
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

function resolvePostgresType(
  format: SqlColumnTypeFormat,
  path: readonly (string | number)[],
  state: ResolutionState,
  arrayDepth = 0,
): RuntimePhysicalType | undefined {
  if (format.dialect !== "postgres") {
    state.issues.push(
      issue("invalid-column-type", path, "PostgreSQL column requires a PostgreSQL type"),
    );
    return undefined;
  }
  const options = readTypeOptions(format);
  if (directTypes.has(format.type as PostgresDirectTypeName)) {
    const type = format.type as PostgresDirectTypeName;
    if (!validateDirectOptions(type, options)) {
      state.issues.push(
        issue("invalid-column-type", path, `PostgreSQL ${type} type options are invalid`),
      );
      return undefined;
    }
    const codec = directCodec(type, options);
    return Object.freeze({ resolved: directResolved(type, options), ...codec });
  }
  if (format.type === "enum") {
    if (options === undefined) {
      state.issues.push(
        issue("invalid-column-type", path, "PostgreSQL enum type options are missing"),
      );
      return undefined;
    }
    const schema = options.schema;
    const name = options.name;
    const values = options.values;
    const identity = options.identity;
    if (
      (schema !== undefined && !isValidPostgresName(schema)) ||
      !isValidPostgresName(name) ||
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => !isValidPostgresName(value)) ||
      new Set(values).size !== values.length ||
      typeof identity !== "symbol"
    ) {
      state.issues.push(
        issue("invalid-column-type", path, "PostgreSQL enum type contract is invalid"),
      );
      return undefined;
    }
    let asset = state.enumByIdentity.get(identity);
    if (asset === undefined) {
      const tuple = Object.freeze([...values]) as unknown as readonly [string, ...string[]];
      const qualified = Object.freeze({ ...(schema === undefined ? {} : { schema }), name });
      asset = Object.freeze({
        ...qualified,
        values: tuple,
        reference: qualifiedReference(qualified),
      });
      state.enumByIdentity.set(identity, asset);
      state.enums.push({ identity, asset, path });
    }
    const accepted = new Set(asset.values);
    const codec = stringCodec("enum", (value) => accepted.has(value));
    return Object.freeze({
      resolved: Object.freeze({ kind: "enum", enum: asset }),
      ...codec,
      enumIdentity: identity,
    });
  }
  if (format.type === "array") {
    if (arrayDepth >= 6) {
      state.issues.push(
        issue(
          "invalid-column-type",
          path,
          "PostgreSQL array type exceeds the six-dimensional limit",
        ),
      );
      return undefined;
    }
    const element = options?.element;
    const elementFormat = readSqlColumnTypeFormat(element);
    if (elementFormat === undefined || elementFormat.dialect !== "postgres") {
      state.issues.push(
        issue("invalid-column-type", path, "PostgreSQL array element type is invalid"),
      );
      return undefined;
    }
    const elementResolution = resolvePostgresType(
      elementFormat,
      [...path, "element"],
      state,
      arrayDepth + 1,
    );
    if (elementResolution === undefined) return undefined;
    const codec = arrayCodec(elementResolution);
    return Object.freeze({
      resolved: Object.freeze({ kind: "array", element: elementResolution.resolved }),
      ...codec,
    });
  }
  if (format.type === "custom") {
    const type = options?.type;
    const encode = options?.encode;
    const decode = options?.decode;
    if (
      !isRecordContainer(type) ||
      !isValidPostgresName(Reflect.get(type, "name")) ||
      (Object.hasOwn(type, "schema") && !isValidPostgresName(Reflect.get(type, "schema"))) ||
      typeof encode !== "function" ||
      typeof decode !== "function"
    ) {
      state.issues.push(
        issue("invalid-column-type", path, "PostgreSQL custom type contract is invalid"),
      );
      return undefined;
    }
    let modifier: SqlStatement<never> | undefined;
    if (Object.hasOwn(type, "modifier")) {
      modifier = validDatabaseStatement(
        Reflect.get(type, "modifier"),
        [...path, "type", "modifier"],
        state.issues,
        "PostgreSQL custom type modifier",
      );
    }
    const qualified = Object.freeze({
      ...(Object.hasOwn(type, "schema") ? { schema: Reflect.get(type, "schema") as string } : {}),
      name: Reflect.get(type, "name") as string,
    });
    const resolved = Object.freeze({
      kind: "custom" as const,
      type: qualified,
      ...(modifier === undefined ? {} : { modifier }),
    });
    const encodeValue = (value: unknown): PostgresEncodedValue => {
      const converted = (encode as (input: unknown) => unknown)(value);
      return isCustomEncodedValue(converted) ? converted : invalidValue("custom encoder output");
    };
    const decodeValue = (value: unknown): JsonValue => {
      const converted = (decode as (input: unknown) => unknown)(value);
      return isJsonValue(converted) ? converted : invalidValue("custom decoder output");
    };
    return Object.freeze({
      resolved,
      application: "custom",
      encode: encodeValue,
      decode: decodeValue,
    });
  }
  state.issues.push(issue("invalid-column-type", path, `Unknown PostgreSQL type '${format.type}'`));
  return undefined;
}

function isCustomEncodedValue(value: unknown): value is SqlCustomEncodedValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    value instanceof Uint8Array
  );
}

function resolvePhysicalType(
  value: unknown,
  evidence: ReturnType<typeof reflectSqlSelectStorage>,
  path: readonly (string | number)[],
  state: ResolutionState,
): RuntimePhysicalType | undefined {
  if (value === undefined) {
    if (evidence === undefined) {
      state.issues.push(
        issue(
          "column-type-required",
          path,
          "PostgreSQL column requires explicit storage type evidence",
        ),
      );
      return undefined;
    }
    return resolvePortableType(evidence.type);
  }
  const format = readSqlColumnTypeFormat(value);
  if (format === undefined) {
    state.issues.push(
      issue(
        "invalid-column-type",
        path,
        "PostgreSQL column type has an incompatible opaque format",
      ),
    );
    return undefined;
  }
  const portable = portableType(format);
  return portable === undefined
    ? resolvePostgresType(format, path, state)
    : resolvePortableType(portable);
}

function integerRange(type: PostgresResolvedColumnType): readonly [bigint, bigint] | undefined {
  if (type.kind !== "direct") return undefined;
  switch (type.type) {
    case "smallint":
      return [-32_768n, 32_767n];
    case "integer":
      return [-2_147_483_648n, 2_147_483_647n];
    case "bigint":
      return [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n];
    default:
      return undefined;
  }
}

function resolveIdentity(
  value: unknown,
  type: PostgresResolvedColumnType,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): PostgresResolvedIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isRecordContainer(value)) {
    issues.push(issue("invalid-database-options", path, "PostgreSQL identity must be an object"));
    return undefined;
  }
  const mode = Reflect.get(value, "mode");
  if (mode !== "always" && mode !== "by-default") {
    issues.push(
      issue("invalid-database-options", [...path, "mode"], "PostgreSQL identity mode is invalid"),
    );
    return undefined;
  }
  const range = integerRange(type);
  if (range === undefined) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        "PostgreSQL identity requires an integer physical type",
      ),
    );
    return undefined;
  }
  if (!Object.hasOwn(value, "sequence")) return Object.freeze({ mode });
  const sequence = Reflect.get(value, "sequence");
  if (!isRecordContainer(sequence)) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence"],
        "PostgreSQL identity sequence must be an object",
      ),
    );
    return undefined;
  }
  let name: Readonly<PostgresQualifiedName> | undefined;
  if (Object.hasOwn(sequence, "name")) {
    const candidate = Reflect.get(sequence, "name");
    if (
      !isRecordContainer(candidate) ||
      !isValidPostgresName(Reflect.get(candidate, "name")) ||
      (Object.hasOwn(candidate, "schema") && !isValidPostgresName(Reflect.get(candidate, "schema")))
    ) {
      issues.push(
        issue(
          "invalid-database-options",
          [...path, "sequence", "name"],
          "PostgreSQL identity sequence name is invalid",
        ),
      );
    } else {
      name = Object.freeze({
        ...(Object.hasOwn(candidate, "schema")
          ? { schema: Reflect.get(candidate, "schema") as string }
          : {}),
        name: Reflect.get(candidate, "name") as string,
      });
    }
  }
  const normalized = new Map<string, bigint>();
  for (const key of ["startWith", "incrementBy", "minValue", "maxValue", "cache"] as const) {
    if (!Object.hasOwn(sequence, key)) continue;
    const integer = normalizeExactInteger(Reflect.get(sequence, key));
    if (integer === undefined || integer < range[0] || integer > range[1]) {
      issues.push(
        issue(
          "invalid-database-options",
          [...path, "sequence", key],
          `PostgreSQL identity sequence '${key}' is outside the column range`,
        ),
      );
    } else {
      normalized.set(key, integer);
    }
  }
  if (normalized.get("incrementBy") === 0n) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "incrementBy"],
        "PostgreSQL identity increment must not be zero",
      ),
    );
  }
  const cache = normalized.get("cache");
  if (cache !== undefined && cache < 1n) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "cache"],
        "PostgreSQL identity cache must be at least one",
      ),
    );
  }
  const minimum = normalized.get("minValue");
  const maximum = normalized.get("maxValue");
  const start = normalized.get("startWith");
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "maxValue"],
        "PostgreSQL identity minimum exceeds its maximum",
      ),
    );
  }
  if (
    start !== undefined &&
    ((minimum !== undefined && start < minimum) || (maximum !== undefined && start > maximum))
  ) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "startWith"],
        "PostgreSQL identity start is outside its explicit bounds",
      ),
    );
  }
  if (Object.hasOwn(sequence, "cycle") && typeof Reflect.get(sequence, "cycle") !== "boolean") {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "cycle"],
        "PostgreSQL identity cycle must be a boolean",
      ),
    );
  }
  const resolvedSequence = Object.freeze({
    ...(name === undefined ? {} : { name, reference: qualifiedReference(name) }),
    ...Object.fromEntries([...normalized].map(([key, integer]) => [key, integer.toString()])),
    ...(typeof Reflect.get(sequence, "cycle") === "boolean"
      ? { cycle: Reflect.get(sequence, "cycle") as boolean }
      : {}),
  });
  return Object.freeze({ mode, sequence: resolvedSequence });
}

function resolveDefault(
  value: unknown,
  physical: RuntimePhysicalType,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): SqlLiteralValue | SqlStatement<never> | undefined {
  if (value === undefined) return undefined;
  const literal = readSqlLiteralFormat(value);
  if (literal !== undefined) {
    if (!literalMatchesApplication(literal.value, physical.application)) {
      issues.push(
        issue(
          "invalid-column-default",
          path,
          "PostgreSQL column default does not match its final type",
        ),
      );
      return undefined;
    }
    return literal.value;
  }
  return validStatement(value, path, issues, "PostgreSQL column default");
}

function resolveGenerated(
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): SqlResolvedGeneratedColumn | undefined {
  if (value === undefined) return undefined;
  const expression = validDatabaseStatement(value, path, issues, "PostgreSQL generated expression");
  return expression === undefined ? undefined : Object.freeze({ expression, mode: "stored" });
}

function namespaceKey(name: PostgresQualifiedName): string {
  return name.schema === undefined
    ? `unqualified\0${name.name}`
    : `qualified\0${name.schema}\0${name.name}`;
}

function validatePrimaryKey(
  value: unknown,
  definition: RecordDefinition,
  columns: Readonly<Record<string, RuntimeColumn>>,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): readonly RuntimeColumn[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(
      issue("invalid-primary-key", path, "SQL Record primary key must be a nonempty field tuple"),
    );
    return Object.freeze([]);
  }
  const result: RuntimeColumn[] = [];
  const names = new Set<string>();
  value.forEach((fieldName, index) => {
    if (typeof fieldName !== "string" || fieldName.length === 0 || names.has(fieldName)) {
      issues.push(
        issue(
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
        issue(
          "invalid-primary-key",
          [...path, index],
          `SQL Record primary key names unknown field '${fieldName}'`,
        ),
      );
      return;
    }
    const column = columns[fieldName];
    if (column === undefined) return;
    if (!column.notNull) {
      issues.push(
        issue(
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

function resolveRuntime(
  definitions: RecordDefinitions,
): PostgresRecordResolution<RecordDefinitions> {
  const state: ResolutionState = { issues: [], enums: [], enumByIdentity: new Map() };
  const tables = new Map<string, RuntimeTable>();
  const records = new Map<string, SqlRecordReference<RecordDefinition>>();
  const namespaceAssets: Array<{
    readonly relation?: {
      readonly name: PostgresQualifiedName;
      readonly path: readonly (string | number)[];
      readonly owner: string;
    };
    readonly type?: {
      readonly name: PostgresQualifiedName;
      readonly path: readonly (string | number)[];
      readonly owner: string;
    };
  }> = [];

  for (const [recordName, definition] of Object.entries(definitions)) {
    const recordPath = ["records", recordName] as const;
    const tableValue = Object.hasOwn(definition, "table")
      ? Reflect.get(definition, "table")
      : undefined;
    const table =
      tableValue === undefined ? undefined : isRecordContainer(tableValue) ? tableValue : undefined;
    if (tableValue !== undefined && table === undefined) {
      state.issues.push(
        issue(
          "invalid-definition",
          [...recordPath, "table"],
          "SQL Record table metadata must be an object",
        ),
      );
    }
    const postgresValue = table === undefined ? undefined : Reflect.get(table, "postgres");
    if (isRecordContainer(postgresValue)) {
      for (const key of ["schema", "name"] as const) {
        if (Object.hasOwn(postgresValue, key)) {
          const candidate = Reflect.get(postgresValue, key);
          if (candidate !== null && !isValidPostgresName(candidate)) {
            state.issues.push(
              issue(
                "invalid-name",
                [...recordPath, "table", "postgres", key],
                `PostgreSQL table ${key} is invalid`,
              ),
            );
          }
        }
      }
    }
    const postgresTable = readPostgresMetadata(
      "table",
      postgresValue,
      [...recordPath, "table", "postgres"],
      state.issues,
    );
    const schemaValue = ownNullableOverride(postgresTable, undefined, "schema");
    const nameValue = ownNullableOverride(postgresTable, table, "name") ?? recordName;
    const tableNameValid = isValidPostgresName(nameValue);
    const schemaValid = schemaValue === undefined || isValidPostgresName(schemaValue);
    if (!tableNameValid) {
      state.issues.push(
        issue("invalid-name", [...recordPath, "table", "name"], "PostgreSQL table name is invalid"),
      );
    }
    if (!schemaValid) {
      state.issues.push(
        issue(
          "invalid-name",
          [...recordPath, "table", "postgres", "schema"],
          "PostgreSQL table schema is invalid",
        ),
      );
    }
    const primaryKeyValue = table?.primaryKey;

    const columns = new Map<string, RuntimeColumn>();
    const fieldStatements = new Map<string, SqlStatement<never>>();
    const columnNames = new Map<string, string>();
    for (const [fieldName, field] of Object.entries(definition.fields)) {
      const fieldPath = [...recordPath, "fields", fieldName] as const;
      const columnValue =
        isFieldSchema(field) || !Object.hasOwn(field, "column")
          ? undefined
          : Reflect.get(field, "column");
      const column =
        columnValue === undefined
          ? undefined
          : isRecordContainer(columnValue)
            ? columnValue
            : undefined;
      if (columnValue !== undefined && column === undefined) {
        state.issues.push(
          issue(
            "invalid-definition",
            [...fieldPath, "column"],
            `SQL Record field '${fieldName}' column metadata must be an object`,
          ),
        );
      }
      const postgresColumnValue =
        column === undefined ? undefined : Reflect.get(column, "postgres");
      if (isRecordContainer(postgresColumnValue) && Object.hasOwn(postgresColumnValue, "name")) {
        const candidate = Reflect.get(postgresColumnValue, "name");
        if (candidate !== null && !isValidPostgresName(candidate)) {
          state.issues.push(
            issue(
              "invalid-name",
              [...fieldPath, "column", "postgres", "name"],
              `PostgreSQL column '${fieldName}' name is invalid`,
            ),
          );
        }
      }
      const postgresColumn = readPostgresMetadata(
        "column",
        postgresColumnValue,
        [...fieldPath, "column", "postgres"],
        state.issues,
      );
      const columnName = ownNullableOverride(postgresColumn, column, "name") ?? fieldName;
      if (!isValidPostgresName(columnName)) {
        state.issues.push(
          issue(
            "invalid-name",
            [...fieldPath, "column", "name"],
            `PostgreSQL column '${fieldName}' name is invalid`,
          ),
        );
        continue;
      }
      const evidence = reflectSqlSelectStorage(selectedSchema(field));
      const typeValue = ownNullableOverride(postgresColumn, column, "type");
      const physical = resolvePhysicalType(
        typeValue,
        evidence,
        [...fieldPath, "column", "type"],
        state,
      );
      if (physical === undefined) continue;
      if (!evidenceCompatible(evidence, physical.application)) {
        state.issues.push(
          issue(
            "invalid-column-type",
            [...fieldPath, "column", "type"],
            `PostgreSQL column '${fieldName}' type conflicts with Select Schema output`,
          ),
        );
      }
      const defaultValue = ownNullableOverride(postgresColumn, column, "default");
      const resolvedDefault = resolveDefault(
        defaultValue,
        physical,
        [...fieldPath, "column", "default"],
        state.issues,
      );
      const selectedNull = evidence?.selectedNull ?? false;
      const selectedPresence = evidence?.presence ?? "unknown";
      const explicitNotNull = ownNullableOverride(postgresColumn, column, "notNull");
      let notNull =
        typeof explicitNotNull === "boolean"
          ? explicitNotNull
          : selectedPresence === "required" && (physical.application === "json" || !selectedNull);
      if (explicitNotNull !== undefined && typeof explicitNotNull !== "boolean") {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "notNull"],
            `PostgreSQL column '${fieldName}' notNull option is invalid`,
          ),
        );
      }
      const identityValue =
        postgresColumn === undefined
          ? undefined
          : ownNullableOverride(postgresColumn, undefined, "identity");
      const identity = resolveIdentity(
        identityValue,
        physical.resolved,
        [...fieldPath, "column", "postgres", "identity"],
        state.issues,
      );
      if (identity !== undefined) notNull = true;
      if (notNull && selectedNull && physical.application !== "json") {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "notNull"],
            `PostgreSQL column '${fieldName}' Select Schema permits SQL NULL`,
          ),
        );
      }
      const generatedValue =
        postgresColumn === undefined
          ? undefined
          : ownNullableOverride(postgresColumn, undefined, "generated");
      const generated = resolveGenerated(
        generatedValue,
        [...fieldPath, "column", "postgres", "generated"],
        state.issues,
      );
      if (identity !== undefined && explicitNotNull === false) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "postgres", "identity"],
            "PostgreSQL identity conflicts with notNull false",
          ),
        );
      }
      if (identity !== undefined && resolvedDefault !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "postgres", "identity"],
            "PostgreSQL identity conflicts with an explicit default",
          ),
        );
      }
      if (generated !== undefined && resolvedDefault !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "postgres", "generated"],
            "PostgreSQL generated column conflicts with a default",
          ),
        );
      }
      if (generated !== undefined && identity !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "postgres", "generated"],
            "PostgreSQL generated column conflicts with identity",
          ),
        );
      }
      const reference = fieldReference(columnName);
      const resolvedColumn = Object.freeze({
        name: columnName,
        reference,
        schema: selectedSchema(field),
        type: physical.resolved,
        notNull,
        ...(resolvedDefault === undefined ? {} : { default: resolvedDefault }),
        ...(identity === undefined ? {} : { identity }),
        ...(generated === undefined ? {} : { generated }),
        encode: physical.encode,
        decode: physical.decode,
      }) as RuntimeColumn;
      columns.set(fieldName, resolvedColumn);
      fieldStatements.set(fieldName, reference);
      const earlier = columnNames.get(columnName);
      if (earlier === undefined) columnNames.set(columnName, fieldName);
      else
        state.issues.push(
          issue(
            "duplicate-name",
            [...fieldPath, "column", "name"],
            `PostgreSQL column '${columnName}' conflicts with field '${earlier}'`,
          ),
        );
    }

    const primaryKey = validatePrimaryKey(
      primaryKeyValue,
      definition,
      Object.freeze(Object.fromEntries(columns)),
      [...recordPath, "table", "primaryKey"],
      state.issues,
    );
    if (!tableNameValid || !schemaValid) continue;
    const qualified = Object.freeze({
      ...(schemaValue === undefined ? {} : { schema: schemaValue }),
      name: nameValue,
    });
    const fields = Object.freeze(Object.fromEntries(fieldStatements));
    const reference = recordReference<RecordDefinition>(qualified, fields);
    const resolvedTable = Object.freeze({
      ...qualified,
      reference,
      definition,
      columns: Object.freeze(Object.fromEntries(columns)),
      primaryKey,
    }) as RuntimeTable;
    tables.set(recordName, resolvedTable);
    records.set(recordName, reference);
    namespaceAssets.push({
      relation: {
        name: qualified,
        path: [...recordPath, "table", "name"],
        owner: `table '${recordName}'`,
      },
      type: {
        name: qualified,
        path: [...recordPath, "table", "name"],
        owner: `table row type '${recordName}'`,
      },
    });
    for (const [fieldName, column] of columns) {
      const sequence = column.identity?.sequence;
      if (sequence?.name !== undefined) {
        namespaceAssets.push({
          relation: {
            name: sequence.name,
            path: [
              ...recordPath,
              "fields",
              fieldName,
              "column",
              "postgres",
              "identity",
              "sequence",
              "name",
            ],
            owner: `identity sequence '${recordName}.${fieldName}'`,
          },
        });
      }
    }
  }

  for (const pending of state.enums) {
    namespaceAssets.push({
      type: { name: pending.asset, path: pending.path, owner: `enum '${pending.asset.name}'` },
    });
  }
  const relations = new Map<string, string>();
  const types = new Map<string, string>();
  for (const asset of namespaceAssets) {
    if (asset.relation !== undefined) {
      const key = namespaceKey(asset.relation.name);
      const earlier = relations.get(key);
      if (earlier === undefined) relations.set(key, asset.relation.owner);
      else
        state.issues.push(
          issue(
            "duplicate-name",
            asset.relation.path,
            `PostgreSQL ${asset.relation.owner} conflicts with ${earlier}`,
          ),
        );
    }
    if (asset.type !== undefined) {
      const key = namespaceKey(asset.type.name);
      const earlier = types.get(key);
      if (earlier === undefined) types.set(key, asset.type.owner);
      else
        state.issues.push(
          issue(
            "duplicate-name",
            asset.type.path,
            `PostgreSQL ${asset.type.owner} conflicts with ${earlier}`,
          ),
        );
    }
  }

  if (state.issues.length > 0) throw new SqlDefinitionError(state.issues);
  return Object.freeze({
    records: Object.freeze(Object.fromEntries(records)),
    tables: Object.freeze(Object.fromEntries(tables)),
    enums: Object.freeze(state.enums.map(({ asset }) => asset)),
  });
}

/** Resolve effective SQL Records into immutable PostgreSQL adapter assets without I/O. */
export function resolvePostgresRecords<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions> = {},
>(options: {
  readonly records: Definitions & RoundTripRecordDefinitions<Definitions>;
  readonly overrides?: Overrides & CompatibleRecordOverrides<Definitions, Overrides>;
}): PostgresRecordResolution<ApplyOverrides<Definitions, Overrides>> {
  let definitions: RecordDefinitions;
  try {
    const overrides =
      options.overrides ?? ({} as Overrides & CompatibleRecordOverrides<Definitions, Overrides>);
    definitions = applyRecordOverrides<Definitions, Overrides>(options.records, overrides);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown override structure";
    throw new SqlDefinitionError(
      [
        issue(
          "invalid-override",
          ["overrides"],
          `PostgreSQL Record override is invalid: ${message}`,
        ),
      ],
      { cause },
    );
  }
  // SAFETY: applyRecordOverrides and the resolver preserve all generic Record and Field keys.
  return resolveRuntime(definitions) as PostgresRecordResolution<
    ApplyOverrides<Definitions, Overrides>
  >;
}

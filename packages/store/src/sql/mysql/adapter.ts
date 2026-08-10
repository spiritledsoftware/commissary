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
import {
  isValidMysqlName,
  readMysqlMetadataKind,
  type MysqlDecimalOptions,
  type MysqlDoubleOptions,
  type MysqlFloatOptions,
  type MysqlIntegerOptions,
  type MysqlOptionalLengthOptions,
  type MysqlRealOptions,
  type MysqlTemporalOptions,
} from "./record.js";

const sqlOpaqueFormatSymbol = Symbol.for("@commissary/store/sql-opaque-format");
const mysqlTableMetadataKeys: ReadonlySet<PropertyKey> = new Set([
  "database",
  "name",
  sqlOpaqueFormatSymbol,
]);
const mysqlColumnMetadataKeys: ReadonlySet<PropertyKey> = new Set([
  "name",
  "type",
  "default",
  "notNull",
  "autoIncrement",
  "generated",
  "onUpdate",
  sqlOpaqueFormatSymbol,
]);
const sqlColumnTypeFormatKeys: ReadonlySet<PropertyKey> = new Set([
  "format",
  "kind",
  "dialect",
  "type",
  "identity",
  "options",
]);

// Unicode 17.0.0 full, default (non-Turkic) CaseFolding.txt entries that differ from
// JavaScript lowercase. MySQL names exclude non-BMP code points, so this table does too.
// This table deliberately applies no Unicode normalization.
const unicodeCaseFoldExceptions = new Map<number, string>(
  "b5:3bc,df:73.73,149:2bc.6e,17f:73,1f0:6a.30c,345:3b9,390:3b9.308.301,3b0:3c5.308.301,3c2:3c3,3d0:3b2,3d1:3b8,3d5:3c6,3d6:3c0,3f0:3ba,3f1:3c1,3f5:3b5,587:565.582,13f8:13f0,13f9:13f1,13fa:13f2,13fb:13f3,13fc:13f4,13fd:13f5,1c80:432,1c81:434,1c82:43e,1c83:441,1c84:442,1c85:442,1c86:44a,1c87:463,1c88:a64b,1c89:1c8a,1e96:68.331,1e97:74.308,1e98:77.30a,1e99:79.30a,1e9a:61.2be,1e9b:1e61,1e9e:73.73,1f50:3c5.313,1f52:3c5.313.300,1f54:3c5.313.301,1f56:3c5.313.342,1f80:1f00.3b9,1f81:1f01.3b9,1f82:1f02.3b9,1f83:1f03.3b9,1f84:1f04.3b9,1f85:1f05.3b9,1f86:1f06.3b9,1f87:1f07.3b9,1f88:1f00.3b9,1f89:1f01.3b9,1f8a:1f02.3b9,1f8b:1f03.3b9,1f8c:1f04.3b9,1f8d:1f05.3b9,1f8e:1f06.3b9,1f8f:1f07.3b9,1f90:1f20.3b9,1f91:1f21.3b9,1f92:1f22.3b9,1f93:1f23.3b9,1f94:1f24.3b9,1f95:1f25.3b9,1f96:1f26.3b9,1f97:1f27.3b9,1f98:1f20.3b9,1f99:1f21.3b9,1f9a:1f22.3b9,1f9b:1f23.3b9,1f9c:1f24.3b9,1f9d:1f25.3b9,1f9e:1f26.3b9,1f9f:1f27.3b9,1fa0:1f60.3b9,1fa1:1f61.3b9,1fa2:1f62.3b9,1fa3:1f63.3b9,1fa4:1f64.3b9,1fa5:1f65.3b9,1fa6:1f66.3b9,1fa7:1f67.3b9,1fa8:1f60.3b9,1fa9:1f61.3b9,1faa:1f62.3b9,1fab:1f63.3b9,1fac:1f64.3b9,1fad:1f65.3b9,1fae:1f66.3b9,1faf:1f67.3b9,1fb2:1f70.3b9,1fb3:3b1.3b9,1fb4:3ac.3b9,1fb6:3b1.342,1fb7:3b1.342.3b9,1fbc:3b1.3b9,1fbe:3b9,1fc2:1f74.3b9,1fc3:3b7.3b9,1fc4:3ae.3b9,1fc6:3b7.342,1fc7:3b7.342.3b9,1fcc:3b7.3b9,1fd2:3b9.308.300,1fd3:3b9.308.301,1fd6:3b9.342,1fd7:3b9.308.342,1fe2:3c5.308.300,1fe3:3c5.308.301,1fe4:3c1.313,1fe6:3c5.342,1fe7:3c5.308.342,1ff2:1f7c.3b9,1ff3:3c9.3b9,1ff4:3ce.3b9,1ff6:3c9.342,1ff7:3c9.342.3b9,1ffc:3c9.3b9,a7cb:264,a7cc:a7cd,a7ce:a7cf,a7d2:a7d3,a7d4:a7d5,a7da:a7db,a7dc:19b,ab70:13a0,ab71:13a1,ab72:13a2,ab73:13a3,ab74:13a4,ab75:13a5,ab76:13a6,ab77:13a7,ab78:13a8,ab79:13a9,ab7a:13aa,ab7b:13ab,ab7c:13ac,ab7d:13ad,ab7e:13ae,ab7f:13af,ab80:13b0,ab81:13b1,ab82:13b2,ab83:13b3,ab84:13b4,ab85:13b5,ab86:13b6,ab87:13b7,ab88:13b8,ab89:13b9,ab8a:13ba,ab8b:13bb,ab8c:13bc,ab8d:13bd,ab8e:13be,ab8f:13bf,ab90:13c0,ab91:13c1,ab92:13c2,ab93:13c3,ab94:13c4,ab95:13c5,ab96:13c6,ab97:13c7,ab98:13c8,ab99:13c9,ab9a:13ca,ab9b:13cb,ab9c:13cc,ab9d:13cd,ab9e:13ce,ab9f:13cf,aba0:13d0,aba1:13d1,aba2:13d2,aba3:13d3,aba4:13d4,aba5:13d5,aba6:13d6,aba7:13d7,aba8:13d8,aba9:13d9,abaa:13da,abab:13db,abac:13dc,abad:13dd,abae:13de,abaf:13df,abb0:13e0,abb1:13e1,abb2:13e2,abb3:13e3,abb4:13e4,abb5:13e5,abb6:13e6,abb7:13e7,abb8:13e8,abb9:13e9,abba:13ea,abbb:13eb,abbc:13ec,abbd:13ed,abbe:13ee,abbf:13ef,fb00:66.66,fb01:66.69,fb02:66.6c,fb03:66.66.69,fb04:66.66.6c,fb05:73.74,fb06:73.74,fb13:574.576,fb14:574.565,fb15:574.56b,fb16:57e.576,fb17:574.56d"
    .split(",")
    .map((entry) => {
      const separator = entry.indexOf(":");
      return [
        Number.parseInt(entry.slice(0, separator), 16),
        entry
          .slice(separator + 1)
          .split(".")
          .map((codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
          .join(""),
      ] as const;
    }),
);

function foldMysqlDatabaseName(value: string): string {
  let folded = "";
  for (const character of value) {
    folded +=
      unicodeCaseFoldExceptions.get(character.codePointAt(0) ?? 0) ?? character.toLowerCase();
  }
  return folded;
}

/** One driver-independent value produced by a resolved MySQL column encoder. */
export type MysqlEncodedValue = JsonValue | Uint8Array;

/** Every supported direct MySQL column type name. */
export type MysqlDirectTypeName =
  | "tinyint"
  | "smallint"
  | "mediumint"
  | "int"
  | "bigint"
  | "decimal"
  | "float"
  | "double"
  | "real"
  | "boolean"
  | "char"
  | "varchar"
  | "binary"
  | "varbinary"
  | "text"
  | "tinytext"
  | "mediumtext"
  | "longtext"
  | "json"
  | "date"
  | "datetime"
  | "time"
  | "timestamp"
  | "year"
  | "serial";

/** Final supported options for one direct MySQL column type. */
export type MysqlResolvedDirectTypeOptions =
  | MysqlIntegerOptions
  | MysqlDecimalOptions
  | MysqlFloatOptions
  | MysqlDoubleOptions
  | MysqlRealOptions
  | MysqlOptionalLengthOptions
  | MysqlTemporalOptions
  | Readonly<{ readonly length: number }>;

/** Final physical facts for one direct MySQL type. */
export interface MysqlResolvedDirectType {
  readonly kind: "direct";
  readonly type: MysqlDirectTypeName;
  readonly options?: Readonly<MysqlResolvedDirectTypeOptions>;
}

/** Final physical facts for one inline MySQL enum. */
export interface MysqlResolvedEnumType {
  readonly kind: "enum";
  readonly values: readonly [string, ...string[]];
}

/** Final physical facts for one external MySQL type. */
export interface MysqlResolvedCustomType {
  readonly kind: "custom";
  readonly type: SqlStatement<never>;
}

/** Final MySQL column type selected by resolution. */
export type MysqlResolvedColumnType =
  | MysqlResolvedDirectType
  | MysqlResolvedEnumType
  | MysqlResolvedCustomType;

/** How a MySQL automatic-increment column proves its required key. */
export interface MysqlResolvedAutoIncrement {
  readonly key: "host-required" | "serial-unique";
}

/** Final physical facts for one resolved MySQL column. */
export interface MysqlResolvedColumn<Field extends FieldDefinition> {
  readonly name: string;
  readonly reference: SqlStatement<never>;
  readonly schema: SelectFieldSchema<Field>;
  readonly type: MysqlResolvedColumnType;
  readonly notNull: boolean;
  readonly default?: SqlLiteralValue | SqlStatement<never>;
  readonly autoIncrement?: MysqlResolvedAutoIncrement;
  readonly generated?: SqlResolvedGeneratedColumn;
  readonly onUpdate?: "current-timestamp";
  readonly encode: (
    value: Exclude<FieldOutput<SelectFieldSchema<Field>>, null | undefined>,
  ) => MysqlEncodedValue;
  readonly decode: (
    value: unknown,
  ) => Exclude<FieldOutput<SelectFieldSchema<Field>>, null | undefined>;
}

/** Resolved MySQL columns keyed by local SQL Record Field name. */
export type MysqlResolvedColumns<Definition extends RecordDefinition> = Readonly<{
  [Name in keyof Definition["fields"] & string]: MysqlResolvedColumn<Definition["fields"][Name]>;
}>;

/** Final physical facts for one resolved MySQL table. */
export interface MysqlResolvedTable<Definition extends RecordDefinition> {
  readonly database?: string;
  readonly name: string;
  readonly reference: SqlRecordReference<Definition>;
  readonly definition: Definition;
  readonly columns: MysqlResolvedColumns<Definition>;
  readonly primaryKey: readonly MysqlResolvedColumn<
    Definition["fields"][keyof Definition["fields"]]
  >[];
}

/** Resolved MySQL tables keyed by local SQL Record name. */
export type MysqlResolvedTables<Definitions extends RecordDefinitions> = Readonly<{
  [Name in keyof Definitions & string]: MysqlResolvedTable<Definitions[Name]>;
}>;

/** Immutable SQL Record references and MySQL adapter assets. */
export interface MysqlRecordResolution<Definitions extends RecordDefinitions> {
  readonly records: SqlRecordReferences<Definitions>;
  readonly tables: MysqlResolvedTables<Definitions>;
}

interface RuntimePhysicalType {
  readonly resolved: MysqlResolvedColumnType;
  readonly application: "string" | "number" | "integer" | "boolean" | "json" | "custom";
  readonly encode: (value: unknown) => MysqlEncodedValue;
  readonly decode: (value: unknown) => JsonValue;
  readonly intrinsicAutoIncrement?: boolean;
}

type RuntimeColumn = MysqlResolvedColumn<FieldDefinition>;

interface RuntimeTable extends MysqlResolvedTable<RecordDefinition> {
  readonly columns: Readonly<Record<string, RuntimeColumn>>;
  readonly primaryKey: readonly RuntimeColumn[];
}

interface ResolutionState {
  readonly issues: SqlDefinitionIssue[];
}

const directTypes = new Set<MysqlDirectTypeName>([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "bigint",
  "decimal",
  "float",
  "double",
  "real",
  "boolean",
  "char",
  "varchar",
  "binary",
  "varbinary",
  "text",
  "tinytext",
  "mediumtext",
  "longtext",
  "json",
  "date",
  "datetime",
  "time",
  "timestamp",
  "year",
  "serial",
]);

function isRecordContainer(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldSchema(value: unknown): value is FieldSchema {
  if (!isRecordContainer(value) || !Object.hasOwn(value, "~standard")) return false;
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

function qualifiedReference(database: string | undefined, name: string): SqlStatement<never> {
  return database === undefined
    ? sql.identifier(name)
    : sql`${sql.identifier(database)}.${sql.identifier(name)}`;
}

function fieldReference(name: string): SqlStatement<never> {
  return sql.identifier(name);
}

function recordReference<Definition extends RecordDefinition>(
  database: string | undefined,
  name: string,
  fields: Readonly<Record<string, SqlStatement<never>>>,
): SqlRecordReference<Definition> {
  const statement = qualifiedReference(database, name);
  // SAFETY: The composed Statement and frozen field map provide the full opaque reference contract.
  return Object.freeze({ ...statement, fields }) as SqlRecordReference<Definition>;
}

function readMysqlMetadata(
  owner: "table" | "column",
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): Readonly<Record<PropertyKey, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecordContainer(value)) {
    issues.push(
      issue("invalid-database-options", path, `MySQL ${owner} refinement must be an object`),
    );
    return undefined;
  }
  const expected = owner === "table" ? "mysql-table" : "mysql-column";
  const allowedKeys = owner === "table" ? mysqlTableMetadataKeys : mysqlColumnMetadataKeys;
  if (
    readMysqlMetadataKind(value) !== expected ||
    Reflect.ownKeys(value).some((key) => !allowedKeys.has(key))
  ) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        `MySQL ${owner} refinement has an incompatible opaque format`,
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

function hasStatementStructure(fragments: readonly SqlStatementFragment[]): boolean {
  return fragments.some(
    (fragment) =>
      fragment.kind === "identifier" || (fragment.kind === "raw" && fragment.text.length > 0),
  );
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
  // SAFETY: Compatible opaque structure was checked and contains no parameter fragment.
  return value as SqlStatement<never>;
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
      return "json";
    case "custom":
      return undefined;
  }
}

function evidenceCompatible(
  evidence: ReturnType<typeof reflectSqlSelectStorage>,
  application: RuntimePhysicalType["application"],
): boolean {
  if (evidence === undefined) return true;
  const required = requiredEvidenceCategory(application);
  if (required === undefined) return true;
  if (required === "number") return evidence.type === "number" || evidence.type === "integer";
  return evidence.type === required;
}

function directResolved(
  type: MysqlDirectTypeName,
  options?: Readonly<MysqlResolvedDirectTypeOptions>,
): MysqlResolvedDirectType {
  return Object.freeze({
    kind: "direct",
    type,
    ...(options === undefined ? {} : { options: Object.freeze({ ...options }) }),
  });
}

function invalidValue(type: string): never {
  throw new TypeError(`MySQL ${type} codec received an invalid value`);
}

function boundedInteger(value: unknown, type: string, minimum: number, maximum: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : invalidValue(type);
}

function finiteNumber(value: unknown, type: string, unsigned = false): number {
  return typeof value === "number" && Number.isFinite(value) && (!unsigned || value >= 0)
    ? value
    : invalidValue(type);
}

function isCanonicalIntegerText(value: unknown, minimum: bigint, maximum: bigint): value is string {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(value) || value === "-0") {
    return false;
  }
  try {
    const integer = BigInt(value);
    return integer >= minimum && integer <= maximum;
  } catch {
    return false;
  }
}

function stringCodec(
  type: string,
  validate: (value: string) => boolean = () => true,
  normalize: (value: string) => string | undefined = (value) => value,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "string",
    encode: (value) => (typeof value === "string" && validate(value) ? value : invalidValue(type)),
    decode: (value) => {
      if (typeof value !== "string") return invalidValue(type);
      const normalized = normalize(value);
      return normalized !== undefined && validate(normalized) ? normalized : invalidValue(type);
    },
  };
}

function jsonCodec(type: string): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "json",
    encode: (value) => (isJsonValue(value) ? value : invalidValue(type)),
    decode: (value) => (isJsonValue(value) ? value : invalidValue(type)),
  };
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalidValue("binary");
  }
  const output = new Uint8Array(
    (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0),
  );
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = base64Alphabet.indexOf(value[index] ?? "");
    const b = base64Alphabet.indexOf(value[index + 1] ?? "");
    const c = value[index + 2] === "=" ? 0 : base64Alphabet.indexOf(value[index + 2] ?? "");
    const d = value[index + 3] === "=" ? 0 : base64Alphabet.indexOf(value[index + 3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) return invalidValue("binary");
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 16) & 255;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 8) & 255;
    if (outputIndex < output.length) output[outputIndex++] = bits & 255;
  }
  if (encodeBase64(output) !== value) return invalidValue("binary");
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

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

interface MysqlDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
}

function parseDate(value: string): readonly [number, number, number] | undefined {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1000 && year <= 9999 && validCalendarDate(year, month, day)
    ? [year, month, day]
    : undefined;
}

function parseDateTime(value: string, withUtc: boolean): MysqlDateTimeParts | undefined {
  const suffix = withUtc ? "Z" : "";
  const pattern = withUtc
    ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?Z$/
    : /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?$/;
  const match = pattern.exec(value);
  if (match === null || (withUtc && !value.endsWith(suffix))) return undefined;
  const parts: MysqlDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    fraction: match[7] ?? "",
  };
  return parts.year >= 1000 &&
    parts.year <= 9999 &&
    validCalendarDate(parts.year, parts.month, parts.day) &&
    parts.hour <= 23 &&
    parts.minute <= 59 &&
    parts.second <= 59
    ? parts
    : undefined;
}

function timestampInRange(parts: MysqlDateTimeParts): boolean {
  const second =
    `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}` +
    `T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
  return second >= "1970-01-01T00:00:01" && second <= "2038-01-19T03:14:07";
}

function normalizeFraction(fraction: string, fsp: number): string | undefined {
  if (fraction.length > fsp && /[1-9]/.test(fraction.slice(fsp))) return undefined;
  return fsp === 0 ? "" : `.${fraction.slice(0, fsp).padEnd(fsp, "0")}`;
}

function normalizeDateTime(value: string, withUtc: boolean, fsp: number): string | undefined {
  const parts = parseDateTime(value, withUtc);
  if (parts === undefined || (withUtc && !timestampInRange(parts))) return undefined;
  const fraction = normalizeFraction(parts.fraction, fsp);
  if (fraction === undefined) return undefined;
  const base = value.slice(0, 19);
  return `${base}${fraction}${withUtc ? "Z" : ""}`;
}

interface MysqlTimeParts {
  readonly negative: boolean;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
}

function parseTime(value: string): MysqlTimeParts | undefined {
  const match = /^(-)?([0-9]{3}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?$/.exec(value);
  if (match === null) return undefined;
  const parts: MysqlTimeParts = {
    negative: match[1] === "-",
    hour: Number(match[2]),
    minute: Number(match[3]),
    second: Number(match[4]),
    fraction: match[5] ?? "",
  };
  if (
    parts.hour > 838 ||
    parts.minute > 59 ||
    parts.second > 59 ||
    (parts.hour === 838 && (parts.minute > 59 || parts.second > 59)) ||
    (parts.negative &&
      parts.hour === 0 &&
      parts.minute === 0 &&
      parts.second === 0 &&
      !/[1-9]/.test(parts.fraction))
  ) {
    return undefined;
  }
  return parts;
}

function normalizeTime(value: string, fsp: number): string | undefined {
  const parts = parseTime(value);
  if (parts === undefined) return undefined;
  const fraction = normalizeFraction(parts.fraction, fsp);
  if (fraction === undefined) return undefined;
  return `${parts.negative ? "-" : ""}${String(parts.hour).padStart(3, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}${fraction}`;
}

function optionNumber(
  options: Readonly<MysqlResolvedDirectTypeOptions> | undefined,
  key: string,
): number | undefined {
  const value = isRecordContainer(options) ? Reflect.get(options, key) : undefined;
  return typeof value === "number" ? value : undefined;
}

function temporalCodec(
  type: "date" | "datetime" | "time" | "timestamp",
  options?: Readonly<MysqlResolvedDirectTypeOptions>,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  if (type === "date") {
    return stringCodec(type, (value) => parseDate(value) !== undefined);
  }
  const fsp = optionNumber(options, "fsp") ?? 0;
  const validate =
    type === "time"
      ? (value: string): boolean => parseTime(value) !== undefined
      : type === "timestamp"
        ? (value: string): boolean => {
            const parts = parseDateTime(value, true);
            return parts !== undefined && timestampInRange(parts);
          }
        : (value: string): boolean => parseDateTime(value, false) !== undefined;
  const normalize =
    type === "time"
      ? (value: string): string | undefined => normalizeTime(value, fsp)
      : type === "timestamp"
        ? (value: string): string | undefined => normalizeDateTime(value, true, fsp)
        : (value: string): string | undefined => normalizeDateTime(value, false, fsp);
  return stringCodec(type, validate, normalize);
}

function binaryCodec(
  type: "binary" | "varbinary",
  length: number,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "string",
    encode: (value) => {
      if (typeof value !== "string") return invalidValue(type);
      const decoded = decodeBase64(value);
      return decoded.length <= length ? decoded : invalidValue(type);
    },
    decode: (value) => {
      if (!(value instanceof Uint8Array) || value.length > length) return invalidValue(type);
      return encodeBase64(value);
    },
  };
}

interface ParsedDecimal {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
}

function parseDecimal(value: unknown): ParsedDecimal | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(-)?([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) return undefined;
  return {
    negative: match[1] === "-",
    integer: match[2] ?? "",
    fraction: match[3] ?? "",
  };
}

function decimalFits(
  value: unknown,
  precision: number,
  scale: number,
  unsigned: boolean,
): value is string {
  const parts = parseDecimal(value);
  if (parts === undefined || (unsigned && parts.negative)) return false;
  const significantInteger = parts.integer.replace(/^0+/, "");
  return significantInteger.length <= precision - scale;
}

function normalizeDecimal(
  value: unknown,
  precision: number,
  scale: number,
  unsigned: boolean,
): string {
  if (!decimalFits(value, precision, scale, unsigned)) return invalidValue("decimal");
  const parts = parseDecimal(value);
  if (parts === undefined || parts.fraction.length !== scale) return invalidValue("decimal");
  const integer = parts.integer.replace(/^0+(?=[0-9])/, "");
  const isZero = /^0+$/.test(integer) && (scale === 0 || /^0+$/.test(parts.fraction));
  return `${parts.negative && !isZero ? "-" : ""}${integer}${scale === 0 ? "" : `.${parts.fraction}`}`;
}

function decimalCodec(
  options?: Readonly<MysqlResolvedDirectTypeOptions>,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const precision = optionNumber(options, "precision") ?? 10;
  const scale = optionNumber(options, "scale") ?? 0;
  const unsigned = isRecordContainer(options) && Reflect.get(options, "unsigned") === true;
  return {
    application: "string",
    encode: (value) =>
      decimalFits(value, precision, scale, unsigned) ? value : invalidValue("decimal"),
    decode: (value) => normalizeDecimal(value, precision, scale, unsigned),
  };
}

function booleanCodec(): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "boolean",
    encode: (value) => (typeof value === "boolean" ? Number(value) : invalidValue("boolean")),
    decode: (value) =>
      typeof value === "boolean"
        ? value
        : value === 0
          ? false
          : value === 1
            ? true
            : invalidValue("boolean"),
  };
}

function integerCodec(
  type: "tinyint" | "smallint" | "mediumint" | "int",
  unsigned: boolean,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const ranges = {
    tinyint: [-128, 127, 255],
    smallint: [-32_768, 32_767, 65_535],
    mediumint: [-8_388_608, 8_388_607, 16_777_215],
    int: [-2_147_483_648, 2_147_483_647, 4_294_967_295],
  } as const;
  const [signedMinimum, signedMaximum, unsignedMaximum] = ranges[type];
  const minimum = unsigned ? 0 : signedMinimum;
  const maximum = unsigned ? unsignedMaximum : signedMaximum;
  return {
    application: "integer",
    encode: (value) => boundedInteger(value, type, minimum, maximum),
    decode: (value) => boundedInteger(value, type, minimum, maximum),
  };
}

function bigintCodec(
  type: "bigint" | "serial",
  unsigned: boolean,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const minimum = unsigned ? 0n : -9_223_372_036_854_775_808n;
  const maximum = unsigned ? 18_446_744_073_709_551_615n : 9_223_372_036_854_775_807n;
  return stringCodec(
    type,
    (value) =>
      isCanonicalIntegerText(value, minimum, maximum) && (type !== "serial" || value !== "0"),
  );
}

function directCodec(
  type: MysqlDirectTypeName,
  options?: Readonly<MysqlResolvedDirectTypeOptions>,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const unsigned = isRecordContainer(options) && Reflect.get(options, "unsigned") === true;
  switch (type) {
    case "tinyint":
    case "smallint":
    case "mediumint":
    case "int":
      return integerCodec(type, unsigned);
    case "bigint":
      return bigintCodec(type, unsigned);
    case "serial":
      return bigintCodec(type, true);
    case "decimal":
      return decimalCodec(options);
    case "float":
    case "double":
    case "real":
      return {
        application: "number",
        encode: (value) => finiteNumber(value, type, unsigned),
        decode: (value) => {
          const number = finiteNumber(value, type, unsigned);
          return Object.is(number, -0) ? 0 : number;
        },
      };
    case "boolean":
      return booleanCodec();
    case "char": {
      const length = optionNumber(options, "length") ?? 1;
      const validLength = (value: string): boolean => Array.from(value).length <= length;
      return {
        application: "string",
        encode: (value) =>
          typeof value === "string" && !value.endsWith(" ") && validLength(value)
            ? value
            : invalidValue(type),
        decode: (value) =>
          typeof value === "string" && validLength(value)
            ? value.replace(/ +$/, "")
            : invalidValue(type),
      };
    }
    case "varchar": {
      const length = optionNumber(options, "length") ?? 0;
      return stringCodec(type, (value) => Array.from(value).length <= length);
    }
    case "binary": {
      const length = optionNumber(options, "length") ?? 1;
      return binaryCodec(type, length);
    }
    case "varbinary": {
      const length = optionNumber(options, "length") ?? 0;
      return binaryCodec(type, length);
    }
    case "text":
    case "tinytext":
    case "mediumtext":
    case "longtext":
      return stringCodec(type);
    case "json":
      return jsonCodec(type);
    case "date":
    case "datetime":
    case "time":
    case "timestamp":
      return temporalCodec(type, options);
    case "year":
      return {
        application: "integer",
        encode: (value) => boundedInteger(value, type, 1901, 2155),
        decode: (value) => boundedInteger(value, type, 1901, 2155),
      };
  }
}

function hasOnlyOwnStringKeys(
  value: Readonly<Record<PropertyKey, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function validUnsignedOptions(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
): options is Readonly<MysqlIntegerOptions> {
  return (
    options === undefined ||
    (hasOnlyOwnStringKeys(options, new Set(["unsigned"])) &&
      isMysqlUnsignedOption(Reflect.get(options, "unsigned")))
  );
}

function validDecimalOptions(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
): options is Readonly<MysqlDecimalOptions> {
  if (options === undefined) return true;
  if (!hasOnlyOwnStringKeys(options, new Set(["precision", "scale", "unsigned"]))) return false;
  const precision = Reflect.get(options, "precision");
  const scale = Reflect.get(options, "scale");
  return (
    isMysqlDecimalPrecisionOption(precision) &&
    isMysqlDecimalScaleOption(scale) &&
    isMysqlDecimalScaleCompatible(precision, scale) &&
    isMysqlUnsignedOption(Reflect.get(options, "unsigned"))
  );
}

function validFloatingOptions(
  type: "float" | "double" | "real",
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
): boolean {
  if (options === undefined) return true;
  const allowed =
    type === "real" ? new Set(["precision", "scale"]) : new Set(["precision", "scale", "unsigned"]);
  if (!hasOnlyOwnStringKeys(options, allowed)) return false;
  const precision = Reflect.get(options, "precision");
  const scale = Reflect.get(options, "scale");
  return (
    isMysqlFloatPrecisionOption(type, precision, scale) &&
    isMysqlFloatScaleOption(scale) &&
    isMysqlFloatScaleCompatible(precision, scale) &&
    (type === "real" || isMysqlUnsignedOption(Reflect.get(options, "unsigned")))
  );
}

function validLengthOptions(
  type: "char" | "binary" | "varchar" | "varbinary",
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
): boolean {
  if (options === undefined) return type === "char" || type === "binary";
  return (
    hasOnlyOwnStringKeys(options, new Set(["length"])) &&
    (type === "char" || type === "binary"
      ? isMysqlOptionalLengthOption(Reflect.get(options, "length"))
      : Object.hasOwn(options, "length") &&
        isMysqlRequiredLengthOption(Reflect.get(options, "length")))
  );
}

function validTemporalOptions(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
): options is Readonly<MysqlTemporalOptions> {
  return (
    options === undefined ||
    (hasOnlyOwnStringKeys(options, new Set(["fsp"])) &&
      isMysqlFractionalSecondsOption(Reflect.get(options, "fsp")))
  );
}

function noOptions(options: Readonly<Record<PropertyKey, unknown>> | undefined): boolean {
  return options === undefined;
}

function resolveDirectOptions(
  type: MysqlDirectTypeName,
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
): Readonly<MysqlResolvedDirectTypeOptions> | undefined | false {
  const valid = (() => {
    switch (type) {
      case "tinyint":
      case "smallint":
      case "mediumint":
      case "int":
      case "bigint":
        return validUnsignedOptions(options);
      case "decimal":
        return validDecimalOptions(options);
      case "float":
      case "double":
      case "real":
        return validFloatingOptions(type, options);
      case "char":
      case "binary":
      case "varchar":
      case "varbinary":
        return validLengthOptions(type, options);
      case "datetime":
      case "time":
      case "timestamp":
        return validTemporalOptions(options);
      case "boolean":
      case "text":
      case "tinytext":
      case "mediumtext":
      case "longtext":
      case "json":
      case "date":
      case "year":
      case "serial":
        return noOptions(options);
    }
  })();
  if (!valid) return false;
  // SAFETY: Each type-specific branch accepted only the public option fields and values.
  return options as Readonly<MysqlResolvedDirectTypeOptions> | undefined;
}

function isDirectTypeName(value: string): value is MysqlDirectTypeName {
  return directTypes.has(value as MysqlDirectTypeName);
}

function resolvePortableType(type: SqlPortableTypeName): RuntimePhysicalType {
  switch (type) {
    case "text": {
      const codec = stringCodec("text");
      return Object.freeze({ resolved: directResolved("text"), ...codec });
    }
    case "number": {
      const codec = directCodec("double");
      return Object.freeze({ resolved: directResolved("double"), ...codec });
    }
    case "integer": {
      const codec = {
        application: "integer" as const,
        encode: (value: unknown): number =>
          boundedInteger(value, "bigint", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        decode: (value: unknown): number =>
          boundedInteger(value, "bigint", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      };
      return Object.freeze({ resolved: directResolved("bigint"), ...codec });
    }
    case "boolean": {
      const codec = booleanCodec();
      return Object.freeze({ resolved: directResolved("boolean"), ...codec });
    }
    case "json": {
      const codec = jsonCodec("json");
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

function isValidEnumValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.endsWith(" ") &&
    Array.from(value).length <= 255
  );
}

function resolveEnum(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
  path: readonly (string | number)[],
  state: ResolutionState,
): RuntimePhysicalType | undefined {
  const values = options === undefined ? undefined : Reflect.get(options, "values");
  if (
    options === undefined ||
    !hasOnlyOwnStringKeys(options, new Set(["values"])) ||
    !Array.isArray(values) ||
    !Object.isFrozen(values) ||
    values.length === 0 ||
    values.length > 65_535 ||
    !values.every(isValidEnumValue) ||
    new Set(values).size !== values.length
  ) {
    state.issues.push(issue("invalid-column-type", path, "MySQL enum type contract is invalid"));
    return undefined;
  }
  // SAFETY: The nonempty frozen list was checked as unique MySQL enum strings.
  const frozenValues = Object.freeze([...values]) as unknown as readonly [string, ...string[]];
  const accepted = new Set(frozenValues);
  const codec = stringCodec("enum", (value) => accepted.has(value));
  return Object.freeze({
    resolved: Object.freeze({ kind: "enum", values: frozenValues }),
    ...codec,
  });
}

function isCustomEncodedValue(value: unknown): value is SqlCustomEncodedValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    value instanceof Uint8Array
  );
}

function resolveCustom(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
  path: readonly (string | number)[],
  state: ResolutionState,
): RuntimePhysicalType | undefined {
  if (
    options === undefined ||
    !hasOnlyOwnStringKeys(options, new Set(["type", "encode", "decode"])) ||
    typeof Reflect.get(options, "encode") !== "function" ||
    typeof Reflect.get(options, "decode") !== "function"
  ) {
    state.issues.push(issue("invalid-column-type", path, "MySQL custom type contract is invalid"));
    return undefined;
  }
  const type = validStatement(
    Reflect.get(options, "type"),
    [...path, "type"],
    state.issues,
    "MySQL custom type",
    "invalid-column-type",
  );
  if (type === undefined) return undefined;
  const encode = Reflect.get(options, "encode");
  const decode = Reflect.get(options, "decode");
  const encodeValue = (value: unknown): MysqlEncodedValue => {
    // SAFETY: The contract check above proved this captured reference is callable.
    const converted = (encode as (input: unknown) => unknown)(value);
    return isCustomEncodedValue(converted) ? converted : invalidValue("custom encoder output");
  };
  const decodeValue = (value: unknown): JsonValue => {
    // SAFETY: The contract check above proved this captured reference is callable.
    const converted = (decode as (input: unknown) => unknown)(value);
    return isJsonValue(converted) ? converted : invalidValue("custom decoder output");
  };
  return Object.freeze({
    resolved: Object.freeze({ kind: "custom", type }),
    application: "custom",
    encode: encodeValue,
    decode: decodeValue,
  });
}

function resolveMysqlType(
  format: SqlColumnTypeFormat,
  path: readonly (string | number)[],
  state: ResolutionState,
): RuntimePhysicalType | undefined {
  if (format.dialect !== "mysql") {
    state.issues.push(issue("invalid-column-type", path, "MySQL column requires a MySQL type"));
    return undefined;
  }
  const options = format.options;
  if (format.type === "enum") return resolveEnum(options, path, state);
  if (format.type === "custom") return resolveCustom(options, path, state);
  if (!isDirectTypeName(format.type)) {
    state.issues.push(issue("invalid-column-type", path, `Unknown MySQL type '${format.type}'`));
    return undefined;
  }
  const resolvedOptions = resolveDirectOptions(format.type, options);
  if (resolvedOptions === false) {
    state.issues.push(
      issue("invalid-column-type", path, `MySQL ${format.type} type options are invalid`),
    );
    return undefined;
  }
  const codec = directCodec(format.type, resolvedOptions);
  return Object.freeze({
    resolved: directResolved(format.type, resolvedOptions),
    ...codec,
    ...(format.type === "serial" ? { intrinsicAutoIncrement: true } : {}),
  });
}

function applicationForFormat(
  format: SqlColumnTypeFormat,
): RuntimePhysicalType["application"] | undefined {
  const portable = portableType(format);
  if (portable !== undefined) return resolvePortableType(portable).application;
  if (format.dialect !== "mysql") return undefined;
  switch (format.type) {
    case "tinyint":
    case "smallint":
    case "mediumint":
    case "int":
    case "year":
      return "integer";
    case "float":
    case "double":
    case "real":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
      return "json";
    case "custom":
      return "custom";
    case "bigint":
    case "decimal":
    case "char":
    case "varchar":
    case "binary":
    case "varbinary":
    case "text":
    case "tinytext":
    case "mediumtext":
    case "longtext":
    case "date":
    case "datetime":
    case "time":
    case "timestamp":
    case "serial":
    case "enum":
      return "string";
    default:
      return undefined;
  }
}

function isCompatibleMysqlColumnTypeFormat(format: SqlColumnTypeFormat): boolean {
  if (Reflect.ownKeys(format).some((key) => !sqlColumnTypeFormatKeys.has(key))) return false;
  if (format.dialect === "portable") {
    return !Object.hasOwn(format, "identity") && !Object.hasOwn(format, "options");
  }
  return format.dialect !== "mysql" || !Object.hasOwn(format, "identity");
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
        issue("column-type-required", path, "MySQL column requires explicit storage type evidence"),
      );
      return undefined;
    }
    return resolvePortableType(evidence.type);
  }
  const format = readSqlColumnTypeFormat(value);
  if (format === undefined || !isCompatibleMysqlColumnTypeFormat(format)) {
    state.issues.push(
      issue("invalid-column-type", path, "MySQL column type has an incompatible opaque format"),
    );
    return undefined;
  }
  const application = applicationForFormat(format);
  if (application !== undefined && !evidenceCompatible(evidence, application)) {
    state.issues.push(
      issue("invalid-column-type", path, "MySQL column type conflicts with Select Schema output"),
    );
  }
  const portable = portableType(format);
  return portable === undefined
    ? resolveMysqlType(format, path, state)
    : resolvePortableType(portable);
}

function nestedOwnValue(value: unknown, path: readonly string[]): boolean {
  let current = value;
  for (const key of path) {
    if (!isRecordContainer(current) || !Object.hasOwn(current, key)) return false;
    current = Reflect.get(current, key);
  }
  return true;
}

function sourcePath(
  overrides: unknown,
  recordName: string,
  fieldName: string | undefined,
  tail: readonly string[],
): readonly (string | number)[] {
  const recordOverride =
    isRecordContainer(overrides) && Object.hasOwn(overrides, recordName)
      ? Reflect.get(overrides, recordName)
      : undefined;
  const fieldOverrides =
    isRecordContainer(recordOverride) && isRecordContainer(Reflect.get(recordOverride, "fields"))
      ? Reflect.get(recordOverride, "fields")
      : undefined;
  const candidate =
    fieldName === undefined
      ? recordOverride
      : isRecordContainer(fieldOverrides) && Object.hasOwn(fieldOverrides, fieldName)
        ? Reflect.get(fieldOverrides, fieldName)
        : undefined;
  if (nestedOwnValue(candidate, tail)) {
    return fieldName === undefined
      ? ["overrides", recordName, ...tail]
      : ["overrides", recordName, "fields", fieldName, ...tail];
  }
  return fieldName === undefined
    ? ["records", recordName, ...tail]
    : ["records", recordName, "fields", fieldName, ...tail];
}

function winningColumnTail(
  refinement: Readonly<Record<PropertyKey, unknown>> | undefined,
  key: string,
): readonly string[] {
  return refinement !== undefined && Object.hasOwn(refinement, key)
    ? ["column", "mysql", key]
    : ["column", key];
}

function winningTableTail(
  refinement: Readonly<Record<PropertyKey, unknown>> | undefined,
  key: string,
): readonly string[] {
  return refinement !== undefined && Object.hasOwn(refinement, key)
    ? ["table", "mysql", key]
    : ["table", key];
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
    let valid = literalMatchesApplication(literal.value, physical.application);
    if (valid && physical.application !== "custom") {
      try {
        physical.encode(literal.value);
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      issues.push(
        issue("invalid-column-default", path, "MySQL column default does not match its final type"),
      );
      return undefined;
    }
    return literal.value;
  }
  return validStatement(value, path, issues, "MySQL column default");
}

function resolveGenerated(
  value: unknown,
  path: readonly (string | number)[],
  expressionPath: readonly (string | number)[],
  modePath: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): SqlResolvedGeneratedColumn | undefined {
  if (value === undefined) return undefined;
  if (!isRecordContainer(value)) {
    issues.push(
      issue("invalid-database-options", path, "MySQL generated metadata must be an object"),
    );
    return undefined;
  }
  let valid = true;
  const hasExpression = Object.hasOwn(value, "expression");
  const hasMode = Object.hasOwn(value, "mode");
  if (!hasOnlyOwnStringKeys(value, new Set(["expression", "mode"])) || !hasExpression || !hasMode) {
    issues.push(
      issue("invalid-database-options", path, "MySQL generated metadata has an invalid structure"),
    );
    valid = false;
  }
  const expression = hasExpression
    ? validStatement(
        Reflect.get(value, "expression"),
        expressionPath,
        issues,
        "MySQL generated expression",
        "invalid-database-options",
      )
    : undefined;
  const mode = Reflect.get(value, "mode");
  if (hasMode && mode !== "virtual" && mode !== "stored") {
    issues.push(
      issue("invalid-database-options", modePath, "MySQL generated column mode is invalid"),
    );
    valid = false;
  }
  if (!valid || expression === undefined || (mode !== "virtual" && mode !== "stored")) {
    return undefined;
  }
  return Object.freeze({ expression, mode });
}

function isAutomaticIncrementType(type: MysqlResolvedColumnType): boolean {
  return (
    type.kind === "direct" &&
    (type.type === "tinyint" ||
      type.type === "smallint" ||
      type.type === "mediumint" ||
      type.type === "int" ||
      type.type === "bigint" ||
      type.type === "serial")
  );
}

function resolveAutoIncrement(
  value: unknown,
  physical: RuntimePhysicalType,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): MysqlResolvedAutoIncrement | undefined {
  if (physical.intrinsicAutoIncrement === true) {
    if (value !== undefined && typeof value !== "boolean") {
      issues.push(issue("invalid-database-options", path, "MySQL autoIncrement option is invalid"));
    }
    return Object.freeze({ key: "serial-unique" });
  }
  if (value === undefined || value === false) return undefined;
  if (value !== true) {
    issues.push(issue("invalid-database-options", path, "MySQL autoIncrement option is invalid"));
    return undefined;
  }
  if (!isAutomaticIncrementType(physical.resolved)) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        "MySQL autoIncrement requires an integer physical type",
      ),
    );
    return undefined;
  }
  return Object.freeze({ key: "host-required" });
}

function resolveOnUpdate(
  value: unknown,
  physical: RuntimePhysicalType,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): "current-timestamp" | undefined {
  if (value === undefined) return undefined;
  if (value !== "current-timestamp") {
    issues.push(issue("invalid-database-options", path, "MySQL onUpdate option is invalid"));
    return undefined;
  }
  if (
    physical.resolved.kind !== "direct" ||
    (physical.resolved.type !== "datetime" && physical.resolved.type !== "timestamp")
  ) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        "MySQL current-timestamp update requires datetime or timestamp",
      ),
    );
    return undefined;
  }
  return value;
}

function autoIncrementEncoder(
  physical: RuntimePhysicalType,
): (value: unknown) => MysqlEncodedValue {
  return (value) => {
    const encoded = physical.encode(value);
    if (encoded === 0 || encoded === "0") return invalidValue("automatic increment");
    return encoded;
  };
}

function validatePrimaryKeyStructure(
  value: unknown,
  definition: RecordDefinition,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(
      issue("invalid-primary-key", path, "SQL Record primary key must be a nonempty field tuple"),
    );
    return Object.freeze([]);
  }
  const result: string[] = [];
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
    result.push(fieldName);
  });
  return Object.freeze(result);
}

function resolvePrimaryKey(
  fields: readonly string[],
  columns: Readonly<Record<string, RuntimeColumn>>,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): readonly RuntimeColumn[] {
  const result: RuntimeColumn[] = [];
  fields.forEach((fieldName, index) => {
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

function formatIssuePath(path: readonly (string | number)[]): string {
  return path.map(String).join(".");
}

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

  for (const [recordName, definition] of Object.entries(definitions)) {
    const tableValue = Object.hasOwn(definition, "table")
      ? Reflect.get(definition, "table")
      : undefined;
    const table =
      tableValue === undefined ? undefined : isRecordContainer(tableValue) ? tableValue : undefined;
    if (tableValue !== undefined && table === undefined) {
      state.issues.push(
        issue(
          "invalid-definition",
          sourcePath(overrides, recordName, undefined, ["table"]),
          "SQL Record table metadata must be an object",
        ),
      );
    }

    const mysqlTableValue = table === undefined ? undefined : Reflect.get(table, "mysql");
    if (isRecordContainer(mysqlTableValue)) {
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
      (!isRecordContainer(mysqlTableValue) ||
        !Object.hasOwn(mysqlTableValue, "database") ||
        Reflect.get(mysqlTableValue, "database") !== databaseValue)
    ) {
      state.issues.push(issue("invalid-name", databasePath, "MySQL table database is invalid"));
    }
    if (
      !tableNameValid &&
      (!isRecordContainer(mysqlTableValue) ||
        !Object.hasOwn(mysqlTableValue, "name") ||
        Reflect.get(mysqlTableValue, "name") !== nameValue)
    ) {
      state.issues.push(issue("invalid-name", tableNamePath, "MySQL table name is invalid"));
    }

    const primaryKeyValue = table?.primaryKey;
    const primaryKeyPath = sourcePath(overrides, recordName, undefined, ["table", "primaryKey"]);
    const primaryKeyFields = validatePrimaryKeyStructure(
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

    for (const [fieldName, field] of Object.entries(definition.fields)) {
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
            sourcePath(overrides, recordName, fieldName, ["column"]),
            `SQL Record field '${fieldName}' column metadata must be an object`,
          ),
        );
      }

      const mysqlColumnValue = column === undefined ? undefined : Reflect.get(column, "mysql");
      if (isRecordContainer(mysqlColumnValue) && Object.hasOwn(mysqlColumnValue, "name")) {
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
        (!isRecordContainer(mysqlColumnValue) ||
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
        validStatement(defaultValue, defaultPath, state.issues, "MySQL column default");
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

    const frozenColumns = Object.freeze(Object.fromEntries(columns));
    const primaryKey = resolvePrimaryKey(
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
      const earlier = seenColumnNames.get(asset.name);
      if (earlier === undefined) {
        seenColumnNames.set(asset.name, asset.fieldName);
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
      Object.freeze(Object.fromEntries(fieldStatements)),
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
      const foldedDatabase = foldMysqlDatabaseName(database);
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
      database === undefined ? "unqualified" : `database\u0000${foldMysqlDatabaseName(database)}`;
    const tableKey = `${databaseKey}\u0000${tableName}`;
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
    records: Object.freeze(Object.fromEntries(records)),
    tables: Object.freeze(Object.fromEntries(tables)),
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

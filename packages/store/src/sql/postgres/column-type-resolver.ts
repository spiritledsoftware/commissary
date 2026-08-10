import { isJsonValue, type JsonValue } from "../../json.js";
import {
  isSqlRecordContainer as isRecordContainer,
  sqlDefinitionIssue as issue,
} from "../record-catalog-resolver.js";
import {
  readSqlColumnTypeFormat,
  reflectSqlSelectStorage,
  type SqlColumnTypeFormat,
  type SqlCustomEncodedValue,
  type SqlPortableTypeName,
} from "../record.js";
import type { SqlStatement } from "../statement.js";
import { arrayCodec, directCodec, safeIntegerCodec, stringCodec } from "./column-codecs.js";
import { isValidPostgresName, qualifiedReference, validDatabaseStatement } from "./metadata.js";
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
import type {
  PostgresDirectTypeName,
  PostgresEncodedValue,
  PostgresResolvedDirectType,
  ResolutionState,
  RuntimePhysicalType,
} from "./resolution-types.js";

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
      if (!isCustomEncodedValue(converted)) {
        throw new TypeError("PostgreSQL custom encoder returned an invalid value");
      }
      return converted;
    };
    const decodeValue = (value: unknown): JsonValue => {
      const converted = (decode as (input: unknown) => unknown)(value);
      if (!isJsonValue(converted)) {
        throw new TypeError("PostgreSQL custom decoder returned an invalid value");
      }
      return converted;
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

export function resolvePhysicalType(
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

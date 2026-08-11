import { hasOnlySqlContractKeys } from "../contract-object.js";
import { validateSqlDefinitionStatement } from "../definition-statement.js";
import { isJsonValue, type JsonValue } from "../../json.js";
import {
  sqlDefinitionIssue as issue,
  sqlEvidenceMatchesApplication as evidenceCompatible,
} from "../record-catalog-resolver.js";
import {
  isSqlCustomEncodedValue,
  readSqlColumnTypeFormat,
  readSqlPortableTypeName,
  reflectSqlSelectStorage,
  sqlColumnTypeFormatKeys,
  type SqlColumnTypeFormat,
  type SqlPortableTypeName,
} from "../record.js";
import {
  booleanCodec,
  boundedInteger,
  directCodec,
  invalidValue,
  jsonCodec,
  stringCodec,
} from "./column-codecs.js";
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
import { isValidMysqlEnumValue } from "./mysql-contract.js";
import type { MysqlDecimalOptions, MysqlIntegerOptions, MysqlTemporalOptions } from "./record.js";
import type {
  MysqlDirectTypeName,
  MysqlEncodedValue,
  MysqlResolvedDirectType,
  MysqlResolvedDirectTypeOptions,
  ResolutionState,
  RuntimePhysicalType,
} from "./resolution-types.js";

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

function validUnsignedOptions(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
): options is Readonly<MysqlIntegerOptions> {
  return (
    options === undefined ||
    (hasOnlySqlContractKeys(options, new Set(["unsigned"])) &&
      isMysqlUnsignedOption(Reflect.get(options, "unsigned")))
  );
}

function validDecimalOptions(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
): options is Readonly<MysqlDecimalOptions> {
  if (options === undefined) return true;
  if (!hasOnlySqlContractKeys(options, new Set(["precision", "scale", "unsigned"]))) return false;
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
  if (!hasOnlySqlContractKeys(options, allowed)) return false;
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
    hasOnlySqlContractKeys(options, new Set(["length"])) &&
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
    (hasOnlySqlContractKeys(options, new Set(["fsp"])) &&
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

function resolveEnum(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
  path: readonly (string | number)[],
  state: ResolutionState,
): RuntimePhysicalType | undefined {
  const values = options === undefined ? undefined : Reflect.get(options, "values");
  if (
    options === undefined ||
    !hasOnlySqlContractKeys(options, new Set(["values"])) ||
    !Array.isArray(values) ||
    !Object.isFrozen(values) ||
    values.length === 0 ||
    values.length > 65_535 ||
    !values.every(isValidMysqlEnumValue) ||
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

function resolveCustom(
  options: Readonly<Record<PropertyKey, unknown>> | undefined,
  path: readonly (string | number)[],
  state: ResolutionState,
): RuntimePhysicalType | undefined {
  if (
    options === undefined ||
    !hasOnlySqlContractKeys(options, new Set(["type", "encode", "decode"])) ||
    typeof Reflect.get(options, "encode") !== "function" ||
    typeof Reflect.get(options, "decode") !== "function"
  ) {
    state.issues.push(issue("invalid-column-type", path, "MySQL custom type contract is invalid"));
    return undefined;
  }
  const type = validateSqlDefinitionStatement(
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
    return isSqlCustomEncodedValue(converted) ? converted : invalidValue("custom encoder output");
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
  const portable = readSqlPortableTypeName(format);
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
  if (!hasOnlySqlContractKeys(format, sqlColumnTypeFormatKeys)) return false;
  if (format.dialect === "portable") {
    return !Object.hasOwn(format, "identity") && !Object.hasOwn(format, "options");
  }
  return format.dialect !== "mysql" || !Object.hasOwn(format, "identity");
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
  const portable = readSqlPortableTypeName(format);
  return portable === undefined
    ? resolveMysqlType(format, path, state)
    : resolvePortableType(portable);
}

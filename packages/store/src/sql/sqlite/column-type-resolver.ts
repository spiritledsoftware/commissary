import { isJsonValue, type JsonValue } from "../../json.js";
import {
  sqlDefinitionIssue as issue,
  sqlEvidenceMatchesApplication as evidenceCompatible,
} from "../record-catalog-resolver.js";
import {
  readSqlColumnTypeFormat,
  reflectSqlSelectStorage,
  type SqlColumnTypeFormat,
  type SqlCustomEncodedValue,
  type SqlPortableTypeName,
} from "../record.js";
import { directCodec, invalidValue } from "./column-codecs.js";
import { validStatement } from "./metadata.js";
import { sqlColumnTypeFormatKeys } from "./sqlite-contract.js";
import type {
  ResolutionState,
  RuntimePhysicalType,
  SqliteDirectTypeName,
  SqliteEncodedValue,
  SqliteResolvedDirectType,
} from "./resolution-types.js";

const directTypes = new Set<SqliteDirectTypeName>([
  "integer",
  "boolean",
  "timestamp-seconds",
  "timestamp-milliseconds",
  "real",
  "text",
  "json",
  "blob",
  "json-blob",
  "bigint-blob",
  "numeric",
  "numeric-number",
]);

function directResolved(type: SqliteDirectTypeName): SqliteResolvedDirectType {
  return Object.freeze({ kind: "direct", type });
}

/** Test whether a contract object has only the allowed string keys. */
export function hasOnlyOwnStringKeys(
  value: Readonly<Record<PropertyKey, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function isDirectTypeName(value: string): value is SqliteDirectTypeName {
  return directTypes.has(value as SqliteDirectTypeName);
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

function resolvePortableType(type: SqlPortableTypeName): RuntimePhysicalType {
  const direct = (() => {
    switch (type) {
      case "text":
        return "text" as const;
      case "number":
        return "real" as const;
      case "integer":
        return "integer" as const;
      case "boolean":
        return "boolean" as const;
      case "json":
        return "json" as const;
    }
  })();
  return Object.freeze({ resolved: directResolved(direct), ...directCodec(direct) });
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
    state.issues.push(issue("invalid-column-type", path, "SQLite custom type contract is invalid"));
    return undefined;
  }
  const type = validStatement(
    Reflect.get(options, "type"),
    [...path, "type"],
    state.issues,
    "SQLite custom type",
    "invalid-column-type",
  );
  if (type === undefined) return undefined;
  const encode = Reflect.get(options, "encode");
  const decode = Reflect.get(options, "decode");
  const encodeValue = (value: unknown): SqliteEncodedValue => {
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

function resolveSqliteType(
  format: SqlColumnTypeFormat,
  path: readonly (string | number)[],
  state: ResolutionState,
): RuntimePhysicalType | undefined {
  if (format.dialect !== "sqlite") {
    state.issues.push(issue("invalid-column-type", path, "SQLite column requires a SQLite type"));
    return undefined;
  }
  if (format.type === "custom") return resolveCustom(format.options, path, state);
  if (!isDirectTypeName(format.type)) {
    state.issues.push(issue("invalid-column-type", path, `Unknown SQLite type '${format.type}'`));
    return undefined;
  }
  if (format.options !== undefined) {
    state.issues.push(
      issue("invalid-column-type", path, `SQLite ${format.type} type options are invalid`),
    );
    return undefined;
  }
  return Object.freeze({ resolved: directResolved(format.type), ...directCodec(format.type) });
}

function applicationForFormat(
  format: SqlColumnTypeFormat,
): RuntimePhysicalType["application"] | undefined {
  const portable = portableType(format);
  if (portable !== undefined) return resolvePortableType(portable).application;
  if (format.dialect !== "sqlite") return undefined;
  switch (format.type) {
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "real":
    case "numeric-number":
      return "number";
    case "json":
    case "json-blob":
      return "json";
    case "custom":
      return "custom";
    case "timestamp-seconds":
    case "timestamp-milliseconds":
    case "text":
    case "blob":
    case "bigint-blob":
    case "numeric":
      return "string";
    default:
      return undefined;
  }
}

function isCompatibleSqliteColumnTypeFormat(format: SqlColumnTypeFormat): boolean {
  if (Reflect.ownKeys(format).some((key) => !sqlColumnTypeFormatKeys.has(key))) return false;
  if (format.dialect === "portable") {
    return !Object.hasOwn(format, "identity") && !Object.hasOwn(format, "options");
  }
  return format.dialect !== "sqlite" || !Object.hasOwn(format, "identity");
}

/** Resolve one effective SQLite column type and codec. */
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
          "SQLite column requires explicit storage type evidence",
        ),
      );
      return undefined;
    }
    return resolvePortableType(evidence.type);
  }
  const format = readSqlColumnTypeFormat(value);
  if (format === undefined || !isCompatibleSqliteColumnTypeFormat(format)) {
    state.issues.push(
      issue("invalid-column-type", path, "SQLite column type has an incompatible opaque format"),
    );
    return undefined;
  }
  const application = applicationForFormat(format);
  if (application !== undefined && !evidenceCompatible(evidence, application)) {
    state.issues.push(
      issue("invalid-column-type", path, "SQLite column type conflicts with Select Schema output"),
    );
  }
  const portable = portableType(format);
  return portable === undefined
    ? resolveSqliteType(format, path, state)
    : resolvePortableType(portable);
}

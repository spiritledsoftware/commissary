import {
  isSqlRecordContainer as isRecordContainer,
  sqlDefinitionIssue as issue,
  sqlLiteralMatchesApplication as literalMatchesApplication,
} from "../record-catalog-resolver.js";
import {
  readSqlLiteralFormat,
  type SqlDefinitionIssue,
  type SqlLiteralValue,
  type SqlResolvedGeneratedColumn,
} from "../record.js";
import type { SqlStatement } from "../statement.js";
import { invalidValue } from "./column-codecs.js";
import { hasOnlyOwnStringKeys } from "./column-type-resolver.js";
import { validStatement } from "./metadata.js";
import type {
  MysqlEncodedValue,
  MysqlResolvedAutoIncrement,
  MysqlResolvedColumnType,
  RuntimePhysicalType,
} from "./resolution-types.js";

export function winningColumnTail(
  refinement: Readonly<Record<PropertyKey, unknown>> | undefined,
  key: string,
): readonly string[] {
  return refinement !== undefined && Object.hasOwn(refinement, key)
    ? ["column", "mysql", key]
    : ["column", key];
}

export function winningTableTail(
  refinement: Readonly<Record<PropertyKey, unknown>> | undefined,
  key: string,
): readonly string[] {
  return refinement !== undefined && Object.hasOwn(refinement, key)
    ? ["table", "mysql", key]
    : ["table", key];
}

export function resolveDefault(
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

export function resolveGenerated(
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

export function resolveAutoIncrement(
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

export function resolveOnUpdate(
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

export function autoIncrementEncoder(
  physical: RuntimePhysicalType,
): (value: unknown) => MysqlEncodedValue {
  return (value) => {
    const encoded = physical.encode(value);
    if (encoded === 0 || encoded === "0") return invalidValue("automatic increment");
    return encoded;
  };
}

export function formatIssuePath(path: readonly (string | number)[]): string {
  return path.map(String).join(".");
}

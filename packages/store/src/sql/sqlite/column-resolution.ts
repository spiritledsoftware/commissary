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
import { hasOnlyOwnStringKeys } from "./column-type-resolver.js";
import { validStatement } from "./metadata.js";
import type { RuntimePhysicalType, SqliteResolvedRowid } from "./resolution-types.js";

/** Locate the effective portable or SQLite column property. */
export function winningColumnTail(
  refinement: Readonly<Record<PropertyKey, unknown>> | undefined,
  key: string,
): readonly string[] {
  return refinement !== undefined && Object.hasOwn(refinement, key)
    ? ["column", "sqlite", key]
    : ["column", key];
}

/** Locate the effective portable or SQLite table property. */
export function winningTableTail(
  refinement: Readonly<Record<PropertyKey, unknown>> | undefined,
  key: string,
): readonly string[] {
  return refinement !== undefined && Object.hasOwn(refinement, key)
    ? ["table", "sqlite", key]
    : ["table", key];
}

/** Resolve one SQLite scalar or Statement default. */
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
        issue(
          "invalid-column-default",
          path,
          "SQLite column default does not match its final type",
        ),
      );
      return undefined;
    }
    return literal.value;
  }
  return validStatement(value, path, issues, "SQLite column default");
}

/** Resolve one normalized SQLite ROWID contract. */
export function resolveRowid(
  value: unknown,
  physical: RuntimePhysicalType | undefined,
  path: readonly (string | number)[],
  reusePath: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): SqliteResolvedRowid | undefined {
  if (value === undefined) return undefined;
  let valid = true;
  let reuse: "allowed" | "forbidden" = "allowed";
  if (!isRecordContainer(value)) {
    issues.push(issue("invalid-database-options", path, "SQLite ROWID metadata must be an object"));
    valid = false;
  } else {
    if (!hasOnlyOwnStringKeys(value, new Set(["reuse"]))) {
      issues.push(
        issue("invalid-database-options", path, "SQLite ROWID metadata has an invalid structure"),
      );
      valid = false;
    }
    const candidate = Reflect.get(value, "reuse");
    if (candidate !== undefined && candidate !== "allowed" && candidate !== "forbidden") {
      issues.push(issue("invalid-database-options", reusePath, "SQLite ROWID reuse is invalid"));
      valid = false;
    } else if (candidate !== undefined) {
      reuse = candidate;
    }
  }
  if (
    physical !== undefined &&
    (physical.resolved.kind !== "direct" || physical.resolved.type !== "integer")
  ) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        "SQLite ROWID requires the direct safe-number INTEGER type",
      ),
    );
    valid = false;
  }
  return valid && physical !== undefined ? Object.freeze({ reuse }) : undefined;
}

/** Resolve one normalized SQLite generated-column contract. */
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
      issue("invalid-database-options", path, "SQLite generated metadata must be an object"),
    );
    return undefined;
  }
  let valid = true;
  const hasExpression = Object.hasOwn(value, "expression");
  const hasMode = Object.hasOwn(value, "mode");
  if (!hasOnlyOwnStringKeys(value, new Set(["expression", "mode"])) || !hasExpression || !hasMode) {
    issues.push(
      issue("invalid-database-options", path, "SQLite generated metadata has an invalid structure"),
    );
    valid = false;
  }
  const expression = hasExpression
    ? validStatement(
        Reflect.get(value, "expression"),
        expressionPath,
        issues,
        "SQLite generated expression",
        "invalid-database-options",
      )
    : undefined;
  const mode = Reflect.get(value, "mode");
  if (hasMode && mode !== "virtual" && mode !== "stored") {
    issues.push(issue("invalid-database-options", modePath, "SQLite generated mode is invalid"));
    valid = false;
  }
  if (!valid || expression === undefined || (mode !== "virtual" && mode !== "stored")) {
    return undefined;
  }
  return Object.freeze({ expression, mode });
}

/** Format one definition path for a conflict diagnostic. */
export function formatIssuePath(path: readonly (string | number)[]): string {
  return path.map(String).join(".");
}

import type { RecordDefinition } from "../../record.js";
import {
  createSqlRecordReference,
  isSqlRecordContainer as isRecordContainer,
  sqlDefinitionIssue as issue,
} from "../record-catalog-resolver.js";
import type { SqlDefinitionIssue, SqlRecordReference } from "../record.js";
import { readSqlStatementFragments, sql, type SqlStatement } from "../statement.js";
import {
  hasSqliteStatementStructure,
  sqlOpaqueFormatSymbol,
  sqliteColumnOptionKeys,
  sqliteTableOptionKeys,
} from "./sqlite-contract.js";
import { readSqliteMetadataKind } from "./record.js";

/** Create one resolved SQLite table and Field reference. */
export function recordReference<Definition extends RecordDefinition>(
  name: string,
  fields: Readonly<Record<string, SqlStatement<never>>>,
): SqlRecordReference<Definition> {
  return createSqlRecordReference<Definition>(sql.identifier(name), fields);
}

/** Read and validate one package-copy-compatible SQLite metadata value. */
export function readSqliteMetadata(
  owner: "table" | "column",
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): Readonly<Record<PropertyKey, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecordContainer(value)) {
    issues.push(
      issue("invalid-database-options", path, `SQLite ${owner} refinement must be an object`),
    );
    return undefined;
  }
  const expected = owner === "table" ? "sqlite-table" : "sqlite-column";
  const allowedKeys = owner === "table" ? sqliteTableOptionKeys : sqliteColumnOptionKeys;
  if (
    readSqliteMetadataKind(value) !== expected ||
    Reflect.ownKeys(value).some(
      (key) => key !== sqlOpaqueFormatSymbol && (typeof key !== "string" || !allowedKeys.has(key)),
    )
  ) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        `SQLite ${owner} refinement has an incompatible opaque format`,
      ),
    );
    return undefined;
  }
  return value;
}

/** Validate one nonempty parameter-free SQLite Statement. */
export function validStatement(
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
  if (fragments.some((fragment) => fragment.kind === "parameter")) {
    issues.push(issue(code, path, `${owner} must not contain SQL parameters`));
    return undefined;
  }
  if (fragments.length === 0 || !hasSqliteStatementStructure(fragments)) {
    issues.push(issue(code, path, `${owner} requires nonempty SQL structure`));
    return undefined;
  }
  // SAFETY: Compatible opaque structure was checked and contains no parameter fragment.
  return value as SqlStatement<never>;
}

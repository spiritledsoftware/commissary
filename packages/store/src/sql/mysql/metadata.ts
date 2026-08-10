import {
  createSqlRecordReference,
  isSqlRecordContainer as isRecordContainer,
  sqlDefinitionIssue as issue,
} from "../record-catalog-resolver.js";
import type { RecordDefinition } from "../../record.js";
import type { SqlDefinitionIssue, SqlRecordReference } from "../record.js";
import { readSqlStatementFragments, sql, type SqlStatement } from "../statement.js";
import {
  hasMysqlStatementStructure,
  mysqlColumnOptionKeys,
  mysqlTableOptionKeys,
  sqlOpaqueFormatSymbol,
} from "./mysql-contract.js";
import { readMysqlMetadataKind } from "./record.js";

function qualifiedReference(database: string | undefined, name: string): SqlStatement<never> {
  return database === undefined
    ? sql.identifier(name)
    : sql`${sql.identifier(database)}.${sql.identifier(name)}`;
}

export function recordReference<Definition extends RecordDefinition>(
  database: string | undefined,
  name: string,
  fields: Readonly<Record<string, SqlStatement<never>>>,
): SqlRecordReference<Definition> {
  return createSqlRecordReference<Definition>(qualifiedReference(database, name), fields);
}

export function readMysqlMetadata(
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
  const allowedKeys = owner === "table" ? mysqlTableOptionKeys : mysqlColumnOptionKeys;
  if (
    readMysqlMetadataKind(value) !== expected ||
    Reflect.ownKeys(value).some(
      (key) => key !== sqlOpaqueFormatSymbol && (typeof key !== "string" || !allowedKeys.has(key)),
    )
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
  if (fragments.length === 0 || !hasMysqlStatementStructure(fragments)) {
    issues.push(issue(code, path, `${owner} requires nonempty SQL structure`));
    return undefined;
  }
  // SAFETY: Compatible opaque structure was checked and contains no parameter fragment.
  return value as SqlStatement<never>;
}

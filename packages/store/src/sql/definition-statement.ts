import { sqlDefinitionIssue } from "./record-catalog-resolver.js";
import type { SqlDefinitionIssue } from "./record.js";
import {
  hasSqlStatementStructure,
  readSqlStatementFragments,
  type SqlStatement,
} from "./statement.js";

/** Validate one compatible nonempty parameter-free SQL definition Statement. */
export function validateSqlDefinitionStatement(
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
  owner: string,
  code: SqlDefinitionIssue["code"] = "invalid-column-default",
): SqlStatement<never> | undefined {
  const fragments = readSqlStatementFragments(value);
  if (fragments === undefined) {
    issues.push(sqlDefinitionIssue(code, path, `${owner} requires a compatible SQL Statement`));
    return undefined;
  }
  if (fragments.some((fragment) => fragment.kind === "parameter")) {
    issues.push(sqlDefinitionIssue(code, path, `${owner} must not contain SQL parameters`));
    return undefined;
  }
  if (!hasSqlStatementStructure(fragments)) {
    issues.push(sqlDefinitionIssue(code, path, `${owner} requires nonempty SQL structure`));
    return undefined;
  }
  // SAFETY: Compatible opaque structure was checked and contains no parameter fragment.
  return value as SqlStatement<never>;
}

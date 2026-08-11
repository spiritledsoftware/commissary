import type { RecordDefinition } from "../../record.js";
import { isSqlContractObject } from "../contract-object.js";
import { sqlOpaqueFormatSymbol } from "../opaque-format.js";
import {
  createSqlRecordReference,
  sqlDefinitionIssue as issue,
} from "../record-catalog-resolver.js";
import type { SqlDefinitionIssue, SqlRecordReference } from "../record.js";
import { sql, type SqlStatement } from "../statement.js";
import { sqliteColumnOptionKeys, sqliteTableOptionKeys } from "./sqlite-contract.js";
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
  if (!isSqlContractObject(value)) {
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

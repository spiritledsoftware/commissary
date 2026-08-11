import type { RecordDefinition } from "../../record.js";
import { isSqlContractObject as isRecordContainer } from "../contract-object.js";
import {
  createSqlRecordReference,
  sqlDefinitionIssue as issue,
} from "../record-catalog-resolver.js";
import type { SqlDefinitionIssue, SqlRecordReference } from "../record.js";
import { sql, type SqlStatement } from "../statement.js";
import { readPostgresMetadataKind, type PostgresQualifiedName } from "./record.js";

const postgresNameEncoder = new TextEncoder();
export function isValidPostgresName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    postgresNameEncoder.encode(value).byteLength <= 63
  );
}

export function qualifiedReference(name: PostgresQualifiedName): SqlStatement<never> {
  return name.schema === undefined
    ? sql.identifier(name.name)
    : sql`${sql.identifier(name.schema)}.${sql.identifier(name.name)}`;
}

export function recordReference<Definition extends RecordDefinition>(
  name: PostgresQualifiedName,
  fields: Readonly<Record<string, SqlStatement<never>>>,
): SqlRecordReference<Definition> {
  return createSqlRecordReference<Definition>(qualifiedReference(name), fields);
}

export function readPostgresMetadata(
  owner: "table" | "column",
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): Readonly<Record<PropertyKey, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecordContainer(value)) {
    issues.push(
      issue("invalid-database-options", path, `PostgreSQL ${owner} refinement must be an object`),
    );
    return undefined;
  }
  const expected = owner === "table" ? "postgres-table" : "postgres-column";
  if (readPostgresMetadataKind(value) !== expected) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        `PostgreSQL ${owner} refinement has an incompatible opaque format`,
      ),
    );
    return undefined;
  }
  return value;
}

export function normalizeExactInteger(value: unknown): bigint | undefined {
  if (typeof value === "bigint") {
    return value;
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

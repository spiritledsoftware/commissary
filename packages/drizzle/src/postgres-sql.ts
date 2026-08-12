import type {
  BaseStoreOperatorTypes,
  RecordDefinitions,
  StoreCollections,
  StoreCreateInputMap,
} from "@commissary/store";
import {
  createSqlStore,
  type SqlParameterValue,
  type SqlQueryOutcome,
  type SqlStore,
} from "@commissary/store/sql";
import type {
  CompiledSqlStatement,
  SqlStatementCompilerOptions,
} from "@commissary/store/sql/adapter";
import { sql as drizzleSql, type SQL, type SQLChunk } from "drizzle-orm";

import { quotePostgresIdentifier } from "./drizzle-sql.js";

/** Minimal public Drizzle execution path used by direct SQL and binding probes. */
export interface PostgresExecutionDatabase<DriverResult> {
  readonly execute: (query: SQL) => PromiseLike<DriverResult>;
}

/** PostgreSQL Statement compiler preserving portable parameter representations. */
export const postgresSqlCompiler: SqlStatementCompilerOptions<
  SqlParameterValue,
  SqlParameterValue
> = Object.freeze({
  quoteIdentifier: quotePostgresIdentifier,
  makePlaceholder: (position: number) => `$${position + 1}`,
  isParameter: (value: unknown): value is SqlParameterValue =>
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string",
  convertParameter: (value: SqlParameterValue) => value,
});

/** Reconstruct one public Drizzle SQL value from exact compiled Statement segments. */
export function postgresDrizzleSql(compiled: CompiledSqlStatement<SqlParameterValue>): SQL {
  const chunks: SQLChunk[] = [];
  for (const [index, segment] of compiled.segments.entries()) {
    chunks.push(drizzleSql.raw(segment));
    if (index < compiled.parameters.length) {
      chunks.push(drizzleSql.param(compiled.parameters[index]));
    }
  }
  return drizzleSql.join(chunks);
}

/** Read one public PostgreSQL execution result as an SQL query outcome. */
export function postgresQueryOutcome(result: unknown): SqlQueryOutcome {
  if (Array.isArray(result)) return { kind: "rows", rows: result };
  if (typeof result !== "object" || result === null) return { kind: "rows", rows: undefined };
  return { kind: "rows", rows: Reflect.get(result, "rows") };
}

/** Read a verified PostgreSQL command row count without normalizing additional result data. */
export function postgresAffectedRows(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const rowCount = Reflect.get(result, "rowCount");
  return typeof rowCount === "number" && Number.isSafeInteger(rowCount) && rowCount >= 0
    ? rowCount
    : undefined;
}

/** Build the direct SQL capability over one active PostgreSQL database view. */
export function createPostgresSqlStore<
  Definitions extends RecordDefinitions,
  DriverResult,
  CreateInputs extends StoreCreateInputMap<Definitions>,
>(
  database: PostgresExecutionDatabase<DriverResult>,
  collections: StoreCollections<Definitions, BaseStoreOperatorTypes, CreateInputs>,
): SqlStore<Definitions, BaseStoreOperatorTypes, DriverResult, CreateInputs> {
  return createSqlStore({
    collections,
    compiler: postgresSqlCompiler,
    prepareQuery: (compiled) => async () => await database.execute(postgresDrizzleSql(compiled)),
    prepareExecute: (compiled) => async () => await database.execute(postgresDrizzleSql(compiled)),
    readQueryOutcome: postgresQueryOutcome,
    readAffectedRows: postgresAffectedRows,
  });
}

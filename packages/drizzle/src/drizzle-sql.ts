import { compileSqlStatement } from "@commissary/store/sql/adapter";
import type { SqlStatement } from "@commissary/store/sql";
import { sql as drizzleSql, type SQL } from "drizzle-orm";

/** Convert a parameter-free Commissary SQL definition Statement through exact public segments. */
export function drizzleDefinitionSql(
  statement: SqlStatement<never>,
  quoteIdentifier: (name: string) => string,
): SQL {
  return drizzleSql.raw(drizzleDefinitionSqlText(statement, quoteIdentifier));
}

/** Compile a parameter-free definition Statement to exact dialect SQL text. */
export function drizzleDefinitionSqlText(
  statement: SqlStatement<never>,
  quoteIdentifier: (name: string) => string,
): string {
  const compiled = compileSqlStatement<never, never>(statement, {
    quoteIdentifier,
    makePlaceholder: () => "?",
    isParameter: (_value): _value is never => false,
    convertParameter: (value) => value,
  });
  return compiled.text;
}

/** Render one SQL identifier for PostgreSQL definition SQL. */
export function quotePostgresIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Render one SQL identifier for MySQL definition SQL. */
export function quoteMysqlIdentifier(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

/** Render one SQL identifier for SQLite definition SQL. */
export function quoteSqliteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

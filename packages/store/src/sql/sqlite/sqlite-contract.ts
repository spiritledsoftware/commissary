import type { SqlStatementFragment } from "../statement.js";

/** Package-copy-compatible identity for opaque SQL values used by SQLite contracts. */
export const sqlOpaqueFormatSymbol = Symbol.for("@commissary/store/sql-opaque-format");

/** Valid caller-owned keys for `sqlite.table()` options. */
export const sqliteTableOptionKeys: ReadonlySet<string> = new Set(["name"]);

/** Valid caller-owned keys for `sqlite.column()` options. */
export const sqliteColumnOptionKeys: ReadonlySet<string> = new Set([
  "name",
  "type",
  "default",
  "notNull",
  "rowid",
  "generated",
]);

/** Valid internal keys for a compatible opaque SQL column-type format. */
export const sqlColumnTypeFormatKeys: ReadonlySet<PropertyKey> = new Set([
  "format",
  "kind",
  "dialect",
  "type",
  "identity",
  "options",
]);

/** Test whether validated Statement fragments contain nonempty SQL structure. */
export function hasSqliteStatementStructure(fragments: readonly SqlStatementFragment[]): boolean {
  return fragments.some(
    (fragment) =>
      fragment.kind === "identifier" || (fragment.kind === "raw" && fragment.text.length > 0),
  );
}

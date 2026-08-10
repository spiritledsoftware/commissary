import type { SqlStatementFragment } from "../statement.js";

/** Package-copy-compatible identity for opaque SQL values used by MySQL contracts. */
export const sqlOpaqueFormatSymbol = Symbol.for("@commissary/store/sql-opaque-format");

/** Valid caller-owned keys for `mysql.table()` options. */
export const mysqlTableOptionKeys: ReadonlySet<string> = new Set(["database", "name"]);

/** Valid caller-owned keys for `mysql.column()` options. */
export const mysqlColumnOptionKeys: ReadonlySet<string> = new Set([
  "name",
  "type",
  "default",
  "notNull",
  "autoIncrement",
  "generated",
  "onUpdate",
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

/** Test whether an unknown value is a non-array object that can own contract fields. */
export function isRecordContainer(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test whether validated Statement fragments contain nonempty SQL structure. */
export function hasMysqlStatementStructure(fragments: readonly SqlStatementFragment[]): boolean {
  return fragments.some(
    (fragment) =>
      fragment.kind === "identifier" || (fragment.kind === "raw" && fragment.text.length > 0),
  );
}

/** Test one MySQL inline-enum value before uniqueness validation. */
export function isValidMysqlEnumValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.endsWith(" ") &&
    Array.from(value).length <= 255
  );
}

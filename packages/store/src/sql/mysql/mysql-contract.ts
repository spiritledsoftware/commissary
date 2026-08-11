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

/** Test one MySQL inline-enum value before uniqueness validation. */
export function isValidMysqlEnumValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.endsWith(" ") &&
    Array.from(value).length <= 255
  );
}

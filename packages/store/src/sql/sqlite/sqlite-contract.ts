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

/** Valid caller-owned keys for SQLite ROWID options. */
export const sqliteRowidOptionKeys: ReadonlySet<string> = new Set(["reuse"]);

/** Valid caller-owned keys for SQLite generated-column options. */
export const sqliteGeneratedOptionKeys: ReadonlySet<string> = new Set(["expression", "mode"]);

/** Valid caller-owned keys for SQLite custom-type options. */
export const sqliteCustomTypeOptionKeys: ReadonlySet<string> = new Set([
  "type",
  "encode",
  "decode",
]);

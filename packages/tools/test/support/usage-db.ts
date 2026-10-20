// The usage database of Tools' tests (#214): every checked-in migration of `usage_records` (`migrations/usage/`),
// applied in order to the test Worker's `USAGE` (idempotent), so a new migration needs nothing here. Models' tests keep
// the list (`resetUsageDb`, `@commissary/models/testing`), which Tools' tests cannot import: Models' tests depend on
// Tools. Better Auth's old `auth_` tables (0008, dropped by 0009) are not part of it. `ALTER TABLE ... ADD COLUMN` has
// no IF NOT EXISTS, so a duplicate-column failure of a database already migrated is ignored.
import { env } from "cloudflare:test";

/** The migrations' SQL by path, transformed by vitest (`?raw`: each file's text). */
const MIGRATIONS = import.meta.glob<string>("../../../../migrations/usage/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Better Auth's tables of before ADR 0030, which the usage database no longer has. */
const NOT_USAGE = /\/000[89]_[^/]*\.sql$/;

/** The statements of a migration, its comments left out. */
const statementsOf = (sql: string): ReadonlyArray<string> =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/** Applies the usage migrations to the test Worker's `USAGE`. */
export const migrateUsageDb = async (): Promise<void> => {
  const paths = Object.keys(MIGRATIONS)
    .filter((path) => !NOT_USAGE.test(path))
    .toSorted();

  for (const path of paths)
    for (const statement of statementsOf(MIGRATIONS[path] ?? ""))
      try {
        await env.USAGE.prepare(
          statement.replace(/^CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/, "CREATE $1 IF NOT EXISTS "),
        ).run();
      } catch (error) {
        if (!/duplicate column name/i.test(String(error))) throw error;
      }
};

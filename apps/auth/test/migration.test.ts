// The `SignIn` database's migration (migrations/sign-in/, Better Auth's tables, src/sign-in/auth.ts): applied to an
// empty database, it creates exactly what Better Auth expects, and a second run changes nothing.
import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vite-plus/test";
import signIn from "../../../migrations/sign-in/0001_better_auth.sql?raw";
import { authOptions } from "../src/sign-in/auth.ts";
import { statementsOf } from "./support.ts";

const db = env.SIGN_IN;

const tables = async (): Promise<ReadonlyArray<string>> =>
  (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
  ).results
    .map((row) => row.name)
    .filter(
      (name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_") && !name.startsWith("d1_"),
    );

describe("the SignIn database's migration", () => {
  it("creates exactly Better Auth's tables in an empty database and is idempotent", async () => {
    for (const table of ["session", "account", "verification", "user"])
      await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();

    expect(await tables()).toEqual([]);

    const before = await getMigrations(authOptions(env, "https://auth.commissary.test"));
    expect(before.toBeCreated.map((table) => table.table).sort()).toEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);

    for (const statement of statementsOf(signIn)) await db.prepare(statement).run();

    const after = await getMigrations(authOptions(env, "https://auth.commissary.test"));
    expect(after.toBeCreated).toEqual([]);
    expect(after.toBeAdded).toEqual([]);
    expect(await tables()).toEqual(["account", "session", "user", "verification"]);

    // A second run is a no-op.
    for (const statement of statementsOf(signIn)) await db.prepare(statement).run();
    expect(await tables()).toEqual(["account", "session", "user", "verification"]);
  });
});

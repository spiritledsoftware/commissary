// `@commissary/state/testing`: helpers for workerd tests (`@cloudflare/vitest-plugin`) of a Durable Object on real
// SQLite storage, for state's tests and its dependants' (docs/DEVELOPMENT.md, "Tests"). Test files only.
import { runInDurableObject } from "cloudflare:test";

/**
 * The tables of the ControlPlane's org-wide base, as the ControlPlane named them before it was split into the base and
 * the areas' parts (#148): an area's tables come on top.
 */
export const ORG_WIDE_TABLES: ReadonlyArray<string> = [
  "api_key_settings",
  "api_keys",
  "management_keys",
  "members",
  "membership",
  "org_data_key",
  "removed_principals",
  "service_tokens",
  "session_instances",
  "spend_counters",
  "spend_limits",
  "spend_settings",
  "sso_domains",
  "sso_provider",
  "team_members",
  "teams",
];

/** The tables of a Durable Object's storage that are its own (not SQLite's or the runtime's), by name. */
const ownTables = (sql: SqlStorage): string[] =>
  sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);

/** The object's own tables (not SQLite's or the runtime's), by name. */
export const tablesOf = <O extends Rpc.DurableObjectBranded>(
  stub: DurableObjectStub<O>,
): Promise<string[]> =>
  runInDurableObject(stub, (_instance, state) => ownTables(state.storage.sql));

/** Every row of every table of the object, as JSON text (what browsing its storage shows). */
export const storedText = <O extends Rpc.DurableObjectBranded>(
  stub: DurableObjectStub<O>,
): Promise<string> =>
  runInDurableObject(stub, (_instance, state) =>
    JSON.stringify(
      Object.fromEntries(
        ownTables(state.storage.sql).map((table) => [
          table,
          state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray(),
        ]),
      ),
    ),
  );

/** The object's alarm (epoch ms), `null` when none is set. */
export const alarmOf = <O extends Rpc.DurableObjectBranded>(
  stub: DurableObjectStub<O>,
): Promise<number | null> =>
  runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

/**
 * Runs `call` on the stub of a ControlPlane part (`withPart(stub.models(), …)`), then disposes of it, also when `call`
 * fails: a stub of a part the test still holds keeps `evictDurableObject` from finishing, and a pipelined call
 * (`stub.models().x()`) leaves one held until the test ends.
 */
export const withPart = async <P extends Disposable, R>(
  part: PromiseLike<P>,
  call: (part: P) => R,
): Promise<Awaited<R>> => {
  const held = await part;

  try {
    return await call(held);
  } finally {
    held[Symbol.dispose]();
  }
};

/** An in-memory Spend book, limits and the micro-USD in a dollar, for tests of the Spend ledger and its callers. */
export { limit, MemorySpendBook, USD } from "./support/spend.ts";

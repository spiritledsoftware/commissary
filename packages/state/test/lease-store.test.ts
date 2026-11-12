// The general-purpose lease store (src/lease.ts) on a Durable Object's real SQLite storage: one lease per name,
// held until given back with its token or abandoned, on the object's own clock; and the leases stored before leases
// had names (the ControlPlane's quota sweep lease, the Platform's catalog refresh lease) read back unchanged.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, describe, expect, it } from "vite-plus/test";
import { LEASE_TTL_MS, LeaseStore, mayTake } from "../src/index.ts";

/** Runs `body` on the SQLite storage of a fresh ControlPlane (any Durable Object with SQLite storage would do). */
const onFreshStorage = (body: (sql: SqlStorage) => void): Promise<void> =>
  runInDurableObject(env.CONTROL_PLANE.getByName(crypto.randomUUID()), (_instance, state) =>
    body(state.storage.sql),
  );

/** A lease row as the store wrote it before leases had names: one table per lease, a bare UUID as its token. */
const storeUnnamedLease = (sql: SqlStorage, table: string, renewedAt: number): void => {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       token TEXT NOT NULL,
       source TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       renewed_at INTEGER NOT NULL
     )`,
  );
  sql.exec(
    `INSERT INTO ${table} (id, token, source, started_at, renewed_at)
     VALUES (1, '6f1c2a8e-0000-4000-8000-000000000001', 'cron', ?, ?)`,
    renewedAt - 1_000,
    renewedAt,
  );
};

describe("lease", () => {
  it("is free when unset, held while renewed, and abandoned a lifetime after the last renewal", () => {
    const lease = { token: "t", source: "cron" as const, startedAt: 0, renewedAt: 1_000_000 };

    expect(LEASE_TTL_MS).toBe(120_000);
    expect(mayTake(undefined, 0)).toBe(true);
    expect(mayTake(lease, 1_000_000)).toBe(false);
    expect(mayTake(lease, 1_000_000 + LEASE_TTL_MS - 1)).toBe(false);
    expect(mayTake(lease, 1_000_000 + LEASE_TTL_MS)).toBe(true);
  });

  it("renews and releases only with the token that holds it, on the object's clock", async () => {
    const clock = { now: 5_000_000 };

    await onFreshStorage((sql) => {
      const store = new LeaseStore(sql, () => clock.now);
      const taken = store.take("quota_sweep", "panel");

      assert(taken.ok);
      expect(taken.lease).toMatchObject({
        source: "panel",
        startedAt: 5_000_000,
        renewedAt: 5_000_000,
      });

      // A long holder that keeps renewing keeps the lease well past one lifetime.
      for (let step = 0; step < 4; step += 1) {
        clock.now += LEASE_TTL_MS - 1_000;
        expect(store.renew(taken.lease.token)).toBe(true);
        expect(store.take("quota_sweep", "cron").ok).toBe(false);
      }

      expect(store.renew("someone-else")).toBe(false);
      store.release("someone-else");
      expect(store.current("quota_sweep")?.token).toBe(taken.lease.token);

      // Silent for a lifetime: abandoned, taken over; the old token can neither renew nor release the new lease.
      clock.now += LEASE_TTL_MS;
      const next = store.take("quota_sweep", "cron");

      assert(next.ok);
      expect(store.renew(taken.lease.token)).toBe(false);
      store.release(taken.lease.token);
      expect(store.current("quota_sweep")?.token).toBe(next.lease.token);
      store.release(next.lease.token);
      expect(store.current("quota_sweep")).toBeUndefined();
    });
  });

  it("keeps each name's lease apart: a token renews and releases only the lease it was taken for", async () => {
    await onFreshStorage((sql) => {
      const store = new LeaseStore(sql);
      const sweep = store.take("quota_sweep", "cron");
      const refresh = store.take("catalog_refresh", "panel");

      assert(sweep.ok);
      assert(refresh.ok);
      expect(store.take("catalog_refresh", "cron")).toMatchObject({
        ok: false,
        held: { source: "panel" },
      });

      store.release(sweep.lease.token);
      expect(store.current("quota_sweep")).toBeUndefined();
      expect(store.current("catalog_refresh")?.token).toBe(refresh.lease.token);
      expect(store.renew(sweep.lease.token)).toBe(false);
      expect(store.renew(refresh.lease.token)).toBe(true);
    });
  });

  it("answers for a name nothing has taken yet, and ignores tokens it never handed out", async () => {
    await onFreshStorage((sql) => {
      const store = new LeaseStore(sql);

      expect(store.current("never_taken")).toBeUndefined();
      expect(store.renew("never_taken:not-a-token")).toBe(false);
      expect(store.renew("not-a-token")).toBe(false);
      store.release("not-a-token");
      store.release("bad name:not-a-token");
      expect(store.take("never_taken", "cron").ok).toBe(true);
    });
  });

  it("refuses a name that is not a lowercase identifier (it names the lease's table)", async () => {
    await onFreshStorage((sql) => {
      const store = new LeaseStore(sql);

      for (const name of ["", "Quota", "quota sweep", "x; DROP TABLE y", "1lease"])
        expect(() => store.take(name, "cron")).toThrow(/lease name/);
    });
  });
});

describe("lease storage", () => {
  it("reads back a lease stored before leases had names, which holds until it is abandoned", async () => {
    const clock = { now: 9_000_000 };

    await onFreshStorage((sql) => {
      storeUnnamedLease(sql, "quota_sweep_lease", clock.now);
      storeUnnamedLease(sql, "catalog_refresh_lease", clock.now);

      const store = new LeaseStore(sql, () => clock.now);

      for (const name of ["quota_sweep", "catalog_refresh"]) {
        expect(store.current(name)).toEqual({
          token: "6f1c2a8e-0000-4000-8000-000000000001",
          source: "cron",
          startedAt: 8_999_000,
          renewedAt: 9_000_000,
        });
        expect(store.take(name, "panel")).toMatchObject({ ok: false, held: { source: "cron" } });
      }

      clock.now += LEASE_TTL_MS;
      expect(store.take("catalog_refresh", "panel").ok).toBe(true);
    });
  });

  it("renews and gives back a lease taken before tokens named their lease, with its bare token", async () => {
    const clock = { now: 9_000_000 };
    const bare = "6f1c2a8e-0000-4000-8000-000000000001";

    await onFreshStorage((sql) => {
      storeUnnamedLease(sql, "quota_sweep_lease", clock.now);

      const store = new LeaseStore(sql, () => clock.now);

      clock.now += LEASE_TTL_MS - 1_000;
      expect(store.renew(bare)).toBe(true);
      expect(store.current("quota_sweep")?.renewedAt).toBe(clock.now);

      store.release(bare);
      expect(store.current("quota_sweep")).toBeUndefined();
      expect(store.renew(bare)).toBe(false);
    });
  });

  it("recreates a table from before renewals (no renewed_at), dropping the transient lease it held", async () => {
    await onFreshStorage((sql) => {
      sql.exec("DROP TABLE IF EXISTS quota_sweep_lease");
      sql.exec(
        `CREATE TABLE quota_sweep_lease (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           token TEXT NOT NULL,
           source TEXT NOT NULL,
           started_at INTEGER NOT NULL
         )`,
      );
      sql.exec(
        "INSERT INTO quota_sweep_lease (id, token, source, started_at) VALUES (1, 'old', 'cron', ?)",
        Date.now(),
      );

      const store = new LeaseStore(sql);

      expect(store.current("quota_sweep")).toBeUndefined();
      const taken = store.take("quota_sweep", "panel");

      assert(taken.ok);
      expect(store.renew(taken.lease.token)).toBe(true);

      // Opening it again keeps a current table and its lease.
      expect(new LeaseStore(sql).current("quota_sweep")?.token).toBe(taken.lease.token);
    });
  });

  it("the Platform reads back the catalog refresh lease its storage held before leases had names", async () => {
    const platform = env.PLATFORM.getByName(`registry-${crypto.randomUUID()}`);

    await runInDurableObject(platform, (_instance, state) => {
      storeUnnamedLease(state.storage.sql, "catalog_refresh_lease", Date.now());
    });

    expect(await platform.takeLease("catalog_refresh", "panel")).toMatchObject({
      ok: false,
      held: { token: "6f1c2a8e-0000-4000-8000-000000000001", source: "cron" },
    });
  });
});

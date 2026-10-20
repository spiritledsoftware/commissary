// The Spend store (`@commissary/state/spend`) over the SQLite of a ControlPlane Durable Object: limits with revisions and the
// member-vs-admin rule on an API key, counters of the current period, the org's calendar, and the upgrade of a
// ControlPlane that predates Spend limits (it keeps working, with no limit).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { OrgId } from "@commissary/core";
import { SpendLedger, SpendStore, type SpendResult } from "../src/spend/index.ts";
import { USD } from "./support/spend.ts";

/** Runs `body` against a store on the SQLite of a fresh org's Durable Object. */
const withStore = async (body: (store: SpendStore, sql: SqlStorage) => void | Promise<void>) => {
  const org = OrgId.make(`spend-${crypto.randomUUID().slice(0, 8)}`);
  let tick = 1_000;

  await runInDurableObject(env.CONTROL_PLANE.getByName(org), async (_instance, state) => {
    await body(new SpendStore(state.storage.sql, () => (tick += 1)), state.storage.sql);
  });
};

const value = <A>(result: SpendResult<A>): A => {
  if (!result.ok) throw new Error(`expected a written limit: ${result.message}`);

  return result.value;
};

const KEY = { kind: "key", subject: "key-1", period: "day" } as const;

describe("SpendStore limits", () => {
  it("starts empty, in UTC with weeks starting on Monday", async () => {
    await withStore((store) => {
      expect(store.limits()).toEqual([]);
      expect(store.settings()).toEqual({ timeZone: "UTC", weekStart: "monday" });
    });
  });

  it("creates, edits and deletes a limit with revisions", async () => {
    await withStore((store) => {
      const created = value(
        store.create({ ...KEY, amountMicros: 5 * USD, source: "admin" }, "admin@example.com"),
      );

      expect(created).toMatchObject({
        revision: 1,
        amountMicros: 5 * USD,
        updatedBy: "admin@example.com",
      });
      expect(store.limits()).toEqual([created]);

      const edited = value(store.update(created.id, 1, 7 * USD, "other@example.com"));

      expect(edited).toMatchObject({
        revision: 2,
        amountMicros: 7 * USD,
        updatedBy: "other@example.com",
      });
      expect(store.update(created.id, 1, 9 * USD, "x")).toMatchObject({
        ok: false,
        error: "conflict",
      });
      expect(store.remove(created.id, 1)).toMatchObject({ ok: false, error: "conflict" });
      expect(store.limit(created.id)?.amountMicros).toBe(7 * USD);

      value(store.remove(created.id, 2));
      expect(store.limits()).toEqual([]);
      expect(store.remove(created.id, 2)).toMatchObject({ ok: false, error: "not_found" });
      expect(store.update(created.id, 2, 1, "x")).toMatchObject({ ok: false, error: "not_found" });
    });
  });

  it("allows 0 (nothing may be spent) and refuses amounts that are not whole non-negative numbers", async () => {
    await withStore((store) => {
      expect(store.create({ ...KEY, amountMicros: 0, source: "admin" }, "a").ok).toBe(true);

      for (const amountMicros of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])
        expect(
          store.create({ ...KEY, period: "week", amountMicros, source: "admin" }, "a"),
        ).toMatchObject({
          ok: false,
          error: "invalid",
        });

      const [only] = store.limits();

      expect(store.update(only?.id ?? "", 1, -5, "a")).toMatchObject({
        ok: false,
        error: "invalid",
      });
    });
  });

  it("holds one limit per subject, period and source, and the org limit has no subject", async () => {
    await withStore((store) => {
      value(store.create({ ...KEY, amountMicros: USD, source: "admin" }, "a"));

      expect(store.create({ ...KEY, amountMicros: 2 * USD, source: "admin" }, "a")).toMatchObject({
        ok: false,
        error: "conflict",
      });

      expect(
        store.create({ ...KEY, period: "week", amountMicros: USD, source: "admin" }, "a").ok,
      ).toBe(true);
      expect(store.create({ ...KEY, amountMicros: USD / 2, source: "member" }, "m").ok).toBe(true);

      expect(
        store.create(
          { kind: "org", subject: "x", period: "day", amountMicros: 1, source: "admin" },
          "a",
        ),
      ).toMatchObject({ ok: false, error: "invalid" });

      expect(
        store.create(
          { kind: "member", subject: "", period: "day", amountMicros: 1, source: "admin" },
          "a",
        ),
      ).toMatchObject({ ok: false, error: "invalid" });

      expect(
        store.create(
          { kind: "org", subject: "", period: "day", amountMicros: 1, source: "admin" },
          "a",
        ).ok,
      ).toBe(true);
    });
  });

  it("keeps a member's limit on their API key within the admin's limit on it", async () => {
    await withStore((store) => {
      value(store.create({ ...KEY, amountMicros: 10 * USD, source: "admin" }, "a"));

      expect(store.create({ ...KEY, amountMicros: 11 * USD, source: "member" }, "m")).toMatchObject(
        {
          ok: false,
          error: "exceeds_admin_limit",
        },
      );

      const own = value(store.create({ ...KEY, amountMicros: 10 * USD, source: "member" }, "m"));

      expect(store.update(own.id, 1, 10 * USD + 1, "m")).toMatchObject({
        ok: false,
        error: "exceeds_admin_limit",
      });
      expect(value(store.update(own.id, 1, 4 * USD, "m")).amountMicros).toBe(4 * USD);

      // Another period or key has no admin limit above it.
      expect(
        store.create({ ...KEY, period: "month", amountMicros: 99 * USD, source: "member" }, "m").ok,
      ).toBe(true);
      expect(
        store.create({ ...KEY, subject: "key-2", amountMicros: 99 * USD, source: "member" }, "m")
          .ok,
      ).toBe(true);
    });
  });

  it("forgets the limits and counters of a subject that is gone", async () => {
    await withStore((store) => {
      value(store.create({ ...KEY, amountMicros: USD, source: "admin" }, "a"));
      value(
        store.create(
          { kind: "org", subject: "", period: "day", amountMicros: USD, source: "admin" },
          "a",
        ),
      );
      store.charge({ kind: "key", subject: "key-1" }, "day", 0, 5);
      store.forget("key", "key-1");

      expect(store.limits().map((limit) => limit.kind)).toEqual(["org"]);
      expect(store.spent({ kind: "key", subject: "key-1" }, "day", 0)).toBe(0);
    });
  });
});

describe("SpendStore counters", () => {
  const scope = { kind: "member", subject: "m1" } as const;

  it("adds charges per scope, period and period start, and keeps only the current period", async () => {
    await withStore((store) => {
      store.charge(scope, "day", 100, 3);
      store.charge(scope, "day", 100, 4);
      store.charge(scope, "week", 100, 9);
      store.charge({ kind: "member", subject: "m2" }, "day", 100, 1);

      expect(store.spent(scope, "day", 100)).toBe(7);
      expect(store.spent(scope, "week", 100)).toBe(9);
      expect(store.spent(scope, "day", 200)).toBe(0);

      // The next day's first charge drops yesterday's counter of that scope and period only.
      store.charge(scope, "day", 200, 2);

      expect(store.spent(scope, "day", 200)).toBe(2);
      expect(store.spent(scope, "day", 100)).toBe(0);
      expect(store.spent(scope, "week", 100)).toBe(9);
      expect(store.spent({ kind: "member", subject: "m2" }, "day", 100)).toBe(1);
    });
  });

  it("shares the counter of an admin's and a member's limit and drops it with the last one", async () => {
    await withStore((store) => {
      const admin = value(store.create({ ...KEY, amountMicros: 10 * USD, source: "admin" }, "a"));
      const member = value(store.create({ ...KEY, amountMicros: 5 * USD, source: "member" }, "m"));

      store.charge({ kind: "key", subject: "key-1" }, "day", 0, 3 * USD);
      value(store.remove(member.id, 1));
      expect(store.spent({ kind: "key", subject: "key-1" }, "day", 0)).toBe(3 * USD);

      value(store.remove(admin.id, 1));
      expect(store.spent({ kind: "key", subject: "key-1" }, "day", 0)).toBe(0);
    });
  });

  it("enforces limits through the ledger over SQL, and answers at once while there are none", async () => {
    await withStore((store) => {
      const ledger = new SpendLedger(store, () => []);
      const now = Date.parse("2026-10-14T12:00:00Z");

      expect(ledger.gate({ memberId: "m1", apiKeyId: "key-1" }, now)).toBeUndefined();
      expect(ledger.scopes({ memberId: "m1" }, { id: "c", shared: true })).toEqual([]);

      value(
        store.create(
          { kind: "member", subject: "m1", period: "day", amountMicros: 2 * USD, source: "admin" },
          "a",
        ),
      );
      const scopes = ledger.scopes({ memberId: "m1" }, { id: "c", shared: true });

      expect(scopes).toEqual([{ kind: "member", subject: "m1" }]);
      ledger.charge(scopes, 2 * USD, now);

      expect(ledger.gate({ memberId: "m1" }, now)?.sharedBlocked).toMatchObject({
        kind: "member",
        period: "day",
        resetsAt: Date.parse("2026-10-15T00:00:00Z"),
      });

      expect(ledger.gate({ memberId: "m2" }, now)).toBeUndefined();
    });
  });
});

describe("SpendStore settings", () => {
  it("sets the time zone and the first day of the week, and refuses what is not one", async () => {
    await withStore((store) => {
      expect(value(store.setSettings({ timeZone: "Europe/Berlin" }))).toEqual({
        timeZone: "Europe/Berlin",
        weekStart: "monday",
      });

      expect(value(store.setSettings({ weekStart: "sunday" }))).toEqual({
        timeZone: "Europe/Berlin",
        weekStart: "sunday",
      });

      for (const timeZone of ["", "Mars/Base", "+02:00"])
        expect(store.setSettings({ timeZone })).toMatchObject({ ok: false, error: "invalid" });

      expect(store.setSettings({ weekStart: "someday" as "monday" })).toMatchObject({
        ok: false,
        error: "invalid",
      });
      expect(store.settings()).toEqual({ timeZone: "Europe/Berlin", weekStart: "sunday" });
    });
  });
});

describe("SpendStore calendar change", () => {
  it("starts the counters afresh, so a calendar that returns does not bring old spend back", async () => {
    await withStore((store) => {
      const key = { kind: "key", subject: "key-1" } as const;

      value(store.create({ ...KEY, amountMicros: 10 * USD, source: "admin" }, "a"));
      store.charge(key, "day", 1_000, 7);
      expect(store.spent(key, "day", 1_000)).toBe(7);

      // The same calendar written again keeps the counter.
      value(store.setSettings({ timeZone: "UTC", weekStart: "monday" }));
      expect(store.spent(key, "day", 1_000)).toBe(7);

      value(store.setSettings({ timeZone: "Asia/Tokyo" }));
      expect(store.spent(key, "day", 1_000)).toBe(0);

      store.charge(key, "day", 500, 3);
      value(store.setSettings({ timeZone: "UTC" }));
      expect(store.spent(key, "day", 500)).toBe(0);
      expect(store.spent(key, "day", 1_000)).toBe(0);
    });
  });
});

describe("SpendStore upgrade", () => {
  it("is created for a Durable Object that predates Spend limits, and running the schema again keeps what it holds", async () => {
    await withStore((store, sql) => {
      value(store.create({ ...KEY, amountMicros: USD, source: "admin" }, "a"));
      store.setSettings({ timeZone: "Asia/Tokyo" });
      store.charge({ kind: "key", subject: "key-1" }, "day", 0, 5);

      // The next start (the schema runs again) keeps limits, counters and settings.
      const restarted = new SpendStore(sql);

      expect(restarted.limits()).toHaveLength(1);
      expect(restarted.settings().timeZone).toBe("Asia/Tokyo");
      expect(restarted.spent({ kind: "key", subject: "key-1" }, "day", 0)).toBe(5);

      // The state before the change: no spend tables at all.
      for (const table of ["spend_limits", "spend_counters", "spend_settings"])
        sql.exec(`DROP TABLE ${table}`);

      const upgraded = new SpendStore(sql);

      expect(upgraded.limits()).toEqual([]);
      expect(upgraded.settings()).toEqual({ timeZone: "UTC", weekStart: "monday" });

      // Nothing is limited: no gate, no scope to charge.
      const ledger = new SpendLedger(upgraded, () => []);

      expect(ledger.gate({ memberId: "m1", apiKeyId: "key-1" }, Date.now())).toBeUndefined();
    });
  });
});

/**
 * An org's plan and free-usage counters inside its ControlPlane Durable Object (SQLite). New in the Workers port, no
 * Go counterpart; the counters follow how Spend limits keep theirs (`packages/models/src/spend/store.ts`), not D1
 * usage records.
 *
 * - **billing_plan**: one row with the org's plan; no row means the default (`free`), so an org that existed before
 *   plans needs no backfill.
 * - **billing_usage**: what the org used of each unit in a calendar month (the month's start, epoch ms, and the unit).
 *   A row is created by the first use in a month, so an org that used nothing stores nothing and a new month starts at
 *   zero by itself.
 *
 * Every table is created `IF NOT EXISTS` in the constructor. All methods are synchronous, so a check and the count
 * that follows it are one step of the single-threaded object.
 */
import { DEFAULT_PLAN, FREE_USAGE, isPlan, type Plan, type Unit, type Usage } from "./plan.ts";
import { monthOf } from "./month.ts";

export const BILLING_TABLES = ["billing_plan", "billing_usage"] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS billing_plan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    plan TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS billing_usage (
    month_start INTEGER NOT NULL,
    unit TEXT NOT NULL,
    amount REAL NOT NULL,
    PRIMARY KEY (month_start, unit)
  )`,
];

/** Free usage of requests and tool calls is used up: plain data, as it crosses the RPC boundary. */
export interface PlanLimit {
  readonly unit: Unit;
  /** What the month allows free, and what the org used of it. */
  readonly allowed: number;
  readonly used: number;
  /** When the month ends and the counter starts over (epoch ms), and the seconds until then, at least 1. */
  readonly resetsAt: number;
  readonly retryAfterSeconds: number;
}

/** What a request that starts being served is told: counted (against `monthStart`), or refused by a plan limit. */
export type Admission =
  | { readonly ok: true; readonly monthStart: number }
  | { readonly ok: false; readonly limit: PlanLimit };

/** An org's plan and what it used in the month containing a time. */
export interface BillingUsage {
  readonly plan: Plan;
  /** The month, epoch ms: its start and the start of the next. */
  readonly monthStart: number;
  readonly monthEnd: number;
  readonly used: Usage;
}

export class BillingStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  plan(): Plan {
    const row = this.#sql
      .exec<{ plan: string }>("SELECT plan FROM billing_plan WHERE id = 1")
      .toArray()[0];

    return row !== undefined && isPlan(row.plan) ? row.plan : DEFAULT_PLAN;
  }

  setPlan(plan: Plan): void {
    this.#sql.exec(
      `INSERT INTO billing_plan (id, plan) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET plan = excluded.plan`,
      plan,
    );
  }

  /** What the org used in the month starting at `monthStart`; units never counted read 0. */
  used(monthStart: number): Usage {
    const rows = this.#sql
      .exec<{ unit: string; amount: number }>(
        "SELECT unit, amount FROM billing_usage WHERE month_start = ?",
        monthStart,
      )
      .toArray();

    const amount = (unit: Unit): number => rows.find((row) => row.unit === unit)?.amount ?? 0;

    return {
      requests: amount("requests"),
      browserHours: amount("browserHours"),
      computerHours: amount("computerHours"),
    };
  }

  usage(now: number): BillingUsage {
    const month = monthOf(now);

    return {
      plan: this.plan(),
      monthStart: month.start,
      monthEnd: month.end,
      used: this.used(month.start),
    };
  }

  /**
   * A request starts being served at `now`: on Free with the month's requests and tool calls used up it is refused
   * (and not counted); otherwise it is counted, on either plan (free usage is on both; Pay as you go bills above it).
   */
  admit(now: number): Admission {
    const month = monthOf(now);
    const used = this.used(month.start).requests;

    if (this.plan() === "free" && used >= FREE_USAGE.requests)
      return {
        ok: false,
        limit: {
          unit: "requests",
          allowed: FREE_USAGE.requests,
          used,
          resetsAt: month.end,
          retryAfterSeconds: Math.max(1, Math.ceil((month.end - now) / 1000)),
        },
      };

    this.#add(month.start, "requests", 1);

    return { ok: true, monthStart: month.start };
  }

  /** Takes back a request `admit` counted against `monthStart` (one that a spend limit refused after all). */
  refund(monthStart: number): void {
    this.#add(monthStart, "requests", -1);
  }

  #add(monthStart: number, unit: Unit, amount: number): void {
    this.#sql.exec(
      `INSERT INTO billing_usage (month_start, unit, amount) VALUES (?, ?, MAX(0, ?))
       ON CONFLICT (month_start, unit) DO UPDATE SET amount = MAX(0, amount + ?)`,
      monthStart,
      unit,
      amount,
      amount,
    );
  }

  /** Drops the tables: the org was deleted. */
  drop(): void {
    for (const table of BILLING_TABLES) this.#sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

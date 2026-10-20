/**
 * An org's plan and free-usage counters inside its ControlPlane Durable Object (SQLite). New in the Workers port, no
 * Go counterpart; the counters follow how Spend limits keep theirs (`packages/state/src/spend/store.ts`), not D1
 * usage records.
 *
 * - **billing_plan**: one row with the org's plan; no row means the default (`free`), so an org that existed before
 *   plans needs no backfill.
 * - **billing_usage**: what the org used of each unit in a calendar month (the month's start, epoch ms, and the unit).
 *   A row is created by the first use in a month, so an org that used nothing stores nothing and a new month starts at
 *   zero by itself.
 * - **billing_account** (#237): one row with what Polar knows the org by: its customer, its current subscription, the
 *   last one that ended, the payment state and when Polar last changed the subscription (its `modified_at`, epoch
 *   ms), so a webhook delivered late or twice changes nothing ({@link BillingStore.applySubscription}). No row: no
 *   customer, `ok`.
 * - **billing_meter_sent** (#237): what was sent to Polar of each unit and month, above free usage; the next batch
 *   sends only what usage above free usage grew by since.
 * - **billing_meter_batch** (#237): the one batch on its way to Polar, if any: until Polar took it, every attempt sends
 *   the same events with the same ids, so a retried batch is not counted twice.
 *
 * Every table is created `IF NOT EXISTS` in the constructor. All methods are synchronous, so a check and the count
 * that follows it are one step of the single-threaded object.
 */
import {
  DEFAULT_PLAN,
  FREE_USAGE,
  isPlan,
  isUnit,
  type PaymentState,
  type Plan,
  type Unit,
  type Usage,
} from "./plan.ts";
import { monthOf } from "./month.ts";

export const BILLING_TABLES = [
  "billing_plan",
  "billing_usage",
  "billing_account",
  "billing_meter_sent",
  "billing_meter_batch",
] as const;

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
  `CREATE TABLE IF NOT EXISTS billing_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    customer_id TEXT,
    subscription_id TEXT,
    ended_subscription_id TEXT,
    payment TEXT NOT NULL,
    changed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS billing_meter_sent (
    month_start INTEGER NOT NULL,
    unit TEXT NOT NULL,
    amount REAL NOT NULL,
    PRIMARY KEY (month_start, unit)
  )`,
  `CREATE TABLE IF NOT EXISTS billing_meter_batch (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    batch_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    events TEXT NOT NULL
  )`,
];

/** Below this, an amount of hours left to send is rounding, not usage. */
const SEND_EPSILON = 1e-9;

/** Free usage of requests and tool calls is used up: plain data, as it crosses the RPC boundary. */
export interface PlanLimit {
  /** What the month allows free. */
  readonly allowed: number;
  /** When the month ends and the counter starts over (epoch ms), and the seconds until then, at least 1. */
  readonly resetsAt: number;
  readonly retryAfterSeconds: number;
  /** The org is on Pay as you go, held to Free's limits until a payment succeeds. */
  readonly pastDue: boolean;
}

/** What a request that starts being served is told: counted (against `monthStart`), or refused by a plan limit. */
export type Admission =
  | { readonly ok: true; readonly monthStart: number }
  | { readonly ok: false; readonly limit: PlanLimit };

/** An org's plan and what it used in the month containing a time. */
export interface BillingUsage {
  readonly plan: Plan;
  /** `past_due` while Polar waits for a payment: the org is held to Free's limits. */
  readonly payment: PaymentState;
  /** The org's Polar customer, once an owner started a checkout. */
  readonly customerId: string | null;
  /** Its current subscription, while it has one. */
  readonly subscriptionId: string | null;
  /** The month, epoch ms: its start and the start of the next. */
  readonly monthStart: number;
  readonly monthEnd: number;
  readonly used: Usage;
}

/**
 * What Polar reports of the org's subscription (provider-neutral: `packages/billing/src/provider.ts` turns a webhook
 * into it). `ended`: cancelled or revoked. `changedAt` is when Polar last changed it (epoch ms).
 */
export interface SubscriptionChange {
  readonly status: "active" | "past_due" | "ended";
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly changedAt: number;
}

/** One meter event: what usage of `unit` in the month starting at `monthStart` grew by above free usage. */
export interface MeterEvent {
  readonly unit: Unit;
  readonly monthStart: number;
  readonly amount: number;
  /** Unique per batch, month and unit, so Polar ignores the event when it is sent again. */
  readonly externalId: string;
}

/** The usage an org has not sent to Polar yet, for its customer. */
export interface MeterBatch {
  readonly id: string;
  readonly customerId: string;
  readonly events: ReadonlyArray<MeterEvent>;
}

interface Account {
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  /** The last subscription that ended for the org: a change about it other than becoming active again is ignored. */
  readonly endedSubscriptionId: string | null;
  readonly payment: PaymentState;
  readonly changedAt: number;
}

const NO_ACCOUNT: Account = {
  customerId: null,
  subscriptionId: null,
  endedSubscriptionId: null,
  payment: "ok",
  changedAt: 0,
};

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

  /** The plan whose limits apply: Free's while a Pay-as-you-go org is past due. */
  limitsPlan(): Plan {
    const plan = this.plan();

    return plan === "payg" && this.#account().payment === "past_due" ? "free" : plan;
  }

  usage(now: number): BillingUsage {
    const month = monthOf(now);
    const account = this.#account();

    return {
      plan: this.plan(),
      payment: account.payment,
      customerId: account.customerId,
      subscriptionId: account.subscriptionId,
      monthStart: month.start,
      monthEnd: month.end,
      used: this.used(month.start),
    };
  }

  /**
   * A request starts being served at `now`: on Free (or on Pay as you go while past due) with the month's requests and
   * tool calls used up it is refused (and not counted); otherwise it is counted, on either plan (free usage is on both;
   * Pay as you go bills above it).
   */
  admit(now: number): Admission {
    const month = monthOf(now);
    const used = this.used(month.start).requests;

    if (this.limitsPlan() === "free" && used >= FREE_USAGE.requests)
      return {
        ok: false,
        limit: {
          allowed: FREE_USAGE.requests,
          resetsAt: month.end,
          retryAfterSeconds: Math.max(1, Math.ceil((month.end - now) / 1000)),
          pastDue: this.plan() === "payg",
        },
      };

    this.#add(month.start, "requests", 1);

    return { ok: true, monthStart: month.start };
  }

  /** Takes back a request `admit` counted against `monthStart` (one that did no work). */
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

  /** Records the org's Polar customer (its first checkout). */
  setCustomer(customerId: string): void {
    this.#saveAccount({ ...this.#account(), customerId });
  }

  /**
   * Applies what Polar reports of the org's subscription: `active` puts the org on Pay as you go with payments `ok`,
   * `past_due` keeps it there flagged (held to Free's limits), `ended` moves it to Free (as {@link endSubscription}
   * does). A change older than the last one applied, or about a subscription other than the org's current one (except
   * one that becomes active), is ignored, so webhooks delivered late or twice change nothing. So is any change but
   * becoming active again about the subscription that ended last: one cancelled at the end of its period still reports
   * its last invoice (`past_due` when it is not paid) after the org went to Free. Answers whether anything changed.
   */
  applySubscription(change: SubscriptionChange): boolean {
    const account = this.#account();

    if (change.changedAt < account.changedAt) return false;

    if (change.status !== "active" && change.subscriptionId === account.endedSubscriptionId)
      return false;

    const current = account.subscriptionId;

    if (change.status !== "active" && current !== null && change.subscriptionId !== current)
      return false;

    if (change.status === "ended" && current === null) return false;

    const ended = change.status === "ended";
    const plan: Plan = ended ? "free" : "payg";

    const next: Account = {
      customerId: account.customerId ?? change.customerId,
      subscriptionId: ended ? null : change.subscriptionId,
      endedSubscriptionId: ended
        ? change.subscriptionId
        : change.subscriptionId === account.endedSubscriptionId
          ? null
          : account.endedSubscriptionId,
      payment: change.status === "past_due" ? "past_due" : "ok",
      changedAt: change.changedAt,
    };

    const before = this.plan();

    const changed =
      plan !== before ||
      next.customerId !== account.customerId ||
      next.subscriptionId !== account.subscriptionId ||
      next.payment !== account.payment;

    this.#saveAccount(next);
    this.setPlan(plan);

    if (ended) this.#closeUsage();
    // Back on Pay as you go: what was used on Free is not billed.
    else if (before !== "payg") this.#writeOffUnsent();

    return changed;
  }

  /**
   * The org leaves Pay as you go at `now` (an owner switched to Free, or the org is being deleted, both after sending
   * its usage): it is on Free at once, and whatever Polar reports about the subscription from before is ignored.
   * Answers the subscription to cancel, `null` when there was none.
   */
  endSubscription(now: number): string | null {
    const account = this.#account();

    this.#saveAccount({
      ...account,
      subscriptionId: null,
      endedSubscriptionId: account.subscriptionId ?? account.endedSubscriptionId,
      payment: "ok",
      changedAt: Math.max(account.changedAt, now),
    });
    this.setPlan("free");
    this.#closeUsage();

    return account.subscriptionId;
  }

  /**
   * The org left Pay as you go: what it owes until now, above free usage and not sent (none after a switch to Free,
   * which sends it first), becomes the batch on its way, which still goes (`meterBatch` answers it on any plan); when a
   * batch is on its way already, that one goes and what came after it is not billed. Either way nothing used until now
   * is billed to a later subscription.
   */
  #closeUsage(): void {
    if (this.meterBatchPending() === null) this.#newBatch(undefined);
    this.#writeOffUnsent();
  }

  /** The usage above free usage not sent yet, nor on its way, counts as sent: it is never billed. */
  #writeOffUnsent(): void {
    const pending = this.meterBatchPending()?.events ?? [];

    const rows = this.#sql
      .exec<{ month_start: number; unit: string; used: number }>(
        "SELECT month_start, unit, amount AS used FROM billing_usage",
      )
      .toArray();

    for (const row of rows) {
      if (!isUnit(row.unit)) continue;

      const onItsWay = pending
        .filter((event) => event.monthStart === row.month_start && event.unit === row.unit)
        .reduce((sum, event) => sum + event.amount, 0);

      const sent = Math.max(0, Math.max(0, row.used - FREE_USAGE[row.unit]) - onItsWay);

      this.#sql.exec(
        `INSERT INTO billing_meter_sent (month_start, unit, amount) VALUES (?, ?, ?)
         ON CONFLICT (month_start, unit) DO UPDATE SET amount = MAX(amount, excluded.amount)`,
        row.month_start,
        row.unit,
        sent,
      );
    }
  }

  /**
   * The usage to send to Polar: the batch on its way if there is one (the same events, ids included; on any plan, so
   * the last batch of an org that left Pay as you go still goes), else a new one with what usage above free usage grew
   * by, per month and unit, since it was last sent; `null` when the org is not on Pay as you go, has no Polar customer
   * or has nothing to send. Only usage above free usage is ever sent, so Polar bills exactly that.
   */
  meterBatch(now: number): MeterBatch | null {
    const pending = this.meterBatchPending();

    if (pending !== null) return pending;

    if (this.plan() !== "payg") return null;

    return this.#newBatch(monthOf(now).end);
  }

  /**
   * A new batch, stored as the one on its way, of what usage above free usage grew by in the months starting before
   * `until` (epoch ms; `undefined`: every month) since it was last sent; `null` without a customer or anything to send.
   */
  #newBatch(until: number | undefined): MeterBatch | null {
    const { customerId } = this.#account();

    if (customerId === null) return null;
    const id = crypto.randomUUID();

    const rows = this.#sql
      .exec<{ month_start: number; unit: string; used: number; sent: number | null }>(
        `SELECT u.month_start, u.unit, u.amount AS used, s.amount AS sent
         FROM billing_usage u LEFT JOIN billing_meter_sent s
           ON s.month_start = u.month_start AND s.unit = u.unit
         WHERE u.month_start < ? ORDER BY u.month_start, u.unit`,
        until ?? Number.MAX_SAFE_INTEGER,
      )
      .toArray();

    const events: Array<MeterEvent> = [];

    for (const row of rows) {
      if (!isUnit(row.unit)) continue;
      const unsent = Math.max(0, row.used - FREE_USAGE[row.unit]) - (row.sent ?? 0);

      if (unsent > SEND_EPSILON)
        events.push({
          unit: row.unit,
          monthStart: row.month_start,
          amount: unsent,
          externalId: `${id}:${row.month_start}:${row.unit}`,
        });
    }

    if (events.length === 0) return null;

    this.#sql.exec(
      "INSERT INTO billing_meter_batch (id, batch_id, customer_id, events) VALUES (1, ?, ?, ?)",
      id,
      customerId,
      JSON.stringify(events),
    );

    return { id, customerId, events };
  }

  /** Polar took the batch `id`: what it carried counts as sent. Any other id changes nothing. */
  meterBatchSent(id: string): void {
    const pending = this.meterBatchPending();

    if (pending === null || pending.id !== id) return;

    for (const event of pending.events)
      this.#sql.exec(
        `INSERT INTO billing_meter_sent (month_start, unit, amount) VALUES (?, ?, ?)
         ON CONFLICT (month_start, unit) DO UPDATE SET amount = amount + excluded.amount`,
        event.monthStart,
        event.unit,
        event.amount,
      );

    this.#sql.exec("DELETE FROM billing_meter_batch WHERE id = 1");
  }

  /** The batch on its way to Polar, if any. */
  meterBatchPending(): MeterBatch | null {
    const pending = this.#sql
      .exec<{ batch_id: string; customer_id: string; events: string }>(
        "SELECT batch_id, customer_id, events FROM billing_meter_batch WHERE id = 1",
      )
      .toArray()[0];

    return pending === undefined
      ? null
      : {
          id: pending.batch_id,
          customerId: pending.customer_id,
          // SAFETY: written by `meterBatch` from MeterEvent values only.
          events: JSON.parse(pending.events) as ReadonlyArray<MeterEvent>,
        };
  }

  #account(): Account {
    const row = this.#sql
      .exec<{
        customer_id: string | null;
        subscription_id: string | null;
        ended_subscription_id: string | null;
        payment: string;
        changed_at: number;
      }>(
        `SELECT customer_id, subscription_id, ended_subscription_id, payment, changed_at
         FROM billing_account WHERE id = 1`,
      )
      .toArray()[0];

    if (row === undefined) return NO_ACCOUNT;

    return {
      customerId: row.customer_id,
      subscriptionId: row.subscription_id,
      endedSubscriptionId: row.ended_subscription_id,
      payment: row.payment === "past_due" ? "past_due" : "ok",
      changedAt: row.changed_at,
    };
  }

  #saveAccount(account: Account): void {
    this.#sql.exec(
      `INSERT INTO billing_account (id, customer_id, subscription_id, ended_subscription_id, payment, changed_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET customer_id = excluded.customer_id,
         subscription_id = excluded.subscription_id, ended_subscription_id = excluded.ended_subscription_id,
         payment = excluded.payment, changed_at = excluded.changed_at`,
      account.customerId,
      account.subscriptionId,
      account.endedSubscriptionId,
      account.payment,
      account.changedAt,
    );
  }

  /** Drops the tables: the org was deleted. */
  drop(): void {
    for (const table of BILLING_TABLES) this.#sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

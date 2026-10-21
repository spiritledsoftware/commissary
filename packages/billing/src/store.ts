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
 * - **billing_cap** (#238): one row with the billing cap its org owners set, in dollars a month, `NULL` for none; no
 *   row means the default ($50, `bill.ts`).
 * - **billing_overrides** (#240): one row with what a platform admin set for the org: whether it is unbilled (on Pay as
 *   you go with nothing sent to Polar, whatever its subscription) and the ceilings raised above its plan's (`null`: the
 *   plan's). No row: billed, the plan's ceilings.
 *
 * Every table is created `IF NOT EXISTS` in the constructor. All methods are synchronous, so a check and the count
 * that follows it are one step of the single-threaded object.
 */
import {
  type Ceiling,
  type CeilingKind,
  type Ceilings,
  DEFAULT_PLAN,
  FREE_USAGE,
  isPlan,
  isUnit,
  type PaymentState,
  type Plan,
  type PlanLimitKind,
  PLAN_CEILINGS,
  type RaisedCeilings,
  RATE_LIMIT_PERIOD_SECONDS,
  type Unit,
  UNIT_LIMIT,
  type Usage,
} from "./plan.ts";
import { billMicros, capRefuses, DEFAULT_BILLING_CAP, toDollars } from "./bill.ts";
import { monthOf } from "./month.ts";

export const BILLING_TABLES = [
  "billing_plan",
  "billing_usage",
  "billing_account",
  "billing_meter_sent",
  "billing_meter_batch",
  "billing_cap",
  "billing_overrides",
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
  `CREATE TABLE IF NOT EXISTS billing_cap (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cap REAL
  )`,
  `CREATE TABLE IF NOT EXISTS billing_overrides (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    unbilled INTEGER NOT NULL,
    browser_sessions INTEGER,
    computers INTEGER,
    request_rate INTEGER
  )`,
];

/** Below this, an amount of hours left to send is rounding, not usage. */
const SEND_EPSILON = 1e-9;

/**
 * A plan limit refuses use: free usage of requests and tool calls is used up (`requests`, on Free or while past due),
 * or the month's bill is at the billing cap (`billing_cap`, on Pay as you go). Plain data, as it crosses the RPC
 * boundary.
 */
export interface PlanLimit {
  readonly kind: "limit";
  readonly limit: PlanLimitKind;
  /** What the month allows: its free usage of requests and tool calls, or the billing cap in dollars. */
  readonly allowed: number;
  /** When the month ends and the counter starts over (epoch ms), and the seconds until then, at least 1. */
  readonly resetsAt: number;
  readonly retryAfterSeconds: number;
  /** The org is on Pay as you go, held to Free's limits until a payment succeeds. */
  readonly pastDue: boolean;
}

/**
 * A ceiling for fairness between orgs refuses opening one more browser session or computer (ADR 0042, #241): the org
 * has as many open as its ceiling allows. Plain data, as it crosses the RPC boundary; it names no month, as a ceiling
 * does not start over.
 */
export interface CeilingLimit {
  readonly kind: "ceiling";
  readonly limit: CeilingKind;
  /** The ceiling: how many the org may have open at once (0: none). */
  readonly allowed: number;
  /** The org is on Pay as you go, held to Free's limits until a payment succeeds. */
  readonly pastDue: boolean;
}

/** Why use of a unit, or opening a browser session or a computer, is refused. */
export type PlanRefusal = PlanLimit | CeilingLimit;

/** The time units a plan counts as they run, in hours, from milliseconds. */
const MS_PER_HOUR = 3_600_000;

/** What a request that starts being served is told: counted (against `monthStart`), or refused by a plan limit. */
export type Admission =
  | { readonly ok: true; readonly monthStart: number }
  | { readonly ok: false; readonly limit: PlanLimit };

/** An org's plan and what it used in the month containing a time. */
export interface BillingUsage {
  /** The plan the org is on: Pay as you go while it is unbilled. */
  readonly plan: Plan;
  /** A platform admin marked the org unbilled: Pay as you go with no card and no invoice (#240). */
  readonly unbilled: boolean;
  /** The plan whose limits apply, and so whose ceilings: Free's while a Pay-as-you-go org is past due. */
  readonly limitsPlan: Plan;
  /** The ceilings a platform admin raised for the org; `null`: the plan's. */
  readonly raised: RaisedCeilings;
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
  /** What the month's usage bills above free usage so far, in dollars (what Pay as you go is invoiced). */
  readonly bill: number;
  /** The most Pay as you go may bill the org a month, in dollars; `null`: no cap. */
  readonly billingCap: number | null;
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

/** What a platform admin set for the org (#240). */
interface Overrides {
  readonly unbilled: boolean;
  readonly raised: RaisedCeilings;
}

const NO_OVERRIDES: Overrides = {
  unbilled: false,
  raised: { browserSessions: null, computers: null, requestRate: null },
};

/**
 * The request-rate ceiling that applies to an org: its plan's (`plan`, the plan whose limits apply), counted by that
 * plan's rate-limit binding, or one a platform admin raised above it (`raised`), counted by the org's Billing part
 * ({@link BillingStore.admitRate}).
 */
export interface RateCeiling {
  readonly plan: Plan;
  readonly raised: number | null;
}

const RATE_WINDOW_MS = RATE_LIMIT_PERIOD_SECONDS * 1000;

export class BillingStore {
  readonly #sql: SqlStorage;

  /**
   * The requests counted against a raised request rate in the current window (the minute starting at `start`, epoch
   * ms). Kept in memory, not in storage: a ceiling for fairness, like the rate-limit bindings, not exact accounting;
   * an object that restarts starts the minute over.
   */
  #rate = { start: 0, count: 0 };

  constructor(sql: SqlStorage) {
    this.#sql = sql;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  /** The plan the org is on: Pay as you go while it is unbilled, else the one Polar or its owners chose. */
  plan(): Plan {
    return this.unbilled() ? "payg" : this.#subscribedPlan();
  }

  /**
   * Whether a platform admin marked the org unbilled (#240): it is on Pay as you go and is never billed, so the billing
   * cap ({@link admit}) and the billing notices (`notices.ts`) skip it.
   */
  unbilled(): boolean {
    return this.#overrides().unbilled;
  }

  /** The plan Polar's subscription or the org's owners put it on, whether or not it is unbilled. */
  #subscribedPlan(): Plan {
    const row = this.#sql
      .exec<{ plan: string }>("SELECT plan FROM billing_plan WHERE id = 1")
      .toArray()[0];

    return row !== undefined && isPlan(row.plan) ? row.plan : DEFAULT_PLAN;
  }

  /**
   * Marks the org unbilled or not (#240, ADR 0042 "Unbilled orgs"). Unbilled, it is on Pay as you go and nothing it
   * uses is sent to Polar: what it owed until then on a subscription becomes the batch on its way (as when it leaves
   * Pay as you go), and what it uses meanwhile is never billed. Unmarked, it is back on the plan its subscription gives
   * it (Free without one), and what it used while unbilled is not billed either. Marking it as it is changes nothing.
   */
  setUnbilled(unbilled: boolean): void {
    const overrides = this.#overrides();

    if (overrides.unbilled === unbilled) return;

    if (unbilled && this.#subscribedPlan() === "payg") this.#closeUsage();
    else this.#writeOffUnsent();

    this.#saveOverrides({ ...overrides, unbilled });
  }

  /** Raises the given ceilings for the org (`null`: back to the plan's); the others stay as they are. */
  raiseCeilings(raised: Partial<RaisedCeilings>): void {
    const overrides = this.#overrides();

    this.#saveOverrides({ ...overrides, raised: { ...overrides.raised, ...raised } });
  }

  /**
   * The ceilings that apply to the org: those of the plan whose limits apply ({@link limitsPlan}), each raised to what
   * a platform admin set when that is higher (a raise never lowers a ceiling).
   */
  ceilings(): Ceilings {
    const plan = PLAN_CEILINGS[this.limitsPlan()];
    const { raised } = this.#overrides();

    const ceiling = (name: Ceiling): number => Math.max(plan[name], raised[name] ?? 0);

    return {
      browserSessions: ceiling("browserSessions"),
      computers: ceiling("computers"),
      requestRate: ceiling("requestRate"),
    };
  }

  /** The org's request-rate ceiling: its plan's, or the raised one when a platform admin set one above it. */
  rateCeiling(): RateCeiling {
    const plan = this.limitsPlan();
    const rate = this.ceilings().requestRate;

    return { plan, raised: rate > PLAN_CEILINGS[plan].requestRate ? rate : null };
  }

  /**
   * Counts a request at `now` against the org's request-rate ceiling, in fixed one-minute windows; answers whether it
   * is within it. The Worker asks only for an org whose ceiling was raised ({@link rateCeiling}); the others are
   * counted by their plan's rate-limit binding. Only a later minute starts a new window: a request whose `now` is
   * earlier (another isolate's clock behind) counts in the current one, so it cannot reset the count.
   */
  admitRate(now: number): boolean {
    const start = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;

    if (start > this.#rate.start) this.#rate = { start, count: 0 };

    if (this.#rate.count >= this.ceilings().requestRate) return false;

    this.#rate.count += 1;

    return true;
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
    if (this.unbilled()) return "payg";

    const plan = this.#subscribedPlan();

    return plan === "payg" && this.#account().payment === "past_due" ? "free" : plan;
  }

  /** The billing cap in dollars a month, `null` for none: $50 until an org owner sets it. */
  billingCap(): number | null {
    const row = this.#sql
      .exec<{ cap: number | null }>("SELECT cap FROM billing_cap WHERE id = 1")
      .toArray()[0];

    return row === undefined ? DEFAULT_BILLING_CAP : row.cap;
  }

  setBillingCap(cap: number | null): void {
    this.#sql.exec(
      `INSERT INTO billing_cap (id, cap) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET cap = excluded.cap`,
      cap,
    );
  }

  usage(now: number): BillingUsage {
    const month = monthOf(now);
    const account = this.#account();
    const used = this.used(month.start);

    const overrides = this.#overrides();

    return {
      plan: overrides.unbilled ? "payg" : this.#subscribedPlan(),
      unbilled: overrides.unbilled,
      limitsPlan: this.limitsPlan(),
      raised: overrides.raised,
      payment: account.payment,
      customerId: account.customerId,
      subscriptionId: account.subscriptionId,
      monthStart: month.start,
      monthEnd: month.end,
      used,
      bill: toDollars(billMicros(used)),
      billingCap: this.billingCap(),
    };
  }

  /**
   * The plan limit that refuses the next use of `unit` at `now`, `undefined` when none does: on Free (or on Pay as you
   * go while past due) the unit's free usage used up, on Pay as you go use that would be billed (the unit's free usage
   * is used up) and would take the month's bill past the billing cap. Counts nothing.
   */
  limitOf(unit: Unit, now: number): PlanLimit | undefined {
    const month = monthOf(now);
    const used = this.used(month.start);
    const limitsPlan = this.limitsPlan();
    const retryAfterSeconds = Math.max(1, Math.ceil((month.end - now) / 1000));

    if (limitsPlan === "free" && used[unit] >= FREE_USAGE[unit])
      return {
        kind: "limit",
        limit: UNIT_LIMIT[unit],
        allowed: FREE_USAGE[unit],
        resetsAt: month.end,
        retryAfterSeconds,
        pastDue: this.plan() === "payg",
      };

    // An unbilled org is never billed, so no billing cap applies to it.
    const cap = limitsPlan === "payg" && !this.unbilled() ? this.billingCap() : null;

    if (cap !== null && capRefuses(used, cap, unit))
      return {
        kind: "limit",
        limit: "billing_cap",
        allowed: cap,
        resetsAt: month.end,
        retryAfterSeconds,
        pastDue: false,
      };

    return undefined;
  }

  /**
   * A request or tool call starts being served at `now`: on Free (or on Pay as you go while past due) with the month's
   * requests and tool calls used up it is refused (and not counted); otherwise it is counted, on either plan (free
   * usage is on both; Pay as you go bills above it). On Pay as you go a request that would be billed (free usage of
   * requests is used up) is refused when it would take the month's bill past the billing cap ({@link limitOf}).
   */
  admit(now: number): Admission {
    const limit = this.limitOf("requests", now);

    if (limit !== undefined) return { ok: false, limit };
    const month = monthOf(now);

    this.#add(month.start, "requests", 1);

    return { ok: true, monthStart: month.start };
  }

  /**
   * Counts `ms` of browser or computer time used up to `now` toward the month containing `now` (#241). Counted
   * whatever the limits say: the time was used, and a limit refuses only the use that comes after it.
   */
  addTime(unit: "browserHours" | "computerHours", ms: number, now: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;

    this.#add(monthOf(now).start, unit, ms / MS_PER_HOUR);
  }

  /**
   * Whether the org, with `open` browser sessions or computers open, may not open another: its ceiling (the plan's, or
   * the one a platform admin raised, {@link ceilings}) is reached. `undefined` when it may.
   */
  checkCeiling(kind: CeilingKind, open: number): CeilingLimit | undefined {
    const allowed = this.ceilings()[kind];

    return open >= allowed
      ? {
          kind: "ceiling",
          limit: kind,
          allowed,
          pastDue: this.plan() === "payg" && this.limitsPlan() === "free",
        }
      : undefined;
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

    const before = this.#subscribedPlan();

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
    // Unbilled: what it used meanwhile is never billed, now or after it is unmarked.
    if (this.unbilled()) {
      this.#writeOffUnsent();

      return null;
    }

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

  #overrides(): Overrides {
    const row = this.#sql
      .exec<{
        unbilled: number;
        browser_sessions: number | null;
        computers: number | null;
        request_rate: number | null;
      }>(
        "SELECT unbilled, browser_sessions, computers, request_rate FROM billing_overrides WHERE id = 1",
      )
      .toArray()[0];

    if (row === undefined) return NO_OVERRIDES;

    return {
      unbilled: row.unbilled === 1,
      raised: {
        browserSessions: row.browser_sessions,
        computers: row.computers,
        requestRate: row.request_rate,
      },
    };
  }

  #saveOverrides(overrides: Overrides): void {
    this.#sql.exec(
      `INSERT INTO billing_overrides (id, unbilled, browser_sessions, computers, request_rate)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET unbilled = excluded.unbilled,
         browser_sessions = excluded.browser_sessions, computers = excluded.computers,
         request_rate = excluded.request_rate`,
      overrides.unbilled ? 1 : 0,
      overrides.raised.browserSessions,
      overrides.raised.computers,
      overrides.raised.requestRate,
    );
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

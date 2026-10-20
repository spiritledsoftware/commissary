/**
 * An org's Spend limits and counters inside its ControlPlane Durable Object (SQLite; issue #71). New in the Workers
 * port, no Go counterpart.
 *
 * - **spend_limits**: one row per limit: its subject (kind and id; empty id for the org), period, amount in micro-USD,
 *   who wrote it (an org admin, or a member on their own API key), a revision and when/by whom it was last written. One
 *   limit per subject, period and source.
 * - **spend_counters**: the Cost spent so far per subject, period and period start. Only subjects with a limit have
 *   rows, and only the current period of each is kept, so an org without limits stores nothing.
 * - **spend_settings**: one row with the org's time zone and first day of the week; `UTC` and Monday until set.
 *
 * Every table is created `IF NOT EXISTS` in the constructor, so a Durable Object that predates Spend limits upgrades
 * in place, with no limits (nothing is limited). All methods are synchronous; refusals are plain data. Implements the
 * {@link SpendBook} the ledger reads and charges.
 */
import type { SpendBook } from "./ledger.ts";
import {
  type LimitSource,
  type SpendLimit,
  type SpendScope,
  type SpendSettings,
  SUBJECT_KINDS,
  type SubjectKind,
} from "./model.ts";
import {
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEK_START,
  isTimeZone,
  PERIODS,
  type Period,
  WEEK_STARTS,
  type WeekStart,
} from "./period.ts";

export type SpendErrorCode = "invalid" | "conflict" | "not_found" | "exceeds_admin_limit";

/** A refused write; `message` is fixed text, safe to show. */
export interface SpendRefused {
  readonly ok: false;
  readonly error: SpendErrorCode;
  readonly message: string;
}

export type SpendResult<A> = { readonly ok: true; readonly value: A } | SpendRefused;

export interface NewLimit {
  readonly kind: SubjectKind;
  readonly subject: string;
  readonly period: Period;
  readonly amountMicros: number;
  readonly source: LimitSource;
}

/** The biggest amount of a limit (about 9 billion USD): micro-USD stay exact integers. */
export const MAX_AMOUNT_MICROS = Number.MAX_SAFE_INTEGER;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spend_limits (
    id TEXT PRIMARY KEY,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    period TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    source TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    UNIQUE (subject_kind, subject_id, period, source)
  )`,
  `CREATE TABLE IF NOT EXISTS spend_counters (
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    period TEXT NOT NULL,
    period_start INTEGER NOT NULL,
    micros INTEGER NOT NULL,
    PRIMARY KEY (subject_kind, subject_id, period, period_start)
  )`,
  `CREATE TABLE IF NOT EXISTS spend_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    time_zone TEXT NOT NULL,
    week_start TEXT NOT NULL
  )`,
];

interface LimitRow {
  readonly [column: string]: SqlStorageValue;
  readonly id: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly period: string;
  readonly amount_micros: number;
  readonly source: string;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly updated_by: string;
}

const COLUMNS = `id, subject_kind, subject_id, period, amount_micros, source, revision, created_at, updated_at,
  updated_by`;

const refuse = (error: SpendErrorCode, message: string): SpendRefused => ({
  ok: false,
  error,
  message,
});

const isPeriod = (value: string): value is Period => PERIODS.some((period) => period === value);

const isWeekStart = (value: string): value is WeekStart => WEEK_STARTS.some((day) => day === value);

const KINDS: ReadonlySet<string> = new Set(SUBJECT_KINDS);

const isKind = (value: string): value is SubjectKind => KINDS.has(value);

const isSource = (value: string): value is LimitSource => value === "admin" || value === "member";

const limitOf = (row: LimitRow): SpendLimit | undefined =>
  isKind(row.subject_kind) && isPeriod(row.period) && isSource(row.source)
    ? {
        id: row.id,
        kind: row.subject_kind,
        subject: row.subject_id,
        period: row.period,
        amountMicros: row.amount_micros,
        source: row.source,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      }
    : undefined;

/** A new limit's id, `limit:<24 hex characters>`, as Models' config entries' ids are made. */
const freshLimitId = (): string => `limit:${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

const validAmount = (amount: number): boolean =>
  Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_AMOUNT_MICROS;

export class SpendStore implements SpendBook {
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  #cache: ReadonlyArray<SpendLimit> | undefined;
  #settings: SpendSettings | undefined;

  /** `now`: the clock of the writes' timestamps (epoch milliseconds). */
  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;

    for (const statement of SCHEMA) sql.exec(statement);

    sql.exec(
      `INSERT OR IGNORE INTO spend_settings (id, time_zone, week_start) VALUES (1, ?, ?)`,
      DEFAULT_TIME_ZONE,
      DEFAULT_WEEK_START,
    );
  }

  // --- settings -----------------------------------------------------------------------------------------------

  settings(): SpendSettings {
    if (this.#settings !== undefined) return this.#settings;

    const row = this.#sql
      .exec<{
        readonly time_zone: string;
        readonly week_start: string;
      }>(`SELECT time_zone, week_start FROM spend_settings WHERE id = 1`)
      .toArray()[0];

    this.#settings = {
      timeZone: row !== undefined && isTimeZone(row.time_zone) ? row.time_zone : DEFAULT_TIME_ZONE,
      weekStart:
        row !== undefined && isWeekStart(row.week_start) ? row.week_start : DEFAULT_WEEK_START,
    };

    return this.#settings;
  }

  /**
   * Sets the org's time zone and first day of the week. Periods that begin differently start new counters, so spend
   * counted under the old calendar no longer counts.
   */
  setSettings(settings: {
    readonly timeZone?: string | undefined;
    readonly weekStart?: string | undefined;
  }): SpendResult<SpendSettings> {
    const current = this.settings();
    const timeZone = settings.timeZone ?? current.timeZone;
    const weekStart = settings.weekStart ?? current.weekStart;

    if (!isTimeZone(timeZone))
      return refuse("invalid", "time_zone is not an IANA time zone name such as Europe/Berlin");

    if (!isWeekStart(weekStart))
      return refuse("invalid", `week_start is one of ${WEEK_STARTS.join(", ")}`);

    this.#sql.exec(
      `UPDATE spend_settings SET time_zone = ?, week_start = ? WHERE id = 1`,
      timeZone,
      weekStart,
    );

    // Counters belong to the periods of the calendar that wrote them: a new calendar starts them afresh. (Dropping only
    // earlier periods would keep a counter whose period now begins earlier, and bring it back if the calendar returned.)
    if (timeZone !== current.timeZone || weekStart !== current.weekStart)
      this.#sql.exec(`DELETE FROM spend_counters`);
    this.#settings = { timeZone, weekStart };

    return { ok: true, value: this.#settings };
  }

  // --- limits -------------------------------------------------------------------------------------------------

  /** Every limit, oldest first. */
  limits(): ReadonlyArray<SpendLimit> {
    if (this.#cache !== undefined) return this.#cache;

    this.#cache = this.#sql
      .exec<LimitRow>(`SELECT ${COLUMNS} FROM spend_limits ORDER BY created_at, id`)
      .toArray()
      .flatMap((row) => limitOf(row) ?? []);

    return this.#cache;
  }

  limit(id: string): SpendLimit | undefined {
    return this.limits().find((candidate) => candidate.id === id);
  }

  /**
   * Writes a limit. The caller checked that the subject exists and who may write it; the store keeps the amount valid, one
   * limit per subject, period and source, and a member's limit on an API key within the admin's on it.
   */
  create(input: NewLimit, by: string): SpendResult<SpendLimit> {
    if (!isKind(input.kind) || !isPeriod(input.period) || !isSource(input.source))
      return refuse("invalid", "the limit names an unknown subject kind, period or source");

    if (!validAmount(input.amountMicros))
      return refuse("invalid", "amount_micros is a whole number of micro-USD, 0 or more");

    if ((input.kind === "org") !== (input.subject === ""))
      return refuse("invalid", "the org limit has no subject; every other limit names one");

    if (
      this.limits().some(
        (limit) =>
          limit.kind === input.kind &&
          limit.subject === input.subject &&
          limit.period === input.period &&
          limit.source === input.source,
      )
    )
      return refuse("conflict", "that subject already has a limit for the period; edit it instead");

    const capped = this.#aboveAdmin(input);

    if (capped !== undefined) return capped;

    const now = this.#now();
    const id = freshLimitId();

    this.#sql.exec(
      `INSERT INTO spend_limits (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      input.kind,
      input.subject,
      input.period,
      input.amountMicros,
      input.source,
      now,
      now,
      by,
    );
    this.#cache = undefined;

    const created = this.limit(id);

    return created === undefined
      ? refuse("not_found", "the limit was not stored")
      : { ok: true, value: created };
  }

  /** Changes the amount of a limit written at `revision`; a stale revision is a `conflict`. */
  update(id: string, revision: number, amountMicros: number, by: string): SpendResult<SpendLimit> {
    const existing = this.limit(id);

    if (existing === undefined) return refuse("not_found", "limit not found");

    if (existing.revision !== revision)
      return refuse("conflict", `the limit is at revision ${existing.revision}, not ${revision}`);

    if (!validAmount(amountMicros))
      return refuse("invalid", "amount_micros is a whole number of micro-USD, 0 or more");

    const capped = this.#aboveAdmin({ ...existing, amountMicros });

    if (capped !== undefined) return capped;

    this.#sql.exec(
      `UPDATE spend_limits SET amount_micros = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      amountMicros,
      revision + 1,
      this.#now(),
      by,
      id,
    );
    this.#cache = undefined;

    const updated = this.limit(id);

    return updated === undefined
      ? refuse("not_found", "limit not found")
      : { ok: true, value: updated };
  }

  /** Deletes a limit written at `revision`; the counters of its subject and period go with the last limit on them. */
  remove(id: string, revision: number): SpendResult<SpendLimit> {
    const existing = this.limit(id);

    if (existing === undefined) return refuse("not_found", "limit not found");

    if (existing.revision !== revision)
      return refuse("conflict", `the limit is at revision ${existing.revision}, not ${revision}`);

    this.#sql.exec(`DELETE FROM spend_limits WHERE id = ?`, id);
    this.#cache = undefined;

    const left = this.limits().some(
      (limit) =>
        limit.kind === existing.kind &&
        limit.subject === existing.subject &&
        limit.period === existing.period,
    );

    if (!left)
      this.#sql.exec(
        `DELETE FROM spend_counters WHERE subject_kind = ? AND subject_id = ? AND period = ?`,
        existing.kind,
        existing.subject,
        existing.period,
      );

    return { ok: true, value: existing };
  }

  /** Drops the limits and counters of a subject that is gone (a removed member, team, credential or API key). */
  forget(kind: SubjectKind, subject: string): void {
    this.#sql.exec(
      `DELETE FROM spend_limits WHERE subject_kind = ? AND subject_id = ?`,
      kind,
      subject,
    );
    this.#sql.exec(
      `DELETE FROM spend_counters WHERE subject_kind = ? AND subject_id = ?`,
      kind,
      subject,
    );
    this.#cache = undefined;
  }

  // --- counters -----------------------------------------------------------------------------------------------

  spent(scope: SpendScope, period: Period, periodStart: number): number {
    return (
      this.#sql
        .exec<{ readonly micros: number }>(
          `SELECT micros FROM spend_counters
           WHERE subject_kind = ? AND subject_id = ? AND period = ? AND period_start = ?`,
          scope.kind,
          scope.subject,
          period,
          periodStart,
        )
        .toArray()[0]?.micros ?? 0
    );
  }

  charge(scope: SpendScope, period: Period, periodStart: number, micros: number): void {
    this.#sql.exec(
      `INSERT INTO spend_counters (subject_kind, subject_id, period, period_start, micros)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (subject_kind, subject_id, period, period_start)
       DO UPDATE SET micros = micros + excluded.micros`,
      scope.kind,
      scope.subject,
      period,
      periodStart,
      micros,
    );
    // Only the current period is ever read.
    this.#sql.exec(
      `DELETE FROM spend_counters
       WHERE subject_kind = ? AND subject_id = ? AND period = ? AND period_start < ?`,
      scope.kind,
      scope.subject,
      period,
      periodStart,
    );
  }

  /** A member's limit on an API key may not exceed the admin's limit on that key and period. */
  #aboveAdmin(
    input: Pick<NewLimit, "kind" | "subject" | "period" | "amountMicros" | "source">,
  ): SpendRefused | undefined {
    if (input.source !== "member" || input.kind !== "key") return undefined;

    const admin = this.limits().find(
      (limit) =>
        limit.kind === "key" &&
        limit.subject === input.subject &&
        limit.period === input.period &&
        limit.source === "admin",
    );

    return admin !== undefined && input.amountMicros > admin.amountMicros
      ? refuse(
          "exceeds_admin_limit",
          `an org admin limited this API key to ${admin.amountMicros} micro-USD a ${input.period}`,
        )
      : undefined;
  }
}

/**
 * The org's open sandbox sessions, as the Tools part keeps them (#222): the `sandbox_sessions` table, one of the part's
 * tables (`TOOLS_TABLES`), keyed by `toolkit_id` like the others. A row holds a session's id, the toolkit it was opened
 * through, its owner (the member, and the principal it belongs to), when it opened and when it was last used, so that a
 * member's leaving and the org's deletion reach every session still open (ADR 0027).
 *
 * The provider ends a session itself after {@link SESSION_IDLE_MS} without a call; every call goes through the Tools
 * part, which marks the row used, so the part knows when that is. The session then reports its close with the computer
 * time no call charged (#224, `ToolsPart.sandboxComputerTime`), which charges it to the opener's Spend limits as the
 * row names them and forgets the row; a row whose close was never heard of is forgotten {@link CLOSE_REPORT_MS} after
 * that ({@link SandboxSessionStore.prune}, from the part's alarm). A session closed with `sandbox_close` goes at once:
 * the call that closed it charged its last stretch.
 */
import { CLOSE_REPORT_MS, SESSION_IDLE_MS } from "./provider.ts";

/**
 * The principal ids of hosted agents' runs (`run:<id>`), which Commissary no longer has (ADR 0048), as a `LIKE`
 * pattern. A run's own session waited for its run to be deleted, so no day closes it in the sandbox: the Tools part
 * deletes it at the provider once it went a day unused ({@link SandboxSessionStore.runSessionsDue}).
 */
export const RUN_PRINCIPALS = "run:%";

/** The rows of every other session, which the provider closes itself after a day without use. */
const NOT_RUN = `principal NOT LIKE '${RUN_PRINCIPALS}'`;

/** The first wait before a failed deletion of a retired run's session at the provider is tried again; it doubles. */
export const PURGE_RETRY_MS = 60_000;

/** One open sandbox session. */
export interface TrackedSession {
  readonly id: string;
  readonly toolkitId: string;
  /** The member who opened it, if the caller was one. */
  readonly member: string | undefined;
  /** The principal it belongs to (`user:<email>`, `key:<id>`). */
  readonly principal: string;
  readonly openedAt: number;
  readonly lastUsed: number;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  id: string;
  toolkit_id: string;
  member: string;
  principal: string;
  opened_at: number;
  last_used: number;
}

/**
 * How long after its last use the part forgets a session whose close it did not hear of: its idle day, and the time
 * its provider may take to report the close (#224).
 */
const FORGOTTEN_AFTER_MS = SESSION_IDLE_MS + CLOSE_REPORT_MS;

const SCHEMA = `CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id TEXT PRIMARY KEY, toolkit_id TEXT NOT NULL, member TEXT NOT NULL, principal TEXT NOT NULL,
  opened_at INTEGER NOT NULL, last_used INTEGER NOT NULL
)`;

const sessionOf = (row: SessionRow): TrackedSession => ({
  id: row.id,
  toolkitId: row.toolkit_id,
  member: row.member === "" ? undefined : row.member,
  principal: row.principal,
  openedAt: row.opened_at,
  lastUsed: row.last_used,
});

export class SandboxSessionStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(SCHEMA);

    const columns = sql
      .exec<{ name: string }>("PRAGMA table_info(sandbox_sessions)")
      .toArray()
      .map((column) => column.name);

    // Which hosted agent opened a session, which Commissary no longer has (ADR 0048): dropped once.
    if (columns.includes("agent")) sql.exec(`ALTER TABLE sandbox_sessions DROP COLUMN agent`);

    // When a session's computer stops unless a command uses it again (#241): a log from before has no column for it.
    if (!columns.includes("computer_until"))
      sql.exec(`ALTER TABLE sandbox_sessions ADD COLUMN computer_until INTEGER`);

    // When a failed deletion of a retired run's session at the provider is tried again, and how often it failed.
    if (!columns.includes("purge_retry_at"))
      sql.exec(`ALTER TABLE sandbox_sessions ADD COLUMN purge_retry_at INTEGER`);

    if (!columns.includes("purge_failures"))
      sql.exec(`ALTER TABLE sandbox_sessions ADD COLUMN purge_failures INTEGER`);

    // Whether a session was opened with the computer (#241): a log from before has no column for it, and its sessions
    // may have one.
    if (!columns.includes("computer"))
      sql.exec(`ALTER TABLE sandbox_sessions ADD COLUMN computer INTEGER`);
  }

  /** Keeps a session just opened; `computer`: whether it was opened asking for the computer (#241). */
  opened(session: Omit<TrackedSession, "lastUsed">, computer = true): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO sandbox_sessions (id, toolkit_id, member, principal, opened_at, last_used, computer)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.toolkitId,
      session.member ?? "",
      session.principal,
      session.openedAt,
      session.openedAt,
      computer ? 1 : 0,
    );
  }

  /**
   * Whether the session `id` may have a computer (#241): the part keeps it, and it was not opened without one. A
   * session from before the column may; the ceiling on computers counts and holds no other.
   */
  mayHaveComputer(id: string): boolean {
    const row = this.#sql
      .exec<{ computer: number | null }>(`SELECT computer FROM sandbox_sessions WHERE id = ?`, id)
      .toArray()[0];

    return row !== undefined && row.computer !== 0;
  }

  /** The open session `id`, if the part keeps it. */
  session(id: string): TrackedSession | undefined {
    const row = this.#sql
      .exec<SessionRow>(`SELECT * FROM sandbox_sessions WHERE id = ?`, id)
      .toArray()[0];

    return row === undefined ? undefined : sessionOf(row);
  }

  /** Marks the session `id` used at `now`; `principal`'s only, when given (a call's: another's id is not its). */
  used(id: string, now: number, principal?: string): void {
    this.#sql.exec(
      `UPDATE sandbox_sessions SET last_used = ? WHERE id = ? AND (? IS NULL OR principal = ?)`,
      now,
      id,
      principal ?? null,
      principal ?? null,
    );
  }

  /** Forgets the sessions `ids`; `principal`'s only, when given (a call's: another's id is not its). */
  ended(ids: ReadonlyArray<string>, principal?: string): void {
    for (const id of ids)
      this.#sql.exec(
        `DELETE FROM sandbox_sessions WHERE id = ? AND (? IS NULL OR principal = ?)`,
        id,
        principal ?? null,
        principal ?? null,
      );
  }

  /**
   * Notes when the computer of the session `id` stops unless a command uses it again (`until`, epoch ms), as its object
   * answered with a call, or that it does not run (`undefined`): the org's concurrent computers are counted from it
   * ({@link computersRunning}, #241).
   */
  computerRunsUntil(id: string, until: number | undefined): void {
    this.#sql.exec(
      `UPDATE sandbox_sessions SET computer_until = ? WHERE id = ?`,
      until ?? null,
      id,
    );
  }

  /**
   * Notes that the computer of the session `id` stopped, as its object reported at `now`: unless a later answer says it
   * runs on past `now` (a command started it again before the report came).
   */
  computerStopped(id: string, now: number): void {
    this.#sql.exec(
      `UPDATE sandbox_sessions SET computer_until = NULL WHERE id = ? AND (computer_until IS NULL OR computer_until <= ?)`,
      id,
      now,
    );
  }

  /** Whether the computer of the session `id` runs at `now`, as its object last answered. */
  computerRuns(id: string, now: number): boolean {
    const row = this.#sql
      .exec<{ computer_until: number | null }>(
        `SELECT computer_until FROM sandbox_sessions WHERE id = ?`,
        id,
      )
      .toArray()[0];

    return row?.computer_until !== null && row?.computer_until !== undefined
      ? row.computer_until > now
      : false;
  }

  /**
   * How many computers the org has running at `now`, as the sessions' objects last answered, apart from the session
   * `except`'s.
   */
  computersRunning(now: number, except?: string): number {
    return (
      this.#sql
        .exec<{ running: number }>(
          `SELECT COUNT(*) AS running FROM sandbox_sessions
           WHERE computer_until > ? AND id != ?`,
          now,
          except ?? "",
        )
        .toArray()[0]?.running ?? 0
    );
  }

  /**
   * The open sessions, oldest first; `member`'s only when given, those used at `usedSince` or later only when given, at
   * most `limit`.
   */
  sessions(
    filter: { readonly member?: string; readonly usedSince?: number; readonly limit?: number } = {},
  ): ReadonlyArray<TrackedSession> {
    return this.#sql
      .exec<SessionRow>(
        `SELECT * FROM sandbox_sessions WHERE (? IS NULL OR member = ?) AND last_used >= ?
         ORDER BY opened_at, id LIMIT ?`,
        filter.member ?? null,
        filter.member ?? null,
        filter.usedSince ?? Number.MIN_SAFE_INTEGER,
        filter.limit ?? -1,
      )
      .toArray()
      .map(sessionOf);
  }

  /**
   * The sessions that may still be open at `now`, oldest first (#225: the panel's list), `member`'s only when given, at
   * most `limit`: those used within their idle day. One the provider closed
   * whose close is not reported yet is among them until it is forgotten: the provider says which are open.
   */
  mayBeOpen(now: number, limit: number, member?: string): ReadonlyArray<TrackedSession> {
    return this.#sql
      .exec<SessionRow>(
        `SELECT * FROM sandbox_sessions
         WHERE last_used > ? AND (? IS NULL OR member = ?)
         ORDER BY opened_at, id LIMIT ?`,
        now - SESSION_IDLE_MS,
        member ?? null,
        member ?? null,
        limit,
      )
      .toArray()
      .map(sessionOf);
  }

  /**
   * Forgets the sessions the provider ended for want of use whose close was not reported by `now` (#224), but those of
   * retired runs ({@link RUN_PRINCIPALS}), which the Tools part deletes at the provider first ({@link runSessionsDue});
   * answers when the next of either is due.
   */
  prune(now: number): number | null {
    this.#sql.exec(
      `DELETE FROM sandbox_sessions WHERE last_used <= ? AND ${NOT_RUN}`,
      now - FORGOTTEN_AFTER_MS,
    );

    const next = this.#sql
      .exec<{ forgotten: number | null; purged: number | null }>(
        `SELECT MIN(CASE WHEN ${NOT_RUN} THEN last_used END) AS forgotten,
                MIN(CASE WHEN ${NOT_RUN} THEN NULL ELSE MAX(last_used + ?, COALESCE(purge_retry_at, 0)) END) AS purged
         FROM sandbox_sessions`,
        SESSION_IDLE_MS,
      )
      .toArray()[0];

    const forgotten = next?.forgotten ?? null;

    const wakes = [
      forgotten === null ? null : forgotten + FORGOTTEN_AFTER_MS,
      next?.purged ?? null,
    ].filter((at): at is number => at !== null);

    return wakes.length === 0 ? null : Math.min(...wakes);
  }

  /** Whether the part keeps a session of a retired run ({@link RUN_PRINCIPALS}). */
  hasRunSessions(): boolean {
    return (
      this.#sql.exec(`SELECT 1 FROM sandbox_sessions WHERE NOT (${NOT_RUN}) LIMIT 1`).toArray()
        .length > 0
    );
  }

  /**
   * The sessions of retired runs ({@link RUN_PRINCIPALS}) due to be deleted at the provider at `now`, at most `limit`:
   * those unused for a day, whose last failed deletion, if any, is due to be tried again. Never tried first, then the
   * longest due, so sessions the provider cannot reach do not hold the others back.
   */
  runSessionsDue(now: number, limit: number): ReadonlyArray<TrackedSession> {
    return this.#sql
      .exec<SessionRow>(
        `SELECT * FROM sandbox_sessions
         WHERE NOT (${NOT_RUN}) AND last_used <= ? AND (purge_retry_at IS NULL OR purge_retry_at <= ?)
         ORDER BY purge_retry_at IS NOT NULL, purge_retry_at, last_used, id LIMIT ?`,
        now - SESSION_IDLE_MS,
        now,
        limit,
      )
      .toArray()
      .map(sessionOf);
  }

  /**
   * Notes that deleting the session `id` at the provider failed at `now`: it is tried again after a wait that doubles
   * with each failure, from {@link PURGE_RETRY_MS} up to a day.
   */
  purgeFailed(id: string, now: number): void {
    this.#sql.exec(
      `UPDATE sandbox_sessions
       SET purge_failures = COALESCE(purge_failures, 0) + 1,
           purge_retry_at = ? + MIN(? * (1 << MIN(COALESCE(purge_failures, 0), 20)), ?)
       WHERE id = ?`,
      now,
      PURGE_RETRY_MS,
      SESSION_IDLE_MS,
      id,
    );
  }
}

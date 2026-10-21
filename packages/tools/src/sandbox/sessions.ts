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
 * the call that closed it charged its last stretch. An agent run's session (its principal a run's, #230) lasts as long
 * as the run: no day ends it, and it goes when the run is deleted.
 */
import { CLOSE_REPORT_MS, SESSION_IDLE_MS } from "./provider.ts";

/** The rows of sessions a day without use ends: all but agent runs' (`run:<id>`, `isRunPrincipalId`). */
const ENDS_IDLE = `principal NOT LIKE 'run:%'`;

/** One open sandbox session. */
export interface TrackedSession {
  readonly id: string;
  readonly toolkitId: string;
  /** The member who opened it, if the caller was one. */
  readonly member: string | undefined;
  /** The principal it belongs to (`user:<email>`, `key:<id>`, `run:<id>`). */
  readonly principal: string;
  /** The shared agent whose run opened it (#228), whose Spend limits its computer time counts toward (#224). */
  readonly agent?: string | undefined;
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
  agent: string | null;
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
  ...(row.agent === null ? {} : { agent: row.agent }),
  openedAt: row.opened_at,
  lastUsed: row.last_used,
});

export class SandboxSessionStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(SCHEMA);

    // The shared agent whose run opened a session (#224, #228): a log from before has no column for it.
    const columns = sql
      .exec<{ name: string }>("PRAGMA table_info(sandbox_sessions)")
      .toArray()
      .map((column) => column.name);

    if (!columns.includes("agent")) sql.exec(`ALTER TABLE sandbox_sessions ADD COLUMN agent TEXT`);

    // When a session's computer stops unless a command uses it again (#241): a log from before has no column for it.
    if (!columns.includes("computer_until"))
      sql.exec(`ALTER TABLE sandbox_sessions ADD COLUMN computer_until INTEGER`);

    // Whether a session was opened with the computer (#241): a log from before has no column for it, and its sessions
    // may have one.
    if (!columns.includes("computer"))
      sql.exec(`ALTER TABLE sandbox_sessions ADD COLUMN computer INTEGER`);
  }

  /** Keeps a session just opened; `computer`: whether it was opened asking for the computer (#241). */
  opened(session: Omit<TrackedSession, "lastUsed">, computer = true): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO sandbox_sessions (id, toolkit_id, member, principal, agent, opened_at, last_used, computer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.toolkitId,
      session.member ?? "",
      session.principal,
      session.agent ?? null,
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

  /** Whether the part keeps the open session `id` as `principal`'s (#230: a run's gated call names its own only). */
  owns(id: string, principal: string): boolean {
    return (
      this.#sql
        .exec(`SELECT 1 FROM sandbox_sessions WHERE id = ? AND principal = ?`, id, principal)
        .toArray().length > 0
    );
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
   * `except`'s and from agent runs' (`run:<id>` principals, which no ceiling caps, ADR 0042).
   */
  computersRunning(now: number, except?: string): number {
    return (
      this.#sql
        .exec<{ running: number }>(
          `SELECT COUNT(*) AS running FROM sandbox_sessions
           WHERE computer_until > ? AND id != ? AND principal NOT LIKE 'run:%'`,
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
   * most `limit`: an agent run's, which no day ends, and the others used within their idle day. One the provider closed
   * whose close is not reported yet is among them until it is forgotten: the provider says which are open.
   */
  mayBeOpen(now: number, limit: number, member?: string): ReadonlyArray<TrackedSession> {
    return this.#sql
      .exec<SessionRow>(
        `SELECT * FROM sandbox_sessions
         WHERE (NOT (${ENDS_IDLE}) OR last_used > ?) AND (? IS NULL OR member = ?)
         ORDER BY opened_at, id LIMIT ?`,
        now - SESSION_IDLE_MS,
        member ?? null,
        member ?? null,
        limit,
      )
      .toArray()
      .map(sessionOf);
  }

  /** The open sessions of the principals `principals` (#230: agent runs'). */
  sessionsOf(principals: ReadonlyArray<string>): ReadonlyArray<TrackedSession> {
    if (principals.length === 0) return [];

    return this.#sql
      .exec<SessionRow>(
        `SELECT * FROM sandbox_sessions WHERE principal IN (${principals.map(() => "?").join(", ")})
         ORDER BY opened_at, id`,
        ...principals,
      )
      .toArray()
      .map(sessionOf);
  }

  /**
   * Forgets the sessions the provider ended for want of use whose close was not reported by `now` (#224), but agent
   * runs' (#230), which no day ends; answers when the next one is forgotten.
   */
  prune(now: number): number | null {
    this.#sql.exec(
      `DELETE FROM sandbox_sessions WHERE last_used <= ? AND ${ENDS_IDLE}`,
      now - FORGOTTEN_AFTER_MS,
    );

    const first = this.#sql
      .exec<{ first: number | null }>(
        `SELECT MIN(last_used) AS first FROM sandbox_sessions WHERE ${ENDS_IDLE}`,
      )
      .toArray()[0]?.first;

    return first === null || first === undefined ? null : first + FORGOTTEN_AFTER_MS;
  }
}

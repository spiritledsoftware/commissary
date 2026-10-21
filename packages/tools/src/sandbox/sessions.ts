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
  }

  opened(session: Omit<TrackedSession, "lastUsed">): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO sandbox_sessions (id, toolkit_id, member, principal, agent, opened_at, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.toolkitId,
      session.member ?? "",
      session.principal,
      session.agent ?? null,
      session.openedAt,
      session.openedAt,
    );
  }

  /** The open session `id`, if the part keeps it. */
  session(id: string): TrackedSession | undefined {
    const row = this.#sql
      .exec<SessionRow>(`SELECT * FROM sandbox_sessions WHERE id = ?`, id)
      .toArray()[0];

    return row === undefined ? undefined : sessionOf(row);
  }

  used(id: string, now: number): void {
    this.#sql.exec(`UPDATE sandbox_sessions SET last_used = ? WHERE id = ?`, now, id);
  }

  ended(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.#sql.exec(`DELETE FROM sandbox_sessions WHERE id = ?`, id);
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
   * Forgets the sessions the provider ended for want of use whose close was not reported by `now` (#224); answers when
   * the next one is forgotten.
   */
  prune(now: number): number | null {
    this.#sql.exec(`DELETE FROM sandbox_sessions WHERE last_used <= ?`, now - FORGOTTEN_AFTER_MS);

    const first = this.#sql
      .exec<{ first: number | null }>(`SELECT MIN(last_used) AS first FROM sandbox_sessions`)
      .toArray()[0]?.first;

    return first === null || first === undefined ? null : first + FORGOTTEN_AFTER_MS;
  }
}

/**
 * The org's open browser sessions, as the Tools part keeps them (#214): the `browser_sessions` table, one of the part's
 * tables (`TOOLS_TABLES`), keyed by `toolkit_id` like the others. A row holds a session's id, its toolkit and who opened
 * it (the member, and the principal it belongs to), nothing of its pages. The part logs a session it opens, and forgets
 * it when a call closes it or its object reports that its alarm did (`ToolsPart.browserSessionClosed`, which charges
 * the browser time before it to the opener's Spend limits). The org's deletion deletes each logged session's object
 * first (`ToolsPart.purgeBrowserSessions`), so no alarm of theirs writes a usage record or reaches the ControlPlane
 * after the org is gone. A session opened before the log is not in it; it closes by itself within its idle minutes.
 */

/** The API key a principal names (`key:<id>`), whose limits a session's browser time counts toward; none for a person. */
export const apiKeyOf = (principal: string): string | undefined =>
  principal.startsWith("key:") ? principal.slice("key:".length) : undefined;

/** A browser session as the part logs it. */
export interface LoggedBrowserSession {
  readonly id: string;
  readonly toolkitId: string;
  /** The member who opened it, if the caller was one (null in the table otherwise). */
  readonly member: string | undefined;
  /** The principal it belongs to (`user:<email>`, `key:<id>`). */
  readonly principal: string;
  readonly openedAt: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY, toolkit_id TEXT NOT NULL, member TEXT, principal TEXT NOT NULL, opened_at INTEGER NOT NULL
)`;

type Row = {
  id: string;
  toolkit_id: string;
  member: string | null;
  principal: string;
  opened_at: number;
};

export class BrowserSessionStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(SCHEMA);
  }

  opened(session: LoggedBrowserSession): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO browser_sessions (id, toolkit_id, member, principal, opened_at) VALUES (?, ?, ?, ?, ?)`,
      session.id,
      session.toolkitId,
      session.member ?? null,
      session.principal,
      session.openedAt,
    );
  }

  /** The logged session `id`, if it is. */
  session(id: string): LoggedBrowserSession | undefined {
    const row = this.#sql.exec<Row>(`SELECT * FROM browser_sessions WHERE id = ?`, id).toArray()[0];

    return row === undefined
      ? undefined
      : {
          id: row.id,
          toolkitId: row.toolkit_id,
          member: row.member ?? undefined,
          principal: row.principal,
          openedAt: row.opened_at,
        };
  }

  /** The ids of the logged sessions, oldest first, at most `limit` (all without). */
  ids(limit?: number): ReadonlyArray<string> {
    return this.#sql
      .exec<{ id: string }>(
        `SELECT id FROM browser_sessions ORDER BY opened_at, id LIMIT ?`,
        limit ?? -1,
      )
      .toArray()
      .map((row) => row.id);
  }

  /** Forgets the sessions `ids`. */
  forget(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.#sql.exec(`DELETE FROM browser_sessions WHERE id = ?`, id);
  }
}

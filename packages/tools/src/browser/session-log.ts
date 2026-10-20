/**
 * The org's open browser sessions, as the Tools part keeps them (#214): the `browser_sessions` table, one of the part's
 * tables (`TOOLS_TABLES`), keyed by `toolkit_id` like the others. A row holds a session's id, its toolkit and who opened
 * it (the member, and the principal it belongs to, and the shared agent whose run opened it, #228), nothing of its pages. The part logs a session it opens, and forgets
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
  /** The principal it belongs to (`user:<email>`, `key:<id>`, `run:<id>`). */
  readonly principal: string;
  /** The shared agent whose run opened it (#228), whose Spend limits its browser time counts toward; absent otherwise. */
  readonly agent?: string | undefined;
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
  agent: string | null;
  opened_at: number;
};

export class BrowserSessionStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(SCHEMA);

    // The shared agent whose run opened a session (#228): a log from before has no column for it.
    const columns = sql
      .exec<{ name: string }>("PRAGMA table_info(browser_sessions)")
      .toArray()
      .map((column) => column.name);

    if (!columns.includes("agent")) sql.exec(`ALTER TABLE browser_sessions ADD COLUMN agent TEXT`);
  }

  opened(session: LoggedBrowserSession): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO browser_sessions (id, toolkit_id, member, principal, agent, opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      session.id,
      session.toolkitId,
      session.member ?? null,
      session.principal,
      session.agent ?? null,
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
          ...(row.agent === null ? {} : { agent: row.agent }),
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

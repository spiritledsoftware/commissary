/**
 * The org's open browser sessions, as the Tools part keeps them (#214): the `browser_sessions` table, one of the part's
 * tables (`TOOLS_TABLES`), keyed by `toolkit_id` like the others. A row holds a session's id, its toolkit and who opened
 * it (the member, and the principal it belongs to, and the shared agent whose run opened it, #228), nothing of its pages. The part logs a session it opens, and forgets
 * it when a call closes it or its object reports that its alarm did (`ToolsPart.browserSessionClosed`, which charges
 * the browser time before it to the opener's Spend limits). The org's deletion deletes each logged session's object
 * first (`ToolsPart.purgeBrowserSessions`), so no alarm of theirs writes a usage record or reaches the ControlPlane
 * after the org is gone. A session opened before the log is not in it; it closes by itself within its idle minutes.
 * The panel's Browser sessions page (#216) lists the log: each session's profile and whether a handoff in it waits for
 * its person, as its calls left it (the part asks a session's object again before it flags one).
 */
import type { BrowserSessionOpener } from "@commissary/contract/browser-sessions";

/** The API key a principal names (`key:<id>`), whose limits a session's browser time counts toward; none for a person. */
export const apiKeyOf = (principal: string): string | undefined =>
  principal.startsWith("key:") ? principal.slice("key:".length) : undefined;

/** How a principal opened a session, as the Browser sessions page says it (#216): an API key, an agent run, a person. */
export const openerOf = (principal: string): BrowserSessionOpener => {
  if (apiKeyOf(principal) !== undefined) return "api_key";

  return principal.startsWith("run:") ? "agent_run" : "person";
};

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
  /** The browser profile it opened from (#215, #216: the Browser sessions page shows it); absent: none, or logged before. */
  readonly profile?: string | undefined;
  /**
   * Until when a handoff in it waits for its person (#216), as its calls left it: the Browser sessions page flags it. A
   * time past is no handoff (it ended without a call taking it).
   */
  readonly handoffUntil?: number | undefined;
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
  profile: string | null;
  handoff_until: number | null;
};

const sessionOf = (row: Row): LoggedBrowserSession => ({
  id: row.id,
  toolkitId: row.toolkit_id,
  member: row.member ?? undefined,
  principal: row.principal,
  ...(row.agent === null ? {} : { agent: row.agent }),
  openedAt: row.opened_at,
  ...(row.profile === null ? {} : { profile: row.profile }),
  ...(row.handoff_until === null ? {} : { handoffUntil: row.handoff_until }),
});

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

    // The profile a session opened from, and its handoff (#216): a log from before has no columns for them.
    if (!columns.includes("profile"))
      sql.exec(`ALTER TABLE browser_sessions ADD COLUMN profile TEXT`);

    if (!columns.includes("handoff_until"))
      sql.exec(`ALTER TABLE browser_sessions ADD COLUMN handoff_until INTEGER`);
  }

  opened(session: LoggedBrowserSession): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO browser_sessions (id, toolkit_id, member, principal, agent, opened_at, profile)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.toolkitId,
      session.member ?? null,
      session.principal,
      session.agent ?? null,
      session.openedAt,
      session.profile ?? null,
    );
  }

  /** Notes that a handoff in the session `id` waits for its person until `until` (#216), or no longer (`undefined`). */
  handoff(id: string, until: number | undefined): void {
    this.#sql.exec(`UPDATE browser_sessions SET handoff_until = ? WHERE id = ?`, until ?? null, id);
  }

  /** Every logged session, oldest first. */
  all(): ReadonlyArray<LoggedBrowserSession> {
    return this.#sql
      .exec<Row>(`SELECT * FROM browser_sessions ORDER BY opened_at, id`)
      .toArray()
      .map(sessionOf);
  }

  /** The logged session `id`, if it is. */
  session(id: string): LoggedBrowserSession | undefined {
    const row = this.#sql.exec<Row>(`SELECT * FROM browser_sessions WHERE id = ?`, id).toArray()[0];

    return row === undefined ? undefined : sessionOf(row);
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

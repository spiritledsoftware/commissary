/**
 * The org's browser crawls, as the Tools part keeps them (#270): the `browser_crawls` table, one of the part's tables
 * (`TOOLS_TABLES`), keyed by `toolkit_id` like the others. A row holds the provider's id of a crawl and who started it
 * (the member, and the principal it belongs to), so that only they reach it (`crawl-tools.ts`): the provider's ids are
 * account-wide, and a crawl not on the org's record is no crawl of the org's. Nothing of the crawl's pages is kept here.
 *
 * Browser Run ends a crawl after at most seven days and deletes its pages 14 days after it ends, so a row is kept
 * {@link CRAWL_KEPT_MS} from the start and then forgotten ({@link BrowserCrawlStore.prune}, from the part's alarm). A
 * member's leaving forgets theirs (ADR 0027), and the org's deletion drops the table; before either, the part cancels
 * at the provider each crawl that may still be running ({@link BrowserCrawlStore.mayRun}).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a crawl may run: Browser Run ends one after seven days. */
export const CRAWL_RUN_MS = 7 * DAY_MS;

/** How long a crawl is kept from its start: its longest run, and the 14 days Browser Run keeps its pages after. */
export const CRAWL_KEPT_MS = CRAWL_RUN_MS + 14 * DAY_MS;

/** Who reaches a crawl: the member and principal that started it. */
export interface CrawlOwner {
  /** The member who started it, if the caller was one (null in the table otherwise). */
  readonly member: string | undefined;
  /** The principal it belongs to (`user:<email>`, `key:<id>`). */
  readonly principal: string;
}

/** A crawl as the part logs it. */
export interface LoggedCrawl extends CrawlOwner {
  readonly id: string;
  readonly toolkitId: string;
  readonly startedAt: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS browser_crawls (
  id TEXT PRIMARY KEY, toolkit_id TEXT NOT NULL, member TEXT, principal TEXT NOT NULL, started_at INTEGER NOT NULL
)`;

export class BrowserCrawlStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(SCHEMA);
  }

  started(crawl: LoggedCrawl): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO browser_crawls (id, toolkit_id, member, principal, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      crawl.id,
      crawl.toolkitId,
      crawl.member ?? null,
      crawl.principal,
      crawl.startedAt,
    );
  }

  /** Whether `owner` started the crawl `id`. */
  owns(id: string, owner: CrawlOwner): boolean {
    return (
      this.#sql
        .exec(
          `SELECT 1 FROM browser_crawls WHERE id = ? AND member IS ? AND principal = ?`,
          id,
          owner.member ?? null,
          owner.principal,
        )
        .toArray().length > 0
    );
  }

  /**
   * The ids of the crawls that may still be running at `now` (started less than {@link CRAWL_RUN_MS} before), at most
   * `limit` (all without), `member`'s only when given.
   */
  mayRun(
    now: number,
    filter: { readonly member?: string; readonly limit?: number } = {},
  ): ReadonlyArray<string> {
    const rows =
      filter.member === undefined
        ? this.#sql.exec<{ id: string }>(
            `SELECT id FROM browser_crawls WHERE started_at > ? ORDER BY started_at, id LIMIT ?`,
            now - CRAWL_RUN_MS,
            filter.limit ?? -1,
          )
        : this.#sql.exec<{ id: string }>(
            `SELECT id FROM browser_crawls WHERE started_at > ? AND member = ? ORDER BY started_at, id LIMIT ?`,
            now - CRAWL_RUN_MS,
            filter.member,
            filter.limit ?? -1,
          );

    return rows.toArray().map((row) => row.id);
  }

  /** Forgets the crawls `ids`. */
  forget(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.#sql.exec(`DELETE FROM browser_crawls WHERE id = ?`, id);
  }

  /** Forgets the crawls `member` started. */
  deleteMember(member: string): void {
    this.#sql.exec(`DELETE FROM browser_crawls WHERE member = ?`, member);
  }

  /** Forgets the crawls started {@link CRAWL_KEPT_MS} before `now`; answers when the next one goes. */
  prune(now: number): number | null {
    this.#sql.exec(`DELETE FROM browser_crawls WHERE started_at <= ?`, now - CRAWL_KEPT_MS);

    const first = this.#sql
      .exec<{ first: number | null }>(`SELECT MIN(started_at) AS first FROM browser_crawls`)
      .toArray()[0]?.first;

    return first === null || first === undefined ? null : first + CRAWL_KEPT_MS;
  }
}

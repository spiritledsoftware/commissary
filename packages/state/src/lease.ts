/**
 * Named leases in a Durable Object's SQLite storage, so one piece of work runs at a time across isolates. Workers
 * addition, no Go counterpart.
 *
 * Work that runs in a Worker, possibly in several isolates at once, takes a lease from a Durable Object first: one
 * SQLite row per lease name, read and written synchronously, so taking it is atomic under the object's input gate.
 * Times are the object's own clock, never the caller's. The holder gives the lease back with its token when it ends; a
 * holder that may outlast {@link LEASE_TTL_MS} renews it. A lease not renewed for {@link LEASE_TTL_MS} counts as
 * abandoned (its Worker died), and the next taker takes it over. A second taker that finds the lease held is refused
 * and told who holds it.
 *
 * Leases in use: the ControlPlane's `quota_sweep` (one check of every quota at a time, renewed while it runs: the
 * Models area's quota sweep), and the Platform registry's `catalog_refresh` (one model catalog download at a time, not
 * renewed: the Models area's catalog refresh) and `toolkit_catalog_refresh` (one toolkit catalog download at a time,
 * not renewed: the Tools area's catalog refresh).
 *
 * Each name has its own table, `<name>_lease`, as each lease had before leases were named, so the rows stored then
 * read back. A token names its lease (`<name>:<uuid>`), so renewing and giving it back need only the token; a token
 * from before (a bare UUID, held by a Worker still running the previous version) is looked for in every lease table.
 */

/** Who started the work holding the lease: the scheduled task or the panel. */
export type LeaseSource = "cron" | "panel";

/** A lease stored under its name (not the credential lease `ControlPlane.pick` hands out, `credentials/selection`). */
export interface NamedLease {
  readonly token: string;
  readonly source: LeaseSource;
  readonly startedAt: number;
  /** When the holder last showed it is alive (taken or renewed). */
  readonly renewedAt: number;
}

/** A holder renews well within this (a quota sweep: each account's check is bounded by 15 s per upstream call). */
export const LEASE_TTL_MS = 2 * 60_000;

export type TakeLease =
  | { readonly ok: true; readonly lease: NamedLease }
  | { readonly ok: false; readonly held: NamedLease };

/** Whether a new holder may take the lease while `current` is stored (pure): only once it is gone or abandoned. */
export const mayTake = (current: NamedLease | undefined, now: number): boolean =>
  current === undefined || now - current.renewedAt >= LEASE_TTL_MS;

/**
 * A lease name is part of its table's name: lowercase letters, digits and underscores, starting with a letter. Names
 * are plain strings, checked when used: the store serves any area, and each holder keeps its lease name as a constant.
 */
const LEASE_NAME = /^[a-z][a-z0-9_]*$/;

interface LeaseRow {
  token: string;
  source: string;
  started_at: number;
  renewed_at: number;
  [column: string]: SqlStorageValue;
}

export class LeaseStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  /** The names whose table this object has made sure of since it started. */
  readonly #ready = new Set<string>();

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
  }

  current(name: string): NamedLease | undefined {
    const row = this.#sql
      .exec<LeaseRow>(
        `SELECT token, source, started_at, renewed_at FROM ${this.#table(name)} WHERE id = 1`,
      )
      .toArray()[0];

    if (row === undefined) return undefined;

    return {
      token: row.token,
      source: row.source === "cron" ? "cron" : "panel",
      startedAt: row.started_at,
      renewedAt: row.renewed_at,
    };
  }

  /** Takes the lease `name` for work started by `source` now, unless a live holder has it. */
  take(name: string, source: LeaseSource): TakeLease {
    const now = this.#now();
    const current = this.current(name);

    if (current !== undefined && !mayTake(current, now)) return { ok: false, held: current };

    const lease: NamedLease = {
      token: `${name}:${crypto.randomUUID()}`,
      source,
      startedAt: now,
      renewedAt: now,
    };

    this.#sql.exec(
      `INSERT INTO ${this.#table(name)} (id, token, source, started_at, renewed_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET token = excluded.token, source = excluded.source,
         started_at = excluded.started_at, renewed_at = excluded.renewed_at`,
      lease.token,
      lease.source,
      lease.startedAt,
      lease.renewedAt,
    );

    return { ok: true, lease };
  }

  /** Marks the holder of `token` alive now; `false` when the token no longer holds its lease. */
  renew(token: string): boolean {
    const now = this.#now();

    return this.#tablesOf(token).some(
      (table) =>
        this.#sql.exec(`UPDATE ${table} SET renewed_at = ? WHERE id = 1 AND token = ?`, now, token)
          .rowsWritten > 0,
    );
  }

  /** Gives the lease back; a token that no longer holds it (taken over after the TTL) changes nothing. */
  release(token: string): void {
    for (const table of this.#tablesOf(token))
      this.#sql.exec(`DELETE FROM ${table} WHERE id = 1 AND token = ?`, token);
  }

  /**
   * The tables `token` may hold a lease in: the one of the lease it names, none when it names no valid lease, and for
   * a bare token (taken before tokens named their lease) every lease table this object holds.
   */
  #tablesOf(token: string): ReadonlyArray<string> {
    const separator = token.indexOf(":");

    if (separator !== -1) {
      const name = token.slice(0, separator);

      return LEASE_NAME.test(name) ? [this.#table(name)] : [];
    }

    return this.#sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_lease' ESCAPE '\\'",
      )
      .toArray()
      .map((row) => row.name.slice(0, -"_lease".length))
      .filter((name) => LEASE_NAME.test(name))
      .map((name) => this.#table(name));
  }

  /** The table of the lease `name`, created (or brought up to date) the first time this object uses it. */
  #table(name: string): string {
    if (!LEASE_NAME.test(name)) throw new Error(`invalid lease name: ${JSON.stringify(name)}`);

    const table = `${name}_lease`;

    if (this.#ready.has(name)) return table;

    // A table from before leases were renewed (no `renewed_at`): it holds only a transient lease, so it is recreated.
    const columns = this.#sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((column) => column.name);

    if (columns.length > 0 && !columns.includes("renewed_at"))
      this.#sql.exec(`DROP TABLE ${table}`);
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         token TEXT NOT NULL,
         source TEXT NOT NULL,
         started_at INTEGER NOT NULL,
         renewed_at INTEGER NOT NULL
       )`,
    );
    this.#ready.add(name);

    return table;
  }
}

/**
 * A dummy area part of the ControlPlane (#134 "How an area's ControlPlane part works"), composed with the org-wide base
 * by the test Worker (test/worker.ts) as an area's part is: an `RpcTarget` constructed once per object with the base's
 * view (`core`), creating its own tables (named after the part, so two parts keep theirs apart), told what the base
 * changed, and woken by the base's one alarm. It records each call the base makes, so tests can read them back.
 */
import { RpcTarget } from "cloudflare:workers";
import type { ControlPlanePart, OrgCore, SecretCipher } from "../../src/index.ts";

export class DummyPart extends RpcTarget implements ControlPlanePart {
  readonly #sql: SqlStorage;
  readonly #core: OrgCore;
  readonly #name: string;

  constructor(ctx: DurableObjectState, name: string, core: OrgCore) {
    super();
    this.#sql = ctx.storage.sql;
    this.#core = core;
    this.#name = name;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${name}_items (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${name}_wake_ups (at INTEGER PRIMARY KEY, ran_at INTEGER)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${name}_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, call TEXT NOT NULL)`,
    );
  }

  /** Stores `text`; answers how many items the part holds. */
  add(text: string): number {
    this.#sql.exec(`INSERT INTO ${this.#name}_items (text) VALUES (?)`, text);

    return this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.#name}_items`).one().n;
  }

  /** As `add`, answered asynchronously (most ControlPlane methods return a promise). */
  async addLater(text: string): Promise<number> {
    await Promise.resolve();

    return this.add(text);
  }

  /** Fails with `message`: a failure of the part's own code, which reaches the caller. */
  fail(message: string): never {
    throw new Error(message);
  }

  list(): string[] {
    return this.#sql
      .exec<{ text: string }>(`SELECT text FROM ${this.#name}_items ORDER BY id`)
      .toArray()
      .map((row) => row.text);
  }

  /** What the base holds, read through `core`: the org, its members' emails and its teams' names. */
  orgView() {
    return {
      org: this.#core.org,
      members: this.#core.members().map((member) => member.email),
      teams: this.#core.teams().map((team) => team.name),
    };
  }

  /** Asks to be woken at `at` (epoch ms): the base sets the object's one alarm to the earliest wake-up of any part. */
  async wakeAt(at: number): Promise<void> {
    this.#sql.exec(`INSERT OR IGNORE INTO ${this.#name}_wake_ups (at) VALUES (?)`, at);
    await this.#core.wakeUpChanged(this.#nextWakeUp());
  }

  #nextWakeUp(): number | null {
    return (
      this.#sql
        .exec<{ at: number | null }>(
          `SELECT MIN(at) AS at FROM ${this.#name}_wake_ups WHERE ran_at IS NULL`,
        )
        .one().at ?? null
    );
  }

  /** The wake-ups that ran, earliest first. */
  ran(): number[] {
    return this.#sql
      .exec<{ at: number }>(
        `SELECT at FROM ${this.#name}_wake_ups WHERE ran_at IS NOT NULL ORDER BY at`,
      )
      .toArray()
      .map((row) => row.at);
  }

  /** The calls the base made, oldest first (`alarm`, `memberLeft <id> <how>`, …). */
  calls(): string[] {
    return this.#sql
      .exec<{ call: string }>(`SELECT call FROM ${this.#name}_calls ORDER BY id`)
      .toArray()
      .map((row) => row.call);
  }

  #record(call: string): void {
    this.#sql.exec(`INSERT INTO ${this.#name}_calls (call) VALUES (?)`, call);
  }

  // --- what the base calls (`ControlPlanePart`) -------------------------------------------------------------------

  sealPlaintext(_cipher: SecretCipher): number {
    this.#record("sealPlaintext");

    return 0;
  }

  /** Runs the wake-ups due at `now`; answers the next one. */
  async alarm(now: number): Promise<number | null> {
    await Promise.resolve();
    this.#record("alarm");
    this.#sql.exec(
      `UPDATE ${this.#name}_wake_ups SET ran_at = ? WHERE ran_at IS NULL AND at <= ?`,
      now,
      now,
    );

    return this.#nextWakeUp();
  }

  wipe(): void {
    for (const table of ["items", "wake_ups", "calls"])
      this.#sql.exec(`DROP TABLE IF EXISTS ${this.#name}_${table}`);
  }

  async memberLeft(member: string, how: "left" | "removed"): Promise<void> {
    await Promise.resolve();
    this.#record(`memberLeft ${member} ${how}`);
  }

  teamDeleted(team: string): void {
    this.#record(`teamDeleted ${team}`);
  }

  teamMembersChanged(): void {
    this.#record("teamMembersChanged");
  }

  apiKeysDeleted(ids: ReadonlyArray<string>): void {
    this.#record(`apiKeysDeleted [${ids.join(",")}]`);
  }

  privateCredentialsChanged(): void {
    this.#record("privateCredentialsChanged");
  }

  spendCredentials(): readonly [] {
    return [];
  }
}

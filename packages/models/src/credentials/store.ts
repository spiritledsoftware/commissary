/**
 * SQLite persistence of credentials inside the ControlPlane Durable Object.
 *
 * Auth files are stored as one JSON row each (the Go file *is* `Auth.Metadata`), with `provider`/`disabled`
 * duplicated into indexed columns. Config provider-key credentials are never stored: they are re-synthesised from config.
 * Runtime state (`credential_state`) is persisted only when it matters across restarts (failures and cooldowns);
 * round-robin cursors and session bindings stay in memory (credentials.md §10).
 *
 * The file JSON is a sealed value (`@commissary/state` `secrets/cipher.ts`): encrypted with the org's data key before
 * it is written and opened on read, so the table holds no token in plain text. `sealPlaintext` seals the rows written
 * before encryption.
 *
 * All methods are synchronous so read-modify-write sequences are atomic under the Durable Object input gate.
 */
import { Effect, Result, Schema } from "effect";
import type { JsonObject } from "@commissary/json";
import type { StoredCredential } from "./derive.ts";
import { credentialsChanged, mergeExistingMetadata } from "./merge.ts";
import { CredentialState } from "./model.ts";
import { isSealed, type Sealer } from "@commissary/state";

interface CredentialRow {
  id: string;
  provider: string;
  disabled: number;
  metadata: string;
  credential_version: number;
  owner: string | null;
  created_at: number;
  updated_at: number;
  [column: string]: SqlStorageValue;
}

interface StateRow {
  id: string;
  state: string;
  [column: string]: SqlStorageValue;
}

export interface UpsertOptions {
  /** Carry user settings over from the existing file (re-login semantics, credentials.md §11). */
  readonly mergeExisting: boolean;
  /**
   * The member the credential is private to. A new credential takes it; an existing one keeps its owner (a write
   * never moves a credential between the org and a member: the ControlPlane refuses that before it gets here).
   */
  readonly owner?: string | undefined;
}

export interface UpsertOutcome {
  readonly record: StoredCredential;
  readonly created: boolean;
  /** Token/provider-key material changed (`credentialVersion` was bumped). */
  readonly credentialsChanged: boolean;
}

const decodeState = Schema.decodeUnknownEffect(CredentialState);

// The metadata column is serialised from a JsonObject on write, so it always parses back to one.
const parseMetadata = (text: string): JsonObject => {
  const parsed: JsonObject = JSON.parse(text);

  return parsed;
};

/** Where an auth file's sealed JSON is stored: it opens only there. */
const sealContext = (id: string): string => `credentials/${id}`;

export class CredentialStore {
  readonly #sql: SqlStorage;
  readonly #secrets: Sealer;
  readonly #now: () => number;

  /** `secrets`: the org's data key (`OrgSecrets`), which seals and opens the file JSON. */
  constructor(sql: SqlStorage, secrets: Sealer, now: () => number = Date.now) {
    this.#sql = sql;
    this.#secrets = secrets;
    this.#now = now;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS credentials (
         id TEXT PRIMARY KEY,
         provider TEXT NOT NULL,
         disabled INTEGER NOT NULL DEFAULT 0,
         metadata TEXT NOT NULL,
         credential_version INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );

    // Credentials stored before ownership have no owner column: they all belong to the org (shared).
    if (
      !sql
        .exec<{ name: string }>("PRAGMA table_info(credentials)")
        .toArray()
        .some((column) => column.name === "owner")
    )
      sql.exec("ALTER TABLE credentials ADD COLUMN owner TEXT");

    sql.exec("CREATE INDEX IF NOT EXISTS credentials_provider ON credentials (provider, disabled)");
    sql.exec(
      `CREATE TABLE IF NOT EXISTS credential_state (
         id TEXT PRIMARY KEY,
         state TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  list(): StoredCredential[] {
    return this.#sql
      .exec<CredentialRow>(
        "SELECT id, provider, disabled, metadata, credential_version, owner, created_at, updated_at FROM credentials ORDER BY id",
      )
      .toArray()
      .map((row) => this.#toRecord(row));
  }

  get(id: string): StoredCredential | undefined {
    const row = this.#sql
      .exec<CredentialRow>(
        "SELECT id, provider, disabled, metadata, credential_version, owner, created_at, updated_at FROM credentials WHERE id = ?",
        id,
      )
      .toArray()[0];

    return row === undefined ? undefined : this.#toRecord(row);
  }

  /**
   * Seals every file JSON stored in plain text (written before encryption) with `secrets`, inside the caller's
   * transaction; answers how many it sealed.
   */
  sealPlaintext(secrets: Sealer): number {
    let sealed = 0;

    for (const row of this.#sql
      .exec<CredentialRow>("SELECT id, metadata FROM credentials")
      .toArray()) {
      if (isSealed(row.metadata)) continue;
      this.#sql.exec(
        "UPDATE credentials SET metadata = ? WHERE id = ?",
        secrets.seal(row.metadata, sealContext(row.id)),
        row.id,
      );
      sealed += 1;
    }

    return sealed;
  }

  #toRecord(row: CredentialRow): StoredCredential {
    return {
      id: row.id,
      provider: row.provider,
      metadata: parseMetadata(this.#secrets.open(row.metadata, sealContext(row.id))),
      credentialVersion: row.credential_version,
      ...(row.owner === null ? {} : { owner: row.owner }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Inserts or replaces one auth file. `incoming` is the complete new file content. */
  upsert(
    id: string,
    provider: string,
    incoming: JsonObject,
    options: UpsertOptions,
  ): UpsertOutcome {
    const existing = this.get(id);

    const metadata =
      existing !== undefined && options.mergeExisting
        ? mergeExistingMetadata(provider, incoming, existing.metadata)
        : incoming;

    const now = this.#now();
    const changed = existing === undefined ? true : credentialsChanged(existing.metadata, metadata);

    const record: StoredCredential = {
      id,
      provider,
      metadata,
      credentialVersion:
        existing === undefined ? 1 : existing.credentialVersion + (changed ? 1 : 0),
      ...(existing === undefined
        ? options.owner === undefined
          ? {}
          : { owner: options.owner }
        : existing.owner === undefined
          ? {}
          : { owner: existing.owner }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.#write(record);

    return { record, created: existing === undefined, credentialsChanged: changed };
  }

  /**
   * Sets the `disabled` flag (persisted in the file JSON like Go), with `metadata` written beside it (a TOS_VIOLATION's
   * appeal details). `undefined` when the credential is unknown.
   */
  setDisabled(
    id: string,
    disabled: boolean,
    metadata: Readonly<Record<string, string>> = {},
  ): StoredCredential | undefined {
    const existing = this.get(id);

    if (existing === undefined) return undefined;

    const record: StoredCredential = {
      ...existing,
      metadata: { ...existing.metadata, ...metadata, disabled },
      updatedAt: this.#now(),
    };

    this.#write(record);

    return record;
  }

  /** Removes an auth file without opening it, so a row that no longer opens can still be deleted. */
  remove(id: string): boolean {
    const existing = this.#sql.exec("SELECT id FROM credentials WHERE id = ?", id).toArray()[0];

    if (existing === undefined) return false;
    this.#sql.exec("DELETE FROM credentials WHERE id = ?", id);
    this.deleteState(id);

    return true;
  }

  #write(record: StoredCredential): void {
    this.#sql.exec(
      `INSERT INTO credentials (id, provider, disabled, metadata, credential_version, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, disabled = excluded.disabled,
         metadata = excluded.metadata, credential_version = excluded.credential_version,
         updated_at = excluded.updated_at`,
      record.id,
      record.provider,
      record.metadata.disabled === true ? 1 : 0,
      this.#secrets.seal(JSON.stringify(record.metadata), sealContext(record.id)),
      record.credentialVersion,
      record.owner ?? null,
      record.createdAt,
      record.updatedAt,
    );
  }

  /** Persisted runtime states; rows that no longer decode are dropped. */
  loadStates(): Map<string, CredentialState> {
    const states = new Map<string, CredentialState>();

    for (const row of this.#sql
      .exec<StateRow>("SELECT id, state FROM credential_state")
      .toArray()) {
      try {
        const decoded = Effect.runSync(Effect.result(decodeState(JSON.parse(row.state))));

        if (Result.isSuccess(decoded)) states.set(row.id, decoded.success);
        else this.deleteState(row.id);
      } catch {
        this.deleteState(row.id);
      }
    }

    return states;
  }

  saveState(id: string, state: CredentialState): void {
    this.#sql.exec(
      `INSERT INTO credential_state (id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      id,
      JSON.stringify(state),
      this.#now(),
    );
  }

  deleteState(id: string): void {
    this.#sql.exec("DELETE FROM credential_state WHERE id = ?", id);
  }
}

/**
 * Private provider key groups (ADR 0023, ADR 0025): the key groups a member keeps for themselves.
 *
 * New in the Workers port, no Go counterpart. A private group is a key group with its keys, stored as one sealed row
 * of its own (`private_key_groups`, sealed with the org data key like every secret) and owned by one member. It never
 * enters the org's config entries: the org config, its snapshot and every export stay what an org admin can see. The
 * credential pool derives the private groups of every owner (`owners`), stamping each credential with its owner, so
 * selection offers them to their owner only (`ownership.ts`).
 *
 * A group is written like a shared one, one group at a time at the revision it was read at (`write`); the revisions
 * are values of one change counter, so a group changed or deleted since is a conflict.
 */
import { Effect } from "effect";
import { decodeConfig } from "../config/codec.ts";
import { documentOfEntries, type GroupRow, type KeyRow } from "../config/entries.ts";
import { PROVIDER_KEY_FAMILIES, type ProviderKeyFamily, type Config } from "../config/schema.ts";
import type { KeyGroupChange, WriteResult } from "../config/store.ts";
import {
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  jsonEquals,
} from "@commissary/json";
import type { Sealer } from "@commissary/state";
import { freshEntryId, GROUP_ID_KIND } from "./key-ids.ts";
import { providerKeyIdKind } from "./synthesize.ts";

const TABLE = "private_key_groups";

const patternsOf = (value: Json | undefined): string[] =>
  isJsonArray(value) ? value.filter((pattern) => typeof pattern === "string") : [];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, family TEXT NOT NULL, position INTEGER NOT NULL,
     value TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS private_key_groups_owner ON ${TABLE} (owner)`,
  `CREATE TABLE IF NOT EXISTS private_key_changes (id INTEGER PRIMARY KEY CHECK (id = 1), counter INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO private_key_changes (id, counter) VALUES (1, 0)`,
];

interface GroupSqlRow {
  id: string;
  owner: string;
  family: string;
  position: number;
  value: string;
  revision: number;
  [column: string]: SqlStorageValue;
}

/** One stored group: `group` carries its id and the id of every key. */
interface StoredGroup {
  readonly id: string;
  readonly owner: string;
  readonly family: ProviderKeyFamily;
  readonly position: number;
  readonly revision: number;
  readonly group: JsonObject;
}

/** The private groups of one member, assembled like an org's config (only `api-keys` is ever set). */
export interface PrivateKeyConfig {
  /** The change counter of all private groups. */
  readonly version: number;
  readonly owner: string;
  readonly document: JsonObject;
  readonly config: Config;
  /** Group id -> revision. */
  readonly revisions: Readonly<Record<string, number>>;
}

/** Why a write to private groups is refused (`WriteResult`'s refusals, plus no such owner's group). */
const refused = (
  error: "conflict" | "not_found" | "invalid",
  message: string,
): WriteResult<never> => ({ ok: false, error, message });

class Refusal extends Error {
  readonly result: WriteResult<never>;

  constructor(result: WriteResult<never>) {
    super("refused");
    this.result = result;
  }
}

const isFamily = (value: string): value is ProviderKeyFamily =>
  PROVIDER_KEY_FAMILIES.some((family) => family === value);

/** The private groups of every owner with the change counter they were assembled at. */
export interface PrivateKeyOwners {
  readonly version: number;
  readonly configs: ReadonlyArray<PrivateKeyConfig>;
}

export class PrivateKeyStore {
  readonly #sql: SqlStorage;
  readonly #transaction: <T>(body: () => T) => T;
  readonly #secrets: Sealer;
  readonly #now: () => number;
  #cached: { readonly version: number; readonly configs: ReadonlyMap<string, PrivateKeyConfig> };

  constructor(
    sql: SqlStorage,
    transaction: <T>(body: () => T) => T,
    secrets: Sealer,
    now: () => number = Date.now,
  ) {
    this.#sql = sql;
    this.#transaction = transaction;
    this.#secrets = secrets;
    this.#now = now;

    for (const statement of SCHEMA) sql.exec(statement);
    this.#cached = { version: -1, configs: new Map() };
  }

  /** The change counter of all private groups: moves with every write. */
  version(): number {
    return this.#sql.exec<{ counter: number }>(`SELECT counter FROM private_key_changes`).one()
      .counter;
  }

  /** The private groups of every owner that has any, re-assembled only when the counter moved. */
  owners(): PrivateKeyOwners {
    const version = this.version();

    if (this.#cached.version !== version) {
      const byOwner = new Map<string, StoredGroup[]>();

      for (const group of this.#stored()) {
        const list = byOwner.get(group.owner) ?? [];
        list.push(group);
        byOwner.set(group.owner, list);
      }

      this.#cached = {
        version,
        configs: new Map(
          [...byOwner].map(([owner, groups]) => [owner, this.#assemble(version, owner, groups)]),
        ),
      };
    }

    return { version, configs: [...this.#cached.configs.values()] };
  }

  /** The private groups of `owner`; empty when there are none. */
  configOf(owner: string): PrivateKeyConfig {
    const version = this.version();

    return (
      this.owners().configs.find((config) => config.owner === owner) ??
      this.#assemble(version, owner, [])
    );
  }

  /** The owner of private group `id`, if there is one. */
  ownerOf(id: string): string | undefined {
    return this.#sql
      .exec<{ owner: string }>(`SELECT owner FROM ${TABLE} WHERE id = ?`, id)
      .toArray()[0]?.owner;
  }

  /**
   * Writes, or deletes (`group: null`), one group of `owner` at the revision the change names. A kept key carries its
   * `id`, which must be a key of this group; a new one gets a random id (never a content hash: a private key equal to
   * a shared one must not share its credential id).
   */
  write(
    owner: string,
    change: KeyGroupChange,
    by: string,
  ): WriteResult<{ readonly id: string; readonly revision: number }> {
    try {
      return this.#transaction(() => this.#write(owner, change, by));
    } catch (error) {
      if (error instanceof Refusal) return error.result;

      throw error;
    }
  }

  /** Deletes every private group of `owner` (a member who left the org, ADR 0027); the number removed. */
  removeOwner(owner: string): number {
    return this.#transaction(() => {
      const removed = this.#sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE owner = ?`, owner)
        .one().n;

      if (removed === 0) return 0;
      this.#sql.exec(`DELETE FROM ${TABLE} WHERE owner = ?`, owner);
      this.#sql.exec(`UPDATE private_key_changes SET counter = counter + 1 WHERE id = 1`);

      return removed;
    });
  }

  /**
   * Disables or enables one private key by its credential id, the way a shared key is (`ConfigStore.setKeyExcludedAll`):
   * `*` joins or leaves its `excluded-models`. The key's group keeps its revision, so the owner's open form still saves.
   * `undefined`: no private key has that id.
   */
  setKeyExcludedAll(
    credentialId: string,
    disabled: boolean,
  ): { readonly owner: string } | undefined {
    return this.#transaction(() => {
      const stored = this.#stored().find((group) =>
        isJsonArray(group.group.keys)
          ? group.group.keys.some((key) => isJsonObject(key) && key.id === credentialId)
          : false,
      );

      if (stored === undefined || !isJsonArray(stored.group.keys)) return undefined;

      const inherited = patternsOf(stored.group["excluded-models"]);

      const keys = stored.group.keys.map((key): Json => {
        if (!isJsonObject(key) || key.id !== credentialId) return key;

        const effective = Array.isArray(key["excluded-models"])
          ? patternsOf(key["excluded-models"])
          : inherited;

        const isStar = (pattern: string) => pattern.trim() === "*";

        const next = disabled
          ? effective.some(isStar)
            ? effective
            : [...effective, "*"]
          : effective.filter((pattern) => !isStar(pattern));

        const { "excluded-models": _own, ...rest } = key;

        return jsonEquals(next, inherited) ? rest : { ...rest, "excluded-models": next };
      });

      this.#sql.exec(
        `UPDATE ${TABLE} SET value = ?, updated_at = ? WHERE id = ?`,
        this.#seal(stored.id, { ...stored.group, keys }),
        this.#now(),
        stored.id,
      );
      this.#sql.exec(`UPDATE private_key_changes SET counter = counter + 1 WHERE id = 1`);

      return { owner: stored.owner };
    });
  }

  #write(
    owner: string,
    change: KeyGroupChange,
    by: string,
  ): WriteResult<{ readonly id: string; readonly revision: number }> {
    const existing =
      change.id === undefined
        ? undefined
        : this.#stored().find((group) => group.id === change.id && group.owner === owner);

    if (change.id !== undefined && existing === undefined)
      throw new Refusal(
        change.revision === 0
          ? refused("not_found", "key group not found")
          : refused("conflict", "the key group was deleted"),
      );

    if (existing !== undefined && existing.family !== change.family)
      throw new Refusal(refused("not_found", "key group not found"));

    if (existing === undefined && change.revision !== 0)
      throw new Refusal(refused("conflict", "a new key group is written at revision 0"));

    if (existing !== undefined && existing.revision !== change.revision)
      throw new Refusal(
        refused(
          "conflict",
          `key group is at revision ${existing.revision}, not ${change.revision}`,
        ),
      );

    this.#sql.exec(`UPDATE private_key_changes SET counter = counter + 1 WHERE id = 1`);
    const version = this.version();

    if (change.group === null) {
      if (existing === undefined) throw new Refusal(refused("not_found", "key group not found"));
      this.#sql.exec(`DELETE FROM ${TABLE} WHERE id = ?`, existing.id);

      return { ok: true, version, id: existing.id, revision: 0 };
    }

    const id = existing?.id ?? freshEntryId(GROUP_ID_KIND);
    const group = this.#withKeyIds(change.family, id, change.group, existing);

    const position =
      existing?.position ??
      this.#stored().filter((other) => other.owner === owner && other.family === change.family)
        .length;

    this.#sql.exec(
      `INSERT INTO ${TABLE} (id, owner, family, position, value, revision, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET value = excluded.value, revision = excluded.revision,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      id,
      owner,
      change.family,
      position,
      this.#seal(id, group),
      version,
      this.#now(),
      by,
    );

    // What the config normaliser would drop of the group (a duplicate key, an endpoint without a base URL) is refused.
    const written = this.#assemble(
      version,
      owner,
      this.#stored().filter((g) => g.owner === owner),
    );

    const kept = written.config["api-keys"][change.family].find((candidate) => candidate.id === id);
    const sent = Array.isArray(group.keys) ? group.keys.length : 0;

    if (sent === 0)
      throw new Refusal(refused("invalid", "a private key group needs at least one key"));

    if (kept === undefined || kept.keys.length !== sent)
      throw new Refusal(
        refused("invalid", "the key group is not valid: a key or the group would be dropped"),
      );

    return { ok: true, version, id, revision: version };
  }

  /** `group` with an id on every key: a kept key's id must be one of the stored group's keys. */
  #withKeyIds(
    family: ProviderKeyFamily,
    id: string,
    group: JsonObject,
    stored: StoredGroup | undefined,
  ): JsonObject {
    const known = new Set(
      (isJsonArray(stored?.group.keys) ? stored.group.keys : []).flatMap((key) =>
        isJsonObject(key) && typeof key.id === "string" ? [key.id] : [],
      ),
    );

    const kind = providerKeyIdKind(
      family,
      typeof group.name === "string" ? { name: group.name } : {},
    );

    const keys = (isJsonArray(group.keys) ? group.keys : []).map((raw): JsonObject => {
      const key = isJsonObject(raw) ? raw : {};

      if (key.id === undefined) return { ...key, id: freshEntryId(kind) };

      if (typeof key.id !== "string" || !known.has(key.id))
        throw new Refusal(
          refused("conflict", "a provider key of this group changed since it was read"),
        );

      return key;
    });

    return { ...group, id, keys };
  }

  #stored(): StoredGroup[] {
    return this.#sql
      .exec<GroupSqlRow>(
        `SELECT id, owner, family, position, value, revision FROM ${TABLE} ORDER BY owner, family, position, id`,
      )
      .toArray()
      .flatMap((row): StoredGroup[] => {
        // SAFETY: the value opened is the JSON text `write` sealed.
        const opened = JSON.parse(this.#secrets.open(row.value, `${TABLE}/${row.id}`)) as Json;

        // Only `write` stores a row, with a valid family and an object.
        if (!isFamily(row.family) || !isJsonObject(opened)) return [];

        return [
          {
            id: row.id,
            owner: row.owner,
            family: row.family,
            position: row.position,
            revision: row.revision,
            group: opened,
          },
        ];
      });
  }

  #assemble(version: number, owner: string, groups: ReadonlyArray<StoredGroup>): PrivateKeyConfig {
    const groupRows: GroupRow[] = [];
    const keyRows: KeyRow[] = [];

    for (const stored of groups) {
      const { id: _id, keys, ...value } = stored.group;

      groupRows.push({ id: stored.id, family: stored.family, position: stored.position, value });

      for (const [position, raw] of (isJsonArray(keys) ? keys : []).entries()) {
        if (!isJsonObject(raw) || typeof raw.id !== "string") continue;
        const { id: keyId, ...keyValue } = raw;

        keyRows.push({ id: keyId, groupId: stored.id, position, value: keyValue });
      }
    }

    const document = documentOfEntries({
      settings: [],
      groups: groupRows,
      keys: keyRows,
      aliases: [],
      exclusions: [],
      writeIns: [],
      payload: [],
    });

    return {
      version,
      owner,
      document,
      config: Effect.runSync(decodeConfig(document)),
      revisions: Object.fromEntries(groups.map((stored) => [stored.id, stored.revision])),
    };
  }

  #seal(id: string, value: JsonObject): string {
    return this.#secrets.seal(JSON.stringify(value), `${TABLE}/${id}`);
  }
}

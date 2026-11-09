/**
 * An org's config entries inside its ControlPlane Durable Object (SQLite; ADR 0025). New in the Workers port.
 *
 * Every setting, key group, provider key, model alias, model exclusion, model write-in and payload rule is a row of its own kind's table
 * (`entries.ts`), with an id, a revision, `updated_at` and the principal that wrote it (`updated_by`). Provider keys leave
 * room for an owner (`owner`, `NULL` = the org); private provider keys come with credential ownership.
 *
 * Revisions come from one counter of changes per org (`config_changes`): every write takes the next value, and the
 * entries it changes take that value as their revision. A missing entry has revision 0. A write names the revision of
 * every entry it changes and is refused (`conflict`) when one is stale, so writes to different entries never
 * conflict, and since the counter never goes back, an entry deleted and created again never repeats a revision. The
 * counter is also the version of the assembled config (`snapshot`): readers rebuild their view when it moves.
 *
 * Readers get the `Config` the entries make up (`documentOfEntries`, decoded and normalised like any document). Every
 * write applies its rows and decodes the result inside one storage transaction: a write that would leave an invalid
 * config is rolled back (`invalid`). All methods are synchronous, so a read-check-write is atomic under the Durable
 * Object input gate.
 *
 * Migration: a ControlPlane that stored the config as one document (the single-row `config` table) and has no entries
 * yet imports that document on first use, in one transaction, and keeps the row. The counter continues from the
 * document's version, so every cached view is rebuilt. Not-applied keys are dropped, as on import.
 *
 * Price overrides (ADR 0024) are entries of an org too, in a table of their own (`config_price_overrides`) rather than
 * part of the config document: they take revisions from the same counter, so a write names the revision it is based on
 * and moves the version readers rebuild on, but an import of a Go config document leaves them alone (Go's config has
 * no prices). The table is created when missing, so a ControlPlane that predates it gains it on its next start.
 *
 * Every entry's value is a sealed value (`@commissary/state` `secrets/cipher.ts`): encrypted with the org's data key
 * before it is written and opened on read, so provider keys, headers and any other secret an entry holds are never
 * stored in plain text. Ids, positions, revisions and writers stay readable. `sealPlaintext` seals what was written
 * before encryption (the legacy document included). Price overrides hold no secret and stay readable.
 *
 * Deployment settings (`DEPLOYMENT_SETTINGS`) decide something every org shares; only the `global` org stores them.
 * Another org's store refuses a write or an import that sets one (`invalid`), so a setting never looks applied when it
 * is not: readers take `global`'s value (`config/reader.ts`).
 */
import { Effect, Result } from "effect";
import { MAX_OVERRIDE_PRICE } from "@commissary/contract/prices";
import {
  assignEntryIds,
  freshEntryId,
  withoutEntryIds,
  withStoredKeyIds,
} from "../credentials/key-ids.ts";
import { type Json, type JsonObject, jsonEquals } from "@commissary/json";
import { GLOBAL_ORG, type OrgId } from "@commissary/core";
import { isSealed, type Sealer } from "@commissary/state";
import { decodeConfig, decodeRawConfig, encodeConfig, parseConfigYaml } from "./codec.ts";
import {
  atPath,
  type ChannelRow,
  defaultDocument,
  documentOfEntries,
  type EntryRows,
  entriesOfConfig,
  type GroupRow,
  isSettingPath,
  type KeyRow,
  type PayloadKind,
  type PayloadRow,
  type SettingRow,
} from "./entries.ts";
import { notAppliedSettings } from "./not-applied.ts";
import type { ProviderKeyFamily, Config } from "./schema.ts";

/**
 * Settings that only the `global` org's config may set, with the value read from it: `models.catalog`, the source of
 * the model catalog every org shares (ADR 0021).
 */
export const DEPLOYMENT_SETTINGS: ReadonlyArray<DeploymentSetting> = [
  {
    key: "models.catalog",
    isSet: (config) => config.models.catalog.trim() !== "",
    copy: (config, deployment) =>
      config.models.catalog === deployment.models.catalog
        ? config
        : { ...config, models: { ...config.models, catalog: deployment.models.catalog } },
  },
];

export interface DeploymentSetting {
  /** The setting's key, which is also its entry id. */
  readonly key: string;
  /** Whether `config` sets it (a value other than the default). */
  readonly isSet: (config: Config) => boolean;
  /** `config` with the setting's value taken from `deployment`, the `global` org's config (`config` when equal). */
  readonly copy: (config: Config, deployment: Config) => Config;
}

/** `config` with every deployment setting taken from `deployment`, the `global` org's config. */
export const withDeploymentSettings = (config: Config, deployment: Config): Config =>
  DEPLOYMENT_SETTINGS.reduce((current, setting) => setting.copy(current, deployment), config);

const deploymentRefusal = (keys: ReadonlyArray<string>): string =>
  `${keys.join(", ")}: a deployment setting, set in the global org's config only`;

/** What `getConfig` returns over RPC (plain data only). */
export interface ConfigSnapshotWire {
  /** The org's change counter. */
  readonly version: number;
  /** Canonical JSON document; omitted when the caller already has `version` (`unchanged`). */
  readonly document?: string;
  readonly unchanged: boolean;
  /** Epoch milliseconds of the last write (0 when nothing was stored). */
  readonly updatedAt: number;
  /** The org's price overrides; omitted with the document (`unchanged`). */
  readonly priceOverrides?: ReadonlyArray<PriceOverrideEntry>;
}

/** The prices of a price override: US dollars per million tokens (`usage/pricing.ts`). */
export interface PriceOverrideValue {
  /** The provider key of the usage record (`codex`, `claude`, an OpenAI-compatible endpoint's name, ...). */
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
}

/** A stored price override. */
export interface PriceOverrideEntry extends PriceOverrideValue {
  readonly id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly updated_by: string;
}

/** What the management routes read (`priceOverrideEntries` over RPC): the overrides and the version they were read at. */
export interface PriceOverridesWire {
  readonly version: number;
  readonly overrides: ReadonlyArray<PriceOverrideEntry>;
}

/** A price override write: `value` `null` deletes it; no `id` creates one (`revision` 0). */
export interface PriceOverrideChange {
  readonly id?: string;
  readonly revision: number;
  readonly value: PriceOverrideValue | null;
}

/** The revision of every stored entry by kind (absent = 0). Key groups carry the revision of their keys too. */
export interface EntryRevisions {
  readonly settings: Readonly<Record<string, number>>;
  readonly groups: Readonly<Record<string, number>>;
  readonly aliases: Readonly<Record<string, number>>;
  readonly exclusions: Readonly<Record<string, number>>;
  readonly writeIns: Readonly<Record<string, number>>;
}

/** What the management routes read (`configEntries` over RPC): the assembled config and every entry's revision. */
export interface ConfigEntriesWire extends ConfigSnapshotWire {
  readonly document: string;
  readonly revisions: EntryRevisions;
}

/** A refused write. `conflict`: a named revision is stale; `not_found`: the entry does not exist. */
export interface WriteRefused {
  readonly ok: false;
  readonly error: "conflict" | "invalid" | "not_found";
  readonly message: string;
}

export type WriteResult<A = object> =
  | ({ readonly ok: true; readonly version: number } & A)
  | WriteRefused;

/** One setting write: `value` `null` resets it to its default (removes the entry). */
export interface SettingChange {
  readonly id: string;
  readonly revision: number;
  readonly value: Json | null;
}

/** A key group write: `group` (with its keys; a kept key carries its `id`) or `null` to delete the group. */
export interface KeyGroupChange {
  readonly family: ProviderKeyFamily;
  /** Absent: a new group (`revision` 0). */
  readonly id?: string;
  readonly revision: number;
  readonly group: JsonObject | null;
}

/** The channel rule kinds: `oauth.model-alias`, `oauth.excluded-models` and `models.write-ins`, one entry per channel. */
export type ChannelRuleKind = "aliases" | "exclusions" | "writeIns";

export type ImportResult =
  | {
      readonly ok: true;
      readonly version: number;
      /** Keys of the document that would have no effect here: named, not stored (ADR 0015). */
      readonly notApplied: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly error: "invalid";
      readonly message: string;
      readonly path?: string;
      readonly line?: number;
      readonly column?: number;
    }
  | { readonly ok: false; readonly error: "conflict"; readonly message: string };

const TABLES = {
  settings: "config_settings",
  groups: "config_key_groups",
  keys: "config_provider_keys",
  aliases: "config_model_aliases",
  exclusions: "config_model_exclusions",
  writeIns: "config_model_write_ins",
  payload: "config_payload_rules",
} as const;

type Table = (typeof TABLES)[keyof typeof TABLES];

/** One override per provider and model, however they are cased. */
const PRICE_OVERRIDES = "config_price_overrides";

/** Where a sealed value is stored (`<table>/<row id>`): it opens only there. */
const sealContext = (table: Table | typeof LEGACY_TABLE, id: string): string => `${table}/${id}`;

/** The single-row config document of a ControlPlane from before config entries. */
const LEGACY_TABLE = "config";

const ENTRY_COLUMNS = `revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config_changes (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     counter INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS config_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL, ${ENTRY_COLUMNS})`,
  `CREATE TABLE IF NOT EXISTS config_key_groups (
     id TEXT PRIMARY KEY, family TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, ${ENTRY_COLUMNS}
   )`,
  `CREATE TABLE IF NOT EXISTS config_provider_keys (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL, position INTEGER NOT NULL, owner TEXT, value TEXT NOT NULL,
     ${ENTRY_COLUMNS}
   )`,
  `CREATE TABLE IF NOT EXISTS config_model_aliases (id TEXT PRIMARY KEY, value TEXT NOT NULL, ${ENTRY_COLUMNS})`,
  `CREATE TABLE IF NOT EXISTS config_model_exclusions (id TEXT PRIMARY KEY, value TEXT NOT NULL, ${ENTRY_COLUMNS})`,
  `CREATE TABLE IF NOT EXISTS config_model_write_ins (id TEXT PRIMARY KEY, value TEXT NOT NULL, ${ENTRY_COLUMNS})`,
  `CREATE TABLE IF NOT EXISTS config_payload_rules (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, ${ENTRY_COLUMNS}
   )`,
  `CREATE TABLE IF NOT EXISTS ${PRICE_OVERRIDES} (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, value TEXT NOT NULL, ${ENTRY_COLUMNS}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS config_price_overrides_model
     ON ${PRICE_OVERRIDES} (provider COLLATE NOCASE, model COLLATE NOCASE)`,
];

/** Who wrote the entries a migration imported. */
export const MIGRATION_PRINCIPAL = "migration";

interface Counter {
  counter: number;
  updated_at: number;
  [column: string]: SqlStorageValue;
}

interface ValueRow {
  id: string;
  value: string;
  revision: number;
  [column: string]: SqlStorageValue;
}

interface GroupSqlRow extends ValueRow {
  family: string;
  position: number;
}

interface KeySqlRow extends ValueRow {
  group_id: string;
  position: number;
}

interface PayloadSqlRow extends ValueRow {
  kind: string;
  position: number;
}

interface PriceSqlRow {
  id: string;
  provider: string;
  model: string;
  value: string;
  revision: number;
  updated_at: number;
  updated_by: string;
  [column: string]: SqlStorageValue;
}

interface LegacyRow {
  version: number;
  document: string;
  [column: string]: SqlStorageValue;
}

/** Thrown inside a write's transaction to roll it back; caught by `#write`. */
class Refusal extends Error {
  readonly refused: WriteRefused;

  constructor(refused: WriteRefused) {
    super(refused.message);
    this.refused = refused;
  }
}

const refuse = (error: WriteRefused["error"], message: string): WriteRefused => ({
  ok: false,
  error,
  message,
});

// SAFETY: every value column opens to the JSON text this store wrote (the legacy document to the one it stored).
const parse = (text: string): Json => JSON.parse(text) as Json;

const objectOf = (value: Json): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};

/** Why a price override's value is refused, if it is (names, then each price a finite number in range). */
const priceRefusal = (value: PriceOverrideValue): string | undefined => {
  if (value.provider.trim() === "" || value.model.trim() === "")
    return "a price override names a provider and a model";

  for (const [name, rate] of [
    ["input", value.input],
    ["output", value.output],
    ["cache_read", value.cache_read],
    ["cache_write", value.cache_write],
  ] as const) {
    if (rate === undefined && (name === "cache_read" || name === "cache_write")) continue;

    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > MAX_OVERRIDE_PRICE)
      return `${name} must be a price from 0 to ${MAX_OVERRIDE_PRICE} US dollars per million tokens`;
  }

  return undefined;
};

export class ConfigStore {
  readonly #sql: SqlStorage;
  readonly #org: OrgId;
  readonly #transaction: <T>(body: () => T) => T;
  readonly #secrets: Sealer;
  readonly #now: () => number;
  #ready = false;
  #cached:
    | { readonly version: number; readonly config: Config; readonly document: string }
    | undefined;

  /**
   * `org`: the org whose config this is (only `global`'s stores the deployment settings); `transaction` runs a body in
   * one storage transaction (`ctx.storage.transactionSync`); `secrets`: the org's data key (`OrgSecrets`), which seals
   * and opens every entry's value.
   */
  constructor(
    sql: SqlStorage,
    org: OrgId,
    transaction: <T>(body: () => T) => T,
    secrets: Sealer,
    now: () => number = Date.now,
  ) {
    this.#sql = sql;
    this.#org = org;
    this.#transaction = transaction;
    this.#secrets = secrets;
    this.#now = now;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  // --- reads ------------------------------------------------------------------------------------------------------

  /** The current config, re-assembled only when the counter moved. */
  current(): { readonly version: number; readonly config: Config; readonly document: string } {
    const { counter } = this.#counter();
    const cached = this.#cached;

    if (cached !== undefined && cached.version === counter) return cached;
    const config = Effect.runSync(decodeConfig(documentOfEntries(this.#rows())));

    this.#cached = { version: counter, config, document: JSON.stringify(encodeConfig(config)) };

    return this.#cached;
  }

  /** The change counter: what `snapshot` and the entry lists report as `version`. */
  version(): number {
    return this.#counter().counter;
  }

  /** The assembled document; `unchanged` (no document) when the caller already has `sinceVersion`. */
  snapshot(sinceVersion?: number): ConfigSnapshotWire {
    const { counter, updated_at: updatedAt } = this.#counter();

    if (sinceVersion !== undefined && sinceVersion === counter)
      return { version: counter, unchanged: true, updatedAt };

    return {
      version: counter,
      unchanged: false,
      document: this.current().document,
      updatedAt,
      priceOverrides: this.priceOverrides(),
    };
  }

  /** The org's price overrides, by provider and model. */
  priceOverrides(): ReadonlyArray<PriceOverrideEntry> {
    return this.#sql
      .exec<PriceSqlRow>(
        `SELECT id, provider, model, value, revision, updated_at, updated_by FROM ${PRICE_OVERRIDES}
         ORDER BY provider, model COLLATE NOCASE, id`,
      )
      .toArray()
      .map((row) => {
        const rates = objectOf(parse(row.value));
        const cacheRead = rates["cache_read"];
        const cacheWrite = rates["cache_write"];

        return {
          id: row.id,
          provider: row.provider,
          model: row.model,
          input: Number(rates["input"]),
          output: Number(rates["output"]),
          ...(typeof cacheRead === "number" ? { cache_read: cacheRead } : {}),
          ...(typeof cacheWrite === "number" ? { cache_write: cacheWrite } : {}),
          revision: row.revision,
          updated_at: row.updated_at,
          updated_by: row.updated_by,
        };
      });
  }

  /** The assembled document with the revision of every entry (`EntryRevisions`). */
  entries(): ConfigEntriesWire {
    const { counter, updated_at: updatedAt } = this.#counter();
    const { document } = this.current();

    const revisions = (table: Table) => {
      const out: Record<string, number> = {};

      for (const row of this.#sql.exec<ValueRow>(`SELECT id, revision FROM ${table}`))
        Object.defineProperty(out, row.id, { value: row.revision, enumerable: true });

      return out;
    };

    return {
      version: counter,
      unchanged: false,
      document,
      updatedAt,
      revisions: {
        settings: revisions(TABLES.settings),
        groups: revisions(TABLES.groups),
        aliases: revisions(TABLES.aliases),
        exclusions: revisions(TABLES.exclusions),
        writeIns: revisions(TABLES.writeIns),
      },
    };
  }

  // --- writes -----------------------------------------------------------------------------------------------------

  /** Writes settings entries; every change names the revision it is based on. */
  writeSettings(
    changes: ReadonlyArray<SettingChange>,
    by: string,
  ): WriteResult<{ readonly revisions: Readonly<Record<string, number>> }> {
    for (const change of changes) {
      if (!isSettingPath(change.id)) return refuse("invalid", `${change.id}: not a setting`);
    }

    if (new Set(changes.map(({ id }) => id)).size !== changes.length)
      return refuse("invalid", "a setting is named more than once");

    if (this.#org !== GLOBAL_ORG) {
      const set = changes.filter(
        (change) =>
          change.value !== null &&
          DEPLOYMENT_SETTINGS.some((setting) => setting.key === change.id) &&
          !jsonEquals(change.value, atPath(defaultDocument(), change.id)),
      );

      if (set.length > 0) return refuse("invalid", deploymentRefusal(set.map(({ id }) => id)));
    }

    return this.#write((revision) => {
      this.#checkRevisions(
        TABLES.settings,
        changes.map(({ id, revision: named }) => ({ id, revision: named })),
      );
      const revisions: Record<string, number> = {};

      for (const change of changes) {
        const reset =
          change.value === null || jsonEquals(change.value, atPath(defaultDocument(), change.id));

        if (reset) this.#sql.exec(`DELETE FROM ${TABLES.settings} WHERE id = ?`, change.id);
        else this.#upsertValue(TABLES.settings, change.id, change.value, revision, by);

        Object.defineProperty(revisions, change.id, {
          value: reset ? 0 : revision,
          enumerable: true,
        });
      }

      return { revisions };
    });
  }

  /** Writes one channel rule (the `aliases`, `exclusions` or `writeIns` of `channel`); `value` `null` deletes it. */
  writeChannelRule(
    kind: ChannelRuleKind,
    channel: string,
    revision: number,
    value: Json | null,
    by: string,
  ): WriteResult<{ readonly revision: number }> {
    const table = TABLES[kind];

    return this.#write((next) => {
      const current = this.#revisionOf(table, channel);

      if (value === null && current === 0)
        throw new Refusal(refuse("not_found", `no ${kind} for ${channel}`));
      this.#checkRevisions(table, [{ id: channel, revision }]);

      if (value === null) this.#sql.exec(`DELETE FROM ${table} WHERE id = ?`, channel);
      else this.#upsertValue(table, channel, value, next, by);

      return { revision: value === null ? 0 : next };
    });
  }

  /**
   * Creates, replaces or deletes (`value: null`) one price override. It names the revision it is based on (0 to create);
   * a second override for a provider and model that already has one is a `conflict`.
   */
  writePriceOverride(
    change: PriceOverrideChange,
    by: string,
  ): WriteResult<{ readonly id: string; readonly revision: number }> {
    const invalid = change.value === null ? undefined : priceRefusal(change.value);

    if (invalid !== undefined) return refuse("invalid", invalid);

    return this.#write((revision) => {
      const existing =
        change.id === undefined
          ? undefined
          : this.#sql
              .exec<PriceSqlRow>(
                `SELECT id, provider, model, value, revision, updated_at, updated_by FROM ${PRICE_OVERRIDES}
                 WHERE id = ?`,
                change.id,
              )
              .toArray()[0];

      if (change.id !== undefined && existing === undefined)
        throw new Refusal(
          change.revision === 0
            ? refuse("not_found", "price override not found")
            : refuse("conflict", "the price override was deleted"),
        );

      if (existing === undefined && change.revision !== 0)
        throw new Refusal(refuse("conflict", "a new price override is written at revision 0"));

      if (existing !== undefined && existing.revision !== change.revision)
        throw new Refusal(
          refuse(
            "conflict",
            `price override is at revision ${existing.revision}, not ${change.revision}`,
          ),
        );

      if (change.value === null) {
        if (existing === undefined)
          throw new Refusal(refuse("invalid", "there is no price override to delete"));
        this.#sql.exec(`DELETE FROM ${PRICE_OVERRIDES} WHERE id = ?`, existing.id);

        return { id: existing.id, revision: 0 };
      }

      const provider = change.value.provider.trim().toLowerCase();
      const model = change.value.model.trim();

      const taken = this.#sql
        .exec<{ id: string }>(
          `SELECT id FROM ${PRICE_OVERRIDES}
           WHERE provider = ? COLLATE NOCASE AND model = ? COLLATE NOCASE AND id IS NOT ?`,
          provider,
          model,
          existing?.id ?? null,
        )
        .toArray()[0];

      if (taken !== undefined)
        throw new Refusal(
          refuse("conflict", `a price override for ${provider} ${model} exists: ${taken.id}`),
        );

      const id = existing?.id ?? freshEntryId("price");

      const rates = {
        input: change.value.input,
        output: change.value.output,
        ...(change.value.cache_read === undefined ? {} : { cache_read: change.value.cache_read }),
        ...(change.value.cache_write === undefined
          ? {}
          : { cache_write: change.value.cache_write }),
      };

      this.#sql.exec(
        `INSERT INTO ${PRICE_OVERRIDES} (id, provider, model, value, revision, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
           value = excluded.value, revision = excluded.revision, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        id,
        provider,
        model,
        JSON.stringify(rates),
        revision,
        this.#now(),
        by,
      );

      return { id, revision };
    });
  }

  /**
   * Writes one key group with its keys, or deletes it (`group: null`). A kept key carries its `id`, which must be a key
   * of this group; a key without one is new and gets an entry id (`assignEntryIds`). The group takes the write's
   * revision; a key takes it when its value or position changed.
   */
  writeKeyGroup(
    change: KeyGroupChange,
    by: string,
  ): WriteResult<{ readonly id: string; readonly revision: number }> {
    // The keys stored in the family's other groups: the write is checked against a read of them that names no
    // revision, so one that landed since must not lose a key to the normaliser's first-wins deduplication.
    let others: ReadonlyArray<string> = [];

    const keepsOthers = (config: Config): void => {
      const ids = new Set(
        config["api-keys"][change.family].flatMap((group) => group.keys.map((key) => key.id)),
      );

      if (others.some((id) => !ids.has(id)))
        throw new Refusal(
          refuse("conflict", "another key group changed with a key equal to one written"),
        );
    };

    return this.#write((revision) => {
      others = this.#sql
        .exec<{ id: string }>(
          `SELECT k.id AS id FROM ${TABLES.keys} k JOIN ${TABLES.groups} g ON g.id = k.group_id
           WHERE g.family = ? AND g.id IS NOT ?`,
          change.family,
          change.id ?? null,
        )
        .toArray()
        .map((row) => row.id);

      const existing =
        change.id === undefined
          ? undefined
          : this.#sql
              .exec<GroupSqlRow>(
                `SELECT id, family, position, value, revision FROM ${TABLES.groups} WHERE id = ?`,
                change.id,
              )
              .toArray()[0];

      if (change.id !== undefined && existing === undefined)
        throw new Refusal(
          change.revision === 0
            ? refuse("not_found", "key group not found")
            : refuse("conflict", "the key group was deleted"),
        );

      if (existing !== undefined && existing.family !== change.family)
        throw new Refusal(refuse("not_found", "key group not found"));

      if (existing === undefined && change.revision !== 0)
        throw new Refusal(refuse("conflict", "a new key group is written at revision 0"));

      if (existing !== undefined && existing.revision !== change.revision)
        throw new Refusal(
          refuse(
            "conflict",
            `key group is at revision ${existing.revision}, not ${change.revision}`,
          ),
        );

      if (change.group === null) {
        if (existing === undefined) throw new Refusal(refuse("not_found", "key group not found"));
        this.#sql.exec(`DELETE FROM ${TABLES.groups} WHERE id = ?`, existing.id);
        this.#sql.exec(`DELETE FROM ${TABLES.keys} WHERE group_id = ?`, existing.id);

        return { id: existing.id, revision: 0 };
      }

      const id = existing?.id ?? this.#freshGroupId();

      const stored = new Map(
        this.#sql
          .exec<KeySqlRow>(
            `SELECT id, group_id, position, value, revision FROM ${TABLES.keys} WHERE group_id = ?`,
            id,
          )
          .toArray()
          .map((row) => [row.id, row]),
      );

      const group = this.#withKeyIds(change.family, id, change.group, stored);
      const { id: _id, keys, ...value } = group;
      const position = existing?.position ?? this.#nextGroupPosition(change.family);

      this.#sql.exec(
        `INSERT INTO ${TABLES.groups} (id, family, position, value, revision, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET value = excluded.value, revision = excluded.revision,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        id,
        change.family,
        position,
        this.#seal(TABLES.groups, id, value),
        revision,
        this.#now(),
        by,
      );

      const written = Array.isArray(keys) ? keys : [];
      const kept = new Set<string>();

      for (const [keyPosition, raw] of written.entries()) {
        const { id: keyId, ...keyValue } =
          typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};

        if (typeof keyId !== "string") throw new Error("a provider key was written without an id");
        kept.add(keyId);
        this.#upsertKey(
          { id: keyId, groupId: id, position: keyPosition, value: keyValue },
          revision,
          by,
        );
      }

      for (const keyId of stored.keys())
        if (!kept.has(keyId)) this.#sql.exec(`DELETE FROM ${TABLES.keys} WHERE id = ?`, keyId);

      return { id, revision };
    }, keepsOthers);
  }

  /**
   * Adds or removes `*` in the `excluded-models` of the provider key `credentialId` (disables it without changing its id).
   * A key's own list replaces its group's, so a key without one starts from the group's. The key and its group take
   * the write's revision. It names no revision: it sets one flag to the state asked for (the last toggle wins), and
   * moving the group's revision makes a group write based on the older group a `conflict` instead of undoing it.
   */
  setKeyExcludedAll(credentialId: string, disabled: boolean, by: string): WriteResult {
    return this.#write((revision) => {
      const key = this.#sql
        .exec<KeySqlRow>(
          `SELECT id, group_id, position, value, revision FROM ${TABLES.keys} WHERE id = ?`,
          credentialId,
        )
        .toArray()[0];

      const group =
        key === undefined
          ? undefined
          : this.#sql
              .exec<GroupSqlRow>(
                `SELECT id, family, position, value, revision FROM ${TABLES.groups} WHERE id = ?`,
                key.group_id,
              )
              .toArray()[0];

      if (key === undefined || group === undefined)
        throw new Refusal(refuse("not_found", "Provider key not found"));
      const value = objectOf(this.#open(TABLES.keys, key.id, key.value));

      const inherited = patterns(
        objectOf(this.#open(TABLES.groups, group.id, group.value))["excluded-models"],
      );

      const own = value["excluded-models"];
      const effective = Array.isArray(own) ? patterns(own) : inherited;
      const disabling = (pattern: string) => pattern.trim() === "*";

      const next = disabled
        ? effective.some(disabling)
          ? effective
          : [...effective, "*"]
        : effective.filter((pattern) => !disabling(pattern));

      if (jsonEquals(next, inherited)) delete value["excluded-models"];
      else value["excluded-models"] = next;

      this.#upsertKey(
        { id: key.id, groupId: key.group_id, position: key.position, value },
        revision,
        by,
      );
      this.#sql.exec(
        `UPDATE ${TABLES.groups} SET revision = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        revision,
        this.#now(),
        by,
        group.id,
      );

      return {};
    });
  }

  /**
   * Replaces every entry with a Go config document (`text`, YAML or JSON, v8 or legacy layout) in one transaction. Key
   * ids in the document are ignored: a provider key whose secret a stored key of its family has keeps that key's id
   * (`withStoredKeyIds`), any other takes the id of the credential it produces (`assignEntryIds`). The not-applied
   * keys are named in the answer and not stored. `basedOn` is the change counter the caller's checks read: the import
   * is refused (`conflict`) when another write landed since.
   */
  importDocument(text: string, by: string, basedOn?: number): ImportResult {
    this.#ensure();
    const parsed = Effect.runSync(Effect.result(parseConfigYaml(text)));

    if (Result.isFailure(parsed)) {
      const { message, path, line, column } = parsed.failure;

      return {
        ok: false,
        error: "invalid",
        message,
        ...(path === undefined ? {} : { path }),
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
      };
    }

    if (this.#org !== GLOBAL_ORG) {
      const set = DEPLOYMENT_SETTINGS.filter((setting) => setting.isSet(parsed.success));

      if (set.length > 0)
        return {
          ok: false,
          error: "invalid",
          message: deploymentRefusal(set.map(({ key }) => key)),
        };
    }

    if (basedOn !== undefined && this.#counter().counter !== basedOn)
      return {
        ok: false,
        error: "conflict",
        message: "the configuration changed since it was read",
      };

    const rows = this.#rowsOf(
      withStoredKeyIds(withoutEntryIds(parsed.success), this.current().config),
    );

    const version = this.#transaction(() => {
      const counter = this.#bump();
      this.#replace(rows, counter, by);

      return counter;
    });

    return { ok: true, version, notApplied: notAppliedSettings(parsed.success) };
  }

  // --- internals --------------------------------------------------------------------------------------------------

  /**
   * Runs `apply` with the write's revision in one transaction, then checks the config it leaves (and `verify` it,
   * which refuses by throwing a `Refusal`).
   */
  #write<A extends object>(
    apply: (revision: number) => A,
    verify?: (config: Config) => void,
  ): WriteResult<A> {
    this.#ensure();

    try {
      return this.#transaction(() => {
        const revision = this.#bump();
        const result = apply(revision);

        const decoded = Effect.runSync(
          Effect.result(decodeConfig(documentOfEntries(this.#rows()))),
        );

        if (Result.isFailure(decoded))
          throw new Refusal(refuse("invalid", decoded.failure.message));

        verify?.(decoded.success);

        return { ok: true as const, version: revision, ...result };
      });
    } catch (error) {
      if (error instanceof Refusal) return error.refused;

      throw error;
    }
  }

  #checkRevisions(
    table: Table,
    named: ReadonlyArray<{ readonly id: string; readonly revision: number }>,
  ): void {
    const stale = named.filter(({ id, revision }) => this.#revisionOf(table, id) !== revision);

    if (stale.length > 0)
      throw new Refusal(
        refuse(
          "conflict",
          `changed since the revision named: ${stale.map(({ id }) => id).join(", ")}`,
        ),
      );
  }

  #revisionOf(table: Table, id: string): number {
    return (
      this.#sql.exec<ValueRow>(`SELECT revision FROM ${table} WHERE id = ?`, id).toArray()[0]
        ?.revision ?? 0
    );
  }

  #upsertValue(table: Table, id: string, value: Json, revision: number, by: string): void {
    this.#sql.exec(
      `INSERT INTO ${table} (id, value, revision, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET value = excluded.value, revision = excluded.revision,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      id,
      this.#seal(table, id, value),
      revision,
      this.#now(),
      by,
    );
  }

  /** Writes a key row; an unchanged key (same group, position and value) keeps its revision. */
  #upsertKey(row: KeyRow, revision: number, by: string): void {
    const current = this.#sql
      .exec<KeySqlRow>(
        `SELECT id, group_id, position, value, revision FROM ${TABLES.keys} WHERE id = ?`,
        row.id,
      )
      .toArray()[0];

    if (
      current !== undefined &&
      current.group_id === row.groupId &&
      current.position === row.position &&
      jsonEquals(this.#open(TABLES.keys, current.id, current.value), row.value)
    )
      return;

    this.#sql.exec(
      `INSERT INTO ${TABLES.keys} (id, group_id, position, owner, value, revision, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, position = excluded.position,
         value = excluded.value, revision = excluded.revision, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      row.id,
      row.groupId,
      row.position,
      this.#seal(TABLES.keys, row.id, row.value),
      revision,
      this.#now(),
      by,
    );
  }

  /**
   * `group` (as written, keys with or without ids) checked and given ids: an id must be one of `stored` (this group's
   * keys), and a key without one gets the id of the credential it produces, unique among every stored key.
   */
  #withKeyIds(
    family: ProviderKeyFamily,
    groupId: string,
    group: JsonObject,
    stored: ReadonlyMap<string, KeySqlRow>,
  ): JsonObject {
    const keys = Array.isArray(group.keys) ? group.keys : [];

    for (const key of keys) {
      const id =
        typeof key === "object" && key !== null && !Array.isArray(key) ? key.id : undefined;

      if (id !== undefined && (typeof id !== "string" || !stored.has(id)))
        throw new Refusal(
          refuse("conflict", "a provider key of this group changed since it was read"),
        );
    }

    const decoded = Effect.runSync(
      Effect.result(decodeRawConfig({ "api-keys": { [family]: [{ ...group, id: groupId }] } })),
    );

    if (Result.isFailure(decoded)) throw new Refusal(refuse("invalid", decoded.failure.message));

    const taken = new Set(
      this.#sql
        .exec<ValueRow>(`SELECT id FROM ${TABLES.keys} WHERE group_id != ?`, groupId)
        .toArray()
        .map((row) => row.id),
    );

    const withIds = assignEntryIds(decoded.success, freshEntryId, taken);
    // SAFETY: the config schema encodes to a plain JSON object.
    const document = encodeConfig(withIds) as JsonObject;
    const written = atPath(document, `api-keys.${family}`);

    const first = Array.isArray(written) ? written[0] : undefined;

    if (typeof first !== "object" || first === null || Array.isArray(first))
      throw new Error("the written key group did not survive its own decode");

    return first;
  }

  #nextGroupPosition(family: ProviderKeyFamily): number {
    const row = this.#sql
      .exec<{ position: number | null; [column: string]: SqlStorageValue }>(
        `SELECT MAX(position) AS position FROM ${TABLES.groups} WHERE family = ?`,
        family,
      )
      .toArray()[0];

    return (row?.position ?? -1) + 1;
  }

  #freshGroupId(): string {
    let id = freshEntryId("group");

    while (this.#revisionOf(TABLES.groups, id) !== 0) id = freshEntryId("group");

    return id;
  }

  #counter(): Counter {
    this.#ensure();

    return (
      this.#sql
        .exec<Counter>("SELECT counter, updated_at FROM config_changes WHERE id = 1")
        .toArray()[0] ?? { counter: 0, updated_at: 0 }
    );
  }

  /** Takes the next value of the counter (inside the caller's transaction). */
  #bump(): number {
    const { counter } = this.#counter();
    const next = counter + 1;

    this.#sql.exec(
      "UPDATE config_changes SET counter = ?, updated_at = ? WHERE id = 1",
      next,
      this.#now(),
    );

    return next;
  }

  #rows(): EntryRows {
    const settings = this.#sql
      .exec<ValueRow>(`SELECT id, value FROM ${TABLES.settings}`)
      .toArray()
      .map((row): SettingRow => ({
        id: row.id,
        value: this.#open(TABLES.settings, row.id, row.value),
      }));

    const groups = this.#sql
      .exec<GroupSqlRow>(`SELECT id, family, position, value FROM ${TABLES.groups}`)
      .toArray()
      .map((row): GroupRow => ({
        id: row.id,
        // SAFETY: only `writeKeyGroup` and `#replace` write this column, with a `ProviderKeyFamily`.
        family: row.family as ProviderKeyFamily,
        position: row.position,
        value: objectOf(this.#open(TABLES.groups, row.id, row.value)),
      }));

    const keys = this.#sql
      .exec<KeySqlRow>(`SELECT id, group_id, position, value FROM ${TABLES.keys}`)
      .toArray()
      .map((row): KeyRow => ({
        id: row.id,
        groupId: row.group_id,
        position: row.position,
        value: objectOf(this.#open(TABLES.keys, row.id, row.value)),
      }));

    const channels = (table: Table): ChannelRow[] =>
      this.#sql
        .exec<ValueRow>(`SELECT id, value FROM ${table}`)
        .toArray()
        .map((row) => ({ id: row.id, value: this.#open(table, row.id, row.value) }));

    const payload = this.#sql
      .exec<PayloadSqlRow>(`SELECT id, kind, position, value FROM ${TABLES.payload}`)
      .toArray()
      .map((row): PayloadRow => ({
        id: row.id,
        // SAFETY: only `#replace` writes this column, with a `PayloadKind`.
        kind: row.kind as PayloadKind,
        position: row.position,
        value: this.#open(TABLES.payload, row.id, row.value),
      }));

    return {
      settings,
      groups,
      keys,
      aliases: channels(TABLES.aliases),
      exclusions: channels(TABLES.exclusions),
      writeIns: channels(TABLES.writeIns),
      payload,
    };
  }

  /** The rows of an imported config (without Go ids): entry ids assigned, not-applied keys left out. */
  #rowsOf(config: Config): EntryRows {
    return entriesOfConfig(assignEntryIds(config), () => freshEntryId("payload"));
  }

  /** Replaces every entry with `rows`, each at `revision` (inside the caller's transaction). */
  #replace(rows: EntryRows, revision: number, by: string): void {
    const now = this.#now();

    for (const table of Object.values(TABLES)) this.#sql.exec(`DELETE FROM ${table}`);

    for (const { id, value } of rows.settings)
      this.#upsertValue(TABLES.settings, id, value, revision, by);

    for (const group of rows.groups)
      this.#sql.exec(
        `INSERT INTO ${TABLES.groups} (id, family, position, value, revision, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        group.id,
        group.family,
        group.position,
        this.#seal(TABLES.groups, group.id, group.value),
        revision,
        now,
        by,
      );

    for (const key of rows.keys) this.#upsertKey(key, revision, by);

    for (const { id, value } of rows.aliases)
      this.#upsertValue(TABLES.aliases, id, value, revision, by);

    for (const { id, value } of rows.exclusions)
      this.#upsertValue(TABLES.exclusions, id, value, revision, by);

    for (const { id, value } of rows.writeIns)
      this.#upsertValue(TABLES.writeIns, id, value, revision, by);

    for (const rule of rows.payload)
      this.#sql.exec(
        `INSERT INTO ${TABLES.payload} (id, kind, position, value, revision, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        rule.id,
        rule.kind,
        rule.position,
        this.#seal(TABLES.payload, rule.id, rule.value),
        revision,
        now,
        by,
      );
  }

  /**
   * Creates the counter on first use. A ControlPlane that stored its config as one document (`config` table) imports
   * it here, keeping the row; the counter continues after the document's version.
   */
  #ensure(): void {
    if (this.#ready) return;

    const present = this.#sql
      .exec<Counter>("SELECT counter, updated_at FROM config_changes WHERE id = 1")
      .toArray()[0];

    if (present === undefined) {
      const legacy = this.#legacyDocument();

      // A stored document that no longer decodes fails here, and the next use tries again: never serve an empty
      // config in its place.
      const legacyConfig =
        legacy === undefined ? undefined : Effect.runSync(decodeConfig(parse(legacy.document)));

      const rows =
        legacyConfig === undefined ? undefined : this.#rowsOf(withoutEntryIds(legacyConfig));

      this.#transaction(() => {
        const counter = legacy === undefined ? 0 : legacy.version + 1;

        this.#sql.exec(
          "INSERT INTO config_changes (id, counter, updated_at) VALUES (1, ?, ?)",
          counter,
          legacy === undefined ? 0 : this.#now(),
        );

        if (rows !== undefined) this.#replace(rows, counter, MIGRATION_PRINCIPAL);
      });

      if (legacyConfig !== undefined) {
        const dropped = notAppliedSettings(legacyConfig);

        if (dropped.length > 0)
          Effect.runSync(
            Effect.logWarning("config migrated to entries; not-applied keys dropped").pipe(
              Effect.annotateLogs({ keys: dropped.join(", ") }),
            ),
          );
      }
    }

    this.#ready = true;
  }

  /** The single-row document of a ControlPlane from before config entries, if any (opened). */
  #legacyDocument(): LegacyRow | undefined {
    if (!this.#hasLegacyTable()) return undefined;

    const row = this.#sql
      .exec<LegacyRow>(`SELECT version, document FROM ${LEGACY_TABLE} WHERE id = 1`)
      .toArray()[0];

    return row === undefined
      ? undefined
      : { ...row, document: this.#secrets.open(row.document, sealContext(LEGACY_TABLE, "1")) };
  }

  #hasLegacyTable(): boolean {
    return (
      this.#sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${LEGACY_TABLE}'`)
        .toArray()[0] !== undefined
    );
  }

  /** `value` sealed for its entry. */
  #seal(table: Table, id: string, value: Json): string {
    return this.#secrets.seal(JSON.stringify(value), sealContext(table, id));
  }

  /** The value of an entry, opened. */
  #open(table: Table, id: string, sealed: string): Json {
    return parse(this.#secrets.open(sealed, sealContext(table, id)));
  }

  /**
   * Seals every value stored in plain text (written before encryption: entries and the legacy document) with
   * `secrets`, inside the caller's transaction; answers how many it sealed.
   */
  sealPlaintext(secrets: Sealer): number {
    let sealed = 0;

    for (const table of Object.values(TABLES)) {
      for (const row of this.#sql.exec<ValueRow>(`SELECT id, value FROM ${table}`).toArray()) {
        if (isSealed(row.value)) continue;
        this.#sql.exec(
          `UPDATE ${table} SET value = ? WHERE id = ?`,
          secrets.seal(row.value, sealContext(table, row.id)),
          row.id,
        );
        sealed += 1;
      }
    }

    if (this.#hasLegacyTable()) {
      for (const row of this.#sql
        .exec<LegacyRow>(`SELECT version, document FROM ${LEGACY_TABLE} WHERE id = 1`)
        .toArray()) {
        if (isSealed(row.document)) continue;
        this.#sql.exec(
          `UPDATE ${LEGACY_TABLE} SET document = ? WHERE id = 1`,
          secrets.seal(row.document, sealContext(LEGACY_TABLE, "1")),
        );
        sealed += 1;
      }
    }

    return sealed;
  }
}

const patterns = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Decodes a stored/wire JSON document into a `Config` (the DO already validated it on write). */
export const decodeStoredConfig = (document: string) =>
  Effect.try({
    try: (): Json => JSON.parse(document),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(decodeConfig));

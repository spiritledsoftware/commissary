/**
 * The triggers configured on hosted agents (#231, ADR 0040), in the org's ControlPlane SQLite: table `agent_triggers`
 * of the Agents part (`AGENTS_TABLES`, dropped by its `wipe()`), one row per trigger with its agent, kind, name, whether
 * it is enabled, its input, what its kind configures (`config`, JSON: a schedule's cron expression and time zone, nothing
 * for a webhook) and a webhook's secret, sealed with the org's data key (ADR 0044: it grants access) for its row
 * (`agent_triggers/<id>`), so a copy of the storage does not show it. The store reads and writes rows; the part decides
 * who may do what.
 *
 * Beside it, table `agent_schedule_objects` lists every schedule whose Durable Object may exist (`AGENT_SCHEDULE`): a
 * schedule's row is added when it is created and goes only once its object was deleted, not with the trigger, so the
 * objects of schedules removed with their agent or their member can still be found and deleted (a sweep, the org's
 * deletion).
 */
import { Option, Schema } from "effect";
import { ConfiguredTriggerKind } from "@commissary/contract/agent-triggers";
import type { Sealer } from "@commissary/state";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_triggers (
     id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
     input TEXT, config TEXT NOT NULL, secret TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS agent_triggers_agent ON agent_triggers (agent_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS agent_schedule_objects (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
];

/** What a trigger's kind configures, as stored: a schedule's cron expression and time zone; a webhook's nothing. */
export const TriggerConfig = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    cron: Schema.String,
    timeZone: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("webhook") }),
]);

export type TriggerConfig = typeof TriggerConfig.Type;

const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(TriggerConfig));

/** A trigger as stored; a webhook's secret is read on its own ({@link TriggerStore.secret}). */
export interface StoredTrigger {
  readonly id: string;
  readonly agent: string;
  readonly name: string;
  readonly enabled: boolean;
  /** A schedule's fixed input, or a webhook's template (none: the body alone). */
  readonly input?: string | undefined;
  readonly config: TriggerConfig;
  readonly revision: number;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

interface TriggerRow {
  [column: string]: SqlStorageValue;
  id: string;
  agent_id: string;
  kind: string;
  name: string;
  enabled: number;
  input: string | null;
  config: string;
  secret: string | null;
  revision: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
}

const isKind = Schema.is(ConfiguredTriggerKind);

/** The trigger a row holds; `undefined` for a row of a kind or config this version does not know. */
const triggerOf = (row: TriggerRow): StoredTrigger | undefined => {
  const config = Option.getOrUndefined(decodeConfig(row.config));

  if (config === undefined || !isKind(row.kind) || config.kind !== row.kind) return undefined;

  return {
    id: row.id,
    agent: row.agent_id,
    name: row.name,
    enabled: row.enabled === 1,
    ...(row.input === null ? {} : { input: row.input }),
    config,
    revision: row.revision,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
};

/** Where a webhook's secret is sealed: its row. */
const secretContext = (id: string): string => `agent_triggers/${id}`;

/** A new trigger's id: `trg_` and 32 hex digits, random (128 bits): a webhook's URL names it, so it is unguessable. */
export const freshTriggerId = (): string => `trg_${crypto.randomUUID().replaceAll("-", "")}`;

/** Whether `text` has the shape of an id {@link freshTriggerId} makes. */
export const isTriggerId = (text: string): boolean => /^trg_[0-9a-f]{32}$/.test(text);

export class TriggerStore {
  readonly #sql: SqlStorage;
  readonly #secrets: Sealer;

  constructor(sql: SqlStorage, secrets: Sealer) {
    this.#sql = sql;
    this.#secrets = secrets;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  trigger(id: string): StoredTrigger | undefined {
    const row = this.#sql
      .exec<TriggerRow>(`SELECT * FROM agent_triggers WHERE id = ?`, id)
      .toArray()[0];

    return row === undefined ? undefined : triggerOf(row);
  }

  /** The triggers of `agent`, oldest first. */
  ofAgent(agent: string): ReadonlyArray<StoredTrigger> {
    return this.#sql
      .exec<TriggerRow>(
        `SELECT * FROM agent_triggers WHERE agent_id = ? ORDER BY created_at, id`,
        agent,
      )
      .toArray()
      .flatMap((row) => triggerOf(row) ?? []);
  }

  /** Writes `trigger` (a new one, or a new revision); `secret` replaces a webhook's secret, sealed, when given. */
  put(trigger: StoredTrigger, secret?: string): void {
    const sealed =
      secret === undefined ? null : this.#secrets.seal(secret, secretContext(trigger.id));

    this.#sql.exec(
      `INSERT INTO agent_triggers
         (id, agent_id, kind, name, enabled, input, config, secret, revision, created_at, created_by, updated_at,
          updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, enabled = excluded.enabled, input = excluded.input, config = excluded.config,
         secret = COALESCE(excluded.secret, agent_triggers.secret), revision = excluded.revision,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      trigger.id,
      trigger.agent,
      trigger.config.kind,
      trigger.name,
      trigger.enabled ? 1 : 0,
      trigger.input ?? null,
      JSON.stringify(trigger.config),
      sealed,
      trigger.revision,
      trigger.createdAt,
      trigger.createdBy,
      trigger.updatedAt,
      trigger.updatedBy,
    );
  }

  /** A webhook's secret, opened; `undefined` for a trigger without one. */
  secret(id: string): string | undefined {
    const sealed = this.#sql
      .exec<{ secret: string | null }>(`SELECT secret FROM agent_triggers WHERE id = ?`, id)
      .toArray()[0]?.secret;

    return sealed === undefined || sealed === null
      ? undefined
      : this.#secrets.open(sealed, secretContext(id));
  }

  delete(id: string): void {
    this.#sql.exec(`DELETE FROM agent_triggers WHERE id = ?`, id);
  }

  /** Deletes every trigger of `agent`: it was removed. */
  deleteOfAgent(agent: string): void {
    this.#sql.exec(`DELETE FROM agent_triggers WHERE agent_id = ?`, agent);
  }

  /** Notes that the schedule `id`'s object may exist from now on, until {@link forgetScheduleObjects}. */
  addScheduleObject(id: string, at: number): void {
    this.#sql.exec(
      `INSERT OR IGNORE INTO agent_schedule_objects (id, created_at) VALUES (?, ?)`,
      id,
      at,
    );
  }

  /**
   * Up to `limit` schedules whose object may exist, oldest first; only those whose trigger is gone when `retired`.
   */
  scheduleObjects(limit: number, retired: boolean): ReadonlyArray<string> {
    const where = retired
      ? `WHERE NOT EXISTS (SELECT 1 FROM agent_triggers WHERE agent_triggers.id = agent_schedule_objects.id)`
      : "";

    return this.#sql
      .exec<{ id: string }>(
        `SELECT id FROM agent_schedule_objects ${where} ORDER BY created_at, id LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row) => row.id);
  }

  /** Forgets the schedules `ids`, whose objects were deleted. */
  forgetScheduleObjects(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.#sql.exec(`DELETE FROM agent_schedule_objects WHERE id = ?`, id);
  }
}

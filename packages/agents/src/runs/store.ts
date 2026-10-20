/**
 * The org's index of agent runs in its ControlPlane SQLite (#227, ADR 0040): one row per run, naming its agent, its
 * trigger kind, its starter and its idempotency key, with the run's state as its Durable Object last reported it. The
 * run itself (its transcript, its turns) lives in its own Durable Object (`run-object.ts`); this index is what lets the
 * org list a member's runs, find the run an idempotency key already started, and resolve a run's principal (whom it
 * acts as) without reaching the run: the definition its running turn started with ({@link TurnDefinition}). A table of
 * the Agents part (`AGENTS_TABLES`), dropped by its `wipe()`; the org's deletion deletes the runs' objects first.
 *
 * The starter is two columns (`starter_kind`, `starter_id`), though only members start runs for now, so that child runs
 * (#229) and runs no one started (#231) need no migration.
 */
import { Option, Schema } from "effect";
import type { RunStarter } from "@commissary/auth";
import { RunState, TriggerKind } from "@commissary/contract/agent-runs";
import { ThinkingLevel } from "@commissary/contract/agents";
import { ToolScope } from "@commissary/contract/api-keys";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_runs (
     id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, trigger TEXT NOT NULL, starter_kind TEXT NOT NULL,
     starter_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL, turn_definition TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     UNIQUE (agent_id, starter_kind, starter_id, idempotency_key)
   )`,
  `CREATE INDEX IF NOT EXISTS agent_runs_starter ON agent_runs (starter_kind, starter_id, updated_at)`,
];

/**
 * The agent's definition as a turn read it when it started, with whom the run acts as: the reach of every call of that
 * turn (ADR 0040: an edit, a disable or a revoked grant applies from the next turn).
 */
export const TurnDefinition = Schema.Struct({
  actsAs: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("member"),
      memberId: Schema.String,
      email: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("agent") }),
  ]),
  model: Schema.String,
  thinking: Schema.optionalKey(ThinkingLevel),
  instructions: Schema.String,
  toolScope: ToolScope,
});

export type TurnDefinition = typeof TurnDefinition.Type;

const decodeDefinition = Schema.decodeUnknownOption(Schema.fromJsonString(TurnDefinition));

/** A run as the index keeps it. */
export interface StoredRun {
  readonly id: string;
  readonly agent: string;
  readonly trigger: TriggerKind;
  readonly starter: RunStarter;
  readonly idempotencyKey: string;
  readonly state: RunState;
  /** The definition its latest turn started with; none before its first turn. */
  readonly definition?: TurnDefinition | undefined;
  readonly createdAt: number;
  /** Its last activity: when it was started, or its state last changed. */
  readonly updatedAt: number;
}

interface RunRow {
  [column: string]: SqlStorageValue;
  id: string;
  agent_id: string;
  trigger: string;
  starter_kind: string;
  starter_id: string;
  idempotency_key: string;
  state: string;
  turn_definition: string | null;
  created_at: number;
  updated_at: number;
}

const isTrigger = Schema.is(TriggerKind);

const isState = Schema.is(RunState);

const runOf = (row: RunRow): StoredRun => {
  const definition =
    row.turn_definition === null
      ? undefined
      : Option.getOrUndefined(decodeDefinition(row.turn_definition));

  return {
    id: row.id,
    agent: row.agent_id,
    trigger: isTrigger(row.trigger) ? row.trigger : "chat",
    starter: { kind: "member", id: row.starter_id },
    idempotencyKey: row.idempotency_key,
    state: isState(row.state) ? row.state : "idle",
    ...(definition === undefined ? {} : { definition }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/** A new run's id: `ar_` and 32 hex digits, random. */
export const freshRunId = (): string => `ar_${crypto.randomUUID().replaceAll("-", "")}`;

export class RunStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  run(id: string): StoredRun | undefined {
    const row = this.#sql.exec<RunRow>(`SELECT * FROM agent_runs WHERE id = ?`, id).toArray()[0];

    return row === undefined ? undefined : runOf(row);
  }

  /** The run `starter` started of `agent` with `idempotencyKey`, if any. */
  byKey(agent: string, starter: RunStarter, idempotencyKey: string): StoredRun | undefined {
    const row = this.#sql
      .exec<RunRow>(
        `SELECT * FROM agent_runs
         WHERE agent_id = ? AND starter_kind = ? AND starter_id = ? AND idempotency_key = ?`,
        agent,
        starter.kind,
        starter.id,
        idempotencyKey,
      )
      .toArray()[0];

    return row === undefined ? undefined : runOf(row);
  }

  /** The runs `starter` started, the latest activity first. */
  startedBy(starter: RunStarter): ReadonlyArray<StoredRun> {
    return this.#sql
      .exec<RunRow>(
        `SELECT * FROM agent_runs WHERE starter_kind = ? AND starter_id = ?
         ORDER BY updated_at DESC, id DESC`,
        starter.kind,
        starter.id,
      )
      .toArray()
      .map(runOf);
  }

  insert(run: StoredRun): void {
    this.#sql.exec(
      `INSERT INTO agent_runs
         (id, agent_id, trigger, starter_kind, starter_id, idempotency_key, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.agent,
      run.trigger,
      run.starter.kind,
      run.starter.id,
      run.idempotencyKey,
      run.state,
      run.createdAt,
      run.updatedAt,
    );
  }

  /** A turn starts: the run is running, with the definition the turn read. */
  beginTurn(id: string, definition: TurnDefinition, at: number): void {
    this.#sql.exec(
      `UPDATE agent_runs SET state = 'running', turn_definition = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(definition),
      Math.max(at, 0),
      id,
    );
  }

  /** The ids of up to `limit` runs, oldest first: the org's deletion deletes their objects a page at a time. */
  ids(limit: number): ReadonlyArray<string> {
    return this.#sql
      .exec<{ id: string }>(`SELECT id FROM agent_runs ORDER BY created_at, id LIMIT ?`, limit)
      .toArray()
      .map((row) => row.id);
  }

  count(): number {
    return this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_runs`).one().n;
  }

  delete(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.#sql.exec(`DELETE FROM agent_runs WHERE id = ?`, id);
  }

  /** Records the run's state as its object reported it, and the time as its last activity. */
  setState(id: string, state: RunState, at: number): void {
    this.#sql.exec(
      `UPDATE agent_runs SET state = ?, updated_at = ? WHERE id = ?`,
      state,
      Math.max(at, 0),
      id,
    );
  }
}

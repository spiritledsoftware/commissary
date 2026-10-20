/**
 * The org's index of agent runs in its ControlPlane SQLite (#227, ADR 0040): one row per run, naming its agent, its
 * trigger kind, its starter and its idempotency key, with the run's state as its Durable Object last reported it. The
 * run itself (its transcript, its turns) lives in its own Durable Object (`run-object.ts`); this index is what lets the
 * org list a member's runs, find the run an idempotency key already started, and resolve a run's principal (whom it
 * acts as) without reaching the run: the definition its running turn started with ({@link TurnDefinition}). A table of
 * the Agents part (`AGENTS_TABLES`), dropped by its `wipe()`; the org's deletion deletes the runs' objects first.
 *
 * The starter is two columns (`starter_kind`, `starter_id`): a member, or the run that started a child run through the
 * agents toolkit (#229, kind `run`); a run no one started (a shared agent's schedule or webhook, #231) has `none` and an
 * empty id. A run a trigger configured on the agent started names it (`trigger_id`, added by #231 to the table #227
 * created), and one an API key started through the agents toolkit names the key (`api_key_id`, added by #229): an API
 * key sees only the runs it started.
 *
 * **Deleted runs** (#228, ADR 0027). A run deleted with its agent or its member leaves the index at once
 * ({@link RunStore.discard}), with the child runs it started, and theirs (`starter_kind` `run`, #229); a run pruned past
 * the org's retention period for agent runs leaves it alone, never while a turn runs (its child runs are pruned on
 * their own last activity). From then on it answers like an unknown run, and its principal is refused. Its id waits
 * in `agent_run_purges` until its object is deleted (`purge`), which the ControlPlane cannot reach: the app Worker's
 * sweep after the deletion, the API Worker's cron task, or the org's deletion, which pages both tables.
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
  // #228: runs deleted from the index whose objects are still to delete, and the lookups that delete runs.
  `CREATE TABLE IF NOT EXISTS agent_run_purges (id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs (agent_id)`,
  `CREATE INDEX IF NOT EXISTS agent_runs_updated ON agent_runs (updated_at)`,
];

/**
 * Which runs a deletion takes (#228): those the member `member` started or those of the agents `agents`, each with the
 * child runs it started, and theirs; or those whose last activity was before `idleBefore` (epoch ms) and that run no
 * turn now, alone (retention: a child run goes on its own last activity, not its parent's).
 */
export type DiscardedRuns =
  | { readonly member: string }
  | { readonly agents: ReadonlyArray<string> }
  | { readonly idleBefore: number };

const discardedWhere = (
  runs: DiscardedRuns,
): { readonly where: string; readonly value: string | number } =>
  "member" in runs
    ? { where: "starter_kind = 'member' AND starter_id = ?", value: runs.member }
    : "agents" in runs
      ? {
          where: "agent_id IN (SELECT value FROM json_each(?))",
          value: JSON.stringify(runs.agents),
        }
      : { where: "updated_at < ? AND state <> 'running'", value: runs.idleBefore };

/** The starter columns of a run no one started. */
const NO_STARTER = { kind: "none", id: "" } as const;

const starterColumns = (starter: RunStarter | undefined) => starter ?? NO_STARTER;

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
  /** The trigger configured on the agent that started it; none for a chat. */
  readonly triggerId?: string | undefined;
  /** None for a run no one started. */
  readonly starter?: RunStarter | undefined;
  /** The API key that started it through the agents toolkit (#229); none for any other start. */
  readonly apiKeyId?: string | undefined;
  readonly idempotencyKey: string;
  readonly state: RunState;
  /** The definition its latest turn started with; none before its first turn. */
  readonly definition?: TurnDefinition | undefined;
  readonly createdAt: number;
  /**
   * Its last activity: when it was started, or its state last changed (a turn starting or settling, a message to an
   * idle run starting one; a message to a running turn joins it, which is running until it settles).
   */
  readonly updatedAt: number;
}

interface RunRow {
  [column: string]: SqlStorageValue;
  id: string;
  agent_id: string;
  trigger: string;
  trigger_id: string | null;
  starter_kind: string;
  starter_id: string;
  api_key_id: string | null;
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
    ...(row.trigger_id === null ? {} : { triggerId: row.trigger_id }),
    ...(row.starter_kind === "member" || row.starter_kind === "run"
      ? { starter: { kind: row.starter_kind, id: row.starter_id } }
      : {}),
    ...(row.api_key_id === null ? {} : { apiKeyId: row.api_key_id }),
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

    // #231 and #229: the trigger and the API key that started a run, on a table #227 created without them.
    const columns = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info(agent_runs)")
        .toArray()
        .map((column) => column.name),
    );

    if (!columns.has("trigger_id")) sql.exec(`ALTER TABLE agent_runs ADD COLUMN trigger_id TEXT`);

    if (!columns.has("api_key_id")) sql.exec(`ALTER TABLE agent_runs ADD COLUMN api_key_id TEXT`);
  }

  run(id: string): StoredRun | undefined {
    const row = this.#sql.exec<RunRow>(`SELECT * FROM agent_runs WHERE id = ?`, id).toArray()[0];

    return row === undefined ? undefined : runOf(row);
  }

  /** The run `starter` (none: no one) started of `agent` with `idempotencyKey`, if any. */
  byKey(
    agent: string,
    starter: RunStarter | undefined,
    idempotencyKey: string,
  ): StoredRun | undefined {
    const { kind, id } = starterColumns(starter);

    const row = this.#sql
      .exec<RunRow>(
        `SELECT * FROM agent_runs
         WHERE agent_id = ? AND starter_kind = ? AND starter_id = ? AND idempotency_key = ?`,
        agent,
        kind,
        id,
        idempotencyKey,
      )
      .toArray()[0];

    return row === undefined ? undefined : runOf(row);
  }

  /**
   * The runs of `agent`, oldest first, each with its starter as the index holds it: a member, a run (a child run, #229)
   * or none (`none`); for the org export (#228).
   */
  ofAgent(agent: string): ReadonlyArray<{
    readonly run: StoredRun;
    readonly starterKind: string;
    readonly starterId: string;
  }> {
    return this.#sql
      .exec<RunRow>(`SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY created_at, id`, agent)
      .toArray()
      .map((row) => ({
        run: runOf(row),
        starterKind: row.starter_kind,
        starterId: row.starter_id,
      }));
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

  /** How many of the runs `starter` started are running (a turn works, or a child run's first turn is to start). */
  runningStartedBy(starter: RunStarter): number {
    return this.#sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM agent_runs
           WHERE starter_kind = ? AND starter_id = ? AND state = 'running'`,
        starter.kind,
        starter.id,
      )
      .one().count;
  }

  /** The runs the API key `id` started through the agents toolkit, the latest activity first. */
  startedByKey(id: string): ReadonlyArray<StoredRun> {
    return this.#sql
      .exec<RunRow>(
        `SELECT * FROM agent_runs WHERE api_key_id = ? ORDER BY updated_at DESC, id DESC`,
        id,
      )
      .toArray()
      .map(runOf);
  }

  insert(run: StoredRun): void {
    const starter = starterColumns(run.starter);

    this.#sql.exec(
      `INSERT INTO agent_runs
         (id, agent_id, trigger, trigger_id, starter_kind, starter_id, api_key_id, idempotency_key, state, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.agent,
      run.trigger,
      run.triggerId ?? null,
      starter.kind,
      starter.id,
      run.apiKeyId ?? null,
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
      .exec<{ id: string }>(
        `SELECT id FROM agent_runs ORDER BY created_at, id LIMIT ?`,
        Math.max(0, limit),
      )
      .toArray()
      .map((row) => row.id);
  }

  /** How many runs the index holds. */
  count(): number {
    return this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_runs`).one().n;
  }

  /** How many deleted runs' objects are still to delete. */
  queuedCount(): number {
    return this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_run_purges`).one().n;
  }

  /** Forgets the runs `ids`, whose objects were deleted, whether they were deleted from the index already or not. */
  delete(ids: ReadonlyArray<string>): void {
    for (const id of ids) {
      this.#sql.exec(`DELETE FROM agent_runs WHERE id = ?`, id);
      this.#sql.exec(`DELETE FROM agent_run_purges WHERE id = ?`, id);
    }
  }

  /**
   * Deletes `runs` from the index at once, a deletion's with the child runs each started and theirs, and queues their
   * ids for their objects' deletion; answers how many runs it deleted.
   */
  discard(runs: DiscardedRuns, at: number): number {
    const { where, value } = discardedWhere(runs);

    // Retention prunes each run on its own last activity; a deletion takes the runs' child runs with them.
    const children =
      "idleBefore" in runs
        ? ""
        : `UNION SELECT r.id FROM agent_runs r JOIN doomed d ON r.starter_kind = 'run' AND r.starter_id = d.id`;

    const before = this.count();

    this.#sql.exec(
      `INSERT OR IGNORE INTO agent_run_purges (id, queued_at)
       WITH RECURSIVE doomed(id) AS (
         SELECT id FROM agent_runs WHERE ${where}
         ${children}
       )
       SELECT id, ? FROM doomed`,
      value,
      at,
    );
    this.#sql.exec(`DELETE FROM agent_runs WHERE id IN (SELECT id FROM agent_run_purges)`);

    return before - this.count();
  }

  /** The ids of up to `limit` deleted runs whose objects are still to delete, the earliest deleted first. */
  queued(limit: number): ReadonlyArray<string> {
    return this.#sql
      .exec<{ id: string }>(
        `SELECT id FROM agent_run_purges ORDER BY queued_at, id LIMIT ?`,
        Math.max(0, limit),
      )
      .toArray()
      .map((row) => row.id);
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

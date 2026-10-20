/**
 * Agents' storage in the org's ControlPlane SQLite (#226, ADR 0040): the `agents` table (one row per hosted agent, its
 * definition as it stands now: there are no versions) and `agent_grants` (who may use which shared agent). Both are the
 * Agents part's tables ({@link AGENTS_TABLES}), dropped by its `wipe()`. The store only reads and writes rows; the part
 * decides who may do what, and runs a write that touches both tables in one transaction.
 */
import { Option, Schema } from "effect";
import { AgentWatcher, ThinkingLevel } from "@commissary/contract/agents";
import { ToolScope } from "@commissary/contract/api-keys";
import type { GrantSubject } from "@commissary/contract/grants";

/** The Agents part's tables, in the order `wipe()` drops them: the runs' index (`runs/store.ts`) among them. */
export const AGENTS_TABLES = ["agent_runs", "agent_grants", "agents"] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agents (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, owner TEXT, description TEXT NOT NULL,
     instructions TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, tool_scope TEXT NOT NULL,
     enabled INTEGER NOT NULL, watchers TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS agent_grants (
     id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, agent_id TEXT NOT NULL,
     revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
     UNIQUE (subject_kind, subject_id, agent_id)
   )`,
];

/** A hosted agent as stored: a private agent has an `owner` (its member's id), a shared one none. */
export interface StoredAgent {
  readonly id: string;
  readonly name: string;
  readonly owner?: string | undefined;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly thinking?: ThinkingLevel | undefined;
  readonly toolScope: ToolScope;
  readonly enabled: boolean;
  /** A shared agent's watchers as named; always empty for a private agent. */
  readonly watchers: ReadonlyArray<AgentWatcher>;
  readonly revision: number;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/** A stored agent grant: `subject` may use the shared agent `agent`. */
export interface StoredAgentGrant {
  readonly id: string;
  readonly subject: GrantSubject;
  readonly agent: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

interface AgentRow {
  [column: string]: SqlStorageValue;
  id: string;
  name: string;
  owner: string | null;
  description: string;
  instructions: string;
  model: string;
  thinking: string | null;
  tool_scope: string;
  enabled: number;
  watchers: string;
  revision: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
}

interface GrantRow {
  [column: string]: SqlStorageValue;
  id: string;
  subject_kind: string;
  subject_id: string;
  agent_id: string;
  revision: number;
  updated_at: number;
  updated_by: string;
}

const decodeToolScope = Schema.decodeUnknownOption(Schema.fromJsonString(ToolScope));

const decodeWatchers = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(AgentWatcher)),
);

const isThinking = Schema.is(ThinkingLevel);

/** A row as an agent; a tool scope that does not parse (never written so) gives nothing rather than everything. */
const agentOf = (row: AgentRow): StoredAgent => ({
  id: row.id,
  name: row.name,
  ...(row.owner === null ? {} : { owner: row.owner }),
  description: row.description,
  instructions: row.instructions,
  model: row.model,
  ...(row.thinking !== null && isThinking(row.thinking) ? { thinking: row.thinking } : {}),
  toolScope: Option.getOrElse(decodeToolScope(row.tool_scope), (): ToolScope => []),
  enabled: row.enabled === 1,
  watchers: Option.getOrElse(decodeWatchers(row.watchers), (): ReadonlyArray<AgentWatcher> => []),
  revision: row.revision,
  createdAt: row.created_at,
  createdBy: row.created_by,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

/** A row's subject; none for a kind this version does not know (it gives nothing, never everyone). */
const subjectOf = (row: GrantRow): GrantSubject | undefined => {
  switch (row.subject_kind) {
    case "everyone":
      return { kind: "everyone" };
    case "member":
    case "team":
      return { kind: row.subject_kind, id: row.subject_id };
    default:
      return undefined;
  }
};

const grantOf = (row: GrantRow): StoredAgentGrant | undefined => {
  const subject = subjectOf(row);

  return subject === undefined
    ? undefined
    : {
        id: row.id,
        subject,
        agent: row.agent_id,
        revision: row.revision,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
};

const subjectColumns = (subject: GrantSubject): readonly [string, string] =>
  subject.kind === "everyone" ? ["everyone", ""] : [subject.kind, subject.id];

const freshId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

/** A new agent's id. */
export const freshAgentId = (): string => freshId("ag");

/** A new agent grant's id. */
export const freshAgentGrantId = (): string => freshId("agg");

export class AgentStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  // --- agents --------------------------------------------------------------------------------------------------------

  agents(): ReadonlyArray<StoredAgent> {
    return this.#sql.exec<AgentRow>(`SELECT * FROM agents ORDER BY name`).toArray().map(agentOf);
  }

  agent(id: string): StoredAgent | undefined {
    const row = this.#sql.exec<AgentRow>(`SELECT * FROM agents WHERE id = ?`, id).toArray()[0];

    return row === undefined ? undefined : agentOf(row);
  }

  byName(name: string): StoredAgent | undefined {
    const row = this.#sql.exec<AgentRow>(`SELECT * FROM agents WHERE name = ?`, name).toArray()[0];

    return row === undefined ? undefined : agentOf(row);
  }

  /** Inserts a new agent or replaces the one of its id. */
  put(agent: StoredAgent): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO agents
         (id, name, owner, description, instructions, model, thinking, tool_scope, enabled, watchers, revision,
          created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agent.id,
      agent.name,
      agent.owner ?? null,
      agent.description,
      agent.instructions,
      agent.model,
      agent.thinking ?? null,
      JSON.stringify(agent.toolScope),
      agent.enabled ? 1 : 0,
      JSON.stringify(agent.watchers),
      agent.revision,
      agent.createdAt,
      agent.createdBy,
      agent.updatedAt,
      agent.updatedBy,
    );
  }

  /** Deletes an agent with its grants. */
  delete(id: string): void {
    this.#sql.exec(`DELETE FROM agent_grants WHERE agent_id = ?`, id);
    this.#sql.exec(`DELETE FROM agents WHERE id = ?`, id);
  }

  /** Replaces a shared agent's watchers as they are, keeping its revision (a member or team that went is dropped). */
  setWatchers(id: string, watchers: ReadonlyArray<AgentWatcher>): void {
    this.#sql.exec(`UPDATE agents SET watchers = ? WHERE id = ?`, JSON.stringify(watchers), id);
  }

  // --- grants --------------------------------------------------------------------------------------------------------

  grants(): ReadonlyArray<StoredAgentGrant> {
    return this.#sql
      .exec<GrantRow>(`SELECT * FROM agent_grants ORDER BY agent_id, subject_kind, subject_id`)
      .toArray()
      .flatMap((row) => grantOf(row) ?? []);
  }

  grant(id: string): StoredAgentGrant | undefined {
    const row = this.#sql
      .exec<GrantRow>(`SELECT * FROM agent_grants WHERE id = ?`, id)
      .toArray()[0];

    return row === undefined ? undefined : grantOf(row);
  }

  /** The grant `subject` holds of `agent`, if any. */
  grantOfSubject(subject: GrantSubject, agent: string): StoredAgentGrant | undefined {
    const [kind, subjectId] = subjectColumns(subject);

    const row = this.#sql
      .exec<GrantRow>(
        `SELECT * FROM agent_grants WHERE subject_kind = ? AND subject_id = ? AND agent_id = ?`,
        kind,
        subjectId,
        agent,
      )
      .toArray()[0];

    return row === undefined ? undefined : grantOf(row);
  }

  /** Inserts a new grant or replaces the one of its id. */
  putGrant(grant: StoredAgentGrant): void {
    const [kind, subjectId] = subjectColumns(grant.subject);

    this.#sql.exec(
      `INSERT OR REPLACE INTO agent_grants
         (id, subject_kind, subject_id, agent_id, revision, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      grant.id,
      kind,
      subjectId,
      grant.agent,
      grant.revision,
      grant.updatedAt,
      grant.updatedBy,
    );
  }

  deleteGrant(id: string): void {
    this.#sql.exec(`DELETE FROM agent_grants WHERE id = ?`, id);
  }

  /** Deletes the grants that name `subject` (a member who left, a deleted team). */
  forgetSubject(subject: GrantSubject): void {
    const [kind, subjectId] = subjectColumns(subject);

    this.#sql.exec(
      `DELETE FROM agent_grants WHERE subject_kind = ? AND subject_id = ?`,
      kind,
      subjectId,
    );
  }
}

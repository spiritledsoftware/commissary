/**
 * Toolkit storage in the org's ControlPlane SQLite (ADR 0036, ADR 0037): the toolkits, their credentials (secrets
 * sealed with the org's data key), their tool lists and the overrides on their tools. The tables are
 * {@link TOOLS_TABLES}, which the part drops when the org is deleted.
 *
 * A toolkit's owner is a member id for a private toolkit and empty for an org toolkit; a credential's owner is empty
 * for the shared credential and the member's id for a private one. Tools and overrides are keyed by their stable id,
 * the toolkit's id and the tool's upstream name, so neither a rename nor a refresh moves them. A cleared override stays
 * as a row that sets nothing (a tombstone), so its revision never goes back and a write based on an earlier one is
 * refused.
 */
import type { CredentialsAccepted, ToolClass, ToolkitSecret } from "@commissary/contract/tools";
import type { Sealer } from "@commissary/state";
import type { Schema } from "effect";
import type { UpstreamTool } from "../mcp/client.ts";

/** Every table the store creates, which the part's `wipe` drops (test/control-plane.test.ts checks the list). */
export const TOOLS_TABLES = [
  "toolkits",
  "toolkit_credentials",
  "toolkit_tools",
  "tool_overrides",
] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS toolkits (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, owner TEXT NOT NULL,
     accepts TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
     updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, list_built_at INTEGER, list_error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_credentials (
     toolkit_id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, param TEXT NOT NULL, secret TEXT NOT NULL,
     connected_at INTEGER NOT NULL, connected_by TEXT NOT NULL, PRIMARY KEY (toolkit_id, owner)
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_tools (
     toolkit_id TEXT NOT NULL, upstream_name TEXT NOT NULL, description TEXT, input_schema TEXT, annotations TEXT,
     first_seen INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (toolkit_id, upstream_name)
   )`,
  `CREATE TABLE IF NOT EXISTS tool_overrides (
     toolkit_id TEXT NOT NULL, upstream_name TEXT NOT NULL, hidden INTEGER NOT NULL, name TEXT, description TEXT,
     class TEXT, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
     PRIMARY KEY (toolkit_id, upstream_name)
   )`,
];

export interface Toolkit {
  readonly id: string;
  readonly kind: "mcp";
  readonly name: string;
  readonly source: string;
  /** The member of a private toolkit; undefined for an org toolkit. */
  readonly owner: string | undefined;
  readonly accepts: CredentialsAccepted;
  readonly revision: number;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
  readonly listBuiltAt: number | undefined;
  readonly listError: string | undefined;
}

/** A credential without its secret. */
export interface ToolkitCredential {
  readonly toolkitId: string;
  /** The member of a private credential; undefined for the shared one. */
  readonly owner: string | undefined;
  readonly kind: ToolkitSecret["kind"];
  /** The header or query parameter of a `header` or `query` key. */
  readonly param: string | undefined;
  readonly connectedAt: number;
  readonly connectedBy: string;
}

export interface StoredTool {
  readonly toolkitId: string;
  readonly upstreamName: string;
  readonly description: string | undefined;
  readonly inputSchema: Schema.JsonObject | undefined;
  readonly annotations: Schema.JsonObject | undefined;
  /**
   * Which build first listed it, a number that grows with every build of any toolkit: of two tools with one full name,
   * the one seen first keeps it.
   */
  readonly firstSeen: number;
  /** Its place in the source's list. */
  readonly position: number;
}

export interface ToolOverride {
  readonly toolkitId: string;
  readonly upstreamName: string;
  readonly hidden: boolean;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly toolClass: ToolClass | undefined;
  readonly revision: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/** An override's row as stored: a cleared one (`cleared`) sets nothing and keeps the revision it reached. */
export interface StoredOverride extends ToolOverride {
  readonly cleared: boolean;
}

/** The SQL condition of an override that sets something (not a tombstone); the negation of `cleared` in `overrideOf`. */
const LIVE_OVERRIDE = `(hidden = 1 OR name IS NOT NULL OR description IS NOT NULL OR class IS NOT NULL)`;

interface ToolkitRow {
  [column: string]: SqlStorageValue;
  id: string;
  kind: string;
  name: string;
  source: string;
  owner: string;
  accepts: string;
  revision: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  list_built_at: number | null;
  list_error: string | null;
}

interface CredentialRow {
  [column: string]: SqlStorageValue;
  toolkit_id: string;
  owner: string;
  kind: string;
  param: string;
  secret: string;
  connected_at: number;
  connected_by: string;
}

interface ToolRow {
  [column: string]: SqlStorageValue;
  toolkit_id: string;
  upstream_name: string;
  description: string | null;
  input_schema: string | null;
  annotations: string | null;
  first_seen: number;
  position: number;
}

interface OverrideRow {
  [column: string]: SqlStorageValue;
  toolkit_id: string;
  upstream_name: string;
  hidden: number;
  name: string | null;
  description: string | null;
  class: string | null;
  revision: number;
  updated_at: number;
  updated_by: string;
}

const orUndefined = <A>(value: A | null): A | undefined => (value === null ? undefined : value);

const ownerOf = (owner: string): string | undefined => (owner === "" ? undefined : owner);

const parseObject = (text: string | null): Schema.JsonObject | undefined =>
  // SAFETY: the column holds the JSON object this store wrote from a decoded tool.
  text === null ? undefined : (JSON.parse(text) as Schema.JsonObject);

const toolkitOf = (row: ToolkitRow): Toolkit => ({
  id: row.id,
  kind: "mcp",
  name: row.name,
  source: row.source,
  owner: ownerOf(row.owner),
  // SAFETY: the store writes `accepts` from a decoded `CredentialsAccepted`.
  accepts: row.accepts as CredentialsAccepted,
  revision: row.revision,
  createdAt: row.created_at,
  createdBy: row.created_by,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  listBuiltAt: orUndefined(row.list_built_at),
  listError: orUndefined(row.list_error),
});

const credentialOf = (row: CredentialRow): ToolkitCredential => ({
  toolkitId: row.toolkit_id,
  owner: ownerOf(row.owner),
  // SAFETY: the store writes `kind` from a decoded `ToolkitSecret`.
  kind: row.kind as ToolkitSecret["kind"],
  param: row.param === "" ? undefined : row.param,
  connectedAt: row.connected_at,
  connectedBy: row.connected_by,
});

const toolOf = (row: ToolRow): StoredTool => ({
  toolkitId: row.toolkit_id,
  upstreamName: row.upstream_name,
  description: orUndefined(row.description),
  inputSchema: parseObject(row.input_schema),
  annotations: parseObject(row.annotations),
  firstSeen: row.first_seen,
  position: row.position,
});

const overrideOf = (row: OverrideRow): StoredOverride => ({
  toolkitId: row.toolkit_id,
  upstreamName: row.upstream_name,
  hidden: row.hidden === 1,
  name: orUndefined(row.name),
  description: orUndefined(row.description),
  // SAFETY: the store writes `class` from a decoded `ToolClass`.
  toolClass: orUndefined(row.class) as ToolClass | undefined,
  revision: row.revision,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  // The negation of LIVE_OVERRIDE, its SQL form: change both together.
  cleared: row.hidden === 0 && row.name === null && row.description === null && row.class === null,
});

/** Where a credential's secret is sealed: a value opens only where it was written. */
const secretContext = (toolkitId: string, owner: string): string =>
  `toolkit_credentials/${toolkitId}/${owner}`;

/** A fresh toolkit id: no `:`, which separates it from the tool in a stable id. */
export const freshToolkitId = (): string =>
  `tk_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

export class ToolkitStore {
  readonly #sql: SqlStorage;
  readonly #secrets: Sealer;
  readonly #transaction: <T>(body: () => T) => T;

  constructor(sql: SqlStorage, secrets: Sealer, transaction: <T>(body: () => T) => T) {
    this.#sql = sql;
    this.#secrets = secrets;
    this.#transaction = transaction;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  // --- toolkits ---------------------------------------------------------------------------------------------------

  toolkits(): ReadonlyArray<Toolkit> {
    return this.#sql
      .exec<ToolkitRow>(`SELECT * FROM toolkits ORDER BY created_at, id`)
      .toArray()
      .map(toolkitOf);
  }

  toolkit(id: string): Toolkit | undefined {
    const row = this.#sql.exec<ToolkitRow>(`SELECT * FROM toolkits WHERE id = ?`, id).toArray()[0];

    return row === undefined ? undefined : toolkitOf(row);
  }

  insertToolkit(toolkit: Omit<Toolkit, "listBuiltAt" | "listError">): void {
    this.#sql.exec(
      `INSERT INTO toolkits (id, kind, name, source, owner, accepts, revision, created_at, created_by, updated_at,
         updated_by, list_built_at, list_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      toolkit.id,
      toolkit.kind,
      toolkit.name,
      toolkit.source,
      toolkit.owner ?? "",
      toolkit.accepts,
      toolkit.revision,
      toolkit.createdAt,
      toolkit.createdBy,
      toolkit.updatedAt,
      toolkit.updatedBy,
    );
  }

  /** Renames a toolkit or changes what it accepts, moving its revision on. */
  updateToolkit(
    id: string,
    change: { readonly name: string; readonly accepts: CredentialsAccepted },
    by: string,
    now: number,
  ): void {
    this.#sql.exec(
      `UPDATE toolkits SET name = ?, accepts = ?, revision = revision + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
      change.name,
      change.accepts,
      now,
      by,
      id,
    );
  }

  /** Records a build of the tool list: when it succeeded, or why it failed (the last good list stays). */
  setListStatus(
    id: string,
    outcome: { readonly builtAt: number } | { readonly error: string },
  ): void {
    if ("builtAt" in outcome)
      this.#sql.exec(
        `UPDATE toolkits SET list_built_at = ?, list_error = NULL WHERE id = ?`,
        outcome.builtAt,
        id,
      );
    else this.#sql.exec(`UPDATE toolkits SET list_error = ? WHERE id = ?`, outcome.error, id);
  }

  /** Deletes a toolkit with its credentials, tool list and overrides. */
  deleteToolkit(id: string): void {
    this.#transaction(() => {
      for (const table of TOOLS_TABLES)
        this.#sql.exec(
          `DELETE FROM ${table} WHERE ${table === "toolkits" ? "id" : "toolkit_id"} = ?`,
          id,
        );
    });
  }

  // --- credentials ------------------------------------------------------------------------------------------------

  credentials(toolkitId?: string): ReadonlyArray<ToolkitCredential> {
    const rows =
      toolkitId === undefined
        ? this.#sql.exec<CredentialRow>(`SELECT * FROM toolkit_credentials`)
        : this.#sql.exec<CredentialRow>(
            `SELECT * FROM toolkit_credentials WHERE toolkit_id = ?`,
            toolkitId,
          );

    return rows.toArray().map(credentialOf);
  }

  credential(toolkitId: string, owner: string | undefined): ToolkitCredential | undefined {
    const row = this.#row(toolkitId, owner ?? "");

    return row === undefined ? undefined : credentialOf(row);
  }

  #row(toolkitId: string, owner: string): CredentialRow | undefined {
    return this.#sql
      .exec<CredentialRow>(
        `SELECT * FROM toolkit_credentials WHERE toolkit_id = ? AND owner = ?`,
        toolkitId,
        owner,
      )
      .toArray()[0];
  }

  /** The secret of a credential, opened with the org's data key. */
  secret(toolkitId: string, owner: string | undefined): ToolkitSecret | undefined {
    const row = this.#row(toolkitId, owner ?? "");

    if (row === undefined) return undefined;

    if (row.kind === "none") return { kind: "none" };

    // SAFETY: the sealed value is the JSON of the decoded `ToolkitSecret` this store wrote for this context.
    return JSON.parse(
      this.#secrets.open(row.secret, secretContext(toolkitId, row.owner)),
    ) as ToolkitSecret;
  }

  /** Connects (or replaces) a credential, its secret sealed. */
  putCredential(
    toolkitId: string,
    owner: string | undefined,
    secret: ToolkitSecret,
    by: string,
    now: number,
  ): void {
    const key = owner ?? "";

    const sealed =
      secret.kind === "none"
        ? ""
        : this.#secrets.seal(JSON.stringify(secret), secretContext(toolkitId, key));

    const param = secret.kind === "header" || secret.kind === "query" ? secret.name : "";

    this.#sql.exec(
      `INSERT OR REPLACE INTO toolkit_credentials
         (toolkit_id, owner, kind, param, secret, connected_at, connected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      toolkitId,
      key,
      secret.kind,
      param,
      sealed,
      now,
      by,
    );
  }

  deleteCredential(toolkitId: string, owner: string | undefined): boolean {
    return (
      this.#sql.exec(
        `DELETE FROM toolkit_credentials WHERE toolkit_id = ? AND owner = ?`,
        toolkitId,
        owner ?? "",
      ).rowsWritten > 0
    );
  }

  // --- tool lists -------------------------------------------------------------------------------------------------

  tools(toolkitId?: string): ReadonlyArray<StoredTool> {
    const rows =
      toolkitId === undefined
        ? this.#sql.exec<ToolRow>(`SELECT * FROM toolkit_tools ORDER BY toolkit_id, position`)
        : this.#sql.exec<ToolRow>(
            `SELECT * FROM toolkit_tools WHERE toolkit_id = ? ORDER BY position`,
            toolkitId,
          );

    return rows.toArray().map(toolOf);
  }

  /**
   * Replaces a toolkit's tool list with what its source listed: a tool already known keeps when it was first seen, a new
   * one is seen in this build (after every tool stored), and one the source no longer lists drops out. Of two tools
   * with one upstream name the first is kept.
   */
  replaceTools(toolkitId: string, listed: ReadonlyArray<UpstreamTool>): void {
    this.#transaction(() => {
      const seen = new Map(
        this.tools(toolkitId).map((tool) => [tool.upstreamName, tool.firstSeen]),
      );

      const build =
        (this.#sql
          .exec<{ last: number | null }>(`SELECT MAX(first_seen) AS last FROM toolkit_tools`)
          .toArray()[0]?.last ?? 0) + 1;

      this.#sql.exec(`DELETE FROM toolkit_tools WHERE toolkit_id = ?`, toolkitId);
      const written = new Set<string>();

      for (const [position, tool] of listed.entries()) {
        if (written.has(tool.name)) continue;
        written.add(tool.name);

        this.#sql.exec(
          `INSERT INTO toolkit_tools
             (toolkit_id, upstream_name, description, input_schema, annotations, first_seen, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          toolkitId,
          tool.name,
          tool.description ?? null,
          tool.inputSchema === undefined ? null : JSON.stringify(tool.inputSchema),
          tool.annotations === undefined ? null : JSON.stringify(tool.annotations),
          seen.get(tool.name) ?? build,
          position,
        );
      }
    });
  }

  // --- overrides --------------------------------------------------------------------------------------------------

  /** The overrides that set something (no tombstones). */
  overrides(toolkitId?: string): ReadonlyArray<ToolOverride> {
    const rows =
      toolkitId === undefined
        ? this.#sql.exec<OverrideRow>(`SELECT * FROM tool_overrides WHERE ${LIVE_OVERRIDE}`)
        : this.#sql.exec<OverrideRow>(
            `SELECT * FROM tool_overrides WHERE toolkit_id = ? AND ${LIVE_OVERRIDE} ORDER BY upstream_name`,
            toolkitId,
          );

    return rows.toArray().map(overrideOf);
  }

  /** The override row of one tool, a tombstone included. */
  override(toolkitId: string, upstreamName: string): StoredOverride | undefined {
    const row = this.#sql
      .exec<OverrideRow>(
        `SELECT * FROM tool_overrides WHERE toolkit_id = ? AND upstream_name = ?`,
        toolkitId,
        upstreamName,
      )
      .toArray()[0];

    return row === undefined ? undefined : overrideOf(row);
  }

  /** Writes the whole override of a tool at `revision`, or clears it (`value: undefined`), keeping the revision. */
  putOverride(
    toolkitId: string,
    upstreamName: string,
    value:
      | {
          readonly hidden: boolean;
          readonly name: string | undefined;
          readonly description: string | undefined;
          readonly toolClass: ToolClass | undefined;
        }
      | undefined,
    revision: number,
    by: string,
    now: number,
  ): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO tool_overrides
         (toolkit_id, upstream_name, hidden, name, description, class, revision, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      toolkitId,
      upstreamName,
      value?.hidden === true ? 1 : 0,
      value?.name ?? null,
      value?.description ?? null,
      value?.toolClass ?? null,
      revision,
      now,
      by,
    );
  }

  // --- members ----------------------------------------------------------------------------------------------------

  /** Deletes everything of `member`: their private toolkits (with all they hold) and their private credentials. */
  deleteMember(member: string): void {
    this.#transaction(() => {
      for (const toolkit of this.toolkits())
        if (toolkit.owner === member) this.deleteToolkit(toolkit.id);

      this.#sql.exec(`DELETE FROM toolkit_credentials WHERE owner = ?`, member);
    });
  }
}

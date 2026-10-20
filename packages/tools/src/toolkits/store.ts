/**
 * Toolkit storage in the org's ControlPlane SQLite (ADR 0036, ADR 0037): the toolkits, their credentials (secrets
 * sealed with the org's data key), their tool lists, the overrides on their tools, and the upstream sessions the MCP
 * endpoint's calls keep (ADR 0038: at most {@link SESSION_LIFETIME_MS}). The tables are {@link TOOLS_TABLES}, which
 * the part drops when the org is deleted. An OpenAPI toolkit's uploaded document (#203) is kept in chunks
 * ({@link DOCUMENT_CHUNK_BYTES}), so a document of several MB never meets SQLite's limit on one value; one fetched from a
 * URL is not kept, as its tool list holds what a call needs (each tool's {@link OpenApiOperation}). A GraphQL toolkit's
 * uploaded SDL file (#204) is its document too, and the schema its list was last built from is kept the same way
 * (`toolkit_schemas`, as SDL), as a call checks a caller's selection against it.
 *
 * A toolkit's owner is a member id for a private toolkit and empty for an org toolkit; a credential's owner is empty
 * for the shared credential and the member's id for a private one. An upstream session is kept per credential and per
 * member who called on it, so what a stateful upstream keeps in a session of the shared credential never carries from
 * one member to another. Tools and overrides are keyed by their stable id,
 * the toolkit's id and the tool's upstream name, so neither a rename nor a refresh moves them. A cleared override stays
 * as a row that sets nothing (a tombstone), so its revision never goes back and a write based on an earlier one is
 * refused.
 */
import type {
  CredentialSettings,
  CredentialsAccepted,
  SandboxNetwork,
  ToolClass,
  ToolkitCatalogLink,
} from "@commissary/contract/tools";
import { NO_NETWORK, type SandboxAllowance } from "../sandbox/network.ts";
import type { Sealer } from "@commissary/state";
import type { Schema } from "effect";
import type { StoredApprovalRules } from "../approvals/rules.ts";
import type { GraphQLOperation } from "../graphql/schema.ts";
import type { UpstreamSession, UpstreamTool } from "../mcp/client.ts";
import type { JsonPatchOperation } from "../openapi/patch.ts";
import type { OpenApiOperation } from "../openapi/tools.ts";
import type { StoredToolkit } from "./toolkit.ts";
import { freshId } from "../ids.ts";
import { type ClientVia, OAUTH_TABLES } from "../oauth/store.ts";
import type { StoredSecret } from "./secret.ts";

/**
 * Every table of the Tools part keyed by a toolkit (this store's, the tool grants', `grants/store.ts`, and the pending
 * approvals', `approvals/store.ts`), which the part's `wipe` drops with the browser profiles' (`PROFILE_TABLES`,
 * `browser/profiles.ts`, which outlive any toolkit and so are not in this list). `built_in_toolkits` holds what an org says of a built-in toolkit
 * beyond its grants and overrides, which has no `toolkits` row: its approval rules (#201), the sandbox toolkit's network
 * ceiling (#222), the browser toolkit's price per browser hour (#214), and their revision; `sandbox_sessions`, the
 * org's open sandbox sessions (`sandbox/sessions.ts`); `browser_crawls`, who started each of the org's browser crawls
 * (`browser/crawls.ts`); `browser_sessions`, the org's open browser sessions (`browser/session-log.ts`)
 * (test/control-plane.test.ts checks the list). Each but `toolkits` is keyed by `toolkit_id`, so {@link
 * ToolkitStore.deleteToolkit} deletes a toolkit's rows from all of them.
 */
export const TOOLS_TABLES = [
  "toolkits",
  "toolkit_credentials",
  "toolkit_tools",
  "tool_overrides",
  "toolkit_sessions",
  "tool_grants",
  "tool_approvals",
  "built_in_toolkits",
  "toolkit_documents",
  "toolkit_schemas",
  ...OAUTH_TABLES,
  "sandbox_sessions",
  "browser_crawls",
  "browser_sessions",
] as const;

/** The most bytes of an uploaded document one row holds: well within SQLite's limit on one value (2 MB). */
export const DOCUMENT_CHUNK_BYTES = 1024 * 1024;

/** How long before its access token expires an OAuth credential is refreshed (#202). */
export const REFRESH_LEAD_MS = 5 * 60_000;

/** How long an upstream session is kept from when it was opened (ADR 0038: at most seven days, like replay state). */
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS toolkits (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, owner TEXT NOT NULL,
     accepts TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
     updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, list_built_at INTEGER, list_error TEXT, price_micros INTEGER,
     approval_rules TEXT, base_url TEXT, uploaded INTEGER, credential_settings TEXT, catalog TEXT,
     spec_patch TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_credentials (
     toolkit_id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, param TEXT NOT NULL, secret TEXT NOT NULL,
     connected_at INTEGER NOT NULL, connected_by TEXT NOT NULL, via TEXT, expires_at INTEGER, refresh_at INTEGER,
     needs_sign_in INTEGER, PRIMARY KEY (toolkit_id, owner)
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_tools (
     toolkit_id TEXT NOT NULL, upstream_name TEXT NOT NULL, description TEXT, input_schema TEXT, annotations TEXT,
     first_seen INTEGER NOT NULL, position INTEGER NOT NULL, operation TEXT, PRIMARY KEY (toolkit_id, upstream_name)
   )`,
  `CREATE TABLE IF NOT EXISTS tool_overrides (
     toolkit_id TEXT NOT NULL, upstream_name TEXT NOT NULL, hidden INTEGER NOT NULL, name TEXT, description TEXT,
     class TEXT, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, price_micros INTEGER,
     shown INTEGER, PRIMARY KEY (toolkit_id, upstream_name)
   )`,
  `CREATE TABLE IF NOT EXISTS built_in_toolkits (
     toolkit_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, approval_rules TEXT, updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL, network TEXT, computer INTEGER, browser_hour_price_micros INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_sessions (
     toolkit_id TEXT NOT NULL, owner TEXT NOT NULL, member TEXT NOT NULL, protocol_version TEXT NOT NULL,
     session_id TEXT NOT NULL, opened_at INTEGER NOT NULL, PRIMARY KEY (toolkit_id, owner, member)
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_documents (
     toolkit_id TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (toolkit_id, chunk)
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_schemas (
     toolkit_id TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (toolkit_id, chunk)
   )`,
];

/** The tables that keep a text in chunks of {@link DOCUMENT_CHUNK_BYTES}. */
type ChunkTable = "toolkit_documents" | "toolkit_schemas";

/** Columns added after their tables were first created: a table from before gets each, unset. */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, type: string]> = [
  // Prices (#199): every price unset (free).
  ["toolkits", "price_micros", "INTEGER"],
  ["tool_overrides", "price_micros", "INTEGER"],
  // OpenAPI toolkits (#203).
  ["toolkits", "base_url", "TEXT"],
  ["toolkit_tools", "operation", "TEXT"],
  ["tool_overrides", "shown", "INTEGER"],
  // GraphQL toolkits (#204).
  ["toolkit_tools", "graphql", "TEXT"],
  // The credential types of #206: a toolkit from before has no settings.
  ["toolkits", "credential_settings", "TEXT"],
  // The toolkit catalog (#207): a toolkit from before was not added from it.
  ["toolkits", "catalog", "TEXT"],
  ["toolkits", "spec_patch", "TEXT"],
];

/** A credential without its secret. */
export interface ToolkitCredential {
  readonly toolkitId: string;
  /** The member of a private credential; undefined for the shared one. */
  readonly owner: string | undefined;
  readonly kind: StoredSecret["kind"];
  /** The header or query parameter of a `header` or `query` key. */
  readonly param: string | undefined;
  readonly connectedAt: number;
  readonly connectedBy: string;
  /** How an `oauth` credential's client was registered. */
  readonly via: ClientVia | undefined;
  /** When its access token expires (epoch ms), for `oauth` and `client_credentials`. */
  readonly expiresAt: number | undefined;
  /** When the part's alarm gives it a token refresh next (epoch ms); undefined: not scheduled. */
  readonly refreshAt: number | undefined;
  /** Its token refresh failed for good: it is not used until it is signed in to or connected again. */
  readonly needsSignIn: boolean;
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
  /** An OpenAPI tool's operation: what a call needs to make its request. */
  readonly operation: OpenApiOperation | undefined;
  /** A GraphQL tool's root field: what a call needs to make its request. */
  readonly graphql: GraphQLOperation | undefined;
}

/**
 * A tool as a build lists it: an MCP server's, an OpenAPI document's operation or a GraphQL schema's root field, with
 * what a call needs.
 */
export type ListedTool = UpstreamTool & {
  readonly operation?: OpenApiOperation | undefined;
  readonly graphql?: GraphQLOperation | undefined;
};

export interface ToolOverride {
  readonly toolkitId: string;
  readonly upstreamName: string;
  readonly hidden: boolean;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly toolClass: ToolClass | undefined;
  /** What a call of the tool costs, in micro-USD, whatever its toolkit's price (#199); undefined: the toolkit's. */
  readonly priceMicros: number | undefined;
  /** Shows a tool its source hides by default (a deprecated OpenAPI operation, #203). */
  readonly shown: boolean;
  readonly revision: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/** An override's row as stored: a cleared one (`cleared`) sets nothing and keeps the revision it reached. */
export interface StoredOverride extends ToolOverride {
  readonly cleared: boolean;
}

/** The SQL condition of an override that sets something (not a tombstone); the negation of `cleared` in `overrideOf`. */
const LIVE_OVERRIDE = `(hidden = 1 OR name IS NOT NULL OR description IS NOT NULL OR class IS NOT NULL
  OR price_micros IS NOT NULL OR shown = 1)`;

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
  price_micros: number | null;
  approval_rules: string | null;
  base_url: string | null;
  uploaded: number | null;
  credential_settings: string | null;
  catalog: string | null;
  spec_patch: string | null;
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
  via: string | null;
  expires_at: number | null;
  refresh_at: number | null;
  needs_sign_in: number | null;
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
  operation: string | null;
  graphql: string | null;
}

interface SessionRow {
  [column: string]: SqlStorageValue;
  protocol_version: string;
  session_id: string;
}

interface OverrideRow {
  [column: string]: SqlStorageValue;
  toolkit_id: string;
  upstream_name: string;
  hidden: number;
  name: string | null;
  description: string | null;
  class: string | null;
  price_micros: number | null;
  shown: number | null;
  revision: number;
  updated_at: number;
  updated_by: string;
}

const orUndefined = <A>(value: A | null): A | undefined => (value === null ? undefined : value);

const ownerOf = (owner: string): string | undefined => (owner === "" ? undefined : owner);

const parseObject = (text: string | null): Schema.JsonObject | undefined =>
  // SAFETY: the column holds the JSON object this store wrote from a decoded tool.
  text === null ? undefined : (JSON.parse(text) as Schema.JsonObject);

const parseRules = (text: string | null): StoredApprovalRules | undefined =>
  // SAFETY: the column holds the JSON of the cleaned rules this store wrote.
  text === null ? undefined : (JSON.parse(text) as StoredApprovalRules);

const parseSettings = (text: string | null): CredentialSettings | undefined =>
  // SAFETY: the column holds the JSON of decoded `CredentialSettings` this store wrote.
  text === null ? undefined : (JSON.parse(text) as CredentialSettings);

const parseCatalog = (text: string | null): ToolkitCatalogLink | undefined =>
  // SAFETY: the column holds the JSON of a `ToolkitCatalogLink` this store wrote.
  text === null ? undefined : (JSON.parse(text) as ToolkitCatalogLink);

const parsePatch = (text: string | null): ReadonlyArray<JsonPatchOperation> | undefined =>
  // SAFETY: the column holds the JSON of decoded `JsonPatchOperation`s this store wrote.
  text === null ? undefined : (JSON.parse(text) as ReadonlyArray<JsonPatchOperation>);

const parseNetwork = (text: string | null): SandboxNetwork | undefined =>
  // SAFETY: the column holds the JSON of a decoded, normalized `SandboxNetwork` this store wrote.
  text === null ? undefined : (JSON.parse(text) as SandboxNetwork);

/** What an org says of a built-in toolkit beyond its grants and overrides. */
export interface BuiltInSettings {
  readonly approvalRules: StoredApprovalRules | undefined;
  /** The sandbox toolkit's ceiling (its network, #222, and the computer, #223); undefined: none, the default. */
  readonly ceiling: SandboxAllowance | undefined;
  /** The browser toolkit's price per browser hour (#214), in micro-USD; undefined: browser time is free. */
  readonly browserHourPriceMicros: number | undefined;
}

const toolkitOf = (row: ToolkitRow): StoredToolkit => ({
  id: row.id,
  // SAFETY: the store writes `kind` from a stored toolkit's kind.
  kind: row.kind as StoredToolkit["kind"],
  builtIn: false,
  name: row.name,
  source: row.source,
  baseUrl: orUndefined(row.base_url),
  uploaded: row.uploaded === 1,
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
  priceMicros: orUndefined(row.price_micros),
  approvalRules: parseRules(row.approval_rules),
  credentialSettings: parseSettings(row.credential_settings),
  catalog: parseCatalog(row.catalog),
  specPatch: parsePatch(row.spec_patch),
});

const credentialOf = (row: CredentialRow): ToolkitCredential => ({
  toolkitId: row.toolkit_id,
  owner: ownerOf(row.owner),
  // SAFETY: the store writes `kind` from a `StoredSecret`.
  kind: row.kind as StoredSecret["kind"],
  param: row.param === "" ? undefined : row.param,
  connectedAt: row.connected_at,
  connectedBy: row.connected_by,
  // SAFETY: the store writes `via` from an `OAuthSecret`'s `ClientVia`.
  via: (row.via ?? undefined) as ClientVia | undefined,
  expiresAt: orUndefined(row.expires_at),
  refreshAt: orUndefined(row.refresh_at),
  needsSignIn: row.needs_sign_in === 1,
});

/**
 * When the alarm gives a credential with `secret` a token refresh (#202): an `oauth` sign-in {@link REFRESH_LEAD_MS} before its token
 * expires (one without a refresh token when it expires, to mark it as needing sign-in). A client credentials grant
 * mints a token when one is needed, and a static secret never expires.
 */
export const refreshAtOf = (secret: StoredSecret, now: number): number | undefined => {
  if (secret.kind !== "oauth" || secret.expires_at === undefined) return undefined;

  // A token that lives less than twice the lead gets its refresh halfway through its life.
  return secret.refresh_token === undefined
    ? secret.expires_at
    : Math.max(
        secret.expires_at - REFRESH_LEAD_MS,
        now + Math.floor((secret.expires_at - now) / 2),
      );
};

const expiresAtOf = (secret: StoredSecret): number | undefined =>
  "expires_at" in secret ? secret.expires_at : undefined;

const toolOf = (row: ToolRow): StoredTool => ({
  toolkitId: row.toolkit_id,
  upstreamName: row.upstream_name,
  description: orUndefined(row.description),
  inputSchema: parseObject(row.input_schema),
  annotations: parseObject(row.annotations),
  firstSeen: row.first_seen,
  position: row.position,
  // SAFETY: the column holds the JSON of the operation this store wrote from a build.
  operation: row.operation === null ? undefined : (JSON.parse(row.operation) as OpenApiOperation),
  // SAFETY: the column holds the JSON of the root field this store wrote from a build.
  graphql: row.graphql === null ? undefined : (JSON.parse(row.graphql) as GraphQLOperation),
});

const overrideOf = (row: OverrideRow): StoredOverride => ({
  toolkitId: row.toolkit_id,
  upstreamName: row.upstream_name,
  hidden: row.hidden === 1,
  name: orUndefined(row.name),
  description: orUndefined(row.description),
  // SAFETY: the store writes `class` from a decoded `ToolClass`.
  toolClass: orUndefined(row.class) as ToolClass | undefined,
  priceMicros: orUndefined(row.price_micros),
  shown: row.shown === 1,
  revision: row.revision,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  // The negation of LIVE_OVERRIDE, its SQL form: change both together.
  cleared:
    row.hidden === 0 &&
    row.name === null &&
    row.description === null &&
    row.class === null &&
    row.price_micros === null &&
    row.shown !== 1,
});

/** Settings as the `credential_settings` column holds them: none, or their JSON. */
const settingsText = (settings: CredentialSettings | undefined): string | null =>
  settings === undefined ? null : JSON.stringify(settings);

/** Where a credential's secret is sealed: a value opens only where it was written. */
const secretContext = (toolkitId: string, owner: string): string =>
  `toolkit_credentials/${toolkitId}/${owner}`;

/** A fresh toolkit id: no `:`, which separates it from the tool in a stable id. */
export const freshToolkitId = (): string => freshId("tk");

export class ToolkitStore {
  readonly #sql: SqlStorage;
  readonly #secrets: Sealer;
  readonly #transaction: <T>(body: () => T) => T;

  constructor(sql: SqlStorage, secrets: Sealer, transaction: <T>(body: () => T) => T) {
    this.#sql = sql;
    this.#secrets = secrets;
    this.#transaction = transaction;

    // Sessions kept before they were per member (#198) are dropped: the next call opens a new one.
    const sessionColumns = sql
      .exec<{ name: string }>("PRAGMA table_info(toolkit_sessions)")
      .toArray()
      .map((column) => column.name);

    if (sessionColumns.length > 0 && !sessionColumns.includes("member"))
      sql.exec("DROP TABLE toolkit_sessions");

    for (const statement of SCHEMA) sql.exec(statement);

    for (const [table, column, type] of ADDED_COLUMNS) {
      const columns = sql
        .exec<{ name: string }>(`PRAGMA table_info(${table})`)
        .toArray()
        .map((existing) => existing.name);

      if (!columns.includes(column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }

    // Approval rules (#201) came later too: a toolkit from before has none, so no call of it waits.
    const toolkitColumns = sql
      .exec<{ name: string }>(`PRAGMA table_info(toolkits)`)
      .toArray()
      .map((column) => column.name);

    if (!toolkitColumns.includes("approval_rules"))
      sql.exec(`ALTER TABLE toolkits ADD COLUMN approval_rules TEXT`);

    // Whether a toolkit is built from an uploaded document came with GraphQL toolkits (#204): before, an OpenAPI
    // toolkit was when it had no source URL.
    if (!toolkitColumns.includes("uploaded")) {
      sql.exec(`ALTER TABLE toolkits ADD COLUMN uploaded INTEGER`);
      sql.exec(`UPDATE toolkits SET uploaded = 1 WHERE kind = 'openapi' AND source = ''`);
    }

    // OAuth (#202) came after the first credentials: a table from before gets its columns, every one unset.
    const credentialColumns = sql
      .exec<{ name: string }>("PRAGMA table_info(toolkit_credentials)")
      .toArray()
      .map((column) => column.name);

    for (const [column, type] of [
      ["via", "TEXT"],
      ["expires_at", "INTEGER"],
      ["refresh_at", "INTEGER"],
      ["needs_sign_in", "INTEGER"],
    ] as const)
      if (!credentialColumns.includes(column))
        sql.exec(`ALTER TABLE toolkit_credentials ADD COLUMN ${column} ${type}`);

    // So did the sandbox toolkit's network ceiling (#222): a built-in toolkit set before has none, the default.
    const builtInColumns = sql
      .exec<{ name: string }>(`PRAGMA table_info(built_in_toolkits)`)
      .toArray()
      .map((column) => column.name);

    if (!builtInColumns.includes("network"))
      sql.exec(`ALTER TABLE built_in_toolkits ADD COLUMN network TEXT`);

    // And whether it allows the computer (#223): a sandbox toolkit set before does not, the default.
    if (!builtInColumns.includes("computer"))
      sql.exec(`ALTER TABLE built_in_toolkits ADD COLUMN computer INTEGER`);

    // And the browser toolkit's price per browser hour (#214): unset, browser time is free.
    if (!builtInColumns.includes("browser_hour_price_micros"))
      sql.exec(`ALTER TABLE built_in_toolkits ADD COLUMN browser_hour_price_micros INTEGER`);
  }

  // --- toolkits ---------------------------------------------------------------------------------------------------

  toolkits(): ReadonlyArray<StoredToolkit> {
    return this.#sql
      .exec<ToolkitRow>(`SELECT * FROM toolkits ORDER BY created_at, id`)
      .toArray()
      .map(toolkitOf);
  }

  toolkit(id: string): StoredToolkit | undefined {
    const row = this.#sql.exec<ToolkitRow>(`SELECT * FROM toolkits WHERE id = ?`, id).toArray()[0];

    return row === undefined ? undefined : toolkitOf(row);
  }

  /** A new toolkit has no price and no approval rules: they are set afterwards (`updateToolkit`). */
  insertToolkit(
    toolkit: Omit<
      StoredToolkit,
      "builtIn" | "listBuiltAt" | "listError" | "priceMicros" | "approvalRules"
    >,
  ): void {
    this.#sql.exec(
      `INSERT INTO toolkits (id, kind, name, source, owner, accepts, revision, created_at, created_by, updated_at,
         updated_by, list_built_at, list_error, base_url, uploaded, credential_settings, catalog, spec_patch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
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
      toolkit.baseUrl ?? null,
      toolkit.uploaded ? 1 : null,
      settingsText(toolkit.credentialSettings),
      toolkit.catalog === undefined
        ? null
        : JSON.stringify({
            service: toolkit.catalog.service,
            source: toolkit.catalog.source,
            ...(toolkit.catalog.credential === undefined
              ? {}
              : { credential: toolkit.catalog.credential }),
          }),
      toolkit.specPatch === undefined || toolkit.specPatch.length === 0
        ? null
        : JSON.stringify(toolkit.specPatch),
    );
  }

  /**
   * Renames a toolkit, changes what it accepts, its price, its approval rules, its base URL or its credential settings,
   * moving its revision on.
   */
  updateToolkit(
    id: string,
    change: {
      readonly name: string;
      readonly accepts: CredentialsAccepted;
      readonly priceMicros: number | undefined;
      readonly approvalRules: StoredApprovalRules | undefined;
      readonly baseUrl: string | undefined;
      readonly credentialSettings: CredentialSettings | undefined;
    },
    by: string,
    now: number,
  ): void {
    this.#sql.exec(
      `UPDATE toolkits SET name = ?, accepts = ?, price_micros = ?, approval_rules = ?, base_url = ?,
         credential_settings = ?, revision = revision + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
      change.name,
      change.accepts,
      change.priceMicros ?? null,
      change.approvalRules === undefined ? null : JSON.stringify(change.approvalRules),
      change.baseUrl ?? null,
      settingsText(change.credentialSettings),
      now,
      by,
      id,
    );
  }

  /**
   * Replaces a toolkit's approval rules as they are, its revision kept: a member who left leaves them. A stored
   * toolkit's or a built-in one's alike.
   */
  replaceApprovalRules(id: string, rules: StoredApprovalRules | undefined): void {
    const text = rules === undefined ? null : JSON.stringify(rules);

    this.#sql.exec(`UPDATE toolkits SET approval_rules = ? WHERE id = ?`, text, id);
    this.#sql.exec(
      `UPDATE built_in_toolkits SET approval_rules = ? WHERE toolkit_id = ?`,
      text,
      id,
    );
  }

  /**
   * What the org set on the built-in toolkit `id` (#201, #222, #223, #214): its approval rules, its network ceiling and
   * whether it allows the computer (the sandbox toolkit's), its price per browser hour (the browser toolkit's) and the
   * revision and time of the last change, or undefined when it set nothing yet (the toolkit is then
   * at its first revision).
   */
  builtInSettings(id: string):
    | (BuiltInSettings & {
        readonly revision: number;
        readonly updatedAt: number;
        readonly updatedBy: string;
      })
    | undefined {
    const row = this.#sql
      .exec<{
        revision: number;
        approval_rules: string | null;
        network: string | null;
        computer: number | null;
        browser_hour_price_micros: number | null;
        updated_at: number;
        updated_by: string;
      }>(`SELECT * FROM built_in_toolkits WHERE toolkit_id = ?`, id)
      .toArray()[0];

    return row === undefined
      ? undefined
      : {
          revision: row.revision,
          approvalRules: parseRules(row.approval_rules),
          // A ceiling set before the computer (#223) has no computer column yet: it does not allow it.
          ceiling:
            row.network === null && row.computer === null
              ? undefined
              : { network: parseNetwork(row.network) ?? NO_NETWORK, computer: row.computer === 1 },
          browserHourPriceMicros: orUndefined(row.browser_hour_price_micros),
          updatedAt: row.updated_at,
          updatedBy: row.updated_by,
        };
  }

  /** Sets what the org says of the built-in toolkit `id`, moving its revision on from `revision`. */
  updateBuiltIn(
    id: string,
    revision: number,
    settings: BuiltInSettings,
    by: string,
    now: number,
  ): void {
    this.#sql.exec(
      `INSERT INTO built_in_toolkits (toolkit_id, revision, approval_rules, network, computer,
         browser_hour_price_micros, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (toolkit_id) DO UPDATE SET revision = excluded.revision,
         approval_rules = excluded.approval_rules, network = excluded.network, computer = excluded.computer,
         browser_hour_price_micros = excluded.browser_hour_price_micros, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      id,
      revision + 1,
      settings.approvalRules === undefined ? null : JSON.stringify(settings.approvalRules),
      settings.ceiling === undefined ? null : JSON.stringify(settings.ceiling.network),
      settings.ceiling === undefined ? null : Number(settings.ceiling.computer),
      settings.browserHourPriceMicros ?? null,
      now,
      by,
    );
  }

  /**
   * Records a build of the tool list: when it succeeded, with what keeps some of its tools from being called as its
   * error (`warning`), or why it failed (the last good list stays).
   */
  setListStatus(
    id: string,
    outcome:
      | { readonly builtAt: number; readonly warning?: string | undefined }
      | { readonly error: string },
  ): void {
    if ("builtAt" in outcome)
      this.#sql.exec(
        `UPDATE toolkits SET list_built_at = ?, list_error = ? WHERE id = ?`,
        outcome.builtAt,
        outcome.warning ?? null,
        id,
      );
    else this.setListError(id, outcome.error);
  }

  /** Sets the tool list's error (undefined clears it), its tools kept as they are. */
  setListError(id: string, error: string | undefined): void {
    this.#sql.exec(`UPDATE toolkits SET list_error = ? WHERE id = ?`, error ?? null, id);
  }

  /**
   * Moves a toolkit's revision on: its uploaded document was replaced, or a GraphQL toolkit's first one uploaded, which
   * marks it built from an uploaded document from then on.
   */
  documentUploaded(id: string, by: string, now: number): void {
    this.#sql.exec(
      `UPDATE toolkits SET revision = revision + 1, updated_at = ?, updated_by = ?, uploaded = 1 WHERE id = ?`,
      now,
      by,
      id,
    );
  }

  /** Deletes a toolkit with its credentials, tool list, overrides, sessions, tool grants and document. */
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
  secret(toolkitId: string, owner: string | undefined): StoredSecret | undefined {
    const row = this.#row(toolkitId, owner ?? "");

    if (row === undefined) return undefined;

    if (row.kind === "none") return { kind: "none" };

    // SAFETY: the sealed value is the JSON of the `StoredSecret` this store wrote for this context.
    return JSON.parse(
      this.#secrets.open(row.secret, secretContext(toolkitId, row.owner)),
    ) as StoredSecret;
  }

  #sealed(toolkitId: string, owner: string, secret: StoredSecret): string {
    return secret.kind === "none"
      ? ""
      : this.#secrets.seal(JSON.stringify(secret), secretContext(toolkitId, owner));
  }

  /** Connects (or replaces) a credential, its secret sealed. */
  putCredential(
    toolkitId: string,
    owner: string | undefined,
    secret: StoredSecret,
    by: string,
    now: number,
  ): void {
    const key = owner ?? "";
    const param = secret.kind === "header" || secret.kind === "query" ? secret.name : "";

    this.#transaction(() => {
      this.#sql.exec(
        `INSERT OR REPLACE INTO toolkit_credentials
           (toolkit_id, owner, kind, param, secret, connected_at, connected_by, via, expires_at, refresh_at,
            needs_sign_in)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        toolkitId,
        key,
        secret.kind,
        param,
        this.#sealed(toolkitId, key, secret),
        now,
        by,
        secret.kind === "oauth" ? secret.via : null,
        expiresAtOf(secret) ?? null,
        refreshAtOf(secret, now) ?? null,
      );
      // A session belongs to the identity that opened it.
      this.deleteSessions(toolkitId, owner);
    });
  }

  /**
   * Keeps the tokens a refresh or a mint gave a credential (#202), unless it was connected again since `connectedAt`:
   * the identity is the same, so its upstream sessions stay. Answers whether it was kept.
   */
  refreshSecret(
    toolkitId: string,
    owner: string | undefined,
    connectedAt: number,
    secret: StoredSecret,
    now: number,
  ): boolean {
    const key = owner ?? "";

    return (
      this.#sql.exec(
        `UPDATE toolkit_credentials SET secret = ?, expires_at = ?, refresh_at = ?, needs_sign_in = 0
         WHERE toolkit_id = ? AND owner = ? AND connected_at = ?`,
        this.#sealed(toolkitId, key, secret),
        expiresAtOf(secret) ?? null,
        refreshAtOf(secret, now) ?? null,
        toolkitId,
        key,
        connectedAt,
      ).rowsWritten > 0
    );
  }

  /** Marks a credential as needing sign-in (its token refresh failed for good), unless it was connected again since. */
  markNeedsSignIn(toolkitId: string, owner: string | undefined, connectedAt: number): void {
    this.#sql.exec(
      `UPDATE toolkit_credentials SET needs_sign_in = 1, refresh_at = NULL
       WHERE toolkit_id = ? AND owner = ? AND connected_at = ?`,
      toolkitId,
      owner ?? "",
      connectedAt,
    );
  }

  /** Puts a credential's next token refresh off to `at` (one that may pass later failed). */
  deferRefresh(toolkitId: string, owner: string | undefined, at: number): void {
    this.#sql.exec(
      `UPDATE toolkit_credentials SET refresh_at = ? WHERE toolkit_id = ? AND owner = ? AND refresh_at IS NOT NULL`,
      at,
      toolkitId,
      owner ?? "",
    );
  }

  /** The credentials whose token refresh is due at `now`. */
  refreshesDue(now: number): ReadonlyArray<ToolkitCredential> {
    return this.#sql
      .exec<CredentialRow>(
        `SELECT * FROM toolkit_credentials WHERE refresh_at IS NOT NULL AND refresh_at <= ? ORDER BY refresh_at`,
        now,
      )
      .toArray()
      .map(credentialOf);
  }

  /** When the next token refresh is due (epoch ms); `null`: none is scheduled. */
  nextRefreshAt(): number | null {
    return (
      this.#sql
        .exec<{ next: number | null }>(`SELECT MIN(refresh_at) AS next FROM toolkit_credentials`)
        .toArray()[0]?.next ?? null
    );
  }

  deleteCredential(toolkitId: string, owner: string | undefined): boolean {
    return this.#transaction(() => {
      this.deleteSessions(toolkitId, owner);

      return (
        this.#sql.exec(
          `DELETE FROM toolkit_credentials WHERE toolkit_id = ? AND owner = ?`,
          toolkitId,
          owner ?? "",
        ).rowsWritten > 0
      );
    });
  }

  // --- upstream sessions ------------------------------------------------------------------------------------------

  /**
   * The session kept for `member`'s calls on a toolkit's credential (`owner` undefined: the shared one; `member` empty:
   * a caller without a member), unless it expired at `now`.
   */
  session(
    toolkitId: string,
    owner: string | undefined,
    member: string,
    now: number,
  ): UpstreamSession | undefined {
    const row = this.#sql
      .exec<SessionRow>(
        `SELECT protocol_version, session_id FROM toolkit_sessions
         WHERE toolkit_id = ? AND owner = ? AND member = ? AND opened_at > ?`,
        toolkitId,
        owner ?? "",
        member,
        now - SESSION_LIFETIME_MS,
      )
      .toArray()[0];

    return row === undefined
      ? undefined
      : {
          protocolVersion: row.protocol_version,
          ...(row.session_id === "" ? {} : { sessionId: row.session_id }),
        };
  }

  /** Keeps the session `member`'s call opened at `now`, in place of the one before. */
  putSession(
    toolkitId: string,
    owner: string | undefined,
    member: string,
    session: UpstreamSession,
    now: number,
  ): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO toolkit_sessions
         (toolkit_id, owner, member, protocol_version, session_id, opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      toolkitId,
      owner ?? "",
      member,
      session.protocolVersion,
      session.sessionId ?? "",
      now,
    );
  }

  /** Forgets `member`'s session on a toolkit's credential. */
  deleteSession(toolkitId: string, owner: string | undefined, member: string): void {
    this.#sql.exec(
      `DELETE FROM toolkit_sessions WHERE toolkit_id = ? AND owner = ? AND member = ?`,
      toolkitId,
      owner ?? "",
      member,
    );
  }

  /** Forgets every member's session on a toolkit's credential: it was connected again or removed. */
  deleteSessions(toolkitId: string, owner: string | undefined): void {
    this.#sql.exec(
      `DELETE FROM toolkit_sessions WHERE toolkit_id = ? AND owner = ?`,
      toolkitId,
      owner ?? "",
    );
  }

  /** Deletes the sessions expired at `now`; answers when the next one expires (`null`: none is kept). */
  pruneSessions(now: number): number | null {
    this.#sql.exec(`DELETE FROM toolkit_sessions WHERE opened_at <= ?`, now - SESSION_LIFETIME_MS);

    const first = this.#sql
      .exec<{ first: number | null }>(`SELECT MIN(opened_at) AS first FROM toolkit_sessions`)
      .toArray()[0]?.first;

    return first === null || first === undefined ? null : first + SESSION_LIFETIME_MS;
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
  replaceTools(toolkitId: string, listed: ReadonlyArray<ListedTool>): void {
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
             (toolkit_id, upstream_name, description, input_schema, annotations, first_seen, position, operation,
              graphql)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          toolkitId,
          tool.name,
          tool.description ?? null,
          tool.inputSchema === undefined ? null : JSON.stringify(tool.inputSchema),
          tool.annotations === undefined ? null : JSON.stringify(tool.annotations),
          seen.get(tool.name) ?? build,
          position,
          tool.operation === undefined ? null : JSON.stringify(tool.operation),
          tool.graphql === undefined ? null : JSON.stringify(tool.graphql),
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
          readonly priceMicros: number | undefined;
          readonly shown: boolean;
        }
      | undefined,
    revision: number,
    by: string,
    now: number,
  ): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO tool_overrides
         (toolkit_id, upstream_name, hidden, name, description, class, price_micros, shown, revision, updated_at,
          updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      toolkitId,
      upstreamName,
      value?.hidden === true ? 1 : 0,
      value?.name ?? null,
      value?.description ?? null,
      value?.toolClass ?? null,
      value?.priceMicros ?? null,
      value?.shown === true ? 1 : null,
      revision,
      now,
      by,
    );
  }

  // --- uploaded documents -----------------------------------------------------------------------------------------

  /** Keeps `text` as the toolkit's uploaded document, in place of the one before, in chunks of UTF-8 bytes. */
  putDocument(toolkitId: string, text: string): void {
    this.#putChunks("toolkit_documents", toolkitId, text);
  }

  /** The toolkit's uploaded document, if it has one. */
  document(toolkitId: string): string | undefined {
    return this.#chunks("toolkit_documents", toolkitId);
  }

  /** Keeps `sdl` as the schema a GraphQL toolkit's list was built from, in place of the one before. */
  putSchema(toolkitId: string, sdl: string): void {
    this.#putChunks("toolkit_schemas", toolkitId, sdl);
  }

  /** The schema a GraphQL toolkit's list was built from, as SDL, if it has one. */
  schema(toolkitId: string): string | undefined {
    return this.#chunks("toolkit_schemas", toolkitId);
  }

  #putChunks(table: ChunkTable, toolkitId: string, text: string): void {
    const bytes = new TextEncoder().encode(text);

    this.#transaction(() => {
      this.#sql.exec(`DELETE FROM ${table} WHERE toolkit_id = ?`, toolkitId);

      for (
        let start = 0, chunk = 0;
        start < bytes.byteLength;
        start += DOCUMENT_CHUNK_BYTES, chunk += 1
      )
        this.#sql.exec(
          `INSERT INTO ${table} (toolkit_id, chunk, data) VALUES (?, ?, ?)`,
          toolkitId,
          chunk,
          bytes.slice(start, start + DOCUMENT_CHUNK_BYTES).buffer,
        );
    });
  }

  #chunks(table: ChunkTable, toolkitId: string): string | undefined {
    const chunks = this.#sql
      .exec<{ data: ArrayBuffer }>(
        `SELECT data FROM ${table} WHERE toolkit_id = ? ORDER BY chunk`,
        toolkitId,
      )
      .toArray();

    if (chunks.length === 0) return undefined;
    const bytes = new Uint8Array(chunks.reduce((total, { data }) => total + data.byteLength, 0));
    let offset = 0;

    for (const { data } of chunks) {
      bytes.set(new Uint8Array(data), offset);
      offset += data.byteLength;
    }

    return new TextDecoder().decode(bytes);
  }

  // --- members ----------------------------------------------------------------------------------------------------

  /**
   * Deletes everything of `member`: their private toolkits (with all they hold), their private credentials and the
   * sessions opened with them or by their calls on a shared credential.
   */
  deleteMember(member: string): void {
    this.#transaction(() => {
      for (const toolkit of this.toolkits())
        if (toolkit.owner === member) this.deleteToolkit(toolkit.id);

      this.#sql.exec(`DELETE FROM toolkit_credentials WHERE owner = ?`, member);
      this.#sql.exec(`DELETE FROM toolkit_sessions WHERE owner = ? OR member = ?`, member, member);
    });
  }
}

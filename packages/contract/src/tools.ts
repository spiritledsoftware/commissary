/**
 * Toolkits (`/v9/management/toolkits`, `packages/tools/src/management/routes.ts`; ADR 0036, ADR 0037, ADR 0038): the
 * org's and the caller's private toolkits built from remote MCP servers, their credentials, their tool lists and the
 * overrides on their tools. Shared with the browser: imports `effect` and `./errors.ts` only.
 *
 * An org admin adds and manages org toolkits; any member adds private toolkits, which only they see in full (an org
 * admin sees that one exists, and may remove it). A toolkit holds at most one shared credential and one private
 * credential per member; a member's private credential wins for them. Tools are named `<toolkit>_<tool>` and referred
 * to by their stable id, the toolkit's id and the tool's upstream name (`id`: `<toolkit id>:<upstream name>`), so
 * overrides survive renames and refreshes. Edits of a toolkit or an override name its revision in `If-Match` (0 for a
 * new override).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/** What a toolkit is built from; this version builds remote MCP servers (Streamable HTTP) only. */
export const ToolkitKind = Schema.Literals(["mcp"]);

export type ToolkitKind = typeof ToolkitKind.Type;

/** Which credentials an org toolkit accepts; a private toolkit takes its owner's only (`private`). */
export const CredentialsAccepted = Schema.Literals(["shared", "private", "both"]);

export type CredentialsAccepted = typeof CredentialsAccepted.Type;

/** Whether a tool reads or writes (ADR 0038). */
export const ToolClass = Schema.Literals(["read", "write"]);

export type ToolClass = typeof ToolClass.Type;

/** A shared credential (org admins) or the caller's own private one. */
export const CredentialSlot = Schema.Literals(["shared", "private"]);

export type CredentialSlot = typeof CredentialSlot.Type;

/**
 * A toolkit's sign-in at its source, a static secret: none (a source that needs no sign-in), a bearer token, an API key
 * in a named header or query parameter, or basic auth. It is sealed when stored and never answered.
 */
export const ToolkitSecret = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("bearer"), token: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("header"), name: Schema.String, value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("query"), name: Schema.String, value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("basic"),
    username: Schema.String,
    password: Schema.String,
  }),
]);

export type ToolkitSecret = typeof ToolkitSecret.Type;

export type ToolkitSecretKind = ToolkitSecret["kind"];

/** A connected credential, without its secret. Times are ISO. */
export const ToolkitCredentialView = Schema.Struct({
  kind: Schema.Literals(["none", "bearer", "header", "query", "basic"]),
  /** The header or query parameter a `header` or `query` key goes in. */
  name: optional(Schema.String),
  connected_at: Schema.String,
  connected_by: Schema.String,
  /** False for a private credential while the org has private credentials turned off. */
  active: Schema.Boolean,
});

export type ToolkitCredentialView = typeof ToolkitCredentialView.Type;

/** The last build of a toolkit's tool list. */
export const ToolListStatus = Schema.Struct({
  /** When the list was last built (ISO); absent: never. */
  built_at: optional(Schema.String),
  /** Why the last build failed; absent when it succeeded. */
  error: optional(Schema.String),
  /** Tools in the list. */
  tools: Schema.Int,
});

export type ToolListStatus = typeof ToolListStatus.Type;

export const ToolkitOwner = Schema.Struct({
  member_id: Schema.String,
  email: optional(Schema.String),
});

export const ToolkitView = Schema.Struct({
  id: Schema.String,
  kind: ToolkitKind,
  name: Schema.String,
  /** The MCP server's URL. */
  source: Schema.String,
  /** A private toolkit, the caller's own. */
  private: Schema.Boolean,
  accepts: CredentialsAccepted,
  revision: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
  updated_by: Schema.String,
  credentials: Schema.Struct({
    shared: optional(ToolkitCredentialView),
    /** The caller's private credential. */
    mine: optional(ToolkitCredentialView),
    /** Org admins, on an org toolkit: how many members connected a private credential (only that they exist). */
    private_count: optional(Schema.Int),
  }),
  tool_list: ToolListStatus,
  /**
   * A private toolkit whose name an org toolkit took later: it wins for its owner, who should rename it (ADR 0037).
   */
  rename_suggested: optional(Schema.Boolean),
  /** An org toolkit whose name the caller's private toolkit has: hidden for the caller. */
  shadowed: optional(Schema.Boolean),
});

export type ToolkitView = typeof ToolkitView.Type;

/** Another member's private toolkit as an org admin sees it: only that it exists. */
export const LimitedToolkitView = Schema.Struct({
  id: Schema.String,
  private: Schema.Literal(true),
  limited: Schema.Literal(true),
  owner: ToolkitOwner,
  created_at: Schema.String,
});

export type LimitedToolkitView = typeof LimitedToolkitView.Type;

export const ToolkitsList = Schema.Struct({
  toolkits: Schema.Array(ToolkitView),
  /** Org admins: the other members' private toolkits. */
  others: optional(Schema.Array(LimitedToolkitView)),
});

export type ToolkitsList = typeof ToolkitsList.Type;

export const AddToolkit = Schema.Struct({
  /** The MCP server's URL: a public `https:` address (the outbound guard, ADR 0044). */
  source: Schema.String,
  /** Defaults to the slug of the source's host. */
  name: optional(Schema.String),
  /** A private toolkit of the caller; a plain member's toolkit is always private. */
  private: optional(Schema.Boolean),
  /** Org toolkits; default `shared`. */
  accepts: optional(CredentialsAccepted),
  /** Connected at once: the shared credential of an org toolkit, the caller's of a private one. */
  credential: optional(ToolkitSecret),
});

export type AddToolkit = typeof AddToolkit.Type;

export const UpdateToolkit = Schema.Struct({
  name: optional(Schema.String),
  /** Org toolkits only. */
  accepts: optional(CredentialsAccepted),
});

export type UpdateToolkit = typeof UpdateToolkit.Type;

/** An override as stored: absent fields leave the tool as its source describes it. */
export const ToolOverrideView = Schema.Struct({
  revision: Schema.Int,
  hidden: Schema.Boolean,
  /** The tool's own name (after `<toolkit>_`). */
  name: optional(Schema.String),
  description: optional(Schema.String),
  class: optional(ToolClass),
  updated_at: Schema.String,
  updated_by: Schema.String,
});

export const ToolView = Schema.Struct({
  /** The stable id: `<toolkit id>:<upstream name>`. */
  id: Schema.String,
  toolkit_id: Schema.String,
  upstream_name: Schema.String,
  /** The full name, `<toolkit>_<tool>`. */
  name: Schema.String,
  description: optional(Schema.String),
  input_schema: optional(Schema.Record(Schema.String, Schema.Json)),
  annotations: optional(Schema.Record(Schema.String, Schema.Json)),
  class: ToolClass,
  flags: Schema.Struct({
    /** The full name was cut to 46 characters and ends in a hash: rename it. */
    shortened: Schema.Boolean,
    renamed: Schema.Boolean,
    /** Hidden by an override. */
    hidden: Schema.Boolean,
    /** Hidden because another tool has its full name: rename it. */
    clash: Schema.Boolean,
    /** An override of a tool its source no longer lists. */
    missing: Schema.Boolean,
  }),
  override: optional(ToolOverrideView),
});

export type ToolView = typeof ToolView.Type;

export const ToolsList = Schema.Struct({
  toolkit_id: Schema.String,
  tool_list: ToolListStatus,
  tools: Schema.Array(ToolView),
});

export type ToolsList = typeof ToolsList.Type;

/** The whole override of one tool (named by its upstream name); one with nothing set is deleted. */
export const SetToolOverride = Schema.Struct({
  tool: Schema.String,
  hidden: optional(Schema.Boolean),
  name: optional(Schema.NullOr(Schema.String)),
  description: optional(Schema.NullOr(Schema.String)),
  class: optional(Schema.NullOr(ToolClass)),
});

export type SetToolOverride = typeof SetToolOverride.Type;

export const RemovedToolkit = Schema.Struct({ id: Schema.String });

/** The `If-Match` request header: the revision the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const idParam = { params: { id: Schema.String } };

const slotParams = { params: { id: Schema.String, slot: CredentialSlot } };

export class ToolsGroup extends HttpApiGroup.make("tools").add(
  HttpApiEndpoint.get("list", "/toolkits", { success: ToolkitsList, error: managementErrors }),
  /**
   * `422 invalid_toolkit` (source, name, accepts), `422 outbound_refused` (a source the outbound guard refuses),
   * `409 name_taken`, `403 forbidden` (a plain member adding an org toolkit). A tool list that cannot be built does not
   * fail the add: `tool_list.error` says why.
   */
  HttpApiEndpoint.post("add", "/toolkits", {
    payload: AddToolkit,
    success: ToolkitView.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** Rename, or change which credentials an org toolkit accepts; `409 conflict` when the revision is stale. */
  HttpApiEndpoint.patch("update", "/toolkits/:id", {
    ...idParam,
    ...IfMatch,
    payload: UpdateToolkit,
    success: ToolkitView,
    error: managementErrors,
  }),
  /** Remove a toolkit with its credentials, tool list and overrides. */
  HttpApiEndpoint.delete("remove", "/toolkits/:id", {
    ...idParam,
    ...IfMatch,
    success: RemovedToolkit,
    error: managementErrors,
  }),
  /** Connect (or replace) the shared credential or the caller's private one. */
  HttpApiEndpoint.put("connect", "/toolkits/:id/credentials/:slot", {
    ...slotParams,
    payload: ToolkitSecret,
    success: ToolkitView,
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("disconnect", "/toolkits/:id/credentials/:slot", {
    ...slotParams,
    success: ToolkitView,
    error: managementErrors,
  }),
  /** Build the tool list now; `502 tool_list_failed` when the source cannot be listed. */
  HttpApiEndpoint.post("refresh", "/toolkits/:id/refresh", {
    ...idParam,
    success: ToolsList,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("tools", "/toolkits/:id/tools", {
    ...idParam,
    success: ToolsList,
    error: managementErrors,
  }),
  /** `409 name_taken` (a rename to a full name in use), `409 conflict` (a stale revision). */
  HttpApiEndpoint.put("override", "/toolkits/:id/overrides", {
    ...idParam,
    ...IfMatch,
    payload: SetToolOverride,
    success: ToolView,
    error: managementErrors,
  }),
) {}

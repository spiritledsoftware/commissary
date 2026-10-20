/**
 * Toolkits (`/v9/management/toolkits`, `packages/tools/src/management/routes.ts`; ADR 0036, ADR 0037, ADR 0038): the
 * org's and the caller's private toolkits built from remote MCP servers, their credentials, their tool lists and the
 * overrides on their tools. Shared with the browser: imports `effect`, `./errors.ts` and `./grants.ts` only.
 *
 * An org admin adds and manages org toolkits; any member adds private toolkits, which only they see in full (an org
 * admin sees that one exists, and may remove it). A toolkit holds at most one shared credential and one private
 * credential per member; a member's private credential wins for them. Tools are named `<toolkit>_<tool>` and referred
 * to by their stable id, the toolkit's id and the tool's upstream name (`id`: `<toolkit id>:<upstream name>`), so
 * overrides survive renames and refreshes. Edits of a toolkit or an override name its revision in `If-Match` (0 for a
 * new override).
 *
 * Prices (#199, ADR 0038): an org admin may price a call of an org toolkit's tools, in micro-USD (1 USD = 1,000,000),
 * on the toolkit (`PATCH /toolkits/:id`, `price_micros`) and per tool in its override, which wins (`0` makes one tool of
 * a priced toolkit free). A tool without a price costs nothing. A private toolkit takes no price (`422 invalid`).
 */
import { Schema, Tuple } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";
import { GrantSubject } from "./grants.ts";

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

/**
 * A credential as it is connected: its secret and, for a toolkit's shared credential, who may use it (ADR 0038). There
 * is no default tool grant, so connecting a shared credential names a `subject` (`422 invalid` without one). If the
 * subject holds no grant on the toolkit, its grant of every tool is added in the same write; if it holds one, nothing is
 * added and its grants stay as they are, so its reach is unchanged only then. The answer's `grant` says which. A private
 * credential is its owner's alone and names none.
 */
export const ConnectCredential = ToolkitSecret.mapMembers(
  Tuple.map(Schema.fieldsAssign({ subject: optional(GrantSubject) })),
);

export type ConnectCredential = typeof ConnectCredential.Type;

/** A connected credential, without its secret. Times are ISO. */
export const ToolkitCredentialView = Schema.Struct({
  kind: Schema.Literals(["none", "bearer", "header", "query", "basic"]),
  /** The header or query parameter a `header` or `query` key goes in. */
  name: optional(Schema.String),
  connected_at: Schema.String,
  connected_by: Schema.String,
  /**
   * False while the toolkit does not accept its kind (it is kept, and not used) and, for a private credential, while
   * the org has private credentials turned off.
   */
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
  /**
   * The MCP server's URL. A member who only reads an org toolkit sees its query parameters' values masked (`***`), their
   * names kept; managers and the org export get it whole. A key belongs in a `query` credential, not in the source.
   */
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
  /** What a call of its tools costs in micro-USD, unless a tool's override prices it; absent: free. */
  price_micros: optional(Schema.Number),
  /**
   * A private toolkit whose name an org toolkit took later: it wins for its owner, who should rename it (ADR 0037).
   */
  rename_suggested: optional(Schema.Boolean),
  /** An org toolkit whose name the caller's private toolkit has: hidden for the caller. */
  shadowed: optional(Schema.Boolean),
});

export type ToolkitView = typeof ToolkitView.Type;

/**
 * What connecting a shared credential did to its subject's tool grants: the grant it added (`created`), or the first
 * grant the subject already held on the toolkit, kept as it is.
 */
export const ConnectedGrant = Schema.Struct({ id: Schema.String, created: Schema.Boolean });

export type ConnectedGrant = typeof ConnectedGrant.Type;

/** A toolkit as adding it or connecting a credential answers it: `grant` when a shared credential was connected. */
export const ConnectedToolkitView = Schema.Struct({
  ...ToolkitView.fields,
  grant: optional(ConnectedGrant),
});

export type ConnectedToolkitView = typeof ConnectedToolkitView.Type;

/** Another member's private toolkit as an org admin sees it: only that it exists. */
export const LimitedToolkitView = Schema.Struct({
  id: Schema.String,
  private: Schema.Literal(true),
  limited: Schema.Literal(true),
  owner: ToolkitOwner,
  created_at: Schema.String,
  /** For the `If-Match` of an org admin's removal. */
  revision: Schema.Int,
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
  /**
   * Connected at once: the shared credential of an org toolkit, which names who may use it (`subject`), or the caller's
   * of a private one.
   */
  credential: optional(ConnectCredential),
});

export type AddToolkit = typeof AddToolkit.Type;

export const UpdateToolkit = Schema.Struct({
  name: optional(Schema.String),
  /** Org toolkits only. */
  accepts: optional(CredentialsAccepted),
  /** Org toolkits only: a whole number of micro-USD per call, 0 or more; `null` clears it (calls are free). */
  price_micros: optional(Schema.NullOr(Schema.Number)),
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
  /** What a call of the tool costs in micro-USD, whatever its toolkit's price. */
  price_micros: optional(Schema.Number),
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
  /** What a call costs in micro-USD: its override's price, else its toolkit's; absent: free. */
  price_micros: optional(Schema.Number),
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

/** The whole override of one tool (named by its upstream name); one with nothing set clears it. */
export const SetToolOverride = Schema.Struct({
  tool: Schema.String,
  hidden: optional(Schema.Boolean),
  name: optional(Schema.NullOr(Schema.String)),
  description: optional(Schema.NullOr(Schema.String)),
  class: optional(Schema.NullOr(ToolClass)),
  /** Org toolkits only: micro-USD per call, a whole number, 0 or more, that wins over the toolkit's price. */
  price_micros: optional(Schema.NullOr(Schema.Number)),
});

export type SetToolOverride = typeof SetToolOverride.Type;

export const RemovedToolkit = Schema.Struct({ id: Schema.String });

/**
 * The answer to clearing the override of a tool its source no longer lists: the tool left the list. The override
 * endpoint answers this or a {@link ToolView}; callers tell them apart with `"removed" in reply`.
 */
export const RemovedToolOverride = Schema.Struct({
  /** The tool's stable id. */
  id: Schema.String,
  removed: Schema.Literal(true),
});

export type RemovedToolOverride = typeof RemovedToolOverride.Type;

/** The `If-Match` request header: the revision the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const idParam = { params: { id: Schema.String } };

const slotParams = { params: { id: Schema.String, slot: CredentialSlot } };

export class ToolsGroup extends HttpApiGroup.make("tools").add(
  HttpApiEndpoint.get("list", "/toolkits", { success: ToolkitsList, error: managementErrors }),
  /**
   * `422 invalid` (name, accepts, credential; a source naming a user or password, with `path: "source"`),
   * `422 not_accepted` (a credential the toolkit does not take), `422` with
   * the outbound guard's message as `error` and `path: "source"` (a source the guard refuses), `409 name_taken`,
   * `403 private_credentials_unavailable` (a private credential while the org has them off), `403
   * private_toolkits_unavailable` (a private toolkit while the org has them off). A plain member's toolkit is always
   * private. A shared credential names its `subject` (`ConnectCredential`; `grant` says what it did). A tool list that
   * cannot be built does not fail the add: `tool_list.error` says why.
   */
  HttpApiEndpoint.post("add", "/toolkits", {
    payload: AddToolkit,
    success: ConnectedToolkitView.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /**
   * Rename, change which credentials an org toolkit accepts, or price its calls; `409 conflict` when the revision is
   * stale, `422 invalid` for a price on a private toolkit or one that is not a whole number of micro-USD, 0 or more.
   */
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
  /**
   * Connect (or replace) the shared credential, naming who may use it (`subject`, `422 invalid` without one; `grant`
   * says whether its grant was added or one it held kept), or the caller's private one (`403
   * private_credentials_unavailable` on an org toolkit, `403 private_toolkits_unavailable` on a private toolkit, while
   * the org has that setting off).
   */
  HttpApiEndpoint.put("connect", "/toolkits/:id/credentials/:slot", {
    ...slotParams,
    payload: ConnectCredential,
    success: ConnectedToolkitView,
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
  /**
   * `409 name_taken` (a rename to a full name in use), `409 conflict` (a stale revision), `422 invalid` (a price on a
   * private toolkit's tool, or one that is not a whole number of micro-USD, 0 or more). Clearing the override of a tool
   * its source no longer lists answers {@link RemovedToolOverride}.
   */
  HttpApiEndpoint.put("override", "/toolkits/:id/overrides", {
    ...idParam,
    ...IfMatch,
    payload: SetToolOverride,
    success: Schema.Union([ToolView, RemovedToolOverride]),
    error: managementErrors,
  }),
) {}

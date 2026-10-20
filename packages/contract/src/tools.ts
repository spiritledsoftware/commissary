/**
 * Toolkits (`/v9/management/toolkits`, `packages/tools/src/management/routes.ts`; ADR 0036, ADR 0037, ADR 0038): the
 * org's and the caller's private toolkits built from remote MCP servers, OpenAPI documents or GraphQL endpoints, their
 * credentials, their tool lists and the overrides on their tools. Shared with the browser: imports `effect`,
 * `./approvals.ts`, `./errors.ts` and `./grants.ts` only.
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
 *
 * OAuth 2 (#202): a credential may be an OAuth 2 client credentials grant (shared only), connected like any other, or
 * the tokens of an authorization code sign-in, started with `signIn` (the browser opens its `url`, comes back to
 * `https://<app host>/oauth/toolkits/callback`, and the panel polls `signInStatus`). The sign-in's client is the
 * toolkit's own OAuth app when its managers set one (`setOAuthApp`), else Commissary through its Client ID Metadata
 * Document or dynamic registration. Commissary refreshes the tokens; a credential whose token refresh fails for good
 * shows `needs_sign_in`.
 * Every URL entered here passes the outbound guard (`422` with the guard's message as `error` and the field as `path`).
 */
import { Schema, Tuple } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { ApprovalRules, ApprovalRulesView } from "./approvals.ts";
import { managementErrors } from "./errors.ts";
import { GrantSubject } from "./grants.ts";

const optional = Schema.optionalKey;

/**
 * What a toolkit is built from: a remote MCP server (Streamable HTTP), an OpenAPI document (3.0, 3.1 or 3.2, or
 * Swagger 2.0, given by URL or uploaded, #203), a GraphQL endpoint (its schema introspected, or uploaded as SDL, #204),
 * or, for a toolkit Commissary provides itself (`built_in`), the kind of service behind it: `browser`, the browser
 * toolkit (ADR 0039), or `sandbox`, the sandbox toolkit (ADR 0041).
 */
export const ToolkitKind = Schema.Literals(["mcp", "openapi", "graphql", "browser", "sandbox"]);

export type ToolkitKind = typeof ToolkitKind.Type;

/** The kinds of toolkit an org adds: a built-in toolkit is never added. */
export const AddedToolkitKind = Schema.Literals(["mcp", "openapi", "graphql"]);

export type AddedToolkitKind = typeof AddedToolkitKind.Type;

/** Which credentials an org toolkit accepts; a private toolkit takes its owner's only (`private`). */
export const CredentialsAccepted = Schema.Literals(["shared", "private", "both"]);

export type CredentialsAccepted = typeof CredentialsAccepted.Type;

/**
 * A sandbox's network (ADR 0041, #222): `none`, the default; `hosts`, only the hosts listed (an exact name, or `*.`
 * and a name for every name under it) and those of its presets (`package_registries`: npm, PyPI, GitHub and mise's
 * download hosts); or `open`, the internet. Every request also passes the outbound guard (ADR 0044), whatever the
 * network. The sandbox toolkit's (`network` on it) is the org's ceiling, set by org admins; a session opened with
 * `sandbox_open` asks for one within it and keeps it.
 */
export const SandboxNetwork = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("hosts"),
    hosts: Schema.Array(Schema.String),
    presets: optional(Schema.Array(Schema.Literal("package_registries"))),
  }),
  Schema.Struct({ kind: Schema.Literal("open") }),
]);

export type SandboxNetwork = typeof SandboxNetwork.Type;

/** Whether a tool reads or writes (ADR 0038). */
export const ToolClass = Schema.Literals(["read", "write"]);

export type ToolClass = typeof ToolClass.Type;

/** A shared credential (org admins) or the caller's own private one. */
export const CredentialSlot = Schema.Literals(["shared", "private"]);

export type CredentialSlot = typeof CredentialSlot.Type;

/**
 * A toolkit's sign-in at its source, as it is connected: none (a source that needs no sign-in), a bearer token, an API
 * key in a named header or query parameter, basic auth, or an OAuth 2 client credentials grant (#202; a shared
 * credential only), whose tokens Commissary mints and refreshes itself. It is sealed when stored and never answered. An
 * OAuth 2 authorization code sign-in is not connected this way but signed in to (`signIn`).
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
  Schema.Struct({
    kind: Schema.Literal("client_credentials"),
    client_id: Schema.String,
    client_secret: Schema.String,
    /**
     * The token endpoint, a public `https:` address (the outbound guard, ADR 0044); absent: the one the MCP server's
     * authorization server names (RFC 9728, RFC 8414).
     */
    token_url: optional(Schema.String),
    /** The scopes asked for, space separated. */
    scope: optional(Schema.String),
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

/**
 * How an `oauth` sign-in's client was registered (#202): Commissary's CIMD document (`cimd`), dynamic client
 * registration (`dcr`), or the toolkit's OAuth app (`app`).
 */
export const ClientVia = Schema.Literals(["cimd", "dcr", "app"]);

export type ClientVia = typeof ClientVia.Type;

/** A connected credential, without its secret. Times are ISO. */
export const ToolkitCredentialView = Schema.Struct({
  /** `oauth`: an OAuth 2 authorization code sign-in (#202). */
  kind: Schema.Literals([
    "none",
    "bearer",
    "header",
    "query",
    "basic",
    "client_credentials",
    "oauth",
  ]),
  /** The header or query parameter a `header` or `query` key goes in. */
  name: optional(Schema.String),
  /** How an `oauth` sign-in's client was registered ({@link ClientVia}). */
  via: optional(ClientVia),
  /** When its access token expires (ISO), for `oauth` and `client_credentials`; Commissary refreshes it before. */
  expires_at: optional(Schema.String),
  /**
   * Its token refresh failed for good (the refresh token was refused, or there is none): it is not used until someone
   * signs in again (`signIn`), or connects it again for `client_credentials`.
   */
  needs_sign_in: optional(Schema.Boolean),
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
  /**
   * Why the last build failed (the list before it stays), or what keeps some of its tools from being called as they
   * are (an OpenAPI toolkit's operations that name no server the outbound guard allows, while it has no base URL);
   * absent otherwise.
   */
  error: optional(Schema.String),
  /** Tools in the list. */
  tools: Schema.Int,
});

export type ToolListStatus = typeof ToolListStatus.Type;

/**
 * A toolkit's own OAuth app (#202), for a service that offers neither a CIMD document nor dynamic client registration
 * (Slack, HubSpot, GitHub, Google): its client, its endpoints and the scopes a sign-in asks for. Both URLs are public
 * `https:` addresses (the outbound guard, ADR 0044). The secret is sealed and never answered.
 */
export const SetOAuthApp = Schema.Struct({
  client_id: Schema.String,
  /** Absent: a public client, which signs in with PKCE only. */
  client_secret: optional(Schema.String),
  authorize_url: Schema.String,
  token_url: Schema.String,
  scopes: optional(Schema.Array(Schema.String)),
  /**
   * The authorization server's issuer identifier (RFC 9207): when set, a sign-in's answer must name it (`iss`), and one
   * that names another is refused. Absent: the answer's `iss` is not checked.
   */
  issuer: optional(Schema.String),
});

export type SetOAuthApp = typeof SetOAuthApp.Type;

/** A toolkit's OAuth app without its secret. */
export const OAuthAppView = Schema.Struct({
  client_id: Schema.String,
  /** Whether a client secret is set. */
  client_secret: Schema.Boolean,
  authorize_url: Schema.String,
  token_url: Schema.String,
  scopes: Schema.Array(Schema.String),
  issuer: optional(Schema.String),
  updated_at: Schema.String,
  updated_by: Schema.String,
});

export type OAuthAppView = typeof OAuthAppView.Type;

/**
 * Starts an OAuth 2 authorization code sign-in (#202) for the toolkit's shared credential, naming who may use it
 * (`subject`, as `ConnectCredential` does), or the caller's private one (no subject).
 */
export const StartSignIn = Schema.Struct({ subject: optional(GrantSubject) });

export type StartSignIn = typeof StartSignIn.Type;

/** A sign-in started: open `url` in a browser, then poll its `state` until it is done. */
export const SignInStarted = Schema.Struct({
  state: Schema.String,
  url: Schema.String,
  /** When the sign-in ends unless it is done (ISO). */
  expires_at: Schema.String,
});

export type SignInStarted = typeof SignInStarted.Type;

/** Where a sign-in stands: waiting for the browser, done (`ok`), or failed, with why. */
export const SignInStatus = Schema.Struct({
  status: Schema.Literals(["wait", "ok", "error"]),
  message: optional(Schema.String),
});

export type SignInStatus = typeof SignInStatus.Type;

export const ToolkitOwner = Schema.Struct({
  member_id: Schema.String,
  email: optional(Schema.String),
});

export const ToolkitView = Schema.Struct({
  id: Schema.String,
  kind: ToolkitKind,
  name: Schema.String,
  /**
   * The MCP server's URL, the OpenAPI document's (empty for an uploaded document) or the GraphQL endpoint's. A member
   * who only reads an org toolkit sees its query parameters' values masked (`***`), their names kept; managers and the
   * org export get it whole. A key belongs in a `query` credential, not in the source. A browser toolkit's is its
   * browser provider (`browser-run`).
   */
  source: Schema.String,
  /** An OpenAPI toolkit's base URL, set in place of its document's servers; masked like `source` for readers. */
  base_url: optional(Schema.String),
  /**
   * An OpenAPI toolkit built from an uploaded document, or a GraphQL toolkit from an uploaded schema (SDL) instead of
   * introspection, since it was added or since its first schema was uploaded (`PUT /toolkits/:id/document` replaces
   * it).
   */
  uploaded: optional(Schema.Boolean),
  /**
   * A toolkit Commissary provides itself (the browser toolkit, `id` and `name` `browser`; the sandbox toolkit, `sandbox`):
   * present while the deployment has what it runs on, reached under tool grants (no default grant), its tools'
   * overrides as any toolkit's; it cannot be renamed, edited (but for its approval rules, #201, and the sandbox's
   * network, #222), given a credential, refreshed or removed (`403 built_in`).
   * Its times are the epoch until its approval rules change.
   */
  built_in: optional(Schema.Literal(true)),
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
  /** Its managers: the OAuth app an `oauth` sign-in uses, when one is set (#202). */
  oauth_app: optional(OAuthAppView),
  /** What a call of its tools costs in micro-USD, unless a tool's override prices it; absent: free. */
  price_micros: optional(Schema.Number),
  /**
   * A private toolkit whose name an org toolkit took later: it wins for its owner, who should rename it (ADR 0037).
   */
  rename_suggested: optional(Schema.Boolean),
  /** An org toolkit whose name the caller's private toolkit has: hidden for the caller. */
  shadowed: optional(Schema.Boolean),
  /**
   * Its approval rules (#201), each approver named, a rule no one can approve under flagged `nobody_decides`; absent:
   * no call of its tools waits.
   */
  approval_rules: optional(ApprovalRulesView),
  /** The sandbox toolkit's (#222): the widest network a sandbox session may ask for, the org's ceiling. */
  network: optional(SandboxNetwork),
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
  /** Default `mcp`. */
  kind: optional(AddedToolkitKind),
  /**
   * The MCP server's URL, the OpenAPI document's or the GraphQL endpoint's: a public `https:` address (the outbound
   * guard, ADR 0044). An OpenAPI toolkit gives either this or `document`; MCP and GraphQL toolkits always give it.
   */
  source: optional(Schema.String),
  /**
   * An OpenAPI toolkit's document, uploaded: its JSON or YAML text (at most 8 MiB); or a GraphQL toolkit's schema as
   * SDL (at most 4 MiB), which it is built from in place of introspection. `413 body_too_large` above.
   */
  document: optional(Schema.String),
  /**
   * An OpenAPI toolkit's base URL, which calls go to in place of the servers its document names: a public `https:`
   * address (the outbound guard).
   */
  base_url: optional(Schema.String),
  /**
   * Defaults to the slug of the source's host (the MCP server's, the GraphQL endpoint's); for an OpenAPI toolkit, of
   * its document's first server, else of its title.
   */
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
  /**
   * The whole of its approval rules (#201): org admins on an org toolkit, its owner on a private one; `null` clears
   * them. An approver left out is the caller.
   */
  approval_rules: optional(Schema.NullOr(ApprovalRules)),
  /** OpenAPI toolkits only: the base URL calls go to (the outbound guard); `null` returns to the document's servers. */
  base_url: optional(Schema.NullOr(Schema.String)),
  /**
   * The sandbox toolkit only (#222), org admins: the widest network a sandbox session may ask for (`403 built_in` on
   * the browser toolkit, `422 invalid` on any other). Sessions keep the network they opened with.
   */
  network: optional(SandboxNetwork),
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
    /**
     * A deprecated OpenAPI operation (#203) or GraphQL field (#204): hidden unless its override says `hidden: false`;
     * `hidden` tells which.
     */
    deprecated: optional(Schema.Boolean),
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
  /** `false` shows a tool its source hides by default (a deprecated OpenAPI operation); elsewhere it sets nothing. */
  hidden: optional(Schema.Boolean),
  name: optional(Schema.NullOr(Schema.String)),
  description: optional(Schema.NullOr(Schema.String)),
  class: optional(Schema.NullOr(ToolClass)),
  /** Org toolkits only: micro-USD per call, a whole number, 0 or more, that wins over the toolkit's price. */
  price_micros: optional(Schema.NullOr(Schema.Number)),
});

export type SetToolOverride = typeof SetToolOverride.Type;

export const RemovedToolkit = Schema.Struct({ id: Schema.String });

/** A toolkit's uploaded document: an OpenAPI document's JSON or YAML text, a GraphQL schema's SDL. */
export const ToolkitDocument = Schema.Struct({ document: Schema.String });

export type ToolkitDocument = typeof ToolkitDocument.Type;

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

/** A tool the caller may use (#200): its stable id, the full name clients call it by, and its class. */
export const UsableTool = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tool_class: ToolClass,
});

export type UsableTool = typeof UsableTool.Type;

/** A toolkit of which the caller may use some tools, with those tools sorted by full name. */
export const UsableToolkit = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tools: Schema.Array(UsableTool),
});

export type UsableToolkit = typeof UsableToolkit.Type;

/**
 * `GET /tools`: what the caller may use on the MCP endpoint, by toolkit sorted by name (the tool list a key without a
 * tool scope gets): what the panel's tool scope editor and the consent page of an MCP client's sign-in pick from.
 */
export const UsableTools = Schema.Struct({ toolkits: Schema.Array(UsableToolkit) });

export type UsableTools = typeof UsableTools.Type;

export class ToolsGroup extends HttpApiGroup.make("tools").add(
  HttpApiEndpoint.get("list", "/toolkits", { success: ToolkitsList, error: managementErrors }),
  HttpApiEndpoint.get("usable", "/tools", { success: UsableTools, error: managementErrors }),
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
   * Rename, change which credentials an org toolkit accepts, price its calls, or set its approval rules; `409 conflict`
   * when the revision is stale, `422 invalid` for a price on a private toolkit or one that is not a whole number of
   * micro-USD, 0 or more, and for approval rules that mark a tool of another toolkit or name a team or member the org
   * does not have, and for a network that is not the sandbox toolkit's or not a valid one; `403 built_in` for anything
   * but approval rules (and the sandbox's network) on a built-in toolkit (also on removing it, and on connecting or
   * removing its credential).
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
  /**
   * Replace an uploaded document, an OpenAPI document or a GraphQL schema's SDL (managers; `409 conflict` on a stale
   * revision, `422 invalid` for a toolkit not built from an uploaded document, `413 body_too_large` above 8 MiB, or
   * 4 MiB for SDL) and build its tool list again; a document that cannot be read does not replace the one before
   * (`422 invalid`). A GraphQL toolkit built by introspection takes a first SDL file here too (an endpoint that stopped
   * allowing introspection), built without a credential and `uploaded` from then on: the cron task no longer
   * introspects it.
   */
  HttpApiEndpoint.put("replaceDocument", "/toolkits/:id/document", {
    ...idParam,
    ...IfMatch,
    payload: ToolkitDocument,
    success: ToolkitView,
    error: managementErrors,
  }),
  /**
   * A toolkit's uploaded document (an OpenAPI document, a GraphQL schema), for its managers (an org admin an org
   * toolkit's, `403 forbidden` for a member who reads it; a member their private toolkit's); `404` for one with none.
   */
  HttpApiEndpoint.get("document", "/toolkits/:id/document", {
    ...idParam,
    success: ToolkitDocument,
    error: managementErrors,
  }),
  /**
   * Start an OAuth 2 authorization code sign-in with PKCE (#202) for the shared credential (org admins; `subject` as for
   * `connect`) or the caller's private one. The client is the toolkit's OAuth app when it has one, else Commissary,
   * registered with the MCP server's authorization server through its CIMD document or dynamic client registration.
   * `422` with the outbound guard's message as `error` and the refused URL's field as `path`; `502 sign_in_failed` when
   * the server's metadata cannot be read or names no way to register.
   */
  HttpApiEndpoint.post("signIn", "/toolkits/:id/credentials/:slot/sign-in", {
    ...slotParams,
    payload: StartSignIn,
    success: SignInStarted.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** Where a sign-in the caller started stands; an unknown or expired state is `404`. */
  HttpApiEndpoint.get("signInStatus", "/toolkits/:id/sign-in", {
    ...idParam,
    query: { state: Schema.String },
    success: SignInStatus,
    error: managementErrors,
  }),
  /**
   * Set the toolkit's OAuth app (its managers); `422` with the outbound guard's message as `error` and `path`
   * (`authorize_url`, `token_url`) for a URL it refuses, `422 invalid` otherwise.
   */
  HttpApiEndpoint.put("setOAuthApp", "/toolkits/:id/oauth-app", {
    ...idParam,
    payload: SetOAuthApp,
    success: ToolkitView,
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("clearOAuthApp", "/toolkits/:id/oauth-app", {
    ...idParam,
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

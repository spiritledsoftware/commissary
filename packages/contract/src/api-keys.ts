/**
 * API keys (ADR 0022; `apps/app/src/management/api-key-routes.ts`, the ControlPlane's `ApiKeyStore` in
 * `packages/state/src/api-keys`): the keys clients send on the client API instead of an Access sign-in. Workers addition, no
 * Go counterpart. Shared with the browser: imports `effect` only.
 *
 * Every member creates, lists and revokes their own keys; org admins list and revoke every key in the org. A key is
 * shown whole once, in the answer to its creation; lists show its prefix only.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";
import { ToolSelection } from "./grants.ts";

/**
 * The agents toolkit's id (ADR 0040, #229): the built-in toolkit through which clients and runs use hosted agents. A
 * tool scope's entry for it may name agents ({@link ToolScopeEntry}).
 */
export const AGENTS_TOOLKIT = "agents";

/**
 * One toolkit of a tool scope (#200, ADR 0036, GLOSSARY "Tool scope"): an API key's or a hosted agent's (#226). It
 * names the toolkit (an org toolkit or a private one of the key's member, by id) and which of its tools: all of them,
 * its read tools (by tool class), or named tools by stable id (`<toolkit id>:<upstream name>`, each of this toolkit),
 * as a tool grant selects them. The entry of the agents toolkit ({@link AGENTS_TOOLKIT}) may also name `agents`, by id
 * (#226, ADR 0040). The scope then lets its holder run only those agents. Without `agents` it allows every agent within
 * reach. No other entry names agents.
 */
export const ToolScopeEntry = Schema.Struct({
  toolkit: Schema.String,
  tools: ToolSelection,
  agents: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type ToolScopeEntry = typeof ToolScopeEntry.Type;

/**
 * The tools an API key may use, within what its member may use: the union of its entries (one per toolkit). An empty
 * scope gives nothing; a key without one (`null`, or left out) may use every tool its member may use. It does not limit
 * the key's models.
 */
export const ToolScope = Schema.Array(ToolScopeEntry);

export type ToolScope = typeof ToolScope.Type;

/**
 * The agents `scope` lets its holder run (#226, #229): the ids its entry for the agents toolkit names, or `undefined`
 * when it names none (no scope, or an entry without `agents`): every agent within reach.
 */
export const agentsInScope = (scope: ToolScope | undefined): ReadonlyArray<string> | undefined =>
  scope?.find((entry) => entry.toolkit === AGENTS_TOOLKIT)?.agents;

/** A key as lists show it: never the key itself. Times are ISO. */
export const ApiKeyView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** `cms_<orgId>_<keyId>_<first 4 secret characters>`, so its member recognises it. */
  prefix: Schema.String,
  member_id: Schema.String,
  /** The email of the member it belongs to. */
  member_email: Schema.optionalKey(Schema.String),
  /** Whether it belongs to the caller. */
  mine: Schema.Boolean,
  created_at: Schema.String,
  last_used_at: Schema.optionalKey(Schema.String),
  expires_at: Schema.optionalKey(Schema.String),
  revoked_at: Schema.optionalKey(Schema.String),
  /** Its tool scope (#200); absent: every tool its member may use. */
  tool_scope: Schema.optionalKey(ToolScope),
  /** How many tools the key may use now: its member's tools, narrowed by its tool scope. */
  tool_count: Schema.optionalKey(Schema.Int),
  /** Stable ids (and toolkit ids) its tool scope names that no longer exist: a tool gone upstream, a removed toolkit. */
  tool_scope_missing: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type ApiKeyView = typeof ApiKeyView.Type;

/** `GET /api-keys`: the caller's keys, or every key of the org for an org admin; newest first. */
export const ApiKeyList = Schema.Struct({ keys: Schema.Array(ApiKeyView) });

export type ApiKeyList = typeof ApiKeyList.Type;

/**
 * `POST /api-keys`: a name (1-100 characters), an optional ISO expiry in the future and an optional tool scope (`null`
 * or left out: every tool the member may use).
 */
export const CreateApiKey = Schema.Struct({
  name: Schema.String,
  expires_at: Schema.optionalKey(Schema.String),
  tool_scope: Schema.optionalKey(Schema.NullOr(ToolScope)),
});

export type CreateApiKey = typeof CreateApiKey.Type;

/** `PATCH /api-keys/:id`: the key's new tool scope; `null` lets it use every tool its member may use. */
export const UpdateApiKey = Schema.Struct({ tool_scope: Schema.NullOr(ToolScope) });

export type UpdateApiKey = typeof UpdateApiKey.Type;

/** The answer to a creation: the new key's entry plus the whole key, shown this once. */
export const CreatedApiKey = Schema.Struct({
  ...ApiKeyView.fields,
  key: Schema.String,
});

export type CreatedApiKey = typeof CreatedApiKey.Type;

const idParam = { params: { id: Schema.String } };

export class ApiKeysGroup extends HttpApiGroup.make("apiKeys").add(
  HttpApiEndpoint.get("list", "/api-keys", { success: ApiKeyList, error: managementErrors }),
  /**
   * `422 invalid_name`, `422 invalid_expiry`, `422 invalid_tool_scope`, `409 too_many_keys`; `403 member_required`
   * for a caller who is not a member of the org (a service token, a platform admin from outside the org).
   */
  HttpApiEndpoint.post("create", "/api-keys", {
    payload: CreateApiKey,
    success: CreatedApiKey.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /**
   * Changes the tool scope of one of the caller's own keys, at once (the ControlPlane reads it on every MCP request);
   * `404 api_key_not_found` for another member's key, `422 invalid_tool_scope`.
   */
  HttpApiEndpoint.patch("update", "/api-keys/:id", {
    ...idParam,
    payload: UpdateApiKey,
    success: ApiKeyView,
    error: managementErrors,
  }),
  /** Refused within 30 seconds (the verified-key cache lifetime); `404 api_key_not_found` for another member's key unless an org admin asks. */
  HttpApiEndpoint.delete("revoke", "/api-keys/:id", {
    ...idParam,
    success: ApiKeyView,
    error: managementErrors,
  }),
) {}

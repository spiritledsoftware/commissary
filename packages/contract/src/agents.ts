/**
 * Hosted agents (`/v9/management/agents`, `packages/agents/src/management/routes.ts`; ADR 0040, #226): the org's shared
 * agents and the caller's private agents, as saved definitions, and the grants on shared agents
 * (`/v9/management/grants/agents`). Nothing runs yet: runs come with #227. Shared with the browser: imports `effect`,
 * `./api-keys.ts`, `./config.ts`, `./errors.ts` and `./grants.ts` only.
 *
 * A hosted agent has a name (`[a-z0-9_]`, unique in the org, the `agent` argument of the agents toolkit), a
 * description, instructions, one model named as clients send it (Models' aliases, selection and failover apply) with an
 * optional thinking level, a tool scope (an API key's, whose agents toolkit entry may name agents) and whether it is
 * enabled. There are no versions: an edit replaces what it names, and keeps no history.
 *
 * - A **private agent** is one member's, while the org's `membership.private_agents` setting allows them (`403
 *   private_agents_unavailable` otherwise; turning it off keeps them but serves none). Only its member sees it in full.
 *   An org admin sees that it exists (`others`: name and owner) and may disable or remove it.
 * - A **shared agent** is created and edited by org admins only. The models and toolkits it names must exist in the org
 *   (`422 unknown_model`, `422 unknown_toolkit`). Creating one names who may use it (`subject`, a grant written at
 *   once; there is no default grant), and it names its watchers (members and teams, the creating admin by default; the
 *   org admins when none is left). Spend limits on one are `agent` limits of `/spend`.
 *
 * Edits and removals name the agent's revision in `If-Match`. Without the deployment's Dynamic Workers binding
 * (`LOADER`) the Agents area is absent: every route here answers 404, and `/me` says `deployment.agents: false`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { ToolScope } from "./api-keys.ts";
import { Revision } from "./config.ts";
import { managementErrors } from "./errors.ts";
import { GrantSubject } from "./grants.ts";

const optional = Schema.optionalKey;

/** A thinking level the agent's model calls ask for, as a client names it in a model's suffix (`model(high)`). */
export const ThinkingLevel = Schema.Literals([
  "none",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ThinkingLevel = typeof ThinkingLevel.Type;

/** A watcher of a shared agent (GLOSSARY "Watcher"): a member, or a team whose members watch. */
export const AgentWatcher = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("member"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("team"), id: Schema.String }),
]);

export type AgentWatcher = typeof AgentWatcher.Type;

/** A private agent's member. */
export const AgentOwner = Schema.Struct({
  member_id: Schema.String,
  email: optional(Schema.String),
});

export type AgentOwner = typeof AgentOwner.Type;

/** An agent as its manager sees it: a private agent's member, or an org admin for a shared agent. */
export const AgentView = Schema.Struct({
  id: Schema.String,
  /** 1-64 of `[a-z0-9_]`, unique in the org. */
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  /** As clients send it. */
  model: Schema.String,
  thinking: optional(ThinkingLevel),
  tool_scope: ToolScope,
  enabled: Schema.Boolean,
  /** A private agent, the caller's own. */
  private: Schema.Boolean,
  /** A shared agent's watchers as named (members and teams still in the org). */
  watchers: optional(Schema.Array(AgentWatcher)),
  /** A shared agent none of whose watchers is left: its org admins watch it. */
  admins_watch: optional(Schema.Boolean),
  revision: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
});

export type AgentView = typeof AgentView.Type;

/** An org admin's view of another member's private agent: that it exists, its name and its member. */
export const LimitedAgentView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  private: Schema.Literal(true),
  limited: Schema.Literal(true),
  owner: AgentOwner,
  enabled: Schema.Boolean,
  created_at: Schema.String,
  /** For the `If-Match` of an org admin's disabling or removal. */
  revision: Schema.Int,
});

export type LimitedAgentView = typeof LimitedAgentView.Type;

/** `GET /agents`: the agents the caller manages; org admins also get the other members' private agents. */
export const AgentsList = Schema.Struct({
  agents: Schema.Array(AgentView),
  others: optional(Schema.Array(LimitedAgentView)),
});

export type AgentsList = typeof AgentsList.Type;

/** What a definition says; every field but `thinking` is required on creation. */
const definition = {
  name: Schema.String,
  /** At most 1,000 characters. */
  description: Schema.String,
  /** At most 65,536 characters. */
  instructions: Schema.String,
  model: Schema.String,
  thinking: optional(ThinkingLevel),
  /** The toolkits, tools and agents it may use; `[]` is none. */
  tool_scope: ToolScope,
};

/**
 * `POST /agents`: a private agent of the caller (a plain member's agent is always private), or for an org admin a
 * shared one (`private` false or left out), which names who may use it (`subject`, written as its grant) and may name
 * its watchers (default: the caller).
 */
export const CreateAgent = Schema.Struct({
  ...definition,
  private: optional(Schema.Boolean),
  subject: optional(GrantSubject),
  watchers: optional(Schema.Array(AgentWatcher)),
});

export type CreateAgent = typeof CreateAgent.Type;

/**
 * `PATCH /agents/:id`: the fields to change (at least one); `thinking: null` clears it. An org admin may only enable
 * or disable another member's private agent.
 */
export const UpdateAgent = Schema.Struct({
  name: optional(Schema.String),
  description: optional(Schema.String),
  instructions: optional(Schema.String),
  model: optional(Schema.String),
  thinking: optional(Schema.NullOr(ThinkingLevel)),
  tool_scope: optional(ToolScope),
  enabled: optional(Schema.Boolean),
  /** Shared agents only. */
  watchers: optional(Schema.Array(AgentWatcher)),
});

export type UpdateAgent = typeof UpdateAgent.Type;

/** A created agent; a shared one says which grant its `subject` got. */
export const CreatedAgentView = Schema.Struct({
  ...AgentView.fields,
  grant: optional(Schema.Struct({ id: Schema.String })),
});

export type CreatedAgentView = typeof CreatedAgentView.Type;

/** `GET /agents/:id`: the agent as the caller sees it. */
export const AgentViewOrLimited = Schema.Union([AgentView, LimitedAgentView]);

export const RemovedAgent = Schema.Struct({ id: Schema.String, removed: Schema.Literal(true) });

export type RemovedAgent = typeof RemovedAgent.Type;

/** An agent the caller may use (their reach): their private agents and the shared agents granted to them, enabled. */
export const UsableAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  private: Schema.Boolean,
});

export type UsableAgent = typeof UsableAgent.Type;

/** `GET /agents/mine`: the agents the caller may use, by name. */
export const UsableAgents = Schema.Struct({ agents: Schema.Array(UsableAgent) });

export type UsableAgents = typeof UsableAgents.Type;

/** What an agent grant says: who may use which shared agent. */
export const AgentGrantBody = Schema.Struct({
  subject: GrantSubject,
  /** The shared agent's id. */
  agent: Schema.String,
});

export type AgentGrantBody = typeof AgentGrantBody.Type;

export const AgentGrant = Schema.Struct({
  ...AgentGrantBody.fields,
  id: Schema.String,
  revision: Revision,
  /** Epoch milliseconds. */
  updated_at: Schema.Number,
  /** The principal that wrote it. */
  updated_by: Schema.String,
});

export type AgentGrant = typeof AgentGrant.Type;

/** `GET /grants/agents`: every agent grant of the org. */
export const AgentGrants = Schema.Struct({ grants: Schema.Array(AgentGrant) });

export type AgentGrants = typeof AgentGrants.Type;

/** A saved agent grant: its `id` and new `revision` (0 when it was removed). */
export const AgentGrantSaved = Schema.Struct({
  status: Schema.Literal("ok"),
  id: Schema.String,
  revision: Revision,
});

export type AgentGrantSaved = typeof AgentGrantSaved.Type;

/** The `If-Match` request header: the revision the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const idParam = { params: { id: Schema.String } };

export class AgentsGroup extends HttpApiGroup.make("agents").add(
  HttpApiEndpoint.get("list", "/agents", { success: AgentsList, error: managementErrors }),
  HttpApiEndpoint.get("mine", "/agents/mine", { success: UsableAgents, error: managementErrors }),
  /**
   * `422 invalid` (a name, a length, a tool scope, a watcher or a subject), `422 unknown_model` (`path: "model"`), `422
   * unknown_toolkit` (`path: "tool_scope"`), `422 unknown_agent` (an agent its tool scope names that the owner may not
   * use), `409 name_taken`, `403 forbidden` (a private agent by a caller who is no member), `403
   * private_agents_unavailable`. A plain member's agent is private whatever `private` says.
   *
   * Names are unique across private and shared agents, as a name is the agents toolkit's `agent` argument and must mean
   * one agent whoever calls. A deliberate choice: `409 name_taken` can reveal a name used by an agent the caller cannot
   * see (another member's private agent).
   */
  HttpApiEndpoint.post("create", "/agents", {
    payload: CreateAgent,
    success: CreatedAgentView.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  HttpApiEndpoint.get("get", "/agents/:id", {
    ...idParam,
    success: AgentViewOrLimited,
    error: managementErrors,
  }),
  /**
   * As `create`'s refusals, and `409 conflict` for a stale revision; `403 forbidden` for an edit an admin may not make.
   */
  HttpApiEndpoint.patch("update", "/agents/:id", {
    ...idParam,
    ...IfMatch,
    payload: UpdateAgent,
    success: AgentViewOrLimited,
    error: managementErrors,
  }),
  /** Deletes the agent at once (ADR 0027) with its grants and Spend limits. */
  HttpApiEndpoint.delete("remove", "/agents/:id", {
    ...idParam,
    ...IfMatch,
    success: RemovedAgent,
    error: managementErrors,
  }),
) {}

/**
 * Agent grants (`/v9/management/grants/agents`, ADR 0040): which shared agents a member, a team or everyone may use,
 * beside the model grants (`/grants`) and the tool grants (`/grants/tools`). Org admins only; there is no default
 * grant.
 */
export class AgentGrantsGroup extends HttpApiGroup.make("agentGrants").add(
  HttpApiEndpoint.get("list", "/grants/agents", { success: AgentGrants, error: managementErrors }),
  /**
   * `409 conflict` when the subject holds a grant of the agent already, `422 invalid` for an unknown subject or agent.
   */
  HttpApiEndpoint.post("create", "/grants/agents", {
    payload: AgentGrantBody,
    success: AgentGrantSaved,
    error: managementErrors,
  }),
  HttpApiEndpoint.put("replace", "/grants/agents/:id", {
    ...idParam,
    ...IfMatch,
    payload: AgentGrantBody,
    success: AgentGrantSaved,
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("remove", "/grants/agents/:id", {
    ...idParam,
    ...IfMatch,
    success: AgentGrantSaved,
    error: managementErrors,
  }),
) {}

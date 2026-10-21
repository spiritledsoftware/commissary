// The Agents pages' model (#233, ADR 0040, GLOSSARY "Hosted agent"): who may create which agents, each agent's row in the
// list and its order, what an org admin sees of other members' private agents, the thinking levels, and what a refused
// write says. The server decides what each caller sees and enforces every rule again; this keeps the panel from offering
// what would be refused. Pure: no DOM, tested in test/agents.test.ts.
import type {
  AgentView,
  LimitedAgentView,
  ThinkingLevel,
  UsableAgent,
} from "@commissary/contract/agents";
import type { Me } from "@commissary/contract/orgs";
import { asSentence } from "./failure.ts";
import { formatDate } from "./format.ts";
import { atLeast, effectiveRole } from "./role.ts";
import type { Outcome } from "./use-action.ts";

/** What the caller may do in the org the panel shows, as far as agents go. */
export interface AgentsCaller {
  /** An org admin (or owner): shared agents, and what other members' private agents show of themselves. */
  readonly admin: boolean;
  /** The org lets members create private agents (`private_agents`). */
  readonly privateAgents: boolean;
}

/** The caller as `GET /me` (addressed to the org) says: a setting it leaves out is off. */
export const agentsCallerOf = (
  me: Pick<Me, "role" | "platform_admin" | "private_agents">,
): AgentsCaller => ({
  admin: atLeast(effectiveRole(me), "admin"),
  privateAgents: me.private_agents === true,
});

/** An org admin creates shared agents, and private ones where the org allows them; a member private ones only. */
export const canCreateAgent = (caller: AgentsCaller): boolean =>
  caller.admin || caller.privateAgents;

/** Whether the caller may create a private agent: where the org allows them (an admin's too). */
export const canCreatePrivate = (caller: AgentsCaller): boolean => caller.privateAgents;

/** Whether the caller may create a shared agent: org admins only. */
export const canCreateShared = (caller: AgentsCaller): boolean => caller.admin;

/** The thinking levels an agent's model calls may ask for, in the order the picker lists them. */
export const THINKING_LEVELS: ReadonlyArray<{
  readonly id: ThinkingLevel;
  readonly label: string;
}> = [
  { id: "none", label: "None" },
  { id: "auto", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

/** The thinking level a picker's value names, if it names one. */
export const thinkingOf = (value: string): ThinkingLevel | undefined =>
  THINKING_LEVELS.find((level) => level.id === value)?.id;

export const thinkingLabel = (level: ThinkingLevel): string =>
  THINKING_LEVELS.find((each) => each.id === level)?.label ?? level;

// ---------------------------------------------------------------------------------------------------------------
// The list

/** One agent of the list: what the caller manages. */
export interface AgentRow {
  readonly agent: AgentView;
  /** "Model, thinking level", as the row's secondary line says it. */
  readonly model: string;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Enabled agents first, then by name: a disabled one is set aside, not hidden. */
export const sortAgents = (agents: ReadonlyArray<AgentView>): ReadonlyArray<AgentView> =>
  agents.toSorted(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) || compare(a.name, b.name) || compare(a.id, b.id),
  );

export const modelText = (agent: Pick<AgentView, "model" | "thinking">): string =>
  agent.thinking === undefined || agent.thinking === "none"
    ? agent.model
    : `${agent.model}, thinking ${thinkingLabel(agent.thinking).toLowerCase()}`;

export const agentRow = (agent: AgentView): AgentRow => ({ agent, model: modelText(agent) });

/** The toolkits an agent's scope names, as the list's Tools column says it. */
export const scopeText = (agent: Pick<AgentView, "tool_scope">): string => {
  const toolkits = agent.tool_scope.length;

  if (toolkits === 0) return "No tools";

  return toolkits === 1 ? "1 toolkit" : `${toolkits} toolkits`;
};

/** The shared agents a member may use but does not manage: what `GET /agents/mine` has beyond their own. */
export const sharedWithCaller = (
  managed: ReadonlyArray<AgentView>,
  usable: ReadonlyArray<UsableAgent>,
): ReadonlyArray<UsableAgent> => {
  const known = new Set(managed.map((agent) => agent.id));

  return usable
    .filter((agent) => !agent.private && !known.has(agent.id))
    .toSorted((a, b) => compare(a.name, b.name));
};

/** What an org admin sees of another member's private agent (existence only, ADR 0040). */
export interface OtherAgentRow {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly added: string;
  readonly enabled: boolean;
  readonly revision: number;
}

export const otherAgentRows = (
  others: ReadonlyArray<LimitedAgentView>,
): ReadonlyArray<OtherAgentRow> =>
  others
    .map((other) => ({
      id: other.id,
      name: other.name,
      owner: other.owner.email ?? other.owner.member_id,
      added: `Added ${formatDate(Date.parse(other.created_at))}`,
      enabled: other.enabled,
      revision: other.revision,
    }))
    .toSorted((a, b) => compare(a.owner, b.owner) || compare(a.name, b.name));

/** What the list says while it is empty. */
export const emptyAgentsText = (caller: AgentsCaller): string => {
  if (caller.admin)
    return caller.privateAgents
      ? "No agents yet. Create a shared agent for the org, or a private one of your own."
      : "No agents yet. Create a shared agent and say who may use it.";

  return caller.privateAgents
    ? "You have no agents yet. Create a private one: a model, instructions and the tools it may use."
    : "You have no agents. An org admin creates shared agents and says who may use them.";
};

/** The line under a member's list when the org has not allowed private agents. */
export const privateOffText = (caller: AgentsCaller): string | undefined =>
  caller.privateAgents
    ? undefined
    : caller.admin
      ? "Members cannot create private agents: the setting is off on the Members page. Private agents they made stay in place, and none runs."
      : "Your org does not let members create private agents. Ones you made earlier stay in place, and none runs.";

// ---------------------------------------------------------------------------------------------------------------
// Refused writes

/**
 * What a refused agent write says, by the server's error code. Codes without copy fall back to the server's own
 * explanation, then to the message.
 */
export const agentProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "name_taken":
      return "Another agent of the org has this name. Names are shared by private and shared agents, since a name is what the agents toolkit calls.";
    case "unknown_model":
      return "No model of this name is in reach for this agent. Pick one from the list.";
    case "unknown_toolkit":
      return "A toolkit in the tool scope is no longer there. Reload to see the current toolkits.";
    case "unknown_agent":
      return "An agent the tool scope names is no longer there. Reload to see the current agents.";
    case "invalid_sandbox":
      return detail === undefined
        ? "The sandbox is beyond what the sandbox toolkit allows."
        : asSentence(detail);
    case "private_agents_unavailable":
      return "The org does not let members create private agents. An org admin turns it on on the Members page.";
    case "conflict":
      return "Someone changed this since you loaded it. Reload to see the current version.";
    case "forbidden":
      return "Only an org admin changes a shared agent, and only its member changes a private one.";
    case "not_found":
      return "This agent is gone. Reload to see the current list.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

export const problemOf = <A>(outcome: Outcome<A>): string | undefined =>
  outcome.ok ? undefined : agentProblem(outcome.error, outcome.message, outcome.detail);

/** Which field of the editor a refusal is about, when it names one. */
export const problemField = (
  error: string | undefined,
  path: string | undefined,
): "name" | "model" | "scope" | "sandbox" | undefined => {
  if (error === "name_taken") return "name";

  if (error === "unknown_model" || path === "model") return "model";

  if (error === "unknown_toolkit" || error === "unknown_agent" || path === "tool_scope")
    return "scope";

  if (error === "invalid_sandbox" || path === "sandbox") return "sandbox";

  return undefined;
};

/** The `If-Match` of a write of anything with a revision: an agent, a trigger, a grant, a Spend limit. */
export const ifMatch = (stored: { readonly revision: number }) => ({
  "if-match": String(stored.revision),
});

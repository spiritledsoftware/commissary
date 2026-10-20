/**
 * The agents toolkit (ADR 0040, #229): the built-in toolkit (`agents`, `AGENTS_TOOLKIT`) through which clients and agent
 * runs start, steer, wait for, watch and cancel runs of the hosted agents they may use. Tools lists it beside the other
 * built-in toolkits and decides who reaches its tools (tool scopes and tool classes apply as to any toolkit's), but it
 * does not make its calls: a run lives in the API Worker's `AgentRun` objects, which the state Worker cannot bind, so
 * the MCP endpoint hands each call it reached to the agents area through the Worker it runs in
 * (`AgentsToolkitPort`, `mcp/agents-port.ts`).
 *
 * **Who may run which agent** comes from the agents, never from tool grants: a member reaches the agents toolkit as
 * soon as they may use an agent (their private agents and the shared agents granted to them, #226), a shared agent's
 * run as soon as its definition reaches one. The Agents area answers which agents those are ({@link AgentDirectory},
 * which the state Worker fills from the Agents part of the same ControlPlane); a tool scope narrows them further by the
 * agents its entry for the toolkit names (`agentsInScope`). The toolkit is listed only to a caller who may run at
 * least one agent, and `agents_start`'s description lists them by name ({@link startDescription}), rebuilt on every
 * list.
 */
import { AGENTS_TOOL_NAMES, AGENTS_TOOLS } from "@commissary/contract/agents-toolkit";
import { AGENTS_TOOLKIT, agentsInScope, type ToolScope } from "@commissary/contract/api-keys";
import { Schema } from "effect";

/** Whether `toolkit` is the agents toolkit: the built-in toolkit of id {@link AGENTS_TOOLKIT}, never a stored one. */
export const isAgentsToolkit = (toolkit: {
  readonly id: string;
  readonly builtIn: boolean;
}): boolean => toolkit.builtIn && toolkit.id === AGENTS_TOOLKIT;

/** An agent a caller may run, as `agents_start`'s description names it. */
export interface RunnableAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/**
 * The Agents area's answer to which agents a caller may run (its reach in the Agents area, GLOSSARY "Reach"): the
 * enabled agents `member` may use, or, for a shared agent's run (`member` undefined), the org's enabled shared agents.
 * The state Worker fills it from the Agents part of the same ControlPlane; Tools imports nothing of Agents.
 */
export interface AgentDirectory {
  readonly runnable: (member: string | undefined) => ReadonlyArray<RunnableAgent>;
}

/** The agents toolkit's tools as it lists them: write tools unless they only read (ADR 0038). */
export const AGENTS_TOOL_LIST = AGENTS_TOOL_NAMES.map((name) => ({
  name,
  description: AGENTS_TOOLS[name].description,
  // SAFETY: a JSON Schema document's schema is a JSON object.
  inputSchema: Schema.toJsonSchemaDocument(AGENTS_TOOLS[name].arguments)
    .schema as Schema.JsonObject,
  annotations: { readOnlyHint: AGENTS_TOOLS[name].toolClass === "read" },
}));

/**
 * The agents a caller may run: those `directory` gives them (as `member`, or as a shared agent when `asAgent`),
 * narrowed by their tool scope's agents, without a calling run's own agent. A caller with neither a member nor a shared agent behind it (an Access service
 * token) may run none.
 */
export const runnableAgents = (
  directory: AgentDirectory,
  caller: {
    readonly member: string | undefined;
    readonly asAgent: boolean;
    readonly scope: ToolScope | undefined;
    /** A calling run's agent, which it may not start (#229: an agent runs once in a chain). */
    readonly self?: string | undefined;
  },
): ReadonlyArray<RunnableAgent> => {
  if (!caller.asAgent && caller.member === undefined) return [];
  const named = agentsInScope(caller.scope);

  return directory
    .runnable(caller.asAgent ? undefined : caller.member)
    .filter(
      (agent) => agent.id !== caller.self && (named === undefined || named.includes(agent.id)),
    );
};

/** `agents_start`'s description for a caller who may run `agents`: the tool's own, then each agent's name and description. */
export const startDescription = (agents: ReadonlyArray<RunnableAgent>): string =>
  [
    AGENTS_TOOLS.start.description,
    "",
    "The agents you may run (`agent`):",
    ...agents.map((agent) =>
      agent.description === "" ? `- ${agent.name}` : `- ${agent.name}: ${agent.description}`,
    ),
  ].join("\n");

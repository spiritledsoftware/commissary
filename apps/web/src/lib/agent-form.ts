// The agent editor's model (#233, ADR 0040, ADR 0041): an agent as the form edits it, what is wrong with a draft, the
// body a draft becomes on creation, the patch it becomes on an edit (only what changed), the tool scope it sends (the
// tool scope editor's draft, #200, plus which agents the agents toolkit may run) and the sandbox it asks for within its
// toolkit's ceiling. Pure: no DOM, tested in test/agent-form.test.ts.
import {
  AGENTS_TOOLKIT,
  agentsInScope,
  type ToolScope,
  type ToolScopeEntry,
} from "@commissary/contract/api-keys";
import {
  type AgentSandbox,
  type AgentView,
  type AgentWatcher,
  CreateAgent,
  type ThinkingLevel,
  type UpdateAgent,
} from "@commissary/contract/agents";
import type { GrantSubject } from "@commissary/contract/grants";
import type { SpendPeriod } from "@commissary/contract/spend";
import type { SandboxNetwork, ToolkitView } from "@commissary/contract/tools";
import {
  fieldsOfNetwork,
  hostsProblem,
  type NetworkFields,
  type NetworkKind,
  networkOfFields,
} from "./sandbox-network.ts";
import { type ScopeDraft, draftOfScope, pickOf, scopeOfDraft } from "./tool-scope.ts";
import { parseDollars } from "./spend.ts";

/** An agent's name: 1 to 64 lowercase letters, digits and underscores (the agents toolkit's `agent` argument). */
export const NAME_PATTERN = /^[a-z0-9_]{1,64}$/;

export const MAX_DESCRIPTION = 1_000;

export const MAX_INSTRUCTIONS = 65_536;

export const MAX_MODEL = 200;

// ---------------------------------------------------------------------------------------------------------------
// The sandbox

/** The sandbox part of a draft: whether the agent has one, which toolkit, and what its session may have. */
export interface SandboxDraft extends NetworkFields {
  readonly on: boolean;
  /** The sandbox toolkit's id. */
  readonly toolkit: string;
  readonly computer: boolean;
}

export const NO_SANDBOX: SandboxDraft = {
  on: false,
  toolkit: "",
  network: "none",
  hosts: "",
  registries: false,
  computer: false,
};

/** The toolkits an agent may work in: sandbox toolkits the caller sees. */
export const sandboxToolkits = (toolkits: ReadonlyArray<ToolkitView>): ReadonlyArray<ToolkitView> =>
  toolkits.filter((toolkit) => toolkit.kind === "sandbox");

/** The toolkit whose ceiling bounds a draft's sandbox: the one it names, else the only one there is. */
export const sandboxCeiling = (
  toolkits: ReadonlyArray<ToolkitView>,
  draft: SandboxDraft,
): ToolkitView | undefined => {
  const sandboxes = sandboxToolkits(toolkits);

  return sandboxes.find((toolkit) => toolkit.id === draft.toolkit) ?? sandboxes[0];
};

/** The sandbox a draft asks for; `undefined` for an agent without one. */
export const sandboxOf = (draft: SandboxDraft): AgentSandbox | undefined => {
  if (!draft.on) return undefined;

  return {
    toolkit: draft.toolkit,
    network: networkOfFields(draft),
    ...(draft.computer ? { computer: true } : {}),
  };
};

/** The draft of a stored sandbox. */
export const draftOfSandbox = (sandbox: AgentSandbox | undefined): SandboxDraft => {
  if (sandbox === undefined) return NO_SANDBOX;

  return {
    on: true,
    toolkit: sandbox.toolkit,
    ...fieldsOfNetwork(sandbox.network),
    computer: sandbox.computer === true,
  };
};

/**
 * A note for a sandbox the tool scope gives none of the tools of: a run's bash, read, write and edit are each gated as
 * the sandbox toolkit's tool of the same name (#230), so the scope must give them. `undefined` when it does.
 */
export const sandboxScopeNote = (draft: AgentDraft): string | undefined =>
  draft.sandbox.on &&
  draft.sandbox.toolkit !== "" &&
  pickOf(draft.scope, draft.sandbox.toolkit).choice === "none"
    ? "The tool scope gives it none of this toolkit's tools, so its runs cannot call bash or the file tools."
    : undefined;

const RANK: Readonly<Record<NetworkKind, number>> = { none: 0, hosts: 1, open: 2 };

/**
 * Whether the toolkit's ceiling lets an agent ask for a kind of network (the server checks each host again): no network
 * always, a list of hosts under a ceiling of hosts or the internet, the internet under the internet.
 */
export const networkAllowed = (kind: NetworkKind, ceiling: SandboxNetwork | undefined): boolean =>
  RANK[kind] <= RANK[ceiling?.kind ?? "none"];

const networkText = (network: NonNullable<ToolkitView["network"]>): string => {
  if (network.kind === "none") return "no network";

  if (network.kind === "open") return "the internet";

  return network.hosts.length === 0 ? "only the package registries" : "only the hosts it lists";
};

/** What the toolkit allows, to follow "The sandbox toolkit allows": "no network and no computer". */
export const sandboxCeilingText = (toolkit: Pick<ToolkitView, "network" | "computer">): string =>
  `${networkText(toolkit.network ?? { kind: "none" })} and ${toolkit.computer === true ? "the computer" : "no computer"}`;

// ---------------------------------------------------------------------------------------------------------------
// The draft

/** Which agents the agents toolkit's entry may run, besides the toolkit's choice of tools. */
export interface AgentsDraft {
  /** `false`: any agent within reach; `true`: only {@link ids}. */
  readonly limited: boolean;
  readonly ids: ReadonlyArray<string>;
}

export interface AgentDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** As clients send it. */
  readonly model: string;
  /** `""`: the model's own default. */
  readonly thinking: ThinkingLevel | "";
  /** An agent's scope is always limited: `[]` is no tools. */
  readonly scope: ScopeDraft;
  readonly agents: AgentsDraft;
  readonly sandbox: SandboxDraft;
  readonly enabled: boolean;
  /** Shared agents. */
  readonly watchers: ReadonlyArray<AgentWatcher>;
  /** Creating a shared agent: who may use it (`""` until chosen). */
  readonly subjectKind: GrantSubject["kind"] | "";
  readonly subjectId: string;
  /** Creating a shared agent: an optional spend limit, a typed dollar amount (`""`: none). */
  readonly limitAmount: string;
  readonly limitPeriod: SpendPeriod;
}

export const EMPTY_DRAFT: AgentDraft = {
  name: "",
  description: "",
  instructions: "",
  model: "",
  thinking: "",
  scope: { limited: true, picks: {} },
  agents: { limited: false, ids: [] },
  sandbox: NO_SANDBOX,
  enabled: true,
  watchers: [],
  subjectKind: "",
  subjectId: "",
  limitAmount: "",
  limitPeriod: "day",
};

export const draftOfAgent = (agent: AgentView): AgentDraft => {
  const named = agentsInScope(agent.tool_scope);

  return {
    ...EMPTY_DRAFT,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    model: agent.model,
    thinking: agent.thinking ?? "",
    scope: { ...draftOfScope(agent.tool_scope), limited: true },
    agents: { limited: named !== undefined, ids: named ?? [] },
    sandbox: draftOfSandbox(agent.sandbox),
    enabled: agent.enabled,
    watchers: agent.watchers ?? [],
  };
};

/** The tool scope a draft sends: the tool scope editor's entries, and the agents the agents toolkit's entry may run. */
export const scopeOfAgentDraft = (draft: AgentDraft): ToolScope =>
  (scopeOfDraft({ ...draft.scope, limited: true }) ?? []).map((entry): ToolScopeEntry =>
    entry.toolkit === AGENTS_TOOLKIT && draft.agents.limited && draft.agents.ids.length > 0
      ? { ...entry, agents: [...draft.agents.ids] }
      : entry,
  );

// ---------------------------------------------------------------------------------------------------------------
// Validation

export interface DraftErrors {
  name?: string;
  description?: string;
  instructions?: string;
  model?: string;
  scope?: string;
  sandbox?: string;
  subject?: string;
  limit?: string;
}

export const hasErrors = (errors: DraftErrors): boolean => Object.keys(errors).length > 0;

export const nameProblem = (name: string): string | undefined => {
  if (name === "") return "An agent needs a name.";

  return NAME_PATTERN.test(name)
    ? undefined
    : "Use 1 to 64 lowercase letters, digits and underscores: the name is what other agents and clients call it by.";
};

/** What is wrong with a draft before the server is asked. `shared` and `creating` add the fields of a new shared agent. */
export const validateDraft = (
  draft: AgentDraft,
  options: {
    readonly shared: boolean;
    readonly creating: boolean;
    /** The sandbox toolkit's ceiling for the draft's sandbox, when its toolkit is known. */
    readonly ceiling?: Pick<ToolkitView, "network" | "computer"> | undefined;
  },
): DraftErrors => {
  const errors: DraftErrors = {};
  const named = nameProblem(draft.name);

  if (named !== undefined) errors.name = named;

  if (draft.description.length > MAX_DESCRIPTION)
    errors.description = `At most ${MAX_DESCRIPTION.toLocaleString("en")} characters.`;

  if (draft.instructions.length > MAX_INSTRUCTIONS)
    errors.instructions = `At most ${MAX_INSTRUCTIONS.toLocaleString("en")} characters.`;

  if (draft.model.trim() === "") errors.model = "Pick the model the agent runs on.";
  else if (draft.model.trim().length > MAX_MODEL) errors.model = `At most ${MAX_MODEL} characters.`;

  // Which agents it may run matters only while the agents toolkit is in its scope.
  const runsAgents = scopeOfAgentDraft(draft).some((entry) => entry.toolkit === AGENTS_TOOLKIT);

  if (runsAgents && draft.agents.limited && draft.agents.ids.length === 0)
    errors.scope = "Pick the agents it may run, or let it run any agent within reach.";

  const sandbox = sandboxProblem(draft.sandbox, options.ceiling);

  if (sandbox !== undefined) errors.sandbox = sandbox;

  if (options.shared && options.creating) {
    if (draft.subjectKind === "")
      errors.subject = "Choose who may use this agent: there is no default.";
    else if (draft.subjectKind !== "everyone" && draft.subjectId === "")
      errors.subject = draft.subjectKind === "team" ? "Choose the team." : "Choose the member.";

    if (draft.limitAmount.trim() !== "" && parseDollars(draft.limitAmount) === undefined)
      errors.limit = "Type an amount in US dollars, such as 25 or 12.50 (up to six decimals).";
  }

  return errors;
};

/** What is wrong with the sandbox part of a draft, or `undefined`. */
export const sandboxProblem = (
  draft: SandboxDraft,
  ceiling?: Pick<ToolkitView, "network" | "computer">,
): string | undefined => {
  if (!draft.on) return undefined;

  if (draft.toolkit === "") return "Pick the sandbox toolkit it works in.";

  const hosts = hostsProblem(draft);

  if (hosts !== undefined) return hosts;

  if (ceiling !== undefined) {
    if (!networkAllowed(draft.network, ceiling.network))
      return `The sandbox toolkit allows ${sandboxCeilingText(ceiling)}.`;

    if (draft.computer && ceiling.computer !== true)
      return "The sandbox toolkit does not allow the computer.";
  }

  return undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// The bodies

const sameJson = <A, B>(a: A, b: B): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A stored or drafted sandbox with its defaults written out, so "none" and "left out" compare equal. */
const normalSandbox = (sandbox: AgentSandbox | undefined) =>
  sandbox === undefined
    ? undefined
    : {
        toolkit: sandbox.toolkit,
        network: sandbox.network ?? { kind: "none" },
        computer: sandbox.computer === true,
      };

/** A body built a field at a time. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** The same watchers, whatever their order. */
const watcherKeys = (watchers: ReadonlyArray<AgentWatcher>): ReadonlyArray<string> =>
  watchers.map((watcher) => `${watcher.kind}:${watcher.id}`).toSorted();

/** The subject a picker's two values name, once both are chosen (everyone needs no id). */
export const subjectOfPick = (
  kind: GrantSubject["kind"] | "",
  subjectId: string,
): GrantSubject | undefined => {
  if (kind === "everyone") return { kind: "everyone" };

  if (kind === "" || subjectId === "") return undefined;

  return { kind, id: subjectId };
};

/** What creating an agent sends. A shared agent names who may use it; a private one has no subject or watchers. */
export const createBody = (draft: AgentDraft, shared: boolean): CreateAgent => {
  const sandbox = sandboxOf(draft.sandbox);

  const subject = subjectOfPick(draft.subjectKind, draft.subjectId);

  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions,
    model: draft.model.trim(),
    ...(draft.thinking === "" ? {} : { thinking: draft.thinking }),
    tool_scope: scopeOfAgentDraft(draft),
    ...(sandbox === undefined ? {} : { sandbox }),
    private: !shared,
    ...(shared && subject !== undefined ? { subject } : {}),
    ...(shared && draft.watchers.length > 0 ? { watchers: draft.watchers } : {}),
  };
};

/** What editing an agent sends: only the fields that differ from the stored agent. */
export const updatePatch = (agent: AgentView, draft: AgentDraft): UpdateAgent => {
  const patch: Writable<UpdateAgent> = {};
  const name = draft.name.trim();
  const description = draft.description.trim();
  const model = draft.model.trim();

  if (name !== agent.name) patch.name = name;

  if (description !== agent.description) patch.description = description;

  if (draft.instructions !== agent.instructions) patch.instructions = draft.instructions;

  if (model !== agent.model) patch.model = model;

  if (draft.thinking !== (agent.thinking ?? ""))
    patch.thinking = draft.thinking === "" ? null : draft.thinking;

  const scope = scopeOfAgentDraft(draft);

  if (!sameJson(scope, agent.tool_scope)) patch.tool_scope = scope;

  const sandbox = sandboxOf(draft.sandbox);

  if (!sameJson(normalSandbox(sandbox), normalSandbox(agent.sandbox)))
    patch.sandbox = sandbox ?? null;

  if (draft.enabled !== agent.enabled) patch.enabled = draft.enabled;

  if (!agent.private && !sameJson(watcherKeys(draft.watchers), watcherKeys(agent.watchers ?? [])))
    patch.watchers = draft.watchers;

  return patch;
};

export const hasChanges = (patch: UpdateAgent): boolean => Object.keys(patch).length > 0;

// ---------------------------------------------------------------------------------------------------------------
// Watchers

/** Adds a watcher unless it is one already. */
export const addWatcher = (
  watchers: ReadonlyArray<AgentWatcher>,
  watcher: AgentWatcher,
): ReadonlyArray<AgentWatcher> =>
  watchers.some((each) => each.kind === watcher.kind && each.id === watcher.id)
    ? watchers
    : [...watchers, watcher];

export const removeWatcher = (
  watchers: ReadonlyArray<AgentWatcher>,
  watcher: AgentWatcher,
): ReadonlyArray<AgentWatcher> =>
  watchers.filter((each) => !(each.kind === watcher.kind && each.id === watcher.id));

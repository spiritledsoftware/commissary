/**
 * The Agents part's side of agent runs (#227, ADR 0040): starting a run (its row in the org's index, `store.ts`), who
 * sees it, and what a run is at each turn.
 *
 * **Who sees a run** in the panel (#232, ADR 0040 "Who watches and steers", {@link Runs.accessOf}): its starter; for a
 * shared agent's run that no one started, the agent's watchers (GLOSSARY "Watcher"); and an org admin, every shared
 * agent's run, child runs included, as its metadata only. Its starter and its watchers watch, steer and cancel it; an
 * org admin cancels any run of the org ({@link Runs.cancellableBy}), a private agent's without seeing it. The people
 * who answer a run's approvals and handoffs are those who watch it ({@link Runs.watchersOf}): the member at the head of
 * its chain, or, when no one started that run, its agent's watchers.
 *
 * **Turns read the definition once.** A turn reads the agent's definition when it starts ({@link Runs.beginTurn}, the
 * run's Durable Object calls it), and every call of that turn reaches what that reading allowed
 * ({@link Runs.turnContext}, the API Worker's run gateway reads it on every request): an edit, a disable, a removal or
 * a revoked grant applies from the next turn, which ends the run when the agent or its starter can no longer go on. A
 * private agent's member who left the org stops the running turn at once: the run acted as them. The part's methods
 * delegate here; plain data in and out.
 *
 * **Runs a trigger starts** (#231, {@link Runs.startTriggered}): a schedule's or a webhook's run of a private agent
 * counts as started by its member, a shared agent's as started by no one (its watchers watch it, #232); either names its
 * trigger. A run no one started has no starter to check at its turns: its agent's state alone decides.
 *
 * **The agents toolkit** (#229, ADR 0040) starts runs too ({@link Runs.startFromToolkit}), with the trigger kind `mcp`:
 * a client's call as its member (an API key's, which the run records: a key sees only the runs it started), or a run's,
 * which starts a **child run** of the agent it names, acting as that agent and started by the calling run. A run may
 * run the agents its member may use (a private agent's) or the shared agents (a shared agent's), within its
 * definition's tool scope; a chain of runs is at most {@link MAX_CHAIN} deep, an agent already in the chain is refused,
 * and a run has at most {@link MAX_ACTIVE_CHILDREN} child runs running at once. A child run's turns check that the run
 * that started it is still there and may still run its agent; its approvals are the member's at the head of its chain
 * (its agent's watchers', when no one started that run, #232). A run that ends ends its child runs, and theirs
 * ({@link Runs.stateChanged}).
 */
import type { RunActsAs, RunStarter, Viewer } from "@commissary/auth";
import type { RunAccess, RunState, RunView, TriggerKind } from "@commissary/contract/agent-runs";
import type { AgentSandbox, ThinkingLevel } from "@commissary/contract/agents";
import { agentsInScope, type ToolScope } from "@commissary/contract/api-keys";
import type { OrgCore } from "@commissary/state";
import type { AgentStore, StoredAgent } from "../agents/store.ts";
import { iso, ok, type Refusable, refuse } from "../result.ts";
import {
  type DiscardedRuns,
  freshRunId,
  type RunStore,
  type StoredRun,
  type TurnDefinition,
} from "./store.ts";

/**
 * Why a run call was refused: by the part, or by the run's object (`unavailable`: the org's ControlPlane could not
 * be reached).
 */
export type RunsErrorCode =
  | "invalid"
  | "forbidden"
  | "not_found"
  | "agent_disabled"
  | "trigger_disabled"
  | "run_ended"
  | "unavailable";

export type RunsResult<A> = Refusable<RunsErrorCode, A>;

const RUN_NOT_FOUND = refuse("not_found", "run not found");

/** The longest idempotency key a start or a message takes. */
export const MAX_IDEMPOTENCY_KEY = 200;

/** A run at its running turn: whom it acts as, who started it, and its agent's definition as the turn read it. */
export interface RunContext {
  readonly runId: string;
  readonly agentId: string;
  /** None for a run no one started. */
  readonly starter?: RunStarter | undefined;
  /**
   * The member who started the run, or the one at the head of a child run's chain (#229): the caller of its approvals.
   * None for a run, or a chain, no one started.
   */
  readonly starterMember?: string | undefined;
  /** That member's email, whose standing Commissary Cloud checks on every call of the run. */
  readonly starterEmail?: string | undefined;
  readonly actsAs: RunActsAs;
  readonly model: string;
  readonly thinking?: ThinkingLevel | undefined;
  readonly instructions: string;
  /**
   * The tool scope of the turn's calls: its definition's, with the sandbox toolkit its sandbox names (#230) added, all
   * its tools, when the scope has no entry of that toolkit (one it has narrows the sandbox's tools as any other).
   */
  readonly toolScope: ToolScope;
  /** The sandbox its definition names (#230): the run's bash and file tools work in a session of it. */
  readonly sandbox?: AgentSandbox | undefined;
  /**
   * The run's sandbox session no longer fits that sandbox (#230, `AgentsPart.beginTurn`): the definition or the
   * toolkit's ceiling narrowed since it opened, or the definition names no sandbox or another toolkit now.
   */
  readonly sandboxNarrowed?: true | undefined;
}

/** A run in the org export (#228): its metadata, never its transcript. */
export interface RunExport {
  readonly id: string;
  readonly trigger: TriggerKind;
  /** The member (by email) or the run (by id, a child run) that started it; absent when no one did. */
  readonly starter?: { readonly member: string } | { readonly run: string };
  readonly state: RunState;
  readonly created_at: string;
  /** Its last activity, from which the org's retention period for agent runs counts. */
  readonly last_activity_at: string;
}

/** A page of the org's runs, for its deletion. */
export interface RunsPage {
  readonly ids: ReadonlyArray<string>;
  readonly total: number;
}

/** A started run: the run, and whether this start created it (or found the one its idempotency key started). */
export interface StartedRunRecord {
  readonly run: RunView;
  readonly created: boolean;
}

const isStarter = (run: StoredRun, member: string | undefined): boolean =>
  member !== undefined && run.starter?.kind === "member" && run.starter.id === member;

/**
 * `scope` with the sandbox toolkit `sandbox` names, all its tools, unless it has an entry of that toolkit already
 * (#230): a run whose definition names a sandbox reaches its tools, which its bash and file tools call.
 */
const withSandbox = (scope: ToolScope, sandbox: AgentSandbox | undefined): ToolScope =>
  sandbox === undefined || scope.some((entry) => entry.toolkit === sandbox.toolkit)
    ? scope
    : [...scope, { toolkit: sandbox.toolkit, tools: { kind: "all" } }];

const contextOf = (
  run: StoredRun,
  starter: { readonly id: string; readonly email: string } | undefined,
  definition: TurnDefinition,
): RunContext => ({
  runId: run.id,
  agentId: run.agent,
  ...(run.starter === undefined ? {} : { starter: run.starter }),
  ...(starter === undefined ? {} : { starterMember: starter.id, starterEmail: starter.email }),
  ...definition,
  toolScope: withSandbox(definition.toolScope, definition.sandbox),
});

/** The trigger configured on an agent that starts a run: its kind and id. */
export interface RunTrigger {
  readonly kind: Exclude<TriggerKind, "chat" | "mcp">;
  readonly id: string;
}

/** The longest chain of runs the agents toolkit starts: a run, its child and its grandchild (ADR 0040). */
export const MAX_CHAIN = 3;

/** The most child runs a run may have running at once (#229): a start beyond them is refused. */
export const MAX_ACTIVE_CHILDREN = 8;

/**
 * Who calls the agents toolkit (#229): a member, through an API key (`apiKeyId`, which sees only the runs it started) or
 * signed in (who sees every run they started); or an agent run, which sees the child runs it started.
 */
export type ToolkitCaller =
  | { readonly kind: "member"; readonly member: string; readonly apiKeyId?: string | undefined }
  | { readonly kind: "run"; readonly runId: string };

/** A child run's link to the run that started it (#229): that run, where its turns' results go, and its agent's name. */
export interface ChildOf {
  readonly parent: string;
  readonly agentName: string;
}

/** A run the agents toolkit started: the run, whether this start created it, and for a child run its link. */
export interface ToolkitStartedRun extends StartedRunRecord {
  readonly child?: ChildOf | undefined;
}

/** The calling run of a child run's start ended, or is not the org's. */
const CALLING_RUN_ENDED = refuse("run_ended", "the run that calls ended");

export class Runs {
  readonly #runs: RunStore;
  readonly #agents: AgentStore;
  readonly #core: OrgCore;
  /**
   * Whether `member` may use `agent`, enabled or not, as the part decides it (their reach in the Agents area: their
   * private agent while the org serves them, or a shared agent a grant gives them).
   */
  readonly #reaches: (agent: StoredAgent, member: string) => boolean;
  /** The part's clock (epoch ms), the triggers' too: a test's `TestClock` drives both. */
  readonly #now: () => number;
  /**
   * The members who watch a shared agent's runs that no one started, as the part decides it (its watchers, or its org
   * admins once none is left); `undefined` for a private agent or an unknown one.
   */
  readonly #watchers: (agent: string) => ReadonlyArray<string> | undefined;

  constructor(
    runs: RunStore,
    agents: AgentStore,
    core: OrgCore,
    reaches: (agent: StoredAgent, member: string) => boolean,
    now: () => number,
    watchers: (agent: string) => ReadonlyArray<string> | undefined,
  ) {
    this.#runs = runs;
    this.#agents = agents;
    this.#core = core;
    this.#reaches = reaches;
    this.#now = now;
    this.#watchers = watchers;
  }

  /**
   * Starts a run of `agentId` that `viewer` starts (a member: the panel's chat, `trigger` `chat`), or returns the run
   * their `idempotencyKey` already started of it. The agent must be one they may use: another answers like an unknown
   * one, a disabled one `agent_disabled`.
   */
  start(
    viewer: Viewer,
    agentId: string,
    trigger: TriggerKind,
    idempotencyKey: string | undefined,
  ): RunsResult<StartedRunRecord> {
    const member = viewer.member;

    if (member === undefined) return refuse("forbidden", "only a member of the org starts runs");

    if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY)
      return refuse("invalid", `an idempotency key has at most ${MAX_IDEMPOTENCY_KEY} characters`);

    const agent = this.#agents.agent(agentId);

    if (agent === undefined || !this.#reaches(agent, member))
      return refuse("not_found", "agent not found");

    if (!agent.enabled) return refuse("agent_disabled", "the agent is disabled");

    const starter: RunStarter = { kind: "member", id: member };

    if (idempotencyKey !== undefined) {
      const existing = this.#runs.byKey(agent.id, starter, idempotencyKey);

      if (existing !== undefined) return ok({ run: this.view(existing), created: false });
    }

    const now = this.#now();
    const id = freshRunId();

    const run: StoredRun = {
      id,
      agent: agent.id,
      trigger,
      starter,
      idempotencyKey: idempotencyKey ?? id,
      state: "idle",
      createdAt: now,
      updatedAt: now,
    };

    this.#runs.insert(run);

    return ok({ run: this.view(run), created: true });
  }

  /**
   * Starts a run of `agent` that its trigger `trigger` starts, or returns the run its `idempotencyKey` (a schedule's tick,
   * a webhook's delivery) already started. A private agent's run counts as started by its member, while the org serves
   * private agents; a shared agent's by no one. A disabled agent starts nothing (`agent_disabled`).
   */
  startTriggered(
    agent: StoredAgent,
    trigger: RunTrigger,
    idempotencyKey: string,
  ): RunsResult<StartedRunRecord> {
    if (!agent.enabled) return refuse("agent_disabled", "the agent is disabled");
    let starter: RunStarter | undefined;

    if (agent.owner !== undefined) {
      if (!this.#core.privateAgents() || this.#core.member(agent.owner) === undefined)
        return refuse("agent_disabled", "the org does not serve the agent's member's agents");

      starter = { kind: "member", id: agent.owner };
    }

    const existing = this.#runs.byKey(agent.id, starter, idempotencyKey);

    if (existing !== undefined) return ok({ run: this.view(existing), created: false });

    const now = this.#now();

    const run: StoredRun = {
      id: freshRunId(),
      agent: agent.id,
      trigger: trigger.kind,
      triggerId: trigger.id,
      ...(starter === undefined ? {} : { starter }),
      idempotencyKey,
      state: "idle",
      createdAt: now,
      updatedAt: now,
    };

    this.#runs.insert(run);

    return ok({ run: this.view(run), created: true });
  }

  /** Ends the run `runId` a trigger started, whose object could not be reached to start it. */
  abandonTriggered(runId: string): void {
    const run = this.#runs.run(runId);

    if (run !== undefined && run.triggerId !== undefined) this.#end(runId);
  }

  /**
   * Starts a run of the agent named `agentName` for `caller` through the agents toolkit (#229, trigger `mcp`), or returns
   * the run their `idempotencyKey` started of it before. The agent must be one the caller may run (`scopeAgents`: the
   * ones their tool scope names, `undefined` for all): any other answers like an unknown one; a member's disabled agent
   * answers `agent_disabled`, a run's like an unknown one. A run's call starts a child run, refused (`forbidden`) when
   * the chain would be deeper than {@link MAX_CHAIN}, the agent already runs in it, or the run has
   * {@link MAX_ACTIVE_CHILDREN} child runs running.
   */
  startFromToolkit(
    caller: ToolkitCaller,
    agentName: string,
    scopeAgents: ReadonlyArray<string> | undefined,
    idempotencyKey: string | undefined,
  ): RunsResult<ToolkitStartedRun> {
    if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY)
      return refuse("invalid", `an idempotency key has at most ${MAX_IDEMPOTENCY_KEY} characters`);

    const unknown = refuse("not_found", `unknown agent ${agentName}`);
    const agent = this.#agents.byName(agentName.trim());

    if (agent === undefined || (scopeAgents !== undefined && !scopeAgents.includes(agent.id)))
      return unknown;

    let starter: RunStarter;

    if (caller.kind === "member") {
      if (!this.#reaches(agent, caller.member)) return unknown;

      if (!agent.enabled) return refuse("agent_disabled", "the agent is disabled");
      starter = { kind: "member", id: caller.member };
    } else {
      const calling = this.#runs.run(caller.runId);

      if (calling === undefined || calling.state === "ended") return CALLING_RUN_ENDED;

      if (!this.#mayRun(calling, agent)) return unknown;
      const chain = this.#chain(calling);

      if (chain.length >= MAX_CHAIN)
        return refuse(
          "forbidden",
          `a chain of runs is at most ${MAX_CHAIN} deep: this run cannot start another`,
        );

      if (chain.some((run) => run.agent === agent.id))
        return refuse(
          "forbidden",
          `the agent ${agent.name} already runs in this chain of runs: a chain cannot run an agent twice`,
        );

      starter = { kind: "run", id: calling.id };
    }

    const apiKeyId = caller.kind === "member" ? caller.apiKeyId : undefined;

    const child =
      starter.kind === "run" ? { child: { parent: starter.id, agentName: agent.name } } : {};

    // Apart from the panel's keys, and one API key's from another's.
    const key =
      idempotencyKey === undefined ? undefined : `mcp:${apiKeyId ?? ""}:${idempotencyKey}`;

    if (key !== undefined) {
      const existing = this.#runs.byKey(agent.id, starter, key);

      if (existing !== undefined) return ok({ run: this.view(existing), created: false, ...child });
    }

    if (starter.kind === "run" && this.#runs.runningStartedBy(starter) >= MAX_ACTIVE_CHILDREN)
      return refuse(
        "forbidden",
        `a run has at most ${MAX_ACTIVE_CHILDREN} child runs running at once: wait for one to finish`,
      );

    const now = this.#now();
    const id = freshRunId();

    const run: StoredRun = {
      id,
      agent: agent.id,
      trigger: "mcp",
      starter,
      ...(apiKeyId === undefined ? {} : { apiKeyId }),
      idempotencyKey: key ?? id,
      // A child run counts as running from its start, so that the cap holds for starts made at once.
      state: starter.kind === "run" ? "running" : "idle",
      createdAt: now,
      updatedAt: now,
    };

    this.#runs.insert(run);

    return ok({ run: this.view(run), created: true, ...child });
  }

  /** The run `runId` if the agents toolkit's `caller` sees it ({@link ToolkitCaller}); any other answers like an unknown one. */
  ofToolkitCaller(caller: ToolkitCaller, runId: string): RunsResult<RunView> {
    const run = this.#runs.run(runId);

    return run !== undefined && this.#sees(caller, run) ? ok(this.view(run)) : RUN_NOT_FOUND;
  }

  /** The runs the agents toolkit's `caller` sees, the latest activity first. */
  ofToolkitCallerAll(caller: ToolkitCaller): ReadonlyArray<RunView> {
    const runs =
      caller.kind === "run"
        ? this.#runs.startedBy({ kind: "run", id: caller.runId })
        : caller.apiKeyId === undefined
          ? this.#runs.startedBy({ kind: "member", id: caller.member })
          : this.#runs.startedByKey(caller.apiKeyId);

    return runs.map((run) => this.view(run));
  }

  /** Ends the run `runId` the agents toolkit's `caller` started, whose object could not be reached to start it. */
  abandonFromToolkit(caller: ToolkitCaller, runId: string): void {
    const run = this.#runs.run(runId);

    if (run !== undefined && this.#sees(caller, run)) this.#end(run.id);
  }

  /** Whether the agents toolkit's `caller` sees `run`: one it started (a key: through that key). */
  #sees(caller: ToolkitCaller, run: StoredRun): boolean {
    if (caller.kind === "run")
      return run.starter?.kind === "run" && run.starter.id === caller.runId;

    return caller.apiKeyId === undefined
      ? isStarter(run, caller.member)
      : run.apiKeyId === caller.apiKeyId && isStarter(run, caller.member);
  }

  /**
   * Whether the run `calling` may run `agent`, as its latest turn read its definition: a private agent's run any agent
   * its member may use, a shared agent's run the shared agents, within the agents its tool scope names. A disabled agent
   * it may not run, so that a refusal tells nothing of an agent's existence.
   */
  #mayRun(calling: StoredRun, agent: StoredAgent): boolean {
    const definition = calling.definition;

    if (definition === undefined || !agent.enabled) return false;
    const named = agentsInScope(definition.toolScope);

    if (named !== undefined && !named.includes(agent.id)) return false;

    return definition.actsAs.kind === "member"
      ? this.#reaches(agent, definition.actsAs.memberId)
      : agent.owner === undefined;
  }

  /** `run` and the runs that started it, the run first: at most {@link MAX_CHAIN} and one more. */
  #chain(run: StoredRun): ReadonlyArray<StoredRun> {
    const chain = [run];

    for (let current = run; current.starter?.kind === "run" && chain.length <= MAX_CHAIN;) {
      const parent = this.#runs.run(current.starter.id);

      if (parent === undefined) break;
      chain.push(parent);
      current = parent;
    }

    return chain;
  }

  /**
   * The member at the head of `run`'s chain (#229): its starter, or its first run's; `none` when no one started that run
   * (a shared agent's trigger); `gone` when the chain's head is a run no longer in the index.
   */
  #starterMember(run: StoredRun): { readonly id: string } | "none" | "gone" {
    const head = this.#chain(run).at(-1) ?? run;

    if (head.starter === undefined) return "none";

    return head.starter.kind === "member" ? { id: head.starter.id } : "gone";
  }

  /** Ends the run `runId` in the index, and the child runs it started, and theirs (#229): answers the runs it ended. */
  #end(runId: string): ReadonlyArray<string> {
    const now = this.#now();
    const pending = [runId];
    const ended: Array<string> = [];

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      this.#runs.setState(next, "ended", now);
      ended.push(next);

      for (const child of this.#runs.startedBy({ kind: "run", id: next }))
        if (child.state !== "ended") pending.push(child.id);
    }

    return ended;
  }

  /**
   * Why `viewer` sees `run` in the panel (#232, ADR 0040), if they do: they started it (`starter`); it is a shared
   * agent's run no one started, and they watch the agent (`watcher`); or they are an org admin and it is a shared
   * agent's run (`admin`, its metadata only). A starter and a watcher watch, steer and cancel it; an org admin only
   * cancels it.
   */
  accessOf(viewer: Viewer, run: StoredRun): RunAccess | undefined {
    if (isStarter(run, viewer.member)) return "starter";

    const agent = this.#agents.agent(run.agent);
    const shared = agent !== undefined && agent.owner === undefined;

    if (
      viewer.member !== undefined &&
      run.starter === undefined &&
      shared &&
      (this.#watchers(run.agent) ?? []).includes(viewer.member)
    )
      return "watcher";

    return viewer.admin && shared ? "admin" : undefined;
  }

  /** The run `runId` as `viewer` sees it in the panel, with why ({@link accessOf}); any other answers as unknown. */
  ofViewer(viewer: Viewer, runId: string): RunsResult<RunView> {
    const run = this.#runs.run(runId);
    const access = run === undefined ? undefined : this.accessOf(viewer, run);

    return run === undefined || access === undefined
      ? RUN_NOT_FOUND
      : ok(this.#viewAs(run, access));
  }

  /**
   * The runs `viewer` sees in the panel, the latest activity first ({@link accessOf}): those they started, the runs no
   * one started of the shared agents they watch, and, for an org admin, every shared agent's run.
   */
  visibleTo(viewer: Viewer): ReadonlyArray<RunView> {
    const shared = this.#agents.agents().filter((agent) => agent.owner === undefined);
    const member = viewer.member;

    const watched =
      member === undefined
        ? []
        : shared
            .filter((agent) => (this.#watchers(agent.id) ?? []).includes(member))
            .map((agent) => agent.id);

    const candidates = [
      ...(member === undefined ? [] : this.#runs.startedBy({ kind: "member", id: member })),
      ...this.#runs.ofAgents(
        viewer.admin ? shared.map((agent) => agent.id) : watched,
        !viewer.admin,
      ),
    ];

    const seen = new Set<string>();
    const views: Array<RunView> = [];

    for (const run of candidates) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      const access = this.accessOf(viewer, run);

      if (access !== undefined) views.push(this.#viewAs(run, access));
    }

    return views.toSorted((a, b) =>
      a.updated_at === b.updated_at
        ? b.id.localeCompare(a.id)
        : b.updated_at.localeCompare(a.updated_at),
    );
  }

  /**
   * The members who watch the run `runId` and answer its approvals and handoffs (#232, ADR 0040): the member at the
   * head of its chain (its starter, or the one who started the run that started it); or, when no one started that run
   * (a shared agent's trigger), the watchers of that run's agent. None for an unknown run, or a chain whose head is
   * gone.
   */
  watchersOf(runId: string): ReadonlyArray<string> {
    const run = this.#runs.run(runId);

    if (run === undefined) return [];
    const head = this.#starterMember(run);

    if (head === "gone") return [];

    if (head === "none") return this.#watchers((this.#chain(run).at(-1) ?? run).agent) ?? [];

    return this.#core.member(head.id) === undefined ? [] : [head.id];
  }

  /**
   * The run `runId` when `viewer` may cancel it (#232, ADR 0040): its starter and its watchers, with the run as they
   * see it; an org admin, any run of the org, a private agent's too, which they get no view of (`null`: they learn only
   * whether a turn was cancelled). Anyone else's answers like an unknown run.
   */
  cancellableBy(viewer: Viewer, runId: string): RunsResult<RunView | null> {
    const run = this.#runs.run(runId);

    if (run === undefined) return RUN_NOT_FOUND;
    const access = this.accessOf(viewer, run);

    if (access !== undefined) return ok(this.#viewAs(run, access));

    return viewer.admin ? ok(null) : RUN_NOT_FOUND;
  }

  /** The run `runId` if `viewer` started it; any other answers like an unknown one. */
  ofStarter(viewer: Viewer, runId: string): RunsResult<RunView> {
    const run = this.#runs.run(runId);

    return run !== undefined && isStarter(run, viewer.member) ? ok(this.view(run)) : RUN_NOT_FOUND;
  }

  /** The runs `viewer` started, the latest activity first. */
  startedBy(viewer: Viewer): ReadonlyArray<RunView> {
    const member = viewer.member;

    return member === undefined
      ? []
      : this.#runs.startedBy({ kind: "member", id: member }).map((run) => this.view(run));
  }

  /** Whom a run of `agent` acts as now, or why it cannot go on. */
  #actsAs(agent: StoredAgent): RunsResult<RunActsAs> {
    if (agent.owner === undefined) return ok({ kind: "agent" });
    const member = this.#core.member(agent.owner);

    if (member === undefined) return refuse("run_ended", "the agent's member left the org");

    return ok({ kind: "member", memberId: member.id, email: member.email });
  }

  /**
   * A new turn of the run `runId` starts: reads its agent's definition as it stands now, records it as the turn's
   * reach and marks the run running; or answers why the run cannot go on (`run_ended`): it ended, its agent was removed
   * or disabled, the agent's member left, the org stopped serving private agents, or its starter no longer reaches the
   * agent (a revoked grant, a member who left).
   */
  beginTurn(runId: string): RunsResult<RunContext> {
    const run = this.#runs.run(runId);

    if (run === undefined) return RUN_NOT_FOUND;

    if (run.state === "ended") return refuse("run_ended", "the run ended");
    const agent = this.#agents.agent(run.agent);

    if (agent === undefined) return refuse("run_ended", "the run's agent was removed");

    if (!agent.enabled) return refuse("run_ended", "the run's agent is disabled");

    const actsAs = this.#actsAs(agent);

    if (!actsAs.ok) return actsAs;

    if (agent.owner !== undefined && !this.#core.privateAgents())
      return refuse("run_ended", "the org does not serve private agents");

    if (run.starter?.kind === "run") {
      // A child run (#229): the run that started it must still be there, and still able to run its agent.
      const parent = this.#runs.run(run.starter.id);

      if (parent === undefined || parent.state === "ended" || !this.#mayRun(parent, agent))
        return refuse("run_ended", "the run that started it may no longer run the agent");
    }

    // A run no one started (a shared agent's trigger), or a child run of one, has no starter to check.
    const head = this.#starterMember(run);
    const starter = typeof head === "object" ? this.#core.member(head.id) : undefined;

    if (
      head === "gone" ||
      (head !== "none" && starter === undefined) ||
      (run.starter?.kind === "member" && !this.#reaches(agent, run.starter.id))
    )
      return refuse("run_ended", "the run's starter may no longer use the agent");

    const definition: TurnDefinition = {
      actsAs: actsAs.value,
      model: agent.model,
      ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
      instructions: agent.instructions,
      toolScope: agent.toolScope,
      ...(agent.sandbox === undefined ? {} : { sandbox: agent.sandbox }),
    };

    this.#runs.beginTurn(run.id, definition, this.#now());

    return ok(contextOf(run, starter, definition));
  }

  /**
   * The run `runId` at its latest turn ({@link RunContext}): its principal for the run gateway, as its turn read the
   * definition. Refused (`not_found`, `run_ended`) for an unknown or ended run, one whose turn never started, one that
   * acts as a member no longer in the org, and one whose starter left it (whose standing could not be checked).
   */
  turnContext(runId: string): RunsResult<RunContext> {
    const run = this.#runs.run(runId);

    if (run === undefined) return RUN_NOT_FOUND;

    if (run.state === "ended") return refuse("run_ended", "the run ended");

    if (run.definition === undefined) return refuse("run_ended", "the run has no turn");
    const { actsAs } = run.definition;

    if (actsAs.kind === "member" && this.#core.member(actsAs.memberId) === undefined)
      return refuse("run_ended", "the agent's member left the org");
    const head = this.#starterMember(run);

    if (head === "none") return ok(contextOf(run, undefined, run.definition));
    const starter = head === "gone" ? undefined : this.#core.member(head.id);

    if (starter === undefined) return refuse("run_ended", "the run's starter left the org");

    return ok(contextOf(run, starter, run.definition));
  }

  /**
   * Records the state the run's object reports, as its last activity; an ended run stays ended. A run that ends ends
   * the child runs it started, and theirs (#229): it answers their ids, whose objects the run's object then stops.
   */
  stateChanged(runId: string, state: RunState): ReadonlyArray<string> {
    const run = this.#runs.run(runId);

    if (run === undefined || run.state === "ended") return [];

    if (state === "ended") return this.#end(runId).filter((id) => id !== runId);
    this.#runs.setState(runId, state, this.#now());

    return [];
  }

  /** Ends the run `runId` that `viewer` started: its object could not be reached to start it. */
  abandon(viewer: Viewer, runId: string): void {
    const run = this.#runs.run(runId);

    if (run !== undefined && isStarter(run, viewer.member)) this.#end(runId);
  }

  /**
   * Up to `limit` runs' ids, the deleted ones waiting for their objects first, and how many there are of both: the org's
   * deletion deletes their objects first.
   */
  page(limit: number): RunsPage {
    const queued = this.#runs.queued(limit);

    return {
      ids: [...queued, ...this.#runs.ids(limit - queued.length)],
      total: this.#runs.count() + this.#runs.queuedCount(),
    };
  }

  /** Forgets the runs `ids`, whose objects were deleted. */
  forget(ids: ReadonlyArray<string>): void {
    this.#runs.delete(ids);
  }

  /**
   * Deletes `runs` from the index at once (#228, ADR 0027), with the child runs each started and theirs: they answer
   * like unknown runs from now on, and their objects wait for a sweep ({@link deleted}). Answers how many it deleted.
   */
  discard(runs: DiscardedRuns): number {
    return this.#runs.discard(runs, this.#now());
  }

  /**
   * The metadata of `agentId`'s runs for the org export (#228, ADR 0027): who started each (a member by email, a run by
   * id), its trigger, its state and its times; never its transcript, which stays in its object.
   */
  exported(agentId: string): ReadonlyArray<RunExport> {
    return this.#runs.ofAgent(agentId).map(({ run, starterKind, starterId }) => {
      const email = starterKind === "member" ? this.#core.member(starterId)?.email : undefined;

      const starter =
        email !== undefined
          ? { member: email }
          : starterKind === "run"
            ? { run: starterId }
            : undefined;

      return {
        id: run.id,
        trigger: run.trigger,
        ...(starter === undefined ? {} : { starter }),
        state: run.state,
        created_at: iso(run.createdAt),
        last_activity_at: iso(run.updatedAt),
      };
    });
  }

  /** Up to `limit` deleted runs whose objects are still to delete, for the sweeps that delete them. */
  deleted(limit: number): ReadonlyArray<string> {
    return this.#runs.queued(limit);
  }

  /**
   * `run` as a viewer with `access` sees it: an org admin's view of a child run that a private agent's run started
   * names that run's kind only, as the run is its member's alone.
   */
  #viewAs(run: StoredRun, access: RunAccess): RunView {
    const view = { ...this.view(run), access };
    const { starter } = run;

    if (access !== "admin" || starter?.kind !== "run") return view;
    const starting = this.#runs.run(starter.id);
    const agent = starting === undefined ? undefined : this.#agents.agent(starting.agent);

    return agent !== undefined && agent.owner === undefined
      ? view
      : { ...view, starter: { kind: "run" } };
  }

  view(run: StoredRun): RunView {
    const name = this.#agents.agent(run.agent)?.name;

    return {
      id: run.id,
      agent: { id: run.agent, ...(name === undefined ? {} : { name }) },
      trigger: run.trigger,
      ...(run.triggerId === undefined ? {} : { trigger_id: run.triggerId }),
      ...(run.starter === undefined ? {} : { starter: run.starter }),
      state: run.state,
      created_at: iso(run.createdAt),
      updated_at: iso(run.updatedAt),
    };
  }
}

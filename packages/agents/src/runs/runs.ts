/**
 * The Agents part's side of agent runs (#227, ADR 0040): starting a run (its row in the org's index, `store.ts`), who
 * sees it (its starter only, for now; watchers and org admins come with #232), and what a run is at each turn.
 *
 * **Turns read the definition once.** A turn reads the agent's definition when it starts ({@link Runs.beginTurn}, the
 * run's Durable Object calls it), and every call of that turn reaches what that reading allowed
 * ({@link Runs.turnContext}, the API Worker's run gateway reads it on every request): an edit, a disable, a removal or
 * a revoked grant applies from the next turn, which ends the run when the agent or its starter can no longer go on. A
 * private agent's member who left the org stops the running turn at once: the run acted as them. The part's methods
 * delegate here; plain data in and out.
 */
import type { RunActsAs, RunStarter, Viewer } from "@commissary/auth";
import type { RunState, RunView, TriggerKind } from "@commissary/contract/agent-runs";
import type { ThinkingLevel } from "@commissary/contract/agents";
import type { ToolScope } from "@commissary/contract/api-keys";
import type { OrgCore } from "@commissary/state";
import type { AgentStore, StoredAgent } from "../agents/store.ts";
import { iso, ok, type Refusable, refuse } from "../result.ts";
import { freshRunId, type RunStore, type StoredRun, type TurnDefinition } from "./store.ts";

/**
 * Why a run call was refused: by the part, or by the run's object (`unavailable`: the org's ControlPlane could not
 * be reached).
 */
export type RunsErrorCode =
  | "invalid"
  | "forbidden"
  | "not_found"
  | "agent_disabled"
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
  readonly starter: RunStarter;
  /** The starter's email, whose standing Commissary Cloud checks on every call of the run. */
  readonly starterEmail: string;
  readonly actsAs: RunActsAs;
  readonly model: string;
  readonly thinking?: ThinkingLevel | undefined;
  readonly instructions: string;
  readonly toolScope: ToolScope;
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
  member !== undefined && run.starter.id === member;

const contextOf = (
  run: StoredRun,
  starterEmail: string,
  definition: TurnDefinition,
): RunContext => ({
  runId: run.id,
  agentId: run.agent,
  starter: run.starter,
  starterEmail,
  ...definition,
});

export class Runs {
  readonly #runs: RunStore;
  readonly #agents: AgentStore;
  readonly #core: OrgCore;
  /**
   * Whether `member` may use `agent`, enabled or not, as the part decides it (their reach in the Agents area: their
   * private agent while the org serves them, or a shared agent a grant gives them).
   */
  readonly #reaches: (agent: StoredAgent, member: string) => boolean;

  constructor(
    runs: RunStore,
    agents: AgentStore,
    core: OrgCore,
    reaches: (agent: StoredAgent, member: string) => boolean,
  ) {
    this.#runs = runs;
    this.#agents = agents;
    this.#core = core;
    this.#reaches = reaches;
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

    const now = Date.now();
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

    const starter = this.#core.member(run.starter.id);

    if (starter === undefined || !this.#reaches(agent, run.starter.id))
      return refuse("run_ended", "the run's starter may no longer use the agent");

    const definition: TurnDefinition = {
      actsAs: actsAs.value,
      model: agent.model,
      ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
      instructions: agent.instructions,
      toolScope: agent.toolScope,
    };

    this.#runs.beginTurn(run.id, definition, Date.now());

    return ok(contextOf(run, starter.email, definition));
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
    const starter = this.#core.member(run.starter.id);

    if (starter === undefined) return refuse("run_ended", "the run's starter left the org");

    return ok(contextOf(run, starter.email, run.definition));
  }

  /** Records the state the run's object reports, as its last activity; an ended run stays ended. */
  stateChanged(runId: string, state: RunState): void {
    const run = this.#runs.run(runId);

    if (run !== undefined && run.state !== "ended") this.#runs.setState(runId, state, Date.now());
  }

  /** Ends the run `runId` that `viewer` started: its object could not be reached to start it. */
  abandon(viewer: Viewer, runId: string): void {
    const run = this.#runs.run(runId);

    if (run !== undefined && isStarter(run, viewer.member))
      this.#runs.setState(runId, "ended", Date.now());
  }

  /** Up to `limit` runs' ids, and how many the index holds: the org's deletion deletes their objects first. */
  page(limit: number): RunsPage {
    return { ids: this.#runs.ids(limit), total: this.#runs.count() };
  }

  /** Forgets the runs `ids`, whose objects the org's deletion deleted. */
  forget(ids: ReadonlyArray<string>): void {
    this.#runs.delete(ids);
  }

  view(run: StoredRun): RunView {
    const name = this.#agents.agent(run.agent)?.name;

    return {
      id: run.id,
      agent: { id: run.agent, ...(name === undefined ? {} : { name }) },
      trigger: run.trigger,
      starter: run.starter,
      state: run.state,
      created_at: iso(run.createdAt),
      updated_at: iso(run.updatedAt),
    };
  }
}

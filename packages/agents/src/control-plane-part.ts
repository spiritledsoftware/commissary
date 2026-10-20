import { RpcTarget } from "cloudflare:workers";
import { Clock } from "effect";
import { accessTo, isFullAccess, roleAtLeast, type Scope, type Viewer } from "@commissary/auth";
import type {
  AgentGrantBody,
  AgentGrants,
  AgentsList,
  AgentView,
  AgentWatcher,
  CreateAgent,
  CreatedAgentView,
  LimitedAgentView,
  RemovedAgent,
  UpdateAgent,
  UsableAgents,
} from "@commissary/contract/agents";
import type { ToolScope } from "@commissary/contract/api-keys";
import type { GrantSubject } from "@commissary/contract/grants";
import { type ControlPlanePart, normalizedToolScope, type OrgCore } from "@commissary/state";
import type { SpendAgent, SpendCredential } from "@commissary/state/spend";
import type { RunState, RunsList, RunView, TriggerKind } from "@commissary/contract/agent-runs";
import type {
  ConfiguredTriggerKind,
  CreatedTrigger,
  CreateTrigger,
  RemovedTrigger,
  TriggersList,
  TriggerView,
  UpdateTrigger,
} from "@commissary/contract/agent-triggers";
import { definitionRefusal } from "./agents/definition.ts";
import {
  AGENTS_TABLES,
  AgentStore,
  freshAgentGrantId,
  freshAgentId,
  type StoredAgent,
} from "./agents/store.ts";
import { iso, ok, type Refusable, refuse as refuseWith } from "./result.ts";
import {
  type RunContext,
  Runs,
  type RunsPage,
  type RunsResult,
  type StartedRunRecord,
} from "./runs/runs.ts";
import { RunStore } from "./runs/store.ts";
import { TriggerStore } from "./triggers/store.ts";
import {
  type ScheduleArming,
  type ScheduleFired,
  type TriggerExport,
  type TriggerRequest,
  Triggers,
  type TriggersRequest,
  type TriggersResult,
  type WebhookCheck,
  type WebhookRun,
} from "./triggers/triggers.ts";
import type { WebhookProof } from "./triggers/webhook.ts";

/** Why a call of the part was refused; the routes answer each with its status. */
export type AgentsErrorCode =
  | "invalid"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "name_taken"
  | "private_agents_unavailable"
  | "unknown_model"
  | "unknown_toolkit"
  | "unknown_agent";

export type AgentsResult<A> = Refusable<AgentsErrorCode, A>;

const refuse = (error: AgentsErrorCode, message: string) => refuseWith(error, message);

const NOT_FOUND = refuse("not_found", "agent not found");

/**
 * What the management route found of what a definition names outside the Agents area (its `AgentReferences`, filled
 * from Models and Tools): the part answers it only after deciding that the caller may write, so a refused caller learns
 * nothing of the org's models or toolkits. A field is absent when the write does not change what it checks.
 */
export interface ReferenceCheck {
  /**
   * Whether the org serves the definition's model as named: on its shared credentials, or to a private agent's member.
   */
  readonly modelServed?: boolean | undefined;
  /** The toolkits its tool scope names that the org (or a private agent's member) does not have. */
  readonly unknownToolkits?: ReadonlyArray<string> | undefined;
}

/** What the routes hand over for an agent grant: `value` `null` deletes it; no `id` creates one (`revision` 0). */
export interface AgentGrantChange {
  readonly id?: string | undefined;
  readonly revision: number;
  readonly value: AgentGrantBody | null;
}

/** A watcher or grant subject in the org export: by email or team name, never by id. */
export type ExportedSubject =
  | { readonly everyone: true }
  | { readonly member: string }
  | { readonly team: string };

/**
 * An agent in the org export (`exportSection`): its definition, its triggers, and a shared agent's watchers and grants.
 */
export interface AgentExport {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly thinking?: string;
  readonly tool_scope: ToolScope;
  readonly enabled: boolean;
  readonly private: boolean;
  readonly triggers: ReadonlyArray<TriggerExport>;
  readonly watchers?: ReadonlyArray<ExportedSubject>;
  readonly grants?: ReadonlyArray<ExportedSubject>;
  readonly created_at: string;
}

/** The fields a definition is made of, as the contract names them. */
interface DefinitionFields {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly thinking?: CreateAgent["thinking"];
  readonly tool_scope: ToolScope;
}

/** Whether `subject` names the member `member` (of the teams `teams`). */
const names = (
  subject: GrantSubject,
  member: string | undefined,
  teams: ReadonlyArray<string>,
): boolean => {
  switch (subject.kind) {
    case "everyone":
      return true;
    case "member":
      return member !== undefined && subject.id === member;
    case "team":
      return teams.includes(subject.id);
  }
};

/** Whether `input` creates a private agent: a plain member's always does; an org admin's when it says so. */
export const createsPrivate = (viewer: Viewer, input: Pick<CreateAgent, "private">): boolean =>
  input.private === true || !viewer.admin;

const trimmedSubject = (subject: GrantSubject): GrantSubject =>
  subject.kind === "everyone" ? subject : { kind: subject.kind, id: subject.id.trim() };

/**
 * The Agents part of an org's ControlPlane (#226, ADR 0040): the single writer for the org's hosted agents (their
 * definitions, a shared agent's watchers) and the grants on shared agents. An `RpcTarget` the composed `ControlPlane`
 * constructs once per object (`new AgentsPart(ctx, core)`); callers reach it as `stub.agents().x(…)`. It keeps the org's
 * index of agent runs (#227, `runs/`), which act as a private agent's member or as a shared agent itself.
 *
 * Who may do what follows `@commissary/auth`'s ownership rules: a private agent is its member's, and an org admin only
 * sees that it exists (its name and member) and may disable or remove it; a shared agent is for org admins, and members
 * use it through grants. The org's `privateAgents` setting is read on every use: while it is off a private agent cannot
 * be created and none is served, but none is deleted. It keeps the triggers configured on agents (#231,
 * `triggers/`): schedules and webhooks, which start runs a private agent's member or no one starts. Methods exchange
 * plain data only.
 */
export class AgentsPart extends RpcTarget implements ControlPlanePart {
  readonly #ctx: DurableObjectState;
  readonly #core: OrgCore;
  readonly #store: AgentStore;
  readonly #runs: Runs;
  readonly #triggers: Triggers;
  /** What the part reads the time from: the live clock, or a test's (`useClock`). */
  #clock: Clock.Clock = Clock.Clock.defaultValue();

  constructor(ctx: DurableObjectState, core: OrgCore) {
    super();
    this.#ctx = ctx;
    this.#core = core;
    this.#store = new AgentStore(ctx.storage.sql);
    const now = () => this.#clock.currentTimeMillisUnsafe();

    this.#runs = new Runs(
      new RunStore(ctx.storage.sql),
      this.#store,
      core,
      (agent, member) => this.#reaches(agent, member),
      now,
    );
    this.#triggers = new Triggers(
      new TriggerStore(ctx.storage.sql, core.secrets),
      this.#store,
      this.#runs,
      core,
      now,
    );
  }

  /**
   * Makes the part read the time from `clock` (a test's `TestClock`) instead of the live clock, for its runs and its
   * triggers (schedules' ticks, signatures' timestamps). In the object's isolate only (`runInDurableObject`): a clock is not data an RPC can carry.
   */
  useClock(clock: Clock.Clock): void {
    this.#clock = clock;
  }

  // --- the org-wide base's calls (`ControlPlanePart`, `@commissary/state`) ------------------------------------

  /** Webhook triggers' secrets (#231) were sealed from the start: nothing was stored in plain text. */
  sealPlaintext(): number {
    return 0;
  }

  /** Nothing is due here: a schedule's ticks are its own object's alarms (`triggers/schedule-object.ts`). */
  async alarm(): Promise<number | null> {
    return null;
  }

  /** Deletes the part's tables: the org was deleted (`wipeOrg`). */
  wipe(): void {
    for (const table of AGENTS_TABLES) this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  /**
   * Zero data retention (ADR 0027): a member's private agents go with them at once, and so do the agent grants that
   * named them. They leave every shared agent's watchers; a shared agent none of whose watchers is left is watched by
   * the org admins.
   */
  async memberLeft(member: string): Promise<void> {
    this.#core.transaction(() => {
      for (const agent of this.#store.agents())
        if (agent.owner === member) {
          this.#store.delete(agent.id);
          this.#triggers.forgetAgent(agent.id);
        } else
          this.#dropWatchers(
            agent,
            (watcher) => watcher.kind === "member" && watcher.id === member,
          );

      this.#store.forgetSubject({ kind: "member", id: member });
    });
  }

  /** The agent grants that named the team go with it, and it leaves every shared agent's watchers. */
  teamDeleted(team: string): void {
    this.#core.transaction(() => {
      for (const agent of this.#store.agents())
        this.#dropWatchers(agent, (watcher) => watcher.kind === "team" && watcher.id === team);

      this.#store.forgetSubject({ kind: "team", id: team });
    });
  }

  /** Read on every use (`core.teamIdsOf`, `core.team`): nothing to forget. */
  teamMembersChanged(): void {}

  apiKeysDeleted(): void {}

  privateCredentialsChanged(): void {}

  /** Agents holds no credentials. */
  spendCredentials(): ReadonlyArray<SpendCredential> {
    return [];
  }

  /** The shared agents, which a Spend limit of kind `agent` names (#226; their runs count toward it, #228). */
  spendAgents(): ReadonlyArray<SpendAgent> {
    return this.#store
      .agents()
      .filter((agent) => agent.owner === undefined)
      .map((agent) => ({ id: agent.id, label: agent.name }));
  }

  // --- agents ------------------------------------------------------------------------------------------------------

  /**
   * The agents `viewer` manages: their own private agents and, for an org admin, the shared agents and the other
   * members' private agents as existence only (`others`). A plain member reaches shared agents through
   * {@link usableAgents}.
   */
  listAgents(viewer: Scope): AgentsList {
    const agents: Array<AgentView> = [];
    const others: Array<LimitedAgentView> = [];

    for (const agent of this.#store.agents()) {
      const access = accessTo(agent.owner, viewer);

      if (access === "full") agents.push(this.#view(agent));
      else if (access === "limited") others.push(this.#limitedView(agent));
    }

    return isFullAccess(viewer) || viewer.admin ? { agents, others } : { agents };
  }

  getAgent(viewer: Scope, id: string): AgentsResult<AgentView | LimitedAgentView> {
    const agent = this.#store.agent(id);

    if (agent === undefined) return NOT_FOUND;

    switch (accessTo(agent.owner, viewer)) {
      case "full":
        return ok(this.#view(agent));
      case "limited":
        return ok(this.#limitedView(agent));
      case "none":
        return NOT_FOUND;
    }
  }

  /**
   * Creates a private agent of the caller (a plain member's agent is always private) or, for an org admin, a shared
   * one, which names who may use it (`subject`, written as its grant in the same transaction: there is no default
   * grant) and its watchers (the caller by default).
   */
  createAgent(
    viewer: Viewer,
    input: CreateAgent,
    check: ReferenceCheck,
    by: string,
  ): AgentsResult<CreatedAgentView> {
    const isPrivate = createsPrivate(viewer, input);
    const owner = isPrivate ? viewer.member : undefined;

    if (isPrivate && owner === undefined)
      return refuse("forbidden", "only a member of the org can create a private agent");

    if (isPrivate && !this.#core.privateAgents())
      return refuse(
        "private_agents_unavailable",
        "the org does not let members create private agents",
      );

    if (isPrivate && (input.subject !== undefined || input.watchers !== undefined))
      return refuse(
        "invalid",
        "a private agent is its member's alone: it names no subject and no watchers",
      );

    if (!isPrivate && input.subject === undefined)
      return refuse("invalid", "a shared agent names who may use it (subject)");

    const definition = this.#checkedDefinition(input, owner, check, {
      name: true,
      toolScope: true,
    });

    if (!definition.ok) return definition;

    const subject = input.subject === undefined ? undefined : trimmedSubject(input.subject);
    const subjectRefusal = subject === undefined ? undefined : this.#subjectRefusal(subject);

    if (subjectRefusal !== undefined) return refuse("invalid", subjectRefusal);

    const watchers = this.#checkedWatchers(
      isPrivate
        ? []
        : (input.watchers ??
            (viewer.member === undefined ? [] : [{ kind: "member", id: viewer.member }])),
    );

    if (!watchers.ok) return watchers;

    const now = Date.now();
    const id = freshAgentId();

    const agent: StoredAgent = {
      id,
      owner,
      ...definition.value,
      enabled: true,
      watchers: watchers.value,
      revision: 1,
      createdAt: now,
      createdBy: by,
      updatedAt: now,
      updatedBy: by,
    };

    const grant =
      subject === undefined
        ? undefined
        : {
            id: freshAgentGrantId(),
            subject,
            agent: id,
            revision: 1,
            updatedAt: now,
            updatedBy: by,
          };

    this.#core.transaction(() => {
      this.#store.put(agent);

      if (grant !== undefined) this.#store.putGrant(grant);
    });

    return ok({
      ...this.#view(agent),
      ...(grant === undefined ? {} : { grant: { id: grant.id } }),
    });
  }

  /**
   * Changes what `input` names of an agent at `revision`. An edit replaces those fields and keeps no history. An org
   * admin may only enable or disable another member's private agent.
   */
  updateAgent(
    viewer: Viewer,
    id: string,
    revision: number,
    input: UpdateAgent,
    check: ReferenceCheck,
    by: string,
  ): AgentsResult<AgentView | LimitedAgentView> {
    const agent = this.#store.agent(id);
    const access = agent === undefined ? "none" : accessTo(agent.owner, viewer);

    if (agent === undefined || access === "none") return NOT_FOUND;

    const fields = Object.keys(input);

    if (fields.length === 0) return refuse("invalid", "an edit names at least one field");

    if (access === "limited" && fields.some((field) => field !== "enabled"))
      return refuse(
        "forbidden",
        "an org admin may only enable or disable another member's private agent",
      );

    if (agent.revision !== revision)
      return refuse("conflict", "the agent changed since it was read: read it again");

    if (agent.owner !== undefined && input.watchers !== undefined)
      return refuse("invalid", "a private agent has no watchers");

    const definition = this.#checkedDefinition(
      {
        name: input.name ?? agent.name,
        description: input.description ?? agent.description,
        instructions: input.instructions ?? agent.instructions,
        model: input.model ?? agent.model,
        thinking: input.thinking === undefined ? agent.thinking : (input.thinking ?? undefined),
        tool_scope: input.tool_scope ?? agent.toolScope,
      },
      agent.owner,
      check,
      { name: input.name !== undefined, toolScope: input.tool_scope !== undefined, self: id },
    );

    if (!definition.ok) return definition;

    const watchers =
      input.watchers === undefined ? ok(agent.watchers) : this.#checkedWatchers(input.watchers);

    if (!watchers.ok) return watchers;

    const updated: StoredAgent = {
      ...agent,
      ...definition.value,
      enabled: input.enabled ?? agent.enabled,
      watchers: watchers.value,
      revision: agent.revision + 1,
      updatedAt: Date.now(),
      updatedBy: by,
    };

    this.#store.put(updated);

    return ok(access === "full" ? this.#view(updated) : this.#limitedView(updated));
  }

  /** Deletes an agent at once (ADR 0027), with its grants, its triggers and, for a shared agent, its Spend limits. */
  removeAgent(viewer: Viewer, id: string, revision: number): AgentsResult<RemovedAgent> {
    const agent = this.#store.agent(id);

    if (agent === undefined || accessTo(agent.owner, viewer) === "none") return NOT_FOUND;

    if (agent.revision !== revision)
      return refuse("conflict", "the agent changed since it was read: read it again");

    this.#core.transaction(() => {
      this.#store.delete(id);
      this.#triggers.forgetAgent(id);

      if (agent.owner === undefined) this.#core.spend.forget("agent", id);
    });

    return ok({ id, removed: true });
  }

  /**
   * The agents `viewer` may use, their reach in the Agents area (GLOSSARY "Reach"): their private agents while the org
   * allows them, and the shared agents a grant gives them (everyone, them or one of their teams); enabled ones only.
   */
  usableAgents(viewer: Viewer): UsableAgents {
    return {
      agents: this.#usable(viewer.member).map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        private: agent.owner !== undefined,
      })),
    };
  }

  /**
   * The member ids that watch a shared agent's runs no one started (GLOSSARY "Watcher"; they act in #232): its watching
   * members and the members of its watching teams, or the org admins when none is left. `undefined` for a private agent
   * or an unknown id.
   */
  agentWatchers(id: string): ReadonlyArray<string> | undefined {
    const agent = this.#store.agent(id);

    if (agent === undefined || agent.owner !== undefined) return undefined;
    const watching = this.#watchingMembers(agent);

    if (watching.length > 0) return watching;
    this.#core.seedPlatformAdmins();

    return this.#core
      .members()
      .filter((member) => roleAtLeast(member.role, "admin"))
      .map((member) => member.id);
  }

  // --- agent grants --------------------------------------------------------------------------------------------------

  /** Every agent grant of the org, by agent and subject (the routes are for org admins). */
  listGrants(): AgentGrants {
    return {
      grants: this.#store.grants().map((grant) => ({
        id: grant.id,
        subject: grant.subject,
        agent: grant.agent,
        revision: grant.revision,
        updated_at: grant.updatedAt,
        updated_by: grant.updatedBy,
      })),
    };
  }

  /** Writes one agent grant: one per subject and shared agent, each with its revision (ADR 0025). */
  writeGrant(
    change: AgentGrantChange,
    by: string,
  ): AgentsResult<{ readonly id: string; readonly revision: number }> {
    const value =
      change.value === null
        ? null
        : { subject: trimmedSubject(change.value.subject), agent: change.value.agent.trim() };

    if (value !== null) {
      const refusal = this.#subjectRefusal(value.subject);

      if (refusal !== undefined) return refuse("invalid", refusal);

      if (!this.#isShared(value.agent)) return refuse("invalid", "no shared agent has this id");
    }

    const now = Date.now();

    if (change.id === undefined) {
      if (value === null) return refuse("invalid", "a new grant names its subject and agent");

      if (change.revision !== 0) return refuse("conflict", "a new grant is at revision 0");

      if (this.#store.grantOfSubject(value.subject, value.agent) !== undefined)
        return refuse("conflict", "the subject holds a grant of this agent already: edit that one");

      const id = freshAgentGrantId();

      this.#store.putGrant({ id, ...value, revision: 1, updatedAt: now, updatedBy: by });

      return ok({ id, revision: 1 });
    }

    const current = this.#store.grant(change.id);

    if (current === undefined) return refuse("not_found", "grant not found");

    if (current.revision !== change.revision)
      return refuse("conflict", "the grant changed since it was read: read it again");

    if (value === null) {
      this.#store.deleteGrant(current.id);

      return ok({ id: current.id, revision: 0 });
    }

    const other = this.#store.grantOfSubject(value.subject, value.agent);

    if (other !== undefined && other.id !== current.id)
      return refuse("conflict", "the subject holds a grant of this agent already: edit that one");

    const revision = current.revision + 1;

    this.#store.putGrant({ id: current.id, ...value, revision, updatedAt: now, updatedBy: by });

    return ok({ id: current.id, revision });
  }

  // --- agent runs (#227) --------------------------------------------------------------------------------------------

  /**
   * Starts a run of `agentId` that the member `viewer` starts (its row in the org's index; its Durable Object is the
   * caller's to start next), or finds the run their `idempotencyKey` started of it before (`created: false`).
   */
  startRun(
    viewer: Viewer,
    agentId: string,
    trigger: TriggerKind,
    idempotencyKey: string | undefined,
  ): RunsResult<StartedRunRecord> {
    return this.#runs.start(viewer, agentId, trigger, idempotencyKey);
  }

  /** The run `runId` as its starter sees it; anyone else's answers like an unknown run. */
  getRun(viewer: Viewer, runId: string): RunsResult<RunView> {
    return this.#runs.ofStarter(viewer, runId);
  }

  /** The runs `viewer` started, the latest activity first. */
  listRuns(viewer: Viewer): RunsList {
    return { runs: this.#runs.startedBy(viewer) };
  }

  /**
   * A new turn of the run `runId` starts (its object asks): its agent's definition as it stands now, recorded as the
   * turn's reach; or why the run cannot go on (`run_ended`). See `runs/runs.ts`.
   */
  beginTurn(runId: string): RunsResult<RunContext> {
    return this.#runs.beginTurn(runId);
  }

  /**
   * The run `runId` at its latest turn, as that turn read its definition: the run's principal, which the API Worker's
   * run gateway reads on every call; or why the run cannot call anything.
   */
  turnContext(runId: string): RunsResult<RunContext> {
    return this.#runs.turnContext(runId);
  }

  /** Ends the run `runId` `viewer` started, whose object could not be reached to start it. */
  abandonRun(viewer: Viewer, runId: string): void {
    this.#runs.abandon(viewer, runId);
  }

  /** Up to `limit` of the org's runs, for its deletion (`org-deletion.ts`), which deletes their objects first. */
  runsPage(limit: number): RunsPage {
    return this.#runs.page(limit);
  }

  /** Forgets the runs `ids`, whose objects the org's deletion deleted. */
  forgetRuns(ids: ReadonlyArray<string>): void {
    this.#runs.forget(ids);
  }

  /** The run's object reports its state (`running`, `idle`, `ended`), kept in the index as its last activity. */
  runStateChanged(runId: string, state: RunState): void {
    this.#runs.stateChanged(runId, state);
  }

  /** Ends the run `runId` a trigger started, whose object could not be reached to start it. */
  abandonTriggeredRun(runId: string): void {
    this.#runs.abandonTriggered(runId);
  }

  // --- triggers (#231) -----------------------------------------------------------------------------------------------
  // A webhook's URL starts at `origin`, where the deployment's client API answers (the route knows it).

  /** The triggers of the agent the request names, which its viewer manages, oldest first. */
  listTriggers(request: TriggersRequest): TriggersResult<TriggersList> {
    return this.#triggers.list(request);
  }

  /** Adds a trigger to the agent the request names; a webhook's secret is in the answer, and only there. */
  createTrigger(request: TriggersRequest, input: CreateTrigger): TriggersResult<CreatedTrigger> {
    return this.#triggers.create(request, input);
  }

  /** Changes what `input` names of a trigger at its revision (enabling and disabling it among them). */
  updateTrigger(request: TriggerRequest, input: UpdateTrigger): TriggersResult<TriggerView> {
    return this.#triggers.update(request, input);
  }

  /** Removes a trigger; answers its kind too (a schedule's object is the route's to delete). */
  removeTrigger(
    request: TriggerRequest,
  ): TriggersResult<RemovedTrigger & { readonly kind: ConfiguredTriggerKind }> {
    return this.#triggers.remove(request);
  }

  /** A webhook's new secret, shown once. */
  rotateTriggerSecret(request: TriggerRequest): TriggersResult<CreatedTrigger> {
    return this.#triggers.rotateSecret(request);
  }

  /** A schedule's next tick from now, which its object's alarm is set to (`null` while it is disabled). */
  armSchedule(triggerId: string): ScheduleArming {
    return this.#triggers.arm(triggerId);
  }

  /** Fires a schedule's tick (its object's alarm): its run, once per tick, and the next tick. */
  fireSchedule(triggerId: string, tick: number): ScheduleFired {
    return this.#triggers.fire(triggerId, tick);
  }

  /** Whether a delivery of `body` to the webhook `triggerId` proves it holds its secret, and its input template. */
  verifyWebhook(triggerId: string, proof: WebhookProof, body: Uint8Array): WebhookCheck {
    return this.#triggers.verifyWebhook(triggerId, proof, body);
  }

  /** Starts the run of a proven delivery to the webhook `triggerId`, once per `idempotencyKey`. */
  startWebhookRun(triggerId: string, idempotencyKey: string): RunsResult<WebhookRun> {
    return this.#triggers.startWebhookRun(triggerId, idempotencyKey);
  }

  /**
   * Up to `limit` schedules whose object may exist, removed ones' included, for the org's deletion
   * (`org-deletion.ts`), which deletes every one before the tables go.
   */
  scheduleObjectsPage(limit: number): ReadonlyArray<string> {
    return this.#triggers.scheduleObjects(limit);
  }

  /**
   * Up to `limit` schedules that are gone (removed, or with their agent or its member) but whose object may still
   * exist, for the sweep that deletes them (`sweepRetiredSchedules`).
   */
  retiredSchedules(limit: number): ReadonlyArray<string> {
    return this.#triggers.retiredSchedules(limit);
  }

  /** Forgets the schedules `ids`, whose objects were deleted. */
  forgetScheduleObjects(ids: ReadonlyArray<string>): void {
    this.#triggers.forgetScheduleObjects(ids);
  }

  // --- the org export ------------------------------------------------------------------------------------------------

  /**
   * The agents `viewer` manages, for the org export: definitions, their triggers (never a secret), and a shared agent's
   * watchers and grants.
   */
  exportAgents(viewer: Scope): ReadonlyArray<AgentExport> {
    const grants = this.#store.grants();

    return this.#store
      .agents()
      .filter((agent) => accessTo(agent.owner, viewer) === "full")
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        model: agent.model,
        ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
        tool_scope: agent.toolScope,
        enabled: agent.enabled,
        private: agent.owner !== undefined,
        triggers: this.#triggers.exported(agent.id),
        ...(agent.owner === undefined
          ? {
              watchers: agent.watchers.flatMap((watcher) => this.#exportedSubject(watcher) ?? []),
              grants: grants
                .filter((grant) => grant.agent === agent.id)
                .flatMap((grant) => this.#exportedSubject(grant.subject) ?? []),
            }
          : {}),
        created_at: iso(agent.createdAt),
      }));
  }

  // --- internals -----------------------------------------------------------------------------------------------------

  /**
   * A definition as stored, or why it is refused: its texts (`definitionRefusal`), its name in the org (when
   * `changed.name`), the route's {@link ReferenceCheck}, and its tool scope's shape and the agents it names, which its
   * owner must be able to use (a private agent's member) or which must be shared agents (a shared agent's), when
   * `changed.toolScope`.
   */
  #checkedDefinition(
    fields: DefinitionFields,
    owner: string | undefined,
    check: ReferenceCheck,
    changed: { readonly name: boolean; readonly toolScope: boolean; readonly self?: string },
  ): AgentsResult<
    Pick<StoredAgent, "name" | "description" | "instructions" | "model" | "thinking" | "toolScope">
  > {
    const textRefusal = definitionRefusal(fields);

    if (textRefusal !== undefined) return refuse("invalid", textRefusal);

    if (changed.name) {
      const taken = this.#store.byName(fields.name);

      if (taken !== undefined && taken.id !== changed.self)
        return refuse("name_taken", "another agent of the org has this name");
    }

    if (check.modelServed === false)
      return refuse(
        "unknown_model",
        owner === undefined
          ? "the org's shared credentials serve no model of this name"
          : "the agent's member may use no model of this name",
      );

    const unknownToolkit = check.unknownToolkits?.[0];

    if (unknownToolkit !== undefined)
      return refuse(
        "unknown_toolkit",
        owner === undefined
          ? `the org has no toolkit ${unknownToolkit}`
          : `the agent's member reaches no toolkit ${unknownToolkit}`,
      );

    const toolScope = changed.toolScope
      ? normalizedToolScope(fields.tool_scope)
      : fields.tool_scope;

    if (toolScope === undefined)
      return refuse(
        "invalid",
        "a tool scope names each toolkit once, a named tool by the stable id of a tool of its toolkit, and agents only on the agents toolkit's entry",
      );

    if (changed.toolScope) {
      const usable = new Set(
        (owner === undefined
          ? this.#store.agents().filter((agent) => agent.owner === undefined)
          : this.#usable(owner)
        ).map((agent) => agent.id),
      );

      const unknown = toolScope
        .flatMap((entry) => entry.agents ?? [])
        .find((agent) => !usable.has(agent) && agent !== changed.self);

      if (unknown !== undefined)
        return refuse(
          "unknown_agent",
          owner === undefined
            ? `no shared agent has the id ${unknown}`
            : `the agent's member may use no agent with the id ${unknown}`,
        );
    }

    return ok({
      name: fields.name,
      description: fields.description,
      instructions: fields.instructions,
      model: fields.model.trim(),
      thinking: fields.thinking,
      toolScope,
    });
  }

  /** `watchers` once each, or why they are refused: a member or team the org does not have. */
  #checkedWatchers(
    watchers: ReadonlyArray<AgentWatcher>,
  ): AgentsResult<ReadonlyArray<AgentWatcher>> {
    const kept: Array<AgentWatcher> = [];
    const seen = new Set<string>();

    for (const watcher of watchers) {
      const trimmed: AgentWatcher = { kind: watcher.kind, id: watcher.id.trim() };
      const refusal = this.#subjectRefusal(trimmed);

      if (refusal !== undefined) return refuse("invalid", `a watcher: ${refusal}`);

      const key = `${trimmed.kind}:${trimmed.id}`;

      if (!seen.has(key)) kept.push(trimmed);
      seen.add(key);
    }

    return ok(kept);
  }

  /** Why `subject` cannot be named: a member or team the org does not have. */
  #subjectRefusal(subject: GrantSubject): string | undefined {
    switch (subject.kind) {
      case "everyone":
        return undefined;
      case "member":
        return this.#core.member(subject.id) === undefined ? "no member has this id" : undefined;
      case "team":
        return this.#core.team(subject.id) === undefined ? "no team has this id" : undefined;
    }
  }

  #isShared(id: string): boolean {
    const agent = this.#store.agent(id);

    return agent !== undefined && agent.owner === undefined;
  }

  /** The agents `member` may use: see {@link usableAgents}. */
  #usable(member: string | undefined): ReadonlyArray<StoredAgent> {
    const teams = member === undefined ? [] : this.#core.teamIdsOf(member);

    const granted = new Set(
      this.#store
        .grants()
        .filter((grant) => names(grant.subject, member, teams))
        .map((grant) => grant.agent),
    );

    const privateServed = member !== undefined && this.#core.privateAgents();

    return this.#store
      .agents()
      .filter(
        (agent) =>
          agent.enabled &&
          (agent.owner === undefined
            ? granted.has(agent.id)
            : privateServed && agent.owner === member),
      );
  }

  /** Whether `member` may use `agent`, enabled or not: their private agent while served, or a granted shared one. */
  #reaches(agent: StoredAgent, member: string): boolean {
    if (agent.owner !== undefined) return agent.owner === member && this.#core.privateAgents();
    const teams = this.#core.teamIdsOf(member);

    return this.#store
      .grants()
      .some((grant) => grant.agent === agent.id && names(grant.subject, member, teams));
  }

  /** The members a shared agent's watchers name: its watching members and the members of its watching teams. */
  #watchingMembers(agent: StoredAgent): ReadonlyArray<string> {
    const watching = new Set<string>();

    for (const watcher of agent.watchers)
      if (watcher.kind === "member") {
        if (this.#core.member(watcher.id) !== undefined) watching.add(watcher.id);
      } else for (const member of this.#core.team(watcher.id)?.members ?? []) watching.add(member);

    return [...watching];
  }

  /** Drops the watchers `gone` matches from `agent`. */
  #dropWatchers(agent: StoredAgent, gone: (watcher: AgentWatcher) => boolean): void {
    if (agent.watchers.some(gone))
      this.#store.setWatchers(
        agent.id,
        agent.watchers.filter((watcher) => !gone(watcher)),
      );
  }

  #exportedSubject(subject: GrantSubject | AgentWatcher): ExportedSubject | undefined {
    switch (subject.kind) {
      case "everyone":
        return { everyone: true };
      case "member": {
        const email = this.#core.member(subject.id)?.email;

        return email === undefined ? undefined : { member: email };
      }

      case "team": {
        const name = this.#core.team(subject.id)?.name;

        return name === undefined ? undefined : { team: name };
      }
    }
  }

  #view(agent: StoredAgent): AgentView {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      model: agent.model,
      ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
      tool_scope: agent.toolScope,
      enabled: agent.enabled,
      private: agent.owner !== undefined,
      ...(agent.owner === undefined
        ? {
            watchers: agent.watchers,
            admins_watch: this.#watchingMembers(agent).length === 0,
          }
        : {}),
      revision: agent.revision,
      created_at: iso(agent.createdAt),
      updated_at: iso(agent.updatedAt),
    };
  }

  #limitedView(agent: StoredAgent): LimitedAgentView {
    const owner = agent.owner ?? "";
    const email = this.#core.member(owner)?.email;

    return {
      id: agent.id,
      name: agent.name,
      private: true,
      limited: true,
      owner: { member_id: owner, ...(email === undefined ? {} : { email }) },
      enabled: agent.enabled,
      created_at: iso(agent.createdAt),
      revision: agent.revision,
    };
  }
}

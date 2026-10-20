/**
 * The Agents part's side of triggers (#231, ADR 0040): the schedules and webhooks configured on an agent, which its
 * manager (a private agent's member, an org admin for a shared agent) lists, adds, edits, enables and disables, removes,
 * and whose webhook secret they rotate; and what each kind's delivery asks of the part. The part's methods delegate
 * here; plain data in and out.
 *
 * **The extension point** is the kind. Every kind ends in {@link Runs.startTriggered}, which records the run's trigger
 * kind and trigger, keys it by the delivery's idempotency key and decides its starter (a private agent's member, or no
 * one): runs, the run's principal and usage records know nothing of kinds. A kind adds its literal and fields to the
 * contract (`ConfiguredTriggerKind`, `CreateTrigger`), its stored config ({@link TriggerConfig}), its rules in the
 * kinds' table (`kinds.ts`: input, secret, object, config, view, export), and its own way in: a schedule's is an alarm
 * of its own object (`schedule-object.ts`, {@link Triggers.fire}), a webhook's a route of the API Worker
 * (`webhook-route.ts`, {@link Triggers.verifyWebhook}, {@link Triggers.startWebhookRun}).
 */
import { accessTo, type Viewer } from "@commissary/auth";
import type { RunView } from "@commissary/contract/agent-runs";
import type {
  ConfiguredTriggerKind,
  CreatedTrigger,
  CreateTrigger,
  RemovedTrigger,
  TriggersList,
  TriggerView,
  UpdateTrigger,
} from "@commissary/contract/agent-triggers";
import { agentWebhookPath } from "@commissary/core";
import type { OrgCore } from "@commissary/state";
import type { AgentStore, StoredAgent } from "../agents/store.ts";
import { iso, ok, type Refusable, refuse } from "../result.ts";
import type { Runs, RunsResult } from "../runs/runs.ts";
import { type KindExport, scheduleSpec, TRIGGER_KINDS } from "./kinds.ts";
import { isTick, nextTick } from "./schedule.ts";
import {
  freshTriggerId,
  type StoredTrigger,
  type TriggerConfig,
  type TriggerStore,
} from "./store.ts";
import { freshWebhookSecret, proves, type WebhookProof } from "./webhook.ts";

export type TriggersErrorCode = "invalid" | "forbidden" | "not_found" | "conflict";

export type TriggersResult<A> = Refusable<TriggersErrorCode, A>;

/** A call on an agent's triggers: who asks (`viewer`, and `by` as edits record them), the agent, the client API's origin. */
export interface TriggersRequest {
  readonly viewer: Viewer;
  readonly agentId: string;
  /** Where the deployment's client API answers: a webhook's URL starts here. */
  readonly origin: string;
  /** Who asks, as a trigger records its creator and last editor (the caller's principal id). */
  readonly by: string;
}

/** A call on one trigger of an agent, at the revision the caller read (`If-Match`). */
export interface TriggerRequest extends TriggersRequest {
  readonly triggerId: string;
  readonly revision: number;
}

/** The longest trigger name. */
const MAX_NAME = 100;

/** The longest input or input template, as an agent's instructions. */
const MAX_INPUT = 65_536;

const AGENT_NOT_FOUND = refuse("not_found", "agent not found");

const TRIGGER_NOT_FOUND = refuse("not_found", "trigger not found");

const TRIGGER_CHANGED = refuse("conflict", "the trigger changed since it was read: read it again");

/** What arming a schedule's object finds: its next tick (`null`: none while it is disabled), or that it is gone. */
export type ScheduleArming =
  | { readonly kind: "gone" }
  | { readonly kind: "armed"; readonly next: number | null };

/** A run a trigger started: the run, whether this delivery created it, and its first turn's input. */
export interface TriggeredRun {
  readonly run: RunView;
  readonly created: boolean;
  readonly input: string;
}

/**
 * What firing a schedule's tick came to: gone (the trigger was removed); early (the tick is still to come: the alarm
 * woke before it); or fired, with the run it started, if any (none while its agent is disabled: the tick is skipped),
 * and the next tick (`null`: none while the trigger is disabled).
 */
export type ScheduleFired =
  | { readonly kind: "gone" }
  | { readonly kind: "early"; readonly next: number }
  | { readonly kind: "fired"; readonly next: number | null; readonly run?: TriggeredRun };

/** A webhook delivery's run: the run, and whether this delivery created it. */
export interface WebhookRun {
  readonly run: RunView;
  readonly created: boolean;
}

/** Whether a delivery proved it holds the webhook's secret; a proven one learns the trigger's input template. */
export type WebhookCheck =
  | { readonly proven: false }
  | { readonly proven: true; readonly template?: string | undefined };

/** A trigger in the org export (`exportAgents`): what it is, never its secret. */
export interface TriggerExport extends KindExport {
  readonly kind: ConfiguredTriggerKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly input?: string;
  readonly created_at: string;
}

/** Why `name` is refused, if it is. */
const nameRefusal = (name: string): string | undefined =>
  name.trim() === "" || name.trim().length > MAX_NAME
    ? `a trigger's name has 1 to ${MAX_NAME} characters`
    : undefined;

/** Why `input` is refused, if it is: too long, empty, or missing where the kind requires it. */
const inputRefusal = (
  input: string | undefined,
  kind: ConfiguredTriggerKind,
): string | undefined => {
  if (input !== undefined && input.length > MAX_INPUT)
    return `a trigger's input has at most ${MAX_INPUT} characters`;
  const rules = TRIGGER_KINDS[kind];

  if (input === undefined ? rules.inputRequired : input.trim() === "") return rules.emptyInput;

  return undefined;
};

export class Triggers {
  readonly #store: TriggerStore;
  readonly #agents: AgentStore;
  readonly #runs: Runs;
  readonly #core: OrgCore;
  readonly #now: () => number;

  constructor(
    store: TriggerStore,
    agents: AgentStore,
    runs: Runs,
    core: OrgCore,
    now: () => number,
  ) {
    this.#store = store;
    this.#agents = agents;
    this.#runs = runs;
    this.#core = core;
    this.#now = now;
  }

  // --- management ----------------------------------------------------------------------------------------------------

  /** The agent `agentId` if `viewer` manages it in full; an org admin's view of a member's private agent is refused. */
  #managed({ viewer, agentId }: TriggersRequest): TriggersResult<StoredAgent> {
    const agent = this.#agents.agent(agentId);

    if (agent === undefined) return AGENT_NOT_FOUND;

    switch (accessTo(agent.owner, viewer)) {
      case "full":
        return ok(agent);
      case "limited":
        return refuse("forbidden", "only its member manages a private agent's triggers");
      case "none":
        return AGENT_NOT_FOUND;
    }
  }

  /** The trigger the request names, of the agent it names, at the revision it read. */
  #managedTrigger(
    request: TriggerRequest,
  ): TriggersResult<{ readonly agent: StoredAgent; readonly trigger: StoredTrigger }> {
    const agent = this.#managed(request);

    if (!agent.ok) return agent;
    const trigger = this.#store.trigger(request.triggerId);

    if (trigger === undefined || trigger.agent !== request.agentId) return TRIGGER_NOT_FOUND;

    return trigger.revision === request.revision
      ? ok({ agent: agent.value, trigger })
      : TRIGGER_CHANGED;
  }

  list(request: TriggersRequest): TriggersResult<TriggersList> {
    const agent = this.#managed(request);

    if (!agent.ok) return agent;

    return ok({
      triggers: this.#store
        .ofAgent(request.agentId)
        .map((trigger) => this.#view(agent.value, trigger, request.origin)),
    });
  }

  create(request: TriggersRequest, input: CreateTrigger): TriggersResult<CreatedTrigger> {
    const agent = this.#managed(request);

    if (!agent.ok) return agent;
    const rules = TRIGGER_KINDS[input.kind];
    const refusal = nameRefusal(input.name) ?? inputRefusal(input.input, input.kind);

    if (refusal !== undefined) return refuse("invalid", refusal);

    const config = rules.config(
      { schedule: input.kind === "schedule" ? input.schedule : undefined },
      undefined,
    );

    if (!config.ok) return config;

    const now = this.#now();
    const secret = rules.secret ? freshWebhookSecret() : undefined;

    const trigger: StoredTrigger = {
      id: freshTriggerId(),
      agent: request.agentId,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      ...(input.input === undefined ? {} : { input: input.input }),
      config: config.value,
      revision: 1,
      createdAt: now,
      createdBy: request.by,
      updatedAt: now,
      updatedBy: request.by,
    };

    this.#store.put(trigger, secret);

    if (rules.object) this.#store.addScheduleObject(trigger.id, now);

    return ok({
      ...this.#view(agent.value, trigger, request.origin),
      ...(secret === undefined ? {} : { secret }),
    });
  }

  update(request: TriggerRequest, input: UpdateTrigger): TriggersResult<TriggerView> {
    if (Object.keys(input).length === 0)
      return refuse("invalid", "an edit names at least one field");

    const found = this.#managedTrigger(request);

    if (!found.ok) return found;
    const { agent, trigger } = found.value;
    const kind = trigger.config.kind;
    const name = input.name ?? trigger.name;
    const text = input.input === undefined ? trigger.input : (input.input ?? undefined);
    const refusal = nameRefusal(name) ?? inputRefusal(text, kind);

    if (refusal !== undefined) return refuse("invalid", refusal);
    const config = TRIGGER_KINDS[kind].config(input, trigger.config);

    if (!config.ok) return config;

    const updated: StoredTrigger = {
      ...trigger,
      name: name.trim(),
      enabled: input.enabled ?? trigger.enabled,
      input: text,
      config: config.value,
      revision: trigger.revision + 1,
      updatedAt: this.#now(),
      updatedBy: request.by,
    };

    this.#store.put(updated);

    return ok(this.#view(agent, updated, request.origin));
  }

  /** Removes a trigger; answers its kind too, so a schedule's object can be deleted. */
  remove(
    request: TriggerRequest,
  ): TriggersResult<RemovedTrigger & { readonly kind: TriggerConfig["kind"] }> {
    const found = this.#managedTrigger(request);

    if (!found.ok) return found;

    this.#store.delete(request.triggerId);

    return ok({ id: request.triggerId, removed: true, kind: found.value.trigger.config.kind });
  }

  /** A webhook's new secret, shown once: the old one stops proving deliveries at once. */
  rotateSecret(request: TriggerRequest): TriggersResult<CreatedTrigger> {
    const found = this.#managedTrigger(request);

    if (!found.ok) return found;
    const { agent, trigger } = found.value;

    if (!TRIGGER_KINDS[trigger.config.kind].secret)
      return refuse("invalid", "only a webhook has a secret");

    const secret = freshWebhookSecret();

    const updated: StoredTrigger = {
      ...trigger,
      revision: trigger.revision + 1,
      updatedAt: this.#now(),
      updatedBy: request.by,
    };

    this.#store.put(updated, secret);

    return ok({ ...this.#view(agent, updated, request.origin), secret });
  }

  // --- schedules -----------------------------------------------------------------------------------------------------

  /** The schedule `triggerId`'s next tick from now, for its object's alarm; `null` while the trigger is disabled. */
  arm(triggerId: string): ScheduleArming {
    const trigger = this.#store.trigger(triggerId);
    const spec = trigger === undefined ? undefined : scheduleSpec(trigger.config);

    if (trigger === undefined || spec === undefined) return { kind: "gone" };

    return { kind: "armed", next: trigger.enabled ? (nextTick(spec, this.#now()) ?? null) : null };
  }

  /**
   * Fires the schedule `triggerId`'s tick `tick` (epoch ms), which its object's alarm held: starts its run, keyed by the
   * tick, so the same tick fired again (a retried alarm) finds that run. A tick still to come starts nothing (`early`),
   * nor one while the agent is disabled (it is skipped, never caught up), nor one the schedule no longer has (it was
   * edited since the alarm was set). The next tick is counted from now.
   */
  fire(triggerId: string, tick: number): ScheduleFired {
    const trigger = this.#store.trigger(triggerId);
    const spec = trigger === undefined ? undefined : scheduleSpec(trigger.config);

    if (trigger === undefined || spec === undefined) return { kind: "gone" };
    const now = this.#now();

    if (tick > now) return { kind: "early", next: tick };

    if (!trigger.enabled) return { kind: "fired", next: null };
    const next = nextTick(spec, now) ?? null;
    const agent = this.#agents.agent(trigger.agent);

    if (agent === undefined || !isTick(spec, tick)) return { kind: "fired", next };

    const started = this.#runs.startTriggered(
      agent,
      { kind: "schedule", id: trigger.id },
      `${trigger.id}:schedule:${iso(tick)}`,
    );

    return started.ok
      ? { kind: "fired", next, run: { ...started.value, input: trigger.input ?? "" } }
      : { kind: "fired", next };
  }

  // --- webhooks ------------------------------------------------------------------------------------------------------

  /**
   * Whether `proof` shows a delivery of `body` to the webhook `triggerId` holds its secret (a signature's timestamp
   * within the tolerance of the part's clock), and then the trigger's input template. An unknown trigger answers like a
   * wrong secret, after the same work, so neither the answer nor its time tells whether it exists.
   */
  verifyWebhook(triggerId: string, proof: WebhookProof, body: Uint8Array): WebhookCheck {
    const trigger = this.#store.trigger(triggerId);
    const secret = trigger?.config.kind === "webhook" ? this.#store.secret(triggerId) : undefined;
    const proven = proves(proof, secret ?? freshWebhookSecret(), body, this.#now());

    return trigger === undefined || secret === undefined || !proven
      ? { proven: false }
      : { proven: true, template: trigger.input };
  }

  /**
   * Starts the run of a delivery to the webhook `triggerId` (after {@link verifyWebhook}), keyed by its
   * `idempotencyKey` (its delivery id, or its body's hash and minute), or finds the run that key started. A disabled
   * trigger or agent starts nothing.
   */
  startWebhookRun(triggerId: string, idempotencyKey: string): RunsResult<WebhookRun> {
    const trigger = this.#store.trigger(triggerId);
    const agent = trigger === undefined ? undefined : this.#agents.agent(trigger.agent);

    if (trigger === undefined || trigger.config.kind !== "webhook" || agent === undefined)
      return TRIGGER_NOT_FOUND;

    if (!trigger.enabled) return refuse("trigger_disabled", "the trigger is disabled");

    return this.#runs.startTriggered(
      agent,
      { kind: "webhook", id: trigger.id },
      `${trigger.id}:${idempotencyKey}`,
    );
  }

  // --- the agent and the org -----------------------------------------------------------------------------------------

  /**
   * Deletes the triggers of `agentId`: the agent was removed. Its schedules' objects are left for a sweep
   * ({@link retiredSchedules}); until then each finds its schedule gone at its next alarm and deletes itself.
   */
  forgetAgent(agentId: string): void {
    this.#store.deleteOfAgent(agentId);
  }

  /** Up to `limit` schedules whose object may exist, for the org's deletion, which deletes every one first. */
  scheduleObjects(limit: number): ReadonlyArray<string> {
    return this.#store.scheduleObjects(limit, false);
  }

  /** Up to `limit` schedules whose object may exist though the schedule is gone (removed, or with its agent). */
  retiredSchedules(limit: number): ReadonlyArray<string> {
    return this.#store.scheduleObjects(limit, true);
  }

  /** Forgets the schedules `ids`, whose objects were deleted. */
  forgetScheduleObjects(ids: ReadonlyArray<string>): void {
    this.#store.forgetScheduleObjects(ids);
  }

  /** The triggers of `agentId`, for the org export: what each is, never a secret. */
  exported(agentId: string): ReadonlyArray<TriggerExport> {
    return this.#store.ofAgent(agentId).map((trigger) => ({
      kind: trigger.config.kind,
      name: trigger.name,
      enabled: trigger.enabled,
      ...(trigger.input === undefined ? {} : { input: trigger.input }),
      ...TRIGGER_KINDS[trigger.config.kind].exported(trigger.config),
      created_at: iso(trigger.createdAt),
    }));
  }

  #view(agent: StoredAgent, trigger: StoredTrigger, origin: string): TriggerView {
    const { config } = trigger;

    return {
      id: trigger.id,
      agent_id: trigger.agent,
      kind: config.kind,
      name: trigger.name,
      enabled: trigger.enabled,
      ...(trigger.input === undefined ? {} : { input: trigger.input }),
      ...TRIGGER_KINDS[config.kind].view(config, {
        live: trigger.enabled && agent.enabled,
        now: this.#now(),
        url: `${origin}${agentWebhookPath(this.#core.org, trigger.id)}`,
      }),
      revision: trigger.revision,
      created_at: iso(trigger.createdAt),
      updated_at: iso(trigger.updatedAt),
    };
  }
}

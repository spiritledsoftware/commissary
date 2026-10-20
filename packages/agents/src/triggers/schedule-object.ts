/**
 * A schedule trigger's Durable Object (#231, ADR 0040): one per schedule, named `<org>:<trigger>`
 * ({@link agentScheduleName}), whose alarm is the schedule's next tick. It lives in the API Worker beside the runs'
 * objects (`AgentSchedule`, apps/api), because a tick starts a run's object, which the state Worker that runs the org's
 * ControlPlane cannot reach (the API Worker binds the state Worker's objects: a binding back would be a cycle no fresh
 * stage could deploy). The app Worker binds it by the API Worker's script name, as it binds the runs'.
 *
 * The management routes arm it ({@link AgentScheduleObject.arm}) when a schedule is added, enabled or edited: it asks
 * the org's ControlPlane for the next tick, keeps it and sets its alarm to it. At the alarm it fires that tick (the
 * Agents part's `fireSchedule`), which starts the tick's run keyed by the tick, so an alarm retried after a failure or
 * an eviction fires the same tick and finds that run; it starts the run's object with the schedule's input, then keeps
 * the next tick. A tick while the agent is disabled starts nothing and the next is kept: ticks missed then are not
 * caught up. A disabled schedule has no next tick and no alarm until it is armed again; a removed one's object is
 * deleted by a sweep (`sweepRetiredSchedules`), or deletes its storage at its next alarm. A ControlPlane that cannot be
 * reached is asked again a minute later, for the same tick. An alarm first asks the Platform registry whether the org
 * still exists: one of a deleted org deletes the object without reaching the org's ControlPlane, which would otherwise
 * be created again, empty.
 */
import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";
import { OrgId } from "@commissary/core";
import { type Platform, platformOf } from "@commissary/state";
import { type AgentsControlPlane, agentRunOf } from "../env.ts";
import { iso, ok, refuse } from "../result.ts";
import type { AgentRunObject } from "../runs/run-object.ts";
import type { RunsResult } from "../runs/runs.ts";
import type { ScheduleFired } from "./triggers.ts";

/** How long after a failed call of the org's ControlPlane the alarm asks again, for the same tick. */
export const SCHEDULE_RETRY_MS = 60_000;

/** The least an alarm that woke before its tick waits before it asks again. */
const EARLY_RETRY_MS = 1_000;

/** What the schedule's object reads from its Worker's env. */
export interface AgentScheduleEnv {
  /** The org's ControlPlane: the schedule's ticks, and its runs in the org's index. */
  readonly CONTROL_PLANE: DurableObjectNamespace<AgentsControlPlane>;
  /** The runs' objects, which a tick starts. */
  readonly AGENT_RUN: DurableObjectNamespace<AgentRunObject>;
  /** The Platform registry: whether the schedule's org still exists. */
  readonly PLATFORM: DurableObjectNamespace<Platform>;
}

/** The schedule an object is armed for: its org and trigger, which its name must be. */
export interface ScheduleInit {
  readonly org: OrgId;
  readonly trigger: string;
}

/** The name of the object of the schedule `trigger` of `org`: both, so a trigger id never reaches another org's. */
export const agentScheduleName = (org: OrgId, trigger: string): string => `${org}:${trigger}`;

const StoredMeta = Schema.Struct({ org: OrgId, trigger: Schema.String });

type StoredMeta = typeof StoredMeta.Type;

const decodeMeta = Schema.decodeUnknownOption(StoredMeta);

const META = "schedule";

/** The tick the alarm is set to (epoch ms). */
const TICK = "tick";

/** Logs a failure that fails no call (the Worker's logs), with the schedule and what failed. */
const warn = (message: string, trigger: string, detail: string): void =>
  Effect.runSync(Effect.logWarning(message).pipe(Effect.annotateLogs({ trigger, detail })));

const SCHEDULE_NOT_FOUND = refuse("not_found", "schedule not found");

/**
 * The schedule's Durable Object. `options` are dev-only: under `alchemy dev` the dev registry reaches an object by its
 * hex id, which drops `ctx.id.name` (apps/api/src/dev.ts), so an arming there cannot be checked against the name.
 */
export class AgentScheduleObject extends DurableObject<AgentScheduleEnv> {
  readonly #unnamedInDev: boolean;
  /** The call running now: the next one starts once it settled. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    ctx: DurableObjectState,
    env: AgentScheduleEnv,
    options: { readonly unnamedInDev?: boolean } = {},
  ) {
    super(ctx, env);
    this.#unnamedInDev = options.unnamedInDev === true;
  }

  /** Runs `call` once every call before it settled. */
  #serial<A>(call: () => Promise<A>): Promise<A> {
    const running = this.#queue.then(call, call);

    this.#queue = running.catch(() => undefined);

    return running;
  }

  #meta(): StoredMeta | undefined {
    const stored = this.ctx.storage.kv.get(META);

    return stored === undefined ? undefined : Option.getOrUndefined(decodeMeta(stored));
  }

  #controlPlane(meta: StoredMeta) {
    return this.env.CONTROL_PLANE.getByName(meta.org).agents();
  }

  /** Keeps `next` as the tick the alarm is set to; `null` deletes both. */
  async #keep(next: number | null): Promise<void> {
    if (next === null) {
      this.ctx.storage.kv.delete(TICK);
      await this.ctx.storage.deleteAlarm();

      return;
    }

    this.ctx.storage.kv.put(TICK, next);
    await this.ctx.storage.setAlarm(next);
  }

  /** Deletes the object's alarm and storage. */
  async #forget(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Sets the alarm to the schedule's next tick, from now (none while it is disabled); answers that tick. The object
   * checks that it is that schedule's (its name is `<org>:<trigger>`). A removed schedule deletes its storage.
   */
  arm(init: ScheduleInit): Promise<RunsResult<{ readonly next: string | null }>> {
    return this.#serial(async () => {
      const name = this.ctx.id.name;

      if (
        name !== agentScheduleName(init.org, init.trigger) &&
        !(name === undefined && this.#unnamedInDev)
      )
        return SCHEDULE_NOT_FOUND;

      const meta: StoredMeta = { org: init.org, trigger: init.trigger };

      this.ctx.storage.kv.put(META, meta);
      const armed = await this.#controlPlane(meta).armSchedule(meta.trigger);

      if (armed.kind === "gone") {
        await this.#forget();

        return SCHEDULE_NOT_FOUND;
      }

      await this.#keep(armed.next);

      return ok({ next: armed.next === null ? null : iso(armed.next) });
    });
  }

  /** Deletes the object: the org's deletion calls it for each of its schedules (`org-deletion.ts`). */
  purge(): Promise<void> {
    return this.#serial(async () => await this.#forget());
  }

  /**
   * Starts the run's object a tick started; one this tick created that cannot be started is ended (a run an earlier
   * attempt of the same tick created may have started: it is left as it is), and the schedule goes on.
   */
  async #start(meta: StoredMeta, fired: Extract<ScheduleFired, { kind: "fired" }>): Promise<void> {
    const started = fired.run;

    if (started === undefined) return;
    const { id } = started.run;

    try {
      const first = await agentRunOf(this.env, meta.org, id).start(
        { org: meta.org, id },
        started.input,
      );

      if (!first.ok) warn("agent schedule: run not started", meta.trigger, first.message);
    } catch (error) {
      warn("agent schedule: run not started", meta.trigger, String(error));

      if (!started.created) return;

      try {
        await this.#controlPlane(meta).abandonTriggeredRun(id);
      } catch (abandon) {
        warn("agent schedule: run not ended", meta.trigger, String(abandon));
      }
    }
  }

  /** The tick: fires it, starts its run, and sets the alarm to the next tick (see the module comment). */
  override async alarm(): Promise<void> {
    await this.#serial(async () => {
      const meta = this.#meta();
      const tick = this.ctx.storage.kv.get<number>(TICK);

      if (meta === undefined || tick === undefined) return;

      let fired: ScheduleFired;

      try {
        // A deleted org's object goes: its ControlPlane is not reached, so it is not created again.
        if ((await platformOf(this.env).getOrgById(meta.org)) === undefined) {
          await this.#forget();

          return;
        }

        fired = await this.#controlPlane(meta).fireSchedule(meta.trigger, tick);
      } catch (error) {
        warn("agent schedule: tick not fired", meta.trigger, String(error));
        await this.ctx.storage.setAlarm(Date.now() + SCHEDULE_RETRY_MS);

        return;
      }

      switch (fired.kind) {
        case "gone":
          await this.#forget();

          return;
        case "early":
          await this.ctx.storage.setAlarm(Math.max(fired.next, Date.now() + EARLY_RETRY_MS));

          return;
        case "fired":
          await this.#start(meta, fired);
          await this.#keep(fired.next);
      }
    });
  }
}

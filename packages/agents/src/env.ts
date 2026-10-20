/**
 * What `@commissary/agents` reads from a Worker's env (#134 "How packages get their bindings"): the org's ControlPlane,
 * typed as objects with the Agents part ({@link AgentsControlPlane}), so callers write `stub.agents().x(…)`, and the
 * deployment's Dynamic Workers binding (`LOADER`), whose presence is the Agents area's (#226): without it the area is
 * absent. Its state is the ControlPlane's, each run's its own Durable Object's (`AGENT_RUN`, #227) and each schedule
 * trigger's ticks its own object's (`AGENT_SCHEDULE`, #231), which the API Worker defines and the app Worker binds by its
 * script name.
 */
import { Context, Effect } from "effect";
import { CurrentOrg, type OrgId, type Reply } from "@commissary/core";
import { callControlPlane, controlPlaneOf } from "@commissary/state";
import type { AgentsPart } from "./control-plane-part.ts";
import type { AgentRunObject } from "./runs/run-object.ts";
import { type AgentScheduleObject, agentScheduleName } from "./triggers/schedule-object.ts";

/** The methods of the Agents part callers reach. */
type AgentsPartMethod =
  | "listAgents"
  | "getAgent"
  | "createAgent"
  | "updateAgent"
  | "removeAgent"
  | "usableAgents"
  | "agentWatchers"
  | "listGrants"
  | "writeGrant"
  | "exportAgents"
  | "startRun"
  | "getRun"
  | "listRuns"
  | "beginTurn"
  | "turnContext"
  | "abandonRun"
  | "runsPage"
  | "forgetRuns"
  | "expireRuns"
  | "deletedRuns"
  | "runStateChanged"
  | "abandonTriggeredRun"
  | "listTriggers"
  | "createTrigger"
  | "updateTrigger"
  | "removeTrigger"
  | "rotateTriggerSecret"
  | "armSchedule"
  | "fireSchedule"
  | "verifyWebhook"
  | "startWebhookRun"
  | "scheduleObjectsPage"
  | "retiredSchedules"
  | "forgetScheduleObjects"
  | "startToolkitRun"
  | "getToolkitRun"
  | "listToolkitRuns"
  | "abandonToolkitRun";

/** The Agents part of an org's ControlPlane (`AgentsPart`) as Agents sees it: the methods it calls. */
export type AgentsControlPlanePart = Pick<AgentsPart, AgentsPartMethod> & Rpc.RpcTargetBranded;

/** Agents' view of an org's ControlPlane: its part, reached in one pipelined round trip (`stub.agents().x(…)`). */
export interface AgentsControlPlane extends Rpc.DurableObjectBranded {
  agents(): AgentsControlPlanePart;
}

export type AgentsControlPlaneStub = DurableObjectStub<AgentsControlPlane>;

export interface AgentsBindings {
  /** One ControlPlane per org, seen through {@link AgentsControlPlane}. */
  readonly CONTROL_PLANE: DurableObjectNamespace<AgentsControlPlane>;
  /**
   * Dynamic Workers (Workers Paid, ADR 0043), bound on every deployment: the Agents area exists exactly when it is
   * ({@link agentsPresent}). Only its presence is read here.
   */
  readonly LOADER?: WorkerLoader | undefined;
  /**
   * The agent runs (#227), one object per run ({@link agentRunOf}): the API Worker's class (ADR 0030's amendment),
   * which the app Worker binds by the API Worker's script name.
   */
  readonly AGENT_RUN: DurableObjectNamespace<AgentRunObject>;
  /**
   * The schedule triggers (#231), one object per schedule ({@link agentScheduleOf}), whose alarm is its next tick: the
   * API Worker's class, which the app Worker binds by the API Worker's script name to arm it.
   */
  readonly AGENT_SCHEDULE: DurableObjectNamespace<AgentScheduleObject>;
  /**
   * The API host (`COMMISSARY_API_DOMAIN`), where webhook triggers' URLs point; unset where the client API answers on
   * the app host (zone routes), whose URLs then take the request's origin.
   */
  readonly API_DOMAIN?: string | undefined;
}

/** The name of the run `run` of `org`'s object: both, so a run id never reaches another org's run. */
export const agentRunName = (org: OrgId, run: string): string => `${org}:${run}`;

/** The object of the run `run` of `org` ({@link agentRunName}). */
export const agentRunOf = (
  env: Pick<AgentsBindings, "AGENT_RUN">,
  org: OrgId,
  run: string,
): DurableObjectStub<AgentRunObject> => env.AGENT_RUN.getByName(agentRunName(org, run));

/** The object of the schedule trigger `trigger` of `org` (`agentScheduleName`). */
export const agentScheduleOf = (
  env: Pick<AgentsBindings, "AGENT_SCHEDULE">,
  org: OrgId,
  trigger: string,
): DurableObjectStub<AgentScheduleObject> =>
  env.AGENT_SCHEDULE.getByName(agentScheduleName(org, trigger));

/**
 * The Agents bindings of the current Worker invocation. Provided per request through the `Context` handed to the web
 * handler (`requestContext`), never through a long-lived layer: bindings must not be captured across requests.
 */
export class AgentsEnv extends Context.Service<AgentsEnv, AgentsBindings>()(
  "commissary/agents/AgentsEnv",
) {}

/** Whether the deployment has the Agents area: its Dynamic Workers binding (`LOADER`, #226). */
export const agentsPresent = (env: AgentsPartEnv): boolean => env.LOADER !== undefined;

/**
 * What the state Worker reads for Agents (#229): only whether the area is there (`LOADER`), which decides whether its
 * ControlPlane has the agents toolkit.
 */
export type AgentsPartEnv = Pick<AgentsBindings, "LOADER">;

/** Calls the current org's ControlPlane from an Agents management route (`callControlPlane`). */
export const agentsControlPlane = <R>(
  label: string,
  call: (stub: AgentsControlPlaneStub) => R,
): Effect.Effect<Awaited<R>, Reply, AgentsEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const stub: AgentsControlPlaneStub = controlPlaneOf(yield* AgentsEnv, yield* CurrentOrg);

    return yield* callControlPlane(label, stub, call);
  });

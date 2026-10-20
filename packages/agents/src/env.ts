/**
 * What `@commissary/agents` reads from a Worker's env (#134 "How packages get their bindings"): the org's ControlPlane,
 * typed as objects with the Agents part ({@link AgentsControlPlane}), so callers write `stub.agents().x(…)`, and the
 * deployment's Dynamic Workers binding (`LOADER`), whose presence is the Agents area's (#226): without it the area is
 * absent. Its state is the ControlPlane's. Runs (#227) will execute on Dynamic Workers; until then only the binding's
 * presence is read.
 */
import { Context, Effect } from "effect";
import { CurrentOrg, type Reply } from "@commissary/core";
import { callControlPlane, controlPlaneOf } from "@commissary/state";
import type { AgentsPart } from "./control-plane-part.ts";

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
  | "exportAgents";

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
}

/**
 * The Agents bindings of the current Worker invocation. Provided per request through the `Context` handed to the web
 * handler (`requestContext`), never through a long-lived layer: bindings must not be captured across requests.
 */
export class AgentsEnv extends Context.Service<AgentsEnv, AgentsBindings>()(
  "commissary/agents/AgentsEnv",
) {}

/** Whether the deployment has the Agents area: its Dynamic Workers binding (`LOADER`, #226). */
export const agentsPresent = (env: Pick<AgentsBindings, "LOADER">): boolean =>
  env.LOADER !== undefined;

/** Calls the current org's ControlPlane from an Agents management route (`callControlPlane`). */
export const agentsControlPlane = <R>(
  label: string,
  call: (stub: AgentsControlPlaneStub) => R,
): Effect.Effect<Awaited<R>, Reply, AgentsEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const stub: AgentsControlPlaneStub = controlPlaneOf(yield* AgentsEnv, yield* CurrentOrg);

    return yield* callControlPlane(label, stub, call);
  });

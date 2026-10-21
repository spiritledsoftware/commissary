/**
 * The ControlPlane Durable Object as the state Worker defines it (`CONTROL_PLANE`, one object per org):
 * `@commissary/state`'s org-wide base composed with the areas' parts (`composeControlPlane`; #134 "How an area's
 * ControlPlane part works", #148). Today that is the Models part, Billing's, Tools' and Agents', reached as
 * `stub.models().x(…)`, `stub.billing().x(…)`, `stub.tools().x(…)` and `stub.agents().x(…)`. The Tools part gets the
 * built-in toolkits the env's bindings give (the browser toolkit with a `browser` binding, #212; the sandbox toolkit on
 * the `SandboxSession` objects and Dynamic Workers, which every deployment has, #222), on Commissary Cloud the managed
 * OAuth apps whose secrets the env binds (#207), and the agents toolkit (#229) where the Agents area is (`LOADER`),
 * whose reach is the Agents part's answer to which agents a caller may run, read in place in the same object: Tools
 * imports nothing of Agents, and this composition is the seam between them; and who watches each agent run (#232), read
 * in place the same way, for the run's approvals and its browser sessions' Live View. The other way, the Agents part
 * deletes the sandbox sessions of the runs it deletes through the Tools part of the same object (#230), which keeps
 * them.
 */
import { composeControlPlane } from "@commissary/state";
import {
  AgentsPart,
  type AgentsPartEnv,
  agentsPresent,
  type RunSandboxes,
} from "@commissary/agents/state";
import { BillingPart, planMeterOf } from "@commissary/billing/state";
import { ModelsPart, type ModelsPartEnv } from "@commissary/models/state";
import {
  type AgentDirectory,
  builtInProviders,
  managedAppsOf,
  type RunWatchers,
  ToolsPart,
  type ToolsPartEnv,
} from "@commissary/tools/state";

/** What the parts read from the state Worker's env. */
type PartsEnv = ModelsPartEnv & ToolsPartEnv & AgentsPartEnv;

/** Each object's Agents part, by the object's state: the Tools part of the same object reads it. */
const agentsParts = new WeakMap<DurableObjectState, AgentsPart>();

/** Each object's Tools part, by the object's state: the Agents part of the same object asks it (#230). */
const toolsParts = new WeakMap<DurableObjectState, ToolsPart>();

/**
 * The agents a caller may run, from the Agents part of the object `ctx`. The composition makes both parts with the
 * object, so the part is there by the first call; one missing is a wiring fault, which fails the call rather than
 * hiding the toolkit.
 */
const agentDirectory = (ctx: DurableObjectState): AgentDirectory => ({
  runnable: (member) => {
    const part = agentsParts.get(ctx);

    if (part === undefined) throw new Error("the ControlPlane's Agents part is not wired");

    return part.runnableAgents(member);
  },
});

/**
 * Who watches each agent run of the object `ctx`, from its Agents part (#232): read at once, as the Tools part decides
 * who may watch a browser session for every session of a list. A part missing is a wiring fault, which fails the call.
 */
const runWatchers = (ctx: DurableObjectState): RunWatchers => ({
  of: (runId) => {
    const part = agentsParts.get(ctx);

    if (part === undefined) throw new Error("the ControlPlane's Agents part is not wired");

    return part.runWatchers(runId);
  },
});

/**
 * The sandbox sessions of the runs of the object `ctx`, in its Tools part (#230): a run's go when it is deleted, and
 * one that no longer fits its definition is left for a new one. A part missing is a wiring fault, which fails the call,
 * so the runs stay listed for the next sweep.
 */
const runSandboxes = (ctx: DurableObjectState): RunSandboxes => ({
  purge: async (runIds) => {
    const part = toolsParts.get(ctx);

    if (part === undefined) throw new Error("the ControlPlane's Tools part is not wired");

    return await part.purgeRunSandboxSessions(runIds);
  },
  fits: (definition, opened) => {
    const part = toolsParts.get(ctx);

    if (part === undefined) throw new Error("the ControlPlane's Tools part is not wired");

    return part.runSandboxFits(definition, opened);
  },
});

/** Each object's Billing part: the Tools part of the same object counts what plans count of it through it (#241). */
const billingParts = new WeakMap<DurableObjectState, BillingPart>();

export class ControlPlane extends composeControlPlane({
  models: (ctx, env: PartsEnv, core) => new ModelsPart(ctx, env, core),
  billing: (ctx) => {
    const part = new BillingPart(ctx);

    billingParts.set(ctx, part);

    return part;
  },
  tools: (ctx, env: PartsEnv, core) => {
    const part = new ToolsPart(
      ctx,
      core,
      // The agents toolkit only where the Agents area is (`LOADER`, ADR 0043), as the rest of the area.
      {
        ...builtInProviders(env),
        ...(agentsPresent(env)
          ? { agents: agentDirectory(ctx), runWatchers: runWatchers(ctx) }
          : {}),
      },
      {
        ownHosts: env.OWN_HOSTS,
        managedApps: managedAppsOf(env),
        // Plans exist on Commissary Cloud only: tool calls, browser and computer time count there (#241).
        plans: () => planMeterOf(env, billingParts.get(ctx)),
      },
    );

    toolsParts.set(ctx, part);

    return part;
  },
  // The Agents part (#226), reached as `stub.agents().x(…)`: hosted agent definitions and their grants.
  agents: (ctx, _env, core) => {
    const part = new AgentsPart(ctx, core, runSandboxes(ctx));

    agentsParts.set(ctx, part);

    return part;
  },
}) {}

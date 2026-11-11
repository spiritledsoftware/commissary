/**
 * The ControlPlane Durable Object as the state Worker defines it (`CONTROL_PLANE`, one object per org):
 * `@commissary/state`'s org-wide base composed with the areas' parts (`composeControlPlane`; #134 "How an area's
 * ControlPlane part works", #148). Today that is the Models part, Billing's and Tools', reached as
 * `stub.models().x(…)`, `stub.billing().x(…)` and `stub.tools().x(…)`. The Tools part gets the built-in toolkits the
 * env's bindings give (the browser toolkit with a `browser` binding, #212; the sandbox toolkit on the `SandboxSession`
 * objects and Dynamic Workers, which every deployment has, #222), and on Commissary Cloud the managed OAuth apps whose
 * secrets the env binds (#207).
 *
 * The object also drops the tables of the hosted Agents area, which Commissary no longer has (ADR 0048), when it starts.
 */
import { composeControlPlane } from "@commissary/state";
import { BillingPart, planMeterOf } from "@commissary/billing/state";
import { ModelsPart, type ModelsPartEnv } from "@commissary/models/state";
import {
  builtInProviders,
  managedAppsOf,
  ToolsPart,
  type ToolsPartEnv,
} from "@commissary/tools/state";

/** What the parts read from the state Worker's env. */
type PartsEnv = ModelsPartEnv & ToolsPartEnv;

/**
 * The tables the Agents area (hosted agents, their runs and triggers) kept in an org's ControlPlane SQLite (their
 * indexes go with them). A webhook trigger's sealed secret lived in its row of `agent_triggers`, so it goes with the
 * table. Dropped once per start (`IF EXISTS`: a no-op after the first), and these names must not be reused for a
 * table of another meaning. The runs' sandbox tickets (`sandbox_run_calls`) were Tools', whose store drops them.
 */
const RETIRED_TABLES: ReadonlyArray<string> = [
  "agents",
  "agent_grants",
  "agent_runs",
  "agent_run_purges",
  "agent_triggers",
  "agent_schedule_objects",
];

/** Each object's Billing part: the Tools part of the same object counts what plans count of it through it (#241). */
const billingParts = new WeakMap<DurableObjectState, BillingPart>();

const ControlPlaneBase = composeControlPlane({
  models: (ctx, env: PartsEnv, core) => new ModelsPart(ctx, env, core),
  billing: (ctx) => {
    const part = new BillingPart(ctx);

    billingParts.set(ctx, part);

    return part;
  },
  tools: (ctx, env: PartsEnv, core) =>
    new ToolsPart(ctx, core, builtInProviders(env), {
      ownHosts: env.OWN_HOSTS,
      managedApps: managedAppsOf(env),
      // Plans exist on Commissary Cloud only: tool calls, browser and computer time count there (#241).
      plans: () => planMeterOf(env, billingParts.get(ctx)),
    }),
});

export class ControlPlane extends ControlPlaneBase {
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof ControlPlaneBase>[1]) {
    super(ctx, env);

    for (const table of RETIRED_TABLES) ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

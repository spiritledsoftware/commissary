/**
 * The ControlPlane Durable Object as the state Worker defines it (`CONTROL_PLANE`, one object per org):
 * `@commissary/state`'s org-wide base composed with the areas' parts (`composeControlPlane`; #134 "How an area's
 * ControlPlane part works", #148). Today that is the Models part, Billing's and Tools', reached as `stub.models().x(…)`,
 * `stub.billing().x(…)` and `stub.tools().x(…)`. The Tools part gets the built-in toolkits the env's bindings give (the
 * browser toolkit with a `browser` binding, #212; the sandbox toolkit on the `SandboxSession` objects and Dynamic
 * Workers, which every deployment has, #222).
 */
import { composeControlPlane } from "@commissary/state";
import { BillingPart } from "@commissary/billing/state";
import { ModelsPart, type ModelsPartEnv } from "@commissary/models/state";
import { builtInProviders, ToolsPart, type ToolsPartEnv } from "@commissary/tools/state";

/** What the parts read from the state Worker's env. */
type PartsEnv = ModelsPartEnv & ToolsPartEnv;

export class ControlPlane extends composeControlPlane({
  models: (ctx, env: PartsEnv, core) => new ModelsPart(ctx, env, core),
  billing: (ctx) => new BillingPart(ctx),
  tools: (ctx, env: PartsEnv, core) =>
    new ToolsPart(ctx, core, builtInProviders(env), env.OWN_HOSTS),
}) {}

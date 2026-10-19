/**
 * The ControlPlane Durable Object as the state Worker defines it (`CONTROL_PLANE`, one object per org):
 * `@commissary/state`'s org-wide base composed with the areas' parts (`composeControlPlane`; #134 "How an area's
 * ControlPlane part works", #148). Today that is the Models part, Billing's and Tools', reached as `stub.models().x(…)`,
 * `stub.billing().x(…)` and `stub.tools().x(…)`.
 */
import { composeControlPlane } from "@commissary/state";
import { BillingPart } from "@commissary/billing/state";
import { ModelsPart, type ModelsPartEnv } from "@commissary/models/state";
import { ToolsPart } from "@commissary/tools/state";

export class ControlPlane extends composeControlPlane({
  models: (ctx, env: ModelsPartEnv, core) => new ModelsPart(ctx, env, core),
  billing: (ctx) => new BillingPart(ctx),
  tools: (ctx, _env, core) => new ToolsPart(ctx, core),
}) {}

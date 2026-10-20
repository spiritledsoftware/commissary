/**
 * Cron runner (`scheduled` handler), the API Worker's (#134 "Org deletion and crons"). The Worker has a single
 * three-hourly trigger (`CRONS` in alchemy.run.ts); the runner runs its own task and the cron tasks of each area it
 * mounts, listed explicitly in {@link scheduledTasks}.
 *
 * Jobs run one after another and are isolated: a failing job is logged and does not stop the others. A job is either
 * deployment-wide (`scope: "deployment"`: the shared model catalog, client versions, usage retention) and runs once, or
 * org-scoped (`scope: "org"`: credentials, quotas, entitlements) and runs once for every org with `CurrentOrg` set, so
 * it only ever reaches that org's ControlPlane (ADR 0021). One org's failure does not stop the next org. The orgs
 * are the ones the Platform registry lists ({@link registeredOrgs}).
 */
import { Clock, Context, Effect, Layer } from "effect";
import {
  causeSummary,
  CurrentOutboundPolicy,
  OutboundHttpClientLive,
  WorkerExecutionContext,
  CurrentOrg,
  GLOBAL_ORG,
  type OrgId,
  type ScheduledTask,
} from "@commissary/core";
import { currentControlPlane, platform, type StateBindings, StateEnv } from "@commissary/state";
import {
  type AgentsBindings,
  AgentsEnv,
  scheduledTasks as agentsTasks,
} from "@commissary/agents/api";
import {
  type ModelsBindings,
  ModelsEnv,
  scheduledTasks as modelsTasks,
  ScheduledTaskLayer as ModelsTaskLayer,
} from "@commissary/models/api";
import { type ToolsBindings, ToolsEnv, scheduledTasks as toolsTasks } from "@commissary/tools/api";
import {
  type BillingBindings,
  BillingEnv,
  scheduledTasks as billingTasks,
} from "@commissary/billing/api";
import { type ApiBindings, outboundPolicyOf } from "./worker-env.ts";

/**
 * The bindings the runner and the areas it mounts read: the state's and each area's view of `env`, and the Worker's
 * own hosts for the outbound guard.
 */
export type ScheduledBindings = StateBindings &
  ModelsBindings &
  ToolsBindings &
  BillingBindings &
  AgentsBindings &
  ApiBindings;

/** Each view of `env` the jobs read, as its service. */
const bindingsContext = (
  env: ScheduledBindings,
): Context.Context<StateEnv | ModelsEnv | ToolsEnv | BillingEnv | AgentsEnv> =>
  Context.make(StateEnv, env).pipe(
    Context.add(ModelsEnv, env),
    Context.add(ToolsEnv, env),
    Context.add(BillingEnv, env),
    Context.add(AgentsEnv, env),
  );

/** Services available to scheduled jobs (provided by {@link ScheduledLayer} and the invocation's bindings). */
export type ScheduledServices =
  | Layer.Success<typeof ScheduledLayer>
  | StateEnv
  | ModelsEnv
  | ToolsEnv
  | BillingEnv
  | AgentsEnv
  | WorkerExecutionContext;

/**
 * Expired API keys are deleted, not kept marked (ADR 0027): a listing or issue deletes them too, this covers an org
 * nobody opens. API keys are org-wide (`@commissary/state`), not an area's.
 */
const apiKeyExpiry: ScheduledTask<StateEnv> = {
  name: "api-key-expiry",
  scope: "org",
  run: Effect.gen(function* () {
    const plane = yield* currentControlPlane;
    const now = yield* Clock.currentTimeMillis;

    return yield* Effect.promise(() => plane.purgeExpiredApiKeys(now));
  }),
};

/** Every job of a cron invocation, in order: the runner's own, then each area's. */
export const scheduledTasks: ReadonlyArray<ScheduledTask<ScheduledServices>> = [
  apiKeyExpiry,
  ...modelsTasks,
  ...toolsTasks,
  ...billingTasks,
  ...agentsTasks,
];

/**
 * The services the areas' tasks read besides the bindings, built once per cron invocation: the global `fetch` behind
 * the outbound guard (a quota sweep reaches a provider's `base_url`, ADR 0044).
 */
export const ScheduledLayer = Layer.mergeAll(OutboundHttpClientLive, ModelsTaskLayer);

/** Logs a failed job instead of failing the invocation; a summary only: full causes carry stacks and upstream URLs. */
const isolated = <R>(
  label: string,
  run: Effect.Effect<unknown, Error, R>,
): Effect.Effect<void, never, R> =>
  run.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logError(`scheduled task ${label} failed: ${causeSummary(cause)}`),
    ),
  );

/**
 * The ids of the orgs the Platform registry lists, in its order. When the registry cannot be reached the jobs still run
 * for `global`, the org every deployment has had since before orgs existed, so one failing object does not stop the
 * deployment's maintenance; the failure is logged.
 */
export const registeredOrgs: Effect.Effect<ReadonlyArray<OrgId>, never, StateEnv> = platform(
  "listOrgs",
  (stub) => stub.listOrgs(),
).pipe(
  Effect.map((orgs) => orgs.map((org) => org.id)),
  Effect.catchTag("PlatformUnavailable", (error) =>
    Effect.logError(
      `scheduled tasks: ${error.message}; running the org jobs for ${GLOBAL_ORG} only`,
    ).pipe(Effect.as([GLOBAL_ORG])),
  ),
);

/**
 * Runs all jobs for one cron invocation: deployment jobs once, org jobs once per org of `orgs` (the registry's orgs
 * unless given), in task order.
 */
export const runScheduledTasks = (
  tasks: ReadonlyArray<ScheduledTask<ScheduledServices>>,
  env: ScheduledBindings,
  ctx: ExecutionContext,
  orgs?: ReadonlyArray<OrgId>,
): Promise<void> =>
  Effect.gen(function* () {
    const targets = orgs ?? (yield* registeredOrgs);

    yield* Effect.forEach(
      tasks,
      (task) =>
        task.scope === "deployment"
          ? isolated(task.name, task.run)
          : Effect.forEach(
              targets,
              (org) =>
                isolated(`${task.name} (org ${org})`, task.run).pipe(
                  Effect.provideService(CurrentOrg, org),
                ),
              { discard: true },
            ),
      { discard: true },
    );
  }).pipe(
    Effect.provide(ScheduledLayer),
    Effect.provideContext(bindingsContext(env)),
    Effect.provideService(WorkerExecutionContext, ctx),
    Effect.provideService(CurrentOutboundPolicy, outboundPolicyOf(env)),
    Effect.runPromise,
  );

export const dispatchScheduled = (
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => runScheduledTasks(scheduledTasks, env, ctx);

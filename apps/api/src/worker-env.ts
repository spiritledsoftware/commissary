/**
 * The API Worker's bindings as its code reads them (#134 "How packages get their bindings"): every package reads only
 * its own view ({@link AuthConfig}, {@link StateEnv}, {@link ModelsEnv}, {@link BillingEnv}, {@link ToolsEnv},
 * {@link AgentsEnv}: an agent run's principal, `http/run-gateway.ts`; `core` reads none), and the request context provides each of them from the invocation's `env`, which satisfies every view
 * (`ApiWorkerBindings`), plus the port `@commissary/auth` reaches state through (`AuthDirectory`) and the one through
 * which Tools' MCP endpoint makes the agents toolkit's calls (`AgentsToolkitPort`, filled from Agents, #229). The API
 * Worker never sees sessions (ADR 0030): it provides no `SignInSessions`.
 */
import { Context } from "effect";
import {
  type AgentsBindings,
  AgentsEnv,
  agentsPresent,
  agentsToolkitCalls,
} from "@commissary/agents/api";
import { type AuthBindings, AuthConfig, AuthDirectory } from "@commissary/auth";
import { type BillingBindings, BillingEnv } from "@commissary/billing/api";
import { type ModelsBindings, ModelsEnv } from "@commissary/models/api";
import { AgentsToolkitPort, type ToolsBindings, ToolsEnv } from "@commissary/tools/api";
import {
  CurrentOrg,
  CurrentOutboundPolicy,
  GLOBAL_ORG,
  type OutboundPolicy,
  outboundPolicy,
  WorkerExecutionContext,
} from "@commissary/core";
import { stateAuthDirectory, type StateBindings, StateEnv } from "@commissary/state";

/** What the API Worker's own code reads: where it answers, for its refusals (`http/hosts.ts`). */
export interface ApiBindings {
  /**
   * The app host (ADR 0028), bound on every deployed stage, one host or split: named when another path is asked for
   * (`http/hosts.ts`), and where the panel's links point (Tools' connect pages, Billing's billing page).
   */
  readonly APP_DOMAIN?: string;
  /** The API host (`http/hosts.ts`, ADR 0028). */
  readonly API_DOMAIN?: string;
  /**
   * The deployment's own hosts (base, app, API and auth host, comma separated; empty on a preview and under
   * `alchemy dev`), which the outbound guard refuses ({@link outboundPolicyOf}).
   */
  readonly OWN_HOSTS: string;
}

/** Every view of the API Worker's `env`; the global `Env` satisfies it. */
export type ApiWorkerBindings = AuthBindings &
  StateBindings &
  ModelsBindings &
  BillingBindings &
  ToolsBindings &
  AgentsBindings &
  ApiBindings;

/** The services {@link envContext} provides; where the Agents area is, also the optional `AgentsToolkitPort`. */
export type EnvServices =
  | AuthConfig
  | StateEnv
  | ModelsEnv
  | BillingEnv
  | ToolsEnv
  | AgentsEnv
  | AuthDirectory;

/**
 * Each view of `env`, as its service, the directory over the Durable Object stubs (`stateAuthDirectory`), and, where
 * the Agents area is (`LOADER`), the agents toolkit's calls over the runs' objects this Worker defines (#229).
 */
export const envContext = (env: ApiWorkerBindings): Context.Context<EnvServices> => {
  const services = Context.make(AuthConfig, env).pipe(
    Context.add(StateEnv, env),
    Context.add(ModelsEnv, env),
    Context.add(BillingEnv, env),
    Context.add(ToolsEnv, env),
    Context.add(AgentsEnv, env),
    Context.add(AuthDirectory, stateAuthDirectory(env)),
  );

  return agentsPresent(env)
    ? services.pipe(Context.add(AgentsToolkitPort, agentsToolkitCalls(env)))
    : services;
};

/**
 * The outbound guard's policy (ADR 0044) of an invocation: the deployment's own hosts as the API Worker's bindings name
 * them, plus the host of `requestUrl`, the request being served (none for a cron invocation).
 */
export const outboundPolicyOf = (env: ApiBindings, requestUrl?: string): OutboundPolicy =>
  outboundPolicy({ hosts: [env.OWN_HOSTS, env.APP_DOMAIN, env.API_DOMAIN], requestUrl });

/**
 * Builds the per-request context passed as the second argument of the web handler. A request belongs to `global` until
 * the client gate sets the org of its API key. `requestUrl`, the request's URL, completes the outbound guard's policy
 * ({@link outboundPolicyOf}).
 */
export const requestContext = (
  env: ApiWorkerBindings,
  ctx: ExecutionContext,
  requestUrl?: string,
): Context.Context<EnvServices | WorkerExecutionContext | CurrentOrg> =>
  envContext(env).pipe(
    Context.add(WorkerExecutionContext, ctx),
    Context.add(CurrentOrg, GLOBAL_ORG),
    Context.add(CurrentOutboundPolicy, outboundPolicyOf(env, requestUrl)),
  );

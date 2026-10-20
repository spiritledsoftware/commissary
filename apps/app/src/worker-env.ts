/**
 * The Worker's bindings as its code reads them (#134 "How packages get their bindings"): every package reads only
 * its own view ({@link AuthConfig}, {@link StateEnv}, {@link ModelsEnv}, {@link BillingEnv}, {@link ToolsEnv},
 * {@link AgentsEnv}; `core` reads none), and the
 * code that stays in the Worker reads {@link AppEnv}. The request context provides each of them from the invocation's
 * `env`, which satisfies every view (`WorkerBindings`), and the ports `@commissary/auth` reaches state and Better
 * Auth's sessions through (`AuthDirectory`, `SignInSessions`).
 */
import { Context } from "effect";
import {
  type AuthBindings,
  AuthConfig,
  AuthDirectory,
  SignInSessions,
  type SignInService,
} from "@commissary/auth";
import { type BillingBindings, BillingEnv } from "@commissary/billing/api";
import { signInSessions } from "./hosted/sign-in.ts";
import { type ModelsBindings, ModelsEnv } from "@commissary/models/api";
import { type ToolsBindings, ToolsEnv } from "@commissary/tools/api";
import { type AgentsBindings, AgentsEnv } from "@commissary/agents/api";
import {
  CurrentOrg,
  CurrentOutboundPolicy,
  GLOBAL_ORG,
  type OutboundPolicy,
  outboundPolicy,
  WorkerExecutionContext,
} from "@commissary/core";
import { stateAuthDirectory, type StateBindings, StateEnv } from "@commissary/state";

/**
 * What the Worker's own code reads (the panel's assets, its hosts, the auth Worker, the owned-org limit): code that
 * stays in an app when the packages move.
 */
export interface AppBindings {
  /** Static assets (management panel, `management/web-panel.ts`). */
  readonly ASSETS: Fetcher;
  /** The host of the client API, when it is not the app host (`http/hosts.ts`, ADR 0028, ADR 0030). */
  readonly API_DOMAIN?: string;
  /** Hosted: how many orgs a person may own unless a platform admin raised their limit (`hosted/owned-orgs.ts`). */
  readonly OWNED_ORG_LIMIT?: string;
  /**
   * Hosted: the auth Worker (ADR 0030), which holds Better Auth: who a session belongs to, ending sessions, deleting a
   * sign-in account (`hosted/sign-in.ts`). Unbound on a self-hosted Commissary.
   */
  readonly AUTH?: SignInService;
  /**
   * Hosted: the auth host's origin (`https://<COMMISSARY_AUTH_DOMAIN>`, under the base domain), which the sign-in page
   * calls (`management/web-panel.ts`) and the orgs' identity providers send people back to (`management/sso-routes.ts`).
   */
  readonly AUTH_ORIGIN?: string;
  /**
   * The deployment's own hosts (base, app, API and auth host, comma separated; empty on a preview and under
   * `alchemy dev`), which the outbound guard refuses ({@link outboundPolicyOf}).
   */
  readonly OWN_HOSTS: string;
  /**
   * Browser Run (#212, ADR 0043): bound unless the deploy turned the browser off. Only its presence is read here
   * (`management/deployment.ts`); the browser toolkit runs on the state Worker's own binding.
   */
  readonly BROWSER?: Pick<BrowserRun, "quickAction"> | undefined;
  /**
   * The sandbox's computer (#223, ADR 0043): `on` exactly when the deploy attached its container to the state Worker's
   * `SandboxSession` class (`@commissary/core`'s `COMPUTER_MARKER`). Only read for `/me` (`management/deployment.ts`).
   */
  readonly COMPUTER?: string | undefined;
}

/**
 * The Worker's own bindings of the current invocation. Provided per request through the `Context` handed to the web
 * handler ({@link requestContext}), never through a long-lived layer: bindings must not be captured across requests.
 */
export class AppEnv extends Context.Service<AppEnv, AppBindings>()("commissary/worker/AppEnv") {}

/** Every view of the Worker's `env`; the global `Env` satisfies it. */
export type WorkerBindings = AuthBindings &
  StateBindings &
  ModelsBindings &
  BillingBindings &
  ToolsBindings &
  AgentsBindings &
  AppBindings;

/** The services {@link envContext} provides. */
export type EnvServices =
  | AuthConfig
  | StateEnv
  | ModelsEnv
  | BillingEnv
  | ToolsEnv
  | AgentsEnv
  | AppEnv
  | AuthDirectory
  | SignInSessions;

/**
 * Each view of `env`, as its service, and auth's ports over it: the directory over the Durable Object stubs
 * (`@commissary/state`'s `stateAuthDirectory`) and Better Auth's sessions over the auth Worker's RPC
 * (`hosted/sign-in.ts`).
 */
export const envContext = (env: WorkerBindings): Context.Context<EnvServices> => {
  const directory = stateAuthDirectory(env);

  return Context.make(AuthConfig, env).pipe(
    Context.add(StateEnv, env),
    Context.add(ModelsEnv, env),
    Context.add(BillingEnv, env),
    Context.add(ToolsEnv, env),
    Context.add(AgentsEnv, env),
    Context.add(AppEnv, env),
    Context.add(AuthDirectory, directory),
    Context.add(SignInSessions, signInSessions(env)),
  );
};

/**
 * The outbound guard's policy (ADR 0044) of a request: the deployment's own hosts as the app Worker's bindings name
 * them, plus the host of `requestUrl`, the request being served.
 */
export const outboundPolicyOf = (env: AppBindings, requestUrl?: string): OutboundPolicy =>
  outboundPolicy({ hosts: [env.OWN_HOSTS, env.API_DOMAIN, env.AUTH_ORIGIN], requestUrl });

/**
 * Builds the per-request context passed as the second argument of the web handler. Every request belongs to the org
 * `global` for now (ADR 0021); resolving the org from the request replaces this default later. `requestUrl`, the
 * request's URL, completes the outbound guard's policy ({@link outboundPolicyOf}).
 */
export const requestContext = (
  env: WorkerBindings,
  ctx: ExecutionContext,
  requestUrl?: string,
): Context.Context<EnvServices | WorkerExecutionContext | CurrentOrg> =>
  envContext(env).pipe(
    Context.add(WorkerExecutionContext, ctx),
    Context.add(CurrentOrg, GLOBAL_ORG),
    Context.add(CurrentOutboundPolicy, outboundPolicyOf(env, requestUrl)),
  );

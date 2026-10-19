/**
 * The API Worker's bindings as its code reads them (#134 "How packages get their bindings"): every package reads only
 * its own view ({@link AuthConfig}, {@link StateEnv}, {@link ModelsEnv}, {@link BillingEnv}; `core` reads none), and the
 * request context provides each of them from the invocation's `env`, which satisfies every view (`ApiWorkerBindings`),
 * plus the port `@commissary/auth` reaches state through (`AuthDirectory`). The API Worker never sees sessions (ADR
 * 0030): it provides no `SignInSessions`.
 */
import { Context } from "effect";
import { type AuthBindings, AuthConfig, AuthDirectory } from "@commissary/auth";
import { type BillingBindings, BillingEnv } from "@commissary/billing/api";
import { type ModelsBindings, ModelsEnv } from "@commissary/models/api";
import { WorkerExecutionContext, CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { stateAuthDirectory, type StateBindings, StateEnv } from "@commissary/state";

/** What the API Worker's own code reads: where it answers, for its refusals (`http/hosts.ts`). */
export interface ApiBindings {
  /** The app host, named when another path is asked for (`http/hosts.ts`, ADR 0028). */
  readonly APP_DOMAIN?: string;
  /** The API host (`http/hosts.ts`, ADR 0028). */
  readonly API_DOMAIN?: string;
}

/** Every view of the API Worker's `env`; the global `Env` satisfies it. */
export type ApiWorkerBindings = AuthBindings &
  StateBindings &
  ModelsBindings &
  BillingBindings &
  ApiBindings;

/** The services {@link envContext} provides. */
export type EnvServices = AuthConfig | StateEnv | ModelsEnv | BillingEnv | AuthDirectory;

/** Each view of `env`, as its service, and the directory over the Durable Object stubs (`stateAuthDirectory`). */
export const envContext = (env: ApiWorkerBindings): Context.Context<EnvServices> =>
  Context.make(AuthConfig, env).pipe(
    Context.add(StateEnv, env),
    Context.add(ModelsEnv, env),
    Context.add(BillingEnv, env),
    Context.add(AuthDirectory, stateAuthDirectory(env)),
  );

/**
 * Builds the per-request context passed as the second argument of the web handler. A request belongs to `global` until
 * the client gate sets the org of its API key.
 */
export const requestContext = (
  env: ApiWorkerBindings,
  ctx: ExecutionContext,
): Context.Context<EnvServices | WorkerExecutionContext | CurrentOrg> =>
  envContext(env).pipe(
    Context.add(WorkerExecutionContext, ctx),
    Context.add(CurrentOrg, GLOBAL_ORG),
  );

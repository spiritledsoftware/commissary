/**
 * Which optional pieces this deployment has, as `GET /v9/management/me` reports them (`deployment` of `Me`, ADR 0043).
 * Workers addition, no Go counterpart.
 *
 * A piece is present exactly when its binding is, read from `env` at request time, never from a separate variable.
 * The checks below are where a piece's binding is wired in: the browser's (#212, bound unless
 * `COMMISSARY_BROWSER=off`) is; the computer's does not exist yet, so it is `false` until #223 wires it in here; the
 * Agents area's (#226) is its Dynamic Workers binding (`LOADER`), as `@commissary/agents` reads it.
 */
import { isHosted } from "@commissary/auth";
import { type AgentsBindings, agentsPresent } from "@commissary/agents/api";
import type { Deployment } from "@commissary/contract/orgs";
import type { AppBindings } from "../worker-env.ts";

/** Browser Run binding (#212): the app Worker is bound with it exactly when the state Worker, which runs the toolkit, is. */
export const hasBrowserBinding = (env: AppBindings): boolean => env.BROWSER !== undefined;

/** The sandbox's container binding (#223). */
export const hasComputerBinding = (_env: AppBindings): boolean => false;

export const deploymentOf = (
  mode: { readonly COMMISSARY_MODE?: string | undefined },
  env: AppBindings,
  agents: Pick<AgentsBindings, "LOADER">,
): Deployment => ({
  hosted: isHosted(mode),
  browser: hasBrowserBinding(env),
  computer: hasComputerBinding(env),
  agents: agentsPresent(agents),
});

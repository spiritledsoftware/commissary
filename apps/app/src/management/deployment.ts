/**
 * Which optional pieces this deployment has, as `GET /v9/management/me` reports them (`deployment` of `Me`, ADR 0043).
 * Workers addition, no Go counterpart.
 *
 * A piece is present exactly when its binding is, read from `env` at request time, never from a separate variable,
 * with one exception. The checks below are where a piece's binding is wired in: the browser's (#212, bound unless
 * `COMMISSARY_BROWSER=off`); the Agents area's (#226), its Dynamic Workers binding (`LOADER`), as `@commissary/agents`
 * reads it. The exception is the sandbox's computer (#223): its container is attached to the state Worker's
 * `SandboxSession` class and appears only as `ctx.container` inside those objects, with no binding in any Worker's
 * `env`; so the deploy binds the `COMPUTER` marker beside it, from the one setting that attaches it
 * (`@commissary/core`'s `COMPUTER_MARKER`), and this Worker reads that.
 */
import { isHosted } from "@commissary/auth";
import { hasComputer } from "@commissary/core";
import { type AgentsBindings, agentsPresent } from "@commissary/agents/api";
import type { Deployment } from "@commissary/contract/orgs";
import type { AppBindings } from "../worker-env.ts";

/** Browser Run binding (#212): the app Worker is bound with it exactly when the state Worker, which runs the toolkit, is. */
export const hasBrowserBinding = (env: AppBindings): boolean => env.BROWSER !== undefined;

/** The sandbox's computer (#223): the marker the deploy binds beside its container, which has no binding of its own. */
export const hasComputerBinding = (env: AppBindings): boolean => hasComputer(env);

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

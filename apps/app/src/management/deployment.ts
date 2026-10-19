/**
 * Which optional pieces this deployment has, as `GET /v9/management/me` reports them (`deployment` of `Me`, ADR 0043).
 * Workers addition, no Go counterpart.
 *
 * A piece is present exactly when its binding is, read from `env` at request time, never from a separate variable.
 * The two checks below are where a piece's binding is wired in: neither binding exists yet, so both are `false`.
 * The browser toolkit's issue (#212) replaces its body with `env.BROWSER !== undefined` (the Browser Run binding, added
 * to `AppBindings`), the sandbox's issue (#223) the computer's with its container binding's.
 */
import { isHosted } from "@commissary/auth";
import type { Deployment } from "@commissary/contract/orgs";
import type { AppBindings } from "../worker-env.ts";

/** Browser Run binding (#212). */
export const hasBrowserBinding = (_env: AppBindings): boolean => false;

/** The sandbox's container binding (#223). */
export const hasComputerBinding = (_env: AppBindings): boolean => false;

export const deploymentOf = (
  mode: { readonly COMMISSARY_MODE?: string | undefined },
  env: AppBindings,
): Deployment => ({
  hosted: isHosted(mode),
  browser: hasBrowserBinding(env),
  computer: hasComputerBinding(env),
});

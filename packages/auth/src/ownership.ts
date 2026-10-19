/**
 * Who owns something an area stores for the org and who may see or manage it (ADR 0023, ADR 0025): Models'
 * credentials, Tools' toolkits and their credentials. Shared by the areas, which must not import each other.
 *
 * A thing belongs to the org (shared: `owner` unset) or to one member (private: `owner` is that member's id).
 * Management gives the owner full control, lets an org admin see that a private one exists and disable or remove it,
 * and shows nobody else anything. A shared one is for org admins only. Who asks is a {@link Viewer}.
 */
import type { Viewer } from "./viewer.ts";

/**
 * The ControlPlane itself (a cron sweep, an internal caller, a migration): it reaches everything. Every method that
 * filters by ownership takes a {@link Scope}, so a caller states which of the two it is: leaving the viewer out is a type
 * error, never full access by default.
 */
export interface FullAccess {
  readonly system: true;
}

export const FULL_ACCESS: FullAccess = { system: true };

/** Who a management operation runs for: a viewer, or the system. */
export type Scope = Viewer | FullAccess;

export const isFullAccess = (scope: Scope): scope is FullAccess => "system" in scope;

/**
 * - `full`: every management operation;
 * - `limited`: an org admin on a private one: listed without details, may disable or remove it;
 * - `none`: it does not exist for this viewer.
 */
export type Access = "full" | "limited" | "none";

/** The viewer's access to something owned by `owner` (undefined: shared). */
export const accessTo = (owner: string | undefined, viewer: Scope): Access => {
  if (isFullAccess(viewer)) return "full";

  if (owner === undefined) return viewer.admin ? "full" : "none";

  if (viewer.member !== undefined && viewer.member === owner) return "full";

  return viewer.admin ? "limited" : "none";
};

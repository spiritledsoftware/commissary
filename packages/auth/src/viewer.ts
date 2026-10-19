/**
 * Who asks, as the area's ownership rules need it (ADR 0023): the member of the request and whether they are an org
 * admin, derived from the principal. Every management route that touches credentials hands the viewer to the
 * ControlPlane, which decides what the caller reaches (`ownership.ts`).
 */
import { Effect } from "effect";
import { type AccessIdentity, AccessPrincipal } from "./principal.ts";
import { roleAtLeast } from "./roles.ts";

/** Who asks: the member of the request (none for a service token) and whether they are an org admin. */
export interface Viewer {
  readonly member?: string | undefined;
  readonly admin: boolean;
}

export const viewerOf = (identity: AccessIdentity): Viewer => ({
  member: identity.memberId,
  admin: roleAtLeast(identity.role, "admin"),
});

/** The viewer of the current request. */
export const currentViewer: Effect.Effect<Viewer, never, AccessPrincipal> = Effect.gen(
  function* () {
    return viewerOf(yield* AccessPrincipal);
  },
);

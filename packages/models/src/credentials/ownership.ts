/**
 * Who owns a credential and who may see or manage it (ADR 0023, ADR 0025). The rules are `@commissary/auth`'s
 * (`ownership.ts`), which Tools shares; selection's rule is Models' own.
 *
 * A credential belongs to the org (a shared credential: `owner` unset) or to one member (a private credential:
 * `owner` is that member's id). Selection offers a private credential only to requests of its owner; management
 * gives the owner full control, lets an org admin see that it exists (provider, owner, label) and disable or remove
 * it, and shows nobody else anything. A shared credential is for org admins only, as before.
 */
export {
  type Access,
  accessTo,
  FULL_ACCESS,
  type FullAccess,
  isFullAccess,
  type Scope,
} from "@commissary/auth";

/** Whether a request of `member` may be served by a credential owned by `owner` (selection). */
export const servesMember = (
  credential: { readonly owner?: string | undefined },
  member: string | undefined,
): boolean => credential.owner === undefined || credential.owner === member;

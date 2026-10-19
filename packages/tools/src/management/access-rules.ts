/**
 * Tools' entries of the Worker's role table (ADR 0022, the permission matrix of `docs/ACCESS.md`; the app Worker's
 * `management/policy.ts` combines them with its own and Models'). Every toolkit route is for members: a plain member
 * reads the org's toolkits, adds and manages private toolkits and connects their own private credentials. The Tools
 * part decides the rest from the viewer (`control-plane-part.ts`): org toolkits, their shared credentials and their
 * overrides are for org admins.
 */
import type { AccessRule } from "@commissary/auth";

export const accessRules: ReadonlyArray<AccessRule> = [
  { path: "/v9/management/toolkits", subpaths: true, role: "member" },
];

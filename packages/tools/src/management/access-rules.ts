/**
 * Tools' entries of the Worker's role table (ADR 0022, the permission matrix of `docs/ACCESS.md`; the app Worker's
 * `management/policy.ts` combines them with its own and Models'). Every toolkit route is for members: a plain member
 * reads the org's toolkits, adds and manages private toolkits and connects their own private credentials. The Tools
 * part decides the rest from the viewer (`control-plane-part.ts`): org toolkits, their shared credentials and their
 * overrides are for org admins. The pending approvals of tool calls (#201) are for members too: the part shows each to
 * its eligible approvers and its caller only. So are the browser profiles (#215): a member manages their private ones,
 * an org admin the shared ones; the grants on shared profiles (`/grants/profiles`) keep the table's default, org admins.
 * The toolkit catalog (#207) is read and searched by members, who add toolkits from it, and so are its live lookups;
 * refreshing it, which is the deployment's, is for org admins (as the model catalog's refresh is).
 */
import type { AccessRule } from "@commissary/auth";

export const accessRules: ReadonlyArray<AccessRule> = [
  { path: "/v9/management/toolkits", subpaths: true, role: "member" },
  { path: "/v9/management/approvals", subpaths: true, role: "member" },
  { path: "/v9/management/browser-profiles", subpaths: true, role: "member" },
  // The Browser sessions page (#216): a member's own sessions, and for an org admin the org's (the part decides).
  { path: "/v9/management/browser-sessions", subpaths: true, role: "member" },
  // Before the catalog's member entry, which would cover it.
  { path: "/v9/management/toolkit-catalog/refresh", role: "admin" },
  { path: "/v9/management/toolkit-catalog", subpaths: true, role: "member" },
  // What the caller may use (#200): every member reads their own.
  { path: "/v9/management/tools", role: "member" },
];

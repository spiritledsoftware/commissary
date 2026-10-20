/**
 * Tools' entries of the Worker's role table (ADR 0022, the permission matrix of `docs/ACCESS.md`; the app Worker's
 * `management/policy.ts` combines them with its own and Models'). Every toolkit route is for members: a plain member
 * reads the org's toolkits, adds and manages private toolkits and connects their own private credentials. The Tools
 * part decides the rest from the viewer (`control-plane-part.ts`): org toolkits, their shared credentials and their
 * overrides are for org admins. The pending approvals of tool calls (#201) are for members too: the part shows each to
 * its eligible approvers and its caller only.
 */
import type { AccessRule } from "@commissary/auth";

export const accessRules: ReadonlyArray<AccessRule> = [
  { path: "/v9/management/toolkits", subpaths: true, role: "member" },
  { path: "/v9/management/approvals", subpaths: true, role: "member" },
  // What the caller may use (#200): every member reads their own.
  { path: "/v9/management/tools", role: "member" },
];

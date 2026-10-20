/**
 * Agents' entries of the Worker's role table (ADR 0022, the permission matrix of `docs/ACCESS.md`; the app Worker's
 * `management/policy.ts` combines them with its own and the other areas'). Every agent route is for members: a plain
 * member creates and manages their private agents and reads the agents they may use (`/agents/mine`). The Agents part
 * decides the rest from the viewer (`control-plane-part.ts`): shared agents, and disabling or removing another member's
 * private agent, are for org admins. The grants on shared agents (`/grants/agents`) are for org admins too, but their
 * routes check that themselves (`routes.ts`), after the area's absence: without `LOADER` every Agents route answers
 * 404, a plain member's request included.
 */
import type { AccessRule } from "@commissary/auth";

export const accessRules: ReadonlyArray<AccessRule> = [
  { path: "/v9/management/agents", subpaths: true, role: "member" },
  { path: "/v9/management/grants/agents", subpaths: true, role: "member" },
  // Agent runs (#227): a member starts runs of the agents they may use, and sees the runs they started.
  { path: "/v9/management/agent-runs", subpaths: true, role: "member" },
];

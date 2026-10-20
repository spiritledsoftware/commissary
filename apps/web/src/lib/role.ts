// What the caller's role in the org lets the panel show (ADR 0022). The server enforces every rule again; these
// functions keep the panel from offering a control that would be refused. Pure: no DOM, tested in
// test/role.test.ts.
//
// Roles: org owner > org admin > member. A plain member may only read their own usage, manage their own API keys
// and, where the org lets members connect private credentials (ADR 0023), manage their own private accounts and API
// keys; org admins manage the org's configuration, plain members and teams, and see every API key; org owners also
// change roles, add org admins and org owners, and decide who may join by themselves. A platform admin is an org owner
// of every org.
import type { Me } from "@commissary/contract/orgs";
import type { OrgRole } from "@commissary/contract/members";

export type { OrgRole };

/** Roles from least to most powerful. */
export const ROLES: ReadonlyArray<OrgRole> = ["member", "admin", "owner"];

/** The role a picker's value names, if it names one. */
export const roleOf = (value: string): OrgRole | undefined => ROLES.find((role) => role === value);

const RANK: Readonly<Record<OrgRole, number>> = { member: 0, admin: 1, owner: 2 };

/** Whether `role` includes the rights of `minimum`. */
export const atLeast = (role: OrgRole, minimum: OrgRole): boolean => RANK[role] >= RANK[minimum];

const LABELS: Readonly<Record<OrgRole, string>> = {
  owner: "Org owner",
  admin: "Org admin",
  member: "Member",
};

export const roleLabel = (role: OrgRole): string => LABELS[role];

/** A role in a sentence: "an org owner", "an org admin", "a member". */
export const roleAs = (role: OrgRole): string =>
  role === "member" ? "a member" : `an ${roleLabel(role).toLowerCase()}`;

/** What a role may do, in a sentence (hints under role pickers). */
export const roleSummary = (role: OrgRole): string => {
  switch (role) {
    case "owner":
      return "Everything an org admin can do, plus changing roles and who may join.";
    case "admin":
      return "Manages accounts, keys, models, settings, plain members and teams.";
    case "member":
      return "Sees their own usage and limits, and manages their own API keys.";
  }
};

/**
 * The caller's role in the org the panel shows, from the org-scoped `GET /me`. A platform admin is an org owner of every
 * org; someone with no role in the org is treated as a plain member (the least they could be).
 */
export const effectiveRole = (me: Pick<Me, "role" | "platform_admin">): OrgRole =>
  me.role ?? (me.platform_admin ? "owner" : "member");

// ---------------------------------------------------------------------------------------------------------------
// Pages

/**
 * The sidebar's groups, in order: the pages everyone glances at (no heading), the org's providers, who may use them
 * and how, and the org itself.
 */
export const PAGE_GROUPS = [
  { id: "glance", heading: undefined },
  { id: "providers", heading: "Providers" },
  { id: "people", heading: "People and access" },
  { id: "org", heading: "Org" },
] as const;

export type PageGroupId = (typeof PAGE_GROUPS)[number]["id"];

export interface PanelPage {
  readonly to: string;
  readonly label: string;
  /** The sidebar group the page's link sits in. */
  readonly group: PageGroupId;
  /** The least role that opens the page. */
  readonly role: OrgRole;
  /** A plain member opens it too where the org lets members connect private credentials (their own rows only). */
  readonly privateMembers?: boolean;
  /** The link is active on this exact path only: another page of the nav lives below it (`/settings/sso`). */
  readonly exact?: boolean;
  /** The page exists on Commissary Cloud only (ADR 0026). */
  readonly hosted?: boolean;
}

/** The pages of the shell's sidebar, in order, group by group. A plain member's panel is the Usage page. */
export const PAGES: ReadonlyArray<PanelPage> = [
  { to: "/", label: "Overview", group: "glance", role: "admin" },
  { to: "/usage", label: "Usage", group: "glance", role: "member" },
  { to: "/accounts", label: "Accounts", group: "providers", role: "admin", privateMembers: true },
  { to: "/keys", label: "Provider keys", group: "providers", role: "admin", privateMembers: true },
  { to: "/models", label: "Models", group: "providers", role: "admin" },
  { to: "/members", label: "Members", group: "people", role: "admin" },
  { to: "/grants", label: "Grants", group: "people", role: "admin" },
  { to: "/my-models", label: "My models", group: "people", role: "member" },
  { to: "/api-keys", label: "API keys", group: "people", role: "member" },
  { to: "/management-keys", label: "Management keys", group: "people", role: "admin" },
  { to: "/limits", label: "Limits", group: "people", role: "member" },
  { to: "/approvals", label: "Approvals", group: "people", role: "member" },
  { to: "/settings", label: "Settings", group: "org", role: "admin", exact: true },
  // Under Settings: the Worker serves the panel at `/settings/*` already (`PANEL_SECTIONS`).
  {
    to: "/settings/sso",
    label: "Single sign-on",
    group: "org",
    role: "admin",
    hosted: true,
  },
];

/**
 * The nav links a role sees; `privateCredentials`: the org lets members connect private credentials; `hosted`: the
 * deployment is Commissary Cloud, which has the pages that exist there only.
 */
export const pagesFor = (
  role: OrgRole,
  privateCredentials = false,
  hosted = false,
): ReadonlyArray<PanelPage> =>
  PAGES.filter(
    (page) =>
      (hosted || page.hosted !== true) &&
      (atLeast(role, page.role) || (privateCredentials && page.privateMembers === true)),
  );

export interface PageGroup {
  readonly id: PageGroupId;
  /** The small heading above the group's links; none for the first group. */
  readonly heading: string | undefined;
  readonly pages: ReadonlyArray<PanelPage>;
}

/** The links of {@link pagesFor} as the sidebar groups them, without the groups the role has no page in. */
export const pageGroupsFor = (
  role: OrgRole,
  privateCredentials = false,
  hosted = false,
): ReadonlyArray<PageGroup> => {
  const pages = pagesFor(role, privateCredentials, hosted);

  return PAGE_GROUPS.flatMap(({ id, heading }) => {
    const grouped = pages.filter((page) => page.group === id);

    return grouped.length === 0 ? [] : [{ id, heading, pages: grouped }];
  });
};

/** The page a role lands on when the one asked for is not theirs: the Overview for org admins, Usage for the rest. */
export const homeFor = (role: OrgRole): string => (atLeast(role, "admin") ? "/" : "/usage");

const trimmed = (pathname: string): string =>
  pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

const within = (pathname: string, page: string): boolean =>
  trimmed(pathname) === page || pathname.startsWith(`${page}/`);

/**
 * Whether a role may open a page of the panel (`pathname` is relative to the org's base path). Sub-pages of a page
 * need an org admin, like `/usage/prices`, except the page itself. A plain member opens Usage, My models, API keys and Limits, the
 * Approvals page with each approval's page (#201: the server shows each to its approvers and its caller only), and the
 * pages of their own private accounts and provider keys, with their sub-pages, where the org lets members connect private
 * credentials.
 */
export const pageAllowed = (role: OrgRole, pathname: string, privateCredentials = false): boolean =>
  atLeast(role, "admin") ||
  within(pathname, "/approvals") ||
  trimmed(pathname) === "/usage" ||
  trimmed(pathname) === "/my-models" ||
  trimmed(pathname) === "/api-keys" ||
  trimmed(pathname) === "/limits" ||
  (privateCredentials && (within(pathname, "/accounts") || within(pathname, "/keys")));

// ---------------------------------------------------------------------------------------------------------------
// Members and teams

/** Who the caller is when they act: their role in the org and whether they are a platform admin. */
export interface Caller {
  readonly role: OrgRole;
  readonly platformAdmin: boolean;
  /** The org lets members connect private credentials (ADR 0023). */
  readonly privateCredentials: boolean;
}

export const callerOf = (
  me: Pick<Me, "role" | "platform_admin"> & { readonly private_credentials?: boolean | undefined },
): Caller => ({
  role: effectiveRole(me),
  platformAdmin: me.platform_admin,
  privateCredentials: me.private_credentials === true,
});

/** Whether the caller connects their own private credentials: a plain member (where allowed) holds nothing else. */
export const holdsOnlyPrivate = (caller: Caller): boolean => !atLeast(caller.role, "admin");

/** Org admins manage plain members and teams; org owners everyone. */
export const canManageMembers = (caller: Caller): boolean => atLeast(caller.role, "admin");

/** The roles the caller may give a person they add: org admins add plain members, org owners any role. */
export const addableRoles = (caller: Caller): ReadonlyArray<OrgRole> =>
  ROLES.filter((role) => atLeast(caller.role, role === "member" ? "admin" : "owner"));

/** Changing a member's role (or a token's) is for org owners. */
export const canChangeRoles = (caller: Caller): boolean => atLeast(caller.role, "owner");

/** Removing a plain member is for org admins; removing an org admin or an org owner for org owners. */
export const canRemove = (caller: Caller, target: OrgRole): boolean =>
  atLeast(caller.role, target === "member" ? "admin" : "owner");

/** Whether people Access admits may join by themselves is decided by org owners. */
export const canSetAutoJoin = (caller: Caller): boolean => atLeast(caller.role, "owner");

/** Whether the client API still accepts an Access sign-in instead of an API key is decided by org owners too. */
export const canSetAccessClients = canSetAutoJoin;

/** Org admins list and revoke every API key of the org; every member their own. */
export const seesEveryApiKey = (caller: Caller): boolean => atLeast(caller.role, "admin");

/** Org admins set any Spend limit and the calendar; a plain member limits their own API keys. */
export const setsAnyLimit = (caller: Caller): boolean => atLeast(caller.role, "admin");

export const canManageTeams = (caller: Caller): boolean => atLeast(caller.role, "admin");

/**
 * The roles the caller may register a service token with. A role above member needs a service token that is an org
 * org owner or a platform admin: a person who is only an org owner, however powerful, registers member tokens. A platform
 * admin may register any role.
 */
export const tokenRoles = (caller: Caller): ReadonlyArray<OrgRole> => {
  if (!atLeast(caller.role, "admin")) return [];

  return caller.platformAdmin ? ROLES : ["member"];
};

/**
 * The roles the caller may change a registered token to: org owners only, and to what `tokenRoles` offers (an org owner who
 * is no platform admin may only demote a token to member).
 */
export const tokenRoleChanges = (caller: Caller, current: OrgRole): ReadonlyArray<OrgRole> =>
  canChangeRoles(caller) ? tokenRoles(caller).filter((role) => role !== current) : [];

/** Removing a token takes its rights away: org admins remove plain member tokens, org owners any. */
export const canRemoveToken = canRemove;

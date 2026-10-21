import { describe, expect, it } from "vitest";
import {
  addableRoles,
  callerOf,
  canChangeRoles,
  canManageMembers,
  canRemove,
  canSetAutoJoin,
  effectiveRole,
  holdsOnlyPrivate,
  homeFor,
  pageAllowed,
  pageGroupsFor,
  pagesFor,
  roleOf,
  tokenRoleChanges,
  tokenRoles,
} from "../src/lib/role.ts";

const caller = (role: "owner" | "admin" | "member", platformAdmin = false) =>
  callerOf({ role, platform_admin: platformAdmin });

describe("the caller's role", () => {
  it("is the role in the org, an owner for a platform admin without one, a member otherwise", () => {
    expect(effectiveRole({ role: "admin", platform_admin: false })).toBe("admin");
    expect(effectiveRole({ role: null, platform_admin: true })).toBe("owner");
    expect(effectiveRole({ role: null, platform_admin: false })).toBe("member");
  });

  it("reads a picker's value as a role, or not at all", () => {
    expect(roleOf("admin")).toBe("admin");
    expect(roleOf("root")).toBeUndefined();
  });
});

describe("the Agents section (#233)", () => {
  it("is in the nav of every role only where the deployment has the Agents area", () => {
    for (const role of ["member", "admin", "owner"] as const) {
      expect(pagesFor(role).map((page) => page.to)).not.toContain("/agents");
      expect(
        pagesFor(role, { privateCredentials: false, hosted: false, agents: true }).map(
          (page) => page.to,
        ),
      ).toContain("/agents");
    }

    const groups = pageGroupsFor("member", {
      privateCredentials: false,
      hosted: false,
      agents: true,
    });

    expect(groups.find((group) => group.id === "providers")?.pages.map((page) => page.to)).toEqual([
      "/tools",
      "/agents",
    ]);
  });

  it("opens the agent pages to a plain member, whose private agents they are", () => {
    expect(pageAllowed("member", "/agents")).toBe(true);
    expect(pageAllowed("member", "/agents/new")).toBe(true);
    expect(pageAllowed("member", "/agents/ag_123")).toBe(true);
    expect(pageAllowed("member", "/agentsmith")).toBe(false);
  });
});

describe("pages", () => {
  it("opens only Usage, Tools, My models, My tools, API keys, Limits and Approvals to a plain member and everything to an admin", () => {
    expect(pagesFor("member").map((page) => page.to)).toEqual([
      "/usage",
      "/tools",
      "/my-models",
      "/my-tools",
      "/api-keys",
      "/limits",
      "/approvals",
    ]);
    expect(pagesFor("admin").map((page) => page.to)).toContain("/api-keys");
    expect(pagesFor("admin").map((page) => page.to)).toContain("/members");
    expect(pagesFor("admin").map((page) => page.to)).toContain("/grants");
    expect(homeFor("member")).toBe("/usage");
    expect(homeFor("admin")).toBe("/");
    expect(pageAllowed("member", "/usage")).toBe(true);
    expect(pageAllowed("member", "/usage/")).toBe(true);
    expect(pageAllowed("member", "/my-models")).toBe(true);
    // The tools a member reaches and why (#209) are theirs to read; granting them (Grants) is not.
    expect(pageAllowed("member", "/my-tools")).toBe(true);
    expect(pageAllowed("member", "/my-toolsx")).toBe(false);
    expect(pageAllowed("member", "/grants")).toBe(false);
    expect(pageAllowed("member", "/api-keys")).toBe(true);
    expect(pageAllowed("member", "/api-keys/")).toBe(true);
    expect(pageAllowed("member", "/limits")).toBe(true);
    // An approval's page too (#201): the link a pending tool call answers.
    expect(pageAllowed("member", "/approvals")).toBe(true);
    expect(pageAllowed("member", "/approvals/ap_123")).toBe(true);
    expect(pageAllowed("member", "/approvalsx")).toBe(false);
    // Tools with its pages (#208): every member sees the toolkits they reach, adds private ones, connects their own
    // credentials (the connect link a tool call answers) and builds an endpoint URL; the server shows each only theirs.
    expect(pageAllowed("member", "/tools")).toBe(true);
    expect(pageAllowed("member", "/tools/add")).toBe(true);
    expect(pageAllowed("member", "/tools/endpoint")).toBe(true);
    expect(pageAllowed("member", "/tools/tk_1")).toBe(true);
    expect(pageAllowed("member", "/tools/tk_1/connect")).toBe(true);
    expect(pageAllowed("member", "/toolsx")).toBe(false);
    // Billing is the org admins' (ADR 0042): a plain member has no billing page, on Commissary Cloud either.
    expect(pageAllowed("member", "/billing")).toBe(false);
    expect(
      pagesFor("member", { privateCredentials: true, hosted: true }).map((page) => page.to),
    ).not.toContain("/billing");
    expect(pageAllowed("admin", "/billing")).toBe(true);
    expect(pageAllowed("member", "/usage/prices")).toBe(false);
    expect(pageAllowed("member", "/members")).toBe(false);
    expect(pageAllowed("admin", "/usage/prices")).toBe(true);
  });
});

describe("the sidebar's groups of pages", () => {
  const outline = (groups: ReturnType<typeof pageGroupsFor>) =>
    groups.map((group) => [group.heading ?? "", group.pages.map((page) => page.label)]);

  it("shows an org admin every page, grouped under headings, with Overview and Usage first", () => {
    expect(outline(pageGroupsFor("admin"))).toEqual([
      ["", ["Overview", "Usage"]],
      ["Providers", ["Accounts", "Provider keys", "Models", "Tools"]],
      [
        "People and access",
        [
          "Members",
          "Grants",
          "My models",
          "My tools",
          "API keys",
          "Management keys",
          "Limits",
          "Approvals",
        ],
      ],
      ["Org", ["Settings"]],
    ]);
    expect(outline(pageGroupsFor("owner"))).toEqual(outline(pageGroupsFor("admin")));
  });

  it("puts Single sign-on and Billing beside Settings on Commissary Cloud only", () => {
    expect(
      outline(pageGroupsFor("admin", { privateCredentials: false, hosted: true })).at(-1),
    ).toEqual(["Org", ["Settings", "Single sign-on", "Billing"]]);
    expect(
      outline(pageGroupsFor("owner", { privateCredentials: false, hosted: true })).at(-1),
    ).toEqual(["Org", ["Settings", "Single sign-on", "Billing"]]);
    expect(
      outline(pageGroupsFor("admin", { privateCredentials: false, hosted: false })).at(-1),
    ).toEqual(["Org", ["Settings"]]);
    expect(
      outline(pageGroupsFor("member", { privateCredentials: true, hosted: true })).map(
        ([heading]) => heading,
      ),
    ).toEqual(["", "Providers", "People and access"]);
  });

  it("leaves out the groups a plain member has no page in", () => {
    expect(outline(pageGroupsFor("member"))).toEqual([
      ["", ["Usage"]],
      ["Providers", ["Tools"]],
      ["People and access", ["My models", "My tools", "API keys", "Limits", "Approvals"]],
    ]);
    expect(outline(pageGroupsFor("member", { privateCredentials: true }))).toEqual([
      ["", ["Usage"]],
      ["Providers", ["Accounts", "Provider keys", "Tools"]],
      ["People and access", ["My models", "My tools", "API keys", "Limits", "Approvals"]],
    ]);
  });

  it("holds exactly the pages the role opens, each once", () => {
    for (const [role, privateCredentials, hosted] of [
      ["member", false, false],
      ["member", true, true],
      ["admin", false, true],
      ["owner", true, false],
    ] as const) {
      const grouped = pageGroupsFor(role, { privateCredentials, hosted }).flatMap(
        (group) => group.pages,
      );

      expect(grouped.map((page) => page.to).toSorted()).toEqual(
        pagesFor(role, { privateCredentials, hosted })
          .map((page) => page.to)
          .toSorted(),
      );
    }
  });
});

describe("private credentials in the panel (ADR 0023)", () => {
  it("opens a plain member their own accounts and provider keys only where the org allows private credentials", () => {
    expect(pagesFor("member", { privateCredentials: true }).map((page) => page.to)).toEqual([
      "/usage",
      "/accounts",
      "/keys",
      "/tools",
      "/my-models",
      "/my-tools",
      "/api-keys",
      "/limits",
      "/approvals",
    ]);
    expect(pagesFor("member", { privateCredentials: false }).map((page) => page.to)).toEqual([
      "/usage",
      "/tools",
      "/my-models",
      "/my-tools",
      "/api-keys",
      "/limits",
      "/approvals",
    ]);
    expect(pageAllowed("member", "/accounts", true)).toBe(true);
    expect(pageAllowed("member", "/accounts/connect", true)).toBe(true);
    expect(pageAllowed("member", "/keys/new", true)).toBe(true);
    expect(pageAllowed("member", "/accounts", false)).toBe(false);
    expect(pageAllowed("member", "/accountsabc", true)).toBe(false);
    expect(pageAllowed("member", "/models", true)).toBe(false);
    expect(pageAllowed("member", "/settings", true)).toBe(false);
    // A plain member still lands on Usage.
    expect(homeFor("member")).toBe("/usage");
  });

  it("reads the org's setting from /me, off when it is absent", () => {
    expect(callerOf({ role: "member", platform_admin: false }).privateCredentials).toBe(false);
    expect(
      callerOf({ role: "member", platform_admin: false, private_credentials: true })
        .privateCredentials,
    ).toBe(true);
    expect(holdsOnlyPrivate(caller("member"))).toBe(true);
    expect(holdsOnlyPrivate(caller("admin"))).toBe(false);
  });
});

describe("what each role may do with members", () => {
  it("lets admins add and remove plain members and owners do the rest", () => {
    expect(canManageMembers(caller("member"))).toBe(false);
    expect(addableRoles(caller("admin"))).toEqual(["member"]);
    expect(addableRoles(caller("owner"))).toEqual(["member", "admin", "owner"]);
    expect(canRemove(caller("admin"), "member")).toBe(true);
    expect(canRemove(caller("admin"), "admin")).toBe(false);
    expect(canRemove(caller("owner"), "owner")).toBe(true);
    expect(canChangeRoles(caller("admin"))).toBe(false);
    expect(canSetAutoJoin(caller("owner"))).toBe(true);
    expect(canSetAutoJoin(caller("admin"))).toBe(false);
  });

  it("keeps service tokens above member for platform admins", () => {
    expect(tokenRoles(caller("member"))).toEqual([]);
    expect(tokenRoles(caller("owner"))).toEqual(["member"]);
    expect(tokenRoles(caller("owner", true))).toEqual(["member", "admin", "owner"]);
    expect(tokenRoleChanges(caller("owner"), "admin")).toEqual(["member"]);
    expect(tokenRoleChanges(caller("admin"), "member")).toEqual([]);
  });
});

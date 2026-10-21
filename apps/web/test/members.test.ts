import { describe, expect, it } from "vitest";
import type { MemberView, ServiceTokenView, TeamView } from "@commissary/contract/members";
import {
  clientIdProblem,
  emailProblem,
  memberProblem,
  membersOfTeam,
  normalizeEmail,
  PRIVATE_SWITCH_ORDER,
  PRIVATE_SWITCHES,
  privateSettingPatch,
  privateSwitchesFor,
  roleCounts,
  sortMembers,
  sortTeams,
  sortTokens,
  TEAM_NAME_MAX,
  teamNameProblem,
  teamsOfMember,
  teamsToJoin,
  tokenName,
} from "../src/lib/members.ts";

const member = (id: string, email: string, role: MemberView["role"], teams: string[] = []) => ({
  id,
  email,
  role,
  added_at: "2026-10-11T00:00:00Z",
  teams,
});

const team = (id: string, name: string, members: string[] = []): TeamView => ({
  id,
  name,
  created_at: "2026-10-11T00:00:00Z",
  members,
});

const token = (client_id: string, name: string, role: ServiceTokenView["role"]) => ({
  client_id,
  name,
  role,
  added_at: "2026-10-11T00:00:00Z",
});

describe("memberProblem", () => {
  it("explains the server's codes and falls back to its own words", () => {
    expect(memberProblem("last_owner", "x")).toMatch(/at least one owner/);
    expect(memberProblem("member_exists", "x")).toMatch(/already a member/);
    expect(memberProblem("something_new", "fallback")).toBe("fallback");
    expect(memberProblem(undefined, "fallback", "the reason")).toBe("The reason.");
  });
});

describe("emailProblem", () => {
  it("accepts what the server accepts", () => {
    expect(emailProblem("ian@example.com")).toBeUndefined();
    expect(emailProblem("  Ian@Example.COM ")).toBeUndefined();
    // No dot is needed after the @: the server takes it.
    expect(emailProblem("ian@localhost")).toBeUndefined();
    expect(emailProblem(`${"a".repeat(240)}@example.com`)).toBeUndefined();
  });

  it("refuses what the server refuses", () => {
    expect(emailProblem("")).toBe("Enter an email address.");
    expect(emailProblem("ian")).toMatch(/not an email address/);
    expect(emailProblem("a b@example.com")).toMatch(/not an email address/);
    expect(emailProblem("a@b@c")).toMatch(/not an email address/);
    expect(emailProblem("a,b@example.com")).toMatch(/not an email address/);
    expect(emailProblem('"a"@example.com')).toMatch(/not an email address/);
    expect(emailProblem(`${"a".repeat(250)}@example.com`)).toMatch(/not an email address/);
  });

  it("stores an email trimmed and lower-case", () => {
    expect(normalizeEmail("  Ian@Example.COM ")).toBe("ian@example.com");
  });
});

describe("teamNameProblem", () => {
  it("counts code points, so an emoji is one character", () => {
    expect(teamNameProblem("😀".repeat(TEAM_NAME_MAX), [])).toBeUndefined();
    expect(teamNameProblem("😀".repeat(TEAM_NAME_MAX + 1), [])).toMatch(/up to 100/);
    expect(teamNameProblem("a".repeat(TEAM_NAME_MAX), [])).toBeUndefined();
  });

  it("refuses an empty name, control characters and a name another team has", () => {
    expect(teamNameProblem("  ", [])).toBe("Enter a name.");
    expect(teamNameProblem("a\u0007b", [])).toMatch(/control/);
    expect(teamNameProblem(" Platform ", ["platform"])).toMatch(/exists already/);
    expect(teamNameProblem("Infra", ["platform"])).toBeUndefined();
  });
});

describe("clientIdProblem", () => {
  it("needs an id without spaces", () => {
    expect(clientIdProblem("")).toBe("Enter the token's Client ID.");
    expect(clientIdProblem("a b")).toBe("A client id has no spaces.");
    expect(clientIdProblem(" abc123.access ")).toBeUndefined();
  });
});

describe("ordering and joins", () => {
  const ian = member("m1", "ian@example.com", "owner", ["t1"]);
  const ann = member("m2", "ann@example.com", "member");
  const zed = member("m3", "zed@example.com", "admin", ["t1", "t2"]);
  const ops = team("t1", "Ops", ["m1", "m3"]);
  const dev = team("t2", "Dev", ["m3"]);

  it("lists owners first, then admins, then members, each by email", () => {
    expect(sortMembers([ann, zed, ian]).map((m) => m.id)).toEqual(["m1", "m3", "m2"]);
    expect(sortTeams([ops, dev]).map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(
      sortTokens([
        token("b", "", "member"),
        token("a", "Zed", "admin"),
        token("c", "Amy", "owner"),
      ]).map((t) => t.client_id),
    ).toEqual(["c", "a", "b"]);
  });

  it("reads teams and members by the ids each lists", () => {
    expect(teamsOfMember(zed, [ops, dev]).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(teamsToJoin(ian, [ops, dev]).map((t) => t.id)).toEqual(["t2"]);
    expect(membersOfTeam(ops, [ian, ann, zed]).map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(teamsOfMember(ann, [])).toEqual([]);
  });

  it("names a token and counts the roles", () => {
    expect(tokenName(token("x.access", "", "member"))).toBe("x.access");
    expect(tokenName(token("x.access", "CI", "member"))).toBe("CI");
    expect(roleCounts([ian, ann, zed, member("m4", "d@example.com", "member")])).toBe(
      "1 org owner, 1 org admin, 2 members",
    );
    expect(roleCounts([])).toBe("No members");
  });
});

describe("what members may keep privately (#209, ADR 0023, ADR 0038)", () => {
  it("has a switch for private credentials and, beside it, private toolkits and private agents", () => {
    expect(PRIVATE_SWITCH_ORDER).toEqual([
      "private_credentials",
      "private_toolkits",
      "private_agents",
    ]);

    expect(PRIVATE_SWITCHES.private_agents.title).toBe("Private agents");
    expect(PRIVATE_SWITCHES.private_agents.label).toBe("Let members create private agents");
    expect(PRIVATE_SWITCHES.private_toolkits.title).toBe("Private toolkits");
    expect(PRIVATE_SWITCHES.private_toolkits.label).toBe("Let members add private toolkits");
    expect(PRIVATE_SWITCHES.private_credentials.title).toBe("Private credentials");
  });

  it("lists the private agents switch only where the deployment has the Agents area", () => {
    expect(privateSwitchesFor(true)).toEqual(PRIVATE_SWITCH_ORDER);
    expect(privateSwitchesFor(false)).toEqual(["private_credentials", "private_toolkits"]);
  });

  it("writes a partial patch that changes the one setting and nothing else", () => {
    expect(privateSettingPatch("private_toolkits", true)).toEqual({ private_toolkits: true });
    expect(privateSettingPatch("private_toolkits", false)).toEqual({ private_toolkits: false });
    expect(privateSettingPatch("private_credentials", true)).toEqual({ private_credentials: true });
  });

  it("says what each state means: off keeps what members added, and the two settings are separate", () => {
    const toolkits = PRIVATE_SWITCHES.private_toolkits;

    expect(toolkits.describe(true)).toContain("approval rules");
    expect(toolkits.describe(true)).toContain("cannot price");
    expect(toolkits.describe(false)).toContain("stay in place but are not served");
    expect(toolkits.describe(false)).toContain("separate from private credentials");
    expect(toolkits.said(false)).toBe("Private toolkits are switched off, not deleted.");
    expect(toolkits.said(true)).toBe("Members can add private toolkits now.");
    expect(PRIVATE_SWITCHES.private_credentials.said(false)).toContain("not deleted");
  });
});

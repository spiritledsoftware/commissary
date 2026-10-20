import { describe, expect, it } from "vitest";
import type { ApprovalView } from "@commissary/contract/approvals";
import {
  approvalRulesWarnings,
  approverLabel,
  argumentsText,
  callerText,
  cannotDecideText,
  groupByApprover,
  nobodyDecidesText,
  statusText,
  timeLeftText,
} from "../src/lib/approvals.ts";

const approval = (id: string, extra: Partial<ApprovalView> = {}): ApprovalView => ({
  id,
  status: "pending",
  toolkit: { id: "tk_1", name: "github" },
  tool: { id: "tk_1:create_issue", name: "github_create_issue" },
  caller: { member_id: "m-alice", email: "alice@example.com", principal: "user:alice@example.com" },
  credential: "shared",
  approver: { kind: "team", id: "team-ops", name: "ops" },
  created_at: "2026-10-11T10:00:00.000Z",
  expires_at: "2026-10-11T11:00:00.000Z",
  can_decide: true,
  ...extra,
});

describe("approver sets", () => {
  it("are labelled by who decides", () => {
    expect(approverLabel({ kind: "caller" })).toBe("Each call's caller");
    expect(approverLabel({ kind: "team", id: "team-ops", name: "ops" })).toBe("Team ops");
    expect(approverLabel({ kind: "team", id: "team-gone" })).toBe("A deleted team (team-gone)");
    expect(
      approverLabel({
        kind: "members",
        members: [{ id: "m-bob", email: "bob@example.com" }, { id: "m-left" }],
      }),
    ).toBe("bob@example.com, m-left");
    expect(approverLabel({ kind: "members", members: [] })).toContain("Nobody");
  });

  it("group the pending list, one group per set whatever order its members are listed in", () => {
    const listA = {
      kind: "members" as const,
      members: [{ id: "m1" }, { id: "m2" }],
    };

    const listB = {
      kind: "members" as const,
      members: [{ id: "m2" }, { id: "m1" }],
    };

    const groups = groupByApprover([
      approval("a"),
      approval("b", { approver: listA }),
      approval("c", { approver: { kind: "caller" } }),
      approval("d"),
      approval("e", { approver: listB }),
    ]);

    expect(groups.map((group) => [group.label, group.approvals.map((one) => one.id)])).toEqual([
      ["Team ops", ["a", "d"]],
      ["m1, m2", ["b", "e"]],
      ["Each call's caller", ["c"]],
    ]);
  });
});

describe("an approval", () => {
  it("names its caller by email, member id or principal", () => {
    expect(callerText(approval("a"))).toBe("alice@example.com");
    expect(callerText(approval("a", { caller: { member_id: "m1", principal: "user:x" } }))).toBe(
      "m1",
    );
    expect(callerText(approval("a", { caller: { principal: "service:abc.access" } }))).toBe(
      "service:abc.access",
    );
  });

  it("says how long it has left, and when its hour is over", () => {
    const now = Date.parse("2026-10-11T10:08:00.000Z");

    expect(timeLeftText(approval("a"), now)).toBe("52 min left");
    expect(timeLeftText(approval("a"), Date.parse("2026-10-11T11:00:00.000Z"))).toBe("Expired");
  });

  it("says where it stands, shows arguments as indented JSON, and why its caller cannot decide it", () => {
    expect(statusText({ status: "used" })).toContain("went through");
    expect(argumentsText({ title: "x" })).toBe('{\n  "title": "x"\n}');
    expect(cannotDecideText(approval("a", { can_decide: false }))).toContain("another");
    expect(cannotDecideText(approval("a"))).toBeUndefined();
    expect(cannotDecideText(approval("a", { can_decide: false, status: "denied" }))).toBe(
      undefined,
    );
  });
});

describe("an approver nobody can be", () => {
  it("is warned of on a pending approval: a deleted team, a list whose members all left", () => {
    expect(nobodyDecidesText(approval("a"))).toBeUndefined();
    expect(nobodyDecidesText(approval("a", { approver: { kind: "caller" } }))).toBeUndefined();
    expect(
      nobodyDecidesText(approval("a", { approver: { kind: "team", id: "team-gone" } })),
    ).toContain("team no longer exists");
    expect(
      nobodyDecidesText(approval("a", { approver: { kind: "members", members: [{ id: "m1" }] } })),
    ).toContain("has left");
    expect(
      nobodyDecidesText(
        approval("a", { status: "denied", approver: { kind: "team", id: "team-gone" } }),
      ),
    ).toBeUndefined();
  });

  it("is warned of for each rule the toolkit's view flags", () => {
    expect(
      approvalRulesWarnings({
        writes: { approver: { kind: "team", id: "team-gone" }, nobody_decides: true },
        tools: [
          { id: "tk_1:delete_repo", approver: { kind: "members", ids: [] }, nobody_decides: true },
          { id: "tk_1:list_issues", approver: { kind: "caller" } },
        ],
      }),
    ).toEqual([
      expect.stringMatching(/^The write tools' rule waits for a team that no longer exists/),
      expect.stringMatching(
        /^The rule on delete_repo waits for a list of members who have all left/,
      ),
    ]);
    expect(approvalRulesWarnings({ writes: { approver: { kind: "caller" } } })).toEqual([]);
  });
});

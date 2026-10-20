// Approval rules (#201, ADR 0038): which calls wait for approval, who may decide them, and the hash a repeated call is
// matched by. The toolkit-wide write rule follows each tool's class, a mark on one tool wins over it, and a caller never
// approves their own call under a team or list rule, even as a member of that set.
import { describe, expect, it } from "vitest";
import type { ApprovalRules } from "@commissary/contract/approvals";
import { argumentsHash, canonicalJson } from "../../src/approvals/hash.ts";
import {
  approvalRulesView,
  approverFor,
  cleanApprovalRules,
  mayDecide,
  rulesWithoutMember,
  type StoredApprovalRules,
} from "../../src/approvals/rules.ts";

const TEAM = { kind: "team", id: "team-ops" } as const;

const rules = (value: ApprovalRules): StoredApprovalRules => {
  const cleaned = cleanApprovalRules("tk_github", value);

  if ("refused" in cleaned) throw new Error(cleaned.refused);

  return cleaned;
};

describe("which calls wait", () => {
  it("under the write rule: write tools wait for its approver, read tools pass", () => {
    const writes = rules({ writes: {} });

    expect(approverFor(writes, "create_issue", "write")).toEqual({ kind: "caller" });
    expect(approverFor(writes, "list_issues", "read")).toBeUndefined();
  });

  it("follows the tool's class, so reclassifying a tool changes whether it waits", () => {
    const writes = rules({ writes: { approver: TEAM } });

    // The same tool, classed read by an override, then write again.
    expect(approverFor(writes, "list_issues", "read")).toBeUndefined();
    expect(approverFor(writes, "list_issues", "write")).toEqual(TEAM);
  });

  it("under marks: the marked tools wait, whatever their class, and a mark's approver wins over the write rule's", () => {
    const marked = rules({
      writes: {},
      tools: [
        { id: "tk_github:list_issues" },
        { id: "tk_github:delete_repo", approver: { kind: "members", ids: ["m2", " m1", "m2"] } },
      ],
    });

    expect(approverFor(marked, "list_issues", "read")).toEqual({ kind: "caller" });
    expect(approverFor(marked, "delete_repo", "write")).toEqual({
      kind: "members",
      ids: ["m1", "m2"],
    });
    expect(approverFor(marked, "create_issue", "write")).toEqual({ kind: "caller" });
    expect(approverFor(rules({ tools: [{ id: "tk_github:list_issues" }] }), "x", "write")).toBe(
      undefined,
    );
  });

  it("none without rules", () => {
    expect(approverFor(undefined, "create_issue", "write")).toBeUndefined();
  });
});

describe("rules as written", () => {
  it("refuses a mark of another toolkit's tool, a tool marked twice and an empty list of approvers", () => {
    const refused = (value: ApprovalRules) => cleanApprovalRules("tk_github", value);

    expect(refused({ tools: [{ id: "tk_stripe:refund" }] })).toHaveProperty("refused");
    expect(refused({ tools: [{ id: "tk_github:" }] })).toHaveProperty("refused");
    expect(
      refused({ tools: [{ id: "tk_github:refund" }, { id: "tk_github:refund" }] }),
    ).toHaveProperty("refused");
    expect(refused({ writes: { approver: { kind: "members", ids: [] } } })).toHaveProperty(
      "refused",
    );
    expect(refused({ writes: { approver: { kind: "team", id: " " } } })).toHaveProperty("refused");
  });
});

describe("a member who leaves", () => {
  it("leaves every list of approvers, an emptied one kept (and flagged in the view), and changes nothing else", () => {
    const written = rules({
      writes: { approver: { kind: "members", ids: ["alice", "bob"] } },
      tools: [
        { id: "tk_github:delete_repo", approver: { kind: "members", ids: ["alice"] } },
        { id: "tk_github:list_issues", approver: TEAM },
      ],
    });

    const left = rulesWithoutMember(written, "alice");

    expect(left).toEqual({
      writes: { kind: "members", ids: ["bob"] },
      tools: [
        { tool: "delete_repo", approver: { kind: "members", ids: [] } },
        { tool: "list_issues", approver: TEAM },
      ],
    });
    expect(rulesWithoutMember(written, "carol")).toBeUndefined();

    const nobody = (approver: { readonly kind: string; readonly ids?: ReadonlyArray<string> }) =>
      approver.ids?.length === 0;

    expect(left && approvalRulesView("tk_github", left, nobody).tools).toEqual([
      {
        id: "tk_github:delete_repo",
        approver: { kind: "members", ids: [] },
        nobody_decides: true,
      },
      { id: "tk_github:list_issues", approver: TEAM },
    ]);
  });
});

describe("who may decide", () => {
  const decider = (member: string | undefined, teams: ReadonlyArray<string> = []) => ({
    member,
    teams,
  });

  it("the caller, under a caller rule, and nobody else", () => {
    expect(mayDecide({ kind: "caller" }, "alice", decider("alice"))).toBe(true);
    expect(mayDecide({ kind: "caller" }, "alice", decider("bob"))).toBe(false);
    expect(mayDecide({ kind: "caller" }, undefined, decider(undefined))).toBe(false);
  });

  it("any member of the team or the list but the caller, even when the caller is in it", () => {
    expect(mayDecide(TEAM, "alice", decider("bob", ["team-ops"]))).toBe(true);
    expect(mayDecide(TEAM, "alice", decider("alice", ["team-ops"]))).toBe(false);
    expect(mayDecide(TEAM, "alice", decider("carol", ["team-dev"]))).toBe(false);

    const list = { kind: "members", ids: ["alice", "bob"] } as const;

    expect(mayDecide(list, "alice", decider("bob"))).toBe(true);
    expect(mayDecide(list, "alice", decider("alice"))).toBe(false);
    expect(mayDecide(list, "alice", decider("carol"))).toBe(false);
  });
});

describe("the arguments' hash", () => {
  it("is the same whatever order the keys came in, at every depth", () => {
    expect(argumentsHash({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: "é" } })).toBe(
      argumentsHash({ a: { c: "é", d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it("differs for other arguments or another array order, and is `{}`'s without arguments", () => {
    expect(argumentsHash({ a: [1, 2] })).not.toBe(argumentsHash({ a: [2, 1] }));
    expect(argumentsHash({ a: 1 })).not.toBe(argumentsHash({ a: "1" }));
    expect(argumentsHash(undefined)).toBe(argumentsHash({}));
    // SHA-256 of `{}`.
    expect(argumentsHash({})).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });
});

// A toolkit's approval rules (src/lib/approval-rules.ts, #209, #201, ADR 0038): each shape of rule (the write switch, a
// mark on one tool, and an approver that is the caller, a team or a list of members) as the editor holds it, what is
// wrong with a draft, the whole rules a draft writes, and what each tool's row says of them.
import { describe, expect, it } from "vitest";
import type { ApprovalRulesView } from "@commissary/contract/approvals";
import type { ToolView } from "@commissary/contract/tools";
import {
  approvalOfTool,
  approverKindsFor,
  approverOfDraft,
  approverText,
  CALLER_DRAFT,
  draftOfRules,
  ELSEWHERE_LABELS,
  knownApprover,
  knownRules,
  EMPTY_RULES_DRAFT,
  hasRulesErrors,
  markableTools,
  markRows,
  rulesBody,
  rulesSummary,
  sameRules,
  validateRules,
  withMark,
  withMarkApprover,
  withoutMark,
  writeToolCount,
} from "../src/lib/approval-rules.ts";

const FLAGS = { shortened: false, renamed: false, hidden: false, clash: false, missing: false };

const tool = (upstream: string, patch: Partial<ToolView> = {}): ToolView => ({
  id: `tk_1:${upstream}`,
  toolkit_id: "tk_1",
  upstream_name: upstream,
  name: `linear_${upstream}`,
  class: "read",
  flags: FLAGS,
  ...patch,
});

const tools = [
  tool("create_issue", { class: "write" }),
  tool("delete_issue", { class: "write", flags: { ...FLAGS, hidden: true } }),
  tool("get_issue"),
  tool("list_issues"),
  tool("update_cycle", { class: "write", flags: { ...FLAGS, missing: true } }),
];

describe("each shape of rule", () => {
  it("has none to start with, and writes nothing", () => {
    expect(draftOfRules(undefined)).toEqual(EMPTY_RULES_DRAFT);
    expect(rulesBody(EMPTY_RULES_DRAFT)).toBeNull();
  });

  it("is the write switch with the caller as its approver, which a rule leaves out as the default", () => {
    expect(rulesBody({ ...EMPTY_RULES_DRAFT, writes: true })).toEqual({ writes: {} });
  });

  it("is the write switch with a team as its approver", () => {
    expect(
      rulesBody({
        ...EMPTY_RULES_DRAFT,
        writes: true,
        writesApprover: { kind: "team", teamId: "ops", memberIds: [] },
      }),
    ).toEqual({ writes: { approver: { kind: "team", id: "ops" } } });
  });

  it("is the write switch with a list of members, sorted and without repeats", () => {
    expect(
      rulesBody({
        ...EMPTY_RULES_DRAFT,
        writes: true,
        writesApprover: { kind: "members", teamId: "", memberIds: ["m2", "m1", "m2"] },
      }),
    ).toEqual({ writes: { approver: { kind: "members", ids: ["m1", "m2"] } } });
  });

  it("is a mark on one tool, with its own approver", () => {
    const draft = withMarkApprover(
      withMark(withMark(EMPTY_RULES_DRAFT, "tk_1:get_issue"), "tk_1:create_issue"),
      "tk_1:get_issue",
      { kind: "team", teamId: "ops", memberIds: [] },
    );

    expect(rulesBody(draft)).toEqual({
      tools: [
        { id: "tk_1:create_issue" },
        { id: "tk_1:get_issue", approver: { kind: "team", id: "ops" } },
      ],
    });
  });

  it("is a switch with marks together; a mark is kept beside it and wins over it", () => {
    const draft = withMark({ ...EMPTY_RULES_DRAFT, writes: true }, "tk_1:get_issue");

    expect(rulesBody(draft)).toEqual({ writes: {}, tools: [{ id: "tk_1:get_issue" }] });
  });

  it("clears the rules when the switch is off and no tool is marked, and keeps the approver while it is off", () => {
    const off = {
      ...EMPTY_RULES_DRAFT,
      writesApprover: { kind: "team" as const, teamId: "ops", memberIds: [] },
    };

    expect(rulesBody(off)).toBeNull();
    expect(rulesBody(withMark(off, "tk_1:get_issue"))).toEqual({
      tools: [{ id: "tk_1:get_issue" }],
    });
    expect(rulesBody(withoutMark(withMark(EMPTY_RULES_DRAFT, "tk_1:a"), "tk_1:a"))).toBeNull();
  });

  it("starts from a toolkit's rules as its view shows them, and writes them back unchanged", () => {
    const view: ApprovalRulesView = {
      writes: { approver: { kind: "members", ids: ["m1", "m2"] } },
      tools: [
        { id: "tk_1:get_issue", approver: { kind: "caller" } },
        { id: "tk_1:list_issues", approver: { kind: "team", id: "ops" } },
      ],
    };

    const draft = draftOfRules(view);

    expect(draft.writes).toBe(true);
    expect(draft.writesApprover).toEqual({ kind: "members", teamId: "", memberIds: ["m1", "m2"] });
    expect(draft.marks).toHaveLength(2);

    expect(rulesBody(draft)).toEqual({
      writes: { approver: { kind: "members", ids: ["m1", "m2"] } },
      tools: [
        { id: "tk_1:get_issue" },
        { id: "tk_1:list_issues", approver: { kind: "team", id: "ops" } },
      ],
    });
    expect(sameRules(draft, draftOfRules(view))).toBe(true);
    expect(sameRules(draft, withoutMark(draft, "tk_1:get_issue"))).toBe(false);
    expect(sameRules(EMPTY_RULES_DRAFT, draftOfRules({}))).toBe(true);
  });

  it("names the approver a draft means; the caller is none", () => {
    expect(approverOfDraft(CALLER_DRAFT)).toBeUndefined();
    expect(approverOfDraft({ kind: "team", teamId: "ops", memberIds: [] })).toEqual({
      kind: "team",
      id: "ops",
    });
  });
});

describe("what is wrong with a draft", () => {
  it("asks for the team or the members a rule names", () => {
    const team = { kind: "team" as const, teamId: "", memberIds: [] };
    const members = { kind: "members" as const, teamId: "", memberIds: [] };

    expect(validateRules({ ...EMPTY_RULES_DRAFT, writes: true, writesApprover: team }).writes).toBe(
      "Choose a team.",
    );
    expect(
      validateRules({ ...EMPTY_RULES_DRAFT, writes: true, writesApprover: members }).writes,
    ).toBe("Choose at least one member.");

    const marked = withMarkApprover(
      withMark(EMPTY_RULES_DRAFT, "tk_1:get_issue"),
      "tk_1:get_issue",
      members,
    );

    expect(validateRules(marked).marks).toEqual({
      "tk_1:get_issue": "Choose at least one member.",
    });
    expect(hasRulesErrors(validateRules(marked))).toBe(true);
  });

  it("lets a half-made approver pass while its rule is off, and a complete draft through", () => {
    const team = { kind: "team" as const, teamId: "", memberIds: [] };

    expect(hasRulesErrors(validateRules({ ...EMPTY_RULES_DRAFT, writesApprover: team }))).toBe(
      false,
    );
    expect(hasRulesErrors(validateRules({ ...EMPTY_RULES_DRAFT, writes: true }))).toBe(false);
  });
});

describe("marking tools", () => {
  it("offers the tools the toolkit serves that have no mark, by full name, narrowed by a search", () => {
    const draft = withMark(EMPTY_RULES_DRAFT, "tk_1:get_issue");

    // Not the hidden tool, not the one gone upstream, not the marked one.
    expect(markableTools(tools, draft).map((each) => each.upstream_name)).toEqual([
      "create_issue",
      "list_issues",
    ]);
    expect(markableTools(tools, draft, "LIST").map((each) => each.upstream_name)).toEqual([
      "list_issues",
    ]);
    expect(withMark(draft, "tk_1:get_issue")).toBe(draft);
  });

  it("show a mark by the tool's current name, and one on a vanished tool as missing", () => {
    const draft = withMark(withMark(EMPTY_RULES_DRAFT, "tk_1:get_issue"), "tk_1:update_cycle");

    expect(markRows(draft, tools).map((row) => [row.name, row.toolClass, row.missing])).toEqual([
      ["linear_get_issue", "read", false],
      ["update_cycle", undefined, true],
    ]);
    expect(markRows(draft, undefined).every((row) => !row.missing)).toBe(true);
  });

  it("count the write tools the switch makes wait: those served", () => {
    expect(writeToolCount(tools)).toBe(1);
  });
});

describe("what a tool's row says", () => {
  const view: ApprovalRulesView = {
    writes: { approver: { kind: "caller" } },
    tools: [{ id: "tk_1:get_issue", approver: { kind: "team", id: "ops" } }],
  };

  it("waits under a mark, or under the write switch for a write tool; a mark wins", () => {
    expect(approvalOfTool(view, { id: "tk_1:get_issue", class: "read" })).toEqual({
      approver: { kind: "team", id: "ops" },
      because: "mark",
    });
    expect(approvalOfTool(view, { id: "tk_1:create_issue", class: "write" })).toEqual({
      approver: { kind: "caller" },
      because: "writes",
    });
    expect(approvalOfTool(view, { id: "tk_1:list_issues", class: "read" })).toBeUndefined();
    expect(approvalOfTool(undefined, { id: "tk_1:create_issue", class: "write" })).toBeUndefined();

    // A mark on a write tool names its own approver, whatever the switch says.
    expect(
      approvalOfTool(
        { ...view, tools: [{ id: "tk_1:create_issue", approver: { kind: "team", id: "ops" } }] },
        { id: "tk_1:create_issue", class: "write" },
      )?.because,
    ).toBe("mark");
  });

  it("words an approver with the names the panel has, or without them for a plain member", () => {
    const directory = {
      members: [
        { id: "m1", email: "ana@acme.dev" },
        { id: "m2", email: "bo@acme.dev" },
      ],
      teams: [{ id: "ops", name: "Ops" }],
    };

    expect(approverText({ kind: "caller" })).toBe("the caller");
    expect(approverText({ kind: "team", id: "ops" }, directory)).toBe("team Ops");
    expect(approverText({ kind: "team", id: "gone" }, directory)).toBe("a team");
    expect(approverText({ kind: "members", ids: ["m1", "m2"] }, directory)).toBe(
      "ana@acme.dev, bo@acme.dev",
    );
    expect(approverText({ kind: "members", ids: ["m1", "m9"] }, directory)).toBe("2 members");
    expect(approverText({ kind: "members", ids: ["m1"] })).toBe("1 member");
  });

  it("sums a toolkit's rules up in a line, or says nothing when no call waits", () => {
    expect(rulesSummary(undefined)).toBeUndefined();
    expect(rulesSummary({})).toBeUndefined();
    expect(rulesSummary(view)).toBe("write tools wait for the caller; 1 marked tool");
    expect(rulesSummary({ tools: view.tools ?? [] })).toBe("1 marked tool");
  });
});

describe("who may be named an approver", () => {
  it("is anyone for an org admin; a member on their own private toolkit names the caller only", () => {
    expect(approverKindsFor(true)).toEqual(["caller", "team", "members"]);
    expect(approverKindsFor(false)).toEqual(["caller"]);
  });
});

describe("approvers the directory no longer has", () => {
  const directory = {
    members: [{ id: "bo", email: "bo@example.com" }],
    teams: [{ id: "ops", name: "Ops" }],
  };

  it("reads a deleted team as unchosen and keeps a team that is there", () => {
    expect(knownApprover({ kind: "team", teamId: "gone", memberIds: [] }, directory).teamId).toBe(
      "",
    );
    expect(knownApprover({ kind: "team", teamId: "ops", memberIds: [] }, directory).teamId).toBe(
      "ops",
    );
  });

  it("drops the members who left, and leaves none chosen when all did", () => {
    expect(
      knownApprover({ kind: "members", teamId: "", memberIds: ["bo", "gone"] }, directory)
        .memberIds,
    ).toEqual(["bo"]);
    expect(
      knownApprover({ kind: "members", teamId: "", memberIds: ["gone"] }, directory).memberIds,
    ).toEqual([]);
  });

  it("stops a save that would send a deleted team: the rule asks for a team again", () => {
    const stale = draftOfRules({
      writes: { approver: { kind: "team", id: "gone" } },
      tools: [{ id: "tk_1:a", approver: { kind: "members", ids: ["gone"] } }],
    });

    expect(hasRulesErrors(validateRules(stale))).toBe(false);

    const known = knownRules(stale, directory);

    expect(validateRules(known).writes).toBe("Choose a team.");
    expect(validateRules(known).marks).toEqual({ "tk_1:a": "Choose at least one member." });
  });

  it("words the approvers a member sees but may not choose", () => {
    expect(ELSEWHERE_LABELS.team).toBe("A team (set elsewhere)");
    expect(ELSEWHERE_LABELS.members).toBe("Members (set elsewhere)");
  });
});

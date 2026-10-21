// A toolkit's approval rules on its page (#209, #201, ADR 0038, GLOSSARY "Approval rule", "Approver"): the "write tools
// require approval" switch, marks on single tools, and each rule's approver (the caller, a team, or a list of members),
// as the editor holds them, what is wrong with a draft, the whole body a draft becomes (`PATCH /toolkits/:id` writes the
// rules whole), and what each tool's row says of them. Pure: no DOM, tested in test/approval-rules.test.ts.
import type {
  ApprovalRules,
  ApprovalRulesView,
  Approver,
  ToolApprovalMark,
} from "@commissary/contract/approvals";
import type { ToolView } from "@commissary/contract/tools";
import type { MemberView, TeamView } from "@commissary/contract/members";
import { upstreamNameOf } from "./tool-id.ts";

export type ApproverKind = Approver["kind"];

/** An approver as the editor holds it: its kind and, for that kind, the team or the members chosen. */
export interface ApproverDraft {
  readonly kind: ApproverKind;
  readonly teamId: string;
  readonly memberIds: ReadonlyArray<string>;
}

/** The default approver: the member who made the call. */
export const CALLER_DRAFT: ApproverDraft = { kind: "caller", teamId: "", memberIds: [] };

/** A mark on one tool, by its stable id, with the approver of its calls. */
export interface MarkDraft {
  readonly id: string;
  readonly approver: ApproverDraft;
}

/** A toolkit's approval rules as the editor holds them. */
export interface RulesDraft {
  /** "Write tools require approval": the rule is on. */
  readonly writes: boolean;
  /** The approver of the write tools' rule; kept while the switch is off, so turning it on again restores it. */
  readonly writesApprover: ApproverDraft;
  readonly marks: ReadonlyArray<MarkDraft>;
}

export const EMPTY_RULES_DRAFT: RulesDraft = {
  writes: false,
  writesApprover: CALLER_DRAFT,
  marks: [],
};

export const draftOfApprover = (approver: Approver | undefined): ApproverDraft => {
  switch (approver?.kind) {
    case undefined:
    case "caller":
      return CALLER_DRAFT;
    case "team":
      return { kind: "team", teamId: approver.id, memberIds: [] };
    case "members":
      return { kind: "members", teamId: "", memberIds: approver.ids };
  }
};

/** The approver a draft names; `undefined` for the caller, which a rule leaves out (the default). */
export const approverOfDraft = (draft: ApproverDraft): Approver | undefined => {
  switch (draft.kind) {
    case "caller":
      return undefined;
    case "team":
      return { kind: "team", id: draft.teamId };
    case "members":
      return { kind: "members", ids: [...new Set(draft.memberIds)].toSorted() };
  }
};

const ruleOf = (draft: ApproverDraft) => {
  const approver = approverOfDraft(draft);

  return approver === undefined ? {} : { approver };
};

/** The editor's start for a toolkit: its rules as its view shows them (an approver is always named there). */
export const draftOfRules = (rules: ApprovalRulesView | undefined): RulesDraft => ({
  writes: rules?.writes !== undefined,
  writesApprover: draftOfApprover(rules?.writes?.approver),
  marks: (rules?.tools ?? []).map((mark) => ({
    id: mark.id,
    approver: draftOfApprover(mark.approver),
  })),
});

/**
 * The whole rules a draft makes, to write as they are; `null` when it has none (the write switch off and no marks),
 * which clears the toolkit's rules. A caller approver is left out, as it is the default.
 */
export const rulesBody = (draft: RulesDraft): ApprovalRules | null => {
  const marks = draft.marks
    .toSorted((a, b) => (a.id < b.id ? -1 : 1))
    .map((mark): ToolApprovalMark => ({ id: mark.id, ...ruleOf(mark.approver) }));

  if (!draft.writes && marks.length === 0) return null;

  return {
    ...(draft.writes ? { writes: ruleOf(draft.writesApprover) } : {}),
    ...(marks.length === 0 ? {} : { tools: marks }),
  };
};

/** Whether two drafts write the same rules (the order of marks and of listed members does not matter). */
export const sameRules = (a: RulesDraft, b: RulesDraft): boolean =>
  JSON.stringify(rulesBody(a)) === JSON.stringify(rulesBody(b));

/**
 * `draft` with an approver kept only while the directory still has what it names: a deleted team, or a member who has
 * left, reads as unchosen, so the editor asks again and a save cannot send one the server would refuse.
 */
export const knownApprover = (
  draft: ApproverDraft,
  directory: ApproverDirectory,
): ApproverDraft => {
  switch (draft.kind) {
    case "caller":
      return draft;
    case "team":
      return directory.teams.some((team) => team.id === draft.teamId)
        ? draft
        : { ...draft, teamId: "" };
    case "members":
      return {
        ...draft,
        memberIds: draft.memberIds.filter((id) =>
          directory.members.some((member) => member.id === id),
        ),
      };
  }
};

/** The rules of a draft with every approver known to the directory ({@link knownApprover}). */
export const knownRules = (draft: RulesDraft, directory: ApproverDirectory): RulesDraft => ({
  ...draft,
  writesApprover: knownApprover(draft.writesApprover, directory),
  marks: draft.marks.map((mark) => ({
    ...mark,
    approver: knownApprover(mark.approver, directory),
  })),
});

/** The message for each approver or mark that is not yet complete. */
export interface RulesErrors {
  writes?: string;
  /** By the mark's stable id. */
  marks: Readonly<Record<string, string>>;
}

const approverProblem = (draft: ApproverDraft): string | undefined => {
  if (draft.kind === "team" && draft.teamId === "") return "Choose a team.";

  if (draft.kind === "members" && draft.memberIds.length === 0)
    return "Choose at least one member.";

  return undefined;
};

/** What is wrong with a draft; an empty result means it will do. The writes' approver counts only while the rule is on. */
export const validateRules = (draft: RulesDraft): RulesErrors => {
  const writes = draft.writes ? approverProblem(draft.writesApprover) : undefined;

  const marks = Object.fromEntries(
    draft.marks.flatMap((mark) => {
      const problem = approverProblem(mark.approver);

      return problem === undefined ? [] : [[mark.id, problem] as const];
    }),
  );

  return { ...(writes === undefined ? {} : { writes }), marks };
};

export const hasRulesErrors = (errors: RulesErrors): boolean =>
  errors.writes !== undefined || Object.keys(errors.marks).length > 0;

// ---------------------------------------------------------------------------------------------------------------
// Marks

/** `draft` with a mark on `id` (the caller approving), unless it has one already. */
export const withMark = (draft: RulesDraft, id: string): RulesDraft =>
  draft.marks.some((mark) => mark.id === id)
    ? draft
    : { ...draft, marks: [...draft.marks, { id, approver: CALLER_DRAFT }] };

export const withoutMark = (draft: RulesDraft, id: string): RulesDraft => ({
  ...draft,
  marks: draft.marks.filter((mark) => mark.id !== id),
});

export const withMarkApprover = (
  draft: RulesDraft,
  id: string,
  approver: ApproverDraft,
): RulesDraft => ({
  ...draft,
  marks: draft.marks.map((mark) => (mark.id === id ? { ...mark, approver } : mark)),
});

/**
 * The tools a mark can be added to: those the toolkit serves (not hidden, shadowed by a name clash or gone upstream)
 * that have no mark yet, by full name; narrowed to `query` (case-insensitive) when it is not blank.
 */
export const markableTools = (
  tools: ReadonlyArray<ToolView>,
  draft: RulesDraft,
  query = "",
): ReadonlyArray<ToolView> => {
  const needle = query.trim().toLowerCase();

  return tools
    .filter(
      (tool) =>
        !tool.flags.hidden &&
        !tool.flags.clash &&
        !tool.flags.missing &&
        !draft.marks.some((mark) => mark.id === tool.id) &&
        (needle === "" || tool.name.toLowerCase().includes(needle)),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/** A mark as its row shows it: the tool's current full name and class, or its upstream name once it is gone. */
export interface MarkRow {
  readonly id: string;
  readonly name: string;
  readonly toolClass: ToolView["class"] | undefined;
  readonly missing: boolean;
  readonly approver: ApproverDraft;
}

/** The marks by name. `tools` is the toolkit's tool list; a mark on a tool it does not list is missing. */
export const markRows = (
  draft: RulesDraft,
  tools: ReadonlyArray<ToolView> | undefined,
): ReadonlyArray<MarkRow> =>
  draft.marks
    .map((mark): MarkRow => {
      const listed = tools?.find((tool) => tool.id === mark.id && !tool.flags.missing);

      return {
        id: mark.id,
        name: listed?.name ?? upstreamNameOf(mark.id),
        toolClass: listed?.class,
        missing: tools !== undefined && listed === undefined,
        approver: mark.approver,
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));

/** How many of a toolkit's served tools are write tools: what the switch makes wait. */
export const writeToolCount = (tools: ReadonlyArray<ToolView>): number =>
  tools.filter(
    (tool) =>
      tool.class === "write" && !tool.flags.hidden && !tool.flags.clash && !tool.flags.missing,
  ).length;

// ---------------------------------------------------------------------------------------------------------------
// What a tool's row says

/** Why a tool's calls wait, and for whom: a mark on it, or the write switch for a write tool. */
export interface ToolApproval {
  readonly approver: Approver;
  readonly because: "mark" | "writes";
}

/**
 * The rule a tool's calls fall under, as the toolkit's view shows its rules: a mark on the tool wins over the write
 * switch, which covers the tools whose class is write (an override's class counts, `tool.class` being the resolved one).
 */
export const approvalOfTool = (
  rules: ApprovalRulesView | undefined,
  tool: Pick<ToolView, "id" | "class">,
): ToolApproval | undefined => {
  const mark = rules?.tools?.find((each) => each.id === tool.id);

  if (mark !== undefined) return { approver: mark.approver, because: "mark" };

  if (rules?.writes !== undefined && tool.class === "write")
    return { approver: rules.writes.approver, because: "writes" };

  return undefined;
};

/** The names the panel knows, to word an approver: a plain member's panel has neither list. */
export interface ApproverDirectory {
  readonly members: ReadonlyArray<Pick<MemberView, "id" | "email">>;
  readonly teams: ReadonlyArray<Pick<TeamView, "id" | "name">>;
}

/** An approver in a sentence: "the caller", "team Research", "ana@acme.dev, bo@acme.dev". */
export const approverText = (approver: Approver, directory?: ApproverDirectory): string => {
  switch (approver.kind) {
    case "caller":
      return "the caller";
    case "team": {
      const name = directory?.teams.find((team) => team.id === approver.id)?.name;

      return name === undefined ? "a team" : `team ${name}`;
    }

    case "members": {
      const names = approver.ids.map(
        (id) => directory?.members.find((member) => member.id === id)?.email,
      );

      return names.every((name) => name !== undefined)
        ? names.join(", ")
        : approver.ids.length === 1
          ? "1 member"
          : `${approver.ids.length} members`;
    }
  }
};

/** The line a toolkit's facts carry for its rules; `undefined` when no call of its tools waits. */
export const rulesSummary = (
  rules: ApprovalRulesView | undefined,
  directory?: ApproverDirectory,
): string | undefined => {
  if (rules === undefined) return undefined;

  const parts = [
    ...(rules.writes === undefined
      ? []
      : [`write tools wait for ${approverText(rules.writes.approver, directory)}`]),
    ...((rules.tools ?? []).length === 0
      ? []
      : [`${rules.tools?.length ?? 0} marked ${rules.tools?.length === 1 ? "tool" : "tools"}`]),
  ];

  return parts.length === 0 ? undefined : parts.join("; ");
};

/**
 * Which approvers the caller may name on a toolkit: an org admin any (the panel lists the members and teams they
 * need), a member on their own private toolkit only the caller, as the panel has no member or team list for them.
 */
export const approverKindsFor = (admin: boolean): ReadonlyArray<ApproverKind> =>
  admin ? ["caller", "team", "members"] : ["caller"];

/**
 * How a rule's approver reads in the list of a member who may name only the caller, when an API call set another: the
 * option is shown and disabled, so the editor never misstates the rule.
 */
export const ELSEWHERE_LABELS: Readonly<Record<ApproverKind, string>> = {
  caller: "The caller",
  team: "A team (set elsewhere)",
  members: "Members (set elsewhere)",
};

export const APPROVER_LABELS: Readonly<Record<ApproverKind, string>> = {
  caller: "The caller: whoever made the call",
  team: "A team: any member of it but the caller",
  members: "A list of members: any of them but the caller",
};

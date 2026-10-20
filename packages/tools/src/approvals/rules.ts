/**
 * Approval rules (#201, ADR 0038, GLOSSARY "Approval rule", "Approver"): which calls of a toolkit's tools wait for an
 * approver, and who may approve them. Pure; the Tools part asks it on every call and every decision.
 *
 * A toolkit's rules are the toolkit-wide "write tools require approval" switch (`writes`, which follows each tool's
 * resolved class, so reclassifying a tool changes whether it waits) and marks on single tools by upstream name (stored;
 * the management API names them by stable id). A mark wins over `writes`, so a marked write tool waits for the mark's
 * approver. Rules apply to every call on the toolkit, whatever the credential.
 *
 * An approver is the caller (the default), a team or a list of members; of a team or a list, any member but the caller
 * may approve, even when the caller is in it.
 */
import type { ApprovalRules, ApprovalRulesView, Approver } from "@commissary/contract/approvals";
import type { ToolClass } from "@commissary/contract/tools";

/** A toolkit's approval rules as stored: each approver named, marks by upstream name. */
export interface StoredApprovalRules {
  /** Present while "write tools require approval" is on. */
  readonly writes?: Approver | undefined;
  readonly tools: ReadonlyArray<{ readonly tool: string; readonly approver: Approver }>;
}

const CALLER: Approver = { kind: "caller" };

/** The approver a call of the tool `upstreamName` of class `toolClass` waits for, if any rule applies. */
export const approverFor = (
  rules: StoredApprovalRules | undefined,
  upstreamName: string,
  toolClass: ToolClass,
): Approver | undefined => {
  if (rules === undefined) return undefined;
  const mark = rules.tools.find((marked) => marked.tool === upstreamName);

  if (mark !== undefined) return mark.approver;

  return toolClass === "write" ? rules.writes : undefined;
};

/** Who asks to decide: a member (none for a caller without one) and the teams they are in. */
export interface Decider {
  readonly member: string | undefined;
  readonly teams: ReadonlyArray<string>;
}

/**
 * Whether `decider` may approve or deny a call of `caller` under `approver`: the caller themselves under a `caller` rule;
 * any member of the team or the list but the caller under the others. Nobody without a member decides.
 */
export const mayDecide = (
  approver: Approver,
  caller: string | undefined,
  decider: Decider,
): boolean => {
  const member = decider.member;

  if (member === undefined) return false;

  switch (approver.kind) {
    case "caller":
      return member === caller;
    case "team":
      return member !== caller && decider.teams.includes(approver.id);
    case "members":
      return member !== caller && approver.ids.includes(member);
  }
};

/** An approver without the member `left` (a member who left the org). */
export const withoutMember = (approver: Approver, left: string): Approver =>
  approver.kind === "members"
    ? { kind: "members", ids: approver.ids.filter((id) => id !== left) }
    : approver;

/** The rules with each approver replaced by what `change` makes of it. */
export const mapApprovers = (
  rules: StoredApprovalRules,
  change: (approver: Approver) => Approver,
): StoredApprovalRules => ({
  ...(rules.writes === undefined ? {} : { writes: change(rules.writes) }),
  tools: rules.tools.map((mark) => ({ ...mark, approver: change(mark.approver) })),
});

/**
 * The rules without the member `left` on any list of approvers, or undefined when no list named them (nothing to
 * write). A list they leave empty stays: its calls wait for nobody, and its view says so (`nobody_decides`).
 */
export const rulesWithoutMember = (
  rules: StoredApprovalRules,
  left: string,
): StoredApprovalRules | undefined =>
  approversOf(rules).some((approver) => approver.kind === "members" && approver.ids.includes(left))
    ? mapApprovers(rules, (approver) => withoutMember(approver, left))
    : undefined;

/**
 * Rules as written to the management API, cleaned for the toolkit `toolkitId`: approvers left out are the caller, a
 * list's members trimmed and de-duplicated, marks by upstream name (from their stable ids) and sorted. Or why they are
 * refused: a mark of another toolkit's tool, a tool marked twice, an empty list, a team or member that is blank.
 */
export const cleanApprovalRules = (
  toolkitId: string,
  rules: ApprovalRules,
): StoredApprovalRules | { readonly refused: string } => {
  const approver = (given: Approver | undefined): Approver | string => {
    if (given === undefined || given.kind === "caller") return CALLER;

    if (given.kind === "team") {
      const id = given.id.trim();

      return id === "" ? "a team approver names its team" : { kind: "team", id };
    }

    const ids = [...new Set(given.ids.map((id) => id.trim()))].toSorted();

    return ids.length === 0 || ids.includes("")
      ? "a list of approvers names at least one member"
      : { kind: "members", ids };
  };

  let writes: Approver | undefined;

  if (rules.writes !== undefined) {
    const cleaned = approver(rules.writes.approver);

    if (typeof cleaned === "string") return { refused: cleaned };
    writes = cleaned;
  }

  const tools: Array<{ readonly tool: string; readonly approver: Approver }> = [];

  for (const mark of rules.tools ?? []) {
    const id = mark.id.trim();
    const prefix = `${toolkitId}:`;

    if (!id.startsWith(prefix) || id.length === prefix.length)
      return {
        refused: `${id} is not the stable id of a tool of the toolkit (<toolkit id>:<upstream name>)`,
      };

    const tool = id.slice(prefix.length);

    if (tools.some((marked) => marked.tool === tool))
      return { refused: `${id} is marked more than once` };
    const cleaned = approver(mark.approver);

    if (typeof cleaned === "string") return { refused: cleaned };
    tools.push({ tool, approver: cleaned });
  }

  return {
    ...(writes === undefined ? {} : { writes }),
    tools: tools.toSorted((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0)),
  };
};

/** Every approver the rules name. */
export const approversOf = (rules: StoredApprovalRules): ReadonlyArray<Approver> => [
  ...(rules.writes === undefined ? [] : [rules.writes]),
  ...rules.tools.map((mark) => mark.approver),
];

/**
 * Rules as the management API shows them: marks by stable id, every approver named, and `nobody_decides` on a rule whose
 * approver no one can be (`nobody`: a team the org deleted, a list whose members all left).
 */
export const approvalRulesView = (
  toolkitId: string,
  rules: StoredApprovalRules,
  nobody: (approver: Approver) => boolean,
): ApprovalRulesView => {
  const rule = (approver: Approver) => ({
    approver,
    ...(nobody(approver) ? { nobody_decides: true as const } : {}),
  });

  return {
    ...(rules.writes === undefined ? {} : { writes: rule(rules.writes) }),
    ...(rules.tools.length === 0
      ? {}
      : {
          tools: rules.tools.map((mark) => ({
            id: `${toolkitId}:${mark.tool}`,
            ...rule(mark.approver),
          })),
        }),
  };
};

/** Whether the rules make no call wait: stored as none. */
export const noRules = (rules: StoredApprovalRules): boolean =>
  rules.writes === undefined && rules.tools.length === 0;

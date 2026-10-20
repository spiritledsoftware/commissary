// Pending approvals of tool calls (#201, ADR 0038): what the Approvals pages say of each. Pure: no DOM, tested in
// test/approvals.test.ts. The server decides who sees an approval and who may decide it (`can_decide`); these
// functions only word and group what it answered.
import type {
  ApprovalRulesView,
  ApprovalView,
  Approver,
  ApproverView,
} from "@commissary/contract/approvals";
import { formatDuration } from "./format.ts";

/** Who may decide calls under `approver`, as a heading: the caller, a team or a list of members. */
export const approverLabel = (approver: ApproverView): string => {
  switch (approver.kind) {
    case "caller":
      return "Each call's caller";
    case "team":
      return approver.name === undefined
        ? `A deleted team (${approver.id})`
        : `Team ${approver.name}`;
    case "members":
      return approver.members.length === 0
        ? "Nobody (every listed member left)"
        : approver.members.map((member) => member.email ?? member.id).join(", ");
  }
};

/**
 * Whether no one can be `approver` now: a team the org deleted (the server names only a team it has) or a list whose
 * members all left (the server gives an email to a member it has). Calls under it wait until their hour is over.
 */
export const nobodyDecides = (approver: ApproverView): boolean => {
  switch (approver.kind) {
    case "caller":
      return false;
    case "team":
      return approver.name === undefined;
    case "members":
      return approver.members.every((member) => member.email === undefined);
  }
};

/** The warning an approval page shows when no one can decide it (`undefined`: someone can). */
export const nobodyDecidesText = (
  approval: Pick<ApprovalView, "approver" | "status">,
): string | undefined => {
  if (approval.status !== "pending" || !nobodyDecides(approval.approver)) return undefined;

  const why =
    approval.approver.kind === "team"
      ? "Its team no longer exists"
      : "Every member its rule listed has left";

  return (
    `${why}, so nobody can decide this call: it waits until its hour is over. ` +
    "Whoever manages the toolkit can change its approval rules."
  );
};

/**
 * The warnings a toolkit's approval rules call for, one per rule no one can approve under (`nobody_decides`): its calls
 * wait until they expire. For the rules editor (#209) and anywhere a toolkit's rules show.
 */
export const approvalRulesWarnings = (rules: ApprovalRulesView): ReadonlyArray<string> => {
  const warning = (rule: string, approver: Approver) =>
    `${rule} waits for ${
      approver.kind === "team"
        ? "a team that no longer exists"
        : "a list of members who have all left"
    }: nobody can approve its calls, which wait until their hour is over.`;

  const marks = (rules.tools ?? []).filter((mark) => mark.nobody_decides === true);

  return [
    ...(rules.writes?.nobody_decides === true
      ? [warning("The write tools' rule", rules.writes.approver)]
      : []),
    ...marks.map((mark) =>
      warning(`The rule on ${mark.id.slice(mark.id.indexOf(":") + 1)}`, mark.approver),
    ),
  ];
};

/** The set an approver names, as a key that is the same for every approval it decides. */
const approverKey = (approver: ApproverView): string => {
  switch (approver.kind) {
    case "caller":
      return "caller";
    case "team":
      return `team:${approver.id}`;
    case "members":
      return `members:${approver.members
        .map((member) => member.id)
        .toSorted()
        .join(",")}`;
  }
};

export interface ApprovalGroup {
  readonly key: string;
  readonly label: string;
  readonly approvals: ReadonlyArray<ApprovalView>;
}

/** The pending approvals by approver set, each set in the order its first approval came (newest first). */
export const groupByApprover = (
  approvals: ReadonlyArray<ApprovalView>,
): ReadonlyArray<ApprovalGroup> => {
  const groups = new Map<string, { label: string; approvals: Array<ApprovalView> }>();

  for (const approval of approvals) {
    const key = approverKey(approval.approver);
    const group = groups.get(key) ?? { label: approverLabel(approval.approver), approvals: [] };

    group.approvals.push(approval);
    groups.set(key, group);
  }

  return [...groups].map(([key, group]) => ({ key, ...group }));
};

/** Who made the call: their email, their member id, or the principal of a caller without a member. */
export const callerText = (approval: ApprovalView): string =>
  approval.caller.email ?? approval.caller.member_id ?? approval.caller.principal;

/** How long an approval has left at `now`: "52 min left", or that its hour is over. */
export const timeLeftText = (approval: Pick<ApprovalView, "expires_at">, now: number): string => {
  const left = Date.parse(approval.expires_at) - now;

  return left <= 0 ? "Expired" : `${formatDuration(left)} left`;
};

const STATUS: Readonly<Record<ApprovalView["status"], string>> = {
  pending: "Waiting for a decision",
  approved: "Approved: the same call goes through once when it is made again",
  denied: "Denied",
  used: "Approved, and the call went through",
};

/** Where an approval stands, in a sentence. */
export const statusText = (approval: Pick<ApprovalView, "status">): string =>
  STATUS[approval.status];

/** A call's arguments as the approval page shows them: indented JSON. */
export const argumentsText = (args: NonNullable<ApprovalView["arguments"]>): string =>
  JSON.stringify(args, null, 2);

/** Why the viewer cannot decide an approval they can see, in a sentence (`undefined`: they can). */
export const cannotDecideText = (approval: ApprovalView): string | undefined => {
  if (approval.can_decide) return undefined;

  if (approval.status !== "pending") return undefined;

  return approval.approver.kind === "caller"
    ? undefined
    : "This is your call: another of its approvers decides it.";
};

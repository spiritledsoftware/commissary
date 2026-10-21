/**
 * Approval rules and pending approvals of tool calls (#201, ADR 0038; `packages/tools/src/approvals/`,
 * `packages/tools/src/management/routes.ts`). Shared with the browser: imports `effect` and `./errors.ts` only.
 *
 * An **approval rule** on a toolkit makes calls of some of its tools wait for their **approver**: the toolkit-wide
 * "write tools require approval" switch (`writes`, which follows each tool's class) and marks on single tools by stable
 * id (`tools`, a mark wins over `writes`). Rules apply to every call on the toolkit, whatever the credential. An org
 * admin sets them on org toolkits, a member on their own private toolkits (`PATCH /toolkits/:id`, `approval_rules`).
 *
 * A call that waits on a rule answers that it is pending, with a link to its approval page in the panel, unless its
 * caller is its approver and their client asks them on a form (MCP elicitation). A **pending approval** holds the call's
 * arguments, sealed, until it is approved or denied; it is gone an hour after the call, when it expires. Once approved,
 * the same call (same member, tool and arguments) goes through once, until that hour ends; repeated after it, the call
 * waits for a new approval. Removing or narrowing the rule a pending approval waits on (or reclassifying its tool)
 * deletes it. `/approvals` lists the pending approvals the caller may decide or made, and decides them.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/**
 * Who may approve a call under a rule: the member who made it (`caller`, the default), or any member of a team or of a
 * list of members except the caller, even when the caller is in it.
 */
export const Approver = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("caller") }),
  Schema.Struct({ kind: Schema.Literal("team"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("members"), ids: Schema.Array(Schema.String) }),
]);

export type Approver = typeof Approver.Type;

/** One rule: its approver, the caller when left out. */
export const ApprovalRule = Schema.Struct({ approver: optional(Approver) });

export type ApprovalRule = typeof ApprovalRule.Type;

/** A mark on one tool: its stable id (`<toolkit id>:<upstream name>`) and its approver. */
export const ToolApprovalMark = Schema.Struct({ id: Schema.String, approver: optional(Approver) });

export type ToolApprovalMark = typeof ToolApprovalMark.Type;

/**
 * A toolkit's approval rules: `writes`, present while "write tools require approval" is on, and the marked tools. A
 * view always names each approver.
 */
export const ApprovalRules = Schema.Struct({
  writes: optional(ApprovalRule),
  tools: optional(Schema.Array(ToolApprovalMark)),
});

export type ApprovalRules = typeof ApprovalRules.Type;

/**
 * A rule as a toolkit's view shows it: its approver, and `nobody_decides` when no one can be that approver now (a team
 * the org deleted, a list whose members all left): its calls wait until they expire, so a panel warns of it.
 */
const ApprovalRuleView = {
  approver: Approver,
  nobody_decides: optional(Schema.Literal(true)),
};

/** A toolkit's approval rules as its view shows them ({@link ApprovalRules}, each rule flagged as above). */
export const ApprovalRulesView = Schema.Struct({
  writes: optional(Schema.Struct(ApprovalRuleView)),
  tools: optional(Schema.Array(Schema.Struct({ id: Schema.String, ...ApprovalRuleView }))),
});

export type ApprovalRulesView = typeof ApprovalRulesView.Type;

/**
 * Where a pending approval stands: `pending` (undecided), `approved` (its call has not gone through yet), `used`
 * (approved, and the call went through once) or `denied`. An expired one is gone: there is no status for it.
 */
export const ApprovalStatus = Schema.Literals(["pending", "approved", "denied", "used"]);

export type ApprovalStatus = typeof ApprovalStatus.Type;

/** An approver as the panel shows it: a team with its name, members with their emails (an id that left has none). */
export const ApproverView = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("caller") }),
  Schema.Struct({ kind: Schema.Literal("team"), id: Schema.String, name: optional(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("members"),
    members: Schema.Array(Schema.Struct({ id: Schema.String, email: optional(Schema.String) })),
  }),
]);

export type ApproverView = typeof ApproverView.Type;

/** A pending approval, undecided or decided, until it expires. Times are ISO. */
export const ApprovalView = Schema.Struct({
  id: Schema.String,
  status: ApprovalStatus,
  toolkit: Schema.Struct({ id: Schema.String, name: Schema.String }),
  /** The tool's stable id and its full name when it was called. */
  tool: Schema.Struct({ id: Schema.String, name: Schema.String }),
  /** Who called: their member id and email, or the principal of a caller without a member. */
  caller: Schema.Struct({
    member_id: optional(Schema.String),
    email: optional(Schema.String),
    principal: Schema.String,
  }),
  /** Which of the toolkit's credentials the call is on. */
  credential: Schema.Literals(["shared", "private"]),
  approver: ApproverView,
  created_at: Schema.String,
  /** An hour after the call: the approval is gone then, and an approved call no longer goes through. */
  expires_at: Schema.String,
  decided_at: optional(Schema.String),
  /** The principal that decided. */
  decided_by: optional(Schema.String),
  /** The call's arguments: to an eligible approver, while it is undecided. Gone once it is decided. */
  arguments: optional(Schema.Record(Schema.String, Schema.Json)),
  /** Whether the caller of this route may approve or deny it now. */
  can_decide: Schema.Boolean,
  /**
   * The hosted agent run whose call it is (#232, #234), whose page the panel links (`/agent-runs/<run>`, which decides
   * who sees the run); absent for any other caller's.
   */
  run: optional(Schema.String),
});

export type ApprovalView = typeof ApprovalView.Type;

/** `GET /approvals`: the pending approvals the caller may decide or is waiting on, newest first. */
export const ApprovalsList = Schema.Struct({ approvals: Schema.Array(ApprovalView) });

export type ApprovalsList = typeof ApprovalsList.Type;

export const ApprovalDecision = Schema.Struct({ decision: Schema.Literals(["approve", "deny"]) });

export type ApprovalDecision = typeof ApprovalDecision.Type;

const idParam = { params: { id: Schema.String } };

/**
 * Pending approvals. Every member may call these; what they reach is decided per approval: an eligible approver sees
 * its arguments and decides it, the caller sees it without them (unless they are its approver), anyone else gets `404`.
 */
export class ApprovalsGroup extends HttpApiGroup.make("approvals").add(
  HttpApiEndpoint.get("list", "/approvals", { success: ApprovalsList, error: managementErrors }),
  HttpApiEndpoint.get("get", "/approvals/:id", {
    ...idParam,
    success: ApprovalView,
    error: managementErrors,
  }),
  /**
   * Approve or deny: `403 forbidden` for a caller who is not its approver (a caller never approves their own call under a
   * team or list rule), `409 conflict` once it is decided, `404` once it expired.
   */
  HttpApiEndpoint.post("decide", "/approvals/:id/decision", {
    ...idParam,
    payload: ApprovalDecision,
    success: ApprovalView,
    error: managementErrors,
  }),
) {}

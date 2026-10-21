// The Usage page's tool calls (#209, #199, ADR 0038): what a tool call's usage record says, in words: its outcome, the
// outcome of any approval rule, whose credential served it, and the sizes of what went over the wire (never the
// content: a record keeps no arguments and no results). Pure: no DOM, tested in test/usage-tools.test.ts.
import type {
  ToolCallApproval,
  ToolCallRecordOutcome,
  UsageRecord,
  UsageTotals,
} from "@commissary/contract/usage";
import { formatCount, formatCost, formatDuration, formatLatency } from "./format.ts";
import { upstreamNameOf } from "./tool-id.ts";

const OUTCOMES: Readonly<Record<ToolCallRecordOutcome, string>> = {
  success: "Succeeded",
  tool_error: "The tool reported an error",
  upstream_failure: "The upstream failed",
  refused: "Refused: a spend limit had no room",
  needs_credential: "Needs the caller's own credential",
  approval_pending: "Waiting for approval",
  not_approved: "Not approved",
};

/** A short word for a table cell. */
const OUTCOME_WORDS: Readonly<Record<ToolCallRecordOutcome, string>> = {
  success: "OK",
  tool_error: "Tool error",
  upstream_failure: "Upstream failed",
  refused: "Refused",
  needs_credential: "Needs credential",
  approval_pending: "Waiting",
  not_approved: "Not approved",
};

/** What a tool call's outcome says, in a sentence. */
export const outcomeText = (outcome: ToolCallRecordOutcome): string => OUTCOMES[outcome];

/** What a tool call's outcome says in a table cell. */
export const outcomeWord = (outcome: ToolCallRecordOutcome): string => OUTCOME_WORDS[outcome];

/**
 * Whether an outcome is bad news (the red trail mark): the tool or its upstream failed, or a Spend limit closed the
 * call. A call that waits for approval or for the member's own credential has failed nothing: it is a note.
 */
export const outcomeFailed = (outcome: ToolCallRecordOutcome): boolean =>
  outcome === "tool_error" || outcome === "upstream_failure" || outcome === "refused";

const APPROVALS: Readonly<Record<ToolCallApproval, string>> = {
  none: "No approval rule applied",
  approved_elicitation: "Approved by its caller on a form",
  approved_panel: "Approved on its approval page",
  denied: "Denied",
  pending: "Waiting for its approver",
};

/** How an approval rule decided a call, in a sentence; `undefined` for a record from before approvals. */
export const approvalText = (approval: ToolCallApproval | undefined): string | undefined =>
  approval === undefined ? undefined : APPROVALS[approval];

/** The approval's word for a table cell: only where a rule applied, so a rule-free call carries none. */
export const approvalWord = (approval: ToolCallApproval | undefined): string | undefined => {
  switch (approval) {
    case undefined:
    case "none":
      return undefined;
    case "approved_elicitation":
    case "approved_panel":
      return "Approved";
    case "denied":
      return "Denied";
    case "pending":
      return "Pending";
  }
};

/** The record is a tool call (one that names a tool), not the record a browser or sandbox session writes on closing. */
export const isCall = (record: UsageRecord): boolean => record.tool_id !== undefined;

/** What a record is of, in words: a tool of a toolkit, or a session of the browser or the computer. */
export const recordSubject = (
  record: Pick<UsageRecord, "tool_id" | "browser_ms" | "computer_ms">,
): string => {
  if (record.tool_id !== undefined) return upstreamNameOf(record.tool_id);

  return record.computer_ms !== undefined ? "Computer session" : "Browser session";
};

/** Whose credential served a call. */
export const credentialText = (credential: UsageRecord["credential"]): string => {
  switch (credential) {
    case "shared":
      return "The org's shared credential";
    case "private":
      return "A private credential";
    case undefined:
      return "None";
  }
};

/** Bytes as the detail shows them: "812 B", "4.2 kB", "1.3 MB". */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1000) return `${formatCount(bytes)} B`;

  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;

  return `${(bytes / 1_000_000).toFixed(1)} MB`;
};

/** A record's labelled facts for its open row: nothing here is a call's content. */
export const recordFacts = (
  record: UsageRecord,
  toolkitName: string,
): ReadonlyArray<readonly [string, string]> => {
  const approval = approvalText(record.approval);

  return [
    ["Request", record.request_id],
    ["Toolkit", toolkitName],
    ...(record.tool_id === undefined ? [] : [["Tool", record.tool_id] as const]),
    ...(record.outcome === undefined ? [] : [["Outcome", outcomeText(record.outcome)] as const]),
    ...(approval === undefined || record.approval === "none"
      ? []
      : [["Approval", approval] as const]),
    ["Credential", credentialText(record.credential)],
    ["Cost", record.cost_micros === undefined ? "Not recorded" : formatCost(record.cost_micros)],
    ...(record.request_bytes === undefined
      ? []
      : [["Arguments size", formatBytes(record.request_bytes)] as const]),
    ...(record.response_bytes === undefined
      ? []
      : [["Result size", formatBytes(record.response_bytes)] as const]),
    ...(record.browser_ms === undefined
      ? []
      : [["Browser time", formatDuration(record.browser_ms)] as const]),
    ...(record.computer_ms === undefined
      ? []
      : [["Computer time", formatDuration(record.computer_ms)] as const]),
    ...(record.agent_id === undefined ? [] : [["Agent", record.agent_id] as const]),
    ...(record.run_id === undefined ? [] : [["Agent run", record.run_id] as const]),
    ["Latency", formatLatency(record.latency_ms)],
  ];
};

/** A figure of the totals: its label, its value and whether it is bad news. */
export type Figure = readonly [string, string, boolean?];

/**
 * The headline figures of tool calls: how many, how many did not complete (the server counts every outcome but
 * `success` as failed, so a call that waited for approval counts, and none is painted as bad news here), what they
 * cost and how long they took.
 */
export const toolHeadline = (totals: UsageTotals): ReadonlyArray<Figure> => [
  ["Calls", formatCount(totals.requests)],
  ["Not completed", formatCount(totals.failed)],
  ["Cost", formatCost(totals.cost_micros)],
  ["Average latency", totals.requests === 0 ? "None" : formatLatency(totals.avg_latency_ms)],
];

/** The time the browser and the computer ran, as detail figures: only where there was some. */
export const toolDetails = (totals: UsageTotals): ReadonlyArray<Figure> => [
  ...((totals.browser_ms ?? 0) > 0
    ? [["Browser time", formatDuration(totals.browser_ms ?? 0)] as const]
    : []),
  ...((totals.computer_ms ?? 0) > 0
    ? [["Computer time", formatDuration(totals.computer_ms ?? 0)] as const]
    : []),
];

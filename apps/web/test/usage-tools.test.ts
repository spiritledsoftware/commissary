// The Usage page's tool calls (src/lib/usage-tools.ts, #209, ADR 0038): outcomes, approvals, credentials and sizes in
// words, a record's facts (never its content), and the figures of the totals.
import { describe, expect, it } from "vitest";
import type { UsageRecord, UsageTotals } from "@commissary/contract/usage";
import {
  approvalText,
  approvalWord,
  credentialText,
  formatBytes,
  isCall,
  outcomeFailed,
  outcomeText,
  outcomeWord,
  recordFacts,
  recordSubject,
  toolDetails,
  toolHeadline,
} from "../src/lib/usage-tools.ts";

const record = (patch: Partial<UsageRecord> = {}): UsageRecord => ({
  timestamp: "2026-10-10T12:00:00.000Z",
  latency_ms: 840,
  ttft_ms: 0,
  auth_index: "",
  provider: "",
  model: "",
  alias: "",
  endpoint: "/mcp",
  api_key: "key:abc",
  request_id: "req_1",
  failed: false,
  stream: false,
  fail: { status_code: 200 },
  reasoning_effort: "",
  service_tier: "",
  token_breakdown: {
    total_tokens: 0,
    input: { total_tokens: 0, uncached_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    output: { total_tokens: 0, reasoning_tokens: 0 },
    unclassified_tokens: 0,
  },
  area: "tools",
  toolkit_id: "tk_1",
  tool_id: "tk_1:create_issue",
  outcome: "success",
  credential: "shared",
  request_bytes: 812,
  response_bytes: 4_200,
  approval: "none",
  cost_micros: 2000,
  ...patch,
});

describe("outcomes", () => {
  it("say what became of the call, and only a failed tool or upstream or a closed limit is bad news", () => {
    expect(outcomeText("success")).toBe("Succeeded");
    expect(outcomeText("refused")).toContain("spend limit");
    expect(outcomeWord("approval_pending")).toBe("Waiting");
    expect(outcomeWord("needs_credential")).toBe("Needs credential");

    expect(
      (
        [
          "success",
          "tool_error",
          "upstream_failure",
          "refused",
          "needs_credential",
          "approval_pending",
          "not_approved",
        ] as const
      ).filter(outcomeFailed),
    ).toEqual(["tool_error", "upstream_failure", "refused"]);
  });

  it("say how an approval rule decided the call, and show a word only where a rule applied", () => {
    expect(approvalText("approved_panel")).toBe("Approved on its approval page");
    expect(approvalText("pending")).toBe("Waiting for its approver");
    expect(approvalText(undefined)).toBeUndefined();
    expect(approvalWord("none")).toBeUndefined();
    expect(approvalWord(undefined)).toBeUndefined();
    expect(approvalWord("approved_elicitation")).toBe("Approved");
    expect(approvalWord("approved_panel")).toBe("Approved");
    expect(approvalWord("denied")).toBe("Denied");
    expect(approvalWord("pending")).toBe("Pending");
  });
});

/** What a browser or sandbox session writes when it closes: no tool, no outcome. */
const session = (patch: Partial<UsageRecord>): UsageRecord => {
  const { tool_id: _tool, outcome: _outcome, ...rest } = record();

  return { ...rest, ...patch };
};

describe("a record", () => {
  it("is a call when it names a tool, else a browser or a sandbox session closing", () => {
    expect(isCall(record())).toBe(true);
    expect(isCall(session({ browser_ms: 60_000 }))).toBe(false);
    expect(recordSubject(record())).toBe("create_issue");
    expect(recordSubject(session({ browser_ms: 60_000 }))).toBe("Browser session");
    expect(recordSubject(session({ computer_ms: 60_000 }))).toBe("Computer session");
  });

  it("opens to facts about the call: its toolkit, tool, outcome, credential, cost and the sizes of what was sent", () => {
    const facts = Object.fromEntries(recordFacts(record({ approval: "approved_panel" }), "linear"));

    expect(facts).toMatchObject({
      Toolkit: "linear",
      Tool: "tk_1:create_issue",
      Outcome: "Succeeded",
      Approval: "Approved on its approval page",
      Credential: "The org's shared credential",
      Cost: "$0.0020",
      "Arguments size": "812 B",
      "Result size": "4.2 kB",
      Latency: "840 ms",
    });
  });

  it("shows no approval line when no rule applied, and only sizes of the arguments and result", () => {
    const facts = recordFacts(record(), "linear");

    expect(facts.map(([label]) => label)).not.toContain("Approval");
    expect(facts.map(([label]) => label)).toEqual([
      "Request",
      "Toolkit",
      "Tool",
      "Outcome",
      "Credential",
      "Cost",
      "Arguments size",
      "Result size",
      "Latency",
    ]);
  });

  it("shows browser and computer time and the agent run a record comes from", () => {
    const facts = Object.fromEntries(
      recordFacts(
        record({ browser_ms: 3_600_000, computer_ms: 120_000, agent_id: "ag_1", run_id: "run_1" }),
        "browser",
      ),
    );

    expect(facts).toMatchObject({
      "Browser time": "1 h",
      "Computer time": "2 min",
      Agent: "ag_1",
      "Agent run": "run_1",
    });
  });

  it("says whose credential served it, a private one included, or none", () => {
    expect(credentialText("private")).toBe("A private credential");
    expect(credentialText(undefined)).toBe("None");
  });

  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_500)).toBe("1.5 kB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
  });
});

describe("the totals", () => {
  const totals: UsageTotals = {
    requests: 120,
    failed: 7,
    input_tokens: 0,
    uncached_input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    unclassified_tokens: 0,
    total_tokens: 0,
    cost_micros: 1_240_000,
    unpriced_requests: 0,
    avg_latency_ms: 1_200,
    avg_ttft_ms: null,
  };

  it("lead with calls, those that did not complete, their cost and their latency", () => {
    expect(toolHeadline(totals)).toEqual([
      ["Calls", "120"],
      ["Not completed", "7"],
      ["Cost", "$1.24"],
      ["Average latency", "1.2 s"],
    ]);
    expect(toolHeadline({ ...totals, requests: 0, failed: 0 })[3]).toEqual([
      "Average latency",
      "None",
    ]);
  });

  it("add browser and computer time only where there was some", () => {
    expect(toolDetails(totals)).toEqual([]);
    expect(toolDetails({ ...totals, browser_ms: 5_400_000, computer_ms: 60_000 })).toEqual([
      ["Browser time", "1 h 30 min"],
      ["Computer time", "1 min"],
    ]);
  });
});

// The Usage page's tool calls (src/lib/usage-tools.ts, #209, ADR 0038): outcomes, approvals, credentials and sizes in
// words, a record's facts (never its content), and the figures of the totals.
import { describe, expect, it } from "vitest";
import type { UsageRecord, UsageTotals } from "@commissary/contract/usage";
import {
  approvalText,
  approvalWord,
  meteredDuration,
  browserTimeText,
  computerTimeText,
  credentialText,
  formatBytes,
  hasBrowserTime,
  hasComputerTime,
  isCall,
  latencyText,
  outcomeFailed,
  outcomeText,
  outcomeWord,
  profileFact,
  recordFacts,
  recordSubject,
  resultWord,
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
    const facts = Object.fromEntries(
      recordFacts(record({ approval: "approved_panel" }), "linear", true, undefined),
    );

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
    const facts = recordFacts(record(), "linear", true, undefined);

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
        true,
        undefined,
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

describe("the totals", () => {
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
    expect(toolDetails(totals, true)).toEqual([]);
    expect(toolDetails({ ...totals, browser_ms: 5_400_000, computer_ms: 60_000 }, true)).toEqual([
      ["Browser time", "1 h 30 min"],
      ["Computer time", "1 min"],
    ]);
  });
});

describe("browser usage (#217)", () => {
  it("words a record's browser time, for a Quick Action's call and for a session closing alike", () => {
    expect(browserTimeText(2_300)).toBe("2.3 s of browser time");
    expect(browserTimeText(5_400_000)).toBe("1 h 30 min of browser time");
    expect(browserTimeText(undefined)).toBeUndefined();
    expect(meteredDuration(840)).toBe("840 ms");
    expect(meteredDuration(754_000)).toBe("12 min");
    expect(recordSubject(record({ browser_ms: 2_300 }))).toBe("create_issue");
    expect(recordSubject(session({ browser_ms: 5_400_000, cost_micros: 6_000_000 }))).toBe(
      "Browser session",
    );
  });

  it("gives a breakdown a column of browser time only where a row used some", () => {
    expect(hasBrowserTime([{}, {}])).toBe(false);
    expect(hasBrowserTime([{ browser_ms: 0 }])).toBe(false);
    expect(hasBrowserTime([{}, { browser_ms: 1_000 }])).toBe(true);
  });

  it("shows browser time, its cost and the profile in a session's facts, with no latency", () => {
    const facts = recordFacts(
      session({ browser_ms: 1_800_000, cost_micros: 3_000_000, browser_profile_id: "bp_1" }),
      "browser",
      true,
      "marketing",
    );

    expect(Object.fromEntries(facts)).toMatchObject({
      "Browser time": "30 min",
      Cost: "$3.00",
      Profile: "marketing",
      Outcome: "Closed",
    });

    expect(facts.map(([label]) => label)).not.toContain("Latency");
  });

  it("leaves a session's latency empty and says it closed, where a call shows both", () => {
    expect(latencyText(session({ browser_ms: 1_000 }))).toBeUndefined();
    expect(resultWord(session({ browser_ms: 1_000 }))).toBe("Closed");
    expect(latencyText(record())).toBe("840 ms");
    expect(resultWord(record())).toBe("OK");
    expect(resultWord(record({ outcome: "tool_error" }))).toBe("Tool error");
  });

  it("names the profile a session opened from where the caller manages it", () => {
    const names = new Map([["bp_1", "marketing"]]);

    expect(profileFact(session({ browser_profile_id: "bp_1" }), names)).toBe("marketing");
    expect(profileFact(session({ browser_profile_id: "bp_9" }), names)).toMatch(/do not manage/);
    expect(profileFact(session({}), names)).toBeUndefined();
  });

  it("hides browser time, not the records, where the deployment has no browser (ADR 0043)", () => {
    expect(toolDetails({ ...totals, browser_ms: 5_400_000 }, false)).toEqual([]);

    const closed = session({ browser_ms: 1_000, cost_micros: 5 });

    expect(
      Object.keys(
        Object.fromEntries(recordFacts(record({ browser_ms: 1_000 }), "x", false, undefined)),
      ),
    ).not.toContain("Browser time");

    // A historical session record keeps its label and its cost.
    expect(recordSubject(closed)).toBe("Browser session");
    expect(Object.fromEntries(recordFacts(closed, "x", false, undefined))).toMatchObject({
      Cost: "<$0.0001",
    });
  });
});

describe("computer usage (#225)", () => {
  it("words a record's computer time as the log shows it, beside any browser time", () => {
    expect(computerTimeText(754_000)).toBe("12 min of computer time");
    expect(computerTimeText(5_400_000)).toBe("1 h 30 min of computer time");
    expect(computerTimeText(2_300)).toBe("2.3 s of computer time");
    expect(computerTimeText(undefined)).toBeUndefined();
    expect(recordSubject(session({ computer_ms: 754_000, cost_micros: 100 }))).toBe(
      "Computer session",
    );
  });

  it("gives a breakdown a column of computer time only where a row used some", () => {
    expect(hasComputerTime([{}, {}])).toBe(false);
    expect(hasComputerTime([{ computer_ms: 0 }])).toBe(false);
    expect(hasComputerTime([{}, { computer_ms: 1_000 }])).toBe(true);
  });

  it("shows computer time in a session's facts and the totals, where there is a browser or not", () => {
    for (const browser of [true, false])
      expect(
        Object.fromEntries(
          recordFacts(
            session({ computer_ms: 1_800_000, cost_micros: 3_000_000 }),
            "sandbox",
            browser,
            undefined,
          ),
        ),
      ).toMatchObject({ "Computer time": "30 min", Toolkit: "sandbox", Outcome: "Closed" });
  });
});

// The org's retention periods in the panel (src/lib/retention.ts, ADR 0027): usage records' and agent runs' (#228), how
// each is worded, what the forms accept and the body of `PATCH /org` each sends.
import { describe, expect, it } from "vitest";
import {
  parseRetentionDays,
  retentionPayload,
  retentionSentence,
  suggestedDays,
} from "../src/lib/retention.ts";

describe("retentionSentence", () => {
  it("words the usage records' period", () => {
    expect(retentionSentence(90)).toBe("Usage records are kept for 90 days.");
    expect(retentionSentence(1, "usage")).toBe("Usage records are kept for 1 day.");
    expect(retentionSentence(null)).toBe("Usage records are kept until the org is deleted.");
  });

  it("words the agent runs' period, counted from their last activity", () => {
    expect(retentionSentence(30, "runs")).toBe(
      "Agent runs are kept for 30 days after their last activity.",
    );
    expect(retentionSentence(null, "runs")).toBe("Agent runs are kept until the org is deleted.");
  });
});

describe("retentionPayload", () => {
  it("sets the period of what it names, and only that", () => {
    expect(retentionPayload("usage", 90)).toEqual({ usage_retention_days: 90 });
    expect(retentionPayload("runs", 7)).toEqual({ run_retention_days: 7 });
    expect(retentionPayload("runs", null)).toEqual({ run_retention_days: null });
  });
});

describe("suggestedDays", () => {
  it("suggests each period's default for a new org", () => {
    expect(suggestedDays("usage")).toBe(90);
    expect(suggestedDays("runs")).toBe(30);
  });
});

describe("parseRetentionDays", () => {
  it.each([
    ["30", 30],
    [" 1 ", 1],
    ["3650", 3650],
  ])("accepts %j", (text, days) => {
    expect(parseRetentionDays(text)).toBe(days);
  });

  it.each(["0", "3651", "1.5", "-1", "", "ten"])("refuses %j", (text) => {
    expect(parseRetentionDays(text)).toBeUndefined();
  });
});

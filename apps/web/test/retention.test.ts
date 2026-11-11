// The org's retention periods in the panel (src/lib/retention.ts, ADR 0027): usage records', how it
// is worded, what the form accepts and the body of `PATCH /org` it sends.
import { describe, expect, it } from "vitest";
import { parseRetentionDays, retentionPayload, retentionSentence } from "../src/lib/retention.ts";

describe("retentionSentence", () => {
  it("words the usage records' period", () => {
    expect(retentionSentence(90)).toBe("Usage records are kept for 90 days.");
    expect(retentionSentence(1)).toBe("Usage records are kept for 1 day.");
    expect(retentionSentence(null)).toBe("Usage records are kept until the org is deleted.");
  });
});

describe("retentionPayload", () => {
  it("sets the usage records' period, and only that", () => {
    expect(retentionPayload(90)).toEqual({ usage_retention_days: 90 });
    expect(retentionPayload(null)).toEqual({ usage_retention_days: null });
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

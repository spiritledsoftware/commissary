// The reporter stamps a record with the caller's member and with whether a private credential served it (ADR 0023).
import { describe, expect, it } from "vite-plus/test";
import { GLOBAL_ORG } from "@commissary/core";
import { emptyUsageDetail } from "../../src/usage/record.ts";
import { UsageReporter, type UsageReporterInit } from "../../src/usage/reporter.ts";

const init = (extra: Partial<UsageReporterInit> = {}): UsageReporterInit => ({
  requestId: "r",
  provider: "codex",
  executorType: "codex",
  model: "m",
  alias: "m",
  endpoint: "POST /v1/responses",
  principalId: "p",
  orgId: GLOBAL_ORG,
  authId: "a",
  authType: "oauth",
  source: "s",
  stream: false,
  serviceTier: "auto",
  requestedAt: 1000,
  ...extra,
});

describe("UsageReporter owner fields", () => {
  it("carries the member and the private flag on the record and on additional models", () => {
    const usage = new UsageReporter(init({ memberId: "mem-a", private: true }));

    usage.publishAdditionalModel("image-model", { ...emptyUsageDetail, totalTokens: 5 });

    expect(usage.additionalRecords(2000)).toEqual([
      expect.objectContaining({ memberId: "mem-a", private: true }),
    ]);
    expect(usage.finish(2000)).toMatchObject({ memberId: "mem-a", private: true });
  });

  it("leaves both out for a shared credential and a request without a member", () => {
    const record = new UsageReporter(init()).finish(2000);

    expect(record).not.toHaveProperty("memberId");
    expect(record).not.toHaveProperty("private");
  });
});

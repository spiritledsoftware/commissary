// Devin account-wide quota exhaustion (CLIProxyAPI b946d54e, helps/devin_quota_test.go).
import { describe, expect, it } from "vitest";
import { ExecutionError } from "../../src/executor/errors.ts";
import {
  devinQuotaRetryAfterMs,
  devinQuotaScopedError,
  devinUsageQuotaExhaustionPeriod,
} from "../../src/executor/devin/quota.ts";

describe("devinUsageQuotaExhaustionPeriod", () => {
  const cases: ReadonlyArray<readonly [string, string, "daily" | "weekly" | undefined]> = [
    ["weekly exact", "Your weekly usage quota has been exhausted.", "weekly"],
    ["daily exact", "Your daily usage quota has been exhausted.", "daily"],
    ["case-insensitive", "YOUR WEEKLY USAGE QUOTA HAS BEEN EXHAUSTED.", "weekly"],
    [
      "wrapped trailer text",
      "devin upstream error (failed_precondition): Your weekly usage quota has been exhausted.",
      "weekly",
    ],
    [
      "weekly wins when both named",
      "Your daily and weekly usage quota has been exhausted.",
      "weekly",
    ],
    ["monthly ACU out of scope", "User monthly ACU quota exhausted (trace ID: 12345)", undefined],
    ["rate limit without quota", "Rate limit exceeded. Please slow down.", undefined],
    ["weekly without exhausted", "Your weekly usage quota is nearly used up.", undefined],
    ["quota without period", "Usage quota exhausted.", undefined],
    ["weekly without quota", "Your weekly allowance has been exhausted.", undefined],
    ["empty", "", undefined],
  ];

  for (const [name, message, want] of cases) {
    it(name, () => expect(devinUsageQuotaExhaustionPeriod(message)).toBe(want));
  }
});

describe("devinQuotaRetryAfterMs", () => {
  const now = Date.UTC(2026, 9, 16, 15, 37, 9);
  const HOUR = 3_600_000;
  const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

  const cases: ReadonlyArray<readonly [string, string, number | undefined]> = [
    ["valid future weekly reset", iso(now + 72 * HOUR), 72 * HOUR],
    ["valid future daily reset", iso(now + 3 * HOUR), 3 * HOUR],
    ["past reset", iso(now - 60_000), undefined],
    ["reset exactly now", iso(now), undefined],
    ["far future reset rejected", iso(now + 30 * 24 * HOUR), undefined],
    ["unparseable", "not-a-time", undefined],
    ["empty", "", undefined],
    ["whitespace trimmed", `  ${iso(now + HOUR)}  `, HOUR],
  ];

  for (const [name, signal, want] of cases) {
    it(name, () => expect(devinQuotaRetryAfterMs(signal, now)).toBe(want));
  }
});

describe("devinQuotaScopedError", () => {
  const now = Date.UTC(2026, 9, 16, 15, 37, 9);
  const reset = new Date(now + 5 * 3_600_000).toISOString().replace(".000Z", "Z");
  const signals = { daily_quota_reset_at: reset };

  const quota = (extra: { message?: string; status?: number; retryAfterMs?: number } = {}) => ({
    status: 429,
    message: "Your daily usage quota has been exhausted.",
    ...extra,
  });

  it("makes a daily quota 429 credential-scoped and retries at the observed reset", () => {
    const scoped = devinQuotaScopedError(new ExecutionError(quota()), signals, now);

    expect(scoped.credentialScoped).toBe(true);
    expect(scoped.retryAfterMs).toBe(5 * 3_600_000);
  });

  it("scopes without a delay when the matching reset was not observed", () => {
    const scoped = devinQuotaScopedError(
      new ExecutionError(quota({ message: "Your weekly usage quota has been exhausted." })),
      signals,
      now,
    );

    expect(scoped.credentialScoped).toBe(true);
    expect(scoped.retryAfterMs).toBeUndefined();
  });

  it("keeps an explicit Retry-After", () => {
    const scoped = devinQuotaScopedError(
      new ExecutionError(quota({ retryAfterMs: 7000 })),
      signals,
      now,
    );

    expect(scoped.credentialScoped).toBe(true);
    expect(scoped.retryAfterMs).toBe(7000);
  });

  it("leaves other errors alone", () => {
    for (const error of [
      new ExecutionError(quota({ message: "Rate limit exceeded." })),
      new ExecutionError(quota({ status: 502 })),
    ]) {
      expect(devinQuotaScopedError(error, signals, now)).toBe(error);
    }
  });
});

// The panel's quota reading (src/lib/quota.ts) and figure formatting (src/lib/format.ts).
import { describe, expect, it } from "vite-plus/test";
import type { CredentialEntry } from "@commissary/contract/credentials";
import { formatCount, formatDuration, formatPercent, formatTokens } from "../src/lib/format.ts";
import { accountName, assess } from "../src/lib/accounts.ts";
import {
  accountStanding,
  byUrgency,
  quotaReading,
  quotaWindows,
  windowLabel,
  windowPace,
} from "../src/lib/quota.ts";

const entry = (
  overrides: Partial<CredentialEntry> & Pick<CredentialEntry, "name" | "provider">,
): CredentialEntry => ({
  id: overrides.name,
  auth_index: "0",
  type: overrides.provider,
  label: "",
  status: "active",
  status_message: "",
  disabled: false,
  unavailable: false,
  runtime_only: false,
  source: "file",
  size: 0,
  success: 0,
  failed: 0,
  recent_requests: [],
  quota: { signals: {} },
  cooldowns: [],
  ...overrides,
});

const RESET = "2026-10-10T18:00:00.000Z";

describe("quotaWindows", () => {
  it("reads Claude's unified utilization fractions, whatever the header case", () => {
    const windows = quotaWindows(
      entry({
        name: "claude.json",
        provider: "claude",
        quota: {
          signals: {
            "Anthropic-Ratelimit-Unified-5h-Utilization": "0.69",
            "Anthropic-Ratelimit-Unified-5h-Reset": "1791655200",
            "anthropic-ratelimit-unified-7d-utilization": "1.2",
          },
        },
      }),
    );

    expect(windows).toEqual([
      { label: "5-hour", usedPercent: 69, resetsAt: 1_791_655_200_000, seconds: 18_000 },
      { label: "Weekly", usedPercent: 100, resetsAt: undefined, seconds: 604_800 },
    ]);
  });

  it("reads Codex windows and derives the reset from the observation time", () => {
    const windows = quotaWindows(
      entry({
        name: "codex.json",
        provider: "codex",
        quota: {
          observed_at: "2026-10-10T12:00:00.000Z",
          signals: {
            "X-Codex-Primary-Used-Percent": "42",
            "X-Codex-Primary-Window-Minutes": "300",
            "X-Codex-Primary-Reset-After-Seconds": "600",
            "X-Codex-Secondary-Used-Percent": "85",
            "X-Codex-Secondary-Window-Minutes": "10080",
            "X-Codex-Secondary-Reset-At": RESET,
          },
        },
      }),
    );

    expect(windows).toEqual([
      {
        label: "5-hour",
        usedPercent: 42,
        resetsAt: Date.parse("2026-10-10T12:10:00.000Z"),
        seconds: 18_000,
      },
      { label: "Weekly", usedPercent: 85, resetsAt: Date.parse(RESET), seconds: 604_800 },
    ]);
  });

  it("turns Devin's remaining percentages into use", () => {
    const windows = quotaWindows(
      entry({
        name: "devin.json",
        provider: "devin",
        quota: {
          signals: {
            daily_quota_remaining_percent: "25%",
            daily_quota_reset_at: RESET,
            weekly_quota_remaining_percent: "90%",
          },
        },
      }),
    );

    expect(windows).toEqual([
      { label: "Daily", usedPercent: 75, resetsAt: Date.parse(RESET), seconds: 86_400 },
      { label: "Weekly", usedPercent: 10, resetsAt: undefined, seconds: 604_800 },
    ]);
  });

  it("is empty without signals or for providers that send none", () => {
    expect(quotaWindows(entry({ name: "c.json", provider: "claude" }))).toEqual([]);
    expect(
      quotaWindows(
        entry({ name: "g.json", provider: "gemini", quota: { signals: { "x-anything": "1" } } }),
      ),
    ).toEqual([]);
  });

  it("prefers the quota check when it is fresher than the last response", () => {
    const headers = {
      observed_at: "2026-10-10T12:00:00.000Z",
      signals: { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
    };

    const report = (refreshedAt: string) => ({
      checked_at: refreshedAt,
      refreshed_at: refreshedAt,
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          used_percent: 70,
          resets_at: RESET,
          window_seconds: 18_000,
        },
        { id: "seven_day_opus", label: "Weekly Opus", used_percent: 120 },
      ],
    });

    const fresher = quotaReading(
      entry({
        name: "c.json",
        provider: "claude",
        quota: headers,
        quota_report: report("2026-10-10T12:30:00.000Z"),
      }),
    );

    expect(fresher).toEqual({
      source: "check",
      readAt: Date.parse("2026-10-10T12:30:00.000Z"),
      windows: [
        { label: "5-hour", usedPercent: 70, resetsAt: Date.parse(RESET), seconds: 18_000 },
        { label: "Weekly Opus", usedPercent: 100, resetsAt: undefined, seconds: undefined },
      ],
    });

    const older = quotaReading(
      entry({
        name: "c.json",
        provider: "claude",
        quota: headers,
        quota_report: report("2026-10-10T11:00:00.000Z"),
      }),
    );

    expect(older.source).toBe("response");
    expect(older.windows.map((window) => window.usedPercent)).toEqual([50]);

    // A failed check without an earlier success has no figures: the headers stay.
    expect(
      quotaReading(
        entry({
          name: "c.json",
          provider: "claude",
          quota: headers,
          quota_report: { checked_at: RESET, windows: [], error: "unauthorized" },
        }),
      ).source,
    ).toBe("response");

    // Checked figures for a provider that sends no headers.
    expect(
      quotaReading(
        entry({ name: "k.json", provider: "kimi", quota_report: report("2026-10-10T11:00:00Z") }),
      ).source,
    ).toBe("check");
  });

  it("labels window lengths", () => {
    expect([10_080, 1440, 4320, 300, 45].map(windowLabel)).toEqual([
      "Weekly",
      "Daily",
      "3-day",
      "5-hour",
      "45-minute",
    ]);
  });
});

describe("accountStanding", () => {
  it("is cut off by a credential-wide cooldown, which sets the next reset", () => {
    const standing = accountStanding(
      entry({
        name: "claude.json",
        provider: "claude",
        quota: { signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" } },
        cooldowns: [
          {
            scope: "model",
            model_key: "m",
            reason: "quota",
            retry_at: "2026-10-10T13:00:00Z",
            remaining_seconds: 60,
          },
          { scope: "credential", reason: "quota", retry_at: RESET, remaining_seconds: 600 },
        ],
      }),
    );

    expect(standing.level).toBe("out");
    expect(standing.cutOffUntil).toBe(Date.parse(RESET));
    expect(standing.nextReset).toBe(Date.parse(RESET));
  });

  it("follows the fullest window", () => {
    const standing = accountStanding(
      entry({
        name: "codex.json",
        provider: "codex",
        quota: {
          signals: {
            "x-codex-primary-used-percent": "30",
            "x-codex-secondary-used-percent": "80",
            "x-codex-secondary-reset-at": RESET,
          },
        },
      }),
    );

    expect(standing).toMatchObject({
      level: "near",
      peakPercent: 80,
      nextReset: Date.parse(RESET),
      nextResetWindow: "Long",
      cutOffUntil: undefined,
    });
  });

  it("is out when the credential is failing", () => {
    expect(
      accountStanding(entry({ name: "c.json", provider: "claude", status: "error" })).level,
    ).toBe("out");
  });
});

describe("windowPace", () => {
  const HOUR = 3_600_000;
  const resetsAt = Date.parse(RESET);
  // A 5-hour allowance read 3 hours before it renews: 2 of its 5 hours (40%) had passed.
  const readAt = resetsAt - 3 * HOUR;
  const now = readAt + 10 * 60_000;

  const fiveHour = (usedPercent: number) => ({
    label: "5-hour",
    usedPercent,
    resetsAt,
    seconds: 18_000,
  });

  it("is ahead of pace when the share used runs more than 5 points past the share of the period passed", () => {
    expect(windowPace(fiveHour(62), readAt, now)).toEqual({
      elapsedPercent: 40,
      points: 22,
      verdict: "ahead",
    });
  });

  it("is on pace within 5 points either way, and behind beyond that", () => {
    const verdicts = [46, 45, 40, 35, 34].map((used) => {
      const pace = windowPace(fiveHour(used), readAt, now);

      return [pace?.points, pace?.verdict];
    });

    expect(verdicts).toEqual([
      [6, "ahead"],
      [5, "on"],
      [0, "on"],
      [5, "on"],
      [6, "behind"],
    ]);
  });

  it("rounds the distance to whole points the same way on both sides of an even rate", () => {
    const verdicts = [45.4, 45.5, 34.6, 34.5].map((used) => {
      const pace = windowPace(fiveHour(used), readAt, now);

      return [pace?.points, pace?.verdict];
    });

    expect(verdicts).toEqual([
      [5, "on"],
      [6, "ahead"],
      [5, "on"],
      [6, "behind"],
    ]);
  });

  it("measures the period passed when the figures were read, whatever the time now", () => {
    // Read 4 hours before the reset (20% passed), shown 2 hours later.
    const stale = windowPace(fiveHour(30), resetsAt - 4 * HOUR, resetsAt - 2 * HOUR);
    // Read 2 hours before the reset (60% passed).
    const fresh = windowPace(fiveHour(30), resetsAt - 2 * HOUR, resetsAt - 2 * HOUR);

    expect(stale).toEqual({ elapsedPercent: 20, points: 10, verdict: "ahead" });
    expect(fresh).toEqual({ elapsedPercent: 60, points: 30, verdict: "behind" });
  });

  it("has no pace without the allowance's length, a reset or a reading time", () => {
    expect(windowPace({ ...fiveHour(62), seconds: undefined }, readAt, now)).toBeUndefined();
    expect(windowPace({ ...fiveHour(62), resetsAt: undefined }, readAt, now)).toBeUndefined();
    expect(windowPace(fiveHour(62), undefined, now)).toBeUndefined();
  });

  it("has no pace once the reset has passed", () => {
    expect(windowPace(fiveHour(62), readAt, resetsAt)).toBeUndefined();
    expect(windowPace(fiveHour(62), readAt, resetsAt + HOUR)).toBeUndefined();
  });

  it("has no pace when the figures were read outside the allowance's period", () => {
    expect(windowPace(fiveHour(62), resetsAt - 6 * HOUR, now)).toBeUndefined();
    expect(windowPace(fiveHour(62), resetsAt, now)).toBeUndefined();
  });

  it("has no pace for a used-up allowance", () => {
    expect(windowPace(fiveHour(100), readAt, now)).toBeUndefined();
  });
});

describe("byUrgency", () => {
  it("orders cut off, near, fuller, without data, then disabled", () => {
    const claude = (name: string, utilization: string) =>
      entry({
        name,
        provider: "claude",
        quota: { signals: { "anthropic-ratelimit-unified-5h-utilization": utilization } },
      });

    const accounts = [
      entry({ name: "disabled.json", provider: "claude", disabled: true, status: "error" }),
      entry({ name: "no-data.json", provider: "gemini" }),
      claude("low.json", "0.1"),
      claude("mid.json", "0.5"),
      claude("near.json", "0.9"),
      entry({
        name: "cut.json",
        provider: "claude",
        cooldowns: [
          { scope: "credential", reason: "quota", retry_at: RESET, remaining_seconds: 1 },
        ],
      }),
    ];

    expect(accounts.toSorted(byUrgency).map((account) => account.name)).toEqual([
      "cut.json",
      "near.json",
      "mid.json",
      "low.json",
      "no-data.json",
      "disabled.json",
    ]);
  });
});

describe("accounts", () => {
  it("names an account by its address, never by its provider", () => {
    expect(accountName(entry({ name: "a.json", provider: "claude", email: "me@x.dev" }))).toBe(
      "me@x.dev",
    );
    expect(accountName(entry({ name: "xai-1.json", provider: "xai", label: "xai" }))).toBe(
      "xai-1.json",
    );
  });

  it("says what needs attention", () => {
    expect(assess(entry({ name: "a.json", provider: "claude", disabled: true }))).toMatchObject({
      closed: false,
      note: "Disabled",
      tone: "disabled",
    });
    expect(
      assess(
        entry({ name: "a.json", provider: "claude", status: "error", status_message: "expired" }),
      ),
    ).toMatchObject({ closed: true, note: "Failing: expired", tone: "closed" });
    expect(assess(entry({ name: "a.json", provider: "claude" }))).toMatchObject({
      closed: false,
      note: undefined,
      tone: undefined,
    });
  });
});

describe("format", () => {
  it("prints counts, tokens and percentages", () => {
    expect(formatCount(1204)).toBe("1,204");
    expect([18_200_000, 7400, 312, 2_500_000_000].map(formatTokens)).toEqual([
      "18.2 M",
      "7.4 k",
      "312",
      "2.5 B",
    ]);
    expect([68.6, 0.4, 0, 100].map(formatPercent)).toEqual(["69%", "<1%", "0%", "100%"]);
  });

  it("spells durations in their two largest units", () => {
    const minute = 60_000;

    expect(
      [
        30_000,
        12 * minute,
        155 * minute,
        120 * minute,
        (4 * 24 + 3) * 60 * minute,
        2 * 1440 * minute,
      ].map(formatDuration),
    ).toEqual(["under 1 min", "12 min", "2 h 35 min", "2 h", "4 d 3 h", "2 d"]);
  });
});

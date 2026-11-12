// The panel's window history (src/lib/history.ts): hourly usage points summed into past quota windows and days.
import { describe, expect, it } from "vite-plus/test";
import type { UsagePoint } from "@commissary/contract/usage";
import { dailyHistory, MAX_BARS, windowHistory } from "../src/lib/history.ts";

const HOUR = 3_600_000;

const point = (start: number, tokens: number, requests = 1): UsagePoint => ({
  start,
  requests,
  failed: 0,
  total_tokens: tokens,
  cost_micros: 0,
});

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

describe("windowHistory", () => {
  it("sums points into windows counted back from the reset, the current one last", () => {
    const resetsAt = NOW + 2 * HOUR;

    const points = [
      point(NOW - 1 * HOUR, 100),
      point(NOW - 2 * HOUR, 50),
      point(NOW - 4 * HOUR, 7), // the window before: [now-8h, now-3h)
      point(NOW - 9 * HOUR, 3), // two windows back
    ];

    const bars = windowHistory(points, { resetsAt, seconds: 5 * 3600 }, NOW - 13 * HOUR, NOW);

    expect(bars.map((bar) => [bar.tokens, bar.current])).toEqual([
      [3, false],
      [7, false],
      [150, true],
    ]);
    expect(bars.at(-1)).toMatchObject({ start: resetsAt - 5 * HOUR, end: resetsAt, requests: 2 });
  });

  it("rolls a reset already past forward to the window in progress", () => {
    const bars = windowHistory(
      [point(NOW - HOUR, 10)],
      { resetsAt: NOW - 2 * HOUR, seconds: 5 * 3600 },
      NOW - 4 * HOUR,
      NOW,
    );

    expect(bars.at(-1)).toMatchObject({
      start: NOW - 2 * HOUR,
      end: NOW + 3 * HOUR,
      tokens: 10,
      current: true,
    });
  });

  it("keeps at most MAX_BARS windows and none that began before the series", () => {
    const hourly = windowHistory(
      [],
      { resetsAt: NOW + HOUR, seconds: 3600 },
      NOW - 1000 * HOUR,
      NOW,
    );

    expect(hourly).toHaveLength(MAX_BARS);

    const weekly = windowHistory(
      [],
      { resetsAt: NOW + HOUR, seconds: 7 * 24 * 3600 },
      NOW - 30 * 24 * HOUR,
      NOW,
    );

    expect(weekly).toHaveLength(4);
  });

  it("is empty for a window without a length", () => {
    expect(windowHistory([], { resetsAt: NOW, seconds: 0 }, 0, NOW)).toEqual([]);
  });
});

describe("dailyHistory", () => {
  it("gives one bar per local day, today last", () => {
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);

    const bars = dailyHistory(
      [point(today.getTime() + HOUR, 5), point(today.getTime() - HOUR, 2)],
      3,
      NOW,
    );

    expect(bars.map((bar) => [bar.tokens, bar.current])).toEqual([
      [0, false],
      [2, false],
      [5, true],
    ]);
  });
});

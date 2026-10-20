// Spend periods (issue #71): the day, week and month a Spend limit counts in, by the org's time zone and first day of
// the week. Pure: the boundaries are epoch milliseconds computed from a time, so DST changes need no clock.
import { describe, expect, it } from "vitest";
import { isTimeZone, periodBounds, type WeekStart } from "@commissary/state/spend";

const at = (iso: string): number => Date.parse(iso);

describe("periodBounds", () => {
  it("a day in UTC runs from midnight to midnight", () => {
    expect(periodBounds("day", at("2026-03-10T15:30:00Z"), "UTC", "monday")).toEqual({
      start: at("2026-03-10T00:00:00Z"),
      end: at("2026-03-11T00:00:00Z"),
    });
  });

  it("a day ends at local midnight in the org's zone", () => {
    // 2026-03-10 in Tokyo (UTC+9) starts at 15:00Z the day before.
    expect(periodBounds("day", at("2026-03-10T14:59:59Z"), "Asia/Tokyo", "monday")).toEqual({
      start: at("2026-03-09T15:00:00Z"),
      end: at("2026-03-10T15:00:00Z"),
    });
    expect(periodBounds("day", at("2026-03-10T15:00:00Z"), "Asia/Tokyo", "monday")).toEqual({
      start: at("2026-03-10T15:00:00Z"),
      end: at("2026-03-11T15:00:00Z"),
    });
  });

  it("the day of a spring-forward change is 23 hours long", () => {
    // New York, 2026-03-08: 02:00 EST jumps to 03:00 EDT.
    const bounds = periodBounds("day", at("2026-03-08T16:00:00Z"), "America/New_York", "monday");

    expect(bounds).toEqual({ start: at("2026-03-08T05:00:00Z"), end: at("2026-03-09T04:00:00Z") });
    expect(bounds.end - bounds.start).toBe(23 * 3_600_000);
  });

  it("the day of a fall-back change is 25 hours long", () => {
    // New York, 2026-11-01: 02:00 EDT falls back to 01:00 EST.
    const bounds = periodBounds("day", at("2026-11-01T12:00:00Z"), "America/New_York", "monday");

    expect(bounds).toEqual({ start: at("2026-11-01T04:00:00Z"), end: at("2026-11-02T05:00:00Z") });
    expect(bounds.end - bounds.start).toBe(25 * 3_600_000);
  });

  it("the second just before and after a DST midnight belong to different days", () => {
    const before = periodBounds("day", at("2026-03-09T03:59:59Z"), "America/New_York", "monday");
    const after = periodBounds("day", at("2026-03-09T04:00:00Z"), "America/New_York", "monday");

    expect(before.end).toBe(after.start);
    expect(after.start).toBe(at("2026-03-09T04:00:00Z"));
  });

  it("a week starts on the org's first day of the week", () => {
    // 2026-03-10 is a Tuesday.
    const now = at("2026-03-10T12:00:00Z");

    expect(periodBounds("week", now, "UTC", "monday")).toEqual({
      start: at("2026-03-09T00:00:00Z"),
      end: at("2026-03-16T00:00:00Z"),
    });
    expect(periodBounds("week", now, "UTC", "sunday")).toEqual({
      start: at("2026-03-08T00:00:00Z"),
      end: at("2026-03-15T00:00:00Z"),
    });
  });

  it("a Sunday evening belongs to the week that began on the Monday before", () => {
    expect(periodBounds("week", at("2026-03-15T23:59:59Z"), "UTC", "monday")).toEqual({
      start: at("2026-03-09T00:00:00Z"),
      end: at("2026-03-16T00:00:00Z"),
    });
    expect(periodBounds("week", at("2026-03-16T00:00:00Z"), "UTC", "monday").start).toBe(
      at("2026-03-16T00:00:00Z"),
    );
  });

  it("every first day of the week is understood", () => {
    const starts: ReadonlyArray<[WeekStart, string]> = [
      ["sunday", "2026-03-08T00:00:00Z"],
      ["monday", "2026-03-09T00:00:00Z"],
      ["tuesday", "2026-03-10T00:00:00Z"],
      ["wednesday", "2026-03-04T00:00:00Z"],
      ["thursday", "2026-03-05T00:00:00Z"],
      ["friday", "2026-03-06T00:00:00Z"],
      ["saturday", "2026-03-07T00:00:00Z"],
    ];

    for (const [weekStart, start] of starts)
      expect(periodBounds("week", at("2026-03-10T12:00:00Z"), "UTC", weekStart).start).toBe(
        at(start),
      );
  });

  it("a week over a DST change follows local midnights", () => {
    expect(periodBounds("week", at("2026-03-10T12:00:00Z"), "America/New_York", "monday")).toEqual({
      start: at("2026-03-09T04:00:00Z"),
      end: at("2026-03-16T04:00:00Z"),
    });
    // The week of the change itself starts on EST and ends on EDT: 7 days less an hour.
    expect(periodBounds("week", at("2026-03-08T16:00:00Z"), "America/New_York", "monday")).toEqual({
      start: at("2026-03-02T05:00:00Z"),
      end: at("2026-03-09T04:00:00Z"),
    });
  });

  it("a month runs from the first of the month to the first of the next", () => {
    expect(periodBounds("month", at("2026-02-14T12:00:00Z"), "UTC", "monday")).toEqual({
      start: at("2026-02-01T00:00:00Z"),
      end: at("2026-03-01T00:00:00Z"),
    });
    expect(periodBounds("month", at("2026-12-31T23:59:59Z"), "UTC", "monday")).toEqual({
      start: at("2026-12-01T00:00:00Z"),
      end: at("2027-01-01T00:00:00Z"),
    });
  });

  it("a month changes at local midnight of the first day", () => {
    // Midnight of 2026-02-01 in Tokyo is 2026-01-31T15:00Z.
    expect(periodBounds("month", at("2026-01-31T14:59:59Z"), "Asia/Tokyo", "monday")).toEqual({
      start: at("2025-12-31T15:00:00Z"),
      end: at("2026-01-31T15:00:00Z"),
    });
    expect(periodBounds("month", at("2026-01-31T15:00:00Z"), "Asia/Tokyo", "monday")).toEqual({
      start: at("2026-01-31T15:00:00Z"),
      end: at("2026-02-28T15:00:00Z"),
    });
  });

  it("a month over a DST change follows local midnights", () => {
    expect(periodBounds("month", at("2026-03-20T12:00:00Z"), "America/New_York", "monday")).toEqual(
      {
        start: at("2026-03-01T05:00:00Z"),
        end: at("2026-04-01T04:00:00Z"),
      },
    );
  });
});

describe("periods in zones whose clocks change at midnight", () => {
  // Havana and Cairo spring forward at 00:00 (no local midnight that day), Santiago and Beirut change around it.
  const zones = [
    "America/Havana",
    "Africa/Cairo",
    "America/Santiago",
    "Asia/Beirut",
    "Asia/Kolkata",
  ];

  // The spring and autumn changes of 2025 for these zones fall in these two windows.
  const windows = [
    [at("2025-03-01T00:00:00Z"), at("2025-05-01T00:00:00Z")],
    [at("2025-08-25T00:00:00Z"), at("2025-11-10T00:00:00Z")],
  ] as const;

  const HOUR = 3_600_000;

  it("the day Havana's clocks skip midnight starts at 01:00 and ends at the next day's start", () => {
    // Havana, 2025-03-09: 00:00 CST jumps to 01:00 CDT, so the day begins at 01:00 (05:00Z).
    const bounds = periodBounds("day", at("2025-03-09T12:00:00Z"), "America/Havana", "monday");

    expect(bounds).toEqual({ start: at("2025-03-09T05:00:00Z"), end: at("2025-03-10T04:00:00Z") });
    expect(periodBounds("day", bounds.end, "America/Havana", "monday").start).toBe(bounds.end);
  });

  it("always contains the time it was asked about, and each period begins where the last one ended", () => {
    for (const zone of zones)
      for (const period of ["day", "week", "month"] as const)
        for (const [from, until] of windows)
          for (let now = from; now < until; now += period === "day" ? HOUR : 6 * HOUR) {
            const bounds = periodBounds(period, now, zone, "monday");

            if (!(bounds.start <= now && now < bounds.end))
              throw new Error(
                `${zone} ${period} ${new Date(now).toISOString()} is outside its period`,
              );

            if (periodBounds(period, bounds.end, zone, "monday").start !== bounds.end)
              throw new Error(
                `${zone} ${period} ${new Date(bounds.end).toISOString()} does not begin the next`,
              );
          }
    // A brute-force sweep (every hour or six over several zones and windows): well under a second alone, but past
    // vitest's 5 s default on a loaded CI runner.
  }, 30_000);
});

describe("isTimeZone", () => {
  it("accepts IANA names and refuses anything else", () => {
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("+02:00")).toBe(false);
  });
});

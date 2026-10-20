/**
 * Spend periods (issue #71): the day, week or month a Spend limit counts in. New in the Workers port, no Go counterpart.
 *
 * A period runs from local midnight to local midnight in the org's IANA time zone (a day of a DST change is 23 or 25
 * hours long), a week starts on the org's first day of the week, a month on the first. Pure: the boundaries are epoch
 * milliseconds computed from a time, so tests need no clock.
 */
import { DateTime, Option } from "effect";

export const PERIODS = ["day", "week", "month"] as const;

export type Period = (typeof PERIODS)[number];

export const WEEK_STARTS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export type WeekStart = (typeof WEEK_STARTS)[number];

export const DEFAULT_TIME_ZONE = "UTC";

export const DEFAULT_WEEK_START: WeekStart = "monday";

/** The period containing a time: `start` inclusive, `end` (the start of the next period) exclusive; epoch ms. */
export interface PeriodBounds {
  readonly start: number;
  readonly end: number;
}

/** An IANA zone name the runtime knows (`Europe/Berlin`, `UTC`); offsets such as `+02:00` are not zone names. */
export const isTimeZone = (name: string): boolean =>
  name !== "" && !/^[+-]/.test(name) && Option.isSome(DateTime.zoneMakeNamed(name));

const weekStartsOn = (weekStart: WeekStart): 0 | 1 | 2 | 3 | 4 | 5 | 6 => {
  const index = WEEK_STARTS.indexOf(weekStart);

  // SAFETY: WEEK_STARTS has seven entries, so the index of one of them is 0 to 6.
  return index as 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

const UNIT = { day: "day", week: "week", month: "month" } as const;

const STEP = {
  day: { days: 1 },
  week: { weeks: 1 },
  month: { months: 1 },
} as const;

/** The `period` that contains `now` in `timeZone`; the zone must be valid (`isTimeZone`). */
export const periodBounds = (
  period: Period,
  now: number,
  timeZone: string,
  weekStart: WeekStart,
): PeriodBounds => {
  const local = DateTime.makeZonedUnsafe(now, { timeZone });

  const options = { weekStartsOn: weekStartsOn(weekStart) };
  const start = DateTime.startOf(local, UNIT[period], options);

  // The next start is found by its own `startOf`: where the clocks change at midnight (Havana, Cairo) a period begins
  // later than 00:00, and adding a whole step to that start would overshoot the next local midnight.
  const next = DateTime.startOf(DateTime.add(start, STEP[period]), UNIT[period], options);

  return { start: DateTime.toEpochMillis(start), end: DateTime.toEpochMillis(next) };
};

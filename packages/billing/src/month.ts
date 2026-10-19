/**
 * The calendar month a plan counts in: from the first of the month 00:00 UTC to the first of the next (ADR 0042).
 * Pure: the boundaries are epoch milliseconds computed from a time, so tests need no clock.
 */
import { DateTime } from "effect";

/** The month containing a time: `start` inclusive, `end` (the start of the next month) exclusive; epoch ms. */
export interface Month {
  readonly start: number;
  readonly end: number;
}

export const monthOf = (now: number): Month => {
  const start = DateTime.startOf(DateTime.makeUnsafe(now), "month");
  const end = DateTime.startOf(DateTime.add(start, { months: 1 }), "month");

  return { start: DateTime.toEpochMillis(start), end: DateTime.toEpochMillis(end) };
};

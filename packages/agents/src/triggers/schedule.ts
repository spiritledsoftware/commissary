/**
 * A schedule trigger's ticks (#231): a five-field cron expression (minute, hour, day of month, month, day of week; no
 * seconds) read in an IANA time zone, through Effect's `Cron`. A tick is a time the expression matches in that zone;
 * each starts one run, keyed by its time.
 */
import { Cron, DateTime, Option, Result } from "effect";

/** A schedule's cron expression and time zone, as a trigger stores them. */
export interface ScheduleSpec {
  readonly cron: string;
  readonly timeZone: string;
}

/** The fields of a cron expression a schedule takes: minute granularity, so no seconds field. */
const CRON_FIELDS = 5;

/** The longest cron expression or time zone a schedule takes. */
const MAX_TEXT = 200;

/** The next tick of `cron` after `after` (epoch ms), `undefined` when it has none (`0 0 30 2 *`). */
const nextOf = (cron: Cron.Cron, after: number): number | undefined => {
  try {
    return Cron.next(cron, after).getTime();
  } catch {
    // `Cron.next` gives up on an expression no date matches.
    return undefined;
  }
};

/** `spec` as a `Cron`, or why it is refused (a refusal's message, for `422 invalid`). */
export const parseSchedule = (spec: ScheduleSpec): Result.Result<Cron.Cron, string> => {
  const fields = spec.cron.trim().split(/\s+/);

  if (spec.cron.length > MAX_TEXT || fields.length !== CRON_FIELDS)
    return Result.fail(
      "a schedule's cron expression has five fields: minute, hour, day of month, month and day of week",
    );

  const zone =
    spec.timeZone.length > MAX_TEXT ? Option.none() : DateTime.zoneMakeNamed(spec.timeZone);

  if (Option.isNone(zone)) return Result.fail("a schedule's time zone is an IANA time zone");

  const cron = Cron.parse(spec.cron, zone.value);

  if (Result.isFailure(cron))
    return Result.fail(`a schedule's cron expression is invalid: ${cron.failure.message}`);

  if (nextOf(cron.success, 0) === undefined)
    return Result.fail("a schedule's cron expression matches no date");

  return Result.succeed(cron.success);
};

/** The next tick of `spec` after `after` (epoch ms); `undefined` for a schedule that no longer parses. */
export const nextTick = (spec: ScheduleSpec, after: number): number | undefined => {
  const cron = parseSchedule(spec);

  return Result.isSuccess(cron) ? nextOf(cron.success, after) : undefined;
};

/** Whether `at` (epoch ms) is a tick of `spec`. */
export const isTick = (spec: ScheduleSpec, at: number): boolean => {
  const cron = parseSchedule(spec);

  return Result.isSuccess(cron) && at % 60_000 === 0 && Cron.match(cron.success, at);
};

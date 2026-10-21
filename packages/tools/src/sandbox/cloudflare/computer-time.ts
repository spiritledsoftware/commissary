/**
 * Computer time (#224, ADR 0041): how a sandbox session's object meters its computer, kept with the session
 * ({@link ComputerMetering}) and worked out here, apart from the object, from the times it hands over (its own clock).
 *
 * The computer runs from the command that starts it (a session's first fallback, or the first after it stopped) until
 * {@link COMPUTER_IDLE_MS} after its last command ended, as its container's idle timeout stops it, or until the session
 * stops it (closing, or a Spend limit with no room): that is its time, the idle minutes included, as they are the
 * container's. A command still running on it keeps it running (`busy`). just-bash's time is not metered.
 *
 * Each metered call answers the time since the call before ({@link meterComputer}), at the price per computer hour in
 * force since then, and passes the price from then on: a new price costs from the call that passes it on, as a cost is a
 * price at the time (ADR 0024). The time of a run that ended before the call is answered by the next call
 * (`pendingMs`). The session's usage record holds the sum of what was answered, and of its cost.
 */
import type { UsageRun } from "@commissary/auth";
import { hourlyCost } from "../../toolkits/price.ts";
import type { ComputerTime } from "../provider.ts";
import { COMPUTER_IDLE_MS } from "./computer.ts";

/**
 * The computer's current run, as metered: when the command that started it started, up to when it was answered, and
 * when its last command ended.
 */
export interface ComputerRun {
  readonly startedAt: number;
  readonly meteredAt: number;
  readonly lastUsedAt: number;
}

/** What a session opened by a Tools part from #224 on keeps of its computer time, for its calls and its record. */
export interface ComputerMetering {
  /** The toolkit, member and agent run (#228) its usage record names. */
  readonly toolkitId: string;
  readonly member?: string | undefined;
  readonly run?: UsageRun | undefined;
  /** Epoch ms, when the session opened. */
  readonly openedAt: number;
  /** The computer time answered so far, in ms, and what it cost. */
  readonly computerMs: number;
  readonly costMicros: number;
  /** The price per computer hour in force since the last call that metered, in micro-USD. */
  readonly hourPriceMicros: number;
  /** The org's plan counts the computer's time (#241): its free time is reported too. As its last call said. */
  readonly plans?: true | undefined;
  /** The time of runs that ended since then, not answered yet, in ms. */
  readonly pendingMs: number;
  /** The computer's run, while it may run. */
  readonly running?: ComputerRun | undefined;
  /**
   * Computer time the object's alarm metered once the computer stopped and has not reported yet (its report failed, or
   * runs now): the next call answers it, or the next alarm reports it.
   */
  readonly owed?: ComputerTime | undefined;
}

/** When `run` ends unless a command uses it again: its idle minutes after its last command. */
const idleEnd = (run: ComputerRun): number => run.lastUsedAt + COMPUTER_IDLE_MS;

/**
 * When the computer stops unless a command uses it again: its idle minutes after its last command, while no command
 * runs on it (`busy`); undefined when it is not running, or busy.
 */
export const computerEndsAt = (metering: ComputerMetering, busy: boolean): number | undefined =>
  metering.running === undefined || busy ? undefined : idleEnd(metering.running);

/** `metering` with its run ended at `end`: the run's time not answered yet waits for the next call. */
const ended = (metering: ComputerMetering, end: number): ComputerMetering => {
  const { running } = metering;

  return running === undefined
    ? metering
    : {
        ...metering,
        pendingMs: metering.pendingMs + Math.max(0, end - running.meteredAt),
        running: undefined,
      };
};

/** Whether the computer runs at `at`: a run whose idle minutes have not passed, or one a command is using (`busy`). */
export const computerRuns = (metering: ComputerMetering, at: number, busy: boolean): boolean =>
  metering.running !== undefined && (busy || at < idleEnd(metering.running));

/** `metering` at `at`: a run whose idle minutes passed by then, with no command on it, has ended. */
const settled = (metering: ComputerMetering, at: number, busy: boolean): ComputerMetering =>
  metering.running === undefined || computerRuns(metering, at, busy)
    ? metering
    : ended(metering, idleEnd(metering.running));

/** A command starts on the computer at `at`: it starts a run, unless one runs. */
export const computerStarted = (
  metering: ComputerMetering,
  at: number,
  busy: boolean,
): ComputerMetering => {
  const now = settled(metering, at, busy);

  return now.running === undefined
    ? { ...now, running: { startedAt: at, meteredAt: at, lastUsedAt: at } }
    : now;
};

/**
 * The command that started a run at `startedAt` could not start the computer (its container was refused, or the command
 * failed before it reached it): no computer ran, so the run is dropped rather than metered with its idle minutes. A run
 * another command started stays.
 */
export const computerNotStarted = (
  metering: ComputerMetering,
  startedAt: number,
): ComputerMetering =>
  metering.running?.startedAt === startedAt ? { ...metering, running: undefined } : metering;

/** A command on the computer ended at `at`: its idle minutes count from then. */
export const computerUsed = (metering: ComputerMetering, at: number): ComputerMetering => {
  const { running } = metering;

  return running === undefined
    ? metering
    : { ...metering, running: { ...running, lastUsedAt: Math.max(running.lastUsedAt, at) } };
};

/** The session stopped its computer at `at`: the run ends then, or when its idle minutes passed, if before. */
export const computerStopped = (
  metering: ComputerMetering,
  at: number,
  busy: boolean,
): ComputerMetering => {
  const now = settled(metering, at, busy);

  return ended(now, at);
};

/** What a call's metering answers: the session's metering from then on, and the computer time it answers. */
export interface MeteredComputer {
  readonly metering: ComputerMetering;
  readonly time: ComputerTime;
}

/** How a call meters: whether a command runs on the computer now, and the price it passes. */
export interface MeterOptions {
  readonly busy: boolean;
  /** The price per computer hour in force from the call on. */
  readonly hourPriceMicros: number;
  /** The time is not charged (a call that passes no price): it costs nothing. */
  readonly free?: boolean | undefined;
}

/**
 * `metering` metered at `at`: the computer time since the call before (the runs that ended since, and the current one
 * up to `at`), costed at the price in force since then (none when `free`), and `hourPriceMicros` in force from `at` on.
 */
export const meterComputer = (
  metering: ComputerMetering,
  at: number,
  { busy, hourPriceMicros, free = false }: MeterOptions,
): MeteredComputer => {
  const now = settled(metering, at, busy);

  const { running } = now;

  const computerMs =
    now.pendingMs + (running === undefined ? 0 : Math.max(0, at - running.meteredAt));

  const costMicros = free ? 0 : hourlyCost(computerMs, now.hourPriceMicros);

  return {
    metering: {
      ...now,
      computerMs: now.computerMs + computerMs,
      costMicros: now.costMicros + costMicros,
      hourPriceMicros,
      pendingMs: 0,
      running:
        running === undefined
          ? undefined
          : { ...running, meteredAt: Math.max(running.meteredAt, at) },
    },
    time: { computerMs, costMicros },
  };
};

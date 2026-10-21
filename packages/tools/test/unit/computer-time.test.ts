// A sandbox session's computer time (#224): from the command that starts the computer to its last command and its ten
// idle minutes, or to when the session stops it, answered call by call at the price per computer hour in force since
// the call before.
import { describe, expect, it } from "vitest";
import {
  type ComputerMetering,
  computerNotStarted,
  computerRuns,
  computerStarted,
  computerStopped,
  computerUsed,
  meterComputer,
} from "../../src/sandbox/cloudflare/computer-time.ts";

const MINUTE = 60_000;

/** An hour's price that makes a millisecond of computer time cost one micro-USD. */
const MICRO_PER_MS = 3_600_000;

const opened: ComputerMetering = {
  toolkitId: "sandbox",
  member: "m-alice",
  openedAt: 0,
  computerMs: 0,
  costMicros: 0,
  hourPriceMicros: MICRO_PER_MS,
  pendingMs: 0,
};

/** A command on the computer from `from` to `to`, metered when it ends. */
const command = (metering: ComputerMetering, from: number, to: number, price = MICRO_PER_MS) =>
  meterComputer(computerUsed(computerStarted(metering, from, false), to), to, {
    busy: false,
    hourPriceMicros: price,
  });

describe("a session's computer time", () => {
  it("is nothing while no command ran on the computer", () => {
    const { metering, time } = meterComputer(opened, 30 * MINUTE, {
      busy: false,
      hourPriceMicros: MICRO_PER_MS,
    });

    expect(time).toEqual({ computerMs: 0, costMicros: 0 });
    expect(metering.computerMs).toBe(0);
  });

  it("runs from the command that starts it, and each call answers the time since the call before", () => {
    const first = command(opened, MINUTE, 3 * MINUTE);

    expect(first.time).toEqual({ computerMs: 2 * MINUTE, costMicros: 2 * MINUTE });
    expect(computerRuns(first.metering, 12 * MINUTE, false)).toBe(true);

    // A call four minutes on, on just-bash, answers the four idle minutes.
    const later = meterComputer(first.metering, 7 * MINUTE, {
      busy: false,
      hourPriceMicros: MICRO_PER_MS,
    });

    expect(later.time).toEqual({ computerMs: 4 * MINUTE, costMicros: 4 * MINUTE });
  });

  it("stops ten idle minutes after its last command, whose time the next call answers", () => {
    const { metering } = command(opened, MINUTE, 3 * MINUTE);

    expect(computerRuns(metering, 13 * MINUTE, false)).toBe(false);

    const later = meterComputer(metering, 60 * MINUTE, {
      busy: false,
      hourPriceMicros: MICRO_PER_MS,
    });

    expect(later.time.computerMs).toBe(10 * MINUTE);
    expect(later.metering.computerMs).toBe(12 * MINUTE);
    expect(later.metering.running).toBeUndefined();
  });

  it("keeps running while a command uses it, however long", () => {
    const started = computerStarted(opened, 0, false);

    expect(computerRuns(started, 30 * MINUTE, true)).toBe(true);
    expect(
      meterComputer(started, 30 * MINUTE, { busy: true, hourPriceMicros: MICRO_PER_MS }).time
        .computerMs,
    ).toBe(30 * MINUTE);
  });

  it("starts a new run after it stopped, and the stopped one's time is answered with the next call", () => {
    const { metering } = command(opened, 0, MINUTE);
    const again = command(metering, 60 * MINUTE, 61 * MINUTE);

    // The first run's idle minutes, and the second's minute.
    expect(again.time.computerMs).toBe(11 * MINUTE);
    expect(again.metering.computerMs).toBe(12 * MINUTE);
  });

  it("ends when the session stops it, before its idle minutes pass", () => {
    const { metering } = command(opened, 0, MINUTE);
    const stopped = computerStopped(metering, 4 * MINUTE, false);

    expect(computerRuns(stopped, 4 * MINUTE, false)).toBe(false);
    expect(
      meterComputer(stopped, 30 * MINUTE, { busy: false, hourPriceMicros: MICRO_PER_MS }).time
        .computerMs,
    ).toBe(3 * MINUTE);
  });

  it("costs the stretch before a new price at the old one, and nothing on a call that passes none", () => {
    const { metering } = command(opened, 0, MINUTE, 2 * MICRO_PER_MS);
    const later = meterComputer(metering, 3 * MINUTE, { busy: false, hourPriceMicros: 0 });

    // Two minutes at the new price the command's call passed.
    expect(later.time).toEqual({ computerMs: 2 * MINUTE, costMicros: 4 * MINUTE });
    // Then free.
    expect(
      meterComputer(later.metering, 5 * MINUTE, { busy: false, hourPriceMicros: 0 }).time,
    ).toEqual({
      computerMs: 2 * MINUTE,
      costMicros: 0,
    });
    // A call from a part that passes no price meters the time, and costs it nothing.
    expect(
      meterComputer(metering, 2 * MINUTE, {
        busy: false,
        hourPriceMicros: MICRO_PER_MS,
        free: true,
      }).time.costMicros,
    ).toBe(0);
  });

  it("drops a run whose command could not start the computer, and keeps one another command started", () => {
    const failed = computerNotStarted(computerStarted(opened, MINUTE, false), MINUTE);

    expect(computerRuns(failed, MINUTE, false)).toBe(false);
    expect(
      meterComputer(failed, 30 * MINUTE, { busy: false, hourPriceMicros: MICRO_PER_MS }).time,
    ).toEqual({
      computerMs: 0,
      costMicros: 0,
    });

    const running = computerStarted(opened, 0, false);
    const joined = computerNotStarted(computerStarted(running, MINUTE, true), MINUTE);

    expect(computerRuns(joined, MINUTE, false)).toBe(true);
  });
});

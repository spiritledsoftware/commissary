// When the tests that drive a `TestClock` through a session's Durable Object start their clock (#214, #224): at a noon
// UTC at least an hour ahead. Noon, so a test's hours never cross into the next day of the daily Spend limits it reads;
// ahead, so an alarm an object sets from the clock is never in the past, which the runtime would run at once, on its
// own, rather than when the test runs it.
const HOUR = 60 * 60 * 1000;

const DAY = 24 * HOUR;

/** The first noon UTC an hour or more from now, in epoch ms. */
export const testClockStart = (): number => {
  const from = Date.now() + HOUR;
  const noon = Math.floor(from / DAY) * DAY + DAY / 2;

  return noon >= from ? noon : noon + DAY;
};

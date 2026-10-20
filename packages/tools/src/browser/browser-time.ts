/**
 * Browser time (#214, ADR 0039): what the browser toolkit's calls answer besides their tool result, and what it costs.
 * A Quick Action's call used the browser time the provider reports for it; a browser session's call answers its
 * session's since the call before, which its Durable Object meters (`session-object.ts`). An org admin's price per
 * browser hour on the toolkit makes it cost that, prorated by the millisecond ({@link browserTimeCost}).
 */
import type { Schema } from "effect";

/** Browser time, in milliseconds, and what it cost at a price per browser hour, in micro-USD (0 without one). */
export interface BrowserTime {
  readonly browserMs: number;
  readonly costMicros: number;
}

/** A browser tool's tool result, with the browser time its call used, when it used any. */
export interface Timed {
  readonly result: Schema.JsonObject;
  readonly browserTime?: BrowserTime | undefined;
}

/** A tool result whose call used no browser time (or none that was metered). */
export const untimed = (result: Schema.JsonObject): Timed => ({ result });

const HOUR_MS = 3_600_000n;

/**
 * What `browserMs` of browser time cost at `hourPriceMicros` per hour, prorated and rounded half up to whole micro-USD.
 * Computed exactly: at the highest price (US$1,000,000 an hour) the product of the two passes 2^53 within seconds.
 */
export const browserTimeCost = (browserMs: number, hourPriceMicros: number): number => {
  if (browserMs <= 0 || hourPriceMicros <= 0) return 0;
  const product = BigInt(Math.round(browserMs)) * BigInt(Math.round(hourPriceMicros));

  return Math.min(Number((2n * product + HOUR_MS) / (2n * HOUR_MS)), Number.MAX_SAFE_INTEGER);
};

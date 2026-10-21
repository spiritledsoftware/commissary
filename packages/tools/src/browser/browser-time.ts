/**
 * Browser time (#214, ADR 0039): what the browser toolkit's calls answer besides their tool result, and what it costs.
 * A Quick Action's call used the browser time the provider reports for it; a browser session's call answers its
 * session's since the call before, which its Durable Object meters (`session-object.ts`). An org admin's price per
 * browser hour on the toolkit makes it cost that, prorated by the millisecond (`hourlyCost`, `toolkits/price.ts`, which
 * the sandbox's computer time shares, #224).
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

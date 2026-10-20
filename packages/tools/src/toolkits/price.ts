/**
 * Prices of tool calls (#199, ADR 0038): what an org admin charges per call of an org toolkit's tools, on the toolkit or
 * per tool (the tool's override wins), in micro-USD like costs (1 USD = 1,000,000). A call without a price is free and
 * is not flagged, unlike a model without one: most tools cost nothing. A private toolkit takes no price.
 *
 * Two built-in toolkits take a price per hour besides, of the time they meter (ADR 0039, ADR 0041): the browser toolkit
 * per browser hour (#214), the sandbox toolkit per computer hour (#224). One mechanism serves both
 * ({@link HOUR_PRICES}): the time costs that price, prorated by the millisecond ({@link hourlyCost}), on top of the
 * price per call of the tool that used it.
 */

/** The highest price of one call, US$1,000,000: prices and the Spend they add up to stay exact integers. */
export const MAX_PRICE_MICROS = 1_000_000_000_000;

/** Why `price` cannot be a call's price, if it cannot. */
export const priceRefusal = (price: number): string | undefined =>
  Number.isSafeInteger(price) && price >= 0 && price <= MAX_PRICE_MICROS
    ? undefined
    : `price_micros is a whole number of micro-USD per call, from 0 to ${MAX_PRICE_MICROS}`;

/**
 * The built-in toolkits whose time has a price per hour, by kind: that price's field in the management API, and what
 * its hour is called. Browser time (#214) and computer time (#224).
 */
export const HOUR_PRICES = {
  browser: { field: "browser_hour_price_micros", hour: "browser hour" },
  sandbox: { field: "computer_hour_price_micros", hour: "computer hour" },
} as const;

/** A kind of built-in toolkit whose time has a price per hour. */
export type HourPricedKind = keyof typeof HOUR_PRICES;

/** A field of a price per hour in the management API. */
export type HourPriceField = (typeof HOUR_PRICES)[HourPricedKind]["field"];

/** Whether a toolkit of `kind` takes a price per hour. */
export const isHourPriced = (kind: string): kind is HourPricedKind =>
  Object.hasOwn(HOUR_PRICES, kind);

/** Why `price` cannot be the price per hour `field`, if it cannot: the same range as a call's. */
export const hourPriceRefusal = (field: HourPriceField, price: number): string | undefined =>
  priceRefusal(price) === undefined
    ? undefined
    : `${field} is a whole number of micro-USD per hour, from 0 to ${MAX_PRICE_MICROS}`;

const HOUR_MS = 3_600_000n;

/**
 * What `ms` of metered time cost at `hourPriceMicros` per hour, prorated and rounded half up to whole micro-USD.
 * Computed exactly: at the highest price (US$1,000,000 an hour) the product of the two passes 2^53 within seconds.
 */
export const hourlyCost = (ms: number, hourPriceMicros: number): number => {
  if (ms <= 0 || hourPriceMicros <= 0) return 0;
  const product = BigInt(Math.round(ms)) * BigInt(Math.round(hourPriceMicros));

  return Math.min(Number((2n * product + HOUR_MS) / (2n * HOUR_MS)), Number.MAX_SAFE_INTEGER);
};

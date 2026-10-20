/**
 * Prices of tool calls (#199, ADR 0038): what an org admin charges per call of an org toolkit's tools, on the toolkit or
 * per tool (the tool's override wins), in micro-USD like costs (1 USD = 1,000,000). A call without a price is free and
 * is not flagged, unlike a model without one: most tools cost nothing. A private toolkit takes no price.
 *
 * The browser toolkit takes a price per browser hour besides (#214, ADR 0039): its browser time costs that, prorated by
 * the millisecond (`browserTimeCost`, `browser/browser-time.ts`), on top of the price per call of the tool that used it.
 */

/** The highest price of one call, US$1,000,000: prices and the Spend they add up to stay exact integers. */
export const MAX_PRICE_MICROS = 1_000_000_000_000;

/** Why `price` cannot be a call's price, if it cannot. */
export const priceRefusal = (price: number): string | undefined =>
  Number.isSafeInteger(price) && price >= 0 && price <= MAX_PRICE_MICROS
    ? undefined
    : `price_micros is a whole number of micro-USD per call, from 0 to ${MAX_PRICE_MICROS}`;

/** Why `price` cannot be a price per browser hour, if it cannot: the same range as a call's. */
export const browserHourPriceRefusal = (price: number): string | undefined =>
  priceRefusal(price) === undefined
    ? undefined
    : `browser_hour_price_micros is a whole number of micro-USD per hour, from 0 to ${MAX_PRICE_MICROS}`;

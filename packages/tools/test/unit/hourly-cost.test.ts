// What metered time costs at a price per hour (#214, #224): browser time at the price per browser hour and computer time
// at the price per computer hour, one mechanism, prorated by the millisecond and rounded half up to whole micro-USD,
// computed exactly at every price an org admin may set, where the product of the two passes 2^53.
import { describe, expect, it } from "vitest";
import {
  HOUR_PRICES,
  hourlyCost,
  hourPriceRefusal,
  isHourPriced,
  MAX_PRICE_MICROS,
} from "../../src/toolkits/price.ts";

describe("metered time's cost", () => {
  it("is the price per hour prorated by the millisecond, rounded half up", () => {
    expect(hourlyCost(1_500, 3_600_000)).toBe(1_500);
    expect(hourlyCost(1, 1_800_000)).toBe(1);
    expect(hourlyCost(1, 1_799_999)).toBe(0);
    expect(hourlyCost(3_600_000, 90_000)).toBe(90_000);
  });

  it("is nothing without time or a price", () => {
    expect(hourlyCost(0, 90_000)).toBe(0);
    expect(hourlyCost(-5, 90_000)).toBe(0);
    expect(hourlyCost(60_000, 0)).toBe(0);
  });

  it("is exact at the highest price, where floating point is not", () => {
    expect(hourPriceRefusal("browser_hour_price_micros", MAX_PRICE_MICROS)).toBeUndefined();
    // 1,800,009 ms at 999,999,999,999 per hour is 500,002,499,999.49999975: floating point rounds it up.
    expect(Math.round((1_800_009 * (MAX_PRICE_MICROS - 1)) / 3_600_000)).toBe(500_002_500_000);
    expect(hourlyCost(1_800_009, MAX_PRICE_MICROS - 1)).toBe(500_002_499_999);
    // Ten days at the highest price.
    expect(hourlyCost(864_000_000, MAX_PRICE_MICROS)).toBe(240_000_000_000_000);
    expect(hourlyCost(3_599_999, MAX_PRICE_MICROS)).toBe(999_999_722_222);
  });
});

describe("a price per hour", () => {
  it("is the browser toolkit's per browser hour and the sandbox toolkit's per computer hour, and no other's", () => {
    expect(
      Object.fromEntries(Object.entries(HOUR_PRICES).map(([kind, { field }]) => [kind, field])),
    ).toEqual({
      browser: "browser_hour_price_micros",
      sandbox: "computer_hour_price_micros",
    });
    expect(["browser", "sandbox", "mcp", "agents"].filter(isHourPriced)).toEqual([
      "browser",
      "sandbox",
    ]);
  });

  it("is a whole number of micro-USD from 0 to the highest price of a call, refused in its own field's words", () => {
    for (const price of [0, 1, MAX_PRICE_MICROS])
      expect(hourPriceRefusal("computer_hour_price_micros", price)).toBeUndefined();

    for (const price of [-1, 1.5, MAX_PRICE_MICROS + 1, Number.NaN])
      expect(hourPriceRefusal("computer_hour_price_micros", price)).toBe(
        `computer_hour_price_micros is a whole number of micro-USD per hour, from 0 to ${MAX_PRICE_MICROS}`,
      );
  });
});

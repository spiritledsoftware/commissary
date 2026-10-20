// What browser time costs (#214): a price per browser hour prorated by the millisecond and rounded half up to whole
// micro-USD, computed exactly at every price an org admin may set, where the product of the two passes 2^53.
import { describe, expect, it } from "vitest";
import { browserTimeCost } from "../../src/browser/browser-time.ts";
import { browserHourPriceRefusal, MAX_PRICE_MICROS } from "../../src/toolkits/price.ts";

describe("browser time's cost", () => {
  it("is the price per browser hour prorated by the millisecond, rounded half up", () => {
    expect(browserTimeCost(1_500, 3_600_000)).toBe(1_500);
    expect(browserTimeCost(1, 1_800_000)).toBe(1);
    expect(browserTimeCost(1, 1_799_999)).toBe(0);
    expect(browserTimeCost(3_600_000, 90_000)).toBe(90_000);
  });

  it("is nothing without browser time or a price", () => {
    expect(browserTimeCost(0, 90_000)).toBe(0);
    expect(browserTimeCost(-5, 90_000)).toBe(0);
    expect(browserTimeCost(60_000, 0)).toBe(0);
  });

  it("is exact at the highest price, where floating point is not", () => {
    expect(browserHourPriceRefusal(MAX_PRICE_MICROS)).toBeUndefined();
    // 1,800,009 ms at 999,999,999,999 per hour is 500,002,499,999.49999975: floating point rounds it up.
    expect(Math.round((1_800_009 * (MAX_PRICE_MICROS - 1)) / 3_600_000)).toBe(500_002_500_000);
    expect(browserTimeCost(1_800_009, MAX_PRICE_MICROS - 1)).toBe(500_002_499_999);
    // Ten days at the highest price.
    expect(browserTimeCost(864_000_000, MAX_PRICE_MICROS)).toBe(240_000_000_000_000);
    expect(browserTimeCost(3_599_999, MAX_PRICE_MICROS)).toBe(999_999_722_222);
  });
});

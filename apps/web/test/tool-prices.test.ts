// A toolkit's prices (src/lib/tool-prices.ts, #209, ADR 0038): dollars typed and shown, micro-USD sent; a price per call
// on an org toolkit, one per hour on the browser and sandbox toolkits, none on a private toolkit; and what a tool's row
// says of its own price.
import { describe, expect, it } from "vitest";
import type { ToolkitView } from "@commissary/contract/tools";
import {
  callPriceText,
  currentPrice,
  formatPrice,
  MAX_PRICE_MICROS,
  parsePrice,
  priceBody,
  priceChanged,
  priceFieldsOf,
  priceProblem,
  priceText,
  toolPriceText,
} from "../src/lib/tool-prices.ts";

const toolkit = (patch: Partial<ToolkitView> = {}): ToolkitView => ({
  id: "tk_stripe",
  kind: "openapi",
  name: "stripe",
  source: "https://example.com/openapi.json",
  private: false,
  accepts: "shared",
  revision: 4,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  updated_by: "user:admin@example.com",
  credentials: {},
  tool_list: { tools: 400 },
  ...patch,
});

describe("typing a price", () => {
  it("reads dollars as micro-USD: whole numbers, fractions of up to six decimals, a leading $", () => {
    expect(parsePrice("0.002")).toBe(2000);
    expect(parsePrice("$0.002")).toBe(2000);
    expect(parsePrice("1")).toBe(1_000_000);
    expect(parsePrice("1.25")).toBe(1_250_000);
    expect(parsePrice(".5")).toBe(500_000);
    expect(parsePrice("5.")).toBe(5_000_000);
    expect(parsePrice("0.000001")).toBe(1);
    expect(parsePrice("0")).toBe(0);
    expect(parsePrice(" 0.05 ")).toBe(50_000);
    expect(parsePrice("1000000")).toBe(MAX_PRICE_MICROS);
  });

  it("reads an empty field as no price, and refuses what the server would", () => {
    expect(parsePrice("")).toBe("free");
    expect(parsePrice("  ")).toBe("free");
    expect(parsePrice("-1")).toBe("invalid");
    expect(parsePrice("abc")).toBe("invalid");
    expect(parsePrice("0.0000001")).toBe("invalid");
    expect(parsePrice("1,5")).toBe("invalid");
    expect(parsePrice(".")).toBe("invalid");
    expect(parsePrice("1000000.01")).toBe("invalid");
    expect(priceProblem("abc")).toContain("six decimals");
    expect(priceProblem("")).toBeUndefined();
    expect(priceProblem("0.002")).toBeUndefined();
  });

  it("shows a price in dollars without trailing zeros, and never rounds a small price to free", () => {
    expect(priceText(2000)).toBe("0.002");
    expect(priceText(1_250_000)).toBe("1.25");
    expect(priceText(1_000_000)).toBe("1.00");
    expect(priceText(1)).toBe("0.000001");
    expect(priceText(0)).toBe("0.00");
    expect(priceText(undefined)).toBe("");
    expect(formatPrice(50)).toBe("$0.00005");
    expect(formatPrice(2000)).toBe("$0.002");
  });

  it("round-trips what it shows", () => {
    for (const micros of [0, 1, 50, 2000, 1_250_000, 999_999_999]) {
      expect(parsePrice(priceText(micros))).toBe(micros);
    }
  });
});

describe("a toolkit's prices", () => {
  it("are a price per call on an org toolkit", () => {
    expect(priceFieldsOf(toolkit()).map((field) => field.field)).toEqual(["price_micros"]);
  });

  it("are a price per hour of its time on the browser and the sandbox toolkits, and no price per call", () => {
    expect(
      priceFieldsOf(toolkit({ kind: "browser", built_in: true })).map((field) => field.field),
    ).toEqual(["browser_hour_price_micros"]);
    expect(
      priceFieldsOf(toolkit({ kind: "sandbox", built_in: true })).map((field) => field.field),
    ).toEqual(["computer_hour_price_micros"]);
    expect(priceFieldsOf(toolkit({ kind: "agents", built_in: true }))).toEqual([]);
  });

  it("are none on a private toolkit: a member may not price their own", () => {
    expect(priceFieldsOf(toolkit({ private: true, accepts: "private" }))).toEqual([]);
  });

  it("send the one price that was typed, or null to clear it, and nothing else", () => {
    const [call] = priceFieldsOf(toolkit());
    const [hour] = priceFieldsOf(toolkit({ kind: "browser", built_in: true }));

    expect(call && priceBody(call, "0.002")).toEqual({ price_micros: 2000 });
    expect(call && priceBody(call, "")).toEqual({ price_micros: null });
    expect(call && priceBody(call, "0")).toEqual({ price_micros: 0 });
    expect(call && priceBody(call, "nope")).toBeUndefined();
    expect(hour && priceBody(hour, "6")).toEqual({ browser_hour_price_micros: 6_000_000 });
  });

  it("send the sandbox toolkit's price per computer hour (#225), which round-trips as the toolkit's current price", () => {
    const sandbox = toolkit({ kind: "sandbox", built_in: true });
    const [hour] = priceFieldsOf(sandbox);
    const priced = toolkit({ ...sandbox, computer_hour_price_micros: 1_250_000 });

    expect(hour?.field).toBe("computer_hour_price_micros");
    expect(hour && priceBody(hour, "$1.25")).toEqual({ computer_hour_price_micros: 1_250_000 });
    expect(hour && priceBody(hour, "")).toEqual({ computer_hour_price_micros: null });
    expect(hour && currentPrice(priced, hour.field)).toBe(1_250_000);
    expect(hour && priceText(currentPrice(priced, hour.field))).toBe("1.25");
    expect(hour && priceChanged(priced, hour, "1.25")).toBe(false);
    expect(hour && priceChanged(priced, hour, "1.5")).toBe(true);
  });

  it("know whether a typed price changes the toolkit's", () => {
    const [call] = priceFieldsOf(toolkit());
    const priced = toolkit({ price_micros: 2000 });

    expect(call && priceChanged(toolkit(), call, "")).toBe(false);
    expect(call && priceChanged(toolkit(), call, "0.002")).toBe(true);
    expect(call && priceChanged(priced, call, "0.002")).toBe(false);
    expect(call && priceChanged(priced, call, "")).toBe(true);
    expect(call && priceChanged(priced, call, "x")).toBe(true);
    expect(call && currentPrice(priced, call.field)).toBe(2000);
  });

  it("read as free when there is none, and no flag is raised for it", () => {
    expect(callPriceText(undefined)).toBe("Free");
    expect(callPriceText(0)).toBe("Free");
    expect(callPriceText(2000)).toBe("$0.002 per call");
  });
});

describe("a tool's own price", () => {
  it("shows what a call costs, and whether the tool's override sets it", () => {
    expect(toolPriceText({})).toEqual({ text: "Free", own: false });
    expect(toolPriceText({ price_micros: 2000 })).toEqual({ text: "$0.002", own: false });
    expect(toolPriceText({ price_micros: 5000, override: { price_micros: 5000 } })).toEqual({
      text: "$0.005",
      own: true,
    });
    // An override of 0 makes one tool of a priced toolkit free.
    expect(toolPriceText({ price_micros: 0, override: { price_micros: 0 } })).toEqual({
      text: "Free",
      own: true,
    });
  });
});

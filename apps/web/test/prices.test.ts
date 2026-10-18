// The Prices page's model (src/lib/prices.ts) and the cost figures (src/lib/format.ts): dollars from micro-
// dollars, drafts and their validation, the request body a draft becomes, and the page's address.
import { describe, expect, it } from "@effect/vitest";
import type { PriceOverride } from "@commissary/contract/prices";
import { formatCost, formatRate } from "../src/lib/format.ts";
import {
  draftFor,
  draftOf,
  EMPTY_DRAFT,
  hasPriceErrors,
  KNOWN_PROVIDERS,
  overrideOf,
  parseRate,
  priceBody,
  priceProblem,
  readPricesSearch,
  sortOverrides,
  validatePrice,
} from "../src/lib/prices.ts";

const override = (patch: Partial<PriceOverride> = {}): PriceOverride => ({
  id: "price-1",
  provider: "codex",
  model: "gpt-5",
  input: 1.25,
  output: 10,
  revision: 3,
  updated_at: 1_700_000_000_000,
  updated_by: "ian@example.com",
  ...patch,
});

const filled = { ...EMPTY_DRAFT, provider: "codex", model: "gpt-6", input: "2", output: "$12.50" };

describe("cost figures", () => {
  it("prints micro-dollars as dollars, never printing a used model as free", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1)).toBe("<$0.0001");
    expect(formatCost(99)).toBe("<$0.0001");
    expect(formatCost(100)).toBe("$0.0001");
    expect(formatCost(4_200)).toBe("$0.0042");
    expect(formatCost(9_999)).toBe("$0.0100");
    expect(formatCost(10_000)).toBe("$0.01");
    expect(formatCost(1_234_567)).toBe("$1.23");
    expect(formatCost(1_234_567_890)).toBe("$1,234.57");
  });

  it("prints prices per million tokens with the cents they need", () => {
    expect(formatRate(1.25)).toBe("$1.25");
    expect(formatRate(15)).toBe("$15.00");
    expect(formatRate(0)).toBe("$0.00");
    expect(formatRate(0.075)).toBe("$0.075");
    expect(formatRate(1234.5)).toBe("$1,234.50");
  });
});

describe("price drafts", () => {
  it("reads typed rates: plain non-negative numbers, with an optional dollar sign", () => {
    expect(parseRate("1.25")).toBe(1.25);
    expect(parseRate(" $3 ")).toBe(3);
    expect(parseRate(".5")).toBe(0.5);
    expect(parseRate("0")).toBe(0);
    expect(parseRate("")).toBeUndefined();
    expect(parseRate("-1")).toBeUndefined();
    expect(parseRate("1e3")).toBeUndefined();
    expect(parseRate("abc")).toBeUndefined();
  });

  it("accepts a complete draft and makes it the request body, trimmed", () => {
    const draft = { ...filled, provider: " codex ", model: " gpt-6 ", cacheRead: "0.2" };

    expect(hasPriceErrors(validatePrice(draft, []))).toBe(false);

    expect(priceBody(draft)).toEqual({
      provider: "codex",
      model: "gpt-6",
      input: 2,
      output: 12.5,
      cache_read: 0.2,
    });
  });

  it("suggests the System One providers and prices their models like any other, output free", () => {
    expect(KNOWN_PROVIDERS).toEqual(expect.arrayContaining(["typesafe", "subq"]));

    const draft = {
      ...EMPTY_DRAFT,
      provider: "subq",
      model: "subq-snap-preview",
      input: "0.05",
      output: "0",
    };

    expect(hasPriceErrors(validatePrice(draft, []))).toBe(false);
    expect(priceBody(draft)).toEqual({
      provider: "subq",
      model: "subq-snap-preview",
      input: 0.05,
      output: 0,
    });
  });

  it("leaves empty cache prices out, so they are charged at the input price", () => {
    expect(priceBody(filled)).not.toHaveProperty("cache_read");
    expect(priceBody(filled)).not.toHaveProperty("cache_write");
    expect(priceBody({ ...filled, cacheWrite: "0" })).toMatchObject({ cache_write: 0 });
  });

  it("says what is missing or wrong, field by field", () => {
    const errors = validatePrice({ ...EMPTY_DRAFT, input: "x", cacheRead: "-2" }, []);

    expect(Object.keys(errors).toSorted()).toEqual([
      "cacheRead",
      "input",
      "model",
      "output",
      "provider",
    ]);

    expect(validatePrice({ ...filled, input: "100001" }, []).input).toMatch(/most a price/);
    expect(validatePrice({ ...filled, cacheWrite: "" }, [])).toEqual({});
  });

  it("refuses a provider and model that have a price, however they are cased, but not the one edited", () => {
    const existing = [override()];
    const same = { ...filled, provider: " CODEX", model: "GPT-5" };

    expect(validatePrice(same, existing).model).toMatch(/already has a price/);
    expect(validatePrice(same, existing, existing[0])).toEqual({});
    expect(validatePrice({ ...same, model: "gpt-5-mini" }, existing)).toEqual({});
  });

  it("fills the form from an override and from the address", () => {
    expect(draftOf(override({ cache_read: 0.125 }))).toEqual({
      provider: "codex",
      model: "gpt-5",
      input: "1.25",
      output: "10",
      cacheRead: "0.125",
      cacheWrite: "",
    });

    expect(draftFor({ provider: "claude", model: "claude-x" })).toMatchObject({
      provider: "claude",
      model: "claude-x",
      input: "",
    });

    expect(draftFor({})).toEqual(EMPTY_DRAFT);
  });

  it("finds the override of a draft's provider and model, however they are cased", () => {
    const existing = [override()];

    expect(overrideOf({ ...EMPTY_DRAFT, provider: " CODEX ", model: "Gpt-5" }, existing)).toBe(
      existing[0],
    );
    expect(
      overrideOf({ ...EMPTY_DRAFT, provider: "codex", model: "gpt-6" }, existing),
    ).toBeUndefined();
  });

  it("lists overrides by provider, then model", () => {
    const sorted = sortOverrides([
      override({ id: "c", provider: "codex", model: "b" }),
      override({ id: "a", provider: "claude", model: "z" }),
      override({ id: "b", provider: "codex", model: "a" }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("explains a refused save: a stale revision tells to reload, other refusals say why", () => {
    expect(priceProblem("conflict", "x")).toMatch(/Reload/);
    expect(priceProblem("invalid_config", "input must be a price")).toBe("input must be a price");
  });
});

describe("the prices address", () => {
  it("reads the provider and model, dropping what is malformed", () => {
    expect(readPricesSearch({ provider: "codex", model: "gpt-5" })).toEqual({
      provider: "codex",
      model: "gpt-5",
    });

    expect(readPricesSearch({ provider: "codex", model: 5 })).toEqual({ provider: "codex" });
    expect(readPricesSearch("nonsense")).toEqual({});
  });
});

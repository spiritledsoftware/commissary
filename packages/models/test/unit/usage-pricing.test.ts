// Prices and the cost of an attempt (src/usage/pricing.ts, ADR 0024): known Claude, OpenAI and Gemini attempts with
// cache reads and writes and reasoning tokens, the override that wins over the catalog, the model without a price.
import { describe, expect, it } from "vitest";
import { embeddedModelsDev } from "../../src/registry/catalog.ts";
import { trimModelsDev } from "../../src/registry/models-dev.ts";
import { ensureTokenBreakdown } from "../../src/usage/accounting.ts";
import { parseClaudeUsage, parseGeminiUsage } from "../../src/usage/parsers.ts";
import {
  catalogPrice,
  costOf,
  findPrice,
  PRICE_PROVIDERS,
  type PriceOverride,
  priceOfCost,
} from "../../src/usage/pricing.ts";
import { parseOpenAIUsage, type UsageDetail } from "../../src/usage/record.ts";
import { documentText, mdModel } from "../support/models-dev.ts";

const catalog = (() => {
  const result = trimModelsDev(
    documentText({
      anthropic: {
        "claude-sonnet-4-5": mdModel("claude-sonnet-4-5", {
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        }),
      },
      openai: {
        "gpt-5": mdModel("gpt-5", { cost: { input: 1.25, output: 10, cache_read: 0.125 } }),
      },
      google: {
        "gemini-2.5-pro": mdModel("gemini-2.5-pro", {
          cost: {
            input: 1.25,
            output: 10,
            cache_read: 0.125,
            tiers: [
              {
                input: 2.5,
                output: 15,
                cache_read: 0.25,
                tier: { type: "context", size: 200_000 },
              },
            ],
          },
        }),
        "gemini-legacy-tier": mdModel("gemini-legacy-tier", {
          cost: { input: 1, output: 4, context_over_200k: { input: 2, output: 8 } },
        }),
        "gemini-unpriced": { id: "gemini-unpriced" },
      },
    }),
  );

  if (!result.ok) throw new Error(result.error);

  return result.value;
})();

const breakdownOf = (detail: UsageDetail, provider: string) => {
  const ensured = ensureTokenBreakdown(detail, provider, provider);

  if (ensured.tokenBreakdown === undefined) throw new Error("no breakdown");

  return ensured.tokenBreakdown;
};

const sources = (overrides: ReadonlyArray<PriceOverride> = []) => ({
  docs: [catalog],
  overrides,
});

describe("the cost of a known attempt", () => {
  it("prices a Claude attempt: uncached input, cache reads, cache writes and output", () => {
    const detail = parseClaudeUsage(
      JSON.stringify({
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 500,
          output_tokens: 800,
        },
      }),
    );

    const price = findPrice(sources(), "claude", "claude-sonnet-4-5");

    // 1000 * 3 + 2000 * 0.3 + 500 * 3.75 + 800 * 15 micro-dollars.
    expect(costOf(price, breakdownOf(detail, "claude"))).toEqual({
      micros: 3000 + 600 + 1875 + 12000,
      unpriced: false,
    });
  });

  it("prices a dated Claude id at the undated model's price", () => {
    const detail = parseClaudeUsage(
      JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 0 } }),
    );

    expect(
      costOf(
        findPrice(sources(), "claude", "claude-sonnet-4-5-20250929"),
        breakdownOf(detail, "claude"),
      ),
    ).toEqual({ micros: 3000, unpriced: false });
  });

  it("prices an OpenAI attempt: cached input inside the prompt, reasoning inside the output", () => {
    const detail = parseOpenAIUsage(
      JSON.stringify({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 300,
          total_tokens: 1300,
          prompt_tokens_details: { cached_tokens: 400 },
          completion_tokens_details: { reasoning_tokens: 100 },
        },
      }),
    );

    // 600 uncached * 1.25 + 400 cached * 0.125 + (200 + 100 reasoning) * 10; a Codex account costs the same.
    expect(costOf(findPrice(sources(), "codex", "gpt-5"), breakdownOf(detail, "codex"))).toEqual({
      micros: 750 + 50 + 3000,
      unpriced: false,
    });
  });

  it("prices a Gemini attempt: thinking tokens are output, cached content is a cache read", () => {
    const detail = parseGeminiUsage(
      JSON.stringify({
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 200,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 50,
        },
      }),
    );

    // 800 * 1.25 + 200 * 0.125 + (100 + 50) * 10.
    expect(
      costOf(findPrice(sources(), "gemini", "gemini-2.5-pro"), breakdownOf(detail, "gemini")),
    ).toEqual({ micros: 1000 + 25 + 1500, unpriced: false });
  });

  it("prices an attempt whose input passes the long-context size at the tier's rates", () => {
    const detail = parseGeminiUsage(
      JSON.stringify({
        usageMetadata: {
          promptTokenCount: 300_000,
          cachedContentTokenCount: 100_000,
          candidatesTokenCount: 1000,
        },
      }),
    );

    // 200000 * 2.5 + 100000 * 0.25 + 1000 * 15.
    expect(
      costOf(findPrice(sources(), "gemini", "gemini-2.5-pro"), breakdownOf(detail, "gemini")),
    ).toEqual({ micros: 500_000 + 25_000 + 15_000, unpriced: false });
  });

  it("reads the older context_over_200k spelling of the tier, keeping the base rates it leaves out", () => {
    const price = findPrice(sources(), "gemini", "gemini-legacy-tier");

    expect(price?.tiers).toEqual([
      { above: 200_000, input: 2, output: 8, cacheRead: 2, cacheWrite: 2, reasoning: 8 },
    ]);
  });

  it("charges tokens with no cache rate at the input rate and rounds once", () => {
    const price = priceOfCost({ input: 0.3, output: 1 });

    const detail = parseOpenAIUsage(
      JSON.stringify({
        usage: {
          prompt_tokens: 11,
          completion_tokens: 1,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      }),
    );

    // 11 * 0.3 + 1 * 1 = 4.3
    expect(costOf(price, breakdownOf(detail, "codex")).micros).toBe(4);
  });

  it("costs nothing for tokens a provider reported only in total", () => {
    const price = priceOfCost({ input: 3, output: 15 });
    const detail = parseOpenAIUsage(JSON.stringify({ usage: { total_tokens: 500 } }));

    expect(costOf(price, breakdownOf(detail, "codex"))).toEqual({ micros: 0, unpriced: false });
  });
});

describe("price overrides and unpriced models", () => {
  const detail = parseClaudeUsage(
    JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 1000 } }),
  );

  const breakdown = breakdownOf(detail, "claude");

  const override: PriceOverride = {
    id: "price-1",
    provider: "claude",
    model: "claude-sonnet-4-5",
    input: 1,
    output: 2,
  };

  it("lets an override win over the catalog, for its provider only", () => {
    expect(
      costOf(findPrice(sources([override]), "claude", "claude-sonnet-4-5"), breakdown),
    ).toEqual({ micros: 3000, unpriced: false });
    expect(findPrice(sources([override]), "claude", "claude-sonnet-4-5")?.source).toBe("override");
    // The same model under another provider key keeps the catalog's price (here: none for that key).
    expect(findPrice(sources([override]), "opencode-zen", "claude-sonnet-4-5")).toBeUndefined();
  });

  it("matches provider and model without regard to case", () => {
    const price = findPrice(
      sources([{ ...override, provider: "Claude", model: "Claude-Sonnet-4-5" }]),
      "claude",
      "claude-sonnet-4-5",
    );

    expect(price?.source).toBe("override");
  });

  it("prices a model the catalog lacks when an override names it", () => {
    const gateway: PriceOverride = {
      id: "price-2",
      provider: "openai-compatible-openrouter",
      model: "acme/model",
      input: 2,
      output: 4,
      cache_read: 1,
    };

    const price = findPrice(sources([gateway]), "openai-compatible-openrouter", "acme/model");

    expect(costOf(price, breakdown)).toEqual({ micros: 2000 + 4000, unpriced: false });
  });

  it("marks an attempt on a model without a price unpriced, at cost 0", () => {
    for (const [provider, model] of [
      ["claude", "claude-unknown"],
      ["gemini", "gemini-unpriced"],
      ["openai-compatible-openrouter", "acme/model"],
      ["devin", "swe-1.5"],
    ] as const)
      expect(costOf(findPrice(sources(), provider, model), breakdown)).toEqual({
        micros: 0,
        unpriced: true,
      });
  });

  it("treats a price of zero as a price", () => {
    const free = priceOfCost({ input: 0, output: 0 });

    expect(costOf(free, breakdown)).toEqual({ micros: 0, unpriced: false });
  });
});

describe("write-ins", () => {
  const writeIns = {
    claude: [
      { name: "claude-sonnet-9", like: "claude-sonnet-4-5" },
      { name: "claude-unchecked" },
      { name: "claude-chained", like: "claude-sonnet-9" },
    ],
  };

  const withWriteIns = (overrides: ReadonlyArray<PriceOverride> = []) => ({
    ...sources(overrides),
    writeIns,
  });

  it("prices a write-in the catalog lacks as the model it is like, for its provider only", () => {
    const price = findPrice(withWriteIns(), "claude", "Claude-Sonnet-9");

    expect(price).toEqual(findPrice(sources(), "claude", "claude-sonnet-4-5"));
    expect(findPrice(withWriteIns(), "codex", "claude-sonnet-9")).toBeUndefined();
  });

  it("lets an override of the write-in win, and takes the like's override when it has none", () => {
    const own: PriceOverride = {
      id: "p",
      provider: "claude",
      model: "claude-sonnet-9",
      input: 7,
      output: 7,
    };

    const like: PriceOverride = {
      id: "q",
      provider: "claude",
      model: "claude-sonnet-4-5",
      input: 5,
      output: 5,
    };

    expect(findPrice(withWriteIns([own, like]), "claude", "claude-sonnet-9")?.input).toBe(7);
    expect(findPrice(withWriteIns([like]), "claude", "claude-sonnet-9")?.input).toBe(5);
  });

  it("leaves a write-in without a like, or like another write-in, unpriced", () => {
    expect(findPrice(withWriteIns(), "claude", "claude-unchecked")).toBeUndefined();
    expect(findPrice(withWriteIns(), "claude", "claude-chained")).toBeUndefined();
  });
});

describe("the bundled catalog", () => {
  it("prices a Claude, OpenAI and Gemini model through the provider mapping", () => {
    const docs = [embeddedModelsDev()];

    for (const [provider, model] of [
      ["claude", "claude-sonnet-4-5"],
      ["codex", "gpt-5"],
      ["gemini", "gemini-2.5-pro"],
      ["vertex", "gemini-2.5-pro"],
    ] as const) {
      expect(catalogPrice(docs, provider, model), `${provider}/${model}`).toMatchObject({
        source: "catalog",
      });
    }
  });

  it("leaves Kimi unpriced: models.dev lists only its subscription plan, at zero", () => {
    const docs = [embeddedModelsDev()];

    expect(PRICE_PROVIDERS.has("kimi")).toBe(false);
    expect(catalogPrice(docs, "kimi", "kimi-for-coding")).toBeUndefined();
  });

  it("names a models.dev provider for every provider key it prices", () => {
    expect([...PRICE_PROVIDERS.keys()].toSorted()).toEqual([
      "antigravity",
      "claude",
      "codex",
      "gemini",
      "gemini-interactions",
      "meta",
      "opencode-go",
      "opencode-zen",
      "vertex",
      "xai",
    ]);
  });
});

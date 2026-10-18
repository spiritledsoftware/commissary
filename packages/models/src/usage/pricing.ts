/**
 * Prices and the cost of an attempt (ADR 0024). New in the Workers port, no Go counterpart.
 *
 * The cost of an attempt is its token breakdown (accounting v2, `accounting.ts`) priced at the model's prices: an org's
 * price override for the provider and model, else the models.dev price the model catalog carries (`registry/models-dev.ts`).
 * Prices are US dollars per million tokens, and a token priced at one dollar per million costs one micro-dollar, so
 * the cost in micro-dollars is the sum of tokens times price, rounded once. A model with neither price is unpriced:
 * the attempt costs nothing and says so.
 *
 * Subscription accounts are costed like provider keys, at the API price of the provider they stand for: a provider key
 * names the models.dev providers whose prices apply (`PRICE_PROVIDERS`). A provider the table does not list (Devin,
 * an OpenAI-compatible gateway) has no catalog price: its models need a price override. Models models.dev does not
 * list at all (the System One models of TypeSafe, SubQ and OpenCode Zen, ADR 0032) take the `cost` of their catalog
 * addition record under the same provider key, after models.dev.
 *
 * Kinds of token and their rates: uncached input, cache reads, cache writes, output (reasoning tokens are output and
 * take the output rate unless the price names a reasoning rate). A price without a cache rate charges those tokens at
 * the input rate (no discount known). Tokens the provider reported only in total (`unclassifiedTokens`) have no
 * rate and cost nothing. models.dev's long-context tiers replace the whole price for an attempt whose input exceeds the
 * tier's size (the way providers bill a long prompt); a tier that leaves a rate out keeps the base price's stated rate.
 *
 * Pure: nothing here reads a binding.
 */
import type { CatalogAdditions } from "../registry/catalog-additions.ts";
import type {
  ModelsDevCatalog,
  ModelsDevCost,
  ModelsDevProviderId,
} from "../registry/models-dev.ts";
import type { TokenBreakdown } from "./accounting.ts";

/** US dollars per million tokens of each kind, every kind filled in. */
export interface Rates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

/** Rates that apply once an attempt's input passes `above` tokens. */
export interface PriceTier extends Rates {
  readonly above: number;
}

export interface Price extends Rates {
  /** By `above`, ascending. */
  readonly tiers: ReadonlyArray<PriceTier>;
  /** Where the price came from: an org's override or the model catalog. */
  readonly source: "override" | "catalog";
}

/**
 * A price override as the org stores it (an entry of the ControlPlane, ADR 0025): the provider key and model a usage
 * record carries, and the prices. `cache_read`/`cache_write` left out charge those tokens at the input rate.
 */
export interface PriceOverride {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
}

/** The cost stored on a usage record. */
export interface UsageCost {
  /** Micro-dollars. */
  readonly micros: number;
  /** No price was found for the attempt's model: it costs nothing. */
  readonly unpriced: boolean;
}

export const UNPRICED: UsageCost = { micros: 0, unpriced: true };

/**
 * The models.dev providers whose prices apply to a provider key, in the order they are tried. Claude accounts cost
 * what Anthropic's API charges, Codex accounts what OpenAI's does, and so on. Kimi is left out: models.dev lists only
 * its subscription plan (`kimi-code-plan-global`, every price zero), which would cost its traffic nothing without
 * saying so; its models are unpriced until an override names them.
 */
export const PRICE_PROVIDERS: ReadonlyMap<string, ReadonlyArray<ModelsDevProviderId>> = new Map([
  ["claude", ["anthropic"]],
  ["codex", ["openai"]],
  ["gemini", ["google"]],
  ["gemini-interactions", ["google"]],
  ["vertex", ["google-vertex", "google"]],
  // Antigravity serves Gemini and Claude models under their own ids.
  ["antigravity", ["google", "anthropic"]],
  ["xai", ["xai"]],
  ["meta", ["meta"]],
  ["opencode-zen", ["opencode"]],
  ["opencode-go", ["opencode-go"]],
]);

/** The long-context tier models.dev's older documents spell `context_over_200k`. */
const LEGACY_TIER_ABOVE = 200_000;

const normal = (text: string): string => text.trim().toLowerCase();

const nonNegative = (value: number | undefined): number | undefined =>
  value !== undefined && value >= 0 ? value : undefined;

/** The rates one level of a models.dev `cost` states; a kind it leaves out is absent. */
interface Stated {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cache_read?: number | undefined;
  readonly cache_write?: number | undefined;
  readonly reasoning?: number | undefined;
}

/**
 * Fills in the rates of one level: a kind it leaves out takes `fallback`'s stated rate (a tier keeps the base price's),
 * and a cache kind nobody states is charged at the level's input rate, reasoning at its output rate.
 */
const ratesOf = (level: Stated, fallback: Stated | undefined): Rates | undefined => {
  const input = nonNegative(level.input) ?? nonNegative(fallback?.input);
  const output = nonNegative(level.output) ?? nonNegative(fallback?.output);

  if (input === undefined || output === undefined) return undefined;

  return {
    input,
    output,
    cacheRead: nonNegative(level.cache_read) ?? nonNegative(fallback?.cache_read) ?? input,
    cacheWrite: nonNegative(level.cache_write) ?? nonNegative(fallback?.cache_write) ?? input,
    reasoning: nonNegative(level.reasoning) ?? nonNegative(fallback?.reasoning) ?? output,
  };
};

/** The price a models.dev `cost` states; `undefined` when it names no input or output price. */
export const priceOfCost = (cost: ModelsDevCost): Price | undefined => {
  const base = ratesOf(cost, undefined);

  if (base === undefined) return undefined;

  const listed = (cost.tiers ?? []).flatMap((tier) =>
    tier.tier === undefined || tier.tier.type !== "context"
      ? []
      : [{ above: tier.tier.size, tier }],
  );

  const levels =
    listed.length > 0
      ? listed
      : cost.context_over_200k === undefined
        ? []
        : [{ above: LEGACY_TIER_ABOVE, tier: cost.context_over_200k }];

  const tiers = levels
    .flatMap(({ above, tier }): PriceTier[] => {
      const rates = ratesOf(tier, cost);

      return rates === undefined ? [] : [{ ...rates, above }];
    })
    .toSorted((a, b) => a.above - b.above);

  return { ...base, tiers, source: "catalog" };
};

/** The price an override states. */
export const priceOfOverride = (override: PriceOverride): Price => ({
  input: override.input,
  output: override.output,
  cacheRead: override.cache_read ?? override.input,
  cacheWrite: override.cache_write ?? override.input,
  reasoning: override.output,
  tiers: [],
  source: "override",
});

/** Costs of one models.dev document by provider and lower-cased model id, built once per document. */
const indexes = new WeakMap<
  ModelsDevCatalog,
  Map<ModelsDevProviderId, Map<string, ModelsDevCost>>
>();

const indexOf = (doc: ModelsDevCatalog, provider: ModelsDevProviderId) => {
  let byProvider = indexes.get(doc);

  if (byProvider === undefined) {
    byProvider = new Map();
    indexes.set(doc, byProvider);
  }

  let index = byProvider.get(provider);

  if (index === undefined) {
    index = new Map();

    for (const [id, model] of Object.entries(doc[provider].models))
      if (model.cost !== undefined) index.set(normal(id), model.cost);
    byProvider.set(provider, index);
  }

  return index;
};

/** `claude-sonnet-4-5-20250929` also reads as `claude-sonnet-4-5` when the dated id has no entry of its own. */
const withoutDate = (model: string): string => model.replace(/-\d{8}$/, "");

/** The `cost` of the catalog addition record of `model` under the provider key, if it has one. */
const additionCost = (
  additions: CatalogAdditions | undefined,
  provider: string,
  id: string,
): ModelsDevCost | undefined => {
  if (additions === undefined) return undefined;
  const entry = Object.entries(additions.providers).find(([key]) => key === provider)?.[1];

  return entry?.models?.find((record) => normal(record.id) === id)?.cost;
};

/**
 * The catalog price of `model` under `provider` (a provider key): the first of the provider's models.dev documents that
 * lists it, else the `cost` of its catalog addition record.
 */
export const catalogPrice = (
  docs: ReadonlyArray<ModelsDevCatalog>,
  provider: string,
  model: string,
  additions?: CatalogAdditions,
): Price | undefined => {
  const id = normal(model);
  const added = additionCost(additions, normal(provider), id);
  const fromAddition = added === undefined ? undefined : priceOfCost(added);
  const providers = PRICE_PROVIDERS.get(normal(provider));

  if (providers === undefined) return fromAddition;

  for (const doc of docs) {
    for (const candidate of providers) {
      const index = indexOf(doc, candidate);
      const cost = index.get(id) ?? index.get(withoutDate(id));
      const price = cost === undefined ? undefined : priceOfCost(cost);

      if (price !== undefined) return price;
    }
  }

  return fromAddition;
};

export interface PriceSources {
  /** Documents to read catalog prices from, the preferred first (the active catalog, then the bundled one). */
  readonly docs: ReadonlyArray<ModelsDevCatalog>;
  readonly overrides: ReadonlyArray<PriceOverride>;
  /** The bundled catalog additions: prices of models models.dev does not list. */
  readonly additions?: CatalogAdditions;
}

/** The price of `model` under `provider`: the org's override, else the catalog's; `undefined` when neither has one. */
export const findPrice = (
  sources: PriceSources,
  provider: string,
  model: string,
): Price | undefined => {
  const key = normal(provider);
  const id = normal(model);

  const override =
    sources.overrides.find(
      (entry) => normal(entry.provider) === key && normal(entry.model) === id,
    ) ??
    sources.overrides.find(
      (entry) => normal(entry.provider) === key && normal(entry.model) === withoutDate(id),
    );

  return override === undefined
    ? catalogPrice(sources.docs, provider, model, sources.additions)
    : priceOfOverride(override);
};

/** The rates that apply to an attempt whose input is `inputTokens` long. */
const ratesFor = (price: Price, inputTokens: number): Rates =>
  price.tiers.findLast((tier) => inputTokens > tier.above) ?? price;

/**
 * The cost of an attempt: its token breakdown at `price`, in micro-dollars. `undefined` price: unpriced, zero.
 */
export const costOf = (price: Price | undefined, breakdown: TokenBreakdown): UsageCost => {
  if (price === undefined) return UNPRICED;
  const rates = ratesFor(price, breakdown.input.totalTokens);

  const micros =
    breakdown.input.uncachedTokens * rates.input +
    breakdown.input.cacheReadTokens * rates.cacheRead +
    breakdown.input.cacheWriteTokens * rates.cacheWrite +
    breakdown.output.nonReasoningTokens * rates.output +
    breakdown.output.reasoningTokens * rates.reasoning;

  return { micros: Math.round(micros), unpriced: false };
};

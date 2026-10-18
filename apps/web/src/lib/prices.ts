// The Prices page's model: a price override as the form edits it (text in each field), what is wrong with a draft,
// the body a draft becomes and the page's address (`/usage/prices?provider=…&model=…`, where the Usage page's
// unpriced callout sends the operator). Pure: no DOM, tested in test/prices.test.ts.
import { Option, Schema, flow } from "effect";
import { MAX_OVERRIDE_PRICE } from "@commissary/contract/prices";
import type { PriceOverride, PriceOverrideBody } from "@commissary/contract/prices";
import { lenient } from "./usage.ts";

/** Provider keys of accounts and keys Commissary serves: suggestions for the provider field. */
export const KNOWN_PROVIDERS: ReadonlyArray<string> = [
  "antigravity",
  "claude",
  "codex",
  "devin",
  "gemini",
  "gemini-interactions",
  "kimi",
  "meta",
  "opencode-go",
  "opencode-zen",
  "subq",
  "typesafe",
  "vertex",
  "xai",
];

/** Each field as typed; rates are dollars per million tokens. The cache rates may stay empty. */
export interface PriceDraft {
  readonly provider: string;
  readonly model: string;
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
}

export type PriceField = keyof PriceDraft;

/** The message of each field that is wrong. */
export interface PriceErrors {
  provider?: string;
  model?: string;
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheWrite?: string;
}

export const EMPTY_DRAFT: PriceDraft = {
  provider: "",
  model: "",
  input: "",
  output: "",
  cacheRead: "",
  cacheWrite: "",
};

const lower = (value: string): string => value.trim().toLowerCase();

const rateText = (rate: number | undefined): string => (rate === undefined ? "" : String(rate));

/** The form's fields for an override being edited. */
export const draftOf = (override: PriceOverride): PriceDraft => ({
  provider: override.provider,
  model: override.model,
  input: rateText(override.input),
  output: rateText(override.output),
  cacheRead: rateText(override.cache_read),
  cacheWrite: rateText(override.cache_write),
});

/** The fields a link pre-fills: the provider and model of the unpriced requests it came from. */
export const draftFor = (search: PricesSearch): PriceDraft => ({
  ...EMPTY_DRAFT,
  provider: search.provider ?? "",
  model: search.model ?? "",
});

/** A typed rate: `1.25` or `$1.25`; `undefined` when it is not a plain non-negative number. */
export const parseRate = (raw: string): number | undefined => {
  const text = raw.trim().replace(/^\$/, "");

  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return undefined;

  return Number(text);
};

const rateError = (raw: string, label: string, optional: boolean): string | undefined => {
  if (raw.trim() === "") return optional ? undefined : `Enter the price of ${label}.`;
  const rate = parseRate(raw);

  if (rate === undefined) return "Enter dollars per million tokens as a number, such as 1.25.";

  if (rate > MAX_OVERRIDE_PRICE) return `The most a price can be is $${MAX_OVERRIDE_PRICE}.`;

  return undefined;
};

/**
 * A draft against the overrides there are (`editing`: the one it replaces, which may keep its own provider and
 * model). Names are compared without case or surrounding spaces, as the server stores them.
 */
export const validatePrice = (
  draft: PriceDraft,
  existing: ReadonlyArray<PriceOverride>,
  editing?: PriceOverride,
): PriceErrors => {
  const provider = lower(draft.provider);
  const model = lower(draft.model);

  const taken =
    provider === "" || model === ""
      ? undefined
      : existing.find(
          (entry) =>
            entry.id !== editing?.id &&
            lower(entry.provider) === provider &&
            lower(entry.model) === model,
        );

  const errors: PriceErrors = {};

  if (provider === "") errors.provider = "Enter the provider key, such as codex.";

  if (model === "") errors.model = "Enter the model name, as it appears in the usage log.";

  if (taken !== undefined) errors.model = "This model already has a price. Edit that one instead.";

  const rates = [
    ["input", rateError(draft.input, "input tokens", false)],
    ["output", rateError(draft.output, "output tokens", false)],
    ["cacheRead", rateError(draft.cacheRead, "cached input", true)],
    ["cacheWrite", rateError(draft.cacheWrite, "cache writes", true)],
  ] as const;

  for (const [field, error] of rates) {
    if (error !== undefined) errors[field] = error;
  }

  return errors;
};

/** The override that already prices a draft's provider and model, however they are cased. */
export const overrideOf = (
  draft: PriceDraft,
  existing: ReadonlyArray<PriceOverride>,
): PriceOverride | undefined => {
  const provider = lower(draft.provider);
  const model = lower(draft.model);

  return existing.find(
    (entry) => lower(entry.provider) === provider && lower(entry.model) === model,
  );
};

export const hasPriceErrors = (errors: PriceErrors): boolean => Object.keys(errors).length > 0;

/** The request body of a valid draft: names trimmed, empty cache rates left out (charged at the input price). */
export const priceBody = (draft: PriceDraft): PriceOverrideBody => {
  const cacheRead = parseRate(draft.cacheRead);
  const cacheWrite = parseRate(draft.cacheWrite);

  return {
    provider: draft.provider.trim(),
    model: draft.model.trim(),
    input: parseRate(draft.input) ?? 0,
    output: parseRate(draft.output) ?? 0,
    ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
  };
};

/** The overrides as the table lists them: by provider, then model. */
export const sortOverrides = (
  overrides: ReadonlyArray<PriceOverride>,
): ReadonlyArray<PriceOverride> =>
  overrides.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );

/** What a failed save tells the operator. */
export const priceProblem = (error: string | undefined, message: string): string =>
  error === "conflict"
    ? "The prices changed elsewhere while this page was open. Reload to see the current prices, then make the edit again."
    : message;

/** The page's address: `/usage/prices?provider=codex&model=gpt-5`. A malformed parameter is dropped on its own. */
export const PricesSearch = Schema.Struct({
  provider: lenient(Schema.String),
  model: lenient(Schema.String),
});

export type PricesSearch = typeof PricesSearch.Type;

export const readPricesSearch = flow(
  Schema.decodeUnknownOption(PricesSearch),
  Option.getOrElse((): PricesSearch => ({})),
);

// Prices of tool calls on the Tools pages (#209, ADR 0038, GLOSSARY "Price"): what an org admin charges per call of an
// org toolkit's tools, on the toolkit or on one tool (its own price wins), and per hour of the browser's or the
// computer's time on the two toolkits Commissary provides. The API counts micro-USD; the panel types and shows
// dollars. A tool without a price costs nothing and is not flagged, unlike a model without one. Pure: no DOM, tested in
// test/tool-prices.test.ts.
import type { ToolkitView, UpdateToolkit } from "@commissary/contract/tools";

/** The highest price the server accepts (`MAX_PRICE_MICROS`), US$1,000,000, in micro-USD. */
export const MAX_PRICE_MICROS = 1_000_000_000_000;

/** What a price field is a price of. */
export type PriceKind = "call" | "browser_hour" | "computer_hour";

/** One price field of a toolkit: the field of `PATCH /toolkits/:id`, its label and what the hint says it prices. */
export interface PriceField {
  readonly kind: PriceKind;
  readonly field: "price_micros" | "browser_hour_price_micros" | "computer_hour_price_micros";
  readonly label: string;
  readonly hint: string;
}

const CALL_PRICE: PriceField = {
  kind: "call",
  field: "price_micros",
  label: "Price per call (USD)",
  hint: "What each call of its tools costs. A tool's own price, set in its editor in the tool list, wins. Empty: free, and never flagged as unpriced.",
};

const BROWSER_HOUR_PRICE: PriceField = {
  kind: "browser_hour",
  field: "browser_hour_price_micros",
  label: "Price per browser hour (USD)",
  hint: "What an hour of browser time costs, prorated to the millisecond, on top of any price per call. Empty: browser time is free.",
};

const COMPUTER_HOUR_PRICE: PriceField = {
  kind: "computer_hour",
  field: "computer_hour_price_micros",
  label: "Price per computer hour (USD)",
  hint: "What an hour of the computer's time costs, prorated to the millisecond, on top of any price per call. Empty: the computer's time is free.",
};

/**
 * The prices an org admin sets on a toolkit. An org toolkit takes a price per call; the browser toolkit a price per
 * browser hour and the sandbox toolkit a price per computer hour, and no price per call (`403 built_in`: only its
 * tools' own prices). A private toolkit takes none (a member may not price the tools of their own).
 */
export const priceFieldsOf = (
  toolkit: Pick<ToolkitView, "kind" | "private" | "built_in">,
): ReadonlyArray<PriceField> => {
  if (toolkit.private) return [];

  if (toolkit.built_in !== true) return [CALL_PRICE];

  if (toolkit.kind === "browser") return [BROWSER_HOUR_PRICE];

  return toolkit.kind === "sandbox" ? [COMPUTER_HOUR_PRICE] : [];
};

/** A toolkit's current price in `field`, in micro-USD; `undefined`: free. */
export const currentPrice = (
  toolkit: ToolkitView,
  field: PriceField["field"],
): number | undefined => toolkit[field];

/** Whether a kind of toolkit has a tool-level price at all (every toolkit but a private one's). */
export const toolsTakePrices = (toolkit: Pick<ToolkitView, "private">): boolean => !toolkit.private;

const TYPED_PRICE = /^(\d*)(?:\.(\d{0,6}))?$/;

/**
 * A price typed in dollars (`0.002`, `$0.002`) as micro-USD: a plain non-negative number of at most six decimals, up
 * to US$1,000,000. Empty is `"free"`: no price. `"invalid"` otherwise.
 */
export const parsePrice = (text: string): number | "free" | "invalid" => {
  const trimmed = text.trim().replace(/^\$/, "");

  if (trimmed === "") return "free";

  const typed = TYPED_PRICE.exec(trimmed);
  const whole = typed?.[1] ?? "";
  const fraction = typed?.[2] ?? "";

  if (typed === null || (whole === "" && fraction === "")) return "invalid";

  const micros = Number(whole === "" ? "0" : whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));

  return Number.isSafeInteger(micros) && micros <= MAX_PRICE_MICROS ? micros : "invalid";
};

/** Why a typed price would be refused, or `undefined` (an empty field is no price). */
export const priceProblem = (text: string): string | undefined =>
  parsePrice(text) === "invalid"
    ? "Enter dollars as a number with at most six decimals, such as 0.002, up to 1,000,000."
    : undefined;

/** A price as its field holds it: dollars without trailing zeros but at least two decimals, `""` for free. */
export const priceText = (micros: number | undefined): string => {
  if (micros === undefined) return "";

  const whole = Math.floor(micros / 1_000_000);

  const fraction = String(micros % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");

  return `${whole}.${fraction}`;
};

/** A price as it reads in a table or a sentence: "$0.002", "$1.25", "$0.00005"; never rounded to look free. */
export const formatPrice = (micros: number): string => `$${priceText(micros)}`;

/** What a toolkit's call price reads as in its facts: its price, or that calls are free. */
export const callPriceText = (micros: number | undefined): string =>
  micros === undefined || micros === 0 ? "Free" : `${formatPrice(micros)} per call`;

/**
 * What a tool's price says in its row: its effective price, and whether its own override sets it (an override of 0
 * makes one tool of a priced toolkit free).
 */
export const toolPriceText = (tool: {
  readonly price_micros?: number | undefined;
  readonly override?: { readonly price_micros?: number | undefined } | undefined;
}) => {
  const own = tool.override?.price_micros !== undefined;

  return {
    text:
      tool.price_micros === undefined || tool.price_micros === 0
        ? "Free"
        : formatPrice(tool.price_micros),
    own,
  };
};

/**
 * The body that sets one price of a toolkit: its typed price, or `null` to clear it when the field is empty. Only the
 * field sent changes, so the toolkit's other settings stay as they are.
 */
export const priceBody = (field: PriceField, text: string): UpdateToolkit | undefined => {
  const price = parsePrice(text);

  if (price === "invalid") return undefined;

  return { [field.field]: price === "free" ? null : price };
};

/** Whether a typed price differs from the toolkit's. */
export const priceChanged = (toolkit: ToolkitView, field: PriceField, text: string): boolean => {
  const price = parsePrice(text);

  return price === "invalid"
    ? true
    : (price === "free" ? undefined : price) !== currentPrice(toolkit, field.field);
};

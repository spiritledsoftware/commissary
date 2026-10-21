// The org's billing on Commissary Cloud as the Billing page and the plan notices show it (ADR 0042): its plan, this
// month's usage against free usage at the rates `GET /billing` states, the bill against the billing cap, the notices,
// and what a refused billing call of an org owner says. Pure: no DOM, tested in test/billing.test.ts.
import type {
  BillingNotice,
  BillingRate,
  BillingUnit,
  BillingView,
} from "@commissary/contract/billing";
import { asSentence } from "./failure.ts";
import { formatCount } from "./format.ts";
import type { QuotaLevel } from "./quota.ts";
import { atLeast, BILLING_PAGE, type Caller, pagesFor } from "./role.ts";

/** How near a plan limit a notice says the org is: at 80% of it, or at all of it. */
export type LimitLevel = Exclude<QuotaLevel, "ok">;

/** The units a plan counts, in the order the page lists them. */
const UNITS: ReadonlyArray<BillingUnit> = ["requests", "browser_hours", "computer_hours"];

const UNIT_NAMES: Readonly<Record<BillingUnit, string>> = {
  requests: "Requests and tool calls",
  browser_hours: "Browser hours",
  computer_hours: "Computer hours",
};

/** Each unit's free usage in a notice's sentence. */
const FREE_UNIT_NAMES: Readonly<Record<BillingUnit, string>> = {
  requests: "free requests and tool calls",
  browser_hours: "free browser hours",
  computer_hours: "free computer hours",
};

/**
 * What the server refuses once a unit's free usage is used up, where Free's limits apply: requests only (Billing's
 * `PlanLimitKind`); the other units are not counted yet, so nothing of them is refused.
 */
const REFUSED_AT_FREE_USAGE: Readonly<Partial<Record<BillingUnit, string>>> = {
  requests: "requests",
};

const hours = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** An amount of a unit: "12,400" requests and tool calls, "1 hour", "0.25 hours". */
const amount = (unit: BillingUnit, value: number): string =>
  unit === "requests"
    ? formatCount(value)
    : `${hours.format(value)} ${value === 1 ? "hour" : "hours"}`;

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Dollars as the bill reads: "$12.40". */
export const formatDollars = (value: number): string => dollars.format(value);

/** A rate as `GET /billing` states it: "$0.50 per 100,000", "$0.15 an hour". */
const rateText = (unit: BillingUnit, rate: BillingRate): string => {
  const price = formatDollars(rate.dollars);

  if (rate.per === 1) return unit === "requests" ? `${price} each` : `${price} an hour`;

  return `${price} per ${amount(unit, rate.per)}`;
};

/**
 * Whether Free's limits hold the org: on Free, and on Pay as you go while a payment failed (until one succeeds). An
 * unbilled org has no limits of a plan.
 */
const freeLimitsApply = (view: Pick<BillingView, "plan" | "payment" | "unbilled">): boolean =>
  !view.unbilled && (view.plan === "free" || view.payment === "past_due");

/** A notice's percent as a level: 80% is near the limit, 100% at it. */
const LEVELS: Readonly<Record<80 | 100, LimitLevel>> = { 80: "near", 100: "out" };

/** The level of a notice's percent; no notice, no limit near. */
const levelOf = (percent: 80 | 100 | undefined): QuotaLevel =>
  percent === undefined ? "ok" : LEVELS[percent];

/** What the page says beside a unit near or at its free usage. */
const FREE_USAGE_NOTES: Readonly<Record<LimitLevel, string>> = {
  near: "Over 80% of free usage",
  out: "Free usage used up",
};

/**
 * One unit of the month: its name, what was used, its free usage (none for a unit without any) with the share of it
 * used, how near Free's stop it is with the note that says so, Pay as you go's rate above free usage, and what is
 * billed above it.
 */
export interface UnitReading {
  readonly unit: BillingUnit;
  readonly name: string;
  readonly used: string;
  /** "25,000", "1 hour"; `undefined` for a unit with no free usage. */
  readonly free: string | undefined;
  /** 0–100 of the free usage; `undefined` for a unit with none. */
  readonly percent: number | undefined;
  /** From the server's notices, so the page and the banner agree. */
  readonly level: QuotaLevel;
  readonly levelNote: string | undefined;
  /** Pay as you go's rate above free usage: "$0.50 per 100,000". */
  readonly rate: string;
  /** What is billed above free usage on Pay as you go: "100,000 above free usage, billed". */
  readonly billed: string | undefined;
}

const billedNote = (view: BillingView, unit: BillingUnit): string | undefined => {
  const { used, free } = view.usage[unit];

  if (freeLimitsApply(view) || used <= free) return undefined;

  return `${amount(unit, used - free)} above free usage, ${view.unbilled ? "unbilled" : "billed"}`;
};

/** Each unit of the month, requests first. */
export const unitReadings = (view: BillingView): ReadonlyArray<UnitReading> =>
  UNITS.map((unit) => {
    const { used, free } = view.usage[unit];

    const notice = view.notices.find(
      (candidate) => candidate.kind === "free_usage" && candidate.unit === unit,
    );

    const level = levelOf(notice?.kind === "free_usage" ? notice.percent : undefined);

    return {
      unit,
      name: UNIT_NAMES[unit],
      used: amount(unit, used),
      free: free === 0 ? undefined : amount(unit, free),
      percent: free === 0 ? undefined : Math.min(100, (used / free) * 100),
      level,
      levelNote: level === "ok" ? undefined : FREE_USAGE_NOTES[level],
      rate: rateText(unit, view.rates[unit]),
      billed: billedNote(view, unit),
    };
  });

const monthDay = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** When the month's counters start over: plans count in calendar months in UTC ("September 1, UTC"). */
export const resetDay = (view: Pick<BillingView, "resets_at">): string =>
  `${monthDay.format(Date.parse(view.resets_at))}, UTC`;

/** What the billing cap refuses once the bill reaches it. */
const capRefusal = (view: BillingView): string =>
  `requests that would be billed are refused until ${resetDay(view)}`;

/**
 * Pay as you go's bill so far, the billing cap (none: `undefined`), the share of it billed, how near it is and the note
 * that says so.
 */
export interface BillReading {
  readonly bill: string;
  readonly cap: string | undefined;
  /** 0–100 of the billing cap; `undefined` without one. */
  readonly percent: number | undefined;
  /** From the server's notices, so the page and the banner agree. */
  readonly level: QuotaLevel;
  readonly levelNote: string | undefined;
}

/** The month's bill against the billing cap, on Pay as you go only: Free bills nothing, nor does an unbilled org. */
export const billReading = (view: BillingView): BillReading | undefined => {
  if (view.plan !== "payg" || view.unbilled) return undefined;

  const cap = view.billing_cap;
  const notice = view.notices.find((candidate) => candidate.kind === "billing_cap");
  const level = levelOf(notice?.kind === "billing_cap" ? notice.percent : undefined);

  const levelNotes: Readonly<Record<LimitLevel, string>> = {
    near: "Over 80% of the billing cap.",
    out: `The billing cap is reached: ${capRefusal(view)}.`,
  };

  const levelNote = level === "ok" ? undefined : levelNotes[level];
  const bill = formatDollars(view.bill);

  if (cap === null) return { bill, cap: undefined, percent: undefined, level, levelNote };

  // A billing cap of $0 refuses any billed request: it is reached from the start.
  const percent = cap === 0 ? 100 : Math.min(100, (view.bill / cap) * 100);

  return { bill, cap: formatDollars(cap), percent, level, levelNote };
};

type CapInput = { readonly kind: "cap"; readonly value: number } | { readonly kind: "invalid" };

/** A typed billing cap: dollars from 0 in whole cents ("50", "$1,250.50"); removing it is its own action. */
export const parseBillingCap = (text: string): CapInput => {
  const typed = text.trim().replace(/^\$/, "").replaceAll(",", "");

  if (!/^\d+(\.\d{1,2})?$/.test(typed)) return { kind: "invalid" };

  // Whole cents, so the amount is the nearest double to them (`BillingCap` checks a multiple of 0.01).
  return { kind: "cap", value: Math.round(Number(typed) * 100) / 100 };
};

/** A failed payment, as the banner and the Billing page say it. */
export const PAYMENT_FAILED =
  "A payment failed: this org is held to Free’s limits until a payment succeeds.";

/** What an org admin who is not an owner does about it: only org owners change the payment method. */
export const ASK_OWNER_TO_PAY = "Ask an org owner to update the payment method.";

/**
 * One notice as the banner says it: how near the limit (`out`: something is refused, or a payment failed), the
 * sentence, and what an org owner can do from it (`portal`: update the payment method in the billing portal).
 */
export interface NoticeLine {
  readonly key: string;
  readonly level: LimitLevel;
  readonly text: string;
  readonly action: "portal" | undefined;
}

/** A free usage notice's sentence: what was used and, for what the server refuses there, until when. */
const freeUsageText = (
  view: BillingView,
  notice: Extract<BillingNotice, { kind: "free_usage" }>,
): string => {
  const what = FREE_UNIT_NAMES[notice.unit];
  const refused = REFUSED_AT_FREE_USAGE[notice.unit];
  const until = resetDay(view);

  if (notice.percent === 80) {
    const next = refused === undefined ? "" : ` At 100%, ${refused} are refused until ${until}.`;

    return `This org has used 80% of this month’s ${what}.${next}`;
  }

  const now = refused === undefined ? "" : `: ${refused} are refused until ${until}`;

  return `This org has used all of this month’s ${what}${now}.`;
};

const noticeLine = (view: BillingView, notice: BillingNotice, owner: boolean): NoticeLine => {
  switch (notice.kind) {
    case "free_usage":
      return {
        key: `free_usage/${notice.unit}`,
        level: LEVELS[notice.percent],
        text: freeUsageText(view, notice),
        action: undefined,
      };

    case "billing_cap": {
      const cap = formatDollars(view.billing_cap ?? 0);

      return {
        key: "billing_cap",
        level: LEVELS[notice.percent],
        text:
          notice.percent === 80
            ? `This month’s bill has reached 80% of the billing cap of ${cap}.`
            : `This month’s bill has reached the billing cap of ${cap}: ${capRefusal(view)}.`,
        action: undefined,
      };
    }

    case "payment_failed":
      // Only org owners change the payment method (`POST /billing/portal`).
      return {
        key: "payment_failed",
        level: "out",
        text: owner ? PAYMENT_FAILED : `${PAYMENT_FAILED} ${ASK_OWNER_TO_PAY}`,
        action: owner ? "portal" : undefined,
      };
  }
};

/** The org's notices as the banner shows them to its owners (`owner`) and admins, most urgent first. */
export const noticeLines = (view: BillingView, owner: boolean): ReadonlyArray<NoticeLine> => {
  const lines = view.notices.map((notice) => noticeLine(view, notice, owner));

  return [
    ...lines.filter((line) => line.level === "out"),
    ...lines.filter((line) => line.level === "near"),
  ];
};

/**
 * Whether the caller sees the org's billing (the Billing page and the plan notices): whoever has the Billing page in
 * the sidebar (`PAGES`: org admins, on Commissary Cloud only, where plans exist).
 */
export const seesBilling = (hosted: boolean, caller: Caller): boolean =>
  pagesFor(caller.role, { privateCredentials: caller.privateCredentials, hosted }).some(
    (page) => page.to === BILLING_PAGE,
  );

/** Org owners switch plans, change the payment method and set the billing cap; other org admins read them. */
export const changesBilling = (caller: Caller): boolean => atLeast(caller.role, "owner");

/** What a refused billing call of an org owner (checkout, portal, plan, billing cap) says, by the server's error code. */
export const ownerBillingProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "billing_email_taken":
      return "Your email already bills another org on Commissary Cloud, and one email bills one org. Another org owner can upgrade this one.";
    case "already_on_payg":
      return "This org is on Pay as you go already. Reload the page to see it.";
    case "no_billing_account":
      return "This org has no billing account yet: it gets one with its first upgrade to Pay as you go.";
    case "person_required":
      return "Only a person can upgrade, since the billing email is theirs; a token cannot.";
    case "unbilled":
      return "This org is unbilled: a platform admin decides its billing.";
    case "invalid_billing_cap":
      return "A billing cap is an amount of dollars from 0, in whole cents.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

/** How long after starting a checkout the page waits for Polar's webhook to put the org on Pay as you go. */
const CHECKOUT_WAIT_MS = 60 * 60_000;

/** When the page stops waiting for the upgrade of a checkout started at `startedAt` (epoch ms). */
export const upgradeWaitEnds = (startedAt: number): number => startedAt + CHECKOUT_WAIT_MS;

/**
 * Whether the page is waiting for the upgrade: an owner started a checkout here (`startedAt`, epoch ms) within
 * {@link CHECKOUT_WAIT_MS}, and the org is not on Pay as you go yet. Polar sends the owner back to the page before its
 * webhook may have arrived.
 */
export const awaitingUpgrade = (
  startedAt: number | undefined,
  now: number,
  view: Pick<BillingView, "plan" | "unbilled">,
): boolean =>
  startedAt !== undefined &&
  now < upgradeWaitEnds(startedAt) &&
  view.plan === "free" &&
  !view.unbilled;

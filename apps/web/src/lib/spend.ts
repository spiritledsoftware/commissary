// The Limits page's model: how a Spend limit reads (subject, period, spent and remaining), the order of the list,
// the checks that mirror the server's (packages/state/src/spend/store.ts), the dollar amounts typed into the forms and what a
// refused write tells the caller. Pure: no DOM, tested in test/spend.test.ts.
import type {
  SpendLimitView,
  SpendPeriod,
  SpendSubjectKind,
  SpendWeekStart,
} from "@commissary/contract/spend";
import { asSentence } from "./failure.ts";
import { formatCost } from "./format.ts";

export const PERIODS: ReadonlyArray<{ readonly id: SpendPeriod; readonly label: string }> = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

/** "per day": how a limit's period reads in a sentence. */
export const perPeriod = (period: SpendPeriod): string => `per ${period}`;

export const SUBJECT_KINDS: ReadonlyArray<{
  readonly id: SpendSubjectKind;
  readonly label: string;
}> = [
  { id: "org", label: "Whole org" },
  { id: "team", label: "Team" },
  { id: "member", label: "Member" },
  { id: "credential", label: "Shared credential" },
  { id: "key", label: "API key" },
];

/**
 * The kinds listed, not offered in the form yet: a toolkit's shared credential (#199; the panel's toolkits are #209's)
 * and a shared hosted agent (#226; the panel's agents come later).
 */
const LISTED_ONLY: Partial<Record<SpendSubjectKind, string>> = {
  toolkit_credential: "Toolkit credential",
  agent: "Agent",
};

export const kindLabel = (kind: SpendSubjectKind): string =>
  LISTED_ONLY[kind] ?? SUBJECT_KINDS.find((candidate) => candidate.id === kind)?.label ?? kind;

export const WEEK_STARTS: ReadonlyArray<{ readonly id: SpendWeekStart; readonly label: string }> = [
  { id: "monday", label: "Monday" },
  { id: "sunday", label: "Sunday" },
  { id: "tuesday", label: "Tuesday" },
  { id: "wednesday", label: "Wednesday" },
  { id: "thursday", label: "Thursday" },
  { id: "friday", label: "Friday" },
  { id: "saturday", label: "Saturday" },
];

const KIND_RANK: Readonly<Record<SpendSubjectKind, number>> = {
  org: 0,
  team: 1,
  member: 2,
  key: 3,
  credential: 4,
  toolkit_credential: 5,
  agent: 6,
};

const PERIOD_RANK: Readonly<Record<SpendPeriod, number>> = { day: 0, week: 1, month: 2 };

/**
 * The org's limits first, then teams, members, keys, shared credentials and agents; by name, then the shorter period
 * first.
 */
export const sortLimits = (limits: ReadonlyArray<SpendLimitView>): ReadonlyArray<SpendLimitView> =>
  limits.toSorted(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.label.localeCompare(b.label) ||
      PERIOD_RANK[a.period] - PERIOD_RANK[b.period] ||
      a.id.localeCompare(b.id),
  );

/** The share of a limit that is spent, 0 to 1 (a limit of 0 is spent). */
export const spentShare = (
  limit: Pick<SpendLimitView, "spent_micros" | "amount_micros">,
): number => (limit.amount_micros <= 0 ? 1 : Math.min(1, limit.spent_micros / limit.amount_micros));

/** Whether the limit has no room left: Commissary refuses what it covers until the period ends. */
export const reached = (limit: Pick<SpendLimitView, "spent_micros" | "amount_micros">): boolean =>
  limit.spent_micros >= limit.amount_micros;

/** "$3.20 of $5.00", the figures of a row. */
export const spentText = (limit: Pick<SpendLimitView, "spent_micros" | "amount_micros">): string =>
  `${formatCost(limit.spent_micros)} of ${formatCost(limit.amount_micros)}`;

/** What is left of a limit, "$1.80 left", or that it is reached. */
export const remainingText = (limit: SpendLimitView): string =>
  reached(limit) ? "Reached" : `${formatCost(limit.remaining_micros)} left`;

const timeFormat = (zone: string): Intl.DateTimeFormat | undefined => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return undefined;
  }
};

/** When a period ends, in the org's time zone: "Tue, Oct 15, 12:00 AM". */
export const resetsText = (iso: string, zone: string): string => {
  const at = Date.parse(iso);

  return Number.isNaN(at) ? iso : (timeFormat(zone)?.format(at) ?? new Date(at).toISOString());
};

// ---------------------------------------------------------------------------------------------------------------
// The forms

const MICROS_PER_USD = 1_000_000;

/**
 * A typed dollar amount in micro-USD: whole cents and sub-cents down to six decimals ("5", "5.25", "$0.000001");
 * `undefined` for anything else (empty, negative, more decimals, a letter).
 */
export const parseDollars = (text: string): number | undefined => {
  const parts = /^\$?\s*(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text.trim());

  if (parts === null) return undefined;
  const whole = Number(parts[1]);
  const fraction = Number((parts[2] ?? "").padEnd(6, "0"));

  return whole * MICROS_PER_USD + fraction;
};

/** An amount as the form's input reads it: 5_250_000 → "5.25". */
export const dollarsInput = (micros: number): string => {
  const whole = Math.floor(micros / MICROS_PER_USD);

  const fraction = String(micros % MICROS_PER_USD)
    .padStart(6, "0")
    .replace(/0+$/, "");

  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
};

/** What is wrong with a typed amount, or `undefined` when it will do. */
export const amountProblem = (text: string): string | undefined =>
  parseDollars(text) === undefined
    ? "Type an amount in US dollars, such as 25 or 12.50 (up to six decimals)."
    : undefined;

/** The least a time zone name has to look like before the server is asked (it checks the name itself). */
export const zoneProblem = (text: string): string | undefined =>
  /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(text.trim())
    ? undefined
    : "Type an IANA time zone name such as Europe/Berlin or America/New_York.";

/** The IANA zone names the browser knows, for the calendar's suggestions (empty where it cannot list them). */
export const knownZones = (): ReadonlyArray<string> => {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone")];
  } catch {
    return ["UTC"];
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Refused writes

/**
 * What a refused Spend limit write says, by the server's error code. Codes without copy fall back to the server's own
 * explanation, then to the message.
 */
export const limitProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "conflict":
      return detail?.startsWith("that subject") === true
        ? "That subject already has a limit for the period. Edit it instead."
        : "Someone changed this limit since you loaded it. Reload to see the current one.";
    case "exceeds_admin_limit":
      return "An org admin has limited this key to less than that. Choose an amount at or below their limit.";
    case "forbidden":
      return "You can limit your own API keys, and org admins can limit anything.";
    case "not_found":
      return "That limit no longer exists. Reload to see the current list.";
    case "subject_not_found":
      return "That member, team, shared credential or API key no longer exists.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

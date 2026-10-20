// Retention (ADR 0027): how long an org keeps its usage records, and its agent runs after their last activity (#228,
// ADR 0040). The server refuses anything but whole days from 1 to 3650 (`invalid_retention`); these helpers keep the
// forms within that, word each period and name the setting `PATCH /org` takes for it.
import type { UpdateOrgSettings } from "@commissary/contract/orgs";

/** The shortest and longest period the server accepts, in days. */
export const MIN_RETENTION_DAYS = 1;

export const MAX_RETENTION_DAYS = 3650;

/** The period the panel suggests where none is set, and the default of an org created now. */
export const SUGGESTED_RETENTION_DAYS = 90;

/** What an org keeps for a period: its usage records, or its agent runs (counted from their last activity). */
export type Retained = "usage" | "runs";

/** The agent runs' period the panel suggests where none is set: every org's default. */
export const SUGGESTED_RUN_RETENTION_DAYS = 30;

/** The period suggested where none is set, for what `retained` names. */
export const suggestedDays = (retained: Retained): number =>
  retained === "usage" ? SUGGESTED_RETENTION_DAYS : SUGGESTED_RUN_RETENTION_DAYS;

/** The body of `PATCH /org` that sets the period of `retained` to `days` (`null`: kept until the org is deleted). */
export const retentionPayload = (retained: Retained, days: number | null): UpdateOrgSettings =>
  retained === "usage" ? { usage_retention_days: days } : { run_retention_days: days };

/** The days a text input names: a whole number within the accepted range; `undefined` otherwise. */
export const parseRetentionDays = (text: string): number | undefined => {
  const trimmed = text.trim();

  if (!/^\d+$/.test(trimmed)) return undefined;
  const days = Number(trimmed);

  return days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS ? days : undefined;
};

const daysText = (days: number): string => (days === 1 ? "1 day" : `${days} days`);

/**
 * What the org keeps, as a sentence: "Usage records are kept for 90 days.", "Agent runs are kept for 30 days after
 * their last activity."
 */
export const retentionSentence = (days: number | null, retained: Retained = "usage"): string => {
  const what = retained === "usage" ? "Usage records" : "Agent runs";

  if (days === null) return `${what} are kept until the org is deleted.`;

  return retained === "usage"
    ? `${what} are kept for ${daysText(days)}.`
    : `${what} are kept for ${daysText(days)} after their last activity.`;
};

/** The name an org export is saved under: `acme-export-2026-10-14.json`. */
export const exportFileName = (slug: string, now: number): string =>
  `${slug}-export-${new Date(now).toISOString().slice(0, 10)}.json`;

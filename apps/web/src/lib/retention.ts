// Retention (ADR 0027): how long an org keeps its usage records. The server refuses anything but whole days from 1 to
// 3650 (`invalid_retention`); these helpers keep the form within that, word the period and name the setting `PATCH /org`
// takes for it.
import type { UpdateOrgSettings } from "@commissary/contract/orgs";

/** The shortest and longest period the server accepts, in days. */
export const MIN_RETENTION_DAYS = 1;

export const MAX_RETENTION_DAYS = 3650;

/** The period the panel suggests where none is set, and the default of an org created now. */
export const SUGGESTED_RETENTION_DAYS = 90;

/** The body of `PATCH /org` that sets the usage records' period to `days` (`null`: kept until the org is deleted). */
export const retentionPayload = (days: number | null): UpdateOrgSettings => ({
  usage_retention_days: days,
});

/** The days a text input names: a whole number within the accepted range; `undefined` otherwise. */
export const parseRetentionDays = (text: string): number | undefined => {
  const trimmed = text.trim();

  if (!/^\d+$/.test(trimmed)) return undefined;
  const days = Number(trimmed);

  return days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS ? days : undefined;
};

const daysText = (days: number): string => (days === 1 ? "1 day" : `${days} days`);

/** What the org keeps, as a sentence: "Usage records are kept for 90 days." */
export const retentionSentence = (days: number | null): string =>
  days === null
    ? "Usage records are kept until the org is deleted."
    : `Usage records are kept for ${daysText(days)}.`;

/** The name an org export is saved under: `acme-export-2026-10-14.json`. */
export const exportFileName = (slug: string, now: number): string =>
  `${slug}-export-${new Date(now).toISOString().slice(0, 10)}.json`;

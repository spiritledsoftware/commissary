/**
 * What a refusal by a Spend limit says (ADR 0024): one wording for every area, a model request's `spend_limit_reached`
 * and a refused tool call's tool error (#199).
 */
import type { Refusal, SubjectKind } from "./model.ts";

/** "daily": how a limit's period reads in its refusal. */
const ADJECTIVE = { day: "daily", week: "weekly", month: "monthly" } as const;

/** Whose limit refused, as the caller is told. */
const SUBJECT: Readonly<Record<SubjectKind, string>> = {
  key: "this API key",
  member: "your membership",
  team: "your team",
  org: "your org",
  credential: "this credential",
  toolkit_credential: "this toolkit's shared credential",
  agent: "this agent",
};

/** "The daily Spend limit of this API key is reached; it resets at <ISO time>". */
export const spendRefusalMessage = (refusal: Refusal): string =>
  `The ${ADJECTIVE[refusal.period]} Spend limit of ${SUBJECT[refusal.kind]} is reached; it resets at ${new Date(
    refusal.resetsAt,
  ).toISOString()}`;

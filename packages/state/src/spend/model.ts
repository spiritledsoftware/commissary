/**
 * Spend limits, the shapes shared by the store, the ledger and the selection (issue #71). New in the Workers port, no Go
 * counterpart.
 *
 * A **Spend limit** caps the Cost (micro-USD) that one subject may spend in one period. The subject is a member, a
 * team, the org, a shared credential (a Models credential, or a toolkit's shared credential, #199), an API key or a
 * shared agent (#226); the periods are a day, a week and a month in the org's time zone (`period.ts`). Spend is counted
 * per **scope** (a subject) and period, not per limit: an admin's and a member's limit on one API key share a counter.
 * A counter starts when the first limit of its scope and period is written, and goes when the last one is deleted.
 */
import { Schema } from "effect";
import type { Period, WeekStart } from "./period.ts";

export const SUBJECT_KINDS = [
  "member",
  "team",
  "org",
  "credential",
  "key",
  "toolkit_credential",
  "agent",
] as const;

export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** The kinds of a shared credential's limit: a Models credential's (by its id), or a toolkit's shared credential's. */
export type CredentialKind = Extract<SubjectKind, "credential" | "toolkit_credential">;

/** The subject of the `org` kind: the org itself has no id. */
export const ORG_SUBJECT = "";

/** A subject whose Spend is counted: it crosses the Durable Object RPC boundary inside a lease. */
export const SpendScope = Schema.Struct({
  kind: Schema.Literals(SUBJECT_KINDS),
  subject: Schema.String,
});

export type SpendScope = typeof SpendScope.Type;

/** Who wrote a limit: an org admin (any subject) or a member (their own API keys only). */
export const LIMIT_SOURCES = ["admin", "member"] as const;

export type LimitSource = (typeof LIMIT_SOURCES)[number];

export interface SpendLimit {
  readonly id: string;
  readonly kind: SubjectKind;
  /** A member, team, credential, API key, toolkit or shared agent id; empty for the org. */
  readonly subject: string;
  readonly period: Period;
  /** Micro-USD (1 USD = 1,000,000), at least 0 (nothing may be spent). */
  readonly amountMicros: number;
  readonly source: LimitSource;
  /** Counts the edits of this entry, so an editor holding an old copy is refused (`If-Match`). */
  readonly revision: number;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The principal that wrote it last. */
  readonly updatedBy: string;
}

/** The org's calendar for periods: an IANA time zone and the first day of the week. */
export interface SpendSettings {
  readonly timeZone: string;
  readonly weekStart: WeekStart;
}

/** The limit a request ran into: which subject's, in which period, and when the period ends (epoch ms). */
export interface Refusal {
  readonly kind: SubjectKind;
  readonly period: Period;
  readonly resetsAt: number;
}

/**
 * What the Spend limits say about a request before a credential is chosen:
 * - `refuse`: a limit of the request's API key has no room, so nothing may serve it;
 * - `sharedBlocked`: a member, team or org limit has no room, so only the member's private credentials may serve it;
 * - `credentials`: the shared Models credentials whose own limit has no room, skipped like unavailable ones.
 */
export interface SpendGate {
  readonly refuse?: Refusal;
  readonly sharedBlocked?: Refusal;
  readonly credentials: ReadonlyMap<string, Refusal>;
}

/** The credential that serves a request or a tool call: a Models credential (the default kind) or a toolkit's. */
export interface ChargedCredential {
  /** A Models credential's id, or the toolkit's id for its shared credential. */
  readonly id: string;
  readonly shared: boolean;
  readonly kind?: CredentialKind | undefined;
}

/**
 * Who a request is for, as the limits see it. A hosted agent's run (#228, ADR 0040) has no API key: a private agent's
 * run is its member's (`memberId`), and a shared agent's run is the agent's own (`agentId`, with no member), so it
 * counts toward the agent's limit and the org's, never its starter's.
 */
export interface SpendCaller {
  readonly memberId?: string | undefined;
  readonly apiKeyId?: string | undefined;
  /** A shared agent whose run this is: its own Spend limits apply, as a member's do to their traffic. */
  readonly agentId?: string | undefined;
}

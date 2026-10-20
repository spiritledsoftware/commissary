/**
 * The Spend ledger: which Spend limits a request meets before a credential is chosen (the {@link SpendGate}), which
 * scopes its Cost is charged to afterwards, and the charge itself (issue #71). New in the Workers port, no Go
 * counterpart.
 *
 * Pure over a {@link SpendBook}, the storage of limits and counters (`store.ts` in the ControlPlane, a map in tests), so
 * the boundaries of periods are driven by the `now` of the caller.
 *
 * - An API key's limits count everything the key spends, whatever credential served it.
 * - Member, team, org and credential limits count traffic served by a **shared** credential only: what a private
 *   credential serves is the member's own account with the provider, so only a key limit sees it. A tool call (#199)
 *   counts the same way; its shared credential is the toolkit's (a `toolkit` limit).
 * - A limit with no room refuses (key), keeps the shared credentials away (member, team, org) or skips one credential
 *   (credential limit): the `gate`. A tool call has one credential to go to, so any limit it would be charged to
 *   without room refuses it (`refusal`). Several limits on one subject and period (an admin's and a member's) are enforced
 *   together, so the smaller amount binds.
 * - A scope is charged only while it has a limit: an org without limits stores no counters, and `gate` answers at once.
 */
import { type Period, type PeriodBounds, periodBounds } from "./period.ts";
import {
  type ChargedCredential,
  ORG_SUBJECT,
  type Refusal,
  type SpendCaller,
  type SpendGate,
  type SpendLimit,
  type SpendScope,
  type SpendSettings,
} from "./model.ts";

/** Limits, settings and counters as the ledger reads and writes them. */
export interface SpendBook {
  settings(): SpendSettings;
  limits(): ReadonlyArray<SpendLimit>;
  /** Micro-USD spent in the period that began at `periodStart` (epoch ms). */
  spent(scope: SpendScope, period: Period, periodStart: number): number;
  /** Adds to the counter of the period that began at `periodStart`; counters of earlier periods may be dropped. */
  charge(scope: SpendScope, period: Period, periodStart: number, micros: number): void;
}

/** The slice of the ledger the credential pool uses. */
export interface SpendPolicy {
  /** `undefined` when no limit applies to the request. */
  gate(caller: SpendCaller, now: number): SpendGate | undefined;
  /** The scopes a request served by `credential` is charged to (only those with a limit). */
  scopes(caller: SpendCaller, credential: ChargedCredential): ReadonlyArray<SpendScope>;
  charge(scopes: ReadonlyArray<SpendScope>, micros: number, now: number): void;
}

type Bounds = Readonly<Record<Period, PeriodBounds>>;

const sameScope = (limit: SpendLimit, scope: SpendScope): boolean =>
  limit.kind === scope.kind && limit.subject === scope.subject;

export class SpendLedger implements SpendPolicy {
  readonly #book: SpendBook;
  readonly #teamsOf: (memberId: string) => ReadonlyArray<string>;

  /** `teamsOf`: the teams a member is on; only asked while the org has limits. */
  constructor(book: SpendBook, teamsOf: (memberId: string) => ReadonlyArray<string>) {
    this.#book = book;
    this.#teamsOf = teamsOf;
  }

  gate(caller: SpendCaller, now: number): SpendGate | undefined {
    const limits = this.#book.limits();

    if (limits.length === 0) return undefined;
    const bounds = this.#boundsAt(now);
    const refuse = this.#exhausted(limits, this.#keyScopes(caller), bounds);
    const sharedBlocked = this.#exhausted(limits, this.#sharedScopes(caller), bounds);
    const credentials = new Map<string, Refusal>();

    for (const limit of limits) {
      if (limit.kind !== "credential" || credentials.has(limit.subject)) continue;

      const held = this.#exhausted(
        limits,
        [{ kind: "credential", subject: limit.subject }],
        bounds,
      );

      if (held !== undefined) credentials.set(limit.subject, held);
    }

    if (refuse === undefined && sharedBlocked === undefined && credentials.size === 0)
      return undefined;

    return {
      ...(refuse === undefined ? {} : { refuse }),
      ...(sharedBlocked === undefined ? {} : { sharedBlocked }),
      credentials,
    };
  }

  scopes(caller: SpendCaller, credential: ChargedCredential): ReadonlyArray<SpendScope> {
    const limits = this.#book.limits();

    if (limits.length === 0) return [];

    return this.#chargedScopes(caller, credential).filter((scope) =>
      limits.some((limit) => sameScope(limit, scope)),
    );
  }

  /**
   * The limit without room that a call served by `credential` alone would be charged to, if any: the one that frees up
   * last. For a tool call (#199), which has no other credential to go to, so any such limit refuses it.
   */
  refusal(caller: SpendCaller, credential: ChargedCredential, now: number): Refusal | undefined {
    const limits = this.#book.limits();

    if (limits.length === 0) return undefined;

    return this.#exhausted(limits, this.#chargedScopes(caller, credential), this.#boundsAt(now));
  }

  charge(scopes: ReadonlyArray<SpendScope>, micros: number, now: number): void {
    const amount = Math.max(0, Math.round(micros));

    if (amount === 0 || scopes.length === 0) return;
    const limits = this.#book.limits();
    const bounds = this.#boundsAt(now);

    for (const scope of scopes) {
      const periods = new Set<Period>();

      for (const limit of limits) if (sameScope(limit, scope)) periods.add(limit.period);

      for (const period of periods) this.#book.charge(scope, period, bounds[period].start, amount);
    }
  }

  #boundsAt(now: number): Bounds {
    const { timeZone, weekStart } = this.#book.settings();

    return {
      day: periodBounds("day", now, timeZone, weekStart),
      week: periodBounds("week", now, timeZone, weekStart),
      month: periodBounds("month", now, timeZone, weekStart),
    };
  }

  /** Every scope a call served by `credential` counts toward, with a limit or not. */
  #chargedScopes(caller: SpendCaller, credential: ChargedCredential): ReadonlyArray<SpendScope> {
    return [
      ...this.#keyScopes(caller),
      ...(credential.shared
        ? [
            ...this.#sharedScopes(caller),
            { kind: credential.kind ?? "credential", subject: credential.id },
          ]
        : []),
    ];
  }

  #keyScopes(caller: SpendCaller): ReadonlyArray<SpendScope> {
    return caller.apiKeyId === undefined ? [] : [{ kind: "key", subject: caller.apiKeyId }];
  }

  /** The member, their teams and the org: the limits that shared credentials answer to. */
  #sharedScopes(caller: SpendCaller): ReadonlyArray<SpendScope> {
    return [
      ...(caller.memberId === undefined
        ? []
        : [
            { kind: "member" as const, subject: caller.memberId },
            ...this.#teamsOf(caller.memberId).map((team) => ({
              kind: "team" as const,
              subject: team,
            })),
          ]),
      { kind: "org", subject: ORG_SUBJECT },
    ];
  }

  /**
   * The limit of `scopes` without room that frees up last: a request needs room under every limit, so it can be served
   * again only once the last of them has reset.
   */
  #exhausted(
    limits: ReadonlyArray<SpendLimit>,
    scopes: ReadonlyArray<SpendScope>,
    bounds: Bounds,
  ): Refusal | undefined {
    const smallest = new Map<string, SpendLimit>();

    for (const limit of limits) {
      if (!scopes.some((scope) => sameScope(limit, scope))) continue;
      const key = `${limit.kind}\0${limit.subject}\0${limit.period}`;
      const known = smallest.get(key);

      if (known === undefined || limit.amountMicros < known.amountMicros) smallest.set(key, limit);
    }

    let refusal: Refusal | undefined;

    for (const limit of smallest.values()) {
      const { start, end } = bounds[limit.period];
      const scope = { kind: limit.kind, subject: limit.subject };

      if (this.#book.spent(scope, limit.period, start) < limit.amountMicros) continue;

      if (refusal === undefined || end > refusal.resetsAt)
        refusal = { kind: limit.kind, period: limit.period, resetsAt: end };
    }

    return refusal;
  }
}

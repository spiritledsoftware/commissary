/**
 * What the management API does with Spend limits (issue #71): who may write which limit, what each viewer sees with the
 * Spend so far, and the translation of a credential limit's subject between the stored credential id and the
 * `auth_index` clients know. New in the Workers port, no Go counterpart. The org-wide base's since #199: the shared
 * credentials come from the areas' parts (a Models credential, a toolkit's shared credential).
 *
 * - An **org admin** writes any limit (source `admin`) and the org's calendar, and sees every limit.
 * - A **plain member** writes limits on their own API keys only (source `member`, never above an admin's limit on
 *   that key, which the store keeps), and sees the limits that bind them: their own, their teams', the org's and those
 *   on their API keys, each with what is left.
 *
 * Plain data in and out, so the ControlPlane can hand it across Durable Object RPC. The ControlPlane supplies the
 * {@link SpendDirectory} (members, teams, keys, shared credentials) and the clock.
 */
import type { Viewer } from "@commissary/auth";
import { SpendLedger } from "./ledger.ts";
import {
  type CredentialKind,
  type LimitSource,
  ORG_SUBJECT,
  type SpendLimit,
  type SpendScope,
  type SpendSettings,
  type SubjectKind,
} from "./model.ts";
import { type Period, periodBounds, PERIODS } from "./period.ts";
import type { SpendErrorCode, SpendResult, SpendStore } from "./store.ts";

/** What the service knows of the org besides the limits. */
export interface SpendDirectory {
  members(): ReadonlyArray<{
    readonly id: string;
    readonly email: string;
    readonly teams: ReadonlyArray<string>;
  }>;
  teams(): ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The ids of the teams a member is on (asked on every request while the org has limits). */
  teamsOf(memberId: string): ReadonlyArray<string>;
  /** Every API key, revoked ones included. */
  keys(): ReadonlyArray<{
    readonly id: string;
    readonly memberId: string;
    readonly name: string;
    readonly prefix: string;
    readonly revokedAt?: number | undefined;
  }>;
  /** The shared credentials of every area (a private credential has no limit of its own). */
  credentials(): ReadonlyArray<SpendCredential>;
}

/** A shared credential a limit may name, as an area's part describes it (`ControlPlanePart.spendCredentials`). */
export interface SpendCredential {
  readonly kind: CredentialKind;
  /** What the limit stores: a Models credential's id, a toolkit's id. */
  readonly id: string;
  /** What clients name it by: a Models credential's keyed `auth_index`, a toolkit's id. */
  readonly publicId: string;
  /** What to show for it: `<provider>: <label>`, the toolkit's name. */
  readonly label: string;
}

export type SpendServiceErrorCode = SpendErrorCode | "forbidden" | "subject_not_found";

export interface SpendServiceRefused {
  readonly ok: false;
  readonly error: SpendServiceErrorCode;
  readonly message: string;
}

export type SpendServiceResult<A> = { readonly ok: true; readonly value: A } | SpendServiceRefused;

/** A limit as a viewer sees it: with its subject named and what has been spent in the current period. */
export interface SpendEntry {
  readonly id: string;
  readonly kind: SubjectKind;
  /** Member, team, API key and toolkit ids; the `auth_index` of a credential; empty for the org. */
  readonly subject: string;
  /** What to show for the subject: an email, a team name, an API key's name, a credential's label, a toolkit's name. */
  readonly label: string;
  readonly period: Period;
  readonly amountMicros: number;
  readonly source: LimitSource;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
  /** Micro-USD spent in the current period (the counter of the subject, which an admin's and a member's limit share). */
  readonly spentMicros: number;
  /** When the current period began and ends (epoch ms). */
  readonly periodStart: number;
  readonly resetsAt: number;
  /** Whether the viewer may edit and delete it. */
  readonly editable: boolean;
}

export interface SpendOverview {
  readonly settings: SpendSettings;
  readonly entries: ReadonlyArray<SpendEntry>;
  /** Epoch ms the Spend was read at. */
  readonly now: number;
}

export interface NewSpendLimit {
  readonly kind: SubjectKind;
  /** As in {@link SpendEntry.subject}. */
  readonly subject: string;
  readonly period: Period;
  readonly amountMicros: number;
}

const refuse = (error: SpendServiceErrorCode, message: string): SpendServiceRefused => ({
  ok: false,
  error,
  message,
});

const KIND_ORDER: Readonly<Record<SubjectKind, number>> = {
  org: 0,
  team: 1,
  member: 2,
  key: 3,
  credential: 4,
  toolkit: 5,
};

export class SpendService {
  readonly #store: SpendStore;
  readonly #directory: SpendDirectory;
  readonly #now: () => number;

  constructor(store: SpendStore, directory: SpendDirectory, now: () => number = Date.now) {
    this.#store = store;
    this.#directory = directory;
    this.#now = now;
  }

  /** The limits `viewer` sees with their Spend; a viewer who is no member of the org sees the org's limits only. */
  overview(viewer: Viewer): SpendOverview {
    const now = this.#now();
    const settings = this.#store.settings();
    const names = this.#names();

    const mine =
      viewer.member === undefined
        ? undefined
        : this.#directory.members().find((member) => member.id === viewer.member);

    const keys = new Map(this.#directory.keys().map((key) => [key.id, key]));
    const entries: Array<SpendEntry> = [];

    for (const limit of this.#store.limits()) {
      const label = names.label(limit);

      if (label === undefined) continue;

      if (!viewer.admin && !this.#visible(limit, viewer.member, mine?.teams ?? [], keys)) continue;

      const { start, end } = periodBounds(limit.period, now, settings.timeZone, settings.weekStart);
      const scope: SpendScope = { kind: limit.kind, subject: limit.subject };

      entries.push({
        id: limit.id,
        kind: limit.kind,
        subject: names.publicSubject(limit),
        label,
        period: limit.period,
        amountMicros: limit.amountMicros,
        source: limit.source,
        revision: limit.revision,
        createdAt: limit.createdAt,
        updatedAt: limit.updatedAt,
        updatedBy: limit.updatedBy,
        spentMicros: this.#store.spent(scope, limit.period, start),
        periodStart: start,
        resetsAt: end,
        editable: this.#mayWrite(viewer, limit, keys),
      });
    }

    entries.sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.label.localeCompare(b.label) ||
        PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period) ||
        a.source.localeCompare(b.source),
    );

    return { settings, entries, now };
  }

  create(viewer: Viewer, input: NewSpendLimit, by: string): SpendServiceResult<SpendEntry> {
    const keys = new Map(this.#directory.keys().map((key) => [key.id, key]));
    let subject = input.subject;

    // Who may write comes before whether the subject exists, so a member cannot tell other ids apart by the answer:
    // their own API keys are the only thing they may limit.
    if (!viewer.admin) {
      const key = input.kind === "key" ? keys.get(subject) : undefined;

      if (key === undefined || key.memberId !== viewer.member)
        return refuse("forbidden", "members may limit their own API keys only");
    }

    if (input.kind === "credential" || input.kind === "toolkit") {
      const credential = this.#directory
        .credentials()
        .find((candidate) => candidate.kind === input.kind && candidate.publicId === input.subject);

      if (credential === undefined)
        return refuse(
          "subject_not_found",
          input.kind === "credential"
            ? "no shared credential has this auth_index"
            : "no org toolkit with this id has a shared credential",
        );
      subject = credential.id;
    } else if (input.kind === "member") {
      if (!this.#directory.members().some((member) => member.id === subject))
        return refuse("subject_not_found", "no member has this id");
    } else if (input.kind === "team") {
      if (!this.#directory.teams().some((team) => team.id === subject))
        return refuse("subject_not_found", "no team has this id");
    } else if (input.kind === "key") {
      const key = keys.get(subject);

      if (key === undefined || key.revokedAt !== undefined)
        return refuse("subject_not_found", "no live API key has this id");
    } else if (subject !== ORG_SUBJECT) {
      return refuse("invalid", "the org limit has no subject");
    }

    const source: LimitSource = viewer.admin ? "admin" : "member";

    return this.#entryOf(
      viewer,
      this.#store.create(
        {
          kind: input.kind,
          subject,
          period: input.period,
          amountMicros: input.amountMicros,
          source,
        },
        by,
      ),
    );
  }

  update(
    viewer: Viewer,
    id: string,
    revision: number,
    amountMicros: number,
    by: string,
  ): SpendServiceResult<SpendEntry> {
    const denied = this.#writable(viewer, id);

    return denied ?? this.#entryOf(viewer, this.#store.update(id, revision, amountMicros, by));
  }

  /** Answers the limit as it was just before it went. */
  remove(viewer: Viewer, id: string, revision: number): SpendServiceResult<SpendEntry> {
    const denied = this.#writable(viewer, id);

    if (denied !== undefined) return denied;
    const before = this.overview(viewer).entries.find((entry) => entry.id === id);
    const removed = this.#store.remove(id, revision);

    if (!removed.ok) return removed;

    if (before !== undefined) return { ok: true, value: before };

    // A limit whose subject is gone is not listed (so it has no label), but it is removed all the same.
    const gone = removed.value;
    const now = this.#now();

    return {
      ok: true,
      value: {
        ...gone,
        label: "",
        spentMicros: 0,
        periodStart: now,
        resetsAt: now,
        editable: true,
      },
    };
  }

  settings(): SpendSettings {
    return this.#store.settings();
  }

  /** Only an org admin sets the calendar; the caller checked. */
  setSettings(settings: {
    readonly timeZone?: string | undefined;
    readonly weekStart?: string | undefined;
  }): SpendResult<SpendSettings> {
    return this.#store.setSettings(settings);
  }

  /** A gone member, team, API key or credential: its limits and counters go. */
  forget(kind: SubjectKind, subject: string): void {
    this.#store.forget(kind, subject);
  }

  /** The ledger over the same store, for the pool. */
  ledger(): SpendLedger {
    return new SpendLedger(this.#store, (memberId) => this.#directory.teamsOf(memberId));
  }

  /** The written limit as its writer sees it. */
  #entryOf(viewer: Viewer, written: SpendResult<SpendLimit>): SpendServiceResult<SpendEntry> {
    if (!written.ok) return written;

    const entry = this.overview(viewer).entries.find(
      (candidate) => candidate.id === written.value.id,
    );

    return entry === undefined
      ? refuse("not_found", "limit not found")
      : { ok: true, value: entry };
  }

  #writable(viewer: Viewer, id: string): SpendServiceRefused | undefined {
    const limit = this.#store.limit(id);

    if (limit === undefined) return undefined;

    const keys = new Map(this.#directory.keys().map((key) => [key.id, key]));

    return this.#mayWrite(viewer, limit, keys)
      ? undefined
      : refuse("forbidden", "this limit is set by an org admin");
  }

  #mayWrite(
    viewer: Viewer,
    limit: SpendLimit,
    keys: ReadonlyMap<string, { readonly memberId: string }>,
  ): boolean {
    if (viewer.admin) return true;

    return (
      limit.kind === "key" &&
      limit.source === "member" &&
      keys.get(limit.subject)?.memberId === viewer.member
    );
  }

  #visible(
    limit: SpendLimit,
    member: string | undefined,
    teams: ReadonlyArray<string>,
    keys: ReadonlyMap<string, { readonly memberId: string }>,
  ): boolean {
    switch (limit.kind) {
      case "org":
        return true;
      case "member":
        return member !== undefined && limit.subject === member;
      case "team":
        return teams.includes(limit.subject);
      case "key":
        return member !== undefined && keys.get(limit.subject)?.memberId === member;
      case "credential":
      case "toolkit":
        return false;
    }
  }

  /** Labels and public subjects; a limit whose subject is gone has no label and is not listed. */
  #names() {
    const members = new Map(this.#directory.members().map((member) => [member.id, member.email]));
    const teams = new Map(this.#directory.teams().map((team) => [team.id, team.name]));

    const keys = new Map(
      this.#directory.keys().map((key) => [key.id, `${key.name} (${key.prefix})`]),
    );

    // Only credential and toolkit limits need the credentials (and a Models credential's keyed `auth_index`).
    let credentials: ReadonlyMap<string, SpendCredential> | undefined;

    const credentialOf = (kind: CredentialKind, id: string) => {
      credentials ??= new Map(
        this.#directory
          .credentials()
          .map((credential) => [`${credential.kind}\0${credential.id}`, credential]),
      );

      return credentials.get(`${kind}\0${id}`);
    };

    return {
      label: (limit: SpendLimit): string | undefined => {
        switch (limit.kind) {
          case "org":
            return "Whole org";
          case "member":
            return members.get(limit.subject);
          case "team":
            return teams.get(limit.subject);
          case "key":
            return keys.get(limit.subject);
          case "credential":
          case "toolkit":
            return credentialOf(limit.kind, limit.subject)?.label;
        }
      },
      publicSubject: (limit: SpendLimit): string =>
        limit.kind === "credential" || limit.kind === "toolkit"
          ? (credentialOf(limit.kind, limit.subject)?.publicId ?? "")
          : limit.subject,
    };
  }
}

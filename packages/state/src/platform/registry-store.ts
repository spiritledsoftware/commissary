/**
 * The Platform registry's tables (ADR 0021), in the SQLite database of the `Platform` Durable Object: the deployment's
 * orgs, and an index of which orgs each person (email) and each Access service token belong to. New in the Workers
 * port.
 *
 * The orgs table is the registry's own data. The index is not: each org's ControlPlane stays authoritative for its
 * membership, and the registry only keeps a copy for routing, so {@link PlatformStore.replaceOrgIndex} rebuilds one org's
 * rows from what its ControlPlane says. The first start creates the org `global` (slug `default`), the deployment that
 * existed before orgs, so upgrading needs no settings and moves no data.
 *
 * An org also has its retention periods here (ADR 0027), the org settings the scheduled jobs read for every org at once:
 * its usage records' (`usage_retention_days`), a number of days, or NULL for none (keep records forever), which
 * `global` starts with none of and an org created afterwards with {@link DEFAULT_USAGE_RETENTION_DAYS}; and its agent
 * runs' after their last activity (`run_retention_days`, #228, ADR 0040), {@link DEFAULT_RUN_RETENTION_DAYS} for every
 * org until an org admin sets another, or none. Removing an org or a person deletes their rows.
 *
 * Commissary Cloud (ADR 0026) also keeps its people here: who signed up (and the Personal org they got), how many orgs
 * each may own, and who a platform admin suspended; orgs record who created them and whether they are suspended.
 *
 * Its per-org single sign-on (issue #76) keeps the domain-to-org index here (`sso_domains`): which org verified each
 * email domain, so a sign-in finds the org's identity provider from an email, one verified domain belongs to at most
 * one org, and GitHub and Google sign-in can be refused for a domain whose org requires single sign-on. The org's
 * ControlPlane stays authoritative for its identity provider and its domains (`sso/store.ts`).
 */
import { Schema } from "effect";
import type { IndexRepair, OrgIndex, SsoDomainRecord, Standing } from "@commissary/auth";
import { DEFAULT_ORG_SLUG, GLOBAL_ORG, newOrgId, OrgId, OrgSlug } from "@commissary/core";

/** An org as the registry lists it. */
export interface OrgRecord {
  /** Permanent: names the org's ControlPlane and every name derived from it. */
  readonly id: OrgId;
  /** Addresses the org in URLs; unique, renamable. */
  readonly slug: OrgSlug;
  readonly name: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** How many days the org's usage records are kept; `null`: forever (ADR 0027). */
  readonly usageRetentionDays: number | null;
  /** How many days the org's agent runs are kept after their last activity (#228, ADR 0040); `null`: forever. */
  readonly runRetentionDays: number | null;
  /** The (lowercased) email of the person who created it on Commissary Cloud; absent otherwise. */
  readonly createdBy?: string;
  /** Epoch milliseconds a platform admin suspended it; absent while it is not suspended. */
  readonly suspendedAt?: number;
}

/** New orgs keep their usage records this long unless an admin chooses otherwise (ADR 0027). */
export const DEFAULT_USAGE_RETENTION_DAYS = 90;

/** The longest retention period an org can choose (ten years), of usage records and of agent runs; longer is "none". */
export const MAX_RETENTION_DAYS = 3650;

/** Orgs keep their agent runs this long after their last activity unless an admin chooses otherwise (ADR 0040). */
export const DEFAULT_RUN_RETENTION_DAYS = 30;

/** `id`: the permanent id to create the org under (a caller that prepared the org's ControlPlane first); default: a fresh one. */
export type OrgInput = {
  readonly slug: string;
  readonly name: string;
  readonly id?: OrgId;
  /**
   * A person creating an org on Commissary Cloud, and how many orgs a person may own unless a platform admin gave them
   * another limit: the org is refused (`org_limit_reached`) once they created that many.
   */
  readonly createdBy?: { readonly email: string; readonly defaultLimit: number };
};

export type OrgPatch = { readonly slug?: string; readonly name?: string };

/** The retention periods a write changes (#228): in days, `null` for none; absent: unchanged. */
export interface RetentionPeriods {
  readonly usageDays?: number | null;
  readonly runDays?: number | null;
}

/** Why an org write was refused; `message` is fixed text, safe to show. */
export type OrgWriteResult =
  | { readonly ok: true; readonly org: OrgRecord }
  | {
      readonly ok: false;
      readonly error:
        | "invalid_slug"
        | "invalid_name"
        | "invalid_retention"
        | "slug_taken"
        | "not_found"
        | "org_limit_reached";
      readonly message: string;
    };

/** What removing an org did: it can never remove `global`. */
export type OrgRemoval =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: "global" | "not_found";
      readonly message: string;
    };

/** A person of Commissary Cloud, as platform admins see them. */
export interface PersonRecord {
  /** Lowercased. */
  readonly email: string;
  /** Epoch ms of their first sign-in; absent before it. */
  readonly signedUpAt?: number;
  /** How many orgs they may own: a platform admin's choice, or the deployment's default. */
  readonly orgLimit: number;
  /** Whether {@link orgLimit} is a platform admin's choice for them. */
  readonly orgLimitSet: boolean;
  /** How many orgs they created (their Personal org included). */
  readonly ownedOrgs: number;
  readonly suspendedAt?: number;
}

/** What a platform admin changes about a person: `orgLimit: null` returns them to the deployment's default. */
export interface PersonPatch {
  readonly orgLimit?: number | null;
  readonly suspended?: boolean;
}

/**
 * Where a person who signed in stands (`signIn`): suspended; signed up (or a member of some org, so invited:
 * `signUp` is recorded then); or due a Personal org, already created here, that the Worker still has to give them
 * (make them its owner, then `finishSignUp`).
 */
export type SignInState =
  | { readonly kind: "suspended" }
  | { readonly kind: "ready" }
  | { readonly kind: "personal"; readonly org: OrgRecord };

/** What claiming a verified domain for an org did. */
export type SsoDomainClaim =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "domain_taken" | "not_found"; readonly message: string };

/** The most orgs a platform admin may let one person own. */
export const MAX_ORG_LIMIT = 1000;

/** The name of the org a person gets when they sign up without an invitation. */
export const PERSONAL_ORG_NAME = "Personal";

export const MAX_NAME_LENGTH = 100;

/**
 * A display name (of an org, a team or a service token): 1 to 100 characters after trimming, without control
 * characters; `undefined` otherwise.
 */
export const cleanName = (name: string): string | undefined => {
  const trimmed = name.trim();
  // Code points, so one emoji counts as one character.
  const characters = Array.from(trimmed);

  const control = characters.some((character) => {
    const code = character.codePointAt(0) ?? 0;

    return code < 0x20 || code === 0x7f;
  });

  return characters.length > 0 && characters.length <= MAX_NAME_LENGTH && !control
    ? trimmed
    : undefined;
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
  usage_retention_days: number | null;
  run_retention_days: number | null;
  created_by: string | null;
  suspended_at: number | null;
  [column: string]: SqlStorageValue;
}

interface PersonRow {
  email: string;
  signed_up_at: number | null;
  personal_org: string | null;
  org_limit: number | null;
  suspended_at: number | null;
  [column: string]: SqlStorageValue;
}

const ORG_COLUMN_NAMES = [
  "id",
  "slug",
  "name",
  "created_at",
  "usage_retention_days",
  "run_retention_days",
  "created_by",
  "suspended_at",
] as const;

const ORG_COLUMNS = ORG_COLUMN_NAMES.join(", ");

/** {@link ORG_COLUMNS} of the table `alias` names in a join. */
const orgColumnsOf = (alias: string): string =>
  ORG_COLUMN_NAMES.map((column) => `${alias}.${column}`).join(", ");

const SLUG_PROBLEM =
  "an org slug is 1 to 63 lowercase letters, digits and inner hyphens (it appears in URLs)";

const RETENTION_PROBLEM = `a usage retention period is a whole number of days from 1 to ${MAX_RETENTION_DAYS}, or none`;

const RUN_RETENTION_PROBLEM = `an agent runs' retention period is a whole number of days from 1 to ${MAX_RETENTION_DAYS}, or none`;

/** Whether `days` is a retention period an org may choose: whole days from 1 to the maximum, or none. */
const validRetention = (days: number | null): boolean =>
  days === null || (Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS);

const NAME_PROBLEM = `an org name is 1 to ${MAX_NAME_LENGTH} characters without control characters`;

export class PlatformStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage, now: number = Date.now()) {
    this.#sql = sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS orgs (
         id TEXT PRIMARY KEY,
         slug TEXT NOT NULL UNIQUE,
         name TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         usage_retention_days INTEGER
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS org_members (
         email TEXT NOT NULL,
         org_id TEXT NOT NULL,
         PRIMARY KEY (email, org_id)
       )`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS org_members_by_org ON org_members (org_id)`);

    sql.exec(
      `CREATE TABLE IF NOT EXISTS org_service_tokens (
         client_id TEXT PRIMARY KEY,
         org_id TEXT NOT NULL
       )`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS org_service_tokens_by_org ON org_service_tokens (org_id)`);

    // Hosted proxies (ADR 0026): who created an org and whether it is suspended, and the people who signed up.
    const orgColumns = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info(orgs)")
        .toArray()
        .map((column) => column.name),
    );

    if (!orgColumns.has("created_by")) sql.exec(`ALTER TABLE orgs ADD COLUMN created_by TEXT`);

    if (!orgColumns.has("suspended_at"))
      sql.exec(`ALTER TABLE orgs ADD COLUMN suspended_at INTEGER`);

    // Agent runs' retention (#228): every org, those from before included, starts with the default.
    if (!orgColumns.has("run_retention_days"))
      sql.exec(
        `ALTER TABLE orgs ADD COLUMN run_retention_days INTEGER DEFAULT ${DEFAULT_RUN_RETENTION_DAYS}`,
      );
    sql.exec(`CREATE INDEX IF NOT EXISTS orgs_by_creator ON orgs (created_by)`);

    sql.exec(
      `CREATE TABLE IF NOT EXISTS people (
         email TEXT PRIMARY KEY,
         signed_up_at INTEGER,
         personal_org TEXT,
         org_limit INTEGER,
         suspended_at INTEGER
       )`,
    );
    // Single sign-on (issue #76): which org verified each email domain.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS sso_domains (
         domain TEXT PRIMARY KEY,
         org_id TEXT NOT NULL,
         require_sso INTEGER NOT NULL DEFAULT 0
       )`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS sso_domains_by_org ON sso_domains (org_id)`);
    // The deployment that existed before orgs. Left alone when it exists (a platform admin may have renamed it).
    sql.exec(
      `INSERT OR IGNORE INTO orgs (id, slug, name, created_at, usage_retention_days) VALUES (?, ?, ?, ?, NULL)`,
      GLOBAL_ORG,
      DEFAULT_ORG_SLUG,
      "Default",
      now,
    );
  }

  #record(row: OrgRow): OrgRecord {
    return {
      // SAFETY: only ids and slugs that passed `OrgId` / `OrgSlug` are ever inserted (`createOrg`, `updateOrg`, the seed).
      id: row.id as OrgId,
      // SAFETY: as above.
      slug: row.slug as OrgSlug,
      name: row.name,
      createdAt: row.created_at,
      usageRetentionDays: row.usage_retention_days,
      runRetentionDays: row.run_retention_days,
      ...(row.created_by === null ? {} : { createdBy: row.created_by }),
      ...(row.suspended_at === null ? {} : { suspendedAt: row.suspended_at }),
    };
  }

  /** Every org, the seeded `global` first and then oldest first. */
  listOrgs(): ReadonlyArray<OrgRecord> {
    return this.#sql
      .exec<OrgRow>(
        `SELECT ${ORG_COLUMNS} FROM orgs ORDER BY id <> '${GLOBAL_ORG}', created_at, id`,
      )
      .toArray()
      .map((row) => this.#record(row));
  }

  orgBySlug(slug: string): OrgRecord | undefined {
    const row = this.#sql
      .exec<OrgRow>(`SELECT ${ORG_COLUMNS} FROM orgs WHERE slug = ?`, slug)
      .toArray()[0];

    return row === undefined ? undefined : this.#record(row);
  }

  orgById(id: string): OrgRecord | undefined {
    const row = this.#sql
      .exec<OrgRow>(`SELECT ${ORG_COLUMNS} FROM orgs WHERE id = ?`, id)
      .toArray()[0];

    return row === undefined ? undefined : this.#record(row);
  }

  /** Creates an org under a fresh permanent id; the slug must be new. */
  createOrg(input: OrgInput, now: number): OrgWriteResult {
    if (!Schema.is(OrgSlug)(input.slug))
      return { ok: false, error: "invalid_slug", message: SLUG_PROBLEM };
    const name = cleanName(input.name);

    if (name === undefined) return { ok: false, error: "invalid_name", message: NAME_PROBLEM };

    if (this.orgBySlug(input.slug) !== undefined)
      return { ok: false, error: "slug_taken", message: `the slug “${input.slug}” is in use` };

    const creator =
      input.createdBy === undefined ? undefined : normalizeEmail(input.createdBy.email);

    if (
      input.createdBy !== undefined &&
      creator !== undefined &&
      this.#ownedOrgs(creator) >= this.#orgLimit(creator, input.createdBy.defaultLimit)
    )
      return {
        ok: false,
        error: "org_limit_reached",
        message: "you own as many orgs as you may; ask a platform admin to raise your limit",
      };

    // Never derived from the slug: a renamed org's old slug may be taken again, and its id must stay unique.
    const id = input.id ?? newOrgId();

    this.#sql.exec(
      `INSERT INTO orgs (id, slug, name, created_at, usage_retention_days, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.slug,
      name,
      now,
      DEFAULT_USAGE_RETENTION_DAYS,
      creator ?? null,
    );

    const org = this.orgById(id);

    if (org === undefined) throw new Error("the org just created is missing");

    return { ok: true, org };
  }

  /** Renames the org addressed by `slug`: its display name, its slug, or both. The id never changes. */
  updateOrg(slug: string, patch: OrgPatch): OrgWriteResult {
    const current = this.orgBySlug(slug);

    if (current === undefined)
      return { ok: false, error: "not_found", message: `no org has the slug “${slug}”` };
    const nextSlug = patch.slug ?? current.slug;

    if (!Schema.is(OrgSlug)(nextSlug))
      return { ok: false, error: "invalid_slug", message: SLUG_PROBLEM };
    const nextName = patch.name === undefined ? current.name : cleanName(patch.name);

    if (nextName === undefined) return { ok: false, error: "invalid_name", message: NAME_PROBLEM };
    const holder = this.orgBySlug(nextSlug);

    if (holder !== undefined && holder.id !== current.id)
      return { ok: false, error: "slug_taken", message: `the slug “${nextSlug}” is in use` };

    this.#sql.exec(
      `UPDATE orgs SET slug = ?, name = ? WHERE id = ?`,
      nextSlug,
      nextName,
      current.id,
    );

    return { ok: true, org: { ...current, slug: nextSlug, name: nextName } };
  }

  /**
   * Sets how long the usage records of org `id` are kept: whole days from 1 to {@link MAX_RETENTION_DAYS}, or
   * `null` for forever ({@link setRetention}, kept for callers from before #228).
   */
  setUsageRetention(id: string, days: number | null): OrgWriteResult {
    return this.setRetention(id, { usageDays: days });
  }

  /**
   * Sets the retention periods of org `id` that `periods` names (#228): how long its usage records are kept, and its
   * agent runs after their last activity; each whole days from 1 to {@link MAX_RETENTION_DAYS}, or `null` for
   * forever. Nothing changes unless every one named is valid.
   */
  setRetention(id: string, periods: RetentionPeriods): OrgWriteResult {
    const current = this.orgById(id);

    if (current === undefined)
      return { ok: false, error: "not_found", message: "no org has this id" };

    const { usageDays, runDays } = periods;

    if (usageDays !== undefined && !validRetention(usageDays))
      return { ok: false, error: "invalid_retention", message: RETENTION_PROBLEM };

    if (runDays !== undefined && !validRetention(runDays))
      return { ok: false, error: "invalid_retention", message: RUN_RETENTION_PROBLEM };

    const next = {
      ...current,
      ...(usageDays === undefined ? {} : { usageRetentionDays: usageDays }),
      ...(runDays === undefined ? {} : { runRetentionDays: runDays }),
    };

    this.#sql.exec(
      `UPDATE orgs SET usage_retention_days = ?, run_retention_days = ? WHERE id = ?`,
      next.usageRetentionDays,
      next.runRetentionDays,
      id,
    );

    return { ok: true, org: next };
  }

  /**
   * Deletes org `id` and its index rows at once (ADR 0027): the org leaves the list, its slug is free to take again,
   * and nobody is indexed in it. The caller has already wiped the org's data. `global` is never removed.
   */
  deleteOrg(id: string): OrgRemoval {
    if (id === GLOBAL_ORG)
      return { ok: false, error: "global", message: "the first org cannot be deleted" };

    if (this.orgById(id) === undefined)
      return { ok: false, error: "not_found", message: "no org has this id" };

    this.#sql.exec(`DELETE FROM org_members WHERE org_id = ?`, id);
    this.#sql.exec(`DELETE FROM org_service_tokens WHERE org_id = ?`, id);
    this.#sql.exec(`UPDATE people SET personal_org = NULL WHERE personal_org = ?`, id);
    this.#sql.exec(`DELETE FROM sso_domains WHERE org_id = ?`, id);
    this.#sql.exec(`DELETE FROM orgs WHERE id = ?`, id);

    return { ok: true };
  }

  /**
   * Deletes the index rows of a person in every org (their account was deleted), and on Commissary Cloud their record and
   * their name on the orgs they created; answers how many orgs listed them.
   */
  removePerson(email: string): number {
    const normalized = normalizeEmail(email);

    const listed = this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM org_members WHERE email = ?`, normalized)
      .one().n;

    this.#sql.exec(`DELETE FROM org_members WHERE email = ?`, normalized);
    this.#sql.exec(`DELETE FROM people WHERE email = ?`, normalized);
    this.#sql.exec(`UPDATE orgs SET created_by = NULL WHERE created_by = ?`, normalized);

    return listed;
  }

  /** The orgs `email` belongs to, in listing order. */
  orgsOfEmail(email: string): ReadonlyArray<OrgRecord> {
    return this.#sql
      .exec<OrgRow>(
        `SELECT ${orgColumnsOf("o")} FROM orgs o
         JOIN org_members m ON m.org_id = o.id WHERE m.email = ? ORDER BY o.id <> '${GLOBAL_ORG}', o.created_at, o.id`,
        normalizeEmail(email),
      )
      .toArray()
      .map((row) => this.#record(row));
  }

  /** The org an Access service token (by Client ID) belongs to. */
  orgOfServiceToken(clientId: string): OrgRecord | undefined {
    const row = this.#sql
      .exec<OrgRow>(
        `SELECT ${orgColumnsOf("o")} FROM orgs o
         JOIN org_service_tokens t ON t.org_id = o.id WHERE t.client_id = ?`,
        clientId.trim(),
      )
      .toArray()[0];

    return row === undefined ? undefined : this.#record(row);
  }

  /**
   * Rebuilds the index rows of `org` from its ControlPlane's own lists: whatever the registry held for the org is
   * replaced. A service token another org already holds stays with that org and is reported, since a token belongs to
   * one org.
   */
  replaceOrgIndex(org: string, index: OrgIndex): IndexRepair {
    if (this.orgById(org) === undefined) return { ok: false, error: "not_found" };

    const emails = [...new Set(index.emails.map(normalizeEmail).filter((email) => email !== ""))];

    const tokens = [
      ...new Set(index.serviceTokens.map((token) => token.trim()).filter((token) => token !== "")),
    ];

    const conflicts: Array<string> = [];

    this.#sql.exec(`DELETE FROM org_members WHERE org_id = ?`, org);
    this.#sql.exec(`DELETE FROM org_service_tokens WHERE org_id = ?`, org);

    for (const email of emails)
      this.#sql.exec(`INSERT INTO org_members (email, org_id) VALUES (?, ?)`, email, org);

    for (const token of tokens) {
      const added = this.#sql.exec(
        `INSERT OR IGNORE INTO org_service_tokens (client_id, org_id) VALUES (?, ?)`,
        token,
        org,
      );

      if (added.rowsWritten === 0) conflicts.push(token);
    }

    return {
      ok: true,
      members: emails.length,
      serviceTokens: tokens.length - conflicts.length,
      conflicts,
    };
  }

  // --- people of Commissary Cloud (ADR 0026) ----------------------------------------------------------------------

  #person(email: string): PersonRow | undefined {
    return this.#sql
      .exec<PersonRow>(
        `SELECT email, signed_up_at, personal_org, org_limit, suspended_at FROM people WHERE email = ?`,
        email,
      )
      .toArray()[0];
  }

  #ownedOrgs(email: string): number {
    return (
      this.#sql
        .exec<{ n: number }>(`SELECT count(*) AS n FROM orgs WHERE created_by = ?`, email)
        .toArray()[0]?.n ?? 0
    );
  }

  #orgLimit(email: string, defaultLimit: number): number {
    return this.#person(email)?.org_limit ?? defaultLimit;
  }

  /**
   * A person signed in (a verified email): suspended, signed up already, or due a Personal org. A person the index
   * lists in any org was invited, and is signed up without one. The Personal org is created here, once (a second call
   * before {@link finishSignUp} answers the same org), with a slug of its own.
   */
  signIn(email: string, now: number): SignInState {
    const address = normalizeEmail(email);
    const person = this.#person(address);

    if (person?.suspended_at != null) return { kind: "suspended" };

    if (person?.signed_up_at != null) return { kind: "ready" };
    const pending = person?.personal_org == null ? undefined : this.orgById(person.personal_org);

    if (pending !== undefined) return { kind: "personal", org: pending };

    if (this.orgsOfEmail(address).length > 0) {
      this.finishSignUp(address, now);

      return { kind: "ready" };
    }

    let slug = "";

    do slug = `personal-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    while (this.orgBySlug(slug) !== undefined);
    const id = newOrgId();

    this.#sql.exec(
      `INSERT INTO orgs (id, slug, name, created_at, usage_retention_days, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      slug,
      PERSONAL_ORG_NAME,
      now,
      DEFAULT_USAGE_RETENTION_DAYS,
      address,
    );
    this.#sql.exec(
      `INSERT INTO people (email, personal_org) VALUES (?, ?)
       ON CONFLICT (email) DO UPDATE SET personal_org = excluded.personal_org`,
      address,
      id,
    );

    const org = this.orgById(id);

    if (org === undefined) throw new Error("the Personal org just created is missing");

    return { kind: "personal", org };
  }

  /** The person is signed up: their Personal org (if any) has them as its owner. */
  finishSignUp(email: string, now: number): void {
    this.#sql.exec(
      `INSERT INTO people (email, signed_up_at) VALUES (?, ?)
       ON CONFLICT (email) DO UPDATE SET signed_up_at = coalesce(people.signed_up_at, excluded.signed_up_at)`,
      normalizeEmail(email),
      now,
    );
  }

  /** A person as platform admins see them; one who never signed in has no sign-up time. */
  person(email: string, defaultLimit: number): PersonRecord {
    const address = normalizeEmail(email);
    const row = this.#person(address);

    return {
      email: address,
      ...(row?.signed_up_at == null ? {} : { signedUpAt: row.signed_up_at }),
      orgLimit: row?.org_limit ?? defaultLimit,
      orgLimitSet: row?.org_limit != null,
      ownedOrgs: this.#ownedOrgs(address),
      ...(row?.suspended_at == null ? {} : { suspendedAt: row.suspended_at }),
    };
  }

  /** Changes a person's org limit and/or suspension; a person who never signed in can be prepared too. */
  updatePerson(email: string, patch: PersonPatch, now: number, defaultLimit: number): PersonRecord {
    const address = normalizeEmail(email);

    this.#sql.exec(`INSERT OR IGNORE INTO people (email) VALUES (?)`, address);

    if (patch.orgLimit !== undefined)
      this.#sql.exec(`UPDATE people SET org_limit = ? WHERE email = ?`, patch.orgLimit, address);

    if (patch.suspended !== undefined)
      this.#sql.exec(
        `UPDATE people SET suspended_at = CASE WHEN ? THEN coalesce(suspended_at, ?) ELSE NULL END
         WHERE email = ?`,
        patch.suspended ? 1 : 0,
        now,
        address,
      );

    return this.person(address, defaultLimit);
  }

  /** Suspends or unsuspends the org addressed by `slug`; nothing of it is deleted. */
  setOrgSuspended(slug: string, suspended: boolean, now: number): OrgWriteResult {
    const current = this.orgBySlug(slug);

    if (current === undefined)
      return { ok: false, error: "not_found", message: `no org has the slug “${slug}”` };

    this.#sql.exec(
      `UPDATE orgs SET suspended_at = CASE WHEN ? THEN coalesce(suspended_at, ?) ELSE NULL END
       WHERE id = ?`,
      suspended ? 1 : 0,
      now,
      current.id,
    );

    const org = this.orgById(current.id);

    if (org === undefined) throw new Error("the org just suspended is missing");

    return { ok: true, org };
  }

  /** Where `org` and the person with `email` stand (a key's org and member, a session's person and org). */
  standing(org: string, email: string | undefined): Standing {
    const found = this.orgById(org);
    const person = email === undefined ? undefined : this.#person(normalizeEmail(email));

    return {
      org:
        found === undefined ? "missing" : found.suspendedAt === undefined ? "active" : "suspended",
      person: person?.suspended_at == null ? "active" : "suspended",
    };
  }

  /**
   * Gives the verified email domain `domain` (lowercased by the caller) to `org`: refused (`domain_taken`) while another
   * org holds it. Claiming a domain the org holds already changes nothing.
   */
  claimSsoDomain(domain: string, org: string): SsoDomainClaim {
    if (this.orgById(org) === undefined)
      return { ok: false, error: "not_found", message: "no org has this id" };
    const holder = this.ssoDomain(domain);

    if (holder !== undefined && holder.org !== org)
      return {
        ok: false,
        error: "domain_taken",
        message: `another org has verified the domain ${domain}`,
      };

    if (holder === undefined)
      this.#sql.exec(`INSERT INTO sso_domains (domain, org_id) VALUES (?, ?)`, domain, org);

    return { ok: true };
  }

  /** Frees `domain` when `org` holds it (the org removed it); anyone else's domain is left alone. */
  releaseSsoDomain(domain: string, org: string): void {
    this.#sql.exec(`DELETE FROM sso_domains WHERE domain = ? AND org_id = ?`, domain, org);
  }

  /** Whether `org` requires single sign-on for `domain`; `false` when the org does not hold the domain. */
  setSsoDomainRequired(domain: string, org: string, required: boolean): boolean {
    return (
      this.#sql.exec(
        `UPDATE sso_domains SET require_sso = ? WHERE domain = ? AND org_id = ?`,
        required ? 1 : 0,
        domain,
        org,
      ).rowsWritten > 0
    );
  }

  /** The domains `org` verified, sorted. */
  ssoDomainsOf(org: string): ReadonlyArray<string> {
    return this.#sql
      .exec<{ domain: string }>(
        `SELECT domain FROM sso_domains WHERE org_id = ? ORDER BY domain`,
        org,
      )
      .toArray()
      .map((row) => row.domain);
  }

  /** The org that verified `domain`, if any. */
  ssoDomain(domain: string): SsoDomainRecord | undefined {
    const row = this.#sql
      .exec<{ org_id: string; require_sso: number }>(
        `SELECT org_id, require_sso FROM sso_domains WHERE domain = ?`,
        domain,
      )
      .toArray()[0];

    // SAFETY: only ids of orgs the registry lists are inserted (`claimSsoDomain` checks it).
    return row === undefined
      ? undefined
      : { org: row.org_id as OrgId, requireSso: row.require_sso === 1 };
  }

  /** The emails the index lists in `org` (whom a suspension signs out). */
  emailsOfOrg(org: string): ReadonlyArray<string> {
    return this.#sql
      .exec<{ email: string }>(`SELECT email FROM org_members WHERE org_id = ? ORDER BY email`, org)
      .toArray()
      .map((row) => row.email);
  }
}

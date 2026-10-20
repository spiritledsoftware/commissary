/**
 * Browser profiles' storage in the org's ControlPlane SQLite (#215, ADR 0039, GLOSSARY "Browser profile"): the
 * `browser_profiles` table (one row per profile: its name, its owner, and the storage state a session last saved into
 * it, sealed with the org's data key for the row, `browser_profiles/<id>`: a value copied to another row or org does not
 * open) and `browser_profile_grants` (who may use which shared profile). Both are the Tools part's tables
 * ({@link PROFILE_TABLES}), dropped by its `wipe()`; they are not keyed by a toolkit, as a profile outlives any toolkit.
 * The store only reads and writes rows; the part decides who may do what.
 *
 * A profile's owner is a member id for a private profile and empty for a shared one. Its state is `NULL` until a
 * session saves into it, and a save replaces it whole (the later save wins). A rename moves its revision; a save does
 * not (`saved_at`).
 */
import type { BrowserProfileGrantBody } from "@commissary/contract/browser-profiles";
import type { GrantSubject } from "@commissary/contract/grants";
import type { Sealer } from "@commissary/state";
import { Option, Schema } from "effect";
import type { GrantChange } from "../grants/grant.ts";
import { subjectColumns, subjectOfColumns } from "../grants/subject.ts";
import { freshId } from "../ids.ts";
import { StorageState } from "./provider.ts";

/** The browser profiles' tables, in the order `wipe()` drops them. */
export const PROFILE_TABLES = ["browser_profile_grants", "browser_profiles"] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS browser_profiles (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, state TEXT, revision INTEGER NOT NULL,
     created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
     saved_at INTEGER, saved_by TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS browser_profile_grants (
     id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, profile_id TEXT NOT NULL,
     revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
     UNIQUE (subject_kind, subject_id, profile_id)
   )`,
];

/** A browser profile as stored, without its state: a private profile has an `owner` (its member's id). */
export interface StoredProfile {
  readonly id: string;
  readonly name: string;
  readonly owner: string | undefined;
  readonly revision: number;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
  /** When a session last saved into it; undefined while it is empty. */
  readonly savedAt: number | undefined;
}

/** A stored profile grant: `subject` may use the shared profile `profile`. */
export interface StoredProfileGrant {
  readonly id: string;
  readonly subject: GrantSubject;
  readonly profile: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

interface ProfileRow {
  [column: string]: SqlStorageValue;
  id: string;
  name: string;
  owner: string;
  revision: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  saved_at: number | null;
}

interface GrantRow {
  [column: string]: SqlStorageValue;
  id: string;
  subject_kind: string;
  subject_id: string;
  profile_id: string;
  revision: number;
  updated_at: number;
  updated_by: string;
}

/** The columns of a profile but its state, which only {@link ProfileStore.state} reads. */
const PROFILE_COLUMNS =
  "id, name, owner, revision, created_at, created_by, updated_at, updated_by, saved_at";

const profileOf = (row: ProfileRow): StoredProfile => ({
  id: row.id,
  name: row.name,
  owner: row.owner === "" ? undefined : row.owner,
  revision: row.revision,
  createdAt: row.created_at,
  createdBy: row.created_by,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  savedAt: row.saved_at ?? undefined,
});

/** A row's grant; none for a subject kind this version does not know (it gives nothing, never everyone). */
const grantOf = (row: GrantRow): StoredProfileGrant | undefined => {
  const subject = subjectOfColumns(row.subject_kind, row.subject_id);

  return subject === undefined
    ? undefined
    : {
        id: row.id,
        subject,
        profile: row.profile_id,
        revision: row.revision,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
};

/** Where a profile's state is sealed: it opens only in its own row. */
const stateContext = (id: string): string => `browser_profiles/${id}`;

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(StorageState));

/** A new profile's id. */
export const freshProfileId = (): string => freshId("bp");

/** A profile grant write: `value` `null` deletes it; no `id` creates one (`revision` 0). */
export type ProfileGrantChange = GrantChange<BrowserProfileGrantBody>;

/** What a profile grant write answers: its id and new revision (0 once deleted), or why it was refused. */
export type ProfileGrantWritten =
  | { readonly ok: true; readonly id: string; readonly revision: number }
  | {
      readonly ok: false;
      readonly error: "invalid" | "not_found" | "conflict";
      readonly message: string;
    };

const refused = (
  error: "invalid" | "not_found" | "conflict",
  message: string,
): ProfileGrantWritten => ({ ok: false, error, message });

export class ProfileStore {
  readonly #sql: SqlStorage;
  readonly #secrets: Sealer;

  constructor(sql: SqlStorage, secrets: Sealer) {
    this.#sql = sql;
    this.#secrets = secrets;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  // --- profiles ----------------------------------------------------------------------------------------------------

  profiles(): ReadonlyArray<StoredProfile> {
    return this.#sql
      .exec<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM browser_profiles ORDER BY name, id`)
      .toArray()
      .map(profileOf);
  }

  profile(id: string): StoredProfile | undefined {
    const row = this.#sql
      .exec<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM browser_profiles WHERE id = ?`, id)
      .toArray()[0];

    return row === undefined ? undefined : profileOf(row);
  }

  /** Inserts a new, empty profile. */
  insert(profile: Omit<StoredProfile, "savedAt">): void {
    this.#sql.exec(
      `INSERT INTO browser_profiles
         (id, name, owner, state, revision, created_at, created_by, updated_at, updated_by, saved_at, saved_by)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL)`,
      profile.id,
      profile.name,
      profile.owner ?? "",
      profile.revision,
      profile.createdAt,
      profile.createdBy,
      profile.updatedAt,
      profile.updatedBy,
    );
  }

  /** Renames a profile at its next revision. */
  rename(id: string, name: string, revision: number, at: number, by: string): void {
    this.#sql.exec(
      `UPDATE browser_profiles SET name = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      name,
      revision,
      at,
      by,
      id,
    );
  }

  /**
   * The state a session last saved into the profile `id`; undefined while it is empty (or for a state this version
   * cannot read, which starts a session empty rather than half loaded). A sealed value that does not open throws.
   */
  state(id: string): StorageState | undefined {
    const row = this.#sql
      .exec<{ state: string | null }>(`SELECT state FROM browser_profiles WHERE id = ?`, id)
      .toArray()[0];

    if (row?.state === undefined || row.state === null) return undefined;

    return Option.getOrUndefined(decodeState(this.#secrets.open(row.state, stateContext(id))));
  }

  /** Replaces the profile's state with `state`, sealed for its row; false when the profile is gone. */
  saveState(id: string, state: StorageState, at: number, by: string | undefined): boolean {
    const sealed = this.#secrets.seal(JSON.stringify(state), stateContext(id));

    return (
      this.#sql.exec(
        `UPDATE browser_profiles SET state = ?, saved_at = ?, saved_by = ? WHERE id = ?`,
        sealed,
        at,
        by ?? null,
        id,
      ).rowsWritten > 0
    );
  }

  /** Deletes a profile with its grants. */
  delete(id: string): void {
    this.#sql.exec(`DELETE FROM browser_profile_grants WHERE profile_id = ?`, id);
    this.#sql.exec(`DELETE FROM browser_profiles WHERE id = ?`, id);
  }

  /** Deletes the private profiles of `member` (who left the org). */
  deleteOwner(member: string): void {
    this.#sql.exec(`DELETE FROM browser_profiles WHERE owner = ?`, member);
  }

  // --- grants ------------------------------------------------------------------------------------------------------

  grants(): ReadonlyArray<StoredProfileGrant> {
    return this.#sql
      .exec<GrantRow>(
        `SELECT * FROM browser_profile_grants ORDER BY profile_id, subject_kind, subject_id`,
      )
      .toArray()
      .flatMap((row) => grantOf(row) ?? []);
  }

  /**
   * Creates, replaces or deletes (`value: null`) one grant, its value already trimmed and checked, at the revision it
   * names (0 to create; ADR 0025). One per subject and profile: a second is a `conflict` (edit that one).
   */
  writeGrant(change: ProfileGrantChange, by: string, now: number): ProfileGrantWritten {
    const existing = change.id === undefined ? undefined : this.#grant(change.id);

    if (change.id !== undefined && existing === undefined)
      return refused("not_found", "grant not found");

    if (existing === undefined && change.revision !== 0)
      return refused("conflict", "a new grant is at revision 0");

    if (existing !== undefined && existing.revision !== change.revision)
      return refused("conflict", "the grant changed since it was read: read it again");

    const { value } = change;

    if (value === null) {
      if (existing === undefined) return refused("invalid", "there is no grant to delete");
      this.#sql.exec(`DELETE FROM browser_profile_grants WHERE id = ?`, existing.id);

      return { ok: true, id: existing.id, revision: 0 };
    }

    const taken = this.#grantOfSubject(value.subject, value.profile);

    if (taken !== undefined && taken.id !== existing?.id)
      return refused(
        "conflict",
        "the subject holds a grant of this browser profile already: edit that one",
      );

    const id = existing?.id ?? freshId("bpg");
    const revision = (existing?.revision ?? 0) + 1;
    const [kind, subjectId] = subjectColumns(value.subject);

    this.#sql.exec(
      `INSERT OR REPLACE INTO browser_profile_grants
         (id, subject_kind, subject_id, profile_id, revision, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      kind,
      subjectId,
      value.profile,
      revision,
      now,
      by,
    );

    return { ok: true, id, revision };
  }

  #grant(id: string): StoredProfileGrant | undefined {
    const row = this.#sql
      .exec<GrantRow>(`SELECT * FROM browser_profile_grants WHERE id = ?`, id)
      .toArray()[0];

    return row === undefined ? undefined : grantOf(row);
  }

  /** The grant `subject` holds of `profile`, if any. */
  #grantOfSubject(subject: GrantSubject, profile: string): StoredProfileGrant | undefined {
    const [kind, subjectId] = subjectColumns(subject);

    const row = this.#sql
      .exec<GrantRow>(
        `SELECT * FROM browser_profile_grants WHERE subject_kind = ? AND subject_id = ? AND profile_id = ?`,
        kind,
        subjectId,
        profile,
      )
      .toArray()[0];

    return row === undefined ? undefined : grantOf(row);
  }

  /** Deletes the grants that name `subject` (a member who left, a deleted team). */
  forgetSubject(subject: GrantSubject): void {
    const [kind, subjectId] = subjectColumns(subject);

    this.#sql.exec(
      `DELETE FROM browser_profile_grants WHERE subject_kind = ? AND subject_id = ?`,
      kind,
      subjectId,
    );
  }
}

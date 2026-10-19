/**
 * Tool grant storage in the org's ControlPlane SQLite (ADR 0038): the `tool_grants` table, one of the Tools part's
 * tables (`TOOLS_TABLES`), keyed by `toolkit_id` like the others, so a removed toolkit takes its grants with it.
 *
 * One grant per subject and toolkit; each is a config entry in the sense of ADR 0025: a write names the revision it is
 * based on (0 to create), and a stale one is a `conflict`. Nothing is seeded: there is no default tool grant.
 */
import type { GrantSubject, ToolSelection } from "@commissary/contract/grants";
import type { ToolGrantChange, ToolGrantEntry, ToolGrantValue } from "./grant.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS tool_grants (
   id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, toolkit_id TEXT NOT NULL,
   tools_kind TEXT NOT NULL, tool_ids TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
   updated_by TEXT NOT NULL
 )`;

interface GrantRow {
  [column: string]: SqlStorageValue;
  id: string;
  subject_kind: string;
  subject_id: string;
  toolkit_id: string;
  tools_kind: string;
  tool_ids: string;
  revision: number;
  updated_at: number;
  updated_by: string;
}

/** Why a write was refused; the part answers each with its status. */
export interface ToolGrantRefused {
  readonly ok: false;
  readonly error: "invalid" | "not_found" | "conflict";
  readonly message: string;
}

export type ToolGrantWritten =
  | { readonly ok: true; readonly id: string; readonly revision: number }
  | ToolGrantRefused;

const refuse = (error: ToolGrantRefused["error"], message: string): ToolGrantRefused => ({
  ok: false,
  error,
  message,
});

/** Thrown inside a write's transaction to roll it back. */
class Refusal extends Error {
  readonly refused: ToolGrantRefused;

  constructor(refused: ToolGrantRefused) {
    super(refused.message);
    this.refused = refused;
  }
}

const subjectOf = (row: GrantRow): GrantSubject =>
  row.subject_kind === "member" || row.subject_kind === "team"
    ? { kind: row.subject_kind, id: row.subject_id }
    : { kind: "everyone" };

const toolsOf = (row: GrantRow): ToolSelection => {
  switch (row.tools_kind) {
    case "read":
      return { kind: "read" };
    case "named":
      // SAFETY: `tool_ids` holds the JSON array of strings this store wrote.
      return { kind: "named", ids: JSON.parse(row.tool_ids) as ReadonlyArray<string> };
    default:
      return { kind: "all" };
  }
};

const entryOf = (row: GrantRow): ToolGrantEntry => ({
  id: row.id,
  subject: subjectOf(row),
  toolkit: row.toolkit_id,
  tools: toolsOf(row),
  revision: row.revision,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

const subjectColumns = (subject: GrantSubject): readonly [string, string] =>
  subject.kind === "everyone" ? ["everyone", ""] : [subject.kind, subject.id];

/** `value` with its names trimmed and its named tools de-duplicated, or why it is refused. */
export const cleanToolGrant = (value: ToolGrantValue): ToolGrantValue | ToolGrantRefused => {
  const subject: GrantSubject =
    value.subject.kind === "everyone"
      ? value.subject
      : { kind: value.subject.kind, id: value.subject.id.trim() };

  if (subject.kind !== "everyone" && subject.id === "")
    return refuse("invalid", `a grant for a ${subject.kind} names the ${subject.kind}`);

  const toolkit = value.toolkit.trim();

  if (toolkit === "") return refuse("invalid", "a tool grant names its toolkit");

  if (value.tools.kind !== "named") return { subject, toolkit, tools: value.tools };

  const ids = [...new Set(value.tools.ids.map((id) => id.trim()))];

  if (ids.length === 0 || ids.includes(""))
    return refuse("invalid", "a grant of named tools names at least one tool by its stable id");

  const foreign = ids.find(
    (id) => !id.startsWith(`${toolkit}:`) || id.length === toolkit.length + 1,
  );

  if (foreign !== undefined)
    return refuse(
      "invalid",
      `${foreign} is not the stable id of a tool of the toolkit (<toolkit id>:<upstream name>)`,
    );

  return { subject, toolkit, tools: { kind: "named", ids } };
};

const freshGrantId = (): string => `tg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

export class ToolGrantStore {
  readonly #sql: SqlStorage;
  readonly #transaction: <T>(body: () => T) => T;

  constructor(sql: SqlStorage, transaction: <T>(body: () => T) => T) {
    this.#sql = sql;
    this.#transaction = transaction;
    sql.exec(SCHEMA);
  }

  /** Every tool grant, by subject and toolkit. */
  entries(): ReadonlyArray<ToolGrantEntry> {
    return this.#sql
      .exec<GrantRow>(`SELECT * FROM tool_grants ORDER BY subject_kind, subject_id, toolkit_id, id`)
      .toArray()
      .map(entryOf);
  }

  /** The grant `subject` holds on `toolkit`, if any. */
  held(subject: GrantSubject, toolkit: string): ToolGrantEntry | undefined {
    const [kind, id] = subjectColumns(subject);

    const row = this.#sql
      .exec<GrantRow>(
        `SELECT * FROM tool_grants WHERE subject_kind = ? AND subject_id = ? AND toolkit_id = ?`,
        kind,
        id,
        toolkit,
      )
      .toArray()[0];

    return row === undefined ? undefined : entryOf(row);
  }

  /**
   * Creates, replaces or deletes (`value: null`) one grant, its value already cleaned ({@link cleanToolGrant}) and
   * checked. It names the revision it is based on (0 to create); a second grant of a subject on a toolkit is a
   * `conflict` (edit that one).
   */
  write(change: ToolGrantChange, by: string, now: number): ToolGrantWritten {
    try {
      return this.#transaction(() => {
        const existing =
          change.id === undefined
            ? undefined
            : this.#sql
                .exec<GrantRow>(`SELECT * FROM tool_grants WHERE id = ?`, change.id)
                .toArray()[0];

        if (change.id !== undefined && existing === undefined)
          throw new Refusal(
            change.revision === 0
              ? refuse("not_found", "tool grant not found")
              : refuse("conflict", "the tool grant was deleted"),
          );

        if (existing === undefined && change.revision !== 0)
          throw new Refusal(refuse("conflict", "a new tool grant is written at revision 0"));

        if (existing !== undefined && existing.revision !== change.revision)
          throw new Refusal(
            refuse(
              "conflict",
              `the tool grant is at revision ${existing.revision}, not ${change.revision}`,
            ),
          );

        if (change.value === null) {
          if (existing === undefined)
            throw new Refusal(refuse("invalid", "there is no tool grant to delete"));
          this.#sql.exec(`DELETE FROM tool_grants WHERE id = ?`, existing.id);

          return { ok: true as const, id: existing.id, revision: 0 };
        }

        const value = change.value;
        const taken = this.held(value.subject, value.toolkit);

        if (taken !== undefined && taken.id !== existing?.id)
          throw new Refusal(
            refuse("conflict", `the subject has a grant on that toolkit: ${taken.id}`),
          );

        const id = existing?.id ?? freshGrantId();
        const revision = (existing?.revision ?? 0) + 1;

        this.#put(id, value, revision, by, now);

        return { ok: true as const, id, revision };
      });
    } catch (error) {
      if (error instanceof Refusal) return error.refused;
      throw error;
    }
  }

  /** A member left or a team was deleted: the grants that named it go with it (its id is never reused). */
  forget(subject: { readonly kind: "member" | "team"; readonly id: string }): void {
    this.#sql.exec(
      `DELETE FROM tool_grants WHERE subject_kind = ? AND subject_id = ?`,
      subject.kind,
      subject.id,
    );
  }

  #put(id: string, value: ToolGrantValue, revision: number, by: string, now: number): void {
    const [subjectKind, subjectId] = subjectColumns(value.subject);

    this.#sql.exec(
      `INSERT OR REPLACE INTO tool_grants
         (id, subject_kind, subject_id, toolkit_id, tools_kind, tool_ids, revision, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      subjectKind,
      subjectId,
      value.toolkit,
      value.tools.kind,
      JSON.stringify(value.tools.kind === "named" ? value.tools.ids : []),
      revision,
      now,
      by,
    );
  }
}

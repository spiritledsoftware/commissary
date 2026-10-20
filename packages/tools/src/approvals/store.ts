/**
 * Pending approvals in the org's ControlPlane SQLite (#201, ADR 0038, GLOSSARY "Pending approval"): the
 * `tool_approvals` table, one of the Tools part's tables (`TOOLS_TABLES`), keyed by `toolkit_id` like the others, so a
 * removed toolkit takes its approvals with it.
 *
 * A row is one call that waits: its caller (member, or the principal of a caller without one), the tool's stable id and
 * its full name then, the credential, the approver the rule named then, the hash of its canonical arguments
 * (`hash.ts`) and the arguments themselves, sealed with the org's data key for the row (`tool_approvals/<id>`): the one
 * place Commissary keeps a tool call's content. The arguments are deleted when the approval is decided. The row goes
 * when it expires, {@link APPROVAL_LIFETIME_MS} after the call: every read ignores it from then on, and the part's alarm
 * deletes it.
 *
 * A **form** row (`form = 1`) is the approve-or-deny form a caller who is their call's approver was sent instead
 * (#201): it keeps no arguments, only what binds the answer to the call, and its `requestState` ({@link formState}),
 * sealed for the row, is the only way to answer it. Lists and approval pages never show one, and no repeated call
 * matches it.
 *
 * `settled` marks a row whose outcome a call took: the call it approved went through (once), it learned the denial, or
 * its form was answered. A settled row matches no further call.
 */
import type { Approver } from "@commissary/contract/approvals";
import type { CredentialSlot } from "@commissary/contract/tools";
import type { Sealer } from "@commissary/state";
import { Schema } from "effect";
import { freshId } from "../ids.ts";

/** How long a pending approval waits, and an approved one lets its call through: one hour from the call (ADR 0038). */
export const APPROVAL_LIFETIME_MS = 60 * 60 * 1000;

export const APPROVALS_SCHEMA = `CREATE TABLE IF NOT EXISTS tool_approvals (
   id TEXT PRIMARY KEY, toolkit_id TEXT NOT NULL, upstream_name TEXT NOT NULL, tool_name TEXT NOT NULL,
   caller_member TEXT NOT NULL, caller_principal TEXT NOT NULL, credential TEXT NOT NULL, approver TEXT NOT NULL,
   args_hash TEXT NOT NULL, arguments TEXT, status TEXT NOT NULL, settled INTEGER NOT NULL,
   created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT,
   form INTEGER NOT NULL DEFAULT 0
 )`;

/** What a decision left: `pending` until one is made. */
export type StoredApprovalStatus = "pending" | "approved" | "denied";

export interface StoredApproval {
  readonly id: string;
  readonly toolkitId: string;
  readonly upstreamName: string;
  /** The tool's full name when it was called. */
  readonly toolName: string;
  /** The caller's member id; undefined for a caller without one (a service token). */
  readonly callerMember: string | undefined;
  readonly callerPrincipal: string;
  readonly credential: CredentialSlot;
  readonly approver: Approver;
  readonly argsHash: string;
  readonly status: StoredApprovalStatus;
  readonly settled: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | undefined;
  readonly decidedBy: string | undefined;
}

/** A call as a pending approval or a form is matched with it: the same caller, tool and arguments' hash. */
export interface ApprovalKey {
  readonly toolkitId: string;
  readonly upstreamName: string;
  readonly argsHash: string;
  readonly callerMember: string | undefined;
  readonly callerPrincipal: string;
}

/** A new pending approval (or form) as the part hands it over. */
export interface NewApproval extends ApprovalKey {
  readonly toolName: string;
  readonly credential: CredentialSlot;
  readonly approver: Approver;
}

interface ApprovalRow {
  [column: string]: SqlStorageValue;
  id: string;
  toolkit_id: string;
  upstream_name: string;
  tool_name: string;
  caller_member: string;
  caller_principal: string;
  credential: string;
  approver: string;
  args_hash: string;
  arguments: string | null;
  status: string;
  settled: number;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
  form: number;
}

const approvalOf = (row: ApprovalRow): StoredApproval => ({
  id: row.id,
  toolkitId: row.toolkit_id,
  upstreamName: row.upstream_name,
  toolName: row.tool_name,
  callerMember: row.caller_member === "" ? undefined : row.caller_member,
  callerPrincipal: row.caller_principal,
  // SAFETY: the store writes `credential` from a `CredentialSlot`.
  credential: row.credential as CredentialSlot,
  // SAFETY: `approver` holds the JSON of the cleaned `Approver` this store wrote.
  approver: JSON.parse(row.approver) as Approver,
  argsHash: row.args_hash,
  // SAFETY: the store writes `status` from a `StoredApprovalStatus`.
  status: row.status as StoredApprovalStatus,
  settled: row.settled === 1,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  decidedAt: row.decided_at ?? undefined,
  decidedBy: row.decided_by ?? undefined,
});

/** Where a row's arguments are sealed: a value opens only where it was written. */
const argumentsContext = (id: string): string => `tool_approvals/${id}`;

/** Where a form's `requestState` is sealed. */
const formContext = (id: string): string => `tool_approvals/${id}/form`;

const freshApprovalId = (): string => freshId("ap");

/** What a form's `requestState` seals: the form's row, the tool's stable id and the arguments' hash. */
const FormBinding = Schema.Struct({
  id: Schema.String,
  toolId: Schema.String,
  hash: Schema.String,
});

type FormBinding = typeof FormBinding.Type;

const isFormBinding = Schema.is(FormBinding);

/** The stable id a form binds: `<toolkit id>:<upstream name>`. */
const toolIdOf = (key: Pick<ApprovalKey, "toolkitId" | "upstreamName">): string =>
  `${key.toolkitId}:${key.upstreamName}`;

/** The rows a read sees at `now` (its parameter): those not expired. */
const LIVE = `expires_at > ?`;

export class ApprovalStore {
  readonly #sql: SqlStorage;
  readonly #secrets: Sealer;

  constructor(sql: SqlStorage, secrets: Sealer) {
    this.#sql = sql;
    this.#secrets = secrets;
    sql.exec(APPROVALS_SCHEMA);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS tool_approvals_call ON tool_approvals
         (toolkit_id, upstream_name, args_hash, caller_member)`,
    );
  }

  /** Stores a pending approval of a call at `now`, its arguments sealed; answers it. */
  create(approval: NewApproval, args: Schema.JsonObject, now: number): StoredApproval {
    const id = this.#insert(approval, now, false, (row) =>
      this.#secrets.seal(JSON.stringify(args), argumentsContext(row)),
    );

    const created = this.approval(id, now);

    if (created === undefined) throw new Error("the approval just written is missing");

    return created;
  }

  /**
   * Stores the form a caller is asked to approve their call on at `now`, and answers its `requestState`: the row's id
   * and, sealed for the row, what it binds (the tool and the arguments' hash). Nothing else can answer the form.
   */
  createForm(approval: NewApproval, now: number): string {
    const id = this.#insert(approval, now, true, () => null);

    const binding: FormBinding = {
      id,
      toolId: toolIdOf(approval),
      hash: approval.argsHash,
    };

    return `${id}:${this.#secrets.seal(JSON.stringify(binding), formContext(id))}`;
  }

  #insert(
    approval: NewApproval,
    now: number,
    form: boolean,
    sealed: (id: string) => string | null,
  ): string {
    const id = freshApprovalId();

    this.#sql.exec(
      `INSERT INTO tool_approvals
         (id, toolkit_id, upstream_name, tool_name, caller_member, caller_principal, credential, approver, args_hash,
          arguments, status, settled, created_at, expires_at, decided_at, decided_by, form)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, ?)`,
      id,
      approval.toolkitId,
      approval.upstreamName,
      approval.toolName,
      approval.callerMember ?? "",
      approval.callerPrincipal,
      approval.credential,
      JSON.stringify(approval.approver),
      approval.argsHash,
      sealed(id),
      now,
      now + APPROVAL_LIFETIME_MS,
      form ? 1 : 0,
    );

    return id;
  }

  /**
   * Whether `requestState` answers a form about the call `key` at `now`, and settles that form (a form is answered
   * once): only a state this store issued, for a form still unanswered and not expired, of the same caller, tool and
   * arguments' hash. Anything else is `false`: the caller was not asked about this call.
   */
  takeForm(requestState: string | undefined, key: ApprovalKey, now: number): boolean {
    if (requestState === undefined) return false;
    const colon = requestState.indexOf(":");

    if (colon <= 0) return false;
    const id = requestState.slice(0, colon);
    let binding: Schema.Json;

    try {
      binding = JSON.parse(this.#secrets.open(requestState.slice(colon + 1), formContext(id)));
    } catch {
      return false;
    }

    if (
      !isFormBinding(binding) ||
      binding.id !== id ||
      binding.toolId !== toolIdOf(key) ||
      binding.hash !== key.argsHash
    )
      return false;

    const taken = this.#sql.exec(
      `UPDATE tool_approvals SET settled = 1
       WHERE id = ? AND form = 1 AND settled = 0 AND status = 'pending' AND ${LIVE}
         AND toolkit_id = ? AND upstream_name = ? AND args_hash = ? AND caller_member = ?
         AND (caller_member <> '' OR caller_principal = ?)`,
      id,
      now,
      key.toolkitId,
      key.upstreamName,
      key.argsHash,
      key.callerMember ?? "",
      key.callerPrincipal,
    );

    return taken.rowsWritten === 1;
  }

  /** A pending approval (never a form) while it is kept: until it expires at `now`. */
  approval(id: string, now: number): StoredApproval | undefined {
    const row = this.#sql
      .exec<ApprovalRow>(
        `SELECT * FROM tool_approvals WHERE id = ? AND form = 0 AND ${LIVE}`,
        id,
        now,
      )
      .toArray()[0];

    return row === undefined ? undefined : approvalOf(row);
  }

  /** Every pending approval (never a form) kept at `now`, newest first. */
  approvals(now: number): ReadonlyArray<StoredApproval> {
    return this.#sql
      .exec<ApprovalRow>(
        `SELECT * FROM tool_approvals WHERE form = 0 AND ${LIVE} ORDER BY created_at DESC, id`,
        now,
      )
      .toArray()
      .map(approvalOf);
  }

  /** Every row of the toolkit, forms included, expired or not: what a change of its rules checks. */
  ofToolkit(toolkitId: string): ReadonlyArray<StoredApproval> {
    return this.#sql
      .exec<ApprovalRow>(`SELECT * FROM tool_approvals WHERE toolkit_id = ?`, toolkitId)
      .toArray()
      .map(approvalOf);
  }

  /**
   * The newest pending approval a repeat of a call would take at `now`, not yet settled nor expired: the same caller
   * (member, or the principal of a caller without one), tool and arguments' hash.
   */
  unsettled(key: ApprovalKey, now: number): StoredApproval | undefined {
    const row = this.#sql
      .exec<ApprovalRow>(
        `SELECT * FROM tool_approvals
         WHERE toolkit_id = ? AND upstream_name = ? AND args_hash = ? AND caller_member = ? AND settled = 0
           AND form = 0 AND ${LIVE} AND (caller_member <> '' OR caller_principal = ?)
         ORDER BY created_at DESC, id LIMIT 1`,
        key.toolkitId,
        key.upstreamName,
        key.argsHash,
        key.callerMember ?? "",
        now,
        key.callerPrincipal,
      )
      .toArray()[0];

    return row === undefined ? undefined : approvalOf(row);
  }

  /**
   * The arguments of a pending approval, opened with the org's data key, while it keeps them (until its decision or
   * expiry at `now`).
   */
  arguments(id: string, now: number): Schema.JsonObject | undefined {
    const row = this.#sql
      .exec<{ arguments: string | null }>(
        `SELECT arguments FROM tool_approvals WHERE id = ? AND ${LIVE}`,
        id,
        now,
      )
      .toArray()[0];

    if (row === undefined || row.arguments === null) return undefined;

    // SAFETY: the sealed value is the JSON of the call's arguments, an object, this store wrote for this row.
    return JSON.parse(this.#secrets.open(row.arguments, argumentsContext(id))) as Schema.JsonObject;
  }

  /** Records a decision on a pending approval and deletes its arguments. */
  decide(id: string, decision: "approved" | "denied", by: string, now: number): void {
    this.#sql.exec(
      `UPDATE tool_approvals SET status = ?, decided_at = ?, decided_by = ?, arguments = NULL
       WHERE id = ? AND status = 'pending' AND form = 0`,
      decision,
      now,
      by,
      id,
    );
  }

  /** A repeated call took the approval's outcome: it matches no further call. Its arguments go too. */
  settle(id: string): void {
    this.#sql.exec(`UPDATE tool_approvals SET settled = 1, arguments = NULL WHERE id = ?`, id);
  }

  /** Deletes approvals (and forms), arguments and all. */
  delete(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.#sql.exec(`DELETE FROM tool_approvals WHERE id = ?`, id);
  }

  /** Deletes the approvals and forms expired at `now`; answers when the next one expires (`null`: none is kept). */
  prune(now: number): number | null {
    this.#sql.exec(`DELETE FROM tool_approvals WHERE expires_at <= ?`, now);

    const next = this.#sql
      .exec<{ next: number | null }>(`SELECT MIN(expires_at) AS next FROM tool_approvals`)
      .toArray()[0]?.next;

    return next === null || next === undefined ? null : next;
  }

  /**
   * A member left: the approvals and forms of their calls go, arguments and all, and they leave every approver list
   * they were on (`without`).
   */
  deleteMember(member: string, without: (approver: Approver) => Approver): void {
    this.#sql.exec(`DELETE FROM tool_approvals WHERE caller_member = ?`, member);

    const listed = this.#sql
      .exec<ApprovalRow>(`SELECT * FROM tool_approvals`)
      .toArray()
      .map(approvalOf)
      .filter((approval) => approval.approver.kind === "members");

    for (const approval of listed)
      this.#sql.exec(
        `UPDATE tool_approvals SET approver = ? WHERE id = ?`,
        JSON.stringify(without(approval.approver)),
        approval.id,
      );
  }
}

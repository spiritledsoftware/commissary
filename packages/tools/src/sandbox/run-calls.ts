/**
 * The tickets of agent runs' gated sandbox calls (#230), as the Tools part keeps them: the `sandbox_run_calls` table,
 * one of the part's tables (`TOOLS_TABLES`), keyed by `toolkit_id` like the others.
 *
 * A run's call of pi's `bash`, `read`, `write` or `edit` is gated as the sandbox toolkit's tool of the same name; once
 * every gate passed and its price was charged, the part keeps a ticket for it instead of making the call
 * (`@commissary/contract/sandbox-env`). The ticket is bound to the run's principal, its session and its tool: each of
 * the run's operations of that call names it, and only the operations its tool makes go through (`TICKET_OPS`).
 * Settling it ends its operations and answers what its usage record says, which the API Worker writes under the
 * ticket's id, so it is written once, for that call only, however many times the settling is tried.
 *
 * **Expiry.** A ticket's operations live {@link TICKET_IDLE_MS} past its last sign of life: its gate, and the start and
 * the end of each of them, where a command's start adds the longest the command may run (its timeout, at most the
 * sandbox's ten minutes), so a slow command never outlives its ticket. An operation after that is refused. Its settling
 * is not bound by that: it may be tried for {@link SETTLE_GRACE_MS} after the gate, and answers the same each time, so
 * a settling that failed, or whose record the API Worker could not write, is tried again and recorded once. A run that
 * stopped between gate and settling (its object evicted, its turn cut off) settles its pending tickets as interrupted
 * when it reopens. The part forgets a ticket past that day at its next gate; one never settled by then writes no
 * record, and what the call cost stays charged.
 */
import type { Schema } from "effect";
import type { UsageRun } from "@commissary/auth";
import type { PlanRefusal } from "@commissary/billing/api";
import type { Refusal } from "@commissary/state/spend";
import type { SandboxEnvOp } from "@commissary/contract/sandbox-env";
import type { ToolCallApproval } from "@commissary/contract/usage";

/** How long a ticket's operations live past its last sign of life: its gate, or the start or end of one of them. */
export const TICKET_IDLE_MS = 5 * 60 * 1000;

/** How long after its gate a ticket may be settled, and settled again with the same answer. */
export const SETTLE_GRACE_MS = 24 * 60 * 60 * 1000;

/** The operations each gated tool makes on the session: pi's built-in tool's, and no other. */
const TICKET_OPS = {
  bash: ["exec"],
  read: ["stat", "read"],
  write: ["write"],
  edit: ["stat", "readText", "write"],
} as const satisfies Record<string, ReadonlyArray<SandboxEnvOp>>;

/** The bytes of a call's arguments as JSON (UTF-8), 0 for none, as its usage record counts them. */
export const argumentBytes = (args: Schema.JsonObject | undefined): number =>
  args === undefined ? 0 : new TextEncoder().encode(JSON.stringify(args)).byteLength;

/** Whether calls of the sandbox tool `name` (its upstream name) can be gated for a run to execute. */
export const gatedTool = (name: string): name is keyof typeof TICKET_OPS =>
  Object.hasOwn(TICKET_OPS, name);

/** Whether the gated tool `tool` makes the operation `op`. */
export const ticketAllows = (tool: string, op: SandboxEnvOp): boolean =>
  gatedTool(tool) && TICKET_OPS[tool].some((allowed) => allowed === op);

/** One gated call: who made it, what it may do, and what its usage record will say. */
export interface RunCallTicket {
  readonly id: string;
  readonly toolkitId: string;
  /** The tool's upstream name (`bash`, `read`, `write`, `edit`). */
  readonly tool: string;
  /** The run's principal (`run:<id>`), whose operations alone may name it. */
  readonly principal: string;
  readonly member: string | undefined;
  /**
   * Whose Spend limits the call counts toward besides its member's (`spenderOf`): the API key it was made with, and the
   * shared agent whose run made it (#228), which its operations' computer time is charged to as well.
   */
  readonly apiKey: string | undefined;
  readonly agent: string | undefined;
  readonly run: UsageRun | undefined;
  /** The run's session the call works in. */
  readonly session: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  /** When the call was gated (epoch ms), and the bytes of its arguments as JSON. */
  readonly requestedAt: number;
  readonly requestBytes: number;
  readonly credential: "shared" | "private";
  readonly private: boolean;
  /** The price the gate charged, micro-USD. */
  readonly costMicros: number;
  readonly approval: ToolCallApproval;
  /**
   * The session's computer time's metering (#224), which the part passes to the session with each operation: the
   * price per computer hour, and whether a Spend limit its time counts toward had no room at the gate.
   */
  readonly hourPriceMicros: number;
  readonly limitReached: boolean;
  /**
   * The org's plan keeps the computer from the call's commands (#241), and no Spend limit does: `limitReached` is then
   * the plan's, and a command that would run on the computer is refused in the plan's words.
   */
  readonly planRefusal: PlanRefusal | undefined;
  /** The org's plan counts the computer's time (#241): the session reports time that cost nothing too. */
  readonly plans: boolean;
  /**
   * What the gate counted of the call against the plan (`PlanMeter.admit`'s `monthStart`), until a refused operation
   * takes it back: the call did no work then (#241).
   */
  readonly counted: number | undefined;
  /**
   * The Spend limit that refused one of the call's operations after all (#224): a command that would have run on the
   * computer while the limit had no room. Settling it ends the run's turn with the refusal.
   */
  readonly refusal?: Refusal | undefined;
  /** Whether the refused operation stopped the session's running computer first. */
  readonly computerStopped?: true | undefined;
  /** The plan refused one of the call's operations after all (#241): `planRefusal` is what settling it answers. */
  readonly planRefused?: true | undefined;
  /** When it was first settled (epoch ms), which ended its operations; the record's latency runs to then. */
  readonly settledAt?: number | undefined;
}

interface TicketRow extends Record<string, SqlStorageValue> {
  id: string;
  toolkit_id: string;
  tool: string;
  principal: string;
  member: string;
  api_key: string;
  agent: string;
  run: string;
  session: string;
  expires_at: number;
  requested_at: number;
  request_bytes: number;
  credential: string;
  private: number;
  cost_micros: number;
  approval: string;
  hour_price_micros: number;
  limit_reached: number;
  plan_refusal: string;
  plan_refused: number;
  plans: number;
  counted: number | null;
  refusal: string;
  computer_stopped: number;
  settled_at: number | null;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS sandbox_run_calls (
  id TEXT PRIMARY KEY, toolkit_id TEXT NOT NULL, tool TEXT NOT NULL, principal TEXT NOT NULL, member TEXT NOT NULL,
  api_key TEXT NOT NULL, agent TEXT NOT NULL, run TEXT NOT NULL, session TEXT NOT NULL, expires_at INTEGER NOT NULL,
  requested_at INTEGER NOT NULL, request_bytes INTEGER NOT NULL, credential TEXT NOT NULL, private INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL, approval TEXT NOT NULL, hour_price_micros INTEGER NOT NULL,
  limit_reached INTEGER NOT NULL, refusal TEXT NOT NULL DEFAULT '', computer_stopped INTEGER NOT NULL DEFAULT 0,
  settled_at INTEGER, plan_refusal TEXT NOT NULL DEFAULT '', plan_refused INTEGER NOT NULL DEFAULT 0,
  plans INTEGER NOT NULL DEFAULT 0, counted INTEGER
)`;

/** The columns #241 added to a table from before. */
const PLAN_COLUMNS = {
  plan_refusal: "TEXT NOT NULL DEFAULT ''",
  plan_refused: "INTEGER NOT NULL DEFAULT 0",
  plans: "INTEGER NOT NULL DEFAULT 0",
  counted: "INTEGER",
} as const;

const ticketOf = (row: TicketRow): RunCallTicket => ({
  id: row.id,
  toolkitId: row.toolkit_id,
  tool: row.tool,
  principal: row.principal,
  member: row.member === "" ? undefined : row.member,
  apiKey: row.api_key === "" ? undefined : row.api_key,
  agent: row.agent === "" ? undefined : row.agent,
  // SAFETY: only `issue` writes the column, the JSON of a `UsageRun` or "" for none.
  run: row.run === "" ? undefined : (JSON.parse(row.run) as UsageRun),
  session: row.session,
  expiresAt: row.expires_at,
  requestedAt: row.requested_at,
  requestBytes: row.request_bytes,
  credential: row.credential === "private" ? "private" : "shared",
  private: row.private === 1,
  costMicros: row.cost_micros,
  // SAFETY: only `issue` writes the column, from a `ToolCallApproval`.
  approval: row.approval as ToolCallApproval,
  hourPriceMicros: row.hour_price_micros,
  limitReached: row.limit_reached === 1,
  // SAFETY: only `issue` writes the column, the JSON of a `PlanRefusal` or "" for none.
  planRefusal: row.plan_refusal === "" ? undefined : (JSON.parse(row.plan_refusal) as PlanRefusal),
  plans: row.plans === 1,
  counted: row.counted ?? undefined,
  planRefused: row.plan_refused === 1 ? true : undefined,
  // SAFETY: only `refused` writes the column, the JSON of a `Refusal` or "" for none.
  refusal: row.refusal === "" ? undefined : (JSON.parse(row.refusal) as Refusal),
  computerStopped: row.computer_stopped === 1 ? true : undefined,
  settledAt: row.settled_at ?? undefined,
});

export class RunCallTickets {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(SCHEMA);

    const columns = sql
      .exec<{ name: string }>("PRAGMA table_info(sandbox_run_calls)")
      .toArray()
      .map((column) => column.name);

    for (const [column, type] of Object.entries(PLAN_COLUMNS))
      if (!columns.includes(column))
        sql.exec(`ALTER TABLE sandbox_run_calls ADD COLUMN ${column} ${type}`);
  }

  /** Keeps a new ticket, with a fresh id, and forgets those past their settling's grace; answers its id. */
  issue(
    ticket: Omit<RunCallTicket, "id" | "refusal" | "computerStopped" | "planRefused" | "settledAt">,
    now: number,
  ): string {
    const id = `rtc_${crypto.randomUUID().replaceAll("-", "")}`;

    this.#sql.exec(`DELETE FROM sandbox_run_calls WHERE requested_at < ?`, now - SETTLE_GRACE_MS);

    this.#sql.exec(
      `INSERT INTO sandbox_run_calls (id, toolkit_id, tool, principal, member, api_key, agent, run, session, expires_at,
         requested_at, request_bytes, credential, private, cost_micros, approval, hour_price_micros, limit_reached,
         plan_refusal, plans, counted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ticket.toolkitId,
      ticket.tool,
      ticket.principal,
      ticket.member ?? "",
      ticket.apiKey ?? "",
      ticket.agent ?? "",
      ticket.run === undefined ? "" : JSON.stringify(ticket.run),
      ticket.session,
      ticket.expiresAt,
      ticket.requestedAt,
      ticket.requestBytes,
      ticket.credential,
      ticket.private ? 1 : 0,
      ticket.costMicros,
      ticket.approval,
      ticket.hourPriceMicros,
      ticket.limitReached ? 1 : 0,
      ticket.planRefusal === undefined ? "" : JSON.stringify(ticket.planRefusal),
      ticket.plans ? 1 : 0,
      ticket.counted ?? null,
    );

    return id;
  }

  /**
   * The live ticket `id` of `principal`'s, whose operations may go on, if there is one: an expired or settled one, or
   * another principal's, is none.
   */
  live(id: string, principal: string, now: number): RunCallTicket | undefined {
    const row = this.#sql
      .exec<TicketRow>(
        `SELECT * FROM sandbox_run_calls
         WHERE id = ? AND principal = ? AND expires_at >= ? AND settled_at IS NULL`,
        id,
        principal,
        now,
      )
      .toArray()[0];

    return row === undefined ? undefined : ticketOf(row);
  }

  /** Keeps the ticket alive until `until` at least (a sign of life: an operation's start or end). */
  extend(id: string, until: number): void {
    this.#sql.exec(
      `UPDATE sandbox_run_calls SET expires_at = MAX(expires_at, ?) WHERE id = ?`,
      until,
      id,
    );
  }

  /**
   * Keeps that a Spend limit refused one of the call's operations after all (#224), `refusal`, and whether it stopped
   * the session's running computer: settling the ticket answers it.
   */
  refused(id: string, refusal: Refusal, computerStopped: boolean): void {
    this.#sql.exec(
      `UPDATE sandbox_run_calls SET refusal = ?, computer_stopped = MAX(computer_stopped, ?) WHERE id = ?`,
      JSON.stringify(refusal),
      computerStopped ? 1 : 0,
      id,
    );
  }

  /**
   * Keeps that the plan refused one of the call's operations after all (#241), and whether it stopped the session's
   * running computer: settling the ticket answers its `planRefusal`.
   */
  planRefused(id: string, computerStopped: boolean): void {
    this.#sql.exec(
      `UPDATE sandbox_run_calls SET plan_refused = 1, computer_stopped = MAX(computer_stopped, ?) WHERE id = ?`,
      computerStopped ? 1 : 0,
      id,
    );
  }

  /**
   * Takes the call's count against the plan off the ticket, once: answers it (`counted`) the first time, for the part
   * to give back to the plan, and nothing after (#241).
   */
  uncount(id: string): number | undefined {
    const row = this.#sql
      .exec<{ counted: number | null }>(`SELECT counted FROM sandbox_run_calls WHERE id = ?`, id)
      .toArray()[0];

    if (row?.counted === null || row?.counted === undefined) return undefined;
    this.#sql.exec(`UPDATE sandbox_run_calls SET counted = NULL WHERE id = ?`, id);

    return row.counted;
  }

  /**
   * Settles the ticket `id` of `principal`'s within its grace, expired or not: ends its operations the first time, and
   * answers it, the same each time (with when it was first settled). Another principal's, or one past its grace, is
   * none.
   */
  settle(id: string, principal: string, now: number): RunCallTicket | undefined {
    this.#sql.exec(
      `UPDATE sandbox_run_calls SET settled_at = ?
       WHERE id = ? AND principal = ? AND settled_at IS NULL AND requested_at >= ?`,
      now,
      id,
      principal,
      now - SETTLE_GRACE_MS,
    );

    const row = this.#sql
      .exec<TicketRow>(
        `SELECT * FROM sandbox_run_calls WHERE id = ? AND principal = ? AND requested_at >= ?`,
        id,
        principal,
        now - SETTLE_GRACE_MS,
      )
      .toArray()[0];

    return row === undefined ? undefined : ticketOf(row);
  }

  /** Forgets every ticket of the principals `principals` (their runs are being deleted). */
  forgetPrincipals(principals: ReadonlyArray<string>): void {
    for (const principal of principals)
      this.#sql.exec(`DELETE FROM sandbox_run_calls WHERE principal = ?`, principal);
  }
}

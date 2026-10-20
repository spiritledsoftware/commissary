/**
 * The usage record of a tool call (#199, ADR 0038): one per call of Commissary's MCP endpoint that names a tool the
 * member reaches, written into the usage database's `usage_records` beside Models' model attempts (`area = 'tools'`,
 * `migrations/usage/0010_usage_tool_calls.sql`). It holds who called (org, principal, member, API key through the
 * principal), which credential served (the toolkit's shared one, or the member's private one), the toolkit and the
 * tool's stable id, the outcome, the latency, the sizes of the arguments and of the result, the cost, and how an
 * approval rule decided it (#201); never the arguments or the result. A call on a private credential or of a private toolkit's tool is marked private, so only its
 * member reads it, as a model attempt on a private credential.
 *
 * Tools writes its own records rather than through Models' usage writer, which is the model attempt's (token
 * accounting, the reporter, pricing by the token): the two share the table, its migrations and the reads, retention
 * and org deletion Models runs on it (docs/ARCHITECTURE.md, "Usage accounting and observability"). Written off the
 * response path (`ctx.waitUntil`), as model records are; a failed write is logged and the record dropped.
 *
 * Browser time (#214, ADR 0039, `migrations/usage/0012_usage_browser_time.sql`): a Quick Action's record carries the
 * browser milliseconds its call used (`browser_ms`), its cost the price per browser hour's share of them on top of the
 * tool's price per call. A browser session writes one record of its own when it closes ({@link BrowserSessionRecord},
 * written by its Durable Object): its browser time from opening to closing and what that cost, under the session's id;
 * the calls in it keep their own records, without browser time. No record holds a URL, page content or a screenshot.
 */
import { Effect } from "effect";
import type { UsageRun } from "@commissary/auth";
import type { ToolCallApproval, ToolCallRecordOutcome } from "@commissary/contract/usage";
import { type OrgId, runAfterResponse } from "@commissary/core";
import { ToolsEnv } from "../env.ts";

export interface ToolCallRecord {
  readonly requestId: string;
  readonly orgId: OrgId;
  /** The caller's principal (`key:<key id>` for an API key, which names the key). */
  readonly principalId: string;
  readonly memberId: string | undefined;
  /** The agent run the call is of (#227): its agent, the run and its starter. */
  readonly run?: UsageRun | undefined;
  readonly toolkitId: string;
  /** The tool's stable id, `<toolkit id>:<upstream name>`. */
  readonly toolId: string;
  /** Which of the toolkit's credentials served the call; undefined when none did. */
  readonly credential: "shared" | "private" | undefined;
  /** A private credential or a private toolkit: its member's alone. */
  readonly private: boolean;
  readonly outcome: ToolCallRecordOutcome;
  /** Epoch ms when the call came in. */
  readonly requestedAt: number;
  readonly latencyMs: number;
  /** Bytes of the arguments and of the result as JSON. */
  readonly requestBytes: number;
  readonly responseBytes: number;
  /** Micro-USD: the tool's price when the call was charged, else 0. */
  readonly costMicros: number;
  /** How an approval rule decided the call (#201): `none` when none made it wait. */
  readonly approval: ToolCallApproval;
  /** The browser time the call used, in ms, when it used any the provider reported (a Quick Action's, #214). */
  readonly browserMs?: number | undefined;
}

/**
 * The columns a tool call's record sets; the others keep their defaults. The columns every record must hold that say
 * nothing of a tool call (provider, model, …) are empty. `auth_type` holds the credential's slot.
 */
const COLUMNS = [
  "request_id",
  "requested_at",
  "latency_ms",
  "provider",
  "executor_type",
  "model",
  "alias",
  "endpoint",
  "principal_id",
  "org_id",
  "member_id",
  "private",
  "auth_id",
  "auth_type",
  "source",
  "failed",
  "cost_micros",
  "unpriced",
  "area",
  "toolkit_id",
  "tool_id",
  "tool_outcome",
  "request_bytes",
  "response_bytes",
  "approval",
  "agent_id",
  "run_id",
  "starter",
  "browser_ms",
  "browser_profile_id",
] as const;

const INSERT_SQL = `INSERT OR IGNORE INTO usage_records (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(
  () => "?",
).join(", ")})`;

/** The endpoint the record names: the MCP endpoint's path. */
const ENDPOINT = "POST /mcp";

const rowOf = (
  record: ToolCallRecord,
): Readonly<Record<(typeof COLUMNS)[number], string | number | null>> => ({
  request_id: record.requestId,
  requested_at: record.requestedAt,
  latency_ms: record.latencyMs,
  provider: "",
  executor_type: "",
  model: "",
  alias: "",
  endpoint: ENDPOINT,
  principal_id: record.principalId,
  org_id: record.orgId,
  member_id: record.memberId ?? null,
  private: record.private ? 1 : 0,
  auth_id: "",
  auth_type: record.credential ?? "",
  source: "",
  failed: record.outcome === "success" ? 0 : 1,
  cost_micros: record.costMicros,
  unpriced: 0,
  area: "tools",
  toolkit_id: record.toolkitId,
  tool_id: record.toolId,
  tool_outcome: record.outcome,
  request_bytes: record.requestBytes,
  response_bytes: record.responseBytes,
  approval: record.approval,
  agent_id: record.run?.agentId ?? null,
  run_id: record.run?.runId ?? null,
  starter: record.run === undefined ? null : (record.run.starter ?? ""),
  browser_ms: record.browserMs ?? null,
  browser_profile_id: null,
});

/** Stores one record (idempotent on `request_id`). */
export const insertToolCallRecord = async (
  db: D1Database,
  record: ToolCallRecord,
): Promise<void> => {
  const row = rowOf(record);

  await db
    .prepare(INSERT_SQL)
    .bind(...COLUMNS.map((column) => row[column]))
    .run();
};

/**
 * Writes `record` off the response path (`ctx.waitUntil`; awaited when there is no execution context to hold it). A
 * failed write is logged with the request id and the error's message only, never the record, and fails nothing.
 */
export const writeToolCallRecord = (record: ToolCallRecord): Effect.Effect<void, never, ToolsEnv> =>
  Effect.gen(function* () {
    const env = yield* ToolsEnv;

    yield* runAfterResponse(
      Effect.tryPromise({
        try: () => insertToolCallRecord(env.USAGE, record),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.catch((message) =>
          Effect.logWarning("tool call usage record write failed").pipe(
            Effect.annotateLogs({ requestId: record.requestId, error: message }),
          ),
        ),
      ),
    );
  });

/**
 * The usage record of a browser session (#214): one per session, written when it closes, under the session's id (so a
 * close that runs twice writes it once). It names the session's org, principal (`key:<key id>` for an API key, which
 * names the key) and member, the toolkit, its browser time from opening to closing and what that cost at the price per
 * browser hour, prorated; no tool (its calls keep their own records), no URL, no page content. The browser toolkit's
 * credential is its shared one (Commissary's own binding), so the record is org-wide. It names the browser profile the
 * session opened from (#215), if it opened from one.
 */
export interface BrowserSessionRecord {
  readonly sessionId: string;
  readonly orgId: string;
  readonly principalId: string;
  readonly memberId: string | undefined;
  readonly toolkitId: string;
  /** Epoch ms when the session opened. */
  readonly openedAt: number;
  readonly browserMs: number;
  /** Micro-USD: its browser time at the price per browser hour while it was open; 0 without one. */
  readonly costMicros: number;
  /** The browser profile it opened from (#215); undefined when it opened from none. */
  readonly profileId?: string | undefined;
}

const sessionRowOf = (
  record: BrowserSessionRecord,
): Readonly<Record<(typeof COLUMNS)[number], string | number | null>> => ({
  request_id: record.sessionId,
  requested_at: record.openedAt,
  latency_ms: 0,
  provider: "",
  executor_type: "",
  model: "",
  alias: "",
  endpoint: ENDPOINT,
  principal_id: record.principalId,
  org_id: record.orgId,
  member_id: record.memberId ?? null,
  private: 0,
  auth_id: "",
  auth_type: "shared",
  source: "",
  failed: 0,
  cost_micros: record.costMicros,
  unpriced: 0,
  area: "tools",
  toolkit_id: record.toolkitId,
  tool_id: null,
  tool_outcome: null,
  request_bytes: null,
  response_bytes: null,
  approval: null,
  agent_id: null,
  run_id: null,
  starter: null,
  browser_ms: record.browserMs,
  browser_profile_id: record.profileId ?? null,
});

/** Stores a browser session's record (idempotent on the session's id). */
export const insertBrowserSessionRecord = async (
  db: D1Database,
  record: BrowserSessionRecord,
): Promise<void> => {
  const row = sessionRowOf(record);

  await db
    .prepare(INSERT_SQL)
    .bind(...COLUMNS.map((column) => row[column]))
    .run();
};

/**
 * The SQL condition of a browser session's own record (#214) in `usage_records`: a tool record that names no tool. The
 * summaries count it as no request (Models' `usage/d1.ts` has the same condition).
 */
export const SESSION_RECORD = "area = 'tools' AND tool_id IS NULL";

/**
 * Deletes the org's browser sessions' records (#214): Tools' org-deletion step, after it deleted the sessions, for a
 * record one of them wrote after Models' step deleted the org's usage rows.
 */
export const deleteBrowserSessionRecords = async (db: D1Database, org: string): Promise<void> => {
  await db
    .prepare(`DELETE FROM usage_records WHERE org_id = ? AND ${SESSION_RECORD}`)
    .bind(org)
    .run();
};

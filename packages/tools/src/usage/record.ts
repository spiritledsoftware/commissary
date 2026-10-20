/**
 * The usage record of a tool call (#199, ADR 0038): one per call of Commissary's MCP endpoint that names a tool the
 * member reaches, written into the usage database's `usage_records` beside Models' model attempts (`area = 'tools'`,
 * `migrations/usage/0010_usage_tool_calls.sql`). It holds who called (org, principal, member, API key through the
 * principal), which credential served (the toolkit's shared one, or the member's private one), the toolkit and the
 * tool's stable id, the outcome, the latency, the sizes of the arguments and of the result, and the cost; never the
 * arguments or the result. A call on a private credential or of a private toolkit's tool is marked private, so only its
 * member reads it, as a model attempt on a private credential.
 *
 * Tools writes its own records rather than through Models' usage writer, which is the model attempt's (token
 * accounting, the reporter, pricing by the token): the two share the table, its migrations and the reads, retention
 * and org deletion Models runs on it (docs/ARCHITECTURE.md, "Usage accounting and observability"). Written off the
 * response path (`ctx.waitUntil`), as model records are; a failed write is logged and the record dropped.
 */
import { Effect } from "effect";
import type { ToolCallRecordOutcome } from "@commissary/contract/usage";
import { type OrgId, runAfterResponse } from "@commissary/core";
import { ToolsEnv } from "../env.ts";

export interface ToolCallRecord {
  readonly requestId: string;
  readonly orgId: OrgId;
  /** The caller's principal (`key:<key id>` for an API key, which names the key). */
  readonly principalId: string;
  readonly memberId: string | undefined;
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

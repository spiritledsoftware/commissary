/**
 * D1 persistence of usage records: schema mapping, the queue/record JSON shape, queries, retention and org deletion.
 *
 * Go source: internal/redisqueue/plugin.go (queuedUsageDetail: the export JSON, pipeline.md §8.4) and
 * internal/redisqueue/queue.go (PopOldest). Go keeps records in an in-process queue for 60 s; here they live in D1
 * (`migrations/usage/0001_usage_records.sql`) and the "queue" is the set of records not yet exported.
 *
 * Workers addition (not in Go): `summarizeUsageSeries` (one aggregate query: requests, failures and v2
 * `acct_total_tokens` per key × UTC hour/day bucket) for the control panel's per-account quota-window bars.
 *
 * Every row belongs to one org (`org_id`, `migrations/usage/0003_usage_org.sql`; ADR 0021) and every read takes the org and
 * filters on it, so one org never sees another org's records. A row names the caller's member id when they had one
 * (`member_id`, `migrations/usage/0005_usage_member.sql`; ADR 0022): reads filter by members (a team is its members) and
 * group by member, and a plain member's reads are narrowed to their own records (`UsageFilter.own`).
 *
 * A row served by a private credential (`private`, `migrations/usage/0006_usage_private.sql`; ADR 0023) belongs to the
 * credential's owner: every read leaves it out unless the filter names the reader (`UsageFilter.privateOf`), who then
 * reads their own private records only. The export queue never carries one.
 *
 * Every row carries its cost (`cost_micros`, `unpriced`; `migrations/usage/0004_usage_cost.sql`, `pricing.ts`, ADR 0024), set
 * when the record is written and never recomputed. A record from before that migration, or one whose pricing failed, has no
 * cost (`NULL`, summed as nothing) and is not unpriced; summaries and series add the cost up, and `unpricedModels` lists what to give a price.
 *
 * Rows keep the credential id (`auth_id`); every read answers with the keyed `auth_index` instead
 * (`management/auth-index.ts`), computed on read under the deployment's key. A config credential id is an unsalted
 * hash of its provider key, so it never leaves the database: the `auth` grouping keys are indexes, and the credential filter
 * takes an index, resolved to the live credential's id by the ControlPlane or, for a credential that no longer exists,
 * against the distinct ids of the filtered rows (`resolveAuthIds`).
 *
 * The table holds tool calls too (#199, `area = 'tools'`, `migrations/usage/0010_usage_tool_calls.sql`), which Tools
 * writes (`packages/tools/src/usage/record.ts`). Every read is of model attempts (`area = 'models'`) unless its filter
 * asks for another area (`UsageFilter.area`), so a model-only consumer reads what it read before; the queue never hands
 * out a tool call. Retention and org deletion delete by org, tool calls included.
 */
import type {
  ToolCallApproval,
  ToolCallRecordOutcome,
  UsageArea,
  UsageAreaFilter,
} from "@commissary/contract/usage";
import type { OrgId } from "@commissary/core";
import type { AuthIndexer } from "../management/auth-index.ts";
import { normalizeToCanonicalUuid } from "../session-routing/identity.ts";
import {
  ensureTokenBreakdown,
  TOKEN_ACCOUNTING_SCHEMA_VERSION,
  type TokenBreakdown,
} from "./accounting.ts";
import type { UsageRecord } from "./record.ts";

/** One `usage_records` row. */
export interface UsageRow {
  request_id: string;
  trace_id: string | null;
  requested_at: number;
  latency_ms: number;
  ttft_ms: number | null;
  provider: string;
  executor_type: string;
  model: string;
  alias: string;
  response_model: string | null;
  endpoint: string;
  principal_id: string;
  org_id: string;
  /** The caller's member id (`migrations/usage/0005_usage_member.sql`); `null` without a member record. */
  member_id: string | null;
  /** Served by a private credential (`migrations/usage/0006_usage_private.sql`): `1`, else `0`. */
  private: number;
  auth_id: string;
  auth_type: string;
  source: string;
  stream: number;
  generate: number;
  failed: number;
  fail_status: number | null;
  /** The failure's error type and code (`migrations/usage/0007_usage_failure.sql`, ADR 0027); never the upstream body. */
  fail_type: string | null;
  fail_code: string | null;
  reasoning_effort: string | null;
  service_tier: string;
  response_service_tier: string | null;
  session_id: string | null;
  parent_session_id: string | null;
  base_url: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  accounting_version: number;
  acct_quality: string;
  acct_total_tokens: number;
  acct_input_tokens: number;
  acct_input_uncached_tokens: number;
  acct_cache_read_tokens: number;
  acct_cache_write_tokens: number;
  acct_output_tokens: number;
  acct_output_non_reasoning_tokens: number;
  acct_output_reasoning_tokens: number;
  acct_unclassified_tokens: number;
  /** Micro-dollars; `null` for a record written before costs existed. */
  cost_micros: number | null;
  /** 1 when the model had no price (the cost is 0). */
  unpriced: number;
  exported_at: number | null;
  /** Who wrote it (`migrations/usage/0010_usage_tool_calls.sql`): a model attempt or a tool call (#199). */
  area: UsageArea;
  /** A tool call's toolkit, the tool's stable id, its outcome and its sizes; `null` on a model attempt's row. */
  toolkit_id: string | null;
  tool_id: string | null;
  tool_outcome: ToolCallRecordOutcome | null;
  request_bytes: number | null;
  response_bytes: number | null;
  /** How an approval rule decided a tool call (#201); `null` on a record from before approvals. */
  approval: ToolCallApproval | null;
}

/** The columns of a model attempt's row (Models writes those); a tool call's are Tools'. */
type ModelColumns = Omit<
  UsageRow,
  | "exported_at"
  | "area"
  | "toolkit_id"
  | "tool_id"
  | "tool_outcome"
  | "request_bytes"
  | "response_bytes"
  | "approval"
>;

type Column = keyof UsageRow;

/** Insert order; `exported_at` stays NULL. */
const INSERT_COLUMNS = [
  "request_id",
  "trace_id",
  "requested_at",
  "latency_ms",
  "ttft_ms",
  "provider",
  "executor_type",
  "model",
  "alias",
  "response_model",
  "endpoint",
  "principal_id",
  "org_id",
  "member_id",
  "private",
  "auth_id",
  "auth_type",
  "source",
  "stream",
  "generate",
  "failed",
  "fail_status",
  "fail_type",
  "fail_code",
  "reasoning_effort",
  "service_tier",
  "response_service_tier",
  "session_id",
  "parent_session_id",
  "base_url",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "total_tokens",
  "accounting_version",
  "acct_quality",
  "acct_total_tokens",
  "acct_input_tokens",
  "acct_input_uncached_tokens",
  "acct_cache_read_tokens",
  "acct_cache_write_tokens",
  "acct_output_tokens",
  "acct_output_non_reasoning_tokens",
  "acct_output_reasoning_tokens",
  "acct_unclassified_tokens",
  "cost_micros",
  "unpriced",
] as const satisfies ReadonlyArray<Column>;

const INSERT_SQL = `INSERT OR IGNORE INTO usage_records (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(
  () => "?",
).join(", ")})`;

const trimmedOrNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";

  return trimmed === "" ? null : trimmed;
};

/** Maps a record (with its v2 breakdown ensured) to a model attempt's row: `area` stays `models`, `exported_at` NULL. */
export const recordToRow = (record: UsageRecord): ModelColumns => {
  const detail = ensureTokenBreakdown(record.detail, record.provider, record.executorType);
  // SAFETY: ensureTokenBreakdown always fills tokenBreakdown.
  const breakdown = detail.tokenBreakdown as TokenBreakdown;

  return {
    request_id: record.requestId,
    trace_id: trimmedOrNull(record.traceId),
    requested_at: record.requestedAt,
    latency_ms: record.latencyMs,
    ttft_ms: record.ttftMs ?? null,
    provider: record.provider.trim() === "" ? "unknown" : record.provider.trim(),
    executor_type: record.executorType.trim() === "" ? "unknown" : record.executorType.trim(),
    model: record.model,
    alias: record.alias.trim() === "" ? record.model : record.alias,
    response_model: trimmedOrNull(record.responseModel),
    endpoint: record.endpoint,
    principal_id: record.principalId,
    org_id: record.orgId,
    member_id: trimmedOrNull(record.memberId),
    private: record.private === true ? 1 : 0,
    auth_id: record.authId,
    auth_type: record.authType.trim() === "" ? "unknown" : record.authType.trim(),
    source: record.source,
    stream: record.stream ? 1 : 0,
    generate: record.generate === false ? 0 : 1,
    failed: record.failed ? 1 : 0,
    fail_status: record.failed ? (record.fail?.statusCode ?? 500) : null,
    fail_type: record.failed ? trimmedOrNull(record.fail?.type) : null,
    fail_code: record.failed ? trimmedOrNull(record.fail?.code) : null,
    reasoning_effort: trimmedOrNull(record.reasoningEffort),
    service_tier: record.serviceTier,
    response_service_tier: trimmedOrNull(detail.responseServiceTier),
    session_id: trimmedOrNull(record.sessionId),
    parent_session_id: trimmedOrNull(record.parentSessionId),
    base_url: trimmedOrNull(record.baseUrl),
    input_tokens: detail.inputTokens,
    output_tokens: detail.outputTokens,
    reasoning_tokens: detail.reasoningTokens,
    cached_tokens: detail.cachedTokens,
    cache_read_tokens: detail.cacheReadTokens,
    cache_creation_tokens: detail.cacheCreationTokens,
    total_tokens: detail.totalTokens,
    accounting_version: breakdown.schemaVersion,
    acct_quality: breakdown.quality,
    acct_total_tokens: breakdown.totalTokens,
    acct_input_tokens: breakdown.input.totalTokens,
    acct_input_uncached_tokens: breakdown.input.uncachedTokens,
    acct_cache_read_tokens: breakdown.input.cacheReadTokens,
    acct_cache_write_tokens: breakdown.input.cacheWriteTokens,
    acct_output_tokens: breakdown.output.totalTokens,
    acct_output_non_reasoning_tokens: breakdown.output.nonReasoningTokens,
    acct_output_reasoning_tokens: breakdown.output.reasoningTokens,
    acct_unclassified_tokens: breakdown.unclassifiedTokens,
    cost_micros: record.cost?.micros ?? null,
    unpriced: record.cost?.unpriced === true ? 1 : 0,
  };
};

/** Stores one record (idempotent on `request_id`). */
export const insertUsageRecord = async (db: D1Database, record: UsageRecord): Promise<void> => {
  const row = recordToRow(record);
  await db
    .prepare(INSERT_SQL)
    .bind(...INSERT_COLUMNS.map((column) => row[column]))
    .run();
};

// ---------------------------------------------------------------------------------------------------------------
// JSON shape (redisqueue queuedUsageDetail)
// ---------------------------------------------------------------------------------------------------------------

/** `session_id`/`parent_session_id` of the export: canonical UUIDs, the parent only when it differs (redisqueue). */
const sessionPayload = (row: UsageRow) => {
  const sessionId = normalizeToCanonicalUuid(row.session_id ?? "");

  if (sessionId === "") return {};
  const parent = normalizeToCanonicalUuid(row.parent_session_id ?? "");

  return {
    session_id: sessionId,
    ...(parent === "" || parent === sessionId ? {} : { parent_session_id: parent }),
  };
};

/**
 * What a tool call's record adds to its JSON (#199): its area, toolkit, tool, outcome, credential slot, sizes and
 * approval. Nothing on a model attempt's, whose JSON stays as it was.
 */
const toolPayload = (row: UsageRow) =>
  row.area !== "tools"
    ? {}
    : {
        area: row.area,
        ...(row.toolkit_id === null ? {} : { toolkit_id: row.toolkit_id }),
        ...(row.tool_id === null ? {} : { tool_id: row.tool_id }),
        ...(row.tool_outcome === null ? {} : { outcome: row.tool_outcome }),
        ...(row.auth_type === "shared" || row.auth_type === "private"
          ? { credential: row.auth_type }
          : {}),
        ...(row.request_bytes === null ? {} : { request_bytes: row.request_bytes }),
        ...(row.response_bytes === null ? {} : { response_bytes: row.response_bytes }),
        ...(row.approval === null ? {} : { approval: row.approval }),
      };

/**
 * The export JSON of one record under the deployment's indexer. `api_key` carries the Access principal id (the Go
 * client API key). A tool call's record (#199) has no `auth_index` (its credential is the toolkit's, `credential`) and
 * answers `{status_code: 200}` whatever its outcome, as the MCP endpoint did: `outcome` says how it went.
 */
export const rowToPayload = (row: UsageRow, authIndexOf: AuthIndexer) => {
  const tool = row.area === "tools";
  const failed = row.failed === 1;

  return {
    timestamp: new Date(row.requested_at).toISOString(),
    latency_ms: row.latency_ms,
    ttft_ms: row.ttft_ms ?? 0,
    source: row.source,
    // The management API's keyed `auth_index`, so collectors can join the two; the credential id is never exported.
    auth_index: tool ? "" : authIndexOf(row.auth_id),
    tokens: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      reasoning_tokens: row.reasoning_tokens,
      cached_tokens: row.cached_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_read_tokens_present: true,
      cache_creation_tokens: row.cache_creation_tokens,
      total_tokens: row.total_tokens,
    },
    failed,
    generate: row.generate !== 0,
    stream: row.stream === 1,
    fail:
      failed && !tool
        ? {
            status_code: row.fail_status ?? 500,
            ...(row.fail_type === null ? {} : { type: row.fail_type }),
            ...(row.fail_code === null ? {} : { code: row.fail_code }),
          }
        : { status_code: 200 },
    accounting_version:
      row.accounting_version === 0 ? TOKEN_ACCOUNTING_SCHEMA_VERSION : row.accounting_version,
    token_breakdown: {
      schema_version: row.accounting_version,
      quality: row.acct_quality,
      total_tokens: row.acct_total_tokens,
      input: {
        total_tokens: row.acct_input_tokens,
        uncached_tokens: row.acct_input_uncached_tokens,
        cache_read_tokens: row.acct_cache_read_tokens,
        cache_write_tokens: row.acct_cache_write_tokens,
      },
      output: {
        total_tokens: row.acct_output_tokens,
        non_reasoning_tokens: row.acct_output_non_reasoning_tokens,
        reasoning_tokens: row.acct_output_reasoning_tokens,
      },
      unclassified_tokens: row.acct_unclassified_tokens,
    },
    provider: row.provider,
    executor_type: row.executor_type,
    model: row.model,
    alias: row.alias,
    endpoint: row.endpoint,
    auth_type: row.auth_type,
    api_key: row.principal_id,
    ...(row.member_id === null ? {} : { member_id: row.member_id }),
    ...(row.private === 1 ? { private: true } : {}),
    request_id: row.request_id,
    ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
    ...sessionPayload(row),
    ...(row.base_url === null ? {} : { base_url: row.base_url }),
    reasoning_effort: row.reasoning_effort ?? "",
    service_tier: row.service_tier,
    ...(row.response_service_tier === null
      ? {}
      : { response_service_tier: row.response_service_tier }),
    ...(row.response_model === null ? {} : { response_model: row.response_model }),
    ...(row.cost_micros === null
      ? {}
      : { cost_micros: row.cost_micros, unpriced: row.unpriced === 1 }),
    ...toolPayload(row),
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Queue (GET .../usage/queue)
// ---------------------------------------------------------------------------------------------------------------

export const MAX_QUEUE_COUNT = 1000;

/**
 * `PopOldest`: atomically marks the oldest `count` unexported records of `org` as exported and returns them oldest
 * first. An exported record stays in D1 (for the listing and summary endpoints) until retention removes it. Model
 * attempts only: the export keeps the Go server's shape, so a tool call (#199) is never handed out or marked exported.
 */
export const popUsageQueue = async (
  db: D1Database,
  org: OrgId,
  count: number,
  now: number,
): Promise<ReadonlyArray<UsageRow>> => {
  const limit = Math.max(1, Math.min(MAX_QUEUE_COUNT, Math.trunc(count)));

  const result = await db
    .prepare(
      `UPDATE usage_records SET exported_at = ?1 WHERE request_id IN (
         SELECT request_id FROM usage_records
         WHERE org_id = ?3 AND exported_at IS NULL AND area = 'models' AND private = 0
         ORDER BY requested_at ASC, request_id ASC LIMIT ?2
       ) RETURNING *`,
    )
    .bind(now, limit, org)
    .run<UsageRow>();

  return result.results.toSorted(
    (a, b) =>
      a.requested_at - b.requested_at ||
      (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0),
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Listing and summary
// ---------------------------------------------------------------------------------------------------------------

export interface UsageFilter {
  /** Inclusive lower bound of `requested_at` (epoch ms). */
  readonly since?: number;
  /** Exclusive upper bound of `requested_at` (epoch ms). */
  readonly until?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly principal?: string;
  /** Records of these members only (the `member` and `team` filters); an empty list matches nothing. */
  readonly memberIds?: ReadonlyArray<string>;
  /**
   * The caller's own records only (a plain member): those with their member id, or with their Access principal for
   * records written before members existed or without a member record.
   */
  readonly own?: OwnRecords;
  /**
   * The member whose private records are read too (the caller). Records served by a private credential are left out
   * of every read, except these: the ones of this member.
   */
  readonly privateOf?: string;
  /** Keyed `auth_index` of the credential (`resolveAuthIds`). */
  readonly authIndex?: string;
  /** The live credential id the ControlPlane resolved `authIndex` to (`credentialIdOfAuthIndex`), if any. */
  readonly liveAuthId?: string;
  readonly failed?: boolean;
  /**
   * Whose records (#199): model attempts, tool calls or `all`. Unset: model attempts, or tool calls when `toolkit` or
   * `tool` is set, so a reader that asks for nothing new reads what it read before tool calls were recorded.
   */
  readonly area?: UsageAreaFilter;
  /** A toolkit's id: its tool calls. */
  readonly toolkit?: string;
  /** A tool's stable id: its calls. */
  readonly tool?: string;
}

/** The area a filter reads: its own, or model attempts unless it names a toolkit or a tool. */
const areaOf = (filter: UsageFilter): UsageAreaFilter =>
  filter.area ?? (filter.toolkit !== undefined || filter.tool !== undefined ? "tools" : "models");

/**
 * `query` reading the area its grouping implies when it names none: tool calls for a grouping by toolkit or tool (a
 * model attempt has neither), both areas for a grouping by area.
 */
const withGroupArea = <Q extends { readonly area?: UsageAreaFilter }>(
  query: Q,
  groupBy: string,
): Q => {
  if (query.area !== undefined) return query;

  if (groupBy === "toolkit" || groupBy === "tool") return { ...query, area: "tools" };

  return groupBy === "area" ? { ...query, area: "all" } : query;
};

/** A group's key by `auth`: the credential's keyed `auth_index`; empty for a record without one (a tool call). */
const authKey = (authIndexOf: AuthIndexer, authId: string): string =>
  authId === "" ? "" : authIndexOf(authId);

export interface OwnRecords {
  readonly memberId: string | undefined;
  readonly principalId: string;
}

interface FilterClauses {
  readonly where: string;
  readonly params: Array<string | number>;
}

/**
 * `filter` within `org` as SQL (the org clause is always there); `authIds` are the credential ids `filter.authIndex`
 * resolved to (`resolveAuthIds`).
 */
const filterClauses = (
  org: OrgId,
  filter: UsageFilter,
  authIds: ReadonlyArray<string> | undefined,
): FilterClauses => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  const add = (clause: string, value: string | number) => {
    params.push(value);
    clauses.push(clause.replace("?", `?${params.length}`));
  };

  add("org_id = ?", org);

  const area = areaOf(filter);

  if (area !== "all") add("area = ?", area);

  if (filter.toolkit !== undefined) add("toolkit_id = ?", filter.toolkit);

  if (filter.tool !== undefined) add("tool_id = ?", filter.tool);

  // Private traffic is its owner's alone: never part of an org-wide read.
  if (filter.privateOf === undefined) clauses.push("private = 0");
  else add("(private = 0 OR member_id = ?)", filter.privateOf);

  if (filter.since !== undefined) add("requested_at >= ?", filter.since);

  if (filter.until !== undefined) add("requested_at < ?", filter.until);

  if (filter.provider !== undefined) add("provider = ?", filter.provider);

  if (filter.model !== undefined) add("model = ?", filter.model);

  if (filter.principal !== undefined) add("principal_id = ?", filter.principal);

  // One JSON parameter however large the team: D1 binds at most 100 parameters per query.
  if (filter.memberIds !== undefined)
    add("member_id IN (SELECT value FROM json_each(?))", JSON.stringify(filter.memberIds));

  if (filter.own !== undefined) {
    params.push(filter.own.principalId);
    const principal = `principal_id = ?${params.length}`;

    if (filter.own.memberId === undefined) clauses.push(principal);
    else {
      params.push(filter.own.memberId);
      clauses.push(`(member_id = ?${params.length} OR ${principal})`);
    }
  }

  if (authIds !== undefined) {
    const first = params.length + 1;
    params.push(...authIds);

    // An index no stored id maps to matches nothing.
    clauses.push(
      authIds.length === 0
        ? "0"
        : `auth_id IN (${authIds.map((_, offset) => `?${first + offset}`).join(", ")})`,
    );
  }

  if (filter.failed !== undefined) add("failed = ?", filter.failed ? 1 : 0);

  return { where: ` WHERE ${clauses.join(" AND ")}`, params };
};

/**
 * The credential ids `filter.authIndex` stands for in `org` (undefined without an index). A live credential
 * (`filter.liveAuthId`, resolved by the ControlPlane) is used directly, with no D1 read. Otherwise (a deleted
 * credential, or an index that matches nothing) the distinct `auth_id`s of the rows the other filters select are read
 * and indexed: a scan of the `usage_records_auth` index over the filtered range, bounded by the records kept
 * (the org's usage retention period).
 */
export const resolveAuthIds = async (
  db: D1Database,
  org: OrgId,
  filter: UsageFilter,
  authIndexOf: AuthIndexer,
): Promise<ReadonlyArray<string> | undefined> => {
  const { authIndex, liveAuthId, ...rest } = filter;

  if (authIndex === undefined) return undefined;

  if (liveAuthId !== undefined && authIndexOf(liveAuthId) === authIndex) return [liveAuthId];
  const { where, params } = filterClauses(org, rest, undefined);

  const result = await db
    .prepare(`SELECT DISTINCT auth_id FROM usage_records${where}`)
    .bind(...params)
    .all<{ readonly auth_id: string }>();

  return result.results.map((row) => row.auth_id).filter((id) => authIndexOf(id) === authIndex);
};

/** `filter` within `org` as SQL, its `authIndex` resolved first. */
const resolvedClauses = async (
  db: D1Database,
  org: OrgId,
  filter: UsageFilter,
  authIndexOf: AuthIndexer,
): Promise<FilterClauses> =>
  filterClauses(org, filter, await resolveAuthIds(db, org, filter, authIndexOf));

export const MAX_LIST_LIMIT = 1000;

export const DEFAULT_LIST_LIMIT = 100;

export interface UsageListQuery extends UsageFilter {
  readonly limit?: number;
  /** Cursor from a previous page: `<requested_at>:<request_id>`. */
  readonly before?: string;
}

export interface UsageListPage {
  readonly rows: ReadonlyArray<UsageRow>;
  readonly nextBefore: string | undefined;
}

export const parseCursor = (
  cursor: string,
): { readonly at: number; readonly id: string } | undefined => {
  const separator = cursor.indexOf(":");

  if (separator <= 0) return undefined;
  const at = Number(cursor.slice(0, separator));

  return Number.isSafeInteger(at) ? { at, id: cursor.slice(separator + 1) } : undefined;
};

/** Newest records of `org` first, keyset-paginated. */
export const listUsageRecords = async (
  db: D1Database,
  org: OrgId,
  query: UsageListQuery,
  authIndexOf: AuthIndexer,
): Promise<UsageListPage> => {
  const limit = Math.max(
    1,
    Math.min(MAX_LIST_LIMIT, Math.trunc(query.limit ?? DEFAULT_LIST_LIMIT)),
  );

  const { where, params } = await resolvedClauses(db, org, query, authIndexOf);
  const cursor = query.before === undefined ? undefined : parseCursor(query.before);
  let sql = `SELECT * FROM usage_records${where}`;

  if (cursor !== undefined) {
    params.push(cursor.at, cursor.id);
    sql += ` AND (requested_at < ?${params.length - 1} OR (requested_at = ?${params.length - 1} AND request_id < ?${params.length}))`;
  }

  params.push(limit + 1);
  sql += ` ORDER BY requested_at DESC, request_id DESC LIMIT ?${params.length}`;

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<UsageRow>();

  const rows = result.results.slice(0, limit);
  const last = rows[rows.length - 1];
  const more = result.results.length > limit && last !== undefined;

  return { rows, nextBefore: more ? `${last.requested_at}:${last.request_id}` : undefined };
};

export const GROUP_BY = [
  "model",
  "provider",
  "principal",
  "member",
  "auth",
  "endpoint",
  "day",
  "key",
  "team",
  "area",
  "toolkit",
  "tool",
] as const;

export type GroupBy = (typeof GROUP_BY)[number];

/**
 * `team` is no column: a member may be in several teams, so `summarizeUsage` sums each team's members' records
 * separately (`UsageSummaryQuery.teams`) and the groups can overlap.
 */
const GROUP_EXPRESSIONS: Readonly<Record<Exclude<GroupBy, "team">, string>> = {
  /** The API key's id: its `key:<id>` principal; records of any other sign-in have the empty key. */
  key: "CASE WHEN principal_id LIKE 'key:%' THEN substr(principal_id, 5) END",
  model: "model",
  provider: "provider",
  principal: "principal_id",
  member: "member_id",
  auth: "auth_id",
  endpoint: "endpoint",
  day: "strftime('%Y-%m-%d', requested_at / 1000, 'unixepoch')",
  area: "area",
  toolkit: "toolkit_id",
  tool: "tool_id",
};

const AGGREGATES = `COUNT(*) AS requests,
  COALESCE(SUM(failed), 0) AS failed,
  COALESCE(SUM(acct_input_tokens), 0) AS input_tokens,
  COALESCE(SUM(acct_input_uncached_tokens), 0) AS uncached_input_tokens,
  COALESCE(SUM(acct_cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(acct_cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(acct_output_tokens), 0) AS output_tokens,
  COALESCE(SUM(acct_output_reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(acct_unclassified_tokens), 0) AS unclassified_tokens,
  COALESCE(SUM(acct_total_tokens), 0) AS total_tokens,
  COALESCE(SUM(cost_micros), 0) AS cost_micros,
  COALESCE(SUM(unpriced), 0) AS unpriced_requests,
  COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
  AVG(ttft_ms) AS avg_ttft_ms`;

export interface UsageTotals {
  readonly requests: number;
  readonly failed: number;
  readonly input_tokens: number;
  readonly uncached_input_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly unclassified_tokens: number;
  readonly total_tokens: number;
  /** Micro-dollars: the cost stored on the records (records from before costs existed add nothing). */
  readonly cost_micros: number;
  /** Requests on a model that had no price when they were recorded. */
  readonly unpriced_requests: number;
  readonly avg_latency_ms: number;
  readonly avg_ttft_ms: number | null;
}

const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  failed: 0,
  input_tokens: 0,
  uncached_input_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  unclassified_tokens: 0,
  total_tokens: 0,
  cost_micros: 0,
  unpriced_requests: 0,
  avg_latency_ms: 0,
  avg_ttft_ms: null,
};

export interface UsageGroup extends UsageTotals {
  readonly key: string;
}

export interface UsageSummary {
  readonly totals: UsageTotals;
  readonly groups: ReadonlyArray<UsageGroup>;
}

export interface TeamMembers {
  readonly id: string;
  readonly memberIds: ReadonlyArray<string>;
}

export interface UsageSummaryQuery extends UsageFilter {
  readonly groupBy: GroupBy;
  /** The teams `groupBy: "team"` groups by, with their members. */
  readonly teams?: ReadonlyArray<TeamMembers>;
  readonly limit?: number;
}

/**
 * Token totals (v2 breakdown buckets) of `org` overall and per `groupBy` key, largest total first (`day`:
 * chronological). The `auth` keys are keyed `auth_index` values.
 */
export const summarizeUsage = async (
  db: D1Database,
  org: OrgId,
  asked: UsageSummaryQuery,
  authIndexOf: AuthIndexer,
): Promise<UsageSummary> => {
  const query = withGroupArea(asked, asked.groupBy);
  const { where, params } = await resolvedClauses(db, org, query, authIndexOf);

  const limit = Math.max(
    1,
    Math.min(MAX_LIST_LIMIT, Math.trunc(query.limit ?? DEFAULT_LIST_LIMIT)),
  );

  const order = query.groupBy === "day" ? "key DESC" : "total_tokens DESC, requests DESC, key ASC";

  if (query.groupBy === "team") {
    const teams = query.teams ?? [];

    const statements = await Promise.all(
      teams.map(async (team) => {
        // The team's members within the member filter, if any.
        const memberIds =
          query.memberIds === undefined
            ? team.memberIds
            : team.memberIds.filter((id) => query.memberIds?.includes(id) === true);

        const scoped = await resolvedClauses(db, org, { ...query, memberIds }, authIndexOf);

        return db
          .prepare(`SELECT ${AGGREGATES} FROM usage_records${scoped.where}`)
          .bind(...scoped.params);
      }),
    );

    const overall = db.prepare(`SELECT ${AGGREGATES} FROM usage_records${where}`).bind(...params);
    const [total, ...perTeam] = await db.batch<UsageTotals>([overall, ...statements]);

    return {
      totals: total?.results[0] ?? EMPTY_TOTALS,
      groups: teams
        .flatMap((team, index) => {
          const row = perTeam[index]?.results[0];

          return row === undefined || row.requests === 0 ? [] : [{ ...row, key: team.id }];
        })
        .toSorted(
          (a, b) =>
            b.total_tokens - a.total_tokens ||
            b.requests - a.requests ||
            a.key.localeCompare(b.key),
        )
        .slice(0, limit),
    };
  }

  const expression = GROUP_EXPRESSIONS[query.groupBy];

  const [totals, groups] = await db.batch<UsageTotals & { key?: string }>([
    db.prepare(`SELECT ${AGGREGATES} FROM usage_records${where}`).bind(...params),
    db
      .prepare(
        `SELECT ${expression} AS key, ${AGGREGATES} FROM usage_records${where} GROUP BY key ORDER BY ${order} LIMIT ${limit}`,
      )
      .bind(...params),
  ]);

  return {
    totals: totals?.results[0] ?? EMPTY_TOTALS,
    groups: (groups?.results ?? []).map((group) => {
      const key = String(group.key ?? "");

      return { ...group, key: query.groupBy === "auth" ? authKey(authIndexOf, key) : key };
    }),
  };
};

export interface UnpricedModel {
  readonly provider: string;
  readonly model: string;
  readonly requests: number;
  readonly total_tokens: number;
}

export const MAX_UNPRICED_MODELS = 100;

/**
 * The provider and model pairs of `org`'s unpriced records within `filter`, the busiest first: what an org admin would
 * give a price override (a record keeps its cost, so a new override prices traffic from then on).
 */
export const unpricedModels = async (
  db: D1Database,
  org: OrgId,
  filter: UsageFilter,
  authIndexOf: AuthIndexer,
): Promise<ReadonlyArray<UnpricedModel>> => {
  const { where, params } = await resolvedClauses(db, org, filter, authIndexOf);

  const result = await db
    .prepare(
      `SELECT provider, model, COUNT(*) AS requests, COALESCE(SUM(acct_total_tokens), 0) AS total_tokens
       FROM usage_records${where} AND unpriced = 1 GROUP BY provider, model
       ORDER BY requests DESC, total_tokens DESC, provider ASC, model ASC LIMIT ${MAX_UNPRICED_MODELS}`,
    )
    .bind(...params)
    .all<UnpricedModel>();

  return result.results;
};

// ---------------------------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------------------------

export const SERIES_BUCKETS = ["hour", "day"] as const;

export type SeriesBucket = (typeof SERIES_BUCKETS)[number];

export const SERIES_GROUP_BY = ["auth", "model", "provider", "toolkit", "tool"] as const;

export type SeriesGroupBy = (typeof SERIES_GROUP_BY)[number];

const HOUR_MS = 3_600_000;

const DAY_MS = 86_400_000;

export const BUCKET_MS: Readonly<Record<SeriesBucket, number>> = { hour: HOUR_MS, day: DAY_MS };

/** Widest range a series query may span, per bucket size (keeps the response bounded). */
export const MAX_SERIES_RANGE_DAYS: Readonly<Record<SeriesBucket, number>> = { hour: 31, day: 400 };

const SERIES_KEY_EXPRESSIONS: Readonly<Record<SeriesGroupBy, string>> = {
  auth: "auth_id",
  model: "model",
  provider: "provider",
  toolkit: "toolkit_id",
  tool: "tool_id",
};

export interface UsagePoint {
  /** Bucket start, epoch ms (UTC hour or day boundary). */
  readonly start: number;
  readonly requests: number;
  readonly failed: number;
  readonly total_tokens: number;
  /** Micro-dollars. */
  readonly cost_micros: number;
}

export interface UsageSeriesGroup {
  readonly key: string;
  readonly points: ReadonlyArray<UsagePoint>;
}

export interface UsageSeriesQuery {
  /** Inclusive (epoch ms). */
  readonly since: number;
  /** Exclusive (epoch ms). */
  readonly until: number;
  readonly bucket: SeriesBucket;
  readonly groupBy: SeriesGroupBy;
  readonly provider?: string;
  readonly model?: string;
  /** Keyed `auth_index` of the credential. */
  readonly authIndex?: string;
  /** See {@link UsageFilter.liveAuthId}. */
  readonly liveAuthId?: string;
  /** See {@link UsageFilter.memberIds}. */
  readonly memberIds?: ReadonlyArray<string>;
  /** See {@link UsageFilter.own}. */
  readonly own?: OwnRecords;
  /** See {@link UsageFilter.privateOf}. */
  readonly privateOf?: string;
  /** See {@link UsageFilter.area}. */
  readonly area?: UsageAreaFilter;
  readonly toolkit?: string;
  readonly tool?: string;
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface SeriesRow {
  readonly key: string | null;
  readonly start: number;
  readonly requests: number;
  readonly failed: number;
  readonly total_tokens: number;
  readonly cost_micros: number;
}

/**
 * Requests, failures, `acct_total_tokens` and cost of `org` per `groupBy` key and UTC hour/day bucket (only buckets with requests),
 * series sorted by key, points by time. The first bucket may start before `since` (it holds the records from `since`).
 * The `auth` keys are keyed `auth_index` values.
 */
export const summarizeUsageSeries = async (
  db: D1Database,
  org: OrgId,
  asked: UsageSeriesQuery,
  authIndexOf: AuthIndexer,
): Promise<ReadonlyArray<UsageSeriesGroup>> => {
  const query = withGroupArea(asked, asked.groupBy);

  const { where, params } = await resolvedClauses(
    db,
    org,
    {
      since: query.since,
      until: query.until,
      ...(query.provider === undefined ? {} : { provider: query.provider }),
      ...(query.model === undefined ? {} : { model: query.model }),
      ...(query.authIndex === undefined ? {} : { authIndex: query.authIndex }),
      ...(query.liveAuthId === undefined ? {} : { liveAuthId: query.liveAuthId }),
      ...(query.memberIds === undefined ? {} : { memberIds: query.memberIds }),
      ...(query.own === undefined ? {} : { own: query.own }),
      ...(query.privateOf === undefined ? {} : { privateOf: query.privateOf }),
      ...(query.area === undefined ? {} : { area: query.area }),
      ...(query.toolkit === undefined ? {} : { toolkit: query.toolkit }),
      ...(query.tool === undefined ? {} : { tool: query.tool }),
    },
    authIndexOf,
  );

  const ms = BUCKET_MS[query.bucket];
  const key = SERIES_KEY_EXPRESSIONS[query.groupBy];

  const result = await db
    .prepare(
      `SELECT ${key} AS key, (requested_at / ${ms}) * ${ms} AS start, COUNT(*) AS requests,
         COALESCE(SUM(failed), 0) AS failed, COALESCE(SUM(acct_total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_micros), 0) AS cost_micros
       FROM usage_records${where} GROUP BY key, start ORDER BY key ASC, start ASC`,
    )
    .bind(...params)
    .all<SeriesRow>();

  const series: Array<{ key: string; points: UsagePoint[] }> = [];

  for (const row of result.results) {
    const rawKey = String(row.key ?? "");
    const rowKey = query.groupBy === "auth" ? authKey(authIndexOf, rawKey) : rawKey;
    let current = series[series.length - 1];

    if (current === undefined || current.key !== rowKey) {
      current = { key: rowKey, points: [] };
      series.push(current);
    }

    current.points.push({
      start: row.start,
      requests: row.requests,
      failed: row.failed,
      total_tokens: row.total_tokens,
      cost_micros: row.cost_micros,
    });
  }

  // Indexes do not sort like the ids the query ordered by.
  return query.groupBy === "auth" ? series.toSorted((a, b) => compareKeys(a.key, b.key)) : series;
};

// ---------------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------------

export const PRUNE_BATCH = 5000;

const MAX_PRUNE_BATCHES = 40;

/**
 * Deletes the records of `org` older than `cutoff` (epoch ms) in bounded batches (an org's retention period, ADR 0027);
 * returns the number removed.
 */
export const pruneUsageRecords = async (
  db: D1Database,
  org: OrgId,
  cutoff: number,
): Promise<number> => {
  let removed = 0;

  for (let batch = 0; batch < MAX_PRUNE_BATCHES; batch += 1) {
    const result = await db
      .prepare(
        `DELETE FROM usage_records WHERE request_id IN (
           SELECT request_id FROM usage_records WHERE org_id = ?3 AND requested_at < ?1
           ORDER BY requested_at ASC LIMIT ?2
         )`,
      )
      .bind(cutoff, PRUNE_BATCH, org)
      .run();

    const changes = result.meta.changes ?? 0;
    removed += changes;

    if (changes < PRUNE_BATCH) break;
  }

  return removed;
};

/**
 * Deletes every record of `org` (the org was deleted, ADR 0027) in bounded batches; answers how many were removed and
 * whether any remain, so the caller can run it again; `calls` is how many D1 statements it ran (a Worker invocation
 * has a subrequest limit, `platform/org-deletion.ts`).
 */
export const deleteOrgUsage = async (
  db: D1Database,
  org: OrgId,
): Promise<{
  readonly removed: number;
  readonly complete: boolean;
  readonly calls: number;
}> => {
  let removed = 0;

  for (let batch = 0; batch < MAX_PRUNE_BATCHES; batch += 1) {
    const result = await db
      .prepare(
        `DELETE FROM usage_records WHERE request_id IN (
           SELECT request_id FROM usage_records WHERE org_id = ?1 LIMIT ?2
         )`,
      )
      .bind(org, PRUNE_BATCH)
      .run();

    const changes = result.meta.changes ?? 0;
    removed += changes;

    if (changes < PRUNE_BATCH) return { removed, complete: true, calls: batch + 1 };
  }

  return { removed, complete: false, calls: MAX_PRUNE_BATCHES };
};

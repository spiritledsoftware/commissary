/**
 * `GET /v9/management/observability/usage/summary` (token totals), `/series` (totals per time bucket) and `/records`
 * (the request log, newest first, keyset-paged) from the D1 usage history (`packages/models/src/management/usage-routes.ts`,
 * `packages/models/src/usage/d1.ts` `summarizeUsage` / `summarizeUsageSeries` / `listUsageRecords` / `rowToPayload`). Shared
 * with the browser: imports `effect` only.
 *
 * Two areas write usage records (#199): Models one per upstream attempt, Tools one per call of Commissary's MCP endpoint
 * (`packages/tools/src/usage/record.ts`). Every read is of model attempts unless it asks for another `area` (`tools`,
 * or `all` for both); naming a `toolkit` or a `tool` asks for tool calls. A tool call's record holds no arguments and no
 * results: its toolkit, the tool's stable id, its outcome, its latency, its sizes and its cost. The browser toolkit's
 * records carry browser time besides (#214), and a browser session writes one of its own when it closes.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/** Who wrote a usage record: Models (an upstream attempt) or Tools (a tool call, #199). */
export const UsageArea = Schema.Literals(["models", "tools"]);

export type UsageArea = typeof UsageArea.Type;

/**
 * What a read covers: one area, or `all` of them. Unset: `models`, or `tools` with a `toolkit` or `tool` filter or a
 * grouping by toolkit or tool, or `all` with a grouping by area.
 */
export const UsageAreaFilter = Schema.Literals(["models", "tools", "all"]);

export type UsageAreaFilter = typeof UsageAreaFilter.Type;

/**
 * What a tool call came to: the upstream's result (`success`, or `tool_error` when it says `isError`), an upstream or
 * transport failure (`upstream_failure`), a Spend limit without room (`refused`, before the upstream is reached), a
 * tool that needs the member's own credential, which they have not connected (`needs_credential`), or, under an
 * approval rule (#201), an answer that the call waits for its approver (`approval_pending`) or that it was not
 * approved (`not_approved`: it was denied, on its form or its approval page, or no one could approve it: a caller
 * without a member under a rule whose approver is the caller, from a client that shows no forms); neither reaches the
 * upstream. The last two are beyond the outcomes #199 named, so a usage view can tell a held call from a failed one.
 */
export const ToolCallRecordOutcome = Schema.Literals([
  "success",
  "tool_error",
  "upstream_failure",
  "refused",
  "needs_credential",
  "approval_pending",
  "not_approved",
]);

export type ToolCallRecordOutcome = typeof ToolCallRecordOutcome.Type;

/**
 * How an approval rule decided a tool call (#201): `none` (no rule applies), `approved_elicitation` (its caller approved
 * it on a form), `approved_panel` (an approver approved it on its approval page; this is the repeat that went through),
 * `denied` (denied on its form or its approval page, or no one could approve it; outcome `not_approved`), or `pending`
 * (the call answered that it waits; outcome `approval_pending`). An approval that expires is deleted with its hour: a
 * call repeated after it waits anew (`pending`), so no record says `expired`. Absent on the records of tool calls
 * from before approvals.
 */
export const ToolCallApproval = Schema.Literals([
  "none",
  "approved_elicitation",
  "approved_panel",
  "denied",
  "pending",
]);

export type ToolCallApproval = typeof ToolCallApproval.Type;

/**
 * The filters every read takes besides its own: the area, a tool call's toolkit and tool (its stable id), and the hosted
 * agent and agent run a record comes from (#228).
 */
const areaFilters = {
  area: optional(UsageAreaFilter),
  /** A toolkit's id: its tool calls. */
  toolkit: optional(Schema.String),
  /** A tool's stable id, `<toolkit id>:<upstream name>`: its calls. */
  tool: optional(Schema.String),
  /** A hosted agent's id: the records of its runs, in the areas the read covers. */
  agent: optional(Schema.String),
  /** An agent run's id: its records. */
  run: optional(Schema.String),
};

/** Keys a summary can be grouped by (`packages/models/src/usage/d1.ts` `GROUP_BY`; a contract test keeps them equal). */
export const UsageGroupBy = Schema.Literals([
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
]);

export type UsageGroupBy = typeof UsageGroupBy.Type;

const usageTotalsFields = {
  requests: Schema.Number,
  failed: Schema.Number,
  input_tokens: Schema.Number,
  uncached_input_tokens: Schema.Number,
  cache_read_tokens: Schema.Number,
  cache_write_tokens: Schema.Number,
  output_tokens: Schema.Number,
  reasoning_tokens: Schema.Number,
  unclassified_tokens: Schema.Number,
  total_tokens: Schema.Number,
  /** Micro-dollars (1 USD = 1,000,000): the cost stored on the records, priced when each was written. */
  cost_micros: Schema.Number,
  /** Requests on a model that had no price when recorded (their cost is 0). */
  unpriced_requests: Schema.Number,
  avg_latency_ms: Schema.Number,
  avg_ttft_ms: Schema.NullOr(Schema.Number),
  /**
   * Browser time (#214), in milliseconds: the browser toolkit's Quick Actions' and its sessions' (whose own records, one
   * per session, count toward no request, failure or latency; their cost counts in `cost_micros`).
   */
  browser_ms: optional(Schema.Number),
  /**
   * Computer time (#224), in milliseconds: the sandbox toolkit's sessions' (whose own records, one per session, count
   * toward no request, failure or latency; their cost counts in `cost_micros`).
   */
  computer_ms: optional(Schema.Number),
};

export const UsageTotals = Schema.Struct(usageTotalsFields);

export type UsageTotals = typeof UsageTotals.Type;

export const UsageGroup = Schema.Struct({ key: Schema.String, ...usageTotalsFields });

export type UsageGroup = typeof UsageGroup.Type;

export const UsageSummary = Schema.Struct({
  group_by: UsageGroupBy,
  totals: UsageTotals,
  groups: Schema.Array(UsageGroup),
});

export type UsageSummary = typeof UsageSummary.Type;

/**
 * Filters: `since` inclusive and `until` exclusive (epoch milliseconds); `auth_index` is a credential's keyed index (the
 * `auth_index` of `/credentials`, `/provider-keys` and the records). Grouped `by=auth`, the keys are `auth_index` values;
 * grouped by `member`, member ids (`""` for records without one). A plain member reads only their own records, whatever
 * the filters say.
 */
export const UsageSummaryQuery = Schema.Struct({
  group_by: optional(UsageGroupBy),
  since: optional(Schema.Number),
  until: optional(Schema.Number),
  provider: optional(Schema.String),
  model: optional(Schema.String),
  principal: optional(Schema.String),
  /** A member id of the org (`/members`). */
  member: optional(Schema.String),
  /** A team id of the org (`/teams`): the records of its members. */
  team: optional(Schema.String),
  auth_index: optional(Schema.String),
  failed: optional(Schema.Literals(["true", "false"])),
  limit: optional(Schema.Number),
  ...areaFilters,
});

/** Series buckets: UTC hours or UTC days, each point keyed by its start (epoch milliseconds). */
export const UsageBucket = Schema.Literals(["hour", "day"]);

export type UsageBucket = typeof UsageBucket.Type;

/** Keys a series can be split by: one series per credential (keyed by `auth_index`), model, provider, toolkit or tool. */
export const UsageSeriesGroupBy = Schema.Literals(["auth", "model", "provider", "toolkit", "tool"]);

export const UsagePoint = Schema.Struct({
  start: Schema.Number,
  requests: Schema.Number,
  failed: Schema.Number,
  total_tokens: Schema.Number,
  cost_micros: Schema.Number,
});

export type UsagePoint = typeof UsagePoint.Type;

/** `points` are in time order and hold only buckets with requests. */
export const UsageSeries = Schema.Struct({
  bucket: UsageBucket,
  group_by: UsageSeriesGroupBy,
  series: Schema.Array(Schema.Struct({ key: Schema.String, points: Schema.Array(UsagePoint) })),
});

export type UsageSeries = typeof UsageSeries.Type;

/** `since` is required (epoch milliseconds, inclusive); `until` is exclusive and defaults to now. */
export const UsageSeriesQuery = Schema.Struct({
  since: Schema.Number,
  until: optional(Schema.Number),
  bucket: optional(UsageBucket),
  group_by: optional(UsageSeriesGroupBy),
  provider: optional(Schema.String),
  model: optional(Schema.String),
  auth_index: optional(Schema.String),
  member: optional(Schema.String),
  team: optional(Schema.String),
  ...areaFilters,
});

const tokenBreakdown = Schema.Struct({
  total_tokens: Schema.Number,
  input: Schema.Struct({
    total_tokens: Schema.Number,
    uncached_tokens: Schema.Number,
    cache_read_tokens: Schema.Number,
    cache_write_tokens: Schema.Number,
  }),
  output: Schema.Struct({ total_tokens: Schema.Number, reasoning_tokens: Schema.Number }),
  unclassified_tokens: Schema.Number,
});

/**
 * One request-log record (`rowToPayload` in `packages/models/src/usage/d1.ts`). Only the fields the panel reads are listed:
 * the payload carries more (`tokens`, `source`, `parent_session_id`, ...), and `Schema.Struct` ignores excess keys when
 * decoding.
 */
export const UsageRecord = Schema.Struct({
  /** ISO 8601 request time. */
  timestamp: Schema.String,
  latency_ms: Schema.Number,
  /** `0` when the request has no first-token time. */
  ttft_ms: Schema.Number,
  auth_index: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  alias: Schema.String,
  endpoint: Schema.String,
  /** The Access principal id of the caller (the Go client API key), not an upstream credential. */
  api_key: Schema.String,
  /** The caller's member id in the org; absent when they had none (or the record predates members). */
  member_id: optional(Schema.String),
  /** Served by one of the caller's private credentials (ADR 0023); only its owner reads such a record. */
  private: optional(Schema.Boolean),
  request_id: Schema.String,
  failed: Schema.Boolean,
  stream: Schema.Boolean,
  /**
   * `{status_code: 200}` for a successful request. A failed one carries the status code and the error's `type` and
   * `code` when the upstream gave them, never its body (ADR 0027).
   */
  fail: Schema.Struct({
    status_code: Schema.Number,
    type: optional(Schema.String),
    code: optional(Schema.String),
  }),
  /** Empty when none was requested. */
  reasoning_effort: Schema.String,
  service_tier: Schema.String,
  response_model: optional(Schema.String),
  session_id: optional(Schema.String),
  trace_id: optional(Schema.String),
  token_breakdown: tokenBreakdown,
  /** Micro-dollars the request cost; absent on a record written before costs existed. */
  cost_micros: optional(Schema.Number),
  /** The model had no price when the request was recorded (the cost is 0); absent with `cost_micros`. */
  unpriced: optional(Schema.Boolean),
  /** `tools` on a tool call's record (#199); absent on a model attempt's. The fields below come with it. */
  area: optional(UsageArea),
  toolkit_id: optional(Schema.String),
  /** The tool's stable id, `<toolkit id>:<upstream name>`. */
  tool_id: optional(Schema.String),
  outcome: optional(ToolCallRecordOutcome),
  /** Which of the toolkit's credentials served the call; absent when none did (`needs_credential`). */
  credential: optional(Schema.Literals(["shared", "private"])),
  /** Bytes of the call's arguments and of its result as JSON; never their content. */
  request_bytes: optional(Schema.Number),
  response_bytes: optional(Schema.Number),
  /** How an approval rule decided the call (#201); absent on a record from before approvals. */
  approval: optional(ToolCallApproval),
  /**
   * The browser toolkit's (#214): the browser time a Quick Action's call used, or, on the record a browser session
   * writes when it closes (no `tool_id`, no `outcome`), the session's from opening to closing, in milliseconds; its
   * `cost_micros` is what that time cost at the price per browser hour, prorated (0 without one).
   */
  browser_ms: optional(Schema.Number),
  /**
   * The sandbox toolkit's (#224): on the record a sandbox session writes when it closes (no `tool_id`, no `outcome`),
   * how long its computer ran, in milliseconds; its `cost_micros` is what that time cost at the price per computer
   * hour, prorated (0 without one).
   */
  computer_ms: optional(Schema.Number),
  /** The browser profile (#215) a browser session's record (#214) opened from; absent when it opened from none. */
  browser_profile_id: optional(Schema.String),
  /**
   * The agent run a record comes from (#228): its hosted agent, the run, and who started it (`member:<id>`). A private
   * agent's run's records are its member's alone (`private`).
   */
  agent_id: optional(Schema.String),
  run_id: optional(Schema.String),
  starter: optional(Schema.String),
});

export type UsageRecord = typeof UsageRecord.Type;

/**
 * Filters as for the summary (`since` inclusive, `until` exclusive); `limit` caps the page (default 100, at most 1000)
 * and `before` is the `next_before` cursor of the previous page.
 */
export const UsageRecordsQuery = Schema.Struct({
  since: optional(Schema.Number),
  until: optional(Schema.Number),
  provider: optional(Schema.String),
  model: optional(Schema.String),
  principal: optional(Schema.String),
  /** A member id of the org (`/members`). */
  member: optional(Schema.String),
  /** A team id of the org (`/teams`): the records of its members. */
  team: optional(Schema.String),
  auth_index: optional(Schema.String),
  failed: optional(Schema.Literals(["true", "false"])),
  limit: optional(Schema.Number),
  before: optional(Schema.String),
  ...areaFilters,
});

export type UsageRecordsQuery = typeof UsageRecordsQuery.Type;

/** Newest first; `next_before` is present only when more records follow. */
export const UsageRecordsPage = Schema.Struct({
  records: Schema.Array(UsageRecord),
  next_before: optional(Schema.String),
});

export type UsageRecordsPage = typeof UsageRecordsPage.Type;

/** The filters of the unpriced list: the time range, provider, model, user and account, as the summary's. */
export const UsageUnpricedQuery = Schema.Struct({
  since: optional(Schema.Number),
  until: optional(Schema.Number),
  provider: optional(Schema.String),
  model: optional(Schema.String),
  principal: optional(Schema.String),
  /** A member id of the org (`/members`). */
  member: optional(Schema.String),
  /** A team id of the org (`/teams`): the records of its members. */
  team: optional(Schema.String),
  auth_index: optional(Schema.String),
});

/** A provider and model pair with unpriced requests: what to give a price override. */
export const UnpricedModel = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  requests: Schema.Number,
  total_tokens: Schema.Number,
});

export type UnpricedModel = typeof UnpricedModel.Type;

/** The busiest first. */
export const UsageUnpriced = Schema.Struct({ models: Schema.Array(UnpricedModel) });

export type UsageUnpriced = typeof UsageUnpriced.Type;

export class UsageGroupApi extends HttpApiGroup.make("usage").add(
  HttpApiEndpoint.get("summary", "/observability/usage/summary", {
    query: UsageSummaryQuery,
    success: UsageSummary,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("series", "/observability/usage/series", {
    query: UsageSeriesQuery,
    success: UsageSeries,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("unpriced", "/observability/usage/unpriced", {
    query: UsageUnpricedQuery,
    success: UsageUnpriced,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("records", "/observability/usage/records", {
    query: UsageRecordsQuery,
    success: UsageRecordsPage,
    error: managementErrors,
  }),
) {}

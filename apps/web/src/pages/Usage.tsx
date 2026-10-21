// Usage: what Commissary served over a range (24 hours, 7 days, 30 days), narrowed by model, account, provider or
// user: the totals, tokens per hour or day, a breakdown whose rows narrow the page further, and the request log
// with each request's details. The area switch reads tool calls instead (#209, UsageTools.tsx), narrowed by toolkit,
// tool or user, with their outcome, approval, latency and cost; a call's arguments and results are never shown. The
// area, range, breakdown and filters live in the address, so a view can be linked to.
// A plain member sees their own requests only (the server narrows every read), without the account names, the
// unpriced models and the Prices page, which are for org admins.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { Fragment, useState } from "react";
import type { CredentialEntry } from "@commissary/contract/credentials";
import type { UsageGroup, UsageRecord, UsageSummary } from "@commissary/contract/usage";
import {
  credentialsAtom,
  membersAtom,
  nowAtom,
  teamsAtom,
  type UsageView,
  usageRecordsAtom,
  usageSeriesAtom,
  usageSummaryAtom,
  usageUnpricedAtom,
  apiKeysAtom,
} from "../api/client.ts";
import { HistoryChart } from "../components/HistoryChart.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { RetentionNote } from "../components/RetentionNote.tsx";
import { TrailMark } from "../components/Signs.tsx";
import { accountName } from "../lib/accounts.ts";
import { failureMessage } from "../lib/failure.ts";
import {
  formatClock,
  formatCost,
  formatCount,
  formatDay,
  formatLatency,
  formatMoment,
  formatTokens,
} from "../lib/format.ts";
import type { HistoryBar } from "../lib/history.ts";
import { providerName } from "../lib/providers.ts";
import { canManageMembers } from "../lib/role.ts";
import { useRole } from "../lib/use-role.ts";
import {
  activeFilters,
  AREAS,
  areaOf,
  type Breakdown,
  breakdownOf,
  breakdownsFor,
  FILTER_LABELS,
  type FilterKey,
  filtersFor,
  RANGES,
  type Range,
  rangeBars,
  rangeOf,
  type UsageFilters,
  readUsageSearch,
  type UsageSearch,
} from "../lib/usage.ts";
import { toolkitIdOf, upstreamNameOf } from "../lib/tool-id.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { type ToolNames, ToolLog, ToolSummary, useToolkitNames } from "./UsageTools.tsx";
import styles from "./Usage.module.css";

// ---------------------------------------------------------------------------------------------------------------
// Names

/** Accounts by auth index (summary keys, records and the account filter), to name them. */
interface Names {
  readonly byIndex: ReadonlyMap<string, CredentialEntry>;
  /** Member emails by member id. */
  readonly members: ReadonlyMap<string, string>;
  /** Team names by team id. */
  readonly teams: ReadonlyMap<string, string>;
  /** API key names by key id. */
  readonly keys: ReadonlyMap<string, string>;
  /** Toolkit names by toolkit id: those the caller reaches. */
  readonly toolkits: ReadonlyMap<string, string>;
}

/** API keys by id: a plain member lists their own, an org admin every key. */
const useKeyNames = (): ReadonlyMap<string, string> => {
  const result = useAtomValue(apiKeysAtom);
  const keys = AsyncResult.isSuccess(result) ? result.value.keys : [];

  return new Map(keys.map((key) => [key.id, key.name]));
};

const useNames = (): Names => {
  const result = useAtomValue(credentialsAtom);
  const people = useAtomValue(membersAtom);
  const groups = useAtomValue(teamsAtom);
  const files = AsyncResult.isSuccess(result) ? result.value.files : [];
  const members = AsyncResult.isSuccess(people) ? people.value.members : [];
  const teams = AsyncResult.isSuccess(groups) ? groups.value.teams : [];
  const keys = useKeyNames();
  const toolkits = useToolkitNames();

  return {
    keys,
    toolkits,
    byIndex: new Map(files.map((entry) => [entry.auth_index, entry])),
    members: new Map(members.map((member) => [member.id, member.email])),
    teams: new Map(teams.map((team) => [team.id, team.name])),
  };
};

/** A plain member may not read the accounts, members or teams: only their own API keys are named. */
const NO_NAMES: Omit<Names, "keys" | "toolkits"> = {
  byIndex: new Map(),
  members: new Map(),
  teams: new Map(),
};

/** A breakdown row's or filter's value as the operator knows it. */
const valueName = (key: FilterKey | Breakdown["id"], value: string, names: Names): string => {
  switch (key) {
    case "model":
      return value === "" ? "Unknown model" : value;
    case "account":
    case "auth": {
      const entry = names.byIndex.get(value);

      return entry === undefined ? value || "Unknown account" : accountName(entry);
    }

    case "provider":
      return value === "" ? "Unknown provider" : providerName(value);
    case "member":
      return value === "" ? "No member" : (names.members.get(value) ?? value);
    case "team":
      return names.teams.get(value) ?? value;
    case "key":
      return value === "" ? "No API key" : (names.keys.get(value) ?? value);
    case "user":
    case "principal":
      return value === "" ? "Unknown user" : value;
    case "endpoint":
      return value === "" ? "Unknown endpoint" : value;
    case "toolkit":
      return value === "" ? "Unknown toolkit" : (names.toolkits.get(value) ?? value);
    case "tool": {
      const toolkit = names.toolkits.get(toolkitIdOf(value));
      const tool = upstreamNameOf(value);

      return toolkit === undefined ? tool : `${toolkit} · ${tool}`;
    }
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Address

const filtersOf = (search: UsageSearch): UsageFilters => ({
  model: search.model,
  provider: search.provider,
  account: search.account,
  user: search.user,
  member: search.member,
  team: search.team,
  toolkit: search.toolkit,
  tool: search.tool,
});

const useUsageSearch = () => {
  const search = useSearch({ from: "/usage" });
  const navigate = useNavigate({ from: "/usage" });

  /** Sets parameters; `undefined` removes one. */
  const update = (change: { readonly [K in keyof UsageSearch]?: UsageSearch[K] | undefined }) =>
    void navigate({
      search: (previous: UsageSearch) => readUsageSearch({ ...previous, ...change }),
      replace: true,
      resetScroll: false,
    });

  return { search, update };
};

// ---------------------------------------------------------------------------------------------------------------
// Totals and chart

/** A label, its figure, and whether the figure is bad news (red). */
type Figure = readonly [string, string, boolean?];

const Figures = ({
  figures,
  className,
}: {
  readonly figures: ReadonlyArray<Figure>;
  readonly className: string | undefined;
}) => (
  <dl className={className}>
    {figures.map(([label, value, bad]) => (
      <div key={label}>
        <dt>{label}</dt>
        <dd data-bad={bad === true}>{value}</dd>
      </div>
    ))}
  </dl>
);

const Totals = ({ summary }: { readonly summary: UsageSummary }) => {
  const { totals } = summary;

  const headline: ReadonlyArray<Figure> = [
    ["Requests", formatCount(totals.requests)],
    ["Failed", formatCount(totals.failed), totals.failed > 0],
    ["Tokens", formatTokens(totals.total_tokens)],
    ["Cost", formatCost(totals.cost_micros)],
  ];

  const details: ReadonlyArray<Figure> = [
    ["Unpriced requests", formatCount(totals.unpriced_requests), totals.unpriced_requests > 0],
    ["Input", formatTokens(totals.input_tokens)],
    ["Output", formatTokens(totals.output_tokens)],
    ["Cache read", formatTokens(totals.cache_read_tokens)],
    ["Average latency", totals.requests === 0 ? "None" : formatLatency(totals.avg_latency_ms)],
    [
      "Average first token",
      totals.avg_ttft_ms === null ? "Not measured" : formatLatency(totals.avg_ttft_ms),
    ],
  ];

  return (
    <div className={styles["totals"]}>
      <Figures figures={headline} className={styles["headline"]} />
      <Figures figures={details} className={styles["details"]} />
    </div>
  );
};

const barPeriod = (range: Range) => (bar: HistoryBar) =>
  range.bar === "hour"
    ? `${formatDay(bar.start)}, ${formatClock(bar.start).replace(/^\w+ /, "")}`
    : formatDay(bar.start);

const Chart = ({ view, range }: { readonly view: UsageView; readonly range: Range }) => {
  const result = useAtomValue(usageSeriesAtom(view));

  if (view.filters.user !== undefined) {
    return (
      <p className={kit["muted"]}>
        No chart for a single user: hourly totals are not kept per user. The totals and tables below
        are for this user only.
      </p>
    );
  }

  return AsyncResult.match(result, {
    onInitial: () => <div className={styles["chartSpace"]} aria-busy="true" />,
    onFailure: (failure) => <Problem>Could not load the chart. {failureMessage(failure)}</Problem>,
    onSuccess: ({ value }) => (
      <HistoryChart
        title={range.bar === "hour" ? "Tokens per hour" : "Tokens per day"}
        bars={rangeBars(range, value.points, value.now)}
        period={barPeriod(range)}
        currentLabel={range.bar === "hour" ? "This hour" : "Today"}
      />
    ),
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Breakdown

const BreakdownTable = ({
  summary,
  breakdown,
  names,
  narrowed,
  onNarrow,
}: {
  readonly summary: UsageSummary;
  readonly breakdown: Breakdown;
  readonly names: Names;
  /** The breakdown's own filter is set: rows cannot narrow further. */
  readonly narrowed: boolean;
  readonly onNarrow: (group: UsageGroup) => void;
}) => {
  const largest = Math.max(1, ...summary.groups.map((group) => group.total_tokens));
  const canNarrow = breakdown.filter !== undefined && !narrowed;

  return (
    <table className={`${styles["table"]} ${styles["breakdown"]}`}>
      <caption className={kit["visuallyHidden"]}>Usage by {breakdown.noun.toLowerCase()}</caption>
      <thead>
        <tr>
          <th scope="col">{breakdown.noun}</th>
          <th scope="col" className={styles["number"]}>
            Requests
          </th>
          <th scope="col" className={styles["number"]}>
            Failed
          </th>
          <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
            Input
          </th>
          <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
            Output
          </th>
          <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
            Cache read
          </th>
          <th scope="col" className={styles["number"]}>
            Tokens
          </th>
          <th scope="col" className={styles["number"]}>
            Cost
          </th>
          <th scope="col" className={styles["shareHead"]}>
            <span className={kit["visuallyHidden"]}>Share of tokens</span>
          </th>
          <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
            Average latency
          </th>
        </tr>
      </thead>
      <tbody>
        {summary.groups.map((group) => {
          const name = valueName(breakdown.id, group.key, names);

          return (
            <tr key={group.key}>
              <th scope="row" className={styles["name"]}>
                {canNarrow ? (
                  <button
                    type="button"
                    className={styles["narrow"]}
                    title={`Show only ${name}`}
                    onClick={() => onNarrow(group)}
                  >
                    {name}
                  </button>
                ) : (
                  name
                )}
              </th>
              <td className={styles["number"]}>{formatCount(group.requests)}</td>
              <td className={styles["number"]} data-bad={group.failed > 0}>
                {formatCount(group.failed)}
              </td>
              <td className={`${styles["number"]} ${styles["wide"]}`}>
                {formatTokens(group.input_tokens)}
              </td>
              <td className={`${styles["number"]} ${styles["wide"]}`}>
                {formatTokens(group.output_tokens)}
              </td>
              <td className={`${styles["number"]} ${styles["wide"]}`}>
                {formatTokens(group.cache_read_tokens)}
              </td>
              <td className={styles["number"]}>{formatTokens(group.total_tokens)}</td>
              <td className={styles["number"]}>
                {formatCost(group.cost_micros)}
                {group.unpriced_requests > 0 ? (
                  <span className={styles["unpricedNote"]}>
                    {formatCount(group.unpriced_requests)} unpriced
                  </span>
                ) : null}
              </td>
              <td className={styles["share"]} aria-hidden="true">
                <span style={{ width: `${(group.total_tokens / largest) * 100}%` }} />
              </td>
              <td className={`${styles["number"]} ${styles["wide"]}`}>
                {formatLatency(group.avg_latency_ms)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/** Models served without a price cost nothing in the totals: say so, and send the operator to price them. */
const Unpriced = ({ view }: { readonly view: UsageView }) => {
  const result = useAtomValue(usageUnpricedAtom(view));

  if (!AsyncResult.isSuccess(result) || result.value.models.length === 0) return null;
  const { models } = result.value;
  const shown = models.slice(0, UNPRICED_SHOWN);
  const more = models.length - shown.length;

  return (
    <section className={styles["unpriced"]} aria-label="Unpriced models">
      <p className={styles["unpricedTitle"]}>
        <TrailMark />
        {models.length === 1 ? "A model has" : `${formatCount(models.length)} models have`} no
        price, so its requests count as $0.00
      </p>
      <ul className={styles["unpricedList"]}>
        {shown.map((model) => (
          <li key={`${model.provider}/${model.model}`}>
            <span>
              {providerName(model.provider)} · {model.model === "" ? "Unknown model" : model.model}
              <span className={styles["secondary"]}>
                {formatCount(model.requests)} {model.requests === 1 ? "request" : "requests"}
              </span>
            </span>
            <Link
              to="/usage/prices"
              search={{ provider: model.provider, model: model.model }}
              className={kit["sectionLink"]}
            >
              Add a price
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <p className={styles["hint"]}>
          And {formatCount(more)} more. Open <Link to="/usage/prices">Prices</Link> to add them.
        </p>
      ) : null}
      <p className={styles["hint"]}>
        A price applies to requests from then on; requests already recorded keep their cost.
      </p>
    </section>
  );
};

/** Unpriced models listed before "and N more". */
const UNPRICED_SHOWN = 5;

/** Totals, chart and breakdown: one summary request feeds the totals and the table. */
const Summary = ({
  view,
  range,
  breakdown,
  names,
  admin,
  onBreakdown,
  onNarrow,
}: {
  readonly view: UsageView;
  readonly range: Range;
  readonly breakdown: Breakdown;
  readonly names: Names;
  /** Whether the caller is an org admin: the unpriced models are theirs to price. */
  readonly admin: boolean;
  readonly onBreakdown: (by: Breakdown["id"]) => void;
  readonly onNarrow: (key: FilterKey, value: string) => void;
}) => {
  const atom = usageSummaryAtom({ view, by: breakdown.id });
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const narrowed = breakdown.filter !== undefined && view.filters[breakdown.filter] !== undefined;

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading usage…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load usage. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value, waiting }) => (
      <>
        <section className={styles["overview"]} aria-label="Totals" aria-busy={waiting}>
          <Totals summary={value} />
          <div className={styles["chart"]}>
            <Chart view={view} range={range} />
          </div>
        </section>
        {admin ? <Unpriced view={view} /> : null}
        <Section title="Breakdown">
          <div className={styles["breakdownTabs"]}>
            <div className={kit["tabs"]} role="radiogroup" aria-label="Break down by">
              {breakdownsFor(admin).map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  role="radio"
                  aria-checked={candidate.id === breakdown.id}
                  className={kit["tab"]}
                  onClick={() => onBreakdown(candidate.id)}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
          </div>
          {value.groups.length === 0 ? (
            <p className={kit["muted"]}>No requests in this range.</p>
          ) : (
            <>
              <BreakdownTable
                summary={value}
                breakdown={breakdown}
                names={names}
                narrowed={narrowed}
                onNarrow={(group) => {
                  if (breakdown.filter !== undefined) onNarrow(breakdown.filter, group.key);
                }}
              />
              {breakdown.filter !== undefined && !narrowed ? (
                <p className={styles["hint"]}>
                  Choose a row to narrow the page to that {breakdown.noun.toLowerCase()}.
                </p>
              ) : null}
            </>
          )}
        </Section>
      </>
    ),
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Request log

/** What a request cost as recorded; requests from before costs were kept have none. */
const recordCost = (record: UsageRecord): string => {
  if (record.unpriced === true) return "No price, counted as $0.00";

  return record.cost_micros === undefined ? "Not recorded" : formatCost(record.cost_micros);
};

const Detail = ({ record }: { readonly record: UsageRecord }) => {
  const breakdown = record.token_breakdown;

  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Request", record.request_id],
    ["Endpoint", record.endpoint],
    ["Provider", providerName(record.provider)],
    ...(record.alias !== "" && record.alias !== record.model
      ? [["Asked for", record.alias] as const]
      : []),
    ...(record.response_model === undefined || record.response_model === record.model
      ? []
      : [["Answered by", record.response_model] as const]),
    ["Streamed", record.stream ? "Yes" : "No"],
    ["First token", record.ttft_ms > 0 ? formatLatency(record.ttft_ms) : "Not measured"],
    ["Input", formatCount(breakdown.input.total_tokens)],
    ["Cache read", formatCount(breakdown.input.cache_read_tokens)],
    ["Cache write", formatCount(breakdown.input.cache_write_tokens)],
    ["Output", formatCount(breakdown.output.total_tokens)],
    ["Reasoning", formatCount(breakdown.output.reasoning_tokens)],
    ["Cost", recordCost(record)],
    ...(record.reasoning_effort === "" ? [] : [["Effort", record.reasoning_effort] as const]),
    ...(record.service_tier === "" ? [] : [["Service tier", record.service_tier] as const]),
    ...(record.session_id === undefined ? [] : [["Session", record.session_id] as const]),
  ];

  return (
    <div className={styles["detail"]}>
      <dl className={styles["facts"]}>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {record.failed ? (
        <div className={styles["failure"]}>
          <p className={styles["failureTitle"]}>
            <TrailMark />
            The provider answered HTTP {record.fail.status_code}
          </p>
          {record.fail.type === undefined && record.fail.code === undefined ? null : (
            <pre>
              {[
                record.fail.type === undefined ? undefined : `type: ${record.fail.type}`,
                record.fail.code === undefined ? undefined : `code: ${record.fail.code}`,
              ]
                .filter((line) => line !== undefined)
                .join("\n")}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
};

const RecordRow = ({
  record,
  names,
  now,
}: {
  readonly record: UsageRecord;
  readonly names: Names;
  readonly now: number;
}) => {
  const [open, setOpen] = useState(false);
  const at = Date.parse(record.timestamp);
  const entry = names.byIndex.get(record.auth_index);
  const detailId = `request-${record.request_id}`;
  const tokens = record.token_breakdown;

  return (
    <>
      <tr className={styles["record"]} data-open={open}>
        <td className={styles["when"]}>
          <button
            type="button"
            className={styles["expand"]}
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen(!open)}
          >
            {open ? (
              <ChevronDown aria-hidden="true" size={16} strokeWidth={2.25} />
            ) : (
              <ChevronRight aria-hidden="true" size={16} strokeWidth={2.25} />
            )}
            <time dateTime={record.timestamp}>{formatMoment(at, now)}</time>
          </button>
        </td>
        <td className={styles["what"]}>{record.model === "" ? "Unknown model" : record.model}</td>
        <td className={styles["who"]}>
          <span className={styles["accountName"]}>
            {entry === undefined ? "Removed account" : accountName(entry)}
          </span>
          <span className={styles["secondary"]}>{record.api_key}</span>
        </td>
        <td className={styles["number"]}>
          <span className={styles["tokens"]}>{formatTokens(tokens.total_tokens)}</span>
          {tokens.total_tokens === 0 ? null : (
            <span className={styles["secondary"]}>
              {formatTokens(tokens.input.total_tokens)} in,{" "}
              {formatTokens(tokens.output.total_tokens)} out
            </span>
          )}
        </td>
        <td className={`${styles["number"]} ${styles["latency"]}`}>
          {formatLatency(record.latency_ms)}
        </td>
        <td className={styles["result"]} data-failed={record.failed}>
          {record.failed ? (
            <span className={styles["failedResult"]}>
              <TrailMark />
              HTTP {record.fail.status_code}
            </span>
          ) : (
            "OK"
          )}
        </td>
      </tr>
      {open ? (
        <tr className={styles["detailRow"]} id={detailId}>
          <td colSpan={6}>
            <Detail record={record} />
          </td>
        </tr>
      ) : null}
    </>
  );
};

/** A log body holding one line: loading, a problem, or nothing to show. */
const message = (content: React.ReactNode) => (
  <tbody>
    <tr className={styles["message"]}>
      <td colSpan={6}>{content}</td>
    </tr>
  </tbody>
);

/** One page of the log as its own table body; the last page offers the next. */
const LogPage = ({
  view,
  failedOnly,
  before,
  last,
  names,
  onMore,
  onEmpty,
}: {
  readonly view: UsageView;
  readonly failedOnly: boolean;
  readonly before: string | undefined;
  readonly last: boolean;
  readonly names: Names;
  readonly onMore: (next: string) => void;
  readonly onEmpty: () => React.ReactNode;
}) => {
  const atom = usageRecordsAtom({ view, failedOnly, before });
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const now = useAtomValue(nowAtom);

  return AsyncResult.match(result, {
    onInitial: () =>
      message(
        <span className={kit["muted"]} aria-busy="true">
          Loading requests…
        </span>,
      ),
    onFailure: (failure) =>
      message(
        <Problem onRetry={retry}>Could not load requests. {failureMessage(failure)}</Problem>,
      ),
    onSuccess: ({ value }) => {
      if (value.records.length === 0 && before === undefined) return message(onEmpty());
      const next = value.next_before;

      return (
        <tbody>
          {value.records.map((record) => (
            <RecordRow key={record.request_id} record={record} names={names} now={now} />
          ))}
          {last && next !== undefined ? (
            <tr className={styles["message"]}>
              <td colSpan={6}>
                <button type="button" className={kit["secondary"]} onClick={() => onMore(next)}>
                  Show older requests
                </button>
              </td>
            </tr>
          ) : null}
        </tbody>
      );
    },
  });
};

const Log = ({
  view,
  failedOnly,
  names,
  onFailedOnly,
}: {
  readonly view: UsageView;
  readonly failedOnly: boolean;
  readonly names: Names;
  readonly onFailedOnly: (failedOnly: boolean) => void;
}) => {
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const pages: ReadonlyArray<string | undefined> = [undefined, ...cursors];

  return (
    <Section title="Requests">
      <div className={styles["logTabs"]}>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Show">
          {(
            [
              [false, "All"],
              [true, "Failed"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={failedOnly === value}
              className={kit["tab"]}
              onClick={() => onFailedOnly(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className={styles["mobileKey"]} aria-hidden="true">
        Figures on the right: tokens, then latency.
      </p>
      <table className={`${styles["table"]} ${styles["log"]}`}>
        <caption className={kit["visuallyHidden"]}>Requests, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Model</th>
            <th scope="col">Account and user</th>
            <th scope="col" className={styles["number"]}>
              Tokens
            </th>
            <th scope="col" className={`${styles["number"]} ${styles["latency"]}`}>
              Latency
            </th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        {pages.map((before, index) => (
          <LogPage
            key={before ?? "first"}
            view={view}
            failedOnly={failedOnly}
            before={before}
            last={index === pages.length - 1}
            names={names}
            onMore={(next) => setCursors([...cursors, next])}
            onEmpty={() => (
              <span className={kit["muted"]}>
                {failedOnly ? "No failed requests in this range." : "No requests in this range."}
              </span>
            )}
          />
        ))}
      </table>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Page

const UsageContent = ({ names, admin }: { readonly names: Names; readonly admin: boolean }) => {
  usePageTitle("Usage");
  const { search, update } = useUsageSearch();
  const range = rangeOf(search.range);
  const area = areaOf(search.area);
  const breakdowns = breakdownsFor(admin, area);
  const breakdown = breakdownOf(search.by, breakdowns);
  const filters = filtersFor(filtersOf(search), area);
  const view: UsageView = { range: range.id, area, filters };
  const failedOnly = search.failed === true;
  const active = activeFilters(filters);
  // The log starts over from its first page whenever what it shows changes.
  const logKey = JSON.stringify([view, failedOnly]);

  const toolNames: ToolNames = {
    toolkits: names.toolkits,
    valueName: (key, value) => valueName(key, value, names),
  };

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <div className={styles["titleRow"]}>
          <h1 className={styles["title"]}>Usage</h1>
          {admin ? (
            <Link to="/usage/prices" className={kit["sectionLink"]}>
              Prices
            </Link>
          ) : null}
        </div>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Area">
          {AREAS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={candidate.id === area}
              className={kit["tab"]}
              onClick={() =>
                candidate.id === area
                  ? undefined
                  : // Another area reads other filters and groupings: start it afresh, keeping the range and who.
                    update({
                      area: candidate.id === "tools" ? "tools" : undefined,
                      by: undefined,
                      failed: undefined,
                      ...Object.fromEntries(
                        active
                          .filter(({ key }) => filtersFor(filters, candidate.id)[key] === undefined)
                          .map(({ key }) => [key, undefined]),
                      ),
                    })
              }
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Range">
          {RANGES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={candidate.id === range.id}
              className={kit["tab"]}
              onClick={() => update({ range: candidate.id })}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        {area === "tools" && names.toolkits.size > 0 ? (
          <select
            className={styles["teamPick"]}
            aria-label="Toolkit"
            value={filters.toolkit ?? ""}
            onChange={(event) =>
              update({ toolkit: event.target.value || undefined, tool: undefined })
            }
          >
            <option value="">All toolkits</option>
            {[...names.toolkits].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
        {admin && names.teams.size > 0 ? (
          <select
            className={styles["teamPick"]}
            aria-label="Team"
            value={filters.team ?? ""}
            onChange={(event) => update({ team: event.target.value || undefined })}
          >
            <option value="">All teams</option>
            {[...names.teams].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
        <RetentionNote className={styles["retention"]} />
      </header>
      {active.length === 0 ? null : (
        <div className={styles["filters"]} aria-label="Narrowed to">
          <span className={styles["filtersLabel"]}>Narrowed to</span>
          {active.map(({ key, value }) => (
            <button
              key={key}
              type="button"
              className={styles["chip"]}
              aria-label={`Remove ${FILTER_LABELS[key].toLowerCase()} ${valueName(key, value, names)}`}
              onClick={() => update({ [key]: undefined })}
            >
              <span className={styles["chipKey"]}>{FILTER_LABELS[key]}</span>
              {valueName(key, value, names)}
              <X aria-hidden="true" size={14} strokeWidth={2.5} />
            </button>
          ))}
          {filters.account === undefined || !names.byIndex.has(filters.account) ? null : (
            <Link
              to="/accounts/$authIndex"
              params={{ authIndex: filters.account }}
              className={kit["sectionLink"]}
            >
              Open the account
            </Link>
          )}
        </div>
      )}
      {area === "tools" ? (
        <>
          <ToolSummary
            view={view}
            breakdown={breakdown}
            breakdowns={breakdowns}
            names={toolNames}
            onBreakdown={(by) => update({ by })}
            onNarrow={(key, value) => update({ [key]: value })}
          />
          <Fragment key={logKey}>
            <ToolLog
              view={view}
              failedOnly={failedOnly}
              names={toolNames}
              onFailedOnly={(value) => update({ failed: value ? true : undefined })}
            />
          </Fragment>
        </>
      ) : (
        <>
          <Summary
            view={view}
            range={range}
            breakdown={breakdown}
            names={names}
            admin={admin}
            onBreakdown={(by) => update({ by })}
            onNarrow={(key, value) => update({ [key]: value })}
          />
          <Fragment key={logKey}>
            <Log
              view={view}
              failedOnly={failedOnly}
              names={names}
              onFailedOnly={(value) => update({ failed: value ? true : undefined })}
            />
          </Fragment>
        </>
      )}
    </div>
  );
};

const MemberUsage = () => {
  const keys = useKeyNames();

  const toolkits = useToolkitNames();

  return <UsageContent names={{ ...NO_NAMES, keys, toolkits }} admin={false} />;
};

const OrgAdminUsage = () => {
  const names = useNames();

  return <UsageContent names={names} admin />;
};

/** The page; an org admin's page names the accounts, a plain member's never asks for them. */
export const UsagePage = () => {
  const role = useRole();

  if (role.kind !== "ready") return null;

  return canManageMembers(role.caller) ? <OrgAdminUsage /> : <MemberUsage />;
};

// The Usage page's ranges, breakdowns and filters, and the bars of its chart, over the D1 usage history
// (`GET /observability/usage/summary|series|records`). Pure: no DOM, tested in test/usage.test.ts.
import { Effect, flow, Option, Schema } from "effect";
import type { UsageGroupBy, UsagePoint } from "@commissary/contract/usage";
import { dailyHistory, type HistoryBar } from "./history.ts";

const HOUR_MS = 3_600_000;

export type RangeId = "day" | "week" | "month";

export interface Range {
  readonly id: RangeId;
  readonly label: string;
  /** What one bar of the chart covers. */
  readonly bar: "hour" | "day";
  /** How many bars, the one in progress last. */
  readonly bars: number;
}

export const RANGES: ReadonlyArray<Range> = [
  { id: "day", label: "24 hours", bar: "hour", bars: 24 },
  { id: "week", label: "7 days", bar: "day", bars: 7 },
  { id: "month", label: "30 days", bar: "day", bars: 30 },
];

export const DEFAULT_RANGE: Range = { id: "day", label: "24 hours", bar: "hour", bars: 24 };

export const rangeOf = (id: string | undefined): Range =>
  RANGES.find((range) => range.id === id) ?? DEFAULT_RANGE;

/** Bars per clock hour for the last `hours` hours, the hour in progress last. */
export const hourlyHistory = (
  points: ReadonlyArray<UsagePoint>,
  hours: number,
  now: number,
): ReadonlyArray<HistoryBar> => {
  const current = Math.floor(now / HOUR_MS) * HOUR_MS;

  return Array.from({ length: hours }, (_, index) => {
    const start = current - (hours - 1 - index) * HOUR_MS;
    const end = start + HOUR_MS;
    const inside = points.filter((point) => point.start >= start && point.start < end);

    return {
      start,
      end,
      current: index === hours - 1,
      tokens: inside.reduce((sum, point) => sum + point.total_tokens, 0),
      requests: inside.reduce((sum, point) => sum + point.requests, 0),
    };
  });
};

/** The chart's bars for a range: hours for the last day, local days otherwise. */
export const rangeBars = (
  range: Range,
  points: ReadonlyArray<UsagePoint>,
  now: number,
): ReadonlyArray<HistoryBar> =>
  range.bar === "hour"
    ? hourlyHistory(points, range.bars, now)
    : dailyHistory(points, range.bars, now);

/**
 * Where a range starts (epoch ms), the start of its first bar, so the totals, the breakdown and the chart cover the
 * same time.
 */
export const rangeStart = (range: Range, now: number): number =>
  rangeBars(range, [], now)[0]?.start ?? now;

/** Every series' points summed per bucket start, in time order. */
export const mergePoints = (
  series: ReadonlyArray<{ readonly points: ReadonlyArray<UsagePoint> }>,
): ReadonlyArray<UsagePoint> => {
  const byStart = new Map<number, UsagePoint>();

  for (const point of series.flatMap((entry) => entry.points)) {
    const seen = byStart.get(point.start);

    byStart.set(
      point.start,
      seen === undefined
        ? point
        : {
            start: point.start,
            requests: seen.requests + point.requests,
            failed: seen.failed + point.failed,
            total_tokens: seen.total_tokens + point.total_tokens,
            cost_micros: seen.cost_micros + point.cost_micros,
          },
    );
  }

  return [...byStart.values()].toSorted((a, b) => a.start - b.start);
};

/**
 * What the page reads (#209): the model attempts Models writes, or the tool calls Tools writes. A unified view across
 * the two is not offered (the map's fog), so the page shows one at a time.
 */
export type UsageArea = "models" | "tools";

export const AREAS: ReadonlyArray<{ readonly id: UsageArea; readonly label: string }> = [
  { id: "models", label: "Model requests" },
  { id: "tools", label: "Tool calls" },
];

export const areaOf = (id: string | undefined): UsageArea => (id === "tools" ? "tools" : "models");

/** What the usage is narrowed to; every page part (totals, chart, breakdown, log) applies the same filters. */
export interface UsageFilters {
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  /** A credential's `auth_index`. */
  readonly account?: string | undefined;
  /** An Access principal. */
  readonly user?: string | undefined;
  /** A member id of the org (`/members`). */
  readonly member?: string | undefined;
  /** A team id of the org (`/teams`): the records of its members. */
  readonly team?: string | undefined;
  /** A toolkit's id: its tool calls (the Tool calls area). */
  readonly toolkit?: string | undefined;
  /** A tool's stable id, `<toolkit id>:<upstream name>`: its calls (the Tool calls area). */
  readonly tool?: string | undefined;
}

export type FilterKey = keyof UsageFilters;

/** The filters each area reads: a model attempt has no toolkit or tool, and a tool call no model, provider or account. */
const AREA_FILTERS: Readonly<Record<UsageArea, ReadonlyArray<FilterKey>>> = {
  models: ["model", "account", "provider", "user", "member", "team"],
  tools: ["toolkit", "tool", "user", "member", "team"],
};

/** The filters of `filters` that the area reads: the others are dropped when the area changes. */
export const filtersFor = (filters: UsageFilters, area: UsageArea): UsageFilters =>
  Object.fromEntries(
    AREA_FILTERS[area].flatMap((key) => (filters[key] === undefined ? [] : [[key, filters[key]]])),
  );

export interface Breakdown {
  /** The page's breakdowns, by the area it reads: a grouping by area is a unified view, which is not offered. */
  readonly id: Exclude<UsageGroupBy, "day" | "area">;
  readonly label: string;
  /** The column heading. */
  readonly noun: string;
  /** The filter a row narrows to; endpoints cannot be filtered. */
  readonly filter: FilterKey | undefined;
  /** Whether only an org admin sees it: a plain member's usage is theirs alone, and they may not read the accounts. */
  readonly adminOnly: boolean;
}

export const BREAKDOWNS: ReadonlyArray<Breakdown> = [
  { id: "model", label: "Model", noun: "Model", filter: "model", adminOnly: false },
  { id: "auth", label: "Account", noun: "Account", filter: "account", adminOnly: true },
  { id: "provider", label: "Provider", noun: "Provider", filter: "provider", adminOnly: false },
  { id: "member", label: "Member", noun: "Member", filter: "member", adminOnly: true },
  { id: "team", label: "Team", noun: "Team", filter: "team", adminOnly: true },
  { id: "key", label: "API key", noun: "API key", filter: undefined, adminOnly: false },
  { id: "principal", label: "User", noun: "User", filter: "user", adminOnly: true },
  { id: "endpoint", label: "Endpoint", noun: "Endpoint", filter: undefined, adminOnly: false },
];

/** The breakdowns of tool calls (#209): by toolkit and tool, then by who made them. */
export const TOOL_BREAKDOWNS: ReadonlyArray<Breakdown> = [
  { id: "toolkit", label: "Toolkit", noun: "Toolkit", filter: "toolkit", adminOnly: false },
  { id: "tool", label: "Tool", noun: "Tool", filter: "tool", adminOnly: false },
  { id: "member", label: "Member", noun: "Member", filter: "member", adminOnly: true },
  { id: "team", label: "Team", noun: "Team", filter: "team", adminOnly: true },
  { id: "key", label: "API key", noun: "API key", filter: undefined, adminOnly: false },
  { id: "principal", label: "User", noun: "User", filter: "user", adminOnly: true },
];

/** The breakdowns a caller is offered for an area (model attempts unless it says otherwise). */
export const breakdownsFor = (
  admin: boolean,
  area: UsageArea = "models",
): ReadonlyArray<Breakdown> =>
  (area === "tools" ? TOOL_BREAKDOWNS : BREAKDOWNS).filter(
    (breakdown) => admin || !breakdown.adminOnly,
  );

export const DEFAULT_BREAKDOWN: Breakdown = {
  id: "model",
  label: "Model",
  noun: "Model",
  filter: "model",
  adminOnly: false,
};

/** The breakdown an address names, among those on offer (every one unless `offered` narrows them), else the first. */
export const breakdownOf = (
  id: string | undefined,
  offered: ReadonlyArray<Breakdown> = BREAKDOWNS,
): Breakdown => offered.find((breakdown) => breakdown.id === id) ?? offered[0] ?? DEFAULT_BREAKDOWN;

export const FILTER_LABELS: Readonly<Record<FilterKey, string>> = {
  model: "Model",
  account: "Account",
  provider: "Provider",
  user: "User",
  member: "Member",
  team: "Team",
  toolkit: "Toolkit",
  tool: "Tool",
};

/** The filters as management API query parameters (model attempts, which the API reads unless it is told another area). */
export const filterQuery = (filters: UsageFilters) => ({
  ...(filters.model === undefined ? {} : { model: filters.model }),
  ...(filters.provider === undefined ? {} : { provider: filters.provider }),
  ...(filters.account === undefined ? {} : { auth_index: filters.account }),
  ...(filters.user === undefined ? {} : { principal: filters.user }),
  ...(filters.member === undefined ? {} : { member: filters.member }),
  ...(filters.team === undefined ? {} : { team: filters.team }),
});

/**
 * The tool calls' filters as query parameters (#209): `area=tools`, the toolkit and tool, and who made the calls. A
 * model, provider or account filter means nothing to a tool call, so none is sent.
 */
export const toolFilterQuery = (filters: UsageFilters) => ({
  area: "tools" as const,
  ...(filters.toolkit === undefined ? {} : { toolkit: filters.toolkit }),
  ...(filters.tool === undefined ? {} : { tool: filters.tool }),
  ...(filters.user === undefined ? {} : { principal: filters.user }),
  ...(filters.member === undefined ? {} : { member: filters.member }),
  ...(filters.team === undefined ? {} : { team: filters.team }),
});

/** The query of the area the page reads: for the totals, the breakdown and the log, which both areas have. */
export const areaFilterQuery = (filters: UsageFilters, area: UsageArea) =>
  area === "tools" ? toolFilterQuery(filters) : filterQuery(filters);

/** The filters that are set, in a fixed order. */
export const activeFilters = (
  filters: UsageFilters,
): ReadonlyArray<{ readonly key: FilterKey; readonly value: string }> =>
  (["toolkit", "tool", "model", "account", "provider", "user", "member", "team"] as const).flatMap(
    (key) => {
      const value = filters[key];

      return value === undefined ? [] : [{ key, value }];
    },
  );

/** A parameter that is dropped, rather than failing the whole address, when its value is malformed. */
export const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

/**
 * The page's address: `/usage?range=week&area=tools&toolkit=…&tool=…&by=auth&model=…&account=…&provider=…&user=…&member=…&team=…&failed=true`. A malformed
 * parameter is dropped on its own; the others still apply.
 */
export const UsageSearch = Schema.Struct({
  range: lenient(Schema.Literals(["day", "week", "month"])),
  area: lenient(Schema.Literals(["models", "tools"])),
  by: lenient(
    Schema.Literals([
      "model",
      "auth",
      "provider",
      "member",
      "team",
      "key",
      "principal",
      "endpoint",
      "toolkit",
      "tool",
    ]),
  ),
  model: lenient(Schema.String),
  provider: lenient(Schema.String),
  account: lenient(Schema.String),
  user: lenient(Schema.String),
  member: lenient(Schema.String),
  team: lenient(Schema.String),
  toolkit: lenient(Schema.String),
  tool: lenient(Schema.String),
  failed: lenient(Schema.Boolean),
});

export type UsageSearch = typeof UsageSearch.Type;

/** The router's search parameters as the page reads them; anything but an object reads as no parameters. */
export const readUsageSearch = flow(
  Schema.decodeUnknownOption(UsageSearch),
  Option.getOrElse((): UsageSearch => ({})),
);

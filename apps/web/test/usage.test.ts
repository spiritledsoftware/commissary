// The Usage page's model (src/lib/usage.ts): ranges and their bars, merged series, filters as query parameters,
// and the page address read one parameter at a time.
import { describe, expect, it } from "vitest";
import type { UsagePoint } from "@commissary/contract/usage";
import { formatLatency } from "../src/lib/format.ts";
import {
  activeFilters,
  areaFilterQuery,
  areaOf,
  breakdownOf,
  breakdownsFor,
  filterQuery,
  filtersFor,
  hourlyHistory,
  mergePoints,
  rangeBars,
  rangeOf,
  rangeStart,
  readUsageSearch,
  toolFilterQuery,
} from "../src/lib/usage.ts";

const HOUR = 3_600_000;

const point = (start: number, tokens: number, requests = 1, failed = 0): UsagePoint => ({
  start,
  requests,
  failed,
  total_tokens: tokens,
  cost_micros: tokens * 10,
});

const NOW = Date.parse("2026-10-10T12:30:00.000Z");

const HOUR_START = Date.parse("2026-10-10T12:00:00.000Z");

describe("hourlyHistory", () => {
  it("sums points per clock hour, the hour in progress last", () => {
    const bars = hourlyHistory(
      [point(HOUR_START, 5), point(HOUR_START + 10 * 60_000, 7), point(HOUR_START - HOUR, 3)],
      3,
      NOW,
    );

    expect(bars.map((bar) => [bar.start, bar.tokens, bar.requests, bar.current])).toEqual([
      [HOUR_START - 2 * HOUR, 0, 0, false],
      [HOUR_START - HOUR, 3, 1, false],
      [HOUR_START, 12, 2, true],
    ]);
  });
});

describe("ranges", () => {
  it("falls back to the last 24 hours for an unknown range", () => {
    expect(rangeOf(undefined).id).toBe("day");
    expect(rangeOf("year").id).toBe("day");
    expect(rangeOf("month").bars).toBe(30);
  });

  it("starts a range at its first bar", () => {
    expect(rangeStart(rangeOf("day"), NOW)).toBe(HOUR_START - 23 * HOUR);
    const week = rangeBars(rangeOf("week"), [], NOW);

    expect(week).toHaveLength(7);
    expect(rangeStart(rangeOf("week"), NOW)).toBe(week[0]?.start);
  });
});

describe("mergePoints", () => {
  it("sums every series per bucket, in time order", () => {
    expect(
      mergePoints([
        { points: [point(2 * HOUR, 10, 1, 1), point(HOUR, 4)] },
        { points: [point(2 * HOUR, 5, 2)] },
      ]),
    ).toEqual([point(HOUR, 4), point(2 * HOUR, 15, 3, 1)]);
  });
});

describe("filters", () => {
  it("maps filters to management API query parameters", () => {
    expect(
      filterQuery({ model: "gpt-5", account: "0123456789abcdef", user: "ian@example.com" }),
    ).toEqual({ model: "gpt-5", auth_index: "0123456789abcdef", principal: "ian@example.com" });
    expect(filterQuery({})).toEqual({});
  });

  it("lists the filters that are set in a fixed order", () => {
    expect(activeFilters({ user: "u", model: "m", provider: undefined })).toEqual([
      { key: "model", value: "m" },
      { key: "user", value: "u" },
    ]);
  });

  it("knows which breakdowns narrow the page", () => {
    expect(breakdownOf("auth").filter).toBe("account");
    expect(breakdownOf("endpoint").filter).toBeUndefined();
    expect(breakdownOf("nonsense").id).toBe("model");
    expect(breakdownOf("member").filter).toBe("member");
  });

  it("offers a plain member the breakdowns that need no account, member or team names", () => {
    expect(breakdownsFor(false).map((breakdown) => breakdown.id)).toEqual([
      "model",
      "provider",
      "key",
      "endpoint",
    ]);
    expect(breakdownsFor(true).map((breakdown) => breakdown.id)).toEqual(
      expect.arrayContaining(["member", "team", "key"]),
    );
    expect(breakdownOf("team").filter).toBe("team");
    expect(breakdownOf("key").filter).toBeUndefined();
    expect(readUsageSearch({ by: "key" }).by).toBe("key");
    expect(readUsageSearch({ by: "team" }).by).toBe("team");
    expect(breakdownOf("auth", breakdownsFor(false)).id).toBe("model");
  });

  it("narrows to a member and to a team", () => {
    expect(filterQuery({ member: "m1" })).toEqual({ member: "m1" });
    expect(activeFilters({ member: "m1" })).toEqual([{ key: "member", value: "m1" }]);
    expect(filterQuery({ team: "t1", model: "gpt-5" })).toEqual({ model: "gpt-5", team: "t1" });
    expect(activeFilters({ team: "t1", member: "m1" })).toEqual([
      { key: "member", value: "m1" },
      { key: "team", value: "t1" },
    ]);
  });
});

describe("tool calls (#209)", () => {
  it("read the tool calls area only when the address asks for it", () => {
    expect(areaOf("tools")).toBe("tools");
    expect(areaOf("models")).toBe("models");
    expect(areaOf(undefined)).toBe("models");
    expect(areaOf("all")).toBe("models");
    expect(readUsageSearch({ area: "tools", toolkit: "tk_1", tool: "tk_1:create_issue" })).toEqual({
      area: "tools",
      toolkit: "tk_1",
      tool: "tk_1:create_issue",
    });
    expect(readUsageSearch({ area: "everything" })).toEqual({});
  });

  it("ask the API for the tools area, narrowed to a toolkit, a tool and who made the calls", () => {
    expect(toolFilterQuery({})).toEqual({ area: "tools" });

    expect(
      toolFilterQuery({
        toolkit: "tk_1",
        tool: "tk_1:create_issue",
        user: "ana@example.com",
        member: "m1",
        team: "t1",
        // Meaningless to a tool call: never sent.
        model: "gpt-5",
        provider: "codex",
        account: "abc",
      }),
    ).toEqual({
      area: "tools",
      toolkit: "tk_1",
      tool: "tk_1:create_issue",
      principal: "ana@example.com",
      member: "m1",
      team: "t1",
    });

    expect(areaFilterQuery({ model: "gpt-5" }, "models")).toEqual({ model: "gpt-5" });
    expect(areaFilterQuery({ model: "gpt-5", toolkit: "tk_1" }, "tools")).toEqual({
      area: "tools",
      toolkit: "tk_1",
    });
  });

  it("keep the filters an area reads when the area changes, and drop the others", () => {
    const all = {
      model: "gpt-5",
      account: "a",
      toolkit: "tk_1",
      tool: "t",
      member: "m1",
      team: "t1",
    };

    expect(filtersFor(all, "tools")).toEqual({
      toolkit: "tk_1",
      tool: "t",
      member: "m1",
      team: "t1",
    });
    expect(filtersFor(all, "models")).toEqual({
      model: "gpt-5",
      account: "a",
      member: "m1",
      team: "t1",
    });
  });

  it("break calls down by toolkit and tool, and by who made them for an org admin", () => {
    expect(breakdownsFor(false, "tools").map((breakdown) => breakdown.id)).toEqual([
      "toolkit",
      "tool",
      "key",
    ]);
    expect(breakdownsFor(true, "tools").map((breakdown) => breakdown.id)).toEqual([
      "toolkit",
      "tool",
      "member",
      "team",
      "key",
      "principal",
    ]);
    expect(breakdownOf("toolkit", breakdownsFor(true, "tools")).filter).toBe("toolkit");
    expect(breakdownOf("tool", breakdownsFor(true, "tools")).filter).toBe("tool");
    // An address left from the models area starts at the first breakdown of this one.
    expect(breakdownOf("model", breakdownsFor(true, "tools")).id).toBe("toolkit");
    expect(readUsageSearch({ by: "toolkit" }).by).toBe("toolkit");
    expect(readUsageSearch({ by: "tool" }).by).toBe("tool");
  });

  it("list the toolkit and tool filters first among those that are set", () => {
    expect(activeFilters({ member: "m1", tool: "tk_1:x", toolkit: "tk_1" })).toEqual([
      { key: "toolkit", value: "tk_1" },
      { key: "tool", value: "tk_1:x" },
      { key: "member", value: "m1" },
    ]);
  });
});

describe("readUsageSearch", () => {
  it("keeps the valid parameters and drops the rest", () => {
    expect(
      readUsageSearch({
        range: "week",
        by: "everything",
        model: "gpt-5",
        account: "codex-a.json",
        failed: true,
        extra: "x",
      }),
    ).toEqual({ range: "week", model: "gpt-5", account: "codex-a.json", failed: true });
  });

  it("reads the member and team filters of the address", () => {
    expect(readUsageSearch({ by: "member", member: "m1", team: "t1" })).toEqual({
      by: "member",
      member: "m1",
      team: "t1",
    });
    expect(readUsageSearch({ team: "t1" })).toEqual({ team: "t1" });
    expect(readUsageSearch({ team: 7 })).toEqual({});
    expect(readUsageSearch({ team: undefined })).toEqual({});
  });

  it("drops a malformed value instead of failing", () => {
    expect(readUsageSearch({ failed: "yes", range: 3 })).toEqual({});
  });

  it("removes a parameter set to undefined", () => {
    expect(readUsageSearch({ range: "month", model: undefined })).toEqual({ range: "month" });
  });
});

describe("formatLatency", () => {
  it("reads milliseconds, seconds and minutes", () => {
    expect(formatLatency(840)).toBe("840 ms");
    expect(formatLatency(2_440)).toBe("2.4 s");
    expect(formatLatency(72_000)).toBe("1 min 12 s");
  });
});

// The Limits page's model (src/lib/spend.ts): amounts typed in dollars, how a limit reads, the order of the list and
// what a refused write says.
import { describe, expect, it } from "vitest";
import type { SpendLimitView } from "@commissary/contract/spend";
import type { ToolkitView } from "@commissary/contract/tools";
import {
  amountProblem,
  dollarsInput,
  kindLabel,
  limitableToolkits,
  limitProblem,
  parseDollars,
  reached,
  remainingText,
  sortLimits,
  spentShare,
  spentText,
  SUBJECT_KINDS,
  zoneProblem,
} from "../src/lib/spend.ts";

const limit = (overrides: Partial<SpendLimitView> = {}): SpendLimitView => ({
  id: "l1",
  kind: "member",
  subject: "m1",
  label: "alice@example.com",
  period: "day",
  amount_micros: 5_000_000,
  source: "admin",
  revision: 1,
  spent_micros: 1_800_000,
  remaining_micros: 3_200_000,
  period_start: "2026-10-14T00:00:00.000Z",
  resets_at: "2026-10-15T00:00:00.000Z",
  editable: true,
  updated_at: "2026-10-14T08:00:00.000Z",
  updated_by: "admin@example.com",
  ...overrides,
});

describe("amounts", () => {
  it("reads dollars into micro-USD, with up to six decimals", () => {
    expect(parseDollars("25")).toBe(25_000_000);
    expect(parseDollars(" $12.50 ")).toBe(12_500_000);
    expect(parseDollars("0.000001")).toBe(1);
    expect(parseDollars("0")).toBe(0);

    for (const bad of ["", "-1", "1.1234567", "ten", "1,000", "1e3", "$", "1."])
      expect(parseDollars(bad), bad).toBeUndefined();
  });

  it("writes micro-USD back the way the form reads it", () => {
    expect(dollarsInput(5_250_000)).toBe("5.25");
    expect(dollarsInput(5_000_000)).toBe("5");
    expect(dollarsInput(1)).toBe("0.000001");
    expect(parseDollars(dollarsInput(123_456_789))).toBe(123_456_789);
    expect(amountProblem("abc")).toContain("US dollars");
    expect(amountProblem("3")).toBeUndefined();
  });

  it("checks the shape of a time zone name before the server does", () => {
    expect(zoneProblem("Europe/Berlin")).toBeUndefined();
    expect(zoneProblem("America/Argentina/Buenos_Aires")).toBeUndefined();
    expect(zoneProblem("")).toContain("IANA");
    expect(zoneProblem("+02:00")).toContain("IANA");
  });
});

describe("a limit's figures", () => {
  it("says what is spent, left and whether it is reached", () => {
    expect(spentText(limit())).toBe("$1.80 of $5.00");
    expect(remainingText(limit())).toBe("$3.20 left");
    expect(spentShare(limit())).toBeCloseTo(0.36);
    expect(reached(limit())).toBe(false);

    const full = limit({ spent_micros: 5_100_000, remaining_micros: 0 });

    expect(reached(full)).toBe(true);
    expect(remainingText(full)).toBe("Reached");
    expect(spentShare(full)).toBe(1);
    // A limit of nothing has no room at all.
    expect(spentShare(limit({ amount_micros: 0, spent_micros: 0, remaining_micros: 0 }))).toBe(1);
    expect(reached(limit({ amount_micros: 0, spent_micros: 0, remaining_micros: 0 }))).toBe(true);
  });
});

describe("the list", () => {
  it("puts the org first, then teams, members, keys and shared credentials, the shorter period first", () => {
    const sorted = sortLimits([
      limit({ id: "k", kind: "key", label: "laptop" }),
      limit({ id: "m-week", kind: "member", label: "bob@example.com", period: "week" }),
      limit({ id: "m-day", kind: "member", label: "bob@example.com", period: "day" }),
      limit({ id: "o", kind: "org", label: "Whole org", period: "month" }),
      limit({ id: "t", kind: "team", label: "Platform" }),
      limit({ id: "c", kind: "credential", label: "me@example.com" }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["o", "t", "m-day", "m-week", "k", "c"]);
  });
});

describe("refused writes", () => {
  it("explains each error code in the caller's words", () => {
    expect(limitProblem("exceeds_admin_limit", "x")).toContain("org admin");
    expect(limitProblem("conflict", "x", "that subject already has a limit")).toContain("Edit it");
    expect(limitProblem("conflict", "x", "the limit is at revision 2, not 1")).toContain("Reload");
    expect(limitProblem("forbidden", "x")).toContain("your own API keys");
    expect(limitProblem("not_found", "x")).toContain("no longer exists");
    expect(limitProblem("invalid_limit", "fallback", "amount is bad")).toBe("Amount is bad.");
    expect(limitProblem(undefined, "fallback")).toBe("fallback");
  });
});

describe("limits on a toolkit's shared credential (#209)", () => {
  const toolkit = (patch: Partial<ToolkitView>): ToolkitView => ({
    id: "tk_1",
    kind: "mcp",
    name: "linear",
    source: "https://mcp.linear.app/mcp",
    private: false,
    accepts: "shared",
    revision: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    updated_by: "user:admin@example.com",
    credentials: {
      shared: {
        kind: "bearer",
        connected_at: "2026-08-01T00:00:00.000Z",
        connected_by: "user:admin@example.com",
        active: true,
      },
    },
    tool_list: { tools: 3 },
    ...patch,
  });

  it("are offered in the new limit form, named by the toolkit", () => {
    expect(SUBJECT_KINDS.map((kind) => kind.id)).toContain("toolkit_credential");
    expect(kindLabel("toolkit_credential")).toBe("Toolkit credential");
    expect(kindLabel("credential")).toBe("Shared credential");
  });

  it("name an org toolkit that holds a shared credential, by name", () => {
    expect(
      limitableToolkits([
        toolkit({ id: "tk_b", name: "stripe" }),
        toolkit({ id: "tk_a", name: "github" }),
        // No shared credential to limit yet.
        toolkit({ id: "tk_c", name: "hubspot", credentials: {} }),
        // A private toolkit counts toward its member's and API keys' limits only.
        toolkit({ id: "tk_d", name: "notes", private: true }),
        // The browser toolkit is Commissary's own: its time is priced, not its credential limited.
        toolkit({ id: "browser", name: "browser", kind: "browser", built_in: true }),
      ]),
    ).toEqual([
      { id: "tk_a", label: "github" },
      { id: "tk_b", label: "stripe" },
    ]);
  });
});

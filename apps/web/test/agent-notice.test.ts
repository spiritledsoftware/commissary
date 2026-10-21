// The notice on an unattended agent (src/lib/agent-notice.ts, #233, ADR 0044): a schedule or webhook trigger and a write
// tool with no approval rule show it; an approval rule on those tools, or no such trigger, takes it away.
import { describe, expect, it } from "vitest";
import type { ToolScope } from "@commissary/contract/api-keys";
import type { ToolkitView } from "@commissary/contract/tools";
import {
  covered,
  kindsText,
  servedTools,
  startsUnattended,
  type ToolLike,
  uncoveredWrites,
  unattendedNotice,
  writeToolsText,
} from "../src/lib/agent-notice.ts";

const SEARCH: ToolLike = { id: "tk_gh:search", class: "read" };

const CREATE_ISSUE: ToolLike = { id: "tk_gh:create_issue", class: "write" };

const MERGE_PR: ToolLike = { id: "tk_gh:merge_pr", class: "write" };

const GITHUB: ReadonlyArray<ToolLike> = [SEARCH, CREATE_ISSUE, MERGE_PR];

const LINEAR: ReadonlyArray<ToolLike> = [{ id: "tk_lin:list", class: "read" }];

const lists: ReadonlyMap<string, ReadonlyArray<ToolLike>> = new Map([
  ["tk_gh", GITHUB],
  ["tk_lin", LINEAR],
]);

const CALLER = { kind: "caller" } as const;

const toolkit = (id: string, name: string, approval_rules?: ToolkitView["approval_rules"]) =>
  approval_rules === undefined ? { id, name } : { id, name, approval_rules };

const toolkits = [toolkit("tk_gh", "github"), toolkit("tk_lin", "linear")];

const ALL_GH: ToolScope = [{ toolkit: "tk_gh", tools: { kind: "all" } }];

describe("which write tools nothing asks to approve", () => {
  it("counts the write tools of a whole toolkit, not its read tools", () => {
    expect(uncoveredWrites(ALL_GH, toolkits, (id) => lists.get(id))).toEqual([
      { toolkit: "tk_gh", name: "github", tools: ["tk_gh:create_issue", "tk_gh:merge_pr"] },
    ]);
  });

  it("gives nothing for read tools, a toolkit of read tools only, or no scope", () => {
    expect(
      uncoveredWrites([{ toolkit: "tk_gh", tools: { kind: "read" } }], toolkits, (id) =>
        lists.get(id),
      ),
    ).toEqual([]);

    expect(
      uncoveredWrites([{ toolkit: "tk_lin", tools: { kind: "all" } }], toolkits, (id) =>
        lists.get(id),
      ),
    ).toEqual([]);

    expect(uncoveredWrites([], toolkits, (id) => lists.get(id))).toEqual([]);
  });

  it("counts only the named tools that write", () => {
    const scope: ToolScope = [
      { toolkit: "tk_gh", tools: { kind: "named", ids: ["tk_gh:search", "tk_gh:merge_pr"] } },
    ];

    expect(uncoveredWrites(scope, toolkits, (id) => lists.get(id))).toEqual([
      { toolkit: "tk_gh", name: "github", tools: ["tk_gh:merge_pr"] },
    ]);
  });

  it("is covered by the toolkit's write rule, and by a mark on a single tool", () => {
    const rule = [toolkit("tk_gh", "github", { writes: { approver: CALLER } })];

    expect(uncoveredWrites(ALL_GH, rule, (id) => lists.get(id))).toEqual([]);

    const marked = [
      toolkit("tk_gh", "github", { tools: [{ id: "tk_gh:create_issue", approver: CALLER }] }),
    ];

    expect(uncoveredWrites(ALL_GH, marked, (id) => lists.get(id))).toEqual([
      { toolkit: "tk_gh", name: "github", tools: ["tk_gh:merge_pr"] },
    ]);

    expect(covered(undefined, CREATE_ISSUE)).toBe(false);
    // A mark covers a tool whatever its class: a mark wins over the toolkit-wide rule.
    expect(
      covered(
        toolkit("x", "x", { tools: [{ id: "tk_gh:search", approver: CALLER }] }).approval_rules,
        SEARCH,
      ),
    ).toBe(true);
  });

  it("waits for a tool list that has not loaded, and ignores a toolkit that is gone", () => {
    expect(uncoveredWrites(ALL_GH, toolkits, () => undefined)).toEqual([]);
    expect(uncoveredWrites(ALL_GH, [], (id) => lists.get(id))).toEqual([]);
  });
});

describe("the tools a toolkit serves", () => {
  const flags = { shortened: false, renamed: false, hidden: false, clash: false, missing: false };

  it("leaves out a hidden, missing or shadowed tool, which no client can call", () => {
    expect(
      servedTools([
        { ...SEARCH, flags },
        { ...CREATE_ISSUE, flags: { ...flags, hidden: true } },
        { ...MERGE_PR, flags: { ...flags, missing: true } },
        { id: "tk_gh:close", class: "write", flags: { ...flags, clash: true } },
      ]),
    ).toEqual([SEARCH]);
  });

  it("keeps each served tool's id and class only", () => {
    expect(servedTools([{ ...MERGE_PR, flags }])).toEqual([MERGE_PR]);
  });
});

describe("the notice", () => {
  const uncovered = uncoveredWrites(ALL_GH, toolkits, (id) => lists.get(id));

  it("shows for a webhook or schedule trigger with write tools no rule covers", () => {
    expect(unattendedNotice([{ kind: "webhook", enabled: true }], uncovered)).toEqual({
      kinds: ["webhook"],
      toolkits: uncovered,
    });

    expect(
      unattendedNotice(
        [
          { kind: "webhook", enabled: true },
          { kind: "schedule", enabled: true },
        ],
        uncovered,
      )?.kinds,
    ).toEqual(["schedule", "webhook"]);
  });

  it("goes away with an approval rule on those tools, or with no such trigger", () => {
    const rule = [toolkit("tk_gh", "github", { writes: { approver: CALLER } })];
    const ruled = uncoveredWrites(ALL_GH, rule, (id) => lists.get(id));

    expect(unattendedNotice([{ kind: "webhook", enabled: true }], ruled)).toBeUndefined();
    expect(unattendedNotice([], uncovered)).toBeUndefined();
  });

  it("ignores a disabled trigger, which starts nothing", () => {
    expect(startsUnattended({ kind: "schedule", enabled: false })).toBe(false);
    expect(unattendedNotice([{ kind: "schedule", enabled: false }], uncovered)).toBeUndefined();
  });

  it("says its parts in words", () => {
    expect(kindsText(["schedule"])).toBe("a schedule");
    expect(kindsText(["schedule", "webhook"])).toBe("a schedule and a webhook");
    expect(writeToolsText(1)).toBe("1 write tool");
    expect(writeToolsText(12)).toBe("12 write tools");
  });
});

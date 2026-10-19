// Tool grants (ADR 0038): what a member's grants give of the tools of org toolkits' shared credentials. A grant gives
// all of a toolkit's tools, its read tools (by tool class) or named tools by stable id; a member's reach is the union of
// the grants for everyone, for them and for their teams; there is no deny.
import { describe, expect, it } from "vitest";
import type { ToolGrantEntry } from "../../src/grants/grant.ts";
import { grantedTools } from "../../src/grants/reach.ts";

const grant = (value: Pick<ToolGrantEntry, "subject" | "toolkit" | "tools">): ToolGrantEntry => ({
  id: `tg-${value.toolkit}`,
  revision: 1,
  updatedAt: 0,
  updatedBy: "test",
  ...value,
});

const tool = (toolkitId: string, upstreamName: string, toolClass: "read" | "write" = "write") => ({
  toolkitId,
  upstreamName,
  toolClass,
});

const GITHUB = [
  tool("tk_github", "create_issue"),
  tool("tk_github", "list_issues", "read"),
  tool("tk_github", "delete_repo"),
];

const STRIPE = [tool("tk_stripe", "refund"), tool("tk_stripe", "balance", "read")];

const EVERY_TOOL = [...GITHUB, ...STRIPE];

/** The upstream names of the tools `grants` give `holder`. */
const given = (
  grants: ReadonlyArray<ToolGrantEntry>,
  holder: { readonly member?: string; readonly teams: ReadonlyArray<string> },
) => {
  const granted = grantedTools(grants, holder);

  return EVERY_TOOL.flatMap((tool) =>
    granted(tool) ? [`${tool.toolkitId}:${tool.upstreamName}`] : [],
  );
};

const ALICE = { member: "m-alice", teams: ["t-ops"] };

describe("a tool grant", () => {
  it("of all tools gives every tool of its toolkit and none of another", () => {
    const grants = [
      grant({ subject: { kind: "everyone" }, toolkit: "tk_github", tools: { kind: "all" } }),
    ];

    expect(given(grants, ALICE)).toEqual([
      "tk_github:create_issue",
      "tk_github:list_issues",
      "tk_github:delete_repo",
    ]);
  });

  it("of read tools gives the tools whose class is read", () => {
    const grants = [
      grant({ subject: { kind: "everyone" }, toolkit: "tk_github", tools: { kind: "read" } }),
    ];

    expect(given(grants, ALICE)).toEqual(["tk_github:list_issues"]);
  });

  it("of named tools gives exactly the tools of those stable ids", () => {
    const grants = [
      grant({
        subject: { kind: "everyone" },
        toolkit: "tk_github",
        tools: { kind: "named", ids: ["tk_github:delete_repo", "tk_github:gone"] },
      }),
    ];

    expect(given(grants, ALICE)).toEqual(["tk_github:delete_repo"]);
  });

  it("gives nothing to a holder it does not name", () => {
    const grants = [
      grant({
        subject: { kind: "member", id: "m-bob" },
        toolkit: "tk_github",
        tools: { kind: "all" },
      }),
      grant({
        subject: { kind: "team", id: "t-dev" },
        toolkit: "tk_stripe",
        tools: { kind: "all" },
      }),
    ];

    expect(given(grants, ALICE)).toEqual([]);
    expect(given([], ALICE)).toEqual([]);
  });
});

describe("a member's reach", () => {
  it("is the union of the grants for everyone, for them and for their teams", () => {
    const grants = [
      grant({ subject: { kind: "everyone" }, toolkit: "tk_github", tools: { kind: "read" } }),
      grant({
        subject: { kind: "member", id: "m-alice" },
        toolkit: "tk_github",
        tools: { kind: "named", ids: ["tk_github:create_issue"] },
      }),
      grant({
        subject: { kind: "team", id: "t-ops" },
        toolkit: "tk_stripe",
        tools: { kind: "read" },
      }),
    ];

    expect(given(grants, ALICE)).toEqual([
      "tk_github:create_issue",
      "tk_github:list_issues",
      "tk_stripe:balance",
    ]);

    // Someone else in no team: the grant for everyone only.
    expect(given(grants, { member: "m-bob", teams: [] })).toEqual(["tk_github:list_issues"]);
    // A request without a member: the grants for everyone only.
    expect(given(grants, { teams: [] })).toEqual(["tk_github:list_issues"]);
  });
});

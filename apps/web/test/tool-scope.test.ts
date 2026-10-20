// The tool scope editor's model (src/lib/tool-scope.ts, #200): drafts of stored scopes, the scope a draft sends, what it
// gives of the tools the member may use, and how the API keys page words a key's tools.
import { describe, expect, it } from "vitest";
import type { UsableTools } from "@commissary/contract/tools";
import {
  draftOfScope,
  draftSummary,
  EVERY_TOOL,
  hasTools,
  keyToolsText,
  missingText,
  scopeOfDraft,
  setChoice,
  setLimited,
  toggleTool,
  toolCountText,
  toolsGiven,
} from "../src/lib/tool-scope.ts";

const USABLE: UsableTools = {
  toolkits: [
    {
      id: "tk_gh",
      name: "github",
      tools: [
        { id: "tk_gh:create_issue", name: "github_create_issue", tool_class: "write" },
        { id: "tk_gh:search", name: "github_search", tool_class: "read" },
      ],
    },
    {
      id: "tk_lin",
      name: "linear",
      tools: [{ id: "tk_lin:list", name: "linear_list", tool_class: "read" }],
    },
  ],
};

const names = (draft: Parameters<typeof toolsGiven>[0]) =>
  toolsGiven(draft, USABLE).map((tool) => tool.name);

describe("a draft", () => {
  it("without a limit sends no scope and gives every tool", () => {
    expect(scopeOfDraft(EVERY_TOOL)).toBeNull();
    expect(names(EVERY_TOOL)).toEqual(["github_create_issue", "github_search", "linear_list"]);
    expect(draftSummary(EVERY_TOOL, USABLE)).toBe(
      "Every tool you may use: 3 tools now, and tools you get later.",
    );
  });

  it("limited gives only the toolkits it picks, as the scope names them", () => {
    const limited = setLimited(EVERY_TOOL, true);

    expect(scopeOfDraft(limited)).toEqual([]);
    expect(names(limited)).toEqual([]);
    expect(draftSummary(limited, USABLE)).toBe(
      "No tools: pick a toolkit's tools, or allow every tool.",
    );

    const read = setChoice(setChoice(limited, "tk_gh", "read"), "tk_lin", "all");

    expect(scopeOfDraft(read)).toEqual([
      { toolkit: "tk_gh", tools: { kind: "read" } },
      { toolkit: "tk_lin", tools: { kind: "all" } },
    ]);
    expect(names(read)).toEqual(["github_search", "linear_list"]);
    expect(draftSummary(read, USABLE)).toBe("2 tools, and only those.");
  });

  it("picks tools one by one, keeping the picks while another choice shows", () => {
    const picked = toggleTool(setLimited(EVERY_TOOL, true), "tk_gh", "tk_gh:create_issue");

    expect(scopeOfDraft(picked)).toEqual([
      { toolkit: "tk_gh", tools: { kind: "named", ids: ["tk_gh:create_issue"] } },
    ]);
    expect(names(picked)).toEqual(["github_create_issue"]);

    const all = setChoice(picked, "tk_gh", "all");
    const back = setChoice(all, "tk_gh", "named");

    expect(scopeOfDraft(back)).toEqual(scopeOfDraft(picked));
    // Unpicking the last tool leaves the toolkit out.
    expect(scopeOfDraft(toggleTool(back, "tk_gh", "tk_gh:create_issue"))).toEqual([]);
  });

  it("reads back a stored scope, and none as every tool", () => {
    const scope = [
      { toolkit: "tk_gh", tools: { kind: "named" as const, ids: ["tk_gh:search"] } },
      { toolkit: "tk_lin", tools: { kind: "read" as const } },
    ];

    expect(scopeOfDraft(draftOfScope(scope))).toEqual(scope);
    expect(draftOfScope(undefined)).toEqual(EVERY_TOOL);
    expect(draftOfScope(null)).toEqual(EVERY_TOOL);
  });
});

describe("a key's tools", () => {
  it("are every tool without a scope, else how many it may use now", () => {
    expect(keyToolsText({ tool_count: 3 })).toBe("Every tool (3 tools)");
    expect(keyToolsText({})).toBe("Every tool");
    expect(keyToolsText({ tool_scope: [], tool_count: 0 })).toBe("No tools");
    expect(keyToolsText({ tool_scope: [], tool_count: 1 })).toBe("1 tool");
    expect(keyToolsText({ tool_scope: [] })).toBe("Limited");
  });

  it("say what the scope names that is gone", () => {
    expect(missingText({})).toBeUndefined();
    expect(missingText({ tool_scope_missing: ["tk_old"] })).toBe(
      "1 tool or toolkit it names is gone",
    );
    expect(missingText({ tool_scope_missing: ["tk_old", "tk_gh:gone"] })).toBe(
      "2 tools or toolkits it names are gone",
    );
  });

  it("counts in words, and knows when there is nothing to pick", () => {
    expect([0, 1, 12].map(toolCountText)).toEqual(["No tools", "1 tool", "12 tools"]);
    expect(hasTools(USABLE)).toBe(true);
    expect(hasTools({ toolkits: [{ id: "tk", name: "empty", tools: [] }] })).toBe(false);
  });
});

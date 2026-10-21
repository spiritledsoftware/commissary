// My tools (src/lib/my-tools.ts, #209, ADR 0038): the tools a member reaches, by toolkit, and why: their private
// credential, which grants give them, and the agents toolkit.
import { describe, expect, it } from "vitest";
import type { UsableToolkit, UsableVia } from "@commissary/contract/tools";
import {
  filterMyTools,
  reachText,
  reasonsForTool,
  reasonsOf,
  NO_TOOLS_NOTE,
} from "../src/lib/my-tools.ts";

const tools = [
  { id: "tk_1:create_issue", name: "linear_create_issue", tool_class: "write" as const },
  { id: "tk_1:get_issue", name: "linear_get_issue", tool_class: "read" as const },
  { id: "tk_1:list_issues", name: "linear_list_issues", tool_class: "read" as const },
];

const via: UsableVia = {
  grants: [
    { subject: { kind: "member" }, tools: { kind: "named", ids: ["tk_1:create_issue"] } },
    { subject: { kind: "team", id: "ops", name: "Ops" }, tools: { kind: "read" } },
    { subject: { kind: "everyone" }, tools: { kind: "all" } },
  ],
};

describe("why a toolkit reaches a member", () => {
  it("lists the private credential first, then everyone's grants, their teams' and their own", () => {
    expect(reasonsOf({ ...via, private: true })).toEqual([
      {
        kind: "private",
        label: "Your private credential",
        gives: "Every tool an admin has not hidden",
      },
      { kind: "grant", label: "A grant to everyone", gives: "All tools" },
      { kind: "grant", label: "A grant to team Ops", gives: "Read tools" },
      { kind: "grant", label: "A grant to you", gives: "1 named tool" },
    ]);
  });

  it("says a credential they can connect but have not is a way in once connected, not one they have", () => {
    expect(reasonsOf({ ...via, private_available: true }).map((reason) => reason.kind)).toEqual([
      "private_available",
      "grant",
      "grant",
      "grant",
    ]);

    expect(reasonsOf({ private_available: true })[0]?.label).toBe(
      "Your own credential, once you connect it on the toolkit's page",
    );

    expect(reasonsOf({ private: true }).map((reason) => reason.kind)).toEqual(["private"]);
  });

  it("names the agents toolkit's own reason, and says nothing of an answer that has none", () => {
    expect(reasonsOf({ agents: true }).map((reason) => reason.label)).toEqual([
      "The agents you may run",
    ]);
    expect(reasonsOf(undefined)).toEqual([]);
    expect(reasonsOf({})).toEqual([]);
  });

  it("names a team the org no longer has without its name", () => {
    expect(
      reasonsOf({
        grants: [{ subject: { kind: "team", id: "x", name: "" }, tools: { kind: "all" } }],
      })[0]?.label,
    ).toBe("A grant to one of your teams");
  });

  it("says which of the reasons gives each tool: a grant the tools it selects, a private credential every one", () => {
    const write = tools[0];
    const readOne = tools[1];

    if (write === undefined || readOne === undefined) throw new Error("the fixture lists tools");

    expect(reasonsForTool(via, write)).toEqual(["A grant to everyone", "A grant to you"]);
    expect(reasonsForTool(via, readOne)).toEqual(["A grant to everyone", "A grant to team Ops"]);
    expect(reasonsForTool({ private: true, grants: [] }, write)).toEqual([
      "Your private credential",
    ]);
    expect(reasonsForTool({ private_available: true }, write)).toEqual([
      "Your own credential, once connected",
    ]);
    expect(reasonsForTool(undefined, write)).toEqual([]);

    expect(
      reasonsForTool(
        {
          grants: [{ subject: { kind: "team", id: "ops", name: "Ops" }, tools: { kind: "read" } }],
        },
        write,
      ),
    ).toEqual([]);
  });
});

describe("the list", () => {
  const toolkits: ReadonlyArray<UsableToolkit> = [
    { id: "tk_1", name: "linear", tools, via },
    {
      id: "tk_2",
      name: "github",
      tools: [{ id: "tk_2:open_pr", name: "github_open_pr", tool_class: "write" }],
      via: { private: true },
    },
  ];

  it("narrows to a search: a toolkit whose name matches keeps all its tools, else only the tools that match", () => {
    expect(filterMyTools(toolkits, "")).toBe(toolkits);
    expect(filterMyTools(toolkits, "LINEAR").map((toolkit) => toolkit.tools.length)).toEqual([3]);
    expect(filterMyTools(toolkits, "open_pr").map((toolkit) => toolkit.name)).toEqual(["github"]);
    expect(
      filterMyTools(toolkits, "get_issue").flatMap((toolkit) =>
        toolkit.tools.map((each) => each.name),
      ),
    ).toEqual(["linear_get_issue"]);
    expect(filterMyTools(toolkits, "nothing")).toEqual([]);
  });

  it("counts the tools and toolkits", () => {
    expect(reachText(toolkits)).toBe("4 tools in 2 toolkits");
    expect(reachText(toolkits.slice(1))).toBe("1 tool in 1 toolkit");
  });

  it("tells a member with no tools where to turn", () => {
    expect(NO_TOOLS_NOTE).toContain("An org admin gives you");
  });
});

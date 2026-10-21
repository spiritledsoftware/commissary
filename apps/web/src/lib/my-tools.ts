// My tools (#209, ADR 0038, GLOSSARY "Reach"): the tools a member may use, by toolkit, and why: their own private
// credential, or which grants give them, and the agents toolkit that no grant gates. The server sends each toolkit's
// reasons (`via` of `GET /tools`); this words them and says which of them gives each tool. Pure: no DOM, tested in
// test/my-tools.test.ts.
import type { ToolSelection } from "@commissary/contract/grants";
import type { UsableGrant, UsableTool, UsableToolkit, UsableVia } from "@commissary/contract/tools";
import { formatCount } from "./format.ts";
import { selectionLabel } from "./tool-grants.ts";

/** One way a member reaches tools: what it is and who gave it. */
export interface Reason {
  readonly kind: "private" | "private_available" | "grant" | "agents";
  /**
   * "Your private credential", "Your own credential, once you connect it on the toolkit's page", "A grant to
   * everyone", "A grant to team Research", "A grant to you".
   */
  readonly label: string;
  /** Which tools it gives: "Every tool that is not hidden", "All tools", "Read tools", "3 named tools". */
  readonly gives: string;
}

const grantLabel = (grant: UsableGrant): string => {
  switch (grant.subject.kind) {
    case "everyone":
      return "A grant to everyone";
    case "member":
      return "A grant to you";
    case "team":
      return grant.subject.name === ""
        ? "A grant to one of your teams"
        : `A grant to team ${grant.subject.name}`;
  }
};

/** Everyone's grants first, then their teams', then their own; each the widest selection first. */
const GRANT_RANK = { everyone: 0, team: 1, member: 2 } as const;

const SELECTION_RANK = { all: 0, read: 1, named: 2 } as const;

/** The ways the member reaches a toolkit's tools, most general first: the private credential, then the grants. */
export const reasonsOf = (via: UsableVia | undefined): ReadonlyArray<Reason> => {
  if (via === undefined) return [];

  const grants = (via.grants ?? []).toSorted(
    (a, b) =>
      GRANT_RANK[a.subject.kind] - GRANT_RANK[b.subject.kind] ||
      SELECTION_RANK[a.tools.kind] - SELECTION_RANK[b.tools.kind],
  );

  return [
    ...(via.private === true
      ? [
          {
            kind: "private" as const,
            label: "Your private credential",
            gives: "Every tool an admin has not hidden",
          },
        ]
      : []),
    ...(via.private_available === true
      ? [
          {
            kind: "private_available" as const,
            label: "Your own credential, once you connect it on the toolkit's page",
            gives: "Every tool an admin has not hidden",
          },
        ]
      : []),
    ...grants.map((grant) => ({
      kind: "grant" as const,
      label: grantLabel(grant),
      gives: selectionLabel(grant.tools),
    })),
    ...(via.agents === true
      ? [
          {
            kind: "agents" as const,
            label: "The agents you may run",
            gives: "A tool for each agent",
          },
        ]
      : []),
  ];
};

const selects = (selection: ToolSelection, tool: UsableTool): boolean => {
  switch (selection.kind) {
    case "all":
      return true;
    case "read":
      return tool.tool_class === "read";
    case "named":
      return selection.ids.includes(tool.id);
  }
};

/**
 * Which of the toolkit's reasons give one tool: the private credential (connected or not yet) and the agents toolkit
 * give every tool, a grant the tools it selects (all, the read tools, or those it names).
 */
export const reasonsForTool = (
  via: UsableVia | undefined,
  tool: UsableTool,
): ReadonlyArray<string> => {
  if (via === undefined) return [];

  return [
    ...(via.private === true ? ["Your private credential"] : []),
    ...(via.private_available === true ? ["Your own credential, once connected"] : []),
    ...(via.grants ?? [])
      .filter((grant) => selects(grant.tools, tool))
      .toSorted((a, b) => GRANT_RANK[a.subject.kind] - GRANT_RANK[b.subject.kind])
      .map(grantLabel),
    ...(via.agents === true ? ["The agents you may run"] : []),
  ];
};

/** The toolkits narrowed to a search: a toolkit whose name matches keeps every tool, else only the tools that match. */
export const filterMyTools = (
  toolkits: ReadonlyArray<UsableToolkit>,
  query: string,
): ReadonlyArray<UsableToolkit> => {
  const needle = query.trim().toLowerCase();

  if (needle === "") return toolkits;

  return toolkits.flatMap((toolkit) => {
    if (toolkit.name.toLowerCase().includes(needle)) return [toolkit];

    const tools = toolkit.tools.filter((tool) => tool.name.toLowerCase().includes(needle));

    return tools.length === 0 ? [] : [{ ...toolkit, tools }];
  });
};

/** How many tools there are in the toolkits: "12 tools in 3 toolkits". */
export const reachText = (toolkits: ReadonlyArray<UsableToolkit>): string => {
  const tools = toolkits.reduce((sum, toolkit) => sum + toolkit.tools.length, 0);

  return `${formatCount(tools)} ${tools === 1 ? "tool" : "tools"} in ${formatCount(toolkits.length)} ${toolkits.length === 1 ? "toolkit" : "toolkits"}`;
};

/** What an empty reach means to the member who reads it. */
export const NO_TOOLS_NOTE =
  "No tools reach you yet. An org admin gives you or your team a toolkit's tools; a toolkit that takes private credentials needs yours on its Tools page.";

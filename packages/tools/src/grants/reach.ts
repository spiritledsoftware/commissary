/**
 * What a holder's tool grants give (ADR 0038): the union of the grants that name them (everyone, their member id, their
 * teams). Pure; the Tools part asks it which shared-credential tools a member reaches. A tool's class is the resolved
 * one (an override's wins), so reclassifying a tool changes what a "read" grant gives at once. An API key's tool scope
 * selects tools the same way, within that reach ({@link inToolScope}).
 */
import type { ToolScope } from "@commissary/contract/api-keys";
import type { ToolSelection } from "@commissary/contract/grants";
import type { ToolClass } from "@commissary/contract/tools";
import type { ToolGrantEntry } from "./grant.ts";
import { type GrantHolder, namesHolder } from "./subject.ts";

/** Who asks: the member of the request, if any, and the teams they belong to. */
export type ToolGrantHolder = GrantHolder;

/** A tool as a grant is asked about: its stable id's parts and its class. */
export interface GrantableTool {
  readonly toolkitId: string;
  readonly upstreamName: string;
  readonly toolClass: ToolClass;
}

const names = (grant: ToolGrantEntry, holder: ToolGrantHolder): boolean =>
  namesHolder(grant.subject, holder);

/** Whether `selection` (all, read or named tools of `toolkit`) takes in `tool`. */
const selects = (toolkit: string, selection: ToolSelection, tool: GrantableTool): boolean => {
  if (toolkit !== tool.toolkitId) return false;

  switch (selection.kind) {
    case "all":
      return true;
    case "read":
      return tool.toolClass === "read";
    case "named":
      return selection.ids.includes(`${tool.toolkitId}:${tool.upstreamName}`);
  }
};

const gives = (grant: ToolGrantEntry, tool: GrantableTool): boolean =>
  selects(grant.toolkit, grant.tools, tool);

/**
 * Whether an API key's tool scope (#200, ADR 0036) takes in a tool: one of its toolkits selects it, as a grant would.
 * A key without a scope (`undefined`) takes in every tool; the member's reach still applies first.
 */
export const inToolScope = (scope: ToolScope | undefined, tool: GrantableTool): boolean =>
  scope === undefined || scope.some((entry) => selects(entry.toolkit, entry.tools, tool));

/** Whether the grants that name `holder` give a tool (of an org toolkit's shared credential). */
export const grantedTools = (
  grants: ReadonlyArray<ToolGrantEntry>,
  holder: ToolGrantHolder,
): ((tool: GrantableTool) => boolean) => {
  const applicable = grants.filter((grant) => names(grant, holder));

  return (tool) => applicable.some((grant) => gives(grant, tool));
};

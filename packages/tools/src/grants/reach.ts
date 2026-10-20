/**
 * What a holder's tool grants give (ADR 0038): the union of the grants that name them (everyone, their member id, their
 * teams). Pure; the Tools part asks it which shared-credential tools a member reaches. A tool's class is the resolved
 * one (an override's wins), so reclassifying a tool changes what a "read" grant gives at once.
 */
import type { ToolClass } from "@commissary/contract/tools";
import type { ToolGrantEntry } from "./grant.ts";

/** Who asks: the member of the request, if any, and the teams they belong to. */
export interface ToolGrantHolder {
  readonly member?: string | undefined;
  readonly teams: ReadonlyArray<string>;
}

/** A tool as a grant is asked about: its stable id's parts and its class. */
export interface GrantableTool {
  readonly toolkitId: string;
  readonly upstreamName: string;
  readonly toolClass: ToolClass;
}

const names = (grant: ToolGrantEntry, holder: ToolGrantHolder): boolean => {
  switch (grant.subject.kind) {
    case "everyone":
      return true;
    case "member":
      return holder.member !== undefined && grant.subject.id === holder.member;
    case "team":
      return holder.teams.includes(grant.subject.id);
  }
};

const gives = (grant: ToolGrantEntry, tool: GrantableTool): boolean => {
  if (grant.toolkit !== tool.toolkitId) return false;

  switch (grant.tools.kind) {
    case "all":
      return true;
    case "read":
      return tool.toolClass === "read";
    case "named":
      return grant.tools.ids.includes(`${tool.toolkitId}:${tool.upstreamName}`);
  }
};

/** Whether the grants that name `holder` give a tool (of an org toolkit's shared credential). */
export const grantedTools = (
  grants: ReadonlyArray<ToolGrantEntry>,
  holder: ToolGrantHolder,
): ((tool: GrantableTool) => boolean) => {
  const applicable = grants.filter((grant) => names(grant, holder));

  return (tool) => applicable.some((grant) => gives(grant, tool));
};

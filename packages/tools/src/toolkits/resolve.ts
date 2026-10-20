/**
 * The tools of a set of toolkits as one flat list of unique full names (ADR 0037), with what to tell an admin or a
 * member about each: whether its name was shortened or renamed, whether an override hides it, whether another tool
 * took its full name, and whether its source no longer lists it. Pure: the part hands it what it stored.
 *
 * Who looks decides the set: the org's toolkits for the org's own names, or the org's toolkits and one member's private
 * toolkits for that member. Then:
 *
 * - a private toolkit with the name of an org toolkit wins for its member: the org toolkit is left out for them, and
 *   the private one should be renamed;
 * - of the tools that would share a full name, a renamed one wins (an admin's rename stands against a tool a refresh
 *   brings later), then the one first seen, then the older toolkit's; the others are hidden and flagged.
 */
import type { ToolClass } from "@commissary/contract/tools";
import { fullToolName } from "./names.ts";
import type { StoredTool, ToolOverride } from "./store.ts";
import type { Toolkit } from "./toolkit.ts";

/** What {@link resolveTools} looks at. */
export interface ToolSet {
  readonly toolkits: ReadonlyArray<Toolkit>;
  readonly tools: ReadonlyArray<StoredTool>;
  readonly overrides: ReadonlyArray<ToolOverride>;
  /** Whose private toolkits are in the set; undefined: the org's toolkits only. */
  readonly member: string | undefined;
}

export interface ResolvedTool {
  readonly toolkit: Toolkit;
  readonly upstreamName: string;
  /** The tool as its source last listed it; undefined when it no longer does (`missing`). */
  readonly tool: StoredTool | undefined;
  readonly override: ToolOverride | undefined;
  /** The full name. */
  readonly name: string;
  readonly description: string | undefined;
  readonly toolClass: ToolClass;
  /** What a call costs in micro-USD (#199): the tool's override's price, else its toolkit's; undefined: free. */
  readonly priceMicros: number | undefined;
  readonly shortened: boolean;
  readonly renamed: boolean;
  readonly hidden: boolean;
  readonly clash: boolean;
  readonly missing: boolean;
  /** A deprecated OpenAPI operation: hidden unless its override shows it. */
  readonly deprecated: boolean;
}

export interface Resolution {
  /** Every tool of the set's toolkits, by toolkit and then the source's order; overrides of missing tools last. */
  readonly tools: ReadonlyArray<ResolvedTool>;
  /** Org toolkits left out because the member's private toolkit has their name. */
  readonly shadowed: ReadonlySet<string>;
  /** The member's private toolkits that have an org toolkit's name. */
  readonly renameSuggested: ReadonlySet<string>;
}

/** The stable id of a tool: its toolkit's id and its upstream name (ADR 0037). */
export const stableId = (toolkitId: string, upstreamName: string): string =>
  `${toolkitId}:${upstreamName}`;

/** Methods of an OpenAPI operation that read (#203); every other one writes. */
const READING_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * A tool's class from its source (ADR 0038): an MCP tool reads only with `readOnlyHint: true`; an OpenAPI operation
 * reads when its method is `GET` or `HEAD`.
 */
const sourceClass = (tool: StoredTool | undefined): ToolClass => {
  if (tool?.operation !== undefined)
    return READING_METHODS.has(tool.operation.method) ? "read" : "write";

  return tool?.annotations?.["readOnlyHint"] === true ? "read" : "write";
};

const resolved = (
  toolkit: Toolkit,
  upstreamName: string,
  tool: StoredTool | undefined,
  override: ToolOverride | undefined,
): ResolvedTool => {
  const full = fullToolName(toolkit.name, override?.name ?? upstreamName);
  const deprecated = tool?.operation?.deprecated === true;

  return {
    toolkit,
    upstreamName,
    tool,
    override,
    name: full.name,
    description: override?.description ?? tool?.description,
    toolClass: override?.toolClass ?? sourceClass(tool),
    priceMicros: override?.priceMicros ?? toolkit.priceMicros,
    shortened: full.shortened,
    renamed: override?.name !== undefined,
    // A deprecated operation is hidden by default; an override that shows it (or hides it) decides.
    hidden: override?.hidden === true || (deprecated && override?.shown !== true),
    clash: false,
    missing: tool === undefined,
    deprecated,
  };
};

/** Which of two tools with one full name keeps it: negative when `a` does. */
const precedence = (a: ResolvedTool, b: ResolvedTool): number =>
  Number(b.renamed) - Number(a.renamed) ||
  (a.tool?.firstSeen ?? 0) - (b.tool?.firstSeen ?? 0) ||
  a.toolkit.createdAt - b.toolkit.createdAt ||
  a.toolkit.id.localeCompare(b.toolkit.id) ||
  (a.tool?.position ?? 0) - (b.tool?.position ?? 0);

export const resolveTools = (set: ToolSet): Resolution => {
  const inSet = set.toolkits.filter(
    (toolkit) => toolkit.owner === undefined || toolkit.owner === set.member,
  );

  const privateNames = new Set(
    inSet.filter((toolkit) => toolkit.owner !== undefined).map((toolkit) => toolkit.name),
  );

  const orgNames = new Set(
    inSet.filter((toolkit) => toolkit.owner === undefined).map((toolkit) => toolkit.name),
  );

  const shadowed = new Set(
    inSet
      .filter((toolkit) => toolkit.owner === undefined && privateNames.has(toolkit.name))
      .map((toolkit) => toolkit.id),
  );

  const renameSuggested = new Set(
    inSet
      .filter((toolkit) => toolkit.owner !== undefined && orgNames.has(toolkit.name))
      .map((toolkit) => toolkit.id),
  );

  const active = inSet.filter((toolkit) => !shadowed.has(toolkit.id));
  const overrides = new Map(set.overrides.map((o) => [stableId(o.toolkitId, o.upstreamName), o]));
  const listed: Array<ResolvedTool> = [];
  const missing: Array<ResolvedTool> = [];

  for (const toolkit of active) {
    const tools = set.tools.filter((tool) => tool.toolkitId === toolkit.id);
    const names = new Set(tools.map((tool) => tool.upstreamName));

    for (const tool of tools)
      listed.push(
        resolved(
          toolkit,
          tool.upstreamName,
          tool,
          overrides.get(stableId(toolkit.id, tool.upstreamName)),
        ),
      );

    for (const override of set.overrides)
      if (override.toolkitId === toolkit.id && !names.has(override.upstreamName))
        missing.push(resolved(toolkit, override.upstreamName, undefined, override));
  }

  const byName = new Map<string, Array<ResolvedTool>>();

  for (const tool of listed) {
    if (tool.hidden) continue;
    const group = byName.get(tool.name);

    if (group === undefined) byName.set(tool.name, [tool]);
    else group.push(tool);
  }

  const clashing = new Set<ResolvedTool>();

  for (const group of byName.values())
    for (const loser of group.toSorted(precedence).slice(1)) clashing.add(loser);

  return {
    tools: [
      ...listed.map((tool) => (clashing.has(tool) ? { ...tool, clash: true } : tool)),
      ...missing,
    ],
    shadowed,
    renameSuggested,
  };
};

/** Whether a tool of the set is served: listed by its source, not hidden, and holding its full name. */
export const isServed = (tool: ResolvedTool): boolean =>
  !tool.hidden && !tool.clash && !tool.missing;

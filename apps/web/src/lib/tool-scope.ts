// The tool scope editor's model (#200, GLOSSARY "Tool scope"): which of the tools a member may use an API key (or an MCP
// client signed in through Commissary Cloud's consent page) may use. A draft says, per toolkit, none, all, its read
// tools or the tools picked by hand, as a tool grant selects them; the scope it sends names only the toolkits it gives
// something of, and `null` (every tool the member may use) when the draft is not limited. Pure: no DOM, tested in
// test/tool-scope.test.ts.
import type { ApiKeyView, ToolScope } from "@commissary/contract/api-keys";
import type { UsableTool, UsableTools } from "@commissary/contract/tools";

/** What a limited scope gives of one toolkit. */
export type ToolkitChoice = "none" | "all" | "read" | "named";

export const TOOLKIT_CHOICES: ReadonlyArray<{
  readonly id: ToolkitChoice;
  readonly label: string;
}> = [
  { id: "none", label: "None" },
  { id: "all", label: "All tools" },
  { id: "read", label: "Read tools" },
  { id: "named", label: "Pick tools" },
];

export interface ToolkitPick {
  readonly choice: ToolkitChoice;
  /** The stable ids picked by hand (`named`), kept while another choice is shown. */
  readonly ids: ReadonlyArray<string>;
}

export interface ScopeDraft {
  /** `false`: every tool the member may use, now and later (no scope). */
  readonly limited: boolean;
  /** By toolkit id; a toolkit without a pick gives nothing. */
  readonly picks: Readonly<Record<string, ToolkitPick>>;
}

/** No scope: every tool the member may use. */
export const EVERY_TOOL: ScopeDraft = { limited: false, picks: {} };

const NO_PICK: ToolkitPick = { choice: "none", ids: [] };

/** The draft of a stored scope (`undefined` or `null`: none). */
export const draftOfScope = (scope: ToolScope | null | undefined): ScopeDraft => {
  if (scope === null || scope === undefined) return EVERY_TOOL;

  const picks: Record<string, ToolkitPick> = {};

  for (const entry of scope)
    picks[entry.toolkit] =
      entry.tools.kind === "named"
        ? { choice: "named", ids: [...entry.tools.ids] }
        : { choice: entry.tools.kind, ids: [] };

  return { limited: true, picks };
};

export const pickOf = (draft: ScopeDraft, toolkit: string): ToolkitPick =>
  draft.picks[toolkit] ?? NO_PICK;

/** The scope a draft sends: `null` when it is not limited; one entry per toolkit it gives something of. */
export const scopeOfDraft = (draft: ScopeDraft): ToolScope | null => {
  if (!draft.limited) return null;

  return Object.entries(draft.picks).flatMap(([toolkit, pick]): ToolScope => {
    switch (pick.choice) {
      case "none":
        return [];
      case "named":
        return pick.ids.length === 0 ? [] : [{ toolkit, tools: { kind: "named", ids: pick.ids } }];
      default:
        return [{ toolkit, tools: { kind: pick.choice } }];
    }
  });
};

/** Limits the draft (or lifts the limit); a limit starts from the toolkits it picked before. */
export const setLimited = (draft: ScopeDraft, limited: boolean): ScopeDraft => ({
  ...draft,
  limited,
});

/** Gives `toolkit` the choice `choice`. */
export const setChoice = (
  draft: ScopeDraft,
  toolkit: string,
  choice: ToolkitChoice,
): ScopeDraft => ({
  ...draft,
  picks: { ...draft.picks, [toolkit]: { ...pickOf(draft, toolkit), choice } },
});

/** Picks or unpicks one tool of `toolkit` (its choice becomes `named`). */
export const toggleTool = (draft: ScopeDraft, toolkit: string, tool: string): ScopeDraft => {
  const pick = pickOf(draft, toolkit);
  const ids = pick.ids.includes(tool) ? pick.ids.filter((id) => id !== tool) : [...pick.ids, tool];

  return { ...draft, picks: { ...draft.picks, [toolkit]: { choice: "named", ids } } };
};

/** The tools of `usable` a draft gives, now. */
export const toolsGiven = (draft: ScopeDraft, usable: UsableTools): ReadonlyArray<UsableTool> =>
  usable.toolkits.flatMap((toolkit) => {
    if (!draft.limited) return toolkit.tools;
    const pick = pickOf(draft, toolkit.id);

    switch (pick.choice) {
      case "none":
        return [];
      case "all":
        return toolkit.tools;
      case "read":
        return toolkit.tools.filter((tool) => tool.tool_class === "read");
      case "named":
        return toolkit.tools.filter((tool) => pick.ids.includes(tool.id));
    }
  });

/** "No tools", "1 tool", "12 tools". */
export const toolCountText = (count: number): string => {
  if (count === 0) return "No tools";

  return count === 1 ? "1 tool" : `${count} tools`;
};

/** What a draft gives, in words, for the line under the editor. */
export const draftSummary = (draft: ScopeDraft, usable: UsableTools): string => {
  const given = toolsGiven(draft, usable).length;

  if (!draft.limited)
    return `Every tool you may use: ${toolCountText(given).toLowerCase()} now, and tools you get later.`;

  return given === 0
    ? "No tools: pick a toolkit's tools, or allow every tool."
    : `${toolCountText(given)}, and only those.`;
};

/** A key's Tools column: "Every tool" without a scope, else how many it may use now. */
export const keyToolsText = (key: Pick<ApiKeyView, "tool_scope" | "tool_count">): string => {
  const count = key.tool_count === undefined ? "" : ` (${toolCountText(key.tool_count)})`;

  return key.tool_scope === undefined
    ? `Every tool${count}`
    : key.tool_count === undefined
      ? "Limited"
      : toolCountText(key.tool_count);
};

/** What a key's scope names that is gone, in words; `undefined` when nothing is. */
export const missingText = (key: Pick<ApiKeyView, "tool_scope_missing">): string | undefined => {
  const missing = key.tool_scope_missing?.length ?? 0;

  if (missing === 0) return undefined;

  return missing === 1
    ? "1 tool or toolkit it names is gone"
    : `${missing} tools or toolkits it names are gone`;
};

/** Whether the editor has anything to pick from. */
export const hasTools = (usable: UsableTools): boolean =>
  usable.toolkits.some((toolkit) => toolkit.tools.length > 0);

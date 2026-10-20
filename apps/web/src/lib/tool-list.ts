// A toolkit's tool list (#208, ADR 0037, ADR 0038, GLOSSARY "Tool override", "Full name"): what each flag tells the
// toolkit's managers, and the override each edit sends. An override is written whole by the tool's upstream name at its
// revision, so an edit carries what it does not change (the price an org admin set, #199). Pure: no DOM, tested in
// test/tool-list.test.ts.
import type { SetToolOverride, ToolClass, ToolView } from "@commissary/contract/tools";

/**
 * One thing a flag says of a tool: `failing` when it cannot be called as it is listed (gone upstream), `note` for what
 * its managers should tidy (a name to change) or know (hidden, deprecated).
 */
export interface ToolNote {
  readonly text: string;
  readonly severity: "failing" | "note";
}

/** What a tool's flags say, most pressing first. */
export const toolNotes = (tool: ToolView): ReadonlyArray<ToolNote> => {
  const { flags } = tool;

  const notes: ReadonlyArray<ToolNote | undefined> = [
    flags.missing
      ? {
          text: "Gone upstream: its source no longer lists it. Reset its override to drop it.",
          severity: "failing",
        }
      : undefined,
    flags.clash
      ? {
          text: "Shadowed: another tool took its full name after a listing. Rename it to show it.",
          severity: "note",
        }
      : undefined,
    flags.shortened
      ? {
          text: "Its full name was cut to 46 characters and ends in a hash: rename it.",
          severity: "note",
        }
      : undefined,
    flags.deprecated === true && flags.hidden
      ? { text: "Deprecated upstream, so hidden until you show it.", severity: "note" }
      : flags.deprecated === true
        ? { text: "Deprecated upstream, shown by an override.", severity: "note" }
        : undefined,
    flags.hidden && flags.deprecated !== true
      ? { text: "Hidden by an override.", severity: "note" }
      : undefined,
  ];

  return notes.flatMap((note) => (note === undefined ? [] : [note]));
};

/** An override as its editor holds it: empty text and no class leave the tool as its source describes it. */
export interface OverrideDraft {
  readonly hidden: boolean;
  /** The tool's own name, after `<toolkit>_`. */
  readonly name: string;
  readonly description: string;
  readonly class: ToolClass | "";
}

export const draftOfTool = (tool: ToolView): OverrideDraft => ({
  hidden: tool.flags.hidden,
  name: tool.override?.name ?? "",
  description: tool.override?.description ?? "",
  class: tool.override?.class ?? "",
});

/** The revision an edit of the tool's override names in `If-Match`: 0 while it has none. */
export const overrideRevision = (tool: ToolView): number => tool.override?.revision ?? 0;

const priceOf = (tool: ToolView) =>
  tool.override?.price_micros === undefined ? {} : { price_micros: tool.override.price_micros };

/**
 * The whole override an edit sends. Hiding sets `hidden: true`; a deprecated tool, hidden by default, is shown with
 * `hidden: false`. The price an org admin set stays.
 */
export const overrideBody = (tool: ToolView, draft: OverrideDraft): SetToolOverride => {
  const name = draft.name.trim();
  const description = draft.description.trim();

  return {
    tool: tool.upstream_name,
    ...(draft.hidden ? { hidden: true } : tool.flags.deprecated === true ? { hidden: false } : {}),
    ...(name === "" ? {} : { name }),
    ...(description === "" ? {} : { description }),
    ...(draft.class === "" ? {} : { class: draft.class }),
    ...priceOf(tool),
  };
};

/** The override that returns a tool to what its source says, keeping its price. */
export const resetBody = (tool: ToolView): SetToolOverride => ({
  tool: tool.upstream_name,
  ...priceOf(tool),
});

/** A full name's limit (ADR 0037): it fits after a client's `mcp__<server>__` prefix. */
const FULL_NAME_MAX = 46;

/** Why a tool's new name would be refused, or `undefined` (empty keeps the source's name). */
export const toolNameProblem = (name: string, toolkitName: string): string | undefined => {
  const trimmed = name.trim();

  if (trimmed === "") return undefined;

  if (!/^[a-z0-9_]+$/.test(trimmed)) return "A name holds lowercase letters, digits and _ only.";
  const length = toolkitName.length + 1 + trimmed.length;

  return length > FULL_NAME_MAX
    ? `${toolkitName}_ and the name are ${length} characters; a full name is at most ${FULL_NAME_MAX}.`
    : undefined;
};

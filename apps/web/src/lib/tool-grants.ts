// The Grants page's tool grants (#209, ADR 0038, GLOSSARY "Grant"): a grant as its form edits it (a subject, an org
// toolkit and which of its tools: all, its read tools or named ones), what is wrong with a draft, the body a draft
// becomes, how named tools read by their current names with the vanished ones marked missing, and how the grants read
// by member, by team or by toolkit. Pure: no DOM, tested in test/tool-grants.test.ts.
import type {
  GrantSubject,
  ToolGrant,
  ToolGrantBody,
  ToolSelection,
} from "@commissary/contract/grants";
import type { ToolkitView, ToolView } from "@commissary/contract/tools";
import { asSentence } from "./failure.ts";
import { type Directory, subjectLabel } from "./grants.ts";
import { upstreamNameOf } from "./tool-id.ts";

export type ToolGrantsView = "member" | "team" | "toolkit";

export const TOOL_GRANTS_VIEWS: ReadonlyArray<{
  readonly view: ToolGrantsView;
  readonly label: string;
}> = [
  { view: "member", label: "By member" },
  { view: "team", label: "By team" },
  { view: "toolkit", label: "By toolkit" },
];

/** Each field as chosen. `ids` are the stable ids of the named tools. */
export interface ToolGrantDraft {
  readonly subjectKind: GrantSubject["kind"];
  readonly subjectId: string;
  /** The org toolkit's id. */
  readonly toolkit: string;
  readonly selection: ToolSelection["kind"];
  readonly ids: ReadonlyArray<string>;
}

/** The message of each field that is wrong; a selection the subject already holds is reported under `tools`. */
export interface ToolGrantErrors {
  subject?: string;
  toolkit?: string;
  tools?: string;
}

export const EMPTY_TOOL_GRANT_DRAFT: ToolGrantDraft = {
  subjectKind: "member",
  subjectId: "",
  toolkit: "",
  selection: "all",
  ids: [],
};

/** What a selection can be, as its picker words it. */
export const TOOL_SELECTIONS: ReadonlyArray<{
  readonly kind: ToolSelection["kind"];
  readonly label: string;
  readonly hint: string;
}> = [
  {
    kind: "all",
    label: "All tools",
    hint: "Every tool of the toolkit, including ones it lists later.",
  },
  {
    kind: "read",
    label: "Read tools",
    hint: "The tools that only read. Reclassifying a tool changes what this gives at once.",
  },
  { kind: "named", label: "Named tools", hint: "Only the tools you pick." },
];

export const draftOfToolGrant = (grant: ToolGrant): ToolGrantDraft => ({
  subjectKind: grant.subject.kind,
  subjectId: grant.subject.kind === "everyone" ? "" : grant.subject.id,
  toolkit: grant.toolkit,
  selection: grant.tools.kind,
  ids: grant.tools.kind === "named" ? grant.tools.ids : [],
});

const subjectOf = (draft: ToolGrantDraft): GrantSubject =>
  draft.subjectKind === "everyone"
    ? { kind: "everyone" }
    : { kind: draft.subjectKind, id: draft.subjectId.trim() };

/** The selection as the server keeps it: named ids de-duplicated and sorted, so one set is one selection. */
const selectionOf = (draft: ToolGrantDraft): ToolSelection =>
  draft.selection === "named"
    ? { kind: "named", ids: [...new Set(draft.ids.map((id) => id.trim()))].toSorted() }
    : { kind: draft.selection };

export const toolGrantBody = (draft: ToolGrantDraft): ToolGrantBody => ({
  subject: subjectOf(draft),
  toolkit: draft.toolkit,
  tools: selectionOf(draft),
});

const sameSubject = (a: GrantSubject, b: GrantSubject): boolean =>
  a.kind === b.kind && (a.kind === "everyone" || (b.kind !== "everyone" && a.id === b.id));

/** Whether two selections are the one the server stores once: the same kind and, for named tools, the same set. */
export const sameSelection = (a: ToolSelection, b: ToolSelection): boolean => {
  if (a.kind !== b.kind) return false;

  if (a.kind !== "named" || b.kind !== "named") return true;

  const mine = [...new Set(a.ids)].toSorted();
  const theirs = [...new Set(b.ids)].toSorted();

  return mine.length === theirs.length && mine.every((id, index) => id === theirs[index]);
};

/** The grant that already gives the draft's subject this selection of the toolkit, other than the one being edited. */
const heldAlready = (
  draft: ToolGrantDraft,
  grants: ReadonlyArray<ToolGrant>,
  editing?: ToolGrant,
): ToolGrant | undefined =>
  grants.find(
    (grant) =>
      grant.id !== editing?.id &&
      grant.toolkit === draft.toolkit &&
      sameSubject(grant.subject, subjectOf(draft)) &&
      sameSelection(grant.tools, selectionOf(draft)),
  );

/** What is wrong with a draft, mirroring the server's checks; empty when it will do. */
export const validateToolGrant = (
  draft: ToolGrantDraft,
  grants: ReadonlyArray<ToolGrant>,
  editing?: ToolGrant,
): ToolGrantErrors => {
  const errors: ToolGrantErrors = {};

  if (draft.subjectKind !== "everyone" && draft.subjectId.trim() === "")
    errors.subject = draft.subjectKind === "member" ? "Choose a member." : "Choose a team.";

  if (draft.toolkit === "") errors.toolkit = "Choose a toolkit.";

  if (draft.selection === "named" && draft.ids.length === 0)
    errors.tools = "Pick at least one tool, or give all of them or its read tools.";

  if (
    errors.subject === undefined &&
    errors.toolkit === undefined &&
    errors.tools === undefined &&
    heldAlready(draft, grants, editing) !== undefined
  )
    errors.tools =
      "This subject already holds exactly this on the toolkit. Edit that grant instead.";

  return errors;
};

export const hasToolGrantErrors = (errors: ToolGrantErrors): boolean =>
  Object.keys(errors).length > 0;

/** What a refused tool grant write says, by the server's error code. */
export const toolGrantProblem = (error: string | undefined, message: string): string => {
  switch (error) {
    case "conflict":
      return "The tool grants changed elsewhere while this page was open, or this subject already holds that selection. Reload to see the current grants, then make the edit again.";
    case "invalid":
      return asSentence(message);
    default:
      return message;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// The toolkits a grant may name

/**
 * The toolkits whose shared credential a grant can name: the org's own (a private toolkit is its owner's alone), the
 * browser and sandbox toolkits among them, and neither one that takes a private credential only (nothing shared to
 * grant) nor the agents toolkit, whose tools no grant gates (a caller may run an agent).
 */
export const grantableToolkits = (
  toolkits: ReadonlyArray<ToolkitView>,
): ReadonlyArray<ToolkitView> =>
  toolkits
    .filter(
      (toolkit) => !toolkit.private && toolkit.accepts !== "private" && toolkit.kind !== "agents",
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));

/** A toolkit's name, or its id once it is gone. */
export const toolkitName = (id: string, toolkits: ReadonlyArray<ToolkitView>): string =>
  toolkits.find((toolkit) => toolkit.id === id)?.name ?? id;

// ---------------------------------------------------------------------------------------------------------------
// Named tools

/** A named tool as a grant lists it: its current full name, or what is left of it once its source stops listing it. */
export interface NamedTool {
  /** The stable id. */
  readonly id: string;
  /** The tool's full name now; the upstream name (after the toolkit's id) while it is missing. */
  readonly name: string;
  readonly missing: boolean;
}

/**
 * A grant's named tools by their current names, sorted by name. A tool the toolkit's list no longer has (the server
 * says so in `missing`, and a tool list read since may say so too) is marked missing: it gives nothing until its
 * source lists it again. `tools` is the toolkit's tool list; `undefined` until it is read, when only the server's
 * `missing` ids are marked.
 */
export const namedTools = (
  grant: Pick<ToolGrant, "tools" | "missing">,
  tools: ReadonlyArray<ToolView> | undefined,
): ReadonlyArray<NamedTool> => {
  if (grant.tools.kind !== "named") return [];

  return grant.tools.ids
    .map((id): NamedTool => {
      const listed = tools?.find((tool) => tool.id === id);

      const missing =
        (grant.missing ?? []).includes(id) ||
        (tools !== undefined && (listed === undefined || listed.flags.missing));

      return {
        id,
        name: listed === undefined || listed.flags.missing ? upstreamNameOf(id) : listed.name,
        missing,
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/** What a selection says in a table cell, apart from the names of named tools. */
export const selectionLabel = (selection: ToolSelection): string => {
  switch (selection.kind) {
    case "all":
      return "All tools";
    case "read":
      return "Read tools";
    case "named":
      return selection.ids.length === 1 ? "1 named tool" : `${selection.ids.length} named tools`;
  }
};

/**
 * The tools a picker offers: those its toolkit lists (not gone upstream), by full name, narrowed to `query`
 * (case-insensitive, against the full name and the description). A hidden tool is offered too, since a grant that
 * names it takes effect when it is shown again; the picker marks it.
 */
export const pickableTools = (
  tools: ReadonlyArray<ToolView>,
  query: string,
): ReadonlyArray<ToolView> => {
  const needle = query.trim().toLowerCase();

  return tools
    .filter(
      (tool) =>
        !tool.flags.missing &&
        (needle === "" ||
          tool.name.toLowerCase().includes(needle) ||
          (tool.description ?? "").toLowerCase().includes(needle)),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/** `ids` with `id` added, or taken out when it is there. */
export const toggledId = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  ids.includes(id) ? ids.filter((each) => each !== id) : [...ids, id];

// ---------------------------------------------------------------------------------------------------------------
// Reading the grants

/** A heading and the grants listed under it. */
export interface ToolGrantGroup {
  readonly key: string;
  readonly label: string;
  readonly grants: ReadonlyArray<ToolGrant>;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const SUBJECT_RANK = { everyone: 0, team: 1, member: 2 } as const;

const SELECTION_RANK = { all: 0, read: 1, named: 2 } as const;

/** Everyone first, then teams, then members, each by name; by toolkit, then the widest selection first. */
export const sortToolGrants = (
  grants: ReadonlyArray<ToolGrant>,
  directory: Directory,
  toolkits: ReadonlyArray<ToolkitView>,
): ReadonlyArray<ToolGrant> =>
  grants.toSorted(
    (a, b) =>
      SUBJECT_RANK[a.subject.kind] - SUBJECT_RANK[b.subject.kind] ||
      compare(subjectLabel(a.subject, directory), subjectLabel(b.subject, directory)) ||
      compare(toolkitName(a.toolkit, toolkits), toolkitName(b.toolkit, toolkits)) ||
      SELECTION_RANK[a.tools.kind] - SELECTION_RANK[b.tools.kind],
  );

const appliesToMember = (grant: ToolGrant, member: Directory["members"][number]): boolean => {
  switch (grant.subject.kind) {
    case "everyone":
      return true;
    case "member":
      return grant.subject.id === member.id;
    case "team":
      return member.teams.includes(grant.subject.id);
  }
};

/**
 * The tool grants read by member (what reaches each member: their own, their teams' and everyone's), by team (what each
 * team and everyone is given) or by toolkit (who may use each toolkit's shared credential).
 */
export const groupToolGrants = (
  grants: ReadonlyArray<ToolGrant>,
  view: ToolGrantsView,
  directory: Directory,
  toolkits: ReadonlyArray<ToolkitView>,
): ReadonlyArray<ToolGrantGroup> => {
  const sorted = sortToolGrants(grants, directory, toolkits);

  switch (view) {
    case "member":
      return directory.members
        .toSorted((a, b) => compare(a.email, b.email))
        .map((member) => ({
          key: member.id,
          label: member.email,
          grants: sorted.filter((grant) => appliesToMember(grant, member)),
        }));
    case "team":
      return [
        {
          key: "everyone",
          label: "Everyone",
          grants: sorted.filter((grant) => grant.subject.kind === "everyone"),
        },
        ...directory.teams
          .toSorted((a, b) => compare(a.name, b.name))
          .map((team) => ({
            key: team.id,
            label: team.name,
            grants: sorted.filter(
              (grant) => grant.subject.kind === "team" && grant.subject.id === team.id,
            ),
          })),
      ];
    case "toolkit": {
      const byToolkit = new Map<string, ToolGrant[]>();

      for (const grant of sorted)
        byToolkit.set(grant.toolkit, [...(byToolkit.get(grant.toolkit) ?? []), grant]);

      return [...byToolkit]
        .map(([id, own]) => ({ key: id, label: toolkitName(id, toolkits), grants: own }))
        .toSorted((a, b) => compare(a.label, b.label));
    }
  }
};

/** The toolkits that hold a shared credential but no grant: nobody reaches them yet (no default grant, ADR 0038). */
export const ungrantedToolkits = (
  toolkits: ReadonlyArray<ToolkitView>,
  grants: ReadonlyArray<ToolGrant>,
): ReadonlyArray<ToolkitView> =>
  grantableToolkits(toolkits).filter(
    (toolkit) =>
      (toolkit.built_in === true || toolkit.credentials.shared !== undefined) &&
      !grants.some((grant) => grant.toolkit === toolkit.id),
  );

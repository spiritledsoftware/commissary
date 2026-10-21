// The Grants page's tool grants (#209, ADR 0038): which tools of which org toolkits a member, a team or everyone may use
// through the toolkit's shared credential, read by member, by team or by toolkit. A grant gives all of a toolkit's
// tools, its read tools or named ones, picked from the toolkit's tool list and shown by their current names; a named
// tool its source stopped listing is marked missing. Edits go with the grant's revision (`If-Match`).
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, Pencil, Plus, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { ToolGrant } from "@commissary/contract/grants";
import type { ToolkitView } from "@commissary/contract/tools";
import { saveToolGrantAtom, toolkitToolsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import type { Directory } from "../lib/grants.ts";
import { subjectLabel } from "../lib/grants.ts";
import {
  draftOfToolGrant,
  EMPTY_TOOL_GRANT_DRAFT,
  groupToolGrants,
  hasToolGrantErrors,
  namedTools,
  pickableTools,
  selectionLabel,
  TOOL_GRANTS_VIEWS,
  TOOL_SELECTIONS,
  type ToolGrantDraft,
  type ToolGrantErrors,
  type ToolGrantsView,
  toolGrantBody,
  toolGrantProblem,
  toggledId,
  toolkitName,
  ungrantedToolkits,
  validateToolGrant,
  grantableToolkits,
} from "../lib/tool-grants.ts";
import { upstreamNameOf } from "../lib/tool-id.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Grants.module.css";

type Note =
  | { readonly tone: "done"; readonly text: string }
  | { readonly tone: "problem"; readonly text: string; readonly stale: boolean };

const SUBJECTS: ReadonlyArray<{
  readonly kind: ToolGrantDraft["subjectKind"];
  readonly label: string;
}> = [
  { kind: "member", label: "A member" },
  { kind: "team", label: "A team" },
  { kind: "everyone", label: "Everyone" },
];

const focusFirstInvalid = (form: HTMLFormElement) => {
  requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
};

/** The checkbox list of a toolkit's tools a named selection is picked from. */
const ToolPicker = ({
  toolkit,
  chosen,
  onToggle,
  invalid,
  describedBy,
}: {
  readonly toolkit: string;
  readonly chosen: ReadonlyArray<string>;
  readonly onToggle: (id: string) => void;
  readonly invalid: boolean;
  readonly describedBy: string;
}) => {
  const ids = useId();
  const [query, setQuery] = useState("");
  const result = useAtomValue(toolkitToolsAtom(toolkit));

  if (AsyncResult.isFailure(result))
    return <p className={styles["hint"]}>Could not read this toolkit&rsquo;s tools.</p>;

  if (!AsyncResult.isSuccess(result))
    return (
      <p className={styles["hint"]} aria-busy="true">
        Loading its tools…
      </p>
    );

  const listed = result.value.tools;
  const shown = pickableTools(listed, query);

  // Tools the grant names that the list no longer has stay in the picker, marked, so saving can drop them.
  const gone = chosen.filter((id) => !listed.some((tool) => tool.id === id && !tool.flags.missing));

  return (
    <div className={styles["picker"]}>
      <label className={kit["visuallyHidden"]} htmlFor={`${ids}-search`}>
        Search this toolkit&rsquo;s tools
      </label>
      <input
        id={`${ids}-search`}
        className={kit["input"]}
        type="search"
        placeholder="Search tools"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul
        className={styles["pickList"]}
        aria-label="Tools to give"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        tabIndex={0}
      >
        {gone.map((id) => (
          <li key={id}>
            <label className={styles["pick"]}>
              <input type="checkbox" checked onChange={() => onToggle(id)} />
              <span className={styles["pickName"]}>{upstreamNameOf(id)}</span>
              <span className={styles["secondary"]}>missing: its source no longer lists it</span>
            </label>
          </li>
        ))}
        {shown.map((tool) => (
          <li key={tool.id}>
            <label className={styles["pick"]}>
              <input
                type="checkbox"
                checked={chosen.includes(tool.id)}
                onChange={() => onToggle(tool.id)}
              />
              <span className={styles["pickName"]}>{tool.name}</span>
              <span className={styles["secondary"]}>
                {tool.class === "write" ? "write" : "read"}
                {tool.flags.hidden ? ", hidden" : ""}
              </span>
            </label>
          </li>
        ))}
        {shown.length === 0 && gone.length === 0 ? (
          <li className={styles["hint"]}>
            {listed.length === 0 ? "This toolkit lists no tools yet." : "No tool matches."}
          </li>
        ) : null}
      </ul>
    </div>
  );
};

const ToolGrantForm = ({
  initial,
  editing,
  existing,
  directory,
  toolkits,
  busy,
  onSave,
  onCancel,
}: {
  readonly initial: ToolGrantDraft;
  readonly editing: ToolGrant | undefined;
  readonly existing: ReadonlyArray<ToolGrant>;
  readonly directory: Directory;
  readonly toolkits: ReadonlyArray<ToolkitView>;
  readonly busy: boolean;
  readonly onSave: (draft: ToolGrantDraft) => Promise<boolean>;
  readonly onCancel: () => void;
}) => {
  const ids = useId();
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const errors: ToolGrantErrors = validateToolGrant(draft, existing, editing);
  const shown: ToolGrantErrors = tried ? errors : {};
  const offered = grantableToolkits(toolkits);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);

    if (hasToolGrantErrors(errors)) return focusFirstInvalid(event.currentTarget);

    if (await onSave(draft)) setTried(false);
  };

  const note = (field: keyof ToolGrantErrors, hint: string) => (
    <span
      id={`${ids}-${field}-note`}
      className={shown[field] === undefined ? styles["hint"] : kit["fieldError"]}
    >
      {shown[field] ?? hint}
    </span>
  );

  const selection = TOOL_SELECTIONS.find((entry) => entry.kind === draft.selection);

  return (
    <form
      className={styles["form"]}
      onSubmit={submit}
      noValidate
      aria-label={editing === undefined ? "Add a tool grant" : "Edit the tool grant"}
    >
      <div className={styles["pair"]}>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-subject-kind`}>
            Who
          </label>
          <select
            id={`${ids}-subject-kind`}
            className={kit["input"]}
            value={draft.subjectKind}
            onChange={(event) =>
              setDraft({
                ...draft,
                subjectKind:
                  SUBJECTS.find((entry) => entry.kind === event.target.value)?.kind ?? "member",
                subjectId: "",
              })
            }
          >
            {SUBJECTS.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        {draft.subjectKind === "everyone" ? null : (
          <div className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-subject`}>
              {draft.subjectKind === "member" ? "Member" : "Team"}
            </label>
            <select
              id={`${ids}-subject`}
              className={kit["input"]}
              value={draft.subjectId}
              aria-invalid={shown.subject !== undefined}
              aria-describedby={`${ids}-subject-note`}
              onChange={(event) => setDraft({ ...draft, subjectId: event.target.value })}
            >
              <option value="">Choose…</option>
              {draft.subjectKind === "member"
                ? directory.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.email}
                    </option>
                  ))
                : directory.teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
            </select>
            {note("subject", "")}
          </div>
        )}
      </div>
      <div className={styles["pair"]}>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-toolkit`}>
            Toolkit
          </label>
          <select
            id={`${ids}-toolkit`}
            className={kit["input"]}
            value={draft.toolkit}
            aria-invalid={shown.toolkit !== undefined}
            aria-describedby={`${ids}-toolkit-note`}
            onChange={(event) => setDraft({ ...draft, toolkit: event.target.value, ids: [] })}
          >
            <option value="">Choose…</option>
            {offered.map((toolkit) => (
              <option key={toolkit.id} value={toolkit.id}>
                {toolkit.name}
              </option>
            ))}
            {draft.toolkit === "" ||
            offered.some((toolkit) => toolkit.id === draft.toolkit) ? null : (
              <option value={draft.toolkit}>{toolkitName(draft.toolkit, toolkits)}</option>
            )}
          </select>
          {note("toolkit", "")}
        </div>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-selection`}>
            Tools
          </label>
          <select
            id={`${ids}-selection`}
            className={kit["input"]}
            value={draft.selection}
            onChange={(event) =>
              setDraft({
                ...draft,
                selection:
                  TOOL_SELECTIONS.find((entry) => entry.kind === event.target.value)?.kind ?? "all",
              })
            }
          >
            {TOOL_SELECTIONS.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
          <span className={styles["hint"]}>{selection?.hint}</span>
        </div>
      </div>
      {draft.selection === "named" ? (
        <div className={kit["field"]}>
          <span className={kit["fieldLabel"]}>Pick the tools</span>
          {draft.toolkit === "" ? (
            <span className={styles["hint"]}>Choose a toolkit to pick from its tools.</span>
          ) : (
            <ToolPicker
              key={draft.toolkit}
              toolkit={draft.toolkit}
              chosen={draft.ids}
              invalid={shown.tools !== undefined}
              describedBy={`${ids}-tools-note`}
              onToggle={(id) => setDraft({ ...draft, ids: toggledId(draft.ids, id) })}
            />
          )}
          {note("tools", "")}
        </div>
      ) : (
        note("tools", "")
      )}
      <div className={styles["formActions"]}>
        <button type="submit" className={kit["primary"]} disabled={busy}>
          {editing === undefined ? (
            <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          ) : (
            <Check aria-hidden="true" size={16} strokeWidth={2.25} />
          )}
          {busy ? "Saving…" : editing === undefined ? "Add grant" : "Save grant"}
        </button>
        <button type="button" className={styles["quiet"]} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};

/** A named selection's tools by their current names, read from the toolkit's tool list. */
const NamedGiven = ({ grant }: { readonly grant: ToolGrant }) => {
  const result = useAtomValue(toolkitToolsAtom(grant.toolkit));
  const tools = AsyncResult.isSuccess(result) ? result.value.tools : undefined;

  return (
    <span className={styles["chips"]}>
      {namedTools(grant, tools).map((tool) => (
        <code key={tool.id} className={styles["chip"]}>
          {tool.name}
          {tool.missing ? <span className={styles["missingMark"]}>missing</span> : null}
        </code>
      ))}
    </span>
  );
};

/** What a grant gives, apart from the toolkit: its selection, with a named one's tools by their current names. */
const Given = ({ grant }: { readonly grant: ToolGrant }) =>
  grant.tools.kind === "named" ? (
    <NamedGiven grant={grant} />
  ) : (
    <span className={styles["every"]}>{selectionLabel(grant.tools)}</span>
  );

const ToolGroupTable = ({
  view,
  grants,
  directory,
  toolkits,
  busy,
  onEdit,
  onRemove,
}: {
  readonly view: ToolGrantsView;
  readonly grants: ReadonlyArray<ToolGrant>;
  readonly directory: Directory;
  readonly toolkits: ReadonlyArray<ToolkitView>;
  readonly busy: boolean;
  readonly onEdit: (grant: ToolGrant) => void;
  readonly onRemove: (grant: ToolGrant) => void;
}) => (
  <table className={styles["table"]}>
    <thead>
      <tr>
        <th scope="col">{view === "toolkit" ? "Who" : "Toolkit"}</th>
        <th scope="col">Tools</th>
        <th scope="col">
          <span className={kit["visuallyHidden"]}>Actions</span>
        </th>
      </tr>
    </thead>
    <tbody>
      {grants.map((grant) => {
        const what = `${subjectLabel(grant.subject, directory)} on ${toolkitName(grant.toolkit, toolkits)}`;

        return (
          <tr key={grant.id}>
            <th scope="row" className={styles["name"]}>
              {view === "toolkit"
                ? subjectLabel(grant.subject, directory)
                : toolkitName(grant.toolkit, toolkits)}
              {view === "member" && grant.subject.kind !== "member" ? (
                <span className={styles["secondary"]}>
                  via{" "}
                  {grant.subject.kind === "everyone"
                    ? "everyone"
                    : subjectLabel(grant.subject, directory)}
                </span>
              ) : null}
            </th>
            <td>
              <Given grant={grant} />
            </td>
            <td className={styles["actions"]}>
              <button
                type="button"
                className={styles["icon"]}
                aria-label={`Edit the tool grant for ${what}`}
                title="Edit"
                onClick={() => onEdit(grant)}
              >
                <Pencil aria-hidden="true" size={16} strokeWidth={2.25} />
              </button>
              <button
                type="button"
                className={styles["icon"]}
                aria-label={`Remove the tool grant for ${what}`}
                title="Remove"
                disabled={busy}
                onClick={() => onRemove(grant)}
              >
                <X aria-hidden="true" size={18} strokeWidth={2.25} />
              </button>
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

type Open = { readonly kind: "new" } | { readonly kind: "edit"; readonly grant: ToolGrant };

export const ToolGrants = ({
  grants,
  directory,
  toolkits,
  onReload,
}: {
  readonly grants: ReadonlyArray<ToolGrant>;
  readonly directory: Directory;
  readonly toolkits: ReadonlyArray<ToolkitView>;
  readonly onReload: () => void;
}) => {
  const save = useAction(saveToolGrantAtom);
  const [view, setView] = useState<ToolGrantsView>("member");
  const [open, setOpen] = useState<Open | undefined>(undefined);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const groups = groupToolGrants(grants, view, directory, toolkits);
  const waiting = ungrantedToolkits(toolkits, grants);

  const run = async (write: Parameters<typeof save.run>[0], done: string): Promise<boolean> => {
    setNote(undefined);
    const outcome = await save.run(write);

    if (outcome.ok) {
      setNote({ tone: "done", text: done });

      return true;
    }

    setNote({
      tone: "problem",
      text: toolGrantProblem(outcome.error, outcome.detail ?? outcome.message),
      stale: outcome.error === "conflict",
    });

    return false;
  };

  return (
    <>
      <div className={styles["views"]} role="group" aria-label="Read the tool grants">
        {TOOL_GRANTS_VIEWS.map((entry) => (
          <button
            key={entry.view}
            type="button"
            className={styles["view"]}
            aria-pressed={view === entry.view}
            onClick={() => setView(entry.view)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {waiting.length === 0 ? null : (
        <p className={styles["callout"]} role="status">
          Nobody reaches {waiting.map((toolkit) => toolkit.name).join(", ")} yet: a toolkit with a
          shared credential needs a grant first.
        </p>
      )}
      {grants.length === 0 ? (
        <p className={styles["empty"]}>
          No tool grants: nobody may use a toolkit&rsquo;s shared credential. Add one to let
          members, a team or everyone call its tools. A member&rsquo;s own private credential needs
          no grant.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.key} className={styles["group"]} aria-label={group.label}>
            <h2 className={styles["groupTitle"]}>{group.label}</h2>
            {group.grants.length === 0 ? (
              <p className={styles["none"]}>No grants.</p>
            ) : (
              <ToolGroupTable
                view={view}
                grants={group.grants}
                directory={directory}
                toolkits={toolkits}
                busy={save.busy}
                onEdit={(grant) => {
                  setNote(undefined);
                  setOpen({ kind: "edit", grant });
                }}
                onRemove={(grant) =>
                  void run(
                    { kind: "remove", id: grant.id, revision: grant.revision },
                    "Removed the grant.",
                  )
                }
              />
            )}
          </section>
        ))
      )}
      {open === undefined ? (
        <div className={styles["foot"]}>
          <button
            type="button"
            className={kit["secondary"]}
            onClick={() => {
              setNote(undefined);
              setOpen({ kind: "new" });
            }}
          >
            <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
            Add a tool grant
          </button>
        </div>
      ) : (
        <ToolGrantForm
          key={open.kind === "edit" ? open.grant.id : "new"}
          initial={open.kind === "edit" ? draftOfToolGrant(open.grant) : EMPTY_TOOL_GRANT_DRAFT}
          editing={open.kind === "edit" ? open.grant : undefined}
          existing={grants}
          directory={directory}
          toolkits={toolkits}
          busy={save.busy}
          onCancel={() => setOpen(undefined)}
          onSave={async (draft) => {
            const body = toolGrantBody(draft);

            const saved =
              open.kind === "edit"
                ? await run(
                    { kind: "replace", id: open.grant.id, revision: open.grant.revision, body },
                    "Saved the grant.",
                  )
                : await run({ kind: "create", body }, "Added the grant.");

            if (saved) setOpen(undefined);

            return saved;
          }}
        />
      )}
      {note?.tone === "problem" ? (
        <Problem {...(note.stale ? { onRetry: onReload, retryLabel: "Reload" } : {})}>
          Could not save. {note.text}
        </Problem>
      ) : null}
      <p className={styles["note"]} role="status">
        {note?.tone === "done" ? note.text : null}
      </p>
    </>
  );
};

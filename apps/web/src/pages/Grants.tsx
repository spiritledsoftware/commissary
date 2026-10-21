// Grants (/grants): which models of which shared credentials a member, a team or everyone may use (ADR 0023), read by
// member, by team or by credential. A member may use the union of the grants that name them; there is no deny, so the
// org's default grant (everyone, every account, every model) is what removes a restriction and what to delete to
// restrict. A private account is its owner's alone and never appears here. Edits are saved with the grant's revision
// (`If-Match`); another edit that landed first is refused and the list reloads.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Check, Pencil, Plus, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { Grant } from "@commissary/contract/grants";
import type { MemberView, TeamView } from "@commissary/contract/members";
import {
  credentialsAtom,
  grantsAtom,
  membersAtom,
  saveGrantAtom,
  teamsAtom,
  toolGrantsAtom,
  toolkitsAtom,
} from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import {
  EMPTY_GRANT_DRAFT,
  type Directory,
  draftOf,
  GRANT_PROVIDERS,
  type GrantDraft,
  type GrantErrors,
  grantBody,
  grantProblem,
  GRANTS_AREAS,
  grantsAreaOf,
  GRANTS_VIEWS,
  type GrantsView,
  givesEveryModel,
  groupGrants,
  hasGrantErrors,
  scopeLabel,
  subjectLabel,
  validateGrant,
} from "../lib/grants.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { ToolGrants } from "./GrantsTools.tsx";
import styles from "./Grants.module.css";

/** What a save did, or why it failed, said under the list. */
type Note =
  | { readonly tone: "done"; readonly text: string }
  | { readonly tone: "problem"; readonly text: string; readonly stale: boolean };

/** The shared credentials a credential grant can name: the file names of the org's non-private auth files. */
interface Account {
  readonly id: string;
  readonly label: string;
}

const SUBJECTS: ReadonlyArray<{
  readonly kind: GrantDraft["subjectKind"];
  readonly label: string;
}> = [
  { kind: "member", label: "A member" },
  { kind: "team", label: "A team" },
  { kind: "everyone", label: "Everyone" },
];

const SCOPES: ReadonlyArray<{ readonly kind: GrantDraft["scopeKind"]; readonly label: string }> = [
  { kind: "all", label: "All shared credentials" },
  { kind: "provider", label: "Every account of a provider" },
  { kind: "credential", label: "One account" },
];

const focusFirstInvalid = (form: HTMLFormElement) => {
  requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
};

const GrantForm = ({
  initial,
  editing,
  existing,
  directory,
  accounts,
  busy,
  onSave,
  onCancel,
}: {
  readonly initial: GrantDraft;
  readonly editing: Grant | undefined;
  readonly existing: ReadonlyArray<Grant>;
  readonly directory: Directory;
  readonly accounts: ReadonlyArray<Account>;
  readonly busy: boolean;
  readonly onSave: (draft: GrantDraft) => Promise<boolean>;
  readonly onCancel: () => void;
}) => {
  const ids = useId();
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const errors: GrantErrors = validateGrant(draft, existing, editing);
  const shown: GrantErrors = tried ? errors : {};

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);

    if (hasGrantErrors(errors)) return focusFirstInvalid(event.currentTarget);

    if (await onSave(draft)) setTried(false);
  };

  const note = (field: keyof GrantErrors, hint: string) => (
    <span
      id={`${ids}-${field}-note`}
      className={shown[field] === undefined ? styles["hint"] : kit["fieldError"]}
    >
      {shown[field] ?? hint}
    </span>
  );

  return (
    <form
      className={styles["form"]}
      onSubmit={submit}
      noValidate
      aria-label={editing === undefined ? "Add a grant" : "Edit the grant"}
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
          {note("subject", "")}
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
          </div>
        )}
      </div>
      <div className={styles["pair"]}>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-scope-kind`}>
            Accounts
          </label>
          <select
            id={`${ids}-scope-kind`}
            className={kit["input"]}
            value={draft.scopeKind}
            onChange={(event) =>
              setDraft({
                ...draft,
                scopeKind: SCOPES.find((entry) => entry.kind === event.target.value)?.kind ?? "all",
                scopeValue: "",
              })
            }
          >
            {SCOPES.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        {draft.scopeKind === "all" ? null : (
          <div className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-scope`}>
              {draft.scopeKind === "provider" ? "Provider" : "Account"}
            </label>
            {draft.scopeKind === "provider" ? (
              <>
                <input
                  id={`${ids}-scope`}
                  className={kit["input"]}
                  spellCheck={false}
                  autoComplete="off"
                  list={`${ids}-providers`}
                  value={draft.scopeValue}
                  aria-invalid={shown.scope !== undefined}
                  aria-describedby={`${ids}-scope-note`}
                  onChange={(event) => setDraft({ ...draft, scopeValue: event.target.value })}
                />
                <datalist id={`${ids}-providers`}>
                  {GRANT_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider} />
                  ))}
                </datalist>
              </>
            ) : (
              <select
                id={`${ids}-scope`}
                className={kit["input"]}
                value={draft.scopeValue}
                aria-invalid={shown.scope !== undefined}
                aria-describedby={`${ids}-scope-note`}
                onChange={(event) => setDraft({ ...draft, scopeValue: event.target.value })}
              >
                <option value="">Choose…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
                {draft.scopeValue === "" ||
                accounts.some((account) => account.id === draft.scopeValue) ? null : (
                  <option value={draft.scopeValue}>{draft.scopeValue}</option>
                )}
              </select>
            )}
            {note("scope", "")}
          </div>
        )}
      </div>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-models`}>
          Models
        </label>
        <input
          id={`${ids}-models`}
          className={kit["input"]}
          spellCheck={false}
          autoComplete="off"
          placeholder="claude-sonnet-*, gpt-5"
          value={draft.models}
          aria-invalid={shown.models !== undefined}
          aria-describedby={`${ids}-models-note`}
          onChange={(event) => setDraft({ ...draft, models: event.target.value })}
        />
        {note(
          "models",
          "Upstream model names, with * as a wildcard, separated by commas. * alone is every model.",
        )}
      </div>
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

const ModelChips = ({ grant }: { readonly grant: Grant }) =>
  givesEveryModel(grant) ? (
    <span className={styles["every"]}>Every model</span>
  ) : (
    <span className={styles["chips"]}>
      {grant.models.map((model) => (
        <code key={model} className={styles["chip"]}>
          {model}
        </code>
      ))}
    </span>
  );

const GroupTable = ({
  view,
  grants,
  directory,
  busy,
  onEdit,
  onRemove,
}: {
  readonly view: GrantsView;
  readonly grants: ReadonlyArray<Grant>;
  readonly directory: Directory;
  readonly busy: boolean;
  readonly onEdit: (grant: Grant) => void;
  readonly onRemove: (grant: Grant) => void;
}) => (
  <table className={styles["table"]}>
    <thead>
      <tr>
        <th scope="col">{view === "credential" ? "Who" : "Accounts"}</th>
        <th scope="col">Models</th>
        <th scope="col">
          <span className={kit["visuallyHidden"]}>Actions</span>
        </th>
      </tr>
    </thead>
    <tbody>
      {grants.map((grant) => (
        <tr key={grant.id}>
          <th scope="row" className={styles["name"]}>
            {view === "credential"
              ? subjectLabel(grant.subject, directory)
              : scopeLabel(grant.scope)}
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
            <ModelChips grant={grant} />
          </td>
          <td className={styles["actions"]}>
            <button
              type="button"
              className={styles["icon"]}
              aria-label={`Edit the grant for ${subjectLabel(grant.subject, directory)} on ${scopeLabel(grant.scope)}`}
              title="Edit"
              onClick={() => onEdit(grant)}
            >
              <Pencil aria-hidden="true" size={16} strokeWidth={2.25} />
            </button>
            <button
              type="button"
              className={styles["icon"]}
              aria-label={`Remove the grant for ${subjectLabel(grant.subject, directory)} on ${scopeLabel(grant.scope)}`}
              title="Remove"
              disabled={busy}
              onClick={() => onRemove(grant)}
            >
              <X aria-hidden="true" size={18} strokeWidth={2.25} />
            </button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

type Open = { readonly kind: "new" } | { readonly kind: "edit"; readonly grant: Grant };

const Grants = ({
  grants,
  directory,
  accounts,
  onReload,
}: {
  readonly grants: ReadonlyArray<Grant>;
  readonly directory: Directory;
  readonly accounts: ReadonlyArray<Account>;
  readonly onReload: () => void;
}) => {
  const save = useAction(saveGrantAtom);
  const [view, setView] = useState<GrantsView>("member");
  const [open, setOpen] = useState<Open | undefined>(undefined);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const groups = groupGrants(grants, view, directory);

  const run = async (write: Parameters<typeof save.run>[0], done: string): Promise<boolean> => {
    setNote(undefined);
    const outcome = await save.run(write);

    if (outcome.ok) {
      setNote({ tone: "done", text: done });

      return true;
    }

    setNote({
      tone: "problem",
      text: grantProblem(outcome.error, outcome.detail ?? outcome.message),
      stale: outcome.error === "conflict",
    });

    return false;
  };

  return (
    <>
      <div className={styles["views"]} role="group" aria-label="Read the grants">
        {GRANTS_VIEWS.map((entry) => (
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
      {grants.length === 0 ? (
        <p className={styles["empty"]}>
          No grants: nobody may use any shared account. Add one to let members, a team or everyone
          use models.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.key} className={styles["group"]} aria-label={group.label}>
            <h2 className={styles["groupTitle"]}>{group.label}</h2>
            {group.grants.length === 0 ? (
              <p className={styles["none"]}>No grants.</p>
            ) : (
              <GroupTable
                view={view}
                grants={group.grants}
                directory={directory}
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
            Add a grant
          </button>
        </div>
      ) : (
        <GrantForm
          key={open.kind === "edit" ? open.grant.id : "new"}
          initial={open.kind === "edit" ? draftOf(open.grant) : EMPTY_GRANT_DRAFT}
          editing={open.kind === "edit" ? open.grant : undefined}
          existing={grants}
          directory={directory}
          accounts={accounts}
          busy={save.busy}
          onCancel={() => setOpen(undefined)}
          onSave={async (draft) => {
            const body = grantBody(draft);

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

const accountsOf = (
  result: AsyncResult.AsyncResult<
    {
      readonly files: ReadonlyArray<{
        readonly name: string;
        readonly label: string;
        readonly source: string;
        readonly private?: boolean;
      }>;
    },
    unknown
  >,
): ReadonlyArray<Account> =>
  AsyncResult.isSuccess(result)
    ? result.value.files
        // A provider key is listed under its auth_index, which is not its credential id: a grant names it through its
        // provider or all credentials.
        .filter((file) => file.private !== true && file.source === "file")
        .map((file) => ({
          id: file.name,
          label:
            file.label === "" || file.label === file.name
              ? file.name
              : `${file.label} (${file.name})`,
        }))
    : [];

/** The model grants: the grants, members and teams, then the page's body. */
const ModelGrantsBody = () => {
  const grants = useAtomValue(grantsAtom);
  const members = useAtomValue(membersAtom);
  const teams = useAtomValue(teamsAtom);
  const credentials = useAtomValue(credentialsAtom);
  const reload = useAtomRefresh(grantsAtom);

  if (AsyncResult.isFailure(grants))
    return <Problem onRetry={reload}>Could not load the grants. {failureMessage(grants)}</Problem>;

  if (AsyncResult.isFailure(members))
    return (
      <Problem onRetry={reload}>Could not load the members. {failureMessage(members)}</Problem>
    );

  if (AsyncResult.isFailure(teams))
    return <Problem onRetry={reload}>Could not load the teams. {failureMessage(teams)}</Problem>;

  if (
    !AsyncResult.isSuccess(grants) ||
    !AsyncResult.isSuccess(members) ||
    !AsyncResult.isSuccess(teams)
  )
    return (
      <p className={kit["muted"]} aria-busy="true">
        Loading the grants…
      </p>
    );

  const directory: Directory = {
    members: members.value.members satisfies ReadonlyArray<MemberView>,
    teams: teams.value.teams satisfies ReadonlyArray<TeamView>,
  };

  return (
    <Grants
      grants={grants.value.grants}
      directory={directory}
      accounts={accountsOf(credentials)}
      onReload={reload}
    />
  );
};

/** The tool grants: the grants, the toolkits they name, members and teams, then the page's body. */
const ToolGrantsBody = () => {
  const grants = useAtomValue(toolGrantsAtom);
  const toolkits = useAtomValue(toolkitsAtom);
  const members = useAtomValue(membersAtom);
  const teams = useAtomValue(teamsAtom);
  const reload = useAtomRefresh(toolGrantsAtom);

  if (AsyncResult.isFailure(grants))
    return (
      <Problem onRetry={reload}>Could not load the tool grants. {failureMessage(grants)}</Problem>
    );

  if (AsyncResult.isFailure(toolkits))
    return (
      <Problem onRetry={reload}>Could not load the toolkits. {failureMessage(toolkits)}</Problem>
    );

  if (AsyncResult.isFailure(members))
    return (
      <Problem onRetry={reload}>Could not load the members. {failureMessage(members)}</Problem>
    );

  if (AsyncResult.isFailure(teams))
    return <Problem onRetry={reload}>Could not load the teams. {failureMessage(teams)}</Problem>;

  if (
    !AsyncResult.isSuccess(grants) ||
    !AsyncResult.isSuccess(toolkits) ||
    !AsyncResult.isSuccess(members) ||
    !AsyncResult.isSuccess(teams)
  )
    return (
      <p className={kit["muted"]} aria-busy="true">
        Loading the tool grants…
      </p>
    );

  const directory: Directory = {
    members: members.value.members satisfies ReadonlyArray<MemberView>,
    teams: teams.value.teams satisfies ReadonlyArray<TeamView>,
  };

  return (
    <ToolGrants
      grants={grants.value.grants}
      directory={directory}
      toolkits={toolkits.value.toolkits}
      onReload={reload}
    />
  );
};

export const GrantsPage = () => {
  usePageTitle("Grants");
  const search = useSearch({ from: "/grants" });
  const navigate = useNavigate({ from: "/grants" });
  const area = grantsAreaOf(search);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Grants</h1>
        <p className={styles["intro"]}>
          {area === "models"
            ? "A grant says which models of which shared credentials a member, a team or everyone may use. A member may use everything their own grants, their teams\u2019 and everyone\u2019s add up to; there is no deny, so a new org starts with one grant that gives everyone every model. Delete it and add narrower ones to restrict. A model a member may not use answers as unknown, and private accounts are never granted: they are their owner\u2019s alone."
            : "A tool grant says which tools of a toolkit\u2019s shared credential a member, a team or everyone may call: all of them, its read tools or ones you name. Grants add up and there is no deny; a toolkit nobody holds a grant on is reached by no one but through a private credential."}
        </p>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Grants of">
          {GRANTS_AREAS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={area === candidate.id}
              className={kit["tab"]}
              onClick={() =>
                void navigate({
                  search: candidate.id === "tools" ? { area: "tools" } : {},
                  replace: true,
                  resetScroll: false,
                })
              }
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </header>
      {area === "models" ? <ModelGrantsBody /> : <ToolGrantsBody />}
    </div>
  );
};

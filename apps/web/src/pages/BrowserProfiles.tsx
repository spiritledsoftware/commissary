// The browser toolkit's Browser profiles page (/tools/profiles, #217, ADR 0039): the saved logins and site data a
// browser session can start from. An org admin creates, renames and deletes the shared profiles and edits who may use
// each (a profile grant per subject, asked for when it is created: nothing is preselected), and sees only that the other
// members' private profiles exist; a plain member creates, renames and deletes their own private profiles and has no
// control of the shared ones. The page also says how to log into a profile. The server decides who sees what; where
// the deployment has no browser toolkit (ADR 0043) the page is not found and nothing links to it.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type {
  BrowserProfileGrant,
  BrowserProfileView,
  LimitedBrowserProfileView,
} from "@commissary/contract/browser-profiles";
import {
  BROWSER_PROFILES,
  browserProfileGrantsAtom,
  browserProfilesAtom,
  createBrowserProfileAtom,
  deleteBrowserProfileAtom,
  membersAtom,
  meAtom,
  nowAtom,
  renameBrowserProfileAtom,
  saveBrowserProfileAccessAtom,
  teamsAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem, Section, Step, Steps } from "../components/Kit.tsx";
import { PrivateRows } from "../components/PrivateRows.tsx";
import type { ApproverDirectory } from "../lib/approval-rules.ts";
import {
  accessChange,
  accessProblem,
  accessText,
  BROWSER_PROFILES_PAGE,
  canCreate,
  chosenOf,
  deleteText,
  emptyDraft,
  emptyText,
  grantsOf,
  hasChange,
  hasErrors,
  kindsFor,
  LOGIN_STEPS,
  managesShared,
  MEMBER_NO_PRIVATE_TEXT,
  NAME_HINT,
  nameProblem,
  NOBODY_TEXT,
  otherRows,
  type ProfileDraft,
  type ProfileKind,
  type ProfileRow,
  privateRows,
  profileProblem,
  SAVE_NOTE,
  sharedRows,
  targetOf,
  targetOfKey,
  toggled,
  validateDraft,
} from "../lib/browser-profiles.ts";
import { BROWSER_SESSIONS_PAGE } from "../lib/browser-sessions.ts";
import { failureMessage } from "../lib/failure.ts";
import { hasBrowser } from "../lib/hosted.ts";
import { type ToolsCaller, toolsCallerOf } from "../lib/toolkits.ts";
import { type Outcome, useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { directoryOf, WithApproverDirectory } from "./ApproverDirectory.tsx";
import { AccessPicker } from "./BrowserProfilesAccess.tsx";
import styles from "./BrowserProfiles.module.css";
import { NotFound } from "./NotFound.tsx";
import tools from "./Tools.module.css";

/** The words of a refused write. */
const problemOf = (outcome: Extract<Outcome<unknown>, { ok: false }>): string =>
  profileProblem(outcome.error, outcome.message, outcome.detail);

/** What an org admin edits besides the profiles: the grants on the shared ones and the members and teams to name. */
interface Access {
  readonly grants: ReadonlyArray<BrowserProfileGrant>;
  readonly directory: ApproverDirectory;
}

// ---------------------------------------------------------------------------------------------------------------
// A list of profiles

type Mode = "rename" | "access";

const RenameForm = ({
  row,
  profiles,
  onDone,
}: {
  readonly row: ProfileRow;
  readonly profiles: ReadonlyArray<BrowserProfileView>;
  readonly onDone: () => void;
}) => {
  const ids = useId();
  const rename = useAction(renameBrowserProfileAtom);
  const [name, setName] = useState(row.profile.name);
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const kind: ProfileKind = row.profile.private ? "private" : "shared";
  const wrong = nameProblem(name, kind, profiles, row.profile.id);
  const shown = tried ? wrong : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    setProblem(undefined);

    if (wrong !== undefined) return;

    if (name.trim() === row.profile.name) return onDone();

    const outcome = await rename.run({
      params: { id: row.profile.id },
      headers: { "if-match": String(row.profile.revision) },
      payload: { name: name.trim() },
      reactivityKeys: BROWSER_PROFILES,
    });

    if (outcome.ok) onDone();
    else setProblem(problemOf(outcome));
  };

  return (
    <form
      className={styles["rename"]}
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-label={`Rename ${row.profile.name}`}
    >
      <div className={`${kit["field"]} ${styles["renameField"]}`}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-name`}>
          Name
        </label>
        <input
          id={`${ids}-name`}
          className={kit["input"]}
          value={name}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={shown !== undefined}
          aria-describedby={`${ids}-note`}
          onChange={(event) => setName(event.target.value)}
        />
        <span
          id={`${ids}-note`}
          className={shown === undefined ? tools["hint"] : kit["fieldError"]}
        >
          {shown ?? NAME_HINT}
        </span>
      </div>
      <button type="submit" className={kit["primary"]} disabled={rename.busy}>
        {rename.busy ? "Saving…" : "Save name"}
      </button>
      <button type="button" className={kit["secondary"]} onClick={onDone}>
        Cancel
      </button>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
    </form>
  );
};

const AccessForm = ({
  row,
  access,
  onDone,
}: {
  readonly row: ProfileRow;
  readonly access: Access;
  readonly onDone: () => void;
}) => {
  const ids = useId();
  const save = useAction(saveBrowserProfileAccessAtom);
  const held = grantsOf(access.grants, row.profile.id);
  const [chosen, setChosen] = useState(() => chosenOf(held));
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const change = accessChange(held, chosen);
  const wrong = accessProblem(chosen);
  const shown = tried ? wrong : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    setProblem(undefined);

    // A shared profile is never left that no one may use: remove it instead.
    if (wrong !== undefined) return;

    const outcome = await save.run({ profile: row.profile.id, change });

    if (outcome.ok) onDone();
    else setProblem(problemOf(outcome));
  };

  return (
    <form
      className={tools["form"]}
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-label={`Who may use ${row.profile.name}`}
    >
      <AccessPicker
        directory={access.directory}
        chosen={chosen}
        invalid={shown !== undefined}
        describedBy={`${ids}-note`}
        onToggle={(key) => setChosen(toggled(chosen, key))}
      />
      <span id={`${ids}-note`} className={shown === undefined ? tools["hint"] : kit["fieldError"]}>
        {shown ??
          "Members who may use it open a session from it with browser_open; only an org admin saves into it."}
      </span>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <div className={tools["actions"]}>
        <button type="submit" className={kit["primary"]} disabled={save.busy || !hasChange(change)}>
          {save.busy ? "Saving…" : "Save who may use it"}
        </button>
        <button type="button" className={kit["secondary"]} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
};

/** The row open on the page, and how: one at a time across its tables. */
type OpenRow = { readonly id: string; readonly mode: Mode };

const Row = ({
  row,
  profiles,
  access,
  open,
  onOpen,
  onDelete,
}: {
  readonly row: ProfileRow;
  readonly profiles: ReadonlyArray<BrowserProfileView>;
  /** The grants and directory of a shared profile's row; none on the caller's private profiles, or without them. */
  readonly access: Access | undefined;
  /** What this row has open: one row of a table is open at a time. */
  readonly open: Mode | undefined;
  readonly onOpen: (mode: Mode | undefined) => void;
  readonly onDelete: (profile: BrowserProfileView) => void;
}) => {
  const { profile } = row;
  const who = access && accessText(grantsOf(access.grants, profile.id), access.directory);
  const whoText = access === undefined ? null : (who ?? NOBODY_TEXT);
  const toggle = (next: Mode) => onOpen(open === next ? undefined : next);
  const close = () => onOpen(undefined);

  const hiddenName = <span className={kit["visuallyHidden"]}> {profile.name}</span>;

  return (
    <>
      <tr>
        <td>
          <div className={tools["name"]}>
            <span>{profile.name}</span>
            <span className={tools["secondary"]}>{row.saved}</span>
          </div>
          {/* On a narrow screen the column of who may use it folds in here. */}
          {whoText === null ? null : (
            <div className={tools["narrowOnly"]}>Who may use it: {whoText}</div>
          )}
        </td>
        {access === undefined ? null : <td className={tools["wide"]}>{whoText}</td>}
        <td>
          <div className={styles["rowActions"]}>
            <button
              type="button"
              className={tools["linkButton"]}
              aria-expanded={open === "rename"}
              onClick={() => toggle("rename")}
            >
              {open === "rename" ? "Close" : "Rename"}
              {hiddenName}
            </button>
            {access === undefined ? null : (
              <button
                type="button"
                className={tools["linkButton"]}
                aria-expanded={open === "access"}
                onClick={() => toggle("access")}
              >
                {open === "access" ? "Close" : "Who may use it"}
                {hiddenName}
              </button>
            )}
            <button type="button" className={kit["danger"]} onClick={() => onDelete(profile)}>
              Delete
              {hiddenName}
            </button>
          </div>
        </td>
      </tr>
      {open === undefined ? null : (
        <tr className={tools["editRow"]}>
          <td colSpan={access === undefined ? 2 : 3}>
            <div className={tools["edit"]}>
              {open === "rename" || access === undefined ? (
                <RenameForm row={row} profiles={profiles} onDone={close} />
              ) : (
                <AccessForm row={row} access={access} onDone={close} />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

const ProfileTable = ({
  title,
  caption,
  rows,
  profiles,
  access,
  empty,
  open,
  onOpen,
  onDelete,
}: {
  readonly title: string;
  readonly caption: string;
  readonly rows: ReadonlyArray<ProfileRow>;
  readonly profiles: ReadonlyArray<BrowserProfileView>;
  readonly access: Access | undefined;
  readonly empty: string;
  /** The page's one open row, across both tables. */
  readonly open: OpenRow | undefined;
  readonly onOpen: (open: OpenRow | undefined) => void;
  readonly onDelete: (profile: BrowserProfileView) => void;
}) => {
  return (
    <Section title={title} className={tools["section"]}>
      {rows.length === 0 ? (
        <p className={tools["empty"]}>{empty}</p>
      ) : (
        <div className={tools["scroll"]}>
          <table className={tools["table"]}>
            <caption className={kit["visuallyHidden"]}>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Profile</th>
                {access === undefined ? null : (
                  <th scope="col" className={tools["wide"]}>
                    Who may use it
                  </th>
                )}
                <th scope="col">
                  <span className={kit["visuallyHidden"]}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row
                  key={row.profile.id}
                  row={row}
                  profiles={profiles}
                  access={access}
                  open={open?.id === row.profile.id ? open.mode : undefined}
                  onOpen={(mode) =>
                    onOpen(mode === undefined ? undefined : { id: row.profile.id, mode })
                  }
                  onDelete={onDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Creating one

const NewProfile = ({
  caller,
  profiles,
  directory,
}: {
  readonly caller: ToolsCaller;
  readonly profiles: ReadonlyArray<BrowserProfileView>;
  /** The members and teams a shared profile's grants name; without them only a private profile is offered. */
  readonly directory: ApproverDirectory | undefined;
}) => {
  const ids = useId();
  const create = useAction(createBrowserProfileAtom);

  const [draft, setDraft] = useState<ProfileDraft>(() =>
    emptyDraft(caller, directory !== undefined),
  );

  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<string | undefined>(undefined);
  const kinds = kindsFor(caller, directory !== undefined);
  const errors = validateDraft(draft, profiles);
  const shown = tried ? errors : {};
  const shared = draft.kind === "shared";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    setProblem(undefined);
    setCreated(undefined);

    if (hasErrors(errors)) {
      const form = event.currentTarget;

      requestAnimationFrame(() =>
        form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );

      return;
    }

    const outcome = await create.run(draft);

    if (outcome.ok) {
      setCreated(outcome.value.name);
      setDraft(emptyDraft(caller, directory !== undefined));
      setTried(false);
    } else setProblem(problemOf(outcome));
  };

  return (
    <Section title="New profile" className={tools["section"]}>
      <form
        className={tools["form"]}
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-label="Create a browser profile"
      >
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-name`}>
            Name
          </label>
          <input
            id={`${ids}-name`}
            className={kit["input"]}
            value={draft.name}
            placeholder={shared ? "marketing" : "my-bank"}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={shown.name !== undefined}
            aria-describedby={`${ids}-name-note`}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
              setCreated(undefined);
            }}
          />
          <span
            id={`${ids}-name-note`}
            className={shown.name === undefined ? tools["hint"] : kit["fieldError"]}
          >
            {shown.name ?? NAME_HINT}
          </span>
        </div>
        {kinds.length > 1 ? (
          <fieldset className={tools["choices"]}>
            <legend>Whose</legend>
            <label className={tools["choice"]}>
              <input
                type="radio"
                name={`${ids}-kind`}
                checked={shared}
                onChange={() => setDraft({ ...draft, kind: "shared" })}
              />
              <span className={tools["choiceText"]}>
                The org&rsquo;s, shared
                <span className={tools["hint"]}>
                  It carries a logged-in account, so you choose who may use it.
                </span>
              </span>
            </label>
            <label className={tools["choice"]}>
              <input
                type="radio"
                name={`${ids}-kind`}
                checked={!shared}
                onChange={() => setDraft({ ...draft, kind: "private" })}
              />
              <span className={tools["choiceText"]}>
                Yours, private
                <span className={tools["hint"]}>Only you use it, and no one needs a grant.</span>
              </span>
            </label>
          </fieldset>
        ) : (
          <p className={tools["hint"]}>
            {shared
              ? "It is shared with the org and carries a logged-in account, so you choose who may use it."
              : "It is private to you: only you use it."}
          </p>
        )}
        {shared && directory !== undefined ? (
          <div className={tools["field"]}>
            <AccessPicker
              directory={directory}
              chosen={draft.who}
              invalid={shown.who !== undefined}
              describedBy={`${ids}-who-note`}
              onToggle={(key) => {
                setDraft({ ...draft, who: toggled(draft.who, key) });
                setCreated(undefined);
              }}
            />
            <span
              id={`${ids}-who-note`}
              className={shown.who === undefined ? tools["hint"] : kit["fieldError"]}
              role={shown.who === undefined ? undefined : "alert"}
            >
              {shown.who ??
                "Nothing is chosen for you. Each choice is a grant of this profile; change them later in its row."}
            </span>
          </div>
        ) : null}
        {problem === undefined ? null : <Problem>{problem}</Problem>}
        <div className={tools["actions"]}>
          <button
            type="submit"
            className={kit["primary"]}
            disabled={create.busy}
            aria-busy={create.busy}
          >
            <Plus aria-hidden="true" size={18} strokeWidth={2.25} />
            {create.busy ? "Creating…" : "Create profile"}
          </button>
          {created === undefined ? null : (
            <span className={styles["status"]} role="status">
              Created {created}. It is empty until a session saves into it: see below.
            </span>
          )}
        </div>
      </form>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The page

const OtherProfiles = ({
  others,
}: {
  readonly others: ReadonlyArray<LimitedBrowserProfileView>;
}) => {
  const remove = useAction(deleteBrowserProfileAtom);
  const rows = otherRows(others);

  return (
    <PrivateRows
      title="Members' private profiles"
      noun="private browser profile"
      rows={rows.map((row) => ({ key: row.id, label: row.added, owner: row.owner }))}
      onRemove={async ({ key }) => {
        const target = targetOfKey(rows, key);

        if (target === undefined)
          return { ok: false, message: "That profile is gone already. The list is up to date." };

        const outcome = await remove.run(target);

        return outcome.ok ? { ok: true } : { ok: false, message: problemOf(outcome) };
      }}
    />
  );
};

const LoggingIn = () => (
  <Section title="Logging in to a profile" className={tools["section"]}>
    <Steps>
      {LOGIN_STEPS.map((step) => (
        <Step key={step.title} title={step.title}>
          <p className={tools["lead"]}>{step.body}</p>
        </Step>
      ))}
    </Steps>
    <p className={tools["lead"]}>{SAVE_NOTE}</p>
    <p className={tools["hint"]}>
      Your open sessions, where a handoff waits for you, are on the{" "}
      <Link to={BROWSER_SESSIONS_PAGE}>Browser sessions</Link> page.
    </p>
  </Section>
);

const Body = ({
  caller,
  list,
  access,
  accessNote,
}: {
  readonly caller: ToolsCaller;
  readonly list: {
    readonly profiles: ReadonlyArray<BrowserProfileView>;
    readonly others?: ReadonlyArray<LimitedBrowserProfileView> | undefined;
  };
  /** An org admin's grants and directory, once both are read. */
  readonly access: Access | undefined;
  /** Where they are not (yet): loading, or why they could not be read. */
  readonly accessNote: ReactNode;
}) => {
  const now = useAtomValue(nowAtom);
  const remove = useAction(deleteBrowserProfileAtom);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<OpenRow | undefined>(undefined);
  const own = privateRows(list.profiles, now);
  const shared = sharedRows(list.profiles, now);
  const admin = managesShared(caller);
  const none = shared.length === 0 && own.length === 0;
  const kinds = kindsFor(caller, access !== undefined);

  const ask = (profile: BrowserProfileView) => {
    setProblem(undefined);

    setConfirm({
      title: `Delete ${profile.name}?`,
      body: <p>{deleteText(profile)}</p>,
      action: "Delete profile",
      busyAction: "Deleting…",
      run: async () => {
        const outcome = await remove.run(targetOf(profile));

        if (!outcome.ok) setProblem(problemOf(outcome));
      },
    });
  };

  return (
    <>
      {problem === undefined ? null : <Problem>Could not delete the profile. {problem}</Problem>}
      {accessNote}
      {admin ? (
        <ProfileTable
          title="Shared profiles"
          caption="Shared browser profiles"
          rows={shared}
          profiles={list.profiles}
          access={access}
          empty={none ? emptyText(caller) : "No shared profile yet. Create one below."}
          open={open}
          onOpen={setOpen}
          onDelete={ask}
        />
      ) : null}
      {admin && own.length === 0 ? null : (
        <ProfileTable
          title={admin ? "Your private profiles" : "Your profiles"}
          caption="Your private browser profiles"
          rows={own}
          profiles={list.profiles}
          access={undefined}
          empty={emptyText(caller)}
          open={open}
          onOpen={setOpen}
          onDelete={ask}
        />
      )}
      {list.others === undefined || list.others.length === 0 ? null : (
        <div className={tools["section"]}>
          <OtherProfiles others={list.others} />
        </div>
      )}
      {kinds.length > 0 ? (
        <NewProfile
          // The shared option appears and goes with the directory: a fresh form for each.
          key={access === undefined ? "private" : "shared"}
          caller={caller}
          profiles={list.profiles}
          directory={access?.directory}
        />
      ) : !canCreate(caller) && own.length > 0 ? (
        <p className={tools["note"]}>{MEMBER_NO_PRIVATE_TEXT}</p>
      ) : null}
      <LoggingIn />
      <ConfirmDialog request={confirm} busy={remove.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};

/**
 * An org admin's page also reads the grants and the members and teams they name. The lists show without them; only the
 * column and editor of who may use a shared profile, and the shared option of the form, wait for them.
 */
const AdminProfiles = ({
  caller,
  list,
}: {
  readonly caller: ToolsCaller;
  readonly list: Parameters<typeof Body>[0]["list"];
}) => {
  const grants = useAtomValue(browserProfileGrantsAtom);
  const retryGrants = useAtomRefresh(browserProfileGrantsAtom);
  const retryMembers = useAtomRefresh(membersAtom);
  const retryTeams = useAtomRefresh(teamsAtom);

  return (
    <WithApproverDirectory admin>
      {(state) => {
        const directory = directoryOf(state);
        const held = AsyncResult.isSuccess(grants) ? grants.value.grants : undefined;

        const access =
          directory === undefined || held === undefined ? undefined : { grants: held, directory };

        const retry = () => {
          retryGrants();
          retryMembers();
          retryTeams();
        };

        const note =
          state.state === "failed" || AsyncResult.isFailure(grants) ? (
            <Problem onRetry={retry}>
              Could not load who may use the shared profiles
              {AsyncResult.isFailure(grants)
                ? `. ${failureMessage(grants)}`
                : " (the members and teams)."}{" "}
              Without them you cannot choose or change who may use a shared profile.
            </Problem>
          ) : access === undefined ? (
            <p className={kit["muted"]} aria-busy="true">
              Loading who may use the shared profiles…
            </p>
          ) : null;

        return <Body caller={caller} list={list} access={access} accessNote={note} />;
      }}
    </WithApproverDirectory>
  );
};

const Profiles = ({ caller }: { readonly caller: ToolsCaller }) => {
  const result = useAtomValue(browserProfilesAtom);
  const retry = useAtomRefresh(browserProfilesAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the profiles…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the profiles. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) =>
      managesShared(caller) ? (
        <AdminProfiles caller={caller} list={value} />
      ) : (
        <Body caller={caller} list={value} access={undefined} accessNote={null} />
      ),
  });
};

export const BrowserProfilesPage = () => {
  const me = useAtomValue(meAtom);

  usePageTitle("Browser profiles");

  if (!AsyncResult.isSuccess(me)) return null;

  if (!hasBrowser(me.value)) return <NotFound />;

  const caller = toolsCallerOf(me.value);

  return (
    <div className={kit["page"]}>
      <header className={tools["head"]}>
        <Link to="/tools" className={tools["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Tools
        </Link>
        <h1 className={tools["title"]}>Browser profiles</h1>
        <p className={tools["intro"]}>
          A browser profile holds saved logins and site data, so a browser session can start already
          signed in. A shared profile is the org&rsquo;s and carries a logged-in account: an org
          admin chooses who may use it. A private profile is one member&rsquo;s. An org admin sees
          only that a member&rsquo;s private profile exists.
        </p>
      </header>
      <Profiles caller={caller} />
    </div>
  );
};

/**
 * The browser toolkit's page, under its prices (#217): where its saved logins and its open browsers are, for whoever
 * reads the toolkit. Nothing where the deployment has no browser.
 */
export const BrowserToolkitLinks = () => {
  const me = useAtomValue(meAtom);

  if (!AsyncResult.isSuccess(me) || !hasBrowser(me.value)) return null;

  return (
    <Section title="Profiles and sessions" className={tools["section"]}>
      <p className={tools["note"]}>
        Its saved logins are the <Link to={BROWSER_PROFILES_PAGE}>Browser profiles</Link>, shared
        with the org or private to a member; its open browsers are the{" "}
        <Link to={BROWSER_SESSIONS_PAGE}>Browser sessions</Link>.
      </p>
    </Section>
  );
};

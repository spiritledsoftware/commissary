// One credential slot of a toolkit (#208, ADR 0036, ADR 0038): the shared credential (org admins) or the caller's own,
// what is connected, and the form that connects one of every credential type the management API takes, or starts its
// OAuth sign-in in a new tab and waits for it. A shared credential's form asks who may use it: everyone at first, or,
// when it replaces one, a subject already granted on the toolkit (#198).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Check, ExternalLink, LoaderCircle, LogIn, Plug } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import type { GrantSubject, ToolGrant } from "@commissary/contract/grants";
import type { MemberView, TeamView } from "@commissary/contract/members";
import type {
  CredentialSlot,
  SignInStarted,
  ToolkitCredentialView,
  ToolkitView,
} from "@commissary/contract/tools";
import {
  connectToolkitAtom,
  disconnectToolkitAtom,
  membersAtom,
  startToolkitSignInAtom,
  teamsAtom,
  TOOLKITS,
  toolGrantsAtom,
  toolkitsAtom,
  toolkitSignInStatusAtom,
  updateToolkitAtom,
} from "../api/client.ts";
import { type ConfirmRequest, ConfirmDialog } from "../components/Confirm.tsx";
import { kit, Problem } from "../components/Kit.tsx";
import { TrailMark } from "../components/Signs.tsx";
import { linkHost } from "../lib/connect.ts";
import { asSentence } from "../lib/failure.ts";
import { formatDate } from "../lib/format.ts";
import { subjectLabel } from "../lib/grants.ts";
import {
  connectBody,
  FORM_PROBLEM,
  connectedText,
  type CredentialWay,
  credentialFields,
  defaultWay,
  type FieldValues,
  grantNote,
  isSettingsWay,
  missingSettings,
  pickedSubject,
  settingsFields,
  settingsPatch,
  settingsValuesOf,
  signInBody,
  wayLabel,
  wayName,
  waysFor,
  withSettings,
} from "../lib/toolkit-credentials.ts";
import { principalName, problemOf } from "../lib/toolkits.ts";
import { useAction } from "../lib/use-action.ts";
import { SpecFields } from "./ToolkitFields.tsx";
import styles from "./Tools.module.css";

/** How often the page asks whether a sign-in finished. */
const POLL_MS = 3000;

/** What is connected in a slot, in a sentence. */
const stateText = (credential: ToolkitCredentialView): string => {
  const by = principalName(credential.connected_by);
  const on = formatDate(Date.parse(credential.connected_at));

  return `Connected: ${wayName(credential.kind)}, by ${by} on ${on}.`;
};

const SlotState = ({ credential }: { readonly credential: ToolkitCredentialView | undefined }) => {
  if (credential === undefined) return <p className={styles["state"]}>Not connected.</p>;

  return (
    <div className={styles["lines"]}>
      <p className={styles["state"]}>{stateText(credential)}</p>
      {credential.needs_sign_in === true ? (
        <p className={styles["flag"]}>
          <TrailMark />
          It needs sign-in again: its token could not be refreshed, so it is not used.
        </p>
      ) : null}
      {credential.active ? null : (
        <p className={styles["flag"]}>
          <TrailMark />
          It is not used: the toolkit does not accept it now, or the org turned that kind of
          credential off.
        </p>
      )}
    </div>
  );
};

const subjectKey = (subject: GrantSubject): string =>
  subject.kind === "everyone" ? "everyone" : `${subject.kind}:${subject.id}`;

const subjectOfKey = (key: string): GrantSubject => {
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");

  if (kind === "member") return { kind: "member", id };

  return kind === "team" ? { kind: "team", id } : { kind: "everyone" };
};

/** Who may use a shared credential: everyone, a team or a member, with what connecting does to their grants. */
const SubjectPicker = ({
  toolkit,
  subject,
  onChange,
  members,
  teams,
  grants,
}: {
  readonly toolkit: ToolkitView;
  readonly subject: GrantSubject;
  readonly onChange: (subject: GrantSubject) => void;
  readonly members: ReadonlyArray<MemberView>;
  readonly teams: ReadonlyArray<TeamView>;
  readonly grants: ReadonlyArray<ToolGrant>;
}) => {
  const id = useId();

  // Inside a sentence: "everyone in the org" rather than the picker's "Everyone".
  const label =
    subject.kind === "everyone" ? "everyone in the org" : subjectLabel(subject, { members, teams });

  const note = grantNote(subject, toolkit.id, grants, label);

  return (
    <div className={styles["field"]}>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        Who may use it
      </label>
      <select
        id={id}
        className={kit["input"]}
        value={subjectKey(subject)}
        aria-describedby={`${id}-note`}
        onChange={(event) => onChange(subjectOfKey(event.target.value))}
      >
        <option value="everyone">Everyone in the org</option>
        {teams.length === 0 ? null : (
          <optgroup label="Teams">
            {teams.map((team) => (
              <option key={team.id} value={`team:${team.id}`}>
                {team.name}
              </option>
            ))}
          </optgroup>
        )}
        {members.length === 0 ? null : (
          <optgroup label="Members">
            {members.map((member) => (
              <option key={member.id} value={`member:${member.id}`}>
                {member.email}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <span id={`${id}-note`} className={styles["hint"]}>
        {note.charAt(0).toUpperCase()}
        {note.slice(1)} Narrow or widen it on the Grants page.
      </span>
    </div>
  );
};

type SignIn =
  | { readonly step: "idle" }
  | { readonly step: "open"; readonly started: SignInStarted }
  | { readonly step: "done" }
  | { readonly step: "failed"; readonly message: string };

/** A started sign-in: the link to the service, opened in a new tab, while the page waits for the callback. */
const SignInWait = ({
  toolkit,
  started,
  onSettled,
}: {
  readonly toolkit: ToolkitView;
  readonly started: SignInStarted;
  readonly onSettled: (outcome: SignIn) => void;
}) => {
  const status = useAction(toolkitSignInStatusAtom);
  const latest = useRef({ status: status.run, onSettled });

  latest.current = { status: status.run, onSettled };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expires = Date.parse(started.expires_at);

    const tick = async () => {
      const outcome = await latest.current.status({
        params: { id: toolkit.id },
        query: { state: started.state },
      });

      if (stopped) return;

      if (!outcome.ok) {
        latest.current.onSettled({
          step: "failed",
          message: problemOf(outcome) ?? outcome.message,
        });
      } else if (outcome.value.status === "ok") {
        latest.current.onSettled({ step: "done" });
      } else if (outcome.value.status === "error") {
        latest.current.onSettled({
          step: "failed",
          message: asSentence(outcome.value.message ?? "the service refused the sign-in"),
        });
      } else if (Date.now() > expires) {
        latest.current.onSettled({ step: "failed", message: "The sign-in expired. Start again." });
      } else {
        timer = setTimeout(tick, POLL_MS);
      }
    };

    timer = setTimeout(tick, POLL_MS);

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [toolkit.id, started]);

  return (
    <div className={styles["form"]}>
      <a className={kit["primary"]} href={started.url} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden="true" size={16} strokeWidth={2.25} />
        Sign in on {linkHost(started.url)}
        <span className={kit["visuallyHidden"]}> (opens in a new tab)</span>
      </a>
      <p className={styles["waiting"]} role="status">
        <LoaderCircle aria-hidden="true" size={18} strokeWidth={2.5} className={kit["spinning"]} />
        Waiting for you to approve it there, then come back here.
      </p>
      <button
        type="button"
        className={kit["secondary"]}
        onClick={() => onSettled({ step: "idle" })}
      >
        Stop waiting
      </button>
    </div>
  );
};

interface Directory {
  readonly members: ReadonlyArray<MemberView>;
  readonly teams: ReadonlyArray<TeamView>;
  readonly grants: ReadonlyArray<ToolGrant>;
}

const NO_DIRECTORY: Directory = { members: [], teams: [], grants: [] };

/** The org's members, teams and tool grants, for a shared credential's picker (org admins read them). */
const useDirectory = (): Directory => {
  const members = useAtomValue(membersAtom);
  const teams = useAtomValue(teamsAtom);
  const grants = useAtomValue(toolGrantsAtom);

  return {
    members: AsyncResult.isSuccess(members) ? members.value.members : [],
    teams: AsyncResult.isSuccess(teams) ? teams.value.teams : [],
    grants: AsyncResult.isSuccess(grants) ? grants.value.grants : [],
  };
};

/** The form that connects (or signs in) a credential of the slot. */
const CredentialForm = ({
  toolkit,
  slot,
  manage,
  directory,
  onDone,
  onCancel,
}: {
  readonly toolkit: ToolkitView;
  readonly slot: CredentialSlot;
  /** The caller manages the toolkit, so sets its credential settings. */
  readonly manage: boolean;
  readonly directory: Directory;
  readonly onDone: (text: string) => void;
  readonly onCancel: (() => void) | undefined;
}) => {
  const ids = useId();
  const ways = waysFor(toolkit, slot);
  const [way, setWay] = useState<CredentialWay>(() => defaultWay(toolkit, slot));
  const [values, setValues] = useState<FieldValues>({});

  const [settings, setSettings] = useState<FieldValues>(() =>
    settingsValuesOf(way, toolkit.credential_settings),
  );

  // The admin's pick, once made; until then the default follows the org's grants as they load.
  const [picked, setPicked] = useState<GrantSubject | undefined>(undefined);
  const subject = pickedSubject(picked, toolkit, directory.grants);

  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [signIn, setSignIn] = useState<SignIn>({ step: "idle" });

  const connect = useAction(connectToolkitAtom);
  const update = useAction(updateToolkitAtom);
  const start = useAction(startToolkitSignInAtom);
  const refreshToolkits = useAtomRefresh(toolkitsAtom);
  const busy = connect.busy || update.busy || start.busy;
  const shared = slot === "shared";
  const label = subjectLabel(subject, directory);
  const needsSettings = missingSettings(way, toolkit);
  const showsSettings = manage && isSettingsWay(way);

  const pickWay = (next: CredentialWay) => {
    setWay(next);
    setValues({});
    setProblems({});
    setProblem(undefined);
    setSettings(settingsValuesOf(next, toolkit.credential_settings));
  };

  const saveSettings = async (): Promise<boolean> => {
    if (!showsSettings || !isSettingsWay(way)) return true;
    const patch = settingsPatch(way, settings);

    if (!patch.ok) {
      setProblems(patch.problems);

      return false;
    }

    const next = withSettings(toolkit.credential_settings, patch.settings);

    if (JSON.stringify(next) === JSON.stringify(toolkit.credential_settings ?? {})) return true;

    const outcome = await update.run({
      params: { id: toolkit.id },
      headers: { "if-match": String(toolkit.revision) },
      payload: { credential_settings: next },
      reactivityKeys: TOOLKITS,
    });

    setProblem(problemOf(outcome));

    return outcome.ok;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    setProblems({});

    if (way === "oauth") {
      const outcome = await start.run({
        params: { id: toolkit.id, slot },
        payload: signInBody(slot, subject),
      });

      if (outcome.ok) setSignIn({ step: "open", started: outcome.value });
      else setProblem(problemOf(outcome));

      return;
    }

    if (needsSettings && !manage) {
      setProblem(
        `An org admin must set this toolkit's ${wayName(way)} settings before it can connect.`,
      );

      return;
    }

    const body = connectBody(way, values, toolkit, shared ? subject : undefined);

    if (!body.ok) {
      setProblems(body.problems);
      setProblem(body.problems[FORM_PROBLEM]);

      return;
    }

    if (!(await saveSettings())) return;

    // SAFETY: the client types the request as one union member per ConnectCredential member, and `body.body` is one.
    const request = {
      params: { id: toolkit.id, slot },
      payload: body.body,
      reactivityKeys: TOOLKITS,
    } as Parameters<typeof connect.run>[0];

    const outcome = await connect.run(request);

    if (outcome.ok) {
      setValues({});
      onDone(connectedText(outcome.value.grant, shared ? label : undefined));
    } else {
      setProblem(problemOf(outcome));

      if (outcome.error === "conflict") refreshToolkits();
    }
  };

  if (signIn.step === "open")
    return (
      <SignInWait
        toolkit={toolkit}
        started={signIn.started}
        onSettled={(next) => {
          if (next.step === "done") {
            refreshToolkits();
            onDone(
              shared ? `Signed in. ${label} may use it, under their tool grants.` : "Signed in.",
            );
          } else setSignIn(next);
        }}
      />
    );

  return (
    <form className={styles["form"]} onSubmit={submit} noValidate aria-label="Connect a credential">
      <div className={styles["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-way`}>
          How it signs in
        </label>
        <select
          id={`${ids}-way`}
          className={kit["input"]}
          value={way}
          onChange={(event) => {
            const next = ways.find((each) => each === event.target.value);

            if (next !== undefined) pickWay(next);
          }}
        >
          {ways.map((each) => (
            <option key={each} value={each}>
              {wayLabel(each)}
            </option>
          ))}
        </select>
        {way === "oauth" ? (
          <span className={styles["hint"]}>
            {toolkit.oauth_app !== undefined
              ? "Signs in through the toolkit's OAuth app."
              : toolkit.managed_oauth_app === true
                ? "Signs in through Commissary Cloud's OAuth app with the service."
                : manage
                  ? "Commissary registers itself with the MCP server's sign-in. A service that does not allow that needs an OAuth app, under Settings below."
                  : "Commissary registers itself with the MCP server's sign-in."}
          </span>
        ) : null}
      </div>
      {showsSettings ? (
        <div className={styles["inset"]}>
          <h4 className={styles["insetTitle"]}>{wayLabel(way)} settings</h4>
          <p className={styles["hint"]}>
            The toolkit&rsquo;s, the same for its shared credential and every member&rsquo;s own;
            nothing in them is secret.
          </p>
          <SpecFields
            specs={settingsFields(way)}
            values={settings}
            problems={problems}
            onChange={(key, value) => setSettings((now) => ({ ...now, [key]: value }))}
          />
        </div>
      ) : needsSettings ? (
        <p className={styles["flag"]}>
          <TrailMark />
          An org admin must set this toolkit&rsquo;s {wayName(way)} settings first.
        </p>
      ) : null}
      {way === "compound" && credentialFields(way, toolkit).length === 0 ? (
        <p className={styles["hint"]}>
          The fields come from the template in the settings: save them with a field like{" "}
          <code>{"{api_key}"}</code>, then fill it in.
        </p>
      ) : null}
      <SpecFields
        specs={credentialFields(way, toolkit)}
        values={values}
        problems={problems}
        onChange={(key, value) => setValues((now) => ({ ...now, [key]: value }))}
      />
      {shared ? (
        <SubjectPicker
          toolkit={toolkit}
          subject={subject}
          onChange={setPicked}
          members={directory.members}
          teams={directory.teams}
          grants={directory.grants}
        />
      ) : null}
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      {signIn.step === "failed" ? (
        <Problem>The sign-in did not finish. {signIn.message}</Problem>
      ) : null}
      <div className={styles["actions"]}>
        <button type="submit" className={kit["primary"]} disabled={busy} aria-busy={busy}>
          {way === "oauth" ? (
            <LogIn aria-hidden="true" size={18} strokeWidth={2.25} />
          ) : (
            <Plug aria-hidden="true" size={18} strokeWidth={2.25} />
          )}
          {busy
            ? way === "oauth"
              ? "Starting…"
              : "Connecting…"
            : way === "oauth"
              ? "Sign in"
              : "Connect"}
        </button>
        {onCancel === undefined ? null : (
          <button type="button" className={kit["secondary"]} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
};

const SLOT_TITLES: Readonly<Record<CredentialSlot, string>> = {
  shared: "Shared credential",
  private: "Your private credential",
};

const slotLead = (toolkit: ToolkitView, slot: CredentialSlot): string => {
  if (slot === "shared")
    return "The org's: members use it under their tool grants, unless they connect a private credential of their own.";

  return toolkit.private
    ? "This private toolkit signs in with your private credential, and only you use it."
    : "Yours alone: your calls use it in place of the shared one, as you, with every tool an org admin has not hidden.";
};

/** One slot: its state, the form while it is open, and removing what is connected. */
export const CredentialSlotBlock = ({
  toolkit,
  slot,
  manage,
  onConnected,
}: {
  readonly toolkit: ToolkitView;
  readonly slot: CredentialSlot;
  readonly manage: boolean;
  /** Said once the slot is connected (the connect page says to retry the call). */
  readonly onConnected?: (text: string) => void;
}) =>
  slot === "shared" ? (
    <SharedSlot toolkit={toolkit} manage={manage} />
  ) : (
    <Slot
      toolkit={toolkit}
      slot={slot}
      manage={manage}
      directory={NO_DIRECTORY}
      onConnected={onConnected}
    />
  );

/** The shared slot reads the org's members, teams and tool grants for its picker. */
const SharedSlot = ({
  toolkit,
  manage,
}: {
  readonly toolkit: ToolkitView;
  readonly manage: boolean;
}) => (
  <Slot
    toolkit={toolkit}
    slot="shared"
    manage={manage}
    directory={useDirectory()}
    onConnected={undefined}
  />
);

const Slot = ({
  toolkit,
  slot,
  manage,
  directory,
  onConnected,
}: {
  readonly toolkit: ToolkitView;
  readonly slot: CredentialSlot;
  readonly manage: boolean;
  readonly directory: Directory;
  readonly onConnected: ((text: string) => void) | undefined;
}) => {
  const credential = slot === "shared" ? toolkit.credentials.shared : toolkit.credentials.mine;
  const [open, setOpen] = useState(credential === undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const disconnect = useAction(disconnectToolkitAtom);
  const resign = credential?.needs_sign_in === true;

  const askRemove = () =>
    setConfirm({
      title:
        slot === "shared" ? "Remove the shared credential?" : "Remove your private credential?",
      body: (
        <p>
          {slot === "shared"
            ? `${toolkit.name}'s shared credential is deleted at once. Members granted it lose its tools until another is connected; their grants stay.`
            : `Your private credential for ${toolkit.name} is deleted at once.`}
        </p>
      ),
      action: "Remove",
      busyAction: "Removing…",
      run: async () => {
        const outcome = await disconnect.run({
          params: { id: toolkit.id, slot },
          reactivityKeys: TOOLKITS,
        });

        setProblem(problemOf(outcome));

        if (outcome.ok) {
          setDone(undefined);
          setOpen(true);
        }
      },
    });

  return (
    <div className={styles["slot"]}>
      <h3 className={styles["slotTitle"]}>{SLOT_TITLES[slot]}</h3>
      <p className={styles["lead"]}>{slotLead(toolkit, slot)}</p>
      <SlotState credential={credential} />
      {done === undefined ? null : (
        <p className={styles["done"]} role="status">
          <Check aria-hidden="true" size={20} strokeWidth={2.75} />
          {done}
        </p>
      )}
      {open ? (
        <CredentialForm
          key={credential?.connected_at ?? "none"}
          toolkit={toolkit}
          slot={slot}
          manage={manage}
          directory={directory}
          onDone={(text) => {
            setDone(text);
            setOpen(false);
            onConnected?.(text);
          }}
          onCancel={credential === undefined ? undefined : () => setOpen(false)}
        />
      ) : (
        <div className={styles["actions"]}>
          <button
            type="button"
            className={resign ? kit["primary"] : kit["secondary"]}
            onClick={() => {
              setDone(undefined);
              setOpen(true);
            }}
          >
            {resign ? "Sign in again" : "Replace"}
          </button>
          {credential === undefined ? null : (
            <button
              type="button"
              className={kit["danger"]}
              disabled={disconnect.busy}
              onClick={askRemove}
            >
              Remove
            </button>
          )}
        </div>
      )}
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <ConfirmDialog
        request={confirm}
        busy={disconnect.busy}
        onClose={() => setConfirm(undefined)}
      />
    </div>
  );
};

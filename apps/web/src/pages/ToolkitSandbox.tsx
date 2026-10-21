// The sandbox toolkit's own parts of its page (#225, ADR 0041, ADR 0043, ADR 0044): the org's ceiling on what a sandbox
// may have (the widest network, and whether it may use the computer), set by org admins, and the toolkit's open
// sessions: a member's own, and for an org admin the org's, each of which its viewer may end. The price per computer
// hour is in the prices (`ToolkitPrices`), as the browser's price per hour is. The server decides who sees what and
// enforces every rule again; where the deployment has no computer (`deployment.computer`) the settings show it turned
// off for admins, with the reason and a link to the docs, and a member is told nothing.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { SandboxSessionView } from "@commissary/contract/sandbox-sessions";
import type { ToolkitView } from "@commissary/contract/tools";
import {
  endSandboxSessionAtom,
  nowAtom,
  SANDBOX_SESSIONS,
  sandboxSessionsAtom,
  TOOLKITS,
  updateToolkitAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { NetworkPicker } from "../components/NetworkPicker.tsx";
import { sandboxCeilingText } from "../lib/agent-form.ts";
import { failureMessage } from "../lib/failure.ts";
import type { NetworkFields } from "../lib/sandbox-network.ts";
import {
  COMPUTER_HINT,
  draftOfToolkit,
  LEAK_WARNING,
  NO_COMPUTER_REASON,
  OPTIONAL_PIECES_URL,
  SESSIONS_KEEP_NOTE,
  type SandboxSettingsDraft,
  settingsBody,
  settingsChanged,
  settingsProblem,
} from "../lib/sandbox-settings.ts";
import {
  emptySessionsText,
  endConfirmText,
  endLabel,
  endProblem,
  sessionRow,
  TRUNCATED_TEXT,
  sessionsIntroText,
  sortSessions,
} from "../lib/sandbox-sessions.ts";
import { problemOf } from "../lib/toolkits.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Tools.module.css";

// ---------------------------------------------------------------------------------------------------------------
// Settings

/**
 * The ceiling, for org admins: the network (none, allowed hosts with the package registries preset, or the internet) and
 * whether the computer is allowed. `computerAvailable`: the deployment has a computer.
 */
export const SandboxSettings = ({
  toolkit,
  computerAvailable,
}: {
  readonly toolkit: ToolkitView;
  readonly computerAvailable: boolean;
}) => {
  const id = useId();
  const update = useAction(updateToolkitAtom);

  const [draft, setDraft] = useState<SandboxSettingsDraft>(() =>
    draftOfToolkit(toolkit, computerAvailable),
  );

  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const invalid = settingsProblem(draft);
  const changed = settingsChanged(toolkit, draft, computerAvailable);

  const edit = (next: SandboxSettingsDraft) => {
    setDraft(next);
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    setSaved(false);

    if (invalid !== undefined || !changed) return;

    const outcome = await update.run({
      params: { id: toolkit.id },
      headers: { "if-match": String(toolkit.revision) },
      payload: settingsBody(toolkit, draft, computerAvailable),
      reactivityKeys: TOOLKITS,
    });

    if (outcome.ok) setSaved(true);
    else setProblem(problemOf(outcome) ?? outcome.message);
  };

  return (
    <Section title="Sandbox settings" className={styles["section"]}>
      <p className={styles["lead"]}>
        The org&rsquo;s ceiling: its sandboxes may have{" "}
        {sandboxCeilingText({
          ...toolkit,
          computer: computerAvailable && toolkit.computer === true,
        })}
        . A client&rsquo;s session and a hosted agent&rsquo;s sandbox pick within it.
      </p>
      <form className={styles["form"]} onSubmit={(event) => void submit(event)} noValidate>
        <p className={styles["note"]}>{LEAK_WARNING}</p>
        <NetworkPicker
          label="Widest network"
          fields={draft}
          onChange={(fields: NetworkFields) => edit({ ...draft, ...fields })}
          problem={invalid}
        />
        <div className={styles["field"]}>
          <label className={styles["check"]} data-allowed={computerAvailable}>
            <input
              type="checkbox"
              checked={draft.computer}
              disabled={!computerAvailable}
              aria-describedby={`${id}-computer`}
              onChange={(event) => edit({ ...draft, computer: event.target.checked })}
            />
            May use the computer
          </label>
          <span id={`${id}-computer`} className={styles["hint"]}>
            {computerAvailable ? (
              COMPUTER_HINT
            ) : (
              <>
                {NO_COMPUTER_REASON}{" "}
                <a href={OPTIONAL_PIECES_URL} target="_blank" rel="noopener noreferrer">
                  Optional pieces, in DEPLOY.md
                </a>
                .
              </>
            )}
          </span>
        </div>
        <p className={styles["hint"]}>{SESSIONS_KEEP_NOTE}</p>
        {problem === undefined ? null : <Problem>{problem}</Problem>}
        <div className={styles["actions"]}>
          <button
            type="submit"
            className={kit["primary"]}
            disabled={update.busy || !changed || invalid !== undefined}
            aria-busy={update.busy}
          >
            {update.busy ? "Saving…" : "Save settings"}
          </button>
          {saved ? (
            <span className={styles["note"]} role="status">
              Saved.
            </span>
          ) : null}
        </div>
      </form>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Open sessions

/** Ending a session: the confirmation, the call, and what came of it. */
const useEnd = () => {
  const end = useAction(endSandboxSessionAtom);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const ask = (session: SandboxSessionView) => {
    setProblem(undefined);

    setConfirm({
      title: "End this sandbox session?",
      body: <p>{endConfirmText(session)}</p>,
      action: "End session",
      busyAction: "Ending…",
      keep: "Keep it open",
      run: async () => {
        const outcome = await end.run({
          params: { id: session.id },
          reactivityKeys: SANDBOX_SESSIONS,
        });

        if (!outcome.ok) setProblem(endProblem(outcome.error, outcome.message));
      },
    });
  };

  const dialog = (
    <>
      {problem === undefined ? null : <Problem>Could not end the session. {problem}</Problem>}
      <ConfirmDialog request={confirm} busy={end.busy} onClose={() => setConfirm(undefined)} />
    </>
  );

  return { ask, busy: end.busy, dialog } as const;
};

const Sessions = ({ admin }: { readonly admin: boolean }) => {
  const result = useAtomValue(sandboxSessionsAtom);
  const retry = useAtomRefresh(sandboxSessionsAtom);
  const now = useAtomValue(nowAtom);
  const end = useEnd();

  const list = AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the sessions…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the sessions. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      const rows = sortSessions(value.sessions).map((session) => sessionRow(session, now));

      return rows.length === 0 ? (
        <p className={styles["empty"]}>{emptySessionsText(admin)}</p>
      ) : (
        <div className={styles["scroll"]}>
          <table className={styles["table"]}>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Opened</th>
                <th scope="col" className={styles["wide"]}>
                  Network
                </th>
                <th scope="col" className={styles["wide"]}>
                  Computer
                </th>
                <th scope="col">
                  <span className={kit["visuallyHidden"]}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.session.id}>
                  <td>
                    <div className={styles["name"]}>
                      {row.owner}
                      <span className={styles["secondary"]}>{row.how}</span>
                    </div>
                    {/* On a narrow screen the network and the computer fold in here. */}
                    <div className={styles["narrowOnly"]}>
                      Network: {row.network} · Computer: {row.computer}
                    </div>
                  </td>
                  <td>{row.opened}</td>
                  <td className={styles["wide"]}>{row.network}</td>
                  <td className={styles["wide"]}>{row.computer}</td>
                  <td className={styles["number"]}>
                    <button
                      type="button"
                      className={styles["linkButton"]}
                      aria-label={endLabel(row)}
                      disabled={end.busy}
                      onClick={() => end.ask(row.session)}
                    >
                      End
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {value.truncated ? <p className={styles["hint"]}>{TRUNCATED_TEXT}</p> : null}
        </div>
      );
    },
  });

  // Outside the list, so an end that failed, or a confirmation, outlives the list emptying.
  return (
    <>
      {list}
      {end.dialog}
    </>
  );
};

/** The toolkit's open sessions: the caller's own, and for an org admin the org's. Its own failure leaves the page be. */
export const SandboxSessions = ({ admin }: { readonly admin: boolean }) => (
  <Section title="Open sessions" className={styles["section"]}>
    <p className={styles["lead"]}>{sessionsIntroText(admin)}</p>
    <Sessions admin={admin} />
  </Section>
);

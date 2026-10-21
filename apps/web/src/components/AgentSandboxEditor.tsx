// The sandbox of a hosted agent (#233, #230, ADR 0041): the sandbox toolkit it works in, the network its sessions have and
// whether they may use the computer, within what the toolkit allows (its ceiling, set by org admins on the toolkit). An
// agent with a sandbox has pi's bash, read, write and edit tools in it; one without has none.
import { useId } from "react";
import type { ToolkitView } from "@commissary/contract/tools";
import {
  sandboxCeiling,
  sandboxCeilingText,
  networkAllowed,
  type SandboxDraft,
} from "../lib/agent-form.ts";
import { kit } from "./Kit.tsx";
import { NetworkPicker } from "./NetworkPicker.tsx";
import styles from "./AgentSandboxEditor.module.css";

export const AgentSandboxEditor = ({
  toolkits,
  draft,
  onChange,
  problem,
  scopeNote,
  computerAvailable,
  disabled = false,
}: {
  /** The sandbox toolkits the caller sees. */
  readonly toolkits: ReadonlyArray<ToolkitView>;
  readonly draft: SandboxDraft;
  readonly onChange: (draft: SandboxDraft) => void;
  readonly problem: string | undefined;
  /** What the tool scope lacks for the sandbox to be used (`sandboxScopeNote`). */
  readonly scopeNote?: string | undefined;
  /** The deployment has the sandbox's computer (`deployment.computer`). */
  readonly computerAvailable: boolean;
  readonly disabled?: boolean;
}) => {
  const id = useId();
  const ceiling = sandboxCeiling(toolkits, draft);
  const computerAllowed = computerAvailable && ceiling?.computer === true;

  const turnOn = (on: boolean) =>
    onChange(
      on
        ? { ...draft, on, toolkit: draft.toolkit === "" ? (toolkits[0]?.id ?? "") : draft.toolkit }
        : { ...draft, on },
    );

  return (
    <fieldset
      className={styles["sandbox"]}
      disabled={disabled}
      aria-describedby={problem === undefined ? `${id}-note` : `${id}-problem`}
    >
      <legend className={kit["fieldLabel"]}>Sandbox</legend>
      {toolkits.length === 0 ? (
        <p id={`${id}-note`} className={kit["muted"]}>
          No sandbox toolkit is there yet, so its runs have no bash or file tools.
        </p>
      ) : (
        <>
          <label className={styles["check"]}>
            <input type="checkbox" checked={draft.on} onChange={(e) => turnOn(e.target.checked)} />
            Give its runs a sandbox to work in
          </label>
          <p id={`${id}-note`} className={kit["muted"]}>
            With one, a run has bash, read, write and edit tools in its own sandbox. Each call is
            still checked against the agent&rsquo;s tool scope, so give it the sandbox
            toolkit&rsquo;s tools above too.
          </p>
          {draft.on ? (
            <div className={styles["settings"]}>
              {toolkits.length > 1 ? (
                <div className={kit["field"]}>
                  <label className={kit["fieldLabel"]} htmlFor={`${id}-toolkit`}>
                    Sandbox toolkit
                  </label>
                  <select
                    id={`${id}-toolkit`}
                    className={kit["input"]}
                    value={draft.toolkit}
                    onChange={(event) => onChange({ ...draft, toolkit: event.target.value })}
                  >
                    {toolkits.map((each) => (
                      <option key={each.id} value={each.id}>
                        {each.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <NetworkPicker
                fields={draft}
                onChange={(fields) => onChange({ ...draft, ...fields })}
                allowed={(kind) => networkAllowed(kind, ceiling?.network)}
                beyond="Beyond what the sandbox toolkit allows."
              />
              <label className={styles["check"]} data-allowed={computerAllowed}>
                <input
                  type="checkbox"
                  checked={draft.computer}
                  disabled={!computerAllowed && !draft.computer}
                  onChange={(event) => onChange({ ...draft, computer: event.target.checked })}
                />
                May use the computer
              </label>
              <p className={kit["muted"]}>
                {computerAllowed
                  ? "The computer runs commands the sandbox's own shell cannot, and is priced by the hour."
                  : computerAvailable
                    ? "The sandbox toolkit does not allow the computer."
                    : "This deployment has no computer."}
              </p>
              {scopeNote === undefined ? null : <p className={styles["note"]}>{scopeNote}</p>}
              {ceiling === undefined ? null : (
                <p className={kit["muted"]}>
                  The sandbox toolkit allows {sandboxCeilingText(ceiling)}.
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
      {problem === undefined ? null : (
        <p id={`${id}-problem`} className={kit["fieldError"]} role="alert">
          {problem}
        </p>
      )}
    </fieldset>
  );
};

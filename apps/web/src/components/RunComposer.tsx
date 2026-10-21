// The message box of a chat with a hosted agent (#234): on an agent's chat page it starts the run; on a run's page it
// steers the running turn or starts a new turn on an idle run, with Stop beside it while a turn runs. Enter sends,
// Shift+Enter starts a new line. What sending does now is said under it (`hint`), and what it did after (`note`).
import { Send, Square } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import styles from "../pages/AgentRuns.module.css";
import { kit, Problem } from "./Kit.tsx";

export interface RunComposerProps {
  /** The button's words: "Start chat", "Send" or "Steer". */
  readonly send: string;
  /** The button's words while it sends. */
  readonly sending: string;
  readonly hint: string;
  readonly label: string;
  readonly busy: boolean;
  /** Sends `text`: answers what went wrong, or what it did (`note`), the box emptied. */
  readonly onSend: (
    text: string,
  ) => Promise<{ readonly problem: string } | { readonly note?: string | undefined }>;
  /** Stop, while a turn runs. */
  readonly stop?: { readonly busy: boolean; readonly onStop: () => void } | undefined;
}

export const RunComposer = ({
  send,
  sending,
  hint,
  label,
  busy,
  onSend,
  stop,
}: RunComposerProps) => {
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const empty = text.trim() === "";

  const submit = async () => {
    if (empty || busy) return;
    setProblem(undefined);
    setNote(undefined);

    const outcome = await onSend(text);

    if ("problem" in outcome) setProblem(outcome.problem);
    else {
      setText("");
      setNote(outcome.note);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form
      className={styles["composer"]}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className={kit["visuallyHidden"]}>
        {label}
      </label>
      <textarea
        id={id}
        className={styles["message"]}
        value={text}
        placeholder={label}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles["actions"]}>
        <button type="submit" className={kit["primary"]} disabled={busy || empty} aria-busy={busy}>
          <Send
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={busy ? kit["spinning"] : undefined}
          />
          {busy ? sending : send}
        </button>
        {stop === undefined ? null : (
          <button
            type="button"
            className={kit["secondary"]}
            disabled={stop.busy}
            aria-busy={stop.busy}
            onClick={stop.onStop}
          >
            <Square
              aria-hidden="true"
              size={16}
              strokeWidth={2.25}
              className={stop.busy ? kit["spinning"] : undefined}
            />
            {stop.busy ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      <p className={styles["hint"]}>{hint} Enter sends; Shift+Enter starts a new line.</p>
      {note === undefined ? null : (
        <p className={styles["sent"]} role="status">
          {note}
        </p>
      )}
      {problem === undefined ? null : <Problem>{problem}</Problem>}
    </form>
  );
};

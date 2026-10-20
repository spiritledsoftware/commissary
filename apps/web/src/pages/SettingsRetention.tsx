// The org's retention periods (ADR 0027): how long usage records are kept before the scheduled prune deletes them, and
// how long agent runs are kept after their last activity (#228, ADR 0040), with their transcripts. Org admins set each,
// from 1 to 3650 days or "keep forever"; where none is set the section suggests the default of a new org (90 days for
// usage records, 30 for agent runs).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { OrgView } from "@commissary/contract/orgs";
import { orgAtom, ORGS, updateOrgSettingsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import {
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  parseRetentionDays,
  type Retained,
  retentionPayload,
  retentionSentence,
  suggestedDays,
} from "../lib/retention.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./SettingsOrg.module.css";
import settings from "./Settings.module.css";

type Mode = "days" | "forever";

/** How each form names what it keeps. */
const WORDING: Record<
  Retained,
  { readonly form: string; readonly legend: string; readonly lead: string; readonly unset: string }
> = {
  usage: {
    form: "Usage retention",
    legend: "How long usage records are kept",
    lead: "Older records are deleted automatically. A usage record holds tokens, cost, latency and the outcome of a request, never its prompt or response.",
    unset: "No retention period is set: usage records are kept until you delete the org.",
  },
  runs: {
    form: "Agent run retention",
    legend: "How long agent runs are kept after their last activity",
    lead: "A run idle for longer is deleted automatically with its transcript, never while it is working. Its usage records follow the usage retention period.",
    unset: "No retention period is set: agent runs are kept until you delete the org.",
  },
};

/** The choice and the days input; remounted (`key`) when the saved period changes, so it starts from the new one. */
const RetentionForm = ({
  retained,
  days,
  onSave,
  busy,
}: {
  readonly retained: Retained;
  readonly days: number | null;
  readonly onSave: (days: number | null) => void;
  readonly busy: boolean;
}) => {
  const [mode, setMode] = useState<Mode>(days === null ? "forever" : "days");
  const [text, setText] = useState(String(days ?? suggestedDays(retained)));
  const ids = useId();
  const parsed = mode === "forever" ? null : parseRetentionDays(text);
  const invalid = mode === "days" && parsed === undefined;
  const unchanged = parsed === days;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (parsed !== undefined && !unchanged) onSave(parsed);
  };

  return (
    <form className={styles["form"]} onSubmit={submit} aria-label={WORDING[retained].form}>
      <fieldset className={styles["choices"]}>
        <legend className={kit["visuallyHidden"]}>{WORDING[retained].legend}</legend>
        <label className={styles["choice"]} htmlFor={`${ids}-days`}>
          <input
            id={`${ids}-days`}
            type="radio"
            name={`${ids}-mode`}
            checked={mode === "days"}
            onChange={() => setMode("days")}
          />
          <span>Keep for</span>
          <input
            className={`${kit["input"]} ${styles["days"]}`}
            type="number"
            inputMode="numeric"
            min={MIN_RETENTION_DAYS}
            max={MAX_RETENTION_DAYS}
            step={1}
            value={text}
            aria-label="Days"
            aria-invalid={invalid}
            onFocus={() => setMode("days")}
            onChange={(event) => {
              setMode("days");
              setText(event.target.value);
            }}
          />
          <span>days</span>
        </label>
        <label className={styles["choice"]}>
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={mode === "forever"}
            onChange={() => setMode("forever")}
          />
          <span>Keep forever</span>
        </label>
      </fieldset>
      {invalid ? (
        <p className={kit["fieldError"]}>
          Whole days, from {MIN_RETENTION_DAYS} to {MAX_RETENTION_DAYS}.
        </p>
      ) : null}
      <div className={styles["actions"]}>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={busy || invalid || unchanged}
          aria-busy={busy}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
};

const Retention = ({ org, retained }: { readonly org: OrgView; readonly retained: Retained }) => {
  const update = useAction(updateOrgSettingsAtom);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const days = retained === "usage" ? org.usage_retention_days : org.run_retention_days;
  const suggested = suggestedDays(retained);
  const wording = WORDING[retained];

  const save = async (next: number | null) => {
    setProblem(undefined);
    setSaved(false);

    const outcome = await update.run({
      payload: retentionPayload(retained, next),
      reactivityKeys: ORGS,
    });

    if (outcome.ok) setSaved(true);
    else setProblem(outcome.detail ?? outcome.message);
  };

  return (
    <>
      <p className={settings["lead"]}>
        <b>{retentionSentence(days, retained)}</b> {wording.lead}
      </p>
      {days === null ? (
        <div className={styles["suggest"]}>
          <p>
            {wording.unset} {suggested} days is a common choice.
          </p>
          <button
            type="button"
            className={kit["secondary"]}
            disabled={update.busy}
            onClick={() => save(suggested)}
          >
            Use {suggested} days
          </button>
        </div>
      ) : null}
      <RetentionForm
        key={String(days)}
        retained={retained}
        days={days}
        busy={update.busy}
        onSave={save}
      />
      {problem === undefined ? null : (
        <p className={kit["fieldError"]} role="alert">
          {problem}
        </p>
      )}
      {saved && problem === undefined ? (
        <p className={styles["state"]} role="status">
          Saved.
        </p>
      ) : null}
    </>
  );
};

/**
 * The section's body: the org's current periods, once read, usage records' and agent runs'. Only org admins reach the
 * page, and they may change them.
 */
export const RetentionBody = () => {
  const result = useAtomValue(orgAtom);
  const retry = useAtomRefresh(orgAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the retention periods…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>
        Could not load the retention periods. {failureMessage(failure)}
      </Problem>
    ),
    onSuccess: ({ value }) => (
      <>
        <h3 className={styles["subheading"]}>Usage records</h3>
        <Retention org={value} retained="usage" />
        <h3 className={styles["subheading"]}>Agent runs</h3>
        <Retention org={value} retained="runs" />
      </>
    ),
  });
};

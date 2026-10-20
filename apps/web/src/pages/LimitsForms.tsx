// The Limits page's forms: the org's calendar (time zone and first day of the week, org admins) and a new Spend limit
// (org admins on anything, a plain member on their own API keys).
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { SpendPeriod, SpendSettingsView, SpendSubjectKind } from "@commissary/contract/spend";
import {
  createSpendLimitAtom,
  credentialsAtom,
  membersAtom,
  apiKeysAtom,
  SPEND,
  teamsAtom,
  updateSpendSettingsAtom,
} from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { accountName } from "../lib/accounts.ts";
import {
  amountProblem,
  kindLabel,
  knownZones,
  limitProblem,
  parseDollars,
  PERIODS,
  SUBJECT_KINDS,
  WEEK_STARTS,
  zoneProblem,
} from "../lib/spend.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Limits.module.css";

/** What the last write said: a result to announce, or why it was refused. */
export type Note = { readonly tone: "done" | "problem"; readonly text: string };

export const NoteLine = ({
  note,
  what,
}: {
  readonly note: Note | undefined;
  readonly what: string;
}) => (
  <>
    {note?.tone === "problem" ? (
      <Problem>
        Could not {what}. {note.text}
      </Problem>
    ) : null}
    <p className={styles["note"]} role="status">
      {note?.tone === "done" ? note.text : null}
    </p>
  </>
);

// ---------------------------------------------------------------------------------------------------------------
// Calendar

export const CalendarForm = ({ settings }: { readonly settings: SpendSettingsView }) => {
  const ids = useId();
  const save = useAction(updateSpendSettingsAtom);
  const [zone, setZone] = useState(settings.time_zone);
  const [weekStart, setWeekStart] = useState<string>(settings.week_start);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const issue = zoneProblem(zone);
  const unchanged = zone.trim() === settings.time_zone && weekStart === settings.week_start;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNote(undefined);

    if (issue !== undefined) return;

    const outcome = await save.run({
      payload: { time_zone: zone.trim(), week_start: weekStart },
      reactivityKeys: SPEND,
    });

    setNote(
      outcome.ok
        ? { tone: "done", text: "Saved. Periods now start by this calendar." }
        : { tone: "problem", text: limitProblem(outcome.error, outcome.message, outcome.detail) },
    );
  };

  return (
    <>
      <form className={styles["form"]} onSubmit={submit} noValidate aria-label="Calendar">
        <div className={styles["formRow"]}>
          <div className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-zone`}>
              Time zone
            </label>
            <input
              id={`${ids}-zone`}
              className={kit["input"]}
              list={`${ids}-zones`}
              autoComplete="off"
              spellCheck={false}
              value={zone}
              aria-invalid={issue !== undefined}
              aria-describedby={`${ids}-hint`}
              onChange={(event) => setZone(event.target.value)}
            />
            <datalist id={`${ids}-zones`}>
              {knownZones().map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div className={`${kit["field"]} ${styles["narrow"]}`}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-week`}>
              Week starts on
            </label>
            <select
              id={`${ids}-week`}
              className={kit["input"]}
              value={weekStart}
              onChange={(event) => setWeekStart(event.target.value)}
            >
              {WEEK_STARTS.map((day) => (
                <option key={day.id} value={day.id}>
                  {day.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className={kit["primary"]}
            disabled={unchanged || save.busy}
            aria-busy={save.busy}
          >
            {save.busy ? "Saving…" : "Save calendar"}
          </button>
        </div>
        <p id={`${ids}-hint`} className={issue === undefined ? kit["muted"] : kit["fieldError"]}>
          {issue ??
            "A day runs from midnight to midnight in this time zone, so a daily limit starts over at local midnight. Changing the calendar starts the periods that begin differently afresh."}
        </p>
      </form>
      <NoteLine note={note} what="save the calendar" />
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// New limit

interface Subject {
  readonly id: string;
  readonly label: string;
}

/** What each kind of limit can name, from the lists the panel already loads. */
const useSubjects = (): Readonly<Record<SpendSubjectKind, ReadonlyArray<Subject>>> => {
  const people = useAtomValue(membersAtom);
  const groups = useAtomValue(teamsAtom);
  const files = useAtomValue(credentialsAtom);
  const keys = useAtomValue(apiKeysAtom);

  return {
    org: [],
    member: AsyncResult.isSuccess(people)
      ? people.value.members.map((member) => ({ id: member.id, label: member.email }))
      : [],
    team: AsyncResult.isSuccess(groups)
      ? groups.value.teams.map((team) => ({ id: team.id, label: team.name }))
      : [],
    credential: AsyncResult.isSuccess(files)
      ? files.value.files
          .filter((entry) => entry.private !== true)
          .map((entry) => ({ id: entry.auth_index, label: accountName(entry) }))
      : [],
    key: AsyncResult.isSuccess(keys)
      ? keys.value.keys
          .filter((key) => key.revoked_at === undefined)
          .map((key) => ({
            id: key.id,
            label: key.mine ? key.name : `${key.name} (${key.member_email ?? key.member_id})`,
          }))
      : [],
    // The form does not offer toolkit limits yet (#209).
    toolkit: [],
  };
};

export const NewLimit = ({ admin }: { readonly admin: boolean }) => {
  const ids = useId();
  const create = useAction(createSpendLimitAtom);
  const subjects = useSubjects();
  const kinds = admin ? SUBJECT_KINDS : SUBJECT_KINDS.filter((kind) => kind.id === "key");
  const [kind, setKind] = useState<SpendSubjectKind>(admin ? "org" : "key");
  const [subject, setSubject] = useState("");
  const [period, setPeriod] = useState<SpendPeriod>("day");
  const [amount, setAmount] = useState("");
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const options = subjects[kind];
  const needsSubject = kind !== "org";
  const amountIssue = tried ? amountProblem(amount) : undefined;

  const subjectIssue =
    tried && needsSubject && subject === "" ? "Choose what to limit." : undefined;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    setNote(undefined);
    const micros = parseDollars(amount);

    if (micros === undefined || (needsSubject && subject === "")) return;

    const outcome = await create.run({
      payload: { kind, subject: needsSubject ? subject : "", period, amount_micros: micros },
      reactivityKeys: SPEND,
    });

    if (outcome.ok) {
      setAmount("");
      setTried(false);
      setNote({ tone: "done", text: "Limit added." });
    } else {
      setNote({
        tone: "problem",
        text: limitProblem(outcome.error, outcome.message, outcome.detail),
      });
    }
  };

  return (
    <>
      <form className={styles["form"]} onSubmit={submit} noValidate aria-label="New limit">
        <div className={styles["formRow"]}>
          {admin ? (
            <div className={`${kit["field"]} ${styles["narrow"]}`}>
              <label className={kit["fieldLabel"]} htmlFor={`${ids}-kind`}>
                Limit
              </label>
              <select
                id={`${ids}-kind`}
                className={kit["input"]}
                value={kind}
                onChange={(event) => {
                  // SAFETY: the options are the SUBJECT_KINDS ids.
                  setKind(event.target.value as SpendSubjectKind);
                  setSubject("");
                }}
              >
                {kinds.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {needsSubject ? (
            <div className={kit["field"]}>
              <label className={kit["fieldLabel"]} htmlFor={`${ids}-subject`}>
                {kindLabel(kind)}
              </label>
              <select
                id={`${ids}-subject`}
                className={kit["input"]}
                value={subject}
                aria-invalid={subjectIssue !== undefined}
                onChange={(event) => setSubject(event.target.value)}
              >
                <option value="">Choose…</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className={`${kit["field"]} ${styles["narrow"]}`}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-period`}>
              Per
            </label>
            <select
              id={`${ids}-period`}
              className={kit["input"]}
              value={period}
              onChange={(event) => {
                // SAFETY: the options are the PERIODS ids.
                setPeriod(event.target.value as SpendPeriod);
              }}
            >
              {PERIODS.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label.toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className={`${kit["field"]} ${styles["narrow"]}`}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-amount`}>
              Amount (USD)
            </label>
            <input
              id={`${ids}-amount`}
              className={kit["input"]}
              inputMode="decimal"
              autoComplete="off"
              placeholder="25.00"
              value={amount}
              aria-invalid={amountIssue !== undefined}
              aria-describedby={`${ids}-hint`}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className={kit["primary"]}
            disabled={create.busy}
            aria-busy={create.busy}
          >
            {create.busy ? "Adding…" : "Add limit"}
          </button>
        </div>
        <p
          id={`${ids}-hint`}
          className={
            amountIssue === undefined && subjectIssue === undefined
              ? kit["muted"]
              : kit["fieldError"]
          }
        >
          {amountIssue ??
            subjectIssue ??
            (admin
              ? "Spend is what Commissary has counted at its prices. A request that would start over the limit is refused with a 429 until the period ends; one already running finishes."
              : "Limit one of your own API keys. It counts everything the key does, and may not exceed a limit an org admin set on it.")}
        </p>
      </form>
      <NoteLine note={note} what="add the limit" />
    </>
  );
};

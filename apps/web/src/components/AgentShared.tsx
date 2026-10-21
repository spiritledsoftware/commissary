// The parts of a shared hosted agent's form that private agents lack (#233, ADR 0040): who may use it (required when it
// is created: there is no default grant), its watchers (the members and teams who read, steer and answer the runs no one
// started) and, when it is created, an optional Spend limit. Org admins only. The members and teams are the lists the
// Members and Grants pages read.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import type { AgentWatcher } from "@commissary/contract/agents";
import type { GrantSubject } from "@commissary/contract/grants";
import type { MemberView, TeamView } from "@commissary/contract/members";
import type { SpendPeriod } from "@commissary/contract/spend";
import { membersAtom, teamsAtom } from "../api/client.ts";
import { addWatcher, removeWatcher } from "../lib/agent-form.ts";
import { type Directory } from "../lib/grants.ts";
import { PERIODS } from "../lib/spend.ts";
import { kit } from "./Kit.tsx";
import parts from "./AgentParts.module.css";
import styles from "./AgentShared.module.css";

/** The org's members and teams, once both have loaded. */
export const useDirectory = (): Directory | undefined => {
  const members = useAtomValue(membersAtom);
  const teams = useAtomValue(teamsAtom);

  return AsyncResult.isSuccess(members) && AsyncResult.isSuccess(teams)
    ? { members: members.value.members, teams: teams.value.teams }
    : undefined;
};

const watcherLabel = (watcher: AgentWatcher, directory: Directory): string =>
  watcher.kind === "member"
    ? (directory.members.find((member) => member.id === watcher.id)?.email ?? watcher.id)
    : `${directory.teams.find((team) => team.id === watcher.id)?.name ?? watcher.id} (team)`;

const SUBJECT_KINDS: ReadonlyArray<{ readonly id: GrantSubject["kind"]; readonly label: string }> =
  [
    { id: "team", label: "A team" },
    { id: "member", label: "A member" },
    { id: "everyone", label: "Everyone in the org" },
  ];

/** Who the agent's grant names: a team, a member or everyone; a team or member is picked from the org's. */
export const SubjectPicker = ({
  directory,
  kind,
  subjectId,
  onChange,
  problem,
  label = "Who may use it",
  hint,
}: {
  readonly directory: Directory | undefined;
  readonly kind: GrantSubject["kind"] | "";
  readonly subjectId: string;
  readonly onChange: (kind: GrantSubject["kind"] | "", subjectId: string) => void;
  readonly problem: string | undefined;
  readonly label?: string;
  readonly hint?: string;
}) => {
  const id = useId();

  const options: ReadonlyArray<{ readonly id: string; readonly label: string }> =
    directory === undefined
      ? []
      : kind === "team"
        ? directory.teams.map((team: TeamView) => ({ id: team.id, label: team.name }))
        : kind === "member"
          ? directory.members.map((member: MemberView) => ({ id: member.id, label: member.email }))
          : [];

  return (
    <fieldset
      className={styles["subject"]}
      aria-invalid={problem !== undefined}
      aria-describedby={`${id}-note`}
    >
      <legend className={kit["fieldLabel"]}>{label}</legend>
      <div className={styles["kinds"]}>
        {SUBJECT_KINDS.map((each) => (
          <label key={each.id} className={styles["check"]}>
            <input
              type="radio"
              name={`${id}-kind`}
              checked={kind === each.id}
              onChange={() => onChange(each.id, "")}
            />
            {each.label}
          </label>
        ))}
      </div>
      {kind === "team" || kind === "member" ? (
        <div className={kit["field"]}>
          <label className={kit["visuallyHidden"]} htmlFor={`${id}-who`}>
            {kind === "team" ? "Team" : "Member"}
          </label>
          <select
            id={`${id}-who`}
            className={kit["input"]}
            value={subjectId}
            aria-invalid={problem !== undefined}
            onChange={(event) => onChange(kind, event.target.value)}
          >
            <option value="">{kind === "team" ? "Choose a team" : "Choose a member"}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <p
        id={`${id}-note`}
        className={problem === undefined ? kit["muted"] : kit["fieldError"]}
        role={problem === undefined ? undefined : "alert"}
      >
        {problem ??
          hint ??
          "A grant: whoever it names may chat with the agent and start it, and what it does is its own reach, not theirs."}
      </p>
    </fieldset>
  );
};

/** The watchers: the members and teams who watch a run no one started. Org admins watch it when none is left. */
export const WatcherPicker = ({
  directory,
  watchers,
  creatorWatches,
  onChange,
}: {
  readonly directory: Directory | undefined;
  /**
   * The agent is being created by an org member: with none picked they watch it. Otherwise (an edit, or a platform admin
   * who is no member) the org admins do.
   */
  readonly creatorWatches: boolean;
  readonly watchers: ReadonlyArray<AgentWatcher>;
  readonly onChange: (watchers: ReadonlyArray<AgentWatcher>) => void;
}) => {
  const id = useId();
  const [pick, setPick] = useState("");

  const choices: ReadonlyArray<{
    readonly value: string;
    readonly watcher: AgentWatcher;
    readonly label: string;
  }> =
    directory === undefined
      ? []
      : [
          ...directory.teams.map((team) => ({
            value: `team:${team.id}`,
            watcher: { kind: "team", id: team.id } as const,
            label: `${team.name} (team)`,
          })),
          ...directory.members.map((member) => ({
            value: `member:${member.id}`,
            watcher: { kind: "member", id: member.id } as const,
            label: member.email,
          })),
        ].filter(
          (choice) =>
            !watchers.some(
              (each) => each.kind === choice.watcher.kind && each.id === choice.watcher.id,
            ),
        );

  const chosen = choices.find((choice) => choice.value === pick);

  return (
    <fieldset className={styles["watchers"]} aria-describedby={`${id}-note`}>
      <legend className={kit["fieldLabel"]}>Watchers</legend>
      {watchers.length === 0 ? (
        <p className={kit["muted"]}>
          {creatorWatches
            ? "None picked: you watch its runs, as the agent\u2019s creator."
            : "None picked: the org admins watch its runs until you name some."}
        </p>
      ) : directory === undefined ? (
        <p className={kit["muted"]} aria-busy="true">
          Loading the watchers…
        </p>
      ) : (
        <ul className={styles["watcherList"]}>
          {watchers.map((watcher) => (
            <li key={`${watcher.kind}:${watcher.id}`} className={styles["watcherRow"]}>
              <span>{watcherLabel(watcher, directory)}</span>
              <button
                type="button"
                className={parts["linkButton"]}
                onClick={() => onChange(removeWatcher(watchers, watcher))}
              >
                Remove
                <span className={kit["visuallyHidden"]}> {watcherLabel(watcher, directory)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles["add"]}>
        <label className={kit["visuallyHidden"]} htmlFor={`${id}-pick`}>
          Add a watcher
        </label>
        <select
          id={`${id}-pick`}
          className={kit["input"]}
          value={pick}
          onChange={(event) => setPick(event.target.value)}
        >
          <option value="">Add a team or member</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={kit["secondary"]}
          disabled={chosen === undefined}
          onClick={() => {
            if (chosen === undefined) return;
            onChange(addWatcher(watchers, chosen.watcher));
            setPick("");
          }}
        >
          Add
        </button>
      </div>
      <p id={`${id}-note`} className={kit["muted"]}>
        Watchers read the runs of this agent that no one started (a schedule, a webhook), steer
        them, and answer their approvals. A run a member started is watched by that member.
      </p>
    </fieldset>
  );
};

/** An optional Spend limit for a shared agent that is being created: a period and a dollar amount. */
export const SpendFields = ({
  amount,
  period,
  onChange,
  problem,
}: {
  readonly amount: string;
  readonly period: SpendPeriod;
  readonly onChange: (amount: string, period: SpendPeriod) => void;
  readonly problem: string | undefined;
}) => {
  const id = useId();

  return (
    <fieldset className={styles["spend"]} aria-describedby={`${id}-note`}>
      <legend className={kit["fieldLabel"]}>Spend limit (optional)</legend>
      <div className={styles["add"]}>
        <div className={kit["field"]}>
          <label className={kit["visuallyHidden"]} htmlFor={`${id}-amount`}>
            Amount in US dollars
          </label>
          <input
            id={`${id}-amount`}
            className={kit["input"]}
            inputMode="decimal"
            placeholder="25"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem !== undefined}
            value={amount}
            onChange={(event) => onChange(event.target.value, period)}
          />
        </div>
        <div className={kit["field"]}>
          <label className={kit["visuallyHidden"]} htmlFor={`${id}-period`}>
            Period
          </label>
          <select
            id={`${id}-period`}
            className={kit["input"]}
            value={period}
            onChange={(event) =>
              onChange(amount, PERIODS.find((each) => each.id === event.target.value)?.id ?? period)
            }
          >
            {PERIODS.map((each) => (
              <option key={each.id} value={each.id}>
                US dollars per {each.id}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p
        id={`${id}-note`}
        className={problem === undefined ? kit["muted"] : kit["fieldError"]}
        role={problem === undefined ? undefined : "alert"}
      >
        {problem ??
          "What its runs may spend in the period, models and priced tools together. Empty: no limit of its own; the org's and the credentials' limits still apply."}
      </p>
    </fieldset>
  );
};

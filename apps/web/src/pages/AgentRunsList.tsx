// Agent runs (/agent-runs, #234, ADR 0040): the runs the caller sees, the latest activity first: every run they
// started, whatever the trigger or API key; the runs no one started of the shared agents they watch, and the child runs
// below their runs; and for an org admin, every shared agent's run as its metadata, a running one with Stop. Each row
// shows its agent, trigger, starter, state, last activity and cost, and opens the run's page. The server decides what
// each caller sees (`access`), which the filters follow.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Square } from "lucide-react";
import { useState } from "react";
import type { RunView } from "@commissary/contract/agent-runs";
import { AGENT_RUNS, agentRunsAtom, cancelRunAtom, meAtom, nowAtom } from "../api/client.ts";
import { WithMemberEmails } from "../components/MemberEmails.tsx";
import { kit, Problem } from "../components/Kit.tsx";
import {
  emptyRunsText,
  filterRuns,
  type RunFilter,
  type RunRow,
  runFilters,
  runProblem,
  runRow,
} from "../lib/agent-runs.ts";
import { failureMessage } from "../lib/failure.ts";
import { formatCount } from "../lib/format.ts";
import { atLeast, effectiveRole } from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { NotFound } from "./NotFound.tsx";
import styles from "./Tools.module.css";

/** An org admin's Stop of a running turn, from the list. */
const Stop = ({
  run,
  onProblem,
}: {
  readonly run: RunView;
  readonly onProblem: (text: string) => void;
}) => {
  const cancel = useAction(cancelRunAtom);

  return (
    <button
      type="button"
      className={kit["secondary"]}
      disabled={cancel.busy}
      aria-busy={cancel.busy}
      aria-label={`Stop the running turn of ${run.agent.name ?? "this run"}`}
      onClick={() =>
        void cancel.run({ params: { run: run.id }, reactivityKeys: AGENT_RUNS }).then((outcome) => {
          if (!outcome.ok) onProblem(runProblem(outcome.error, outcome.message, outcome.detail));
        })
      }
    >
      <Square
        aria-hidden="true"
        size={16}
        strokeWidth={2.25}
        className={cancel.busy ? kit["spinning"] : undefined}
      />
      {cancel.busy ? "Stopping…" : "Stop"}
    </button>
  );
};

const Row = ({
  row,
  onProblem,
}: {
  readonly row: RunRow;
  readonly onProblem: (text: string) => void;
}) => (
  <tr>
    <td>
      <div className={styles["name"]}>
        <Link to="/agent-runs/$runId" params={{ runId: row.run.id }}>
          {row.agent}
        </Link>
        <span className={styles["secondary"]}>
          {row.trigger} ·{" "}
          {row.starterRun === undefined ? (
            row.starter
          ) : (
            // A child run's row links the run that started it.
            <Link to="/agent-runs/$runId" params={{ runId: row.starterRun }}>
              {row.starter}
            </Link>
          )}
        </span>
      </div>
    </td>
    <td>{row.status}</td>
    <td className={styles["wide"]}>{row.activity}</td>
    <td className={styles["number"]}>{row.cost}</td>
    <td className={styles["number"]}>
      {row.cancel ? <Stop run={row.run} onProblem={onProblem} /> : null}
    </td>
  </tr>
);

const List = ({
  admin,
  emails,
}: {
  readonly admin: boolean;
  /** Whom a starter id names: the members' emails, an org admin's only. */
  readonly emails: ReadonlyMap<string, string>;
}) => {
  const result = useAtomValue(agentRunsAtom);
  const retry = useAtomRefresh(agentRunsAtom);
  const now = useAtomValue(nowAtom);
  const [filter, setFilter] = useState<RunFilter>("all");
  const [problem, setProblem] = useState<string | undefined>(undefined);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the runs…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the runs. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      const rows = filterRuns(value.runs, filter).map((run) => runRow(run, now, emails));

      return (
        <div className={styles["section"]}>
          <div className={kit["tabs"]} role="radiogroup" aria-label="Show">
            {runFilters(value.runs, admin).map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="radio"
                aria-checked={filter === candidate.id}
                className={kit["tab"]}
                onClick={() => setFilter(candidate.id)}
              >
                {candidate.label}
                <span className={kit["tabCount"]}>{formatCount(candidate.count)}</span>
              </button>
            ))}
          </div>
          {problem === undefined ? null : <Problem>{problem}</Problem>}
          {rows.length === 0 ? (
            <p className={styles["empty"]}>{emptyRunsText(filter)}</p>
          ) : (
            <div className={styles["scroll"]}>
              <table className={styles["table"]}>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">State</th>
                    <th scope="col" className={styles["wide"]}>
                      Last activity
                    </th>
                    <th scope="col" className={styles["number"]}>
                      Cost
                    </th>
                    <th scope="col">
                      <span className={kit["visuallyHidden"]}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Row key={row.run.id} row={row} onProblem={setProblem} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    },
  });
};

export const AgentRunsPage = () => {
  const me = useAtomValue(meAtom);
  const present = AsyncResult.isSuccess(me) ? me.value.deployment.agents : undefined;
  const admin = AsyncResult.isSuccess(me) && atLeast(effectiveRole(me.value), "admin");

  usePageTitle("Agent runs");

  if (present === false) return <NotFound />;

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Agent runs</h1>
        <p className={styles["intro"]}>
          Each run is one conversation with a hosted agent. Here are the runs you started, from a
          chat or a client, the runs you watch that no one started
          {admin ? ", and the metadata of every shared agent's run, which you may stop" : ""}. Start
          a chat from an agent&rsquo;s page.
        </p>
      </header>
      {present === true ? (
        <WithMemberEmails admin={admin}>
          {(emails) => <List admin={admin} emails={emails} />}
        </WithMemberEmails>
      ) : null}
    </div>
  );
};

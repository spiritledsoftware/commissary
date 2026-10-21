// One agent run (/agent-runs/$runId, #234, ADR 0040): the run's facts (agent, trigger, starter, state, last activity,
// cost), what it waits on, answered here (a pending approval decided in place, a browser handoff with its Live View),
// its transcript as it grows (read again every two seconds while a turn runs or something waits; a failed read keeps
// the run last read and goes on reading), the child runs it started linked, the composer that steers the running turn
// or starts a new one with Stop beside it, and when the run is pruned under the org's retention period (read once) with
// Delete. #232's links name the approval's and the browser session's own pages, which this page links and which link
// back here ("From run", their views' `run`). Its starter and its watchers see all of it; an org admin sees its
// metadata and may stop a running turn. The server decides who sees what (`access`); anyone else gets Not found from
// it.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, Square, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { RunDetail, TurnView } from "@commissary/contract/agent-runs";
import type { Me } from "@commissary/contract/orgs";
import {
  AGENT_RUNS,
  agentRunAtom,
  agentRunRetentionAtom,
  APPROVALS,
  approvalAtom,
  browserSessionAtom,
  cancelRunAtom,
  deleteRunAtom,
  meAtom,
  nowAtom,
  sendRunMessageAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { WithMemberEmails } from "../components/MemberEmails.tsx";
import { RunComposer } from "../components/RunComposer.tsx";
import { TrailMark } from "../components/Signs.tsx";
import {
  answeredKeys,
  billingLinkOf,
  composerOf,
  costText,
  lastRun,
  POLL_MS,
  pollStep,
  prunedText,
  runProblem,
  sentText,
  starterText,
  stateText,
  type TranscriptItem,
  transcriptItems,
  triggerText,
  type WaitItem,
  waitingText,
  waitsOf,
} from "../lib/agent-runs.ts";
import { argumentsText } from "../lib/approvals.ts";
import { notWatchableText } from "../lib/browser-sessions.ts";
import { failureMessage } from "../lib/failure.ts";
import { formatAgo, formatMoment } from "../lib/format.ts";
import { hasBrowser } from "../lib/hosted.ts";
import { AGENT_RUNS_PAGE, atLeast, effectiveRole } from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { Decide } from "./Approval.tsx";
import { Handoff, LiveView } from "./BrowserSessions.tsx";
import { NotFound } from "./NotFound.tsx";
import styles from "./AgentRuns.module.css";
import tools from "./Tools.module.css";

const route = getRouteApi("/agent-runs/$runId");

/** A decision or a handoff's end also changes the run: both refetch. */
const ANSWERED = answeredKeys(APPROVALS);

/** A run's id as a link to its page. */
const RunLink = ({ run, children }: { readonly run: string; readonly children: ReactNode }) => (
  <Link to="/agent-runs/$runId" params={{ runId: run }}>
    {children}
  </Link>
);

/** A refusal's words, with the Billing page's link when it is a plan's and the caller manages the plan. */
const Refusal = ({ text, me }: { readonly text: string; readonly me: Me | undefined }) => {
  const billing = me === undefined ? undefined : billingLinkOf(text, me);

  return (
    <>
      {text}
      {billing === undefined ? null : (
        <>
          {" "}
          <Link to="/billing">See the plan and usage</Link>.
        </>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// What the run waits on

/** A pending approval the caller decides here: the call, its arguments, Approve and Deny. */
const ApprovalHere = ({ id }: { readonly id: string }) => {
  const result = useAtomValue(approvalAtom(id));
  const retry = useAtomRefresh(approvalAtom(id));

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the call…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>
        Could not load the approval: its hour may be over. {failureMessage(failure)}
      </Problem>
    ),
    onSuccess: ({ value }) => (
      <>
        <p>
          <code>{value.tool.name}</code> of the toolkit {value.toolkit.name}
        </p>
        {value.arguments === undefined ? null : (
          <pre className={styles["code"]}>
            <code>{argumentsText(value.arguments)}</code>
          </pre>
        )}
        {value.can_decide ? (
          <Decide approval={value} keys={ANSWERED} />
        ) : (
          <p className={kit["muted"]}>Another approver decides this call.</p>
        )}
      </>
    ),
  });
};

/** A handoff the caller answers here: what the agent asks, and the session's Live View. */
const HandoffHere = ({ id }: { readonly id: string }) => {
  const result = useAtomValue(browserSessionAtom(id));
  const retry = useAtomRefresh(browserSessionAtom(id));

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the browser session…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>
        Could not load the browser session: it may have closed. {failureMessage(failure)}
      </Problem>
    ),
    onSuccess: ({ value }) => {
      const why = notWatchableText(value);

      return (
        <>
          <Handoff session={value} />
          {why === undefined ? <LiveView session={value} /> : <p className={kit["muted"]}>{why}</p>}
        </>
      );
    },
  });
};

const Wait = ({ item, browser }: { readonly item: WaitItem; readonly browser: boolean }) => (
  <li className={styles["wait"]}>
    <div className={styles["waitHead"]}>
      <h3 className={styles["waitTitle"]}>{item.title}</h3>
      <span className={styles["caption"]}>{item.left}</span>
    </div>
    {item.run === undefined ? null : (
      <p className={styles["caption"]}>
        In the child run <RunLink run={item.run}>{item.run}</RunLink>
      </p>
    )}
    {item.kind === "approval" ? (
      item.here ? (
        <ApprovalHere id={item.id} />
      ) : (
        <p>
          It waits for an approver under the toolkit&rsquo;s rule; the run goes on once they decide
          on{" "}
          <Link to="/approvals/$approvalId" params={{ approvalId: item.id }}>
            the approval&rsquo;s page
          </Link>
          .
        </p>
      )
    ) : browser ? (
      <HandoffHere id={item.id} />
    ) : null}
    <p className={styles["caption"]}>
      {item.kind === "approval" ? (
        <Link to="/approvals/$approvalId" params={{ approvalId: item.id }}>
          Open the approval&rsquo;s page
        </Link>
      ) : (
        <Link to="/tools/sessions/$sessionId" params={{ sessionId: item.id }}>
          Open the browser session&rsquo;s page
        </Link>
      )}
    </p>
  </li>
);

const Waits = ({ run, me }: { readonly run: RunDetail; readonly me: Me | undefined }) => {
  const now = useAtomValue(nowAtom);
  const items = waitsOf(run, now);

  if (items.length === 0) return null;

  return (
    <Section title="Waiting" className={tools["section"]}>
      <p className={tools["intro"]}>
        The run parked these calls until someone answers; it goes on by itself once they are
        answered. Unanswered, an approval is refused after its hour and a handoff after thirty
        minutes.
      </p>
      <ul className={styles["waits"]}>
        {items.map((item) => (
          <Wait
            key={`${item.kind}:${item.id}`}
            item={item}
            browser={me !== undefined && hasBrowser(me)}
          />
        ))}
      </ul>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The transcript

/** Results longer than this fold behind a summary. */
const LONG_RESULT = 600;

const Said = ({
  item,
  me,
}: {
  readonly item: TranscriptItem;
  readonly me: Me | undefined;
}): ReactNode => {
  switch (item.kind) {
    case "input":
    case "answer":
      return <p className={styles["text"]}>{item.text}</p>;
    case "delivery":
      return (
        <>
          <p className={styles["text"]}>{item.text}</p>
          {item.child === undefined ? null : (
            <p className={styles["caption"]}>
              <RunLink run={item.child}>Open the child run</RunLink>
            </p>
          )}
        </>
      );
    case "tool_call":
      return (
        <>
          <p>
            Calls <code>{item.tool}</code>
          </p>
          <pre className={styles["code"]}>
            <code>{item.text}</code>
          </pre>
        </>
      );
    case "tool_result": {
      const body = (
        <pre className={styles["code"]}>
          <code>{item.text}</code>
        </pre>
      );

      return (
        <>
          {item.error === true ? (
            <p className={styles["failed"]}>
              <TrailMark />
              <span>
                The tool answered with an error.
                {me === undefined || billingLinkOf(item.text, me) === undefined ? null : (
                  <>
                    {" "}
                    <Link to="/billing">See the plan and usage</Link>.
                  </>
                )}
              </span>
            </p>
          ) : null}
          {item.text.length > LONG_RESULT ? (
            <details className={styles["more"]}>
              <summary>
                Show the result ({item.text.length.toLocaleString("en-US")} characters)
              </summary>
              {body}
            </details>
          ) : (
            body
          )}
          {item.child === undefined ? null : (
            <p className={styles["caption"]}>
              Started the child run <RunLink run={item.child}>{item.child}</RunLink>
            </p>
          )}
        </>
      );
    }
  }
};

const whoOf = (item: TranscriptItem, agent: string): string => {
  switch (item.kind) {
    case "input":
      return "Message";
    case "delivery":
      return "Child run";
    case "answer":
    case "tool_call":
      return agent;
    case "tool_result":
      return item.tool ?? "Tool";
  }
};

/** The latest turn when it did not answer: why it failed, or that it was cancelled. */
const LastTurn = ({
  turn,
  me,
}: {
  readonly turn: TurnView | undefined;
  readonly me: Me | undefined;
}) => {
  if (turn?.status === "failed")
    return (
      <Problem>
        The last turn failed: <Refusal text={turn.error ?? "no reason was given"} me={me} />
      </Problem>
    );

  if (turn?.status === "cancelled")
    return <p className={kit["muted"]}>The last turn was stopped.</p>;

  return null;
};

const Transcript = ({ run, me }: { readonly run: RunDetail; readonly me: Me | undefined }) => {
  const now = useAtomValue(nowAtom);
  const items = transcriptItems(run.transcript ?? []);
  const agent = run.agent.name ?? "Agent";

  return (
    <Section title="Transcript" className={tools["section"]}>
      {items.length === 0 ? (
        <p className={tools["empty"]}>
          {run.state === "running" ? "Nothing yet: the first turn is starting." : "Nothing yet."}
        </p>
      ) : (
        <ol className={styles["transcript"]}>
          {items.map((item, index) => (
            // The transcript only grows, so an entry keeps its place.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index} className={styles["entry"]}>
              <div className={styles["who"]}>
                <span>{whoOf(item, agent)}</span>
                <time className={styles["when"]} dateTime={item.at}>
                  {formatMoment(Date.parse(item.at), now)}
                </time>
              </div>
              <div className={styles["said"]}>
                <Said item={item} me={me} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <LastTurn turn={run.turns?.at(-1)} me={me} />
      {run.state === "running" ? (
        <p className={styles["caption"]} aria-live="polite">
          A turn is running: new entries appear as the agent works.
        </p>
      ) : null}
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Steering, stopping and deleting

const useStop = (run: RunDetail) => {
  const cancel = useAction(cancelRunAtom);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const stop = async () => {
    setProblem(undefined);

    const outcome = await cancel.run({ params: { run: run.id }, reactivityKeys: AGENT_RUNS });

    if (!outcome.ok) setProblem(runProblem(outcome.error, outcome.message, outcome.detail));
    else if (!outcome.value.cancelled) setProblem("No turn was running: it had already settled.");
  };

  return { stop, busy: cancel.busy, problem } as const;
};

const Steer = ({ run }: { readonly run: RunDetail }) => {
  const message = useAction(sendRunMessageAtom);
  const stop = useStop(run);
  const composer = composerOf(run);

  if (!composer.open)
    return (
      <Section title="Chat" className={tools["section"]}>
        <p className={kit["muted"]}>{composer.why}</p>
        {composer.stop ? (
          <div className={styles["actions"]}>
            <button
              type="button"
              className={kit["secondary"]}
              disabled={stop.busy}
              aria-busy={stop.busy}
              onClick={() => void stop.stop()}
            >
              <Square
                aria-hidden="true"
                size={16}
                strokeWidth={2.25}
                className={stop.busy ? kit["spinning"] : undefined}
              />
              {stop.busy ? "Stopping…" : "Stop the running turn"}
            </button>
          </div>
        ) : null}
        {stop.problem === undefined ? null : <Problem>{stop.problem}</Problem>}
      </Section>
    );

  return (
    <Section title="Chat" className={tools["section"]}>
      <RunComposer
        send={composer.send}
        sending="Sending…"
        hint={composer.hint}
        label={composer.send === "Steer" ? "Steer the running turn" : "Message the agent"}
        busy={message.busy}
        onSend={async (text) => {
          const outcome = await message.run({
            params: { run: run.id },
            payload: { message: text },
            reactivityKeys: AGENT_RUNS,
          });

          return outcome.ok
            ? { note: sentText(outcome.value.delivery) }
            : { problem: runProblem(outcome.error, outcome.message, outcome.detail) };
        }}
        stop={composer.stop ? { busy: stop.busy, onStop: () => void stop.stop() } : undefined}
      />
      {stop.problem === undefined ? null : <Problem>{stop.problem}</Problem>}
    </Section>
  );
};

const Retention = ({ run }: { readonly run: RunDetail }) => {
  const remove = useAction(deleteRunAtom);
  const navigate = useNavigate();
  const [request, setRequest] = useState<ConfirmRequest | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const deletes = run.access !== "admin";
  // Read once for the page, not on each of the run's reads.
  const read = useAtomValue(agentRunRetentionAtom(run.id));
  const days = AsyncResult.isSuccess(read) ? read.value.retention_days : undefined;

  if (days === undefined && !deletes) return null;

  return (
    <Section title="Retention" className={tools["section"]}>
      {days === undefined ? null : <p className={tools["intro"]}>{prunedText(run, days)}</p>}
      {deletes ? (
        <div className={styles["actions"]}>
          <button
            type="button"
            className={kit["danger"]}
            disabled={remove.busy}
            onClick={() =>
              setRequest({
                title: "Delete this run?",
                body: (
                  <p>
                    Its transcript, its turns and the child runs it started are deleted now, and
                    nothing brings them back. Its usage records stay.
                  </p>
                ),
                action: "Delete run",
                busyAction: "Deleting…",
                run: async () => {
                  setProblem(undefined);

                  const outcome = await remove.run({
                    params: { run: run.id },
                    reactivityKeys: AGENT_RUNS,
                  });

                  if (outcome.ok) void navigate({ to: AGENT_RUNS_PAGE });
                  else setProblem(runProblem(outcome.error, outcome.message, outcome.detail));
                },
              })
            }
          >
            <Trash2 aria-hidden="true" size={18} strokeWidth={2.25} />
            Delete run
          </button>
        </div>
      ) : null}
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <ConfirmDialog request={request} busy={remove.busy} onClose={() => setRequest(undefined)} />
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The page

const Facts = ({
  run,
  emails,
}: {
  readonly run: RunDetail;
  /** Whom a starter id names: the members' emails, an org admin's only. */
  readonly emails: ReadonlyMap<string, string>;
}) => {
  const now = useAtomValue(nowAtom);
  const starter = starterText(run, emails);

  return (
    <dl className={styles["facts"]}>
      <dt>Trigger</dt>
      <dd>{triggerText(run.trigger)}</dd>
      <dt>Started by</dt>
      <dd>
        {run.starter?.kind === "run" && run.starter.id !== undefined ? (
          <RunLink run={run.starter.id}>{starter}</RunLink>
        ) : (
          starter
        )}
      </dd>
      <dt>Started</dt>
      <dd>{formatMoment(Date.parse(run.created_at), now)}</dd>
      <dt>Last activity</dt>
      <dd>{formatAgo(Math.max(0, now - Date.parse(run.updated_at)))}</dd>
      <dt>Cost</dt>
      <dd className={styles["figure"]}>{costText(run)}</dd>
    </dl>
  );
};

const Details = ({ run, me }: { readonly run: RunDetail; readonly me: Me | undefined }) => {
  const admin = me !== undefined && atLeast(effectiveRole(me), "admin");

  return (
    <>
      <WithMemberEmails admin={admin}>
        {(emails) => <Facts run={run} emails={emails} />}
      </WithMemberEmails>
      {run.access === "admin" ? null : (
        <>
          <Waits run={run} me={me} />
          <Transcript run={run} me={me} />
        </>
      )}
      <Steer run={run} />
      <Retention run={run} />
    </>
  );
};

/**
 * Reads the run again every `POLL_MS` while a turn runs or something waits: the transcript grows, a wait ends. Every
 * read's result (`result`, a new one each time, failed or not) decides the next ({@link pollStep}): none while a read
 * is in flight, none once the run is gone.
 */
const usePolling = (runId: string, result: AsyncResult.AsyncResult<RunDetail, unknown>) => {
  const refresh = useAtomRefresh(agentRunAtom(runId));
  const step = pollStep(result);

  useEffect(() => {
    if (step !== "poll") return;
    const timer = setTimeout(refresh, POLL_MS);

    return () => clearTimeout(timer);
  }, [step, refresh, result]);
};

const Loaded = ({ runId, me }: { readonly runId: string; readonly me: Me }) => {
  const result = useAtomValue(agentRunAtom(runId));
  const retry = useAtomRefresh(agentRunAtom(runId));
  const run = lastRun(result);
  const title = run?.agent.name ?? "Agent run";
  const waiting = run === undefined ? undefined : waitingText(run);

  usePageTitle(`Run of ${title}`);
  usePolling(runId, result);

  return (
    <>
      <header className={tools["head"]}>
        <Link to={AGENT_RUNS_PAGE} className={tools["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Agent runs
        </Link>
        <h1 className={tools["title"]}>{title}</h1>
        {run === undefined ? null : (
          <p className={styles["status"]} role="status">
            {stateText(run)}
            {waiting === undefined ? "" : ` · ${waiting}`}
          </p>
        )}
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the run…
          </p>
        ),
        onFailure: (failure) =>
          run !== undefined && pollStep(failure) === "gone" ? (
            <Problem>
              This run was deleted. <Link to={AGENT_RUNS_PAGE}>See your other runs</Link>.
            </Problem>
          ) : run === undefined ? (
            <Problem onRetry={retry}>
              Could not load the run. It may have been deleted, or it is not yours to see.{" "}
              {failureMessage(failure)}
            </Problem>
          ) : (
            // A read after the first failed: the page keeps the run it last read, and reads it again.
            <>
              <Problem onRetry={retry}>
                Could not read the run again; this is how it was. {failureMessage(failure)}
              </Problem>
              <Details run={run} me={me} />
            </>
          ),
        onSuccess: ({ value }) => <Details run={value} me={me} />,
      })}
    </>
  );
};

export const AgentRunPage = () => {
  const { runId } = route.useParams();
  const me = useAtomValue(meAtom);

  if (AsyncResult.isSuccess(me) && !me.value.deployment.agents) return <NotFound />;

  return (
    <div className={kit["page"]}>
      {AsyncResult.isSuccess(me) ? (
        <Loaded runId={runId} me={me.value} />
      ) : (
        <p className={kit["muted"]} aria-busy="true">
          Loading the run…
        </p>
      )}
    </div>
  );
};

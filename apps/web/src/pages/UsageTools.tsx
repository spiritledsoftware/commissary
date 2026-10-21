// The Usage page's tool calls (#209, #199, ADR 0038): the totals of the calls over the range, a breakdown by toolkit, tool,
// member or key whose rows narrow the page, and the log of calls with their outcome, approval, latency and cost. A call's
// record holds no arguments and no results, so neither is shown: only that the call happened and its sizes. Private
// calls follow the visibility of every usage record: only their caller reads them. The range, filters and area live in
// the address (Usage.tsx).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { UsageGroup, UsageRecord, UsageSummary } from "@commissary/contract/usage";
import {
  nowAtom,
  browserProfilesAtom,
  meAtom,
  type UsageView,
  usageRecordsAtom,
  usageSummaryAtom,
  toolkitsAtom,
} from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { TrailMark } from "../components/Signs.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCost, formatCount, formatLatency, formatMoment } from "../lib/format.ts";
import { hasBrowser } from "../lib/hosted.ts";
import { type Breakdown, type FilterKey } from "../lib/usage.ts";
import {
  approvalWord,
  browserDuration,
  browserTimeText,
  credentialText,
  type Figure,
  outcomeFailed,
  hasBrowserTime,
  latencyText,
  outcomeWord,
  profileFact,
  recordFacts,
  recordSubject,
  resultWord,
  toolDetails,
  toolHeadline,
} from "../lib/usage-tools.ts";
import styles from "./Usage.module.css";

/** How the page names what a record or a breakdown row holds: its toolkit, tool, member, key and so on. */
export interface ToolNames {
  readonly toolkits: ReadonlyMap<string, string>;
  readonly valueName: (key: FilterKey | Breakdown["id"], value: string) => string;
}

/** Whether the deployment has a browser, so browser time and its cost show (#217; ADR 0043). */
const useBrowserUsage = (): boolean => {
  const me = useAtomValue(meAtom);

  return AsyncResult.isSuccess(me) && hasBrowser(me.value);
};

const Figures = ({
  figures,
  className,
}: {
  readonly figures: ReadonlyArray<Figure>;
  readonly className: string | undefined;
}) => (
  <dl className={className}>
    {figures.map(([label, value, bad]) => (
      <div key={label}>
        <dt>{label}</dt>
        <dd data-bad={bad === true}>{value}</dd>
      </div>
    ))}
  </dl>
);

const toolkitOf = (record: UsageRecord, names: ToolNames): string =>
  record.toolkit_id === undefined
    ? "Unknown toolkit"
    : (names.toolkits.get(record.toolkit_id) ?? record.toolkit_id);

// ---------------------------------------------------------------------------------------------------------------
// Totals and breakdown

const BreakdownTable = ({
  summary,
  breakdown,
  names,
  narrowed,
  browser,
  onNarrow,
}: {
  readonly summary: UsageSummary;
  readonly breakdown: Breakdown;
  readonly names: ToolNames;
  readonly narrowed: boolean;
  /** The deployment has a browser: a column of browser time where any row used some. */
  readonly browser: boolean;
  readonly onNarrow: (group: UsageGroup) => void;
}) => {
  const canNarrow = breakdown.filter !== undefined && !narrowed;
  const browserTime = browser && hasBrowserTime(summary.groups);

  return (
    <table className={`${styles["table"]} ${styles["breakdown"]}`}>
      <caption className={kit["visuallyHidden"]}>
        Tool calls by {breakdown.noun.toLowerCase()}
      </caption>
      <thead>
        <tr>
          <th scope="col">{breakdown.noun}</th>
          <th scope="col" className={styles["number"]}>
            Calls
          </th>
          <th scope="col" className={styles["number"]}>
            Not completed
          </th>
          <th scope="col" className={styles["number"]}>
            Cost
          </th>
          {browserTime ? (
            <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
              Browser time
            </th>
          ) : null}
          <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
            Average latency
          </th>
        </tr>
      </thead>
      <tbody>
        {summary.groups.map((group) => {
          const name = names.valueName(breakdown.id, group.key);

          return (
            <tr key={group.key}>
              <th scope="row" className={styles["name"]}>
                {canNarrow ? (
                  <button
                    type="button"
                    className={styles["narrow"]}
                    title={`Show only ${name}`}
                    onClick={() => onNarrow(group)}
                  >
                    {name}
                  </button>
                ) : (
                  name
                )}
              </th>
              <td className={styles["number"]}>{formatCount(group.requests)}</td>
              <td className={styles["number"]}>{formatCount(group.failed)}</td>
              <td className={styles["number"]}>{formatCost(group.cost_micros)}</td>
              {browserTime ? (
                <td className={`${styles["number"]} ${styles["wide"]}`}>
                  {(group.browser_ms ?? 0) > 0 ? browserDuration(group.browser_ms ?? 0) : "None"}
                </td>
              ) : null}
              <td className={`${styles["number"]} ${styles["wide"]}`}>
                {formatLatency(group.avg_latency_ms)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/** Totals and breakdown of tool calls: one summary request feeds both. */
export const ToolSummary = ({
  view,
  breakdown,
  breakdowns,
  names,
  onBreakdown,
  onNarrow,
}: {
  readonly view: UsageView;
  readonly breakdown: Breakdown;
  readonly breakdowns: ReadonlyArray<Breakdown>;
  readonly names: ToolNames;
  readonly onBreakdown: (by: Breakdown["id"]) => void;
  readonly onNarrow: (key: FilterKey, value: string) => void;
}) => {
  const atom = usageSummaryAtom({ view, by: breakdown.id });
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const narrowed = breakdown.filter !== undefined && view.filters[breakdown.filter] !== undefined;
  const browser = useBrowserUsage();

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading tool calls…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load tool calls. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value, waiting }) => {
      const details = toolDetails(value.totals, browser);

      return (
        <>
          <section className={styles["overview"]} aria-label="Totals" aria-busy={waiting}>
            <div className={styles["totals"]}>
              <Figures figures={toolHeadline(value.totals)} className={styles["headline"]} />
              {details.length === 0 ? null : (
                <Figures figures={details} className={styles["details"]} />
              )}
            </div>
          </section>
          <Section title="Breakdown">
            <div className={styles["breakdownTabs"]}>
              <div className={kit["tabs"]} role="radiogroup" aria-label="Break down by">
                {breakdowns.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="radio"
                    aria-checked={candidate.id === breakdown.id}
                    className={kit["tab"]}
                    onClick={() => onBreakdown(candidate.id)}
                  >
                    {candidate.label}
                  </button>
                ))}
              </div>
            </div>
            {value.groups.length === 0 ? (
              <p className={kit["muted"]}>No tool calls in this range.</p>
            ) : (
              <>
                <BreakdownTable
                  summary={value}
                  breakdown={breakdown}
                  names={names}
                  narrowed={narrowed}
                  browser={browser}
                  onNarrow={(group) => {
                    if (breakdown.filter !== undefined) onNarrow(breakdown.filter, group.key);
                  }}
                />
                {breakdown.filter !== undefined && !narrowed ? (
                  <p className={styles["hint"]}>
                    Choose a row to narrow the page to that {breakdown.noun.toLowerCase()}.
                  </p>
                ) : null}
              </>
            )}
          </Section>
        </>
      );
    },
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Log

const Facts = ({
  record,
  names,
  browser,
  profile,
}: {
  readonly record: UsageRecord;
  readonly names: ToolNames;
  readonly browser: boolean;
  readonly profile: string | undefined;
}) => (
  <div className={styles["detail"]}>
    <dl className={styles["facts"]}>
      {recordFacts(record, toolkitOf(record, names), browser, profile).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  </div>
);

/** A browser session's record names the profile it opened from by id: its name is in the profiles the caller manages. */
const SessionFacts = (props: {
  readonly record: UsageRecord;
  readonly names: ToolNames;
  readonly browser: boolean;
}) => {
  const result = useAtomValue(browserProfilesAtom);

  const profile = AsyncResult.isSuccess(result)
    ? profileFact(
        props.record,
        new Map(result.value.profiles.map((each) => [each.id, each.name] as const)),
      )
    : undefined;

  return <Facts {...props} profile={profile} />;
};

const Detail = (props: {
  readonly record: UsageRecord;
  readonly names: ToolNames;
  readonly browser: boolean;
}) =>
  !props.browser || props.record.browser_profile_id === undefined ? (
    <Facts {...props} profile={undefined} />
  ) : (
    <SessionFacts {...props} />
  );

const CallRow = ({
  record,
  names,
  now,
  browser,
}: {
  readonly record: UsageRecord;
  readonly names: ToolNames;
  readonly now: number;
  /** The deployment has a browser, so browser time shows. */
  readonly browser: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const detailId = `call-${record.request_id}`;
  const browserTime = browser ? browserTimeText(record.browser_ms) : undefined;
  const outcome = record.outcome;
  const failed = outcome !== undefined && outcomeFailed(outcome);

  // A call that waits or was not approved says so in its outcome: its approval would only repeat it.
  const approval =
    outcome === "approval_pending" || outcome === "not_approved"
      ? undefined
      : approvalWord(record.approval);

  return (
    <>
      <tr className={styles["record"]} data-open={open}>
        <td className={styles["when"]}>
          <button
            type="button"
            className={styles["expand"]}
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen(!open)}
          >
            {open ? (
              <ChevronDown aria-hidden="true" size={16} strokeWidth={2.25} />
            ) : (
              <ChevronRight aria-hidden="true" size={16} strokeWidth={2.25} />
            )}
            <time dateTime={record.timestamp}>
              {formatMoment(Date.parse(record.timestamp), now)}
            </time>
          </button>
        </td>
        <td className={styles["what"]}>
          {recordSubject(record)}
          <span className={styles["secondary"]}>{toolkitOf(record, names)}</span>
          {browserTime === undefined ? null : (
            <span className={styles["secondary"]}>{browserTime}</span>
          )}
        </td>
        <td className={styles["who"]}>
          <span className={styles["accountName"]}>
            {record.private === true ? "Private" : credentialText(record.credential)}
          </span>
          <span className={styles["secondary"]}>{record.api_key}</span>
        </td>
        <td className={styles["number"]}>
          {record.cost_micros === undefined ? "None" : formatCost(record.cost_micros)}
        </td>
        <td className={`${styles["number"]} ${styles["latency"]}`}>{latencyText(record)}</td>
        <td className={styles["result"]} data-failed={failed}>
          {failed ? (
            <span className={styles["failedResult"]}>
              <TrailMark />
              {outcomeWord(outcome)}
            </span>
          ) : (
            resultWord(record)
          )}
          {approval === undefined ? null : <span className={styles["secondary"]}>{approval}</span>}
        </td>
      </tr>
      {open ? (
        <tr className={styles["detailRow"]} id={detailId}>
          <td colSpan={6}>
            <Detail record={record} names={names} browser={browser} />
          </td>
        </tr>
      ) : null}
    </>
  );
};

const message = (content: ReactNode) => (
  <tbody>
    <tr className={styles["message"]}>
      <td colSpan={6}>{content}</td>
    </tr>
  </tbody>
);

const LogPage = ({
  view,
  failedOnly,
  before,
  last,
  names,
  browser,
  onMore,
}: {
  readonly view: UsageView;
  readonly failedOnly: boolean;
  readonly before: string | undefined;
  readonly last: boolean;
  readonly names: ToolNames;
  readonly browser: boolean;
  readonly onMore: (next: string) => void;
}) => {
  const atom = usageRecordsAtom({ view, failedOnly, before });
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const now = useAtomValue(nowAtom);

  return AsyncResult.match(result, {
    onInitial: () =>
      message(
        <span className={kit["muted"]} aria-busy="true">
          Loading tool calls…
        </span>,
      ),
    onFailure: (failure) =>
      message(
        <Problem onRetry={retry}>Could not load tool calls. {failureMessage(failure)}</Problem>,
      ),
    onSuccess: ({ value }) => {
      if (value.records.length === 0 && before === undefined)
        return message(
          <span className={kit["muted"]}>
            {failedOnly
              ? "No tool calls that did not complete in this range."
              : "No tool calls in this range."}
          </span>,
        );

      const next = value.next_before;

      return (
        <tbody>
          {value.records.map((record) => (
            <CallRow
              key={record.request_id}
              record={record}
              names={names}
              now={now}
              browser={browser}
            />
          ))}
          {last && next !== undefined ? (
            <tr className={styles["message"]}>
              <td colSpan={6}>
                <button type="button" className={kit["secondary"]} onClick={() => onMore(next)}>
                  Show older calls
                </button>
              </td>
            </tr>
          ) : null}
        </tbody>
      );
    },
  });
};

/** The log of tool calls, newest first, with a tab for the calls that did not complete. */
export const ToolLog = ({
  view,
  failedOnly,
  names,
  onFailedOnly,
}: {
  readonly view: UsageView;
  readonly failedOnly: boolean;
  readonly names: ToolNames;
  readonly onFailedOnly: (failedOnly: boolean) => void;
}) => {
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const browser = useBrowserUsage();
  const pages: ReadonlyArray<string | undefined> = [undefined, ...cursors];

  return (
    <Section title="Calls">
      <div className={styles["logTabs"]}>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Show">
          {(
            [
              [false, "All"],
              [true, "Not completed"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={failedOnly === value}
              className={kit["tab"]}
              onClick={() => onFailedOnly(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className={styles["mobileKey"]} aria-hidden="true">
        Figures on the right: cost, then latency.
      </p>
      <table className={`${styles["table"]} ${styles["log"]}`}>
        <caption className={kit["visuallyHidden"]}>Tool calls, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Tool</th>
            <th scope="col">Credential and caller</th>
            <th scope="col" className={styles["number"]}>
              Cost
            </th>
            <th scope="col" className={`${styles["number"]} ${styles["latency"]}`}>
              Latency
            </th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        {pages.map((before, index) => (
          <LogPage
            key={before ?? "first"}
            view={view}
            failedOnly={failedOnly}
            before={before}
            last={index === pages.length - 1}
            names={names}
            browser={browser}
            onMore={(next) => setCursors([...cursors, next])}
          />
        ))}
      </table>
    </Section>
  );
};

/** The toolkits the caller reaches, by id, to name a call's toolkit; a toolkit since removed shows its id. */
export const useToolkitNames = (): ReadonlyMap<string, string> => {
  const result = useAtomValue(toolkitsAtom);

  return new Map(
    AsyncResult.isSuccess(result)
      ? result.value.toolkits.map((toolkit) => [toolkit.id, toolkit.name] as const)
      : [],
  );
};

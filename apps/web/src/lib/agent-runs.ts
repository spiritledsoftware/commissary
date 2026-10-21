// The panel's chat with hosted agents and its run pages (#234, ADR 0040, GLOSSARY "Agent run", "Turn", "Watcher"): what
// the composer does, what a run waits on and where it is answered, the transcript with its child runs, the runs list,
// the retention notice, and the words of a refusal. A chat is a run whose turns come from the panel: typing while a turn
// runs steers it, typing while the run is idle starts a new turn, and Stop cancels the running turn. The server decides
// who sees a run and what they may do with it (`access`); these functions only word and gate what it answered. Pure:
// no DOM, tested in test/agent-runs.test.ts.
import type {
  MessageSent,
  RunDetail,
  RunView,
  TranscriptEntry,
  TriggerKind,
} from "@commissary/contract/agent-runs";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { Me } from "@commissary/contract/orgs";
import type { RunWaiting } from "@commissary/contract/run-waits";
import { asSentence, serverError } from "./failure.ts";
import { formatAgo, formatCost, formatDate, formatDuration } from "./format.ts";
import { atLeast, BILLING_PAGE, effectiveRole } from "./role.ts";

/** How often a run's page reads the run again while a turn runs or something waits: the transcript grows. */
export const POLL_MS = 2_000;

/** The reactivity keys of the runs' reads (`AGENT_RUNS` in api/client.ts). */
export const RUN_KEYS = ["agent-runs"] as const;

/**
 * What deciding an approval on a run's page refetches: the approvals (`approvals`, their keys) and the run, which goes on
 * once its call is decided.
 */
export const answeredKeys = (approvals: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...approvals,
  ...RUN_KEYS,
];

/**
 * The link from an approval's or a browser session's page to the hosted agent run it is of (`run`, #234), when it
 * names one; the run's page decides who sees the run.
 */
export const fromRunLink = (view: {
  readonly run?: string | undefined;
}): { readonly runId: string; readonly text: string } | undefined =>
  view.run === undefined ? undefined : { runId: view.run, text: `From run ${view.run}` };

/** What the run page's composer offers on `run`: a message (and its button's words), or why not; and Stop. */
export type Composer =
  | {
      readonly open: true;
      readonly send: "Steer" | "Send";
      readonly hint: string;
      readonly stop: boolean;
    }
  | { readonly open: false; readonly why: string; readonly stop: boolean };

/**
 * The composer of `run` as the caller sees it: its starter and its watchers steer a running turn, or start a new turn
 * on an idle run, and stop a running turn; an org admin sees the metadata only and may only stop it; an ended run takes
 * nothing.
 */
export const composerOf = (run: Pick<RunView, "state" | "access">): Composer => {
  const running = run.state === "running";

  if (run.access === "admin")
    return {
      open: false,
      why: "You see this run's metadata only, as an org admin: its starter or its watchers read and steer it. You may stop its running turn.",
      stop: running,
    };

  if (run.state === "ended")
    return {
      open: false,
      why: "This run ended: its agent was disabled or removed, or whoever it acted for may no longer use it. Start a new chat to go on.",
      stop: false,
    };

  return running
    ? {
        open: true,
        send: "Steer",
        hint: "A turn is running: your message joins it, and the agent reads it before its next step.",
        stop: true,
      }
    : {
        open: true,
        send: "Send",
        hint: "The run is idle: your message starts a new turn.",
        stop: false,
      };
};

/** What a sent message did, as the composer confirms it. */
export const sentText = (delivery: MessageSent["delivery"]): string =>
  delivery === "steering"
    ? "Sent into the running turn: the agent reads it before its next step."
    : "Sent: it started a new turn.";

/** Whether the run's page reads the run again now ({@link POLL_MS}): while a turn runs, or something waits. */
export const pollsNow = (run: Pick<RunDetail, "state" | "waiting">): boolean =>
  run.state === "running" || (run.waiting?.length ?? 0) > 0;

/**
 * The run the page last read (`result`'s value, or the one before a failed read), which it shows and polls from: one
 * failed read neither blanks the page nor stops the reads.
 */
export const lastRun = (
  result: AsyncResult.AsyncResult<RunDetail, unknown>,
): RunDetail | undefined => Option.getOrUndefined(AsyncResult.value(result));

/**
 * What the run's page does after its latest read of the run (`result`): `poll` arms the next read in {@link POLL_MS}
 * (decided from the run it last read, {@link lastRun}, so one failed read does not stop the reads); `hold` while a read
 * is in flight, which the next must not cut short; `stop` once nothing changes by itself; `gone` once the server
 * answers `not_found` (the run was deleted, or is no longer the caller's to see), which no read changes.
 */
export type PollStep = "poll" | "hold" | "stop" | "gone";

export const pollStep = (result: AsyncResult.AsyncResult<RunDetail, unknown>): PollStep => {
  if (AsyncResult.isFailure(result) && serverError(result.cause) === "not_found") return "gone";

  if (result.waiting) return "hold";
  const run = lastRun(result);

  return run !== undefined && pollsNow(run) ? "poll" : "stop";
};

// ---------------------------------------------------------------------------------------------------------------
// What a run waits on (#232)

/** One thing a run waits on, as its page shows it. */
export interface WaitItem {
  readonly kind: RunWaiting["kind"];
  readonly id: string;
  /** The run's person answers it on the run's page: a handoff, or an approval under a rule of the caller. */
  readonly here: boolean;
  readonly title: string;
  /** The time left to answer it: "50 min left", or that it is up. */
  readonly left: string;
  /** The child run whose call waits on it, when it is not the run's own. */
  readonly run?: string;
}

const waitTitle = (wait: RunWaiting): string => {
  if (wait.kind === "handoff") return "The agent asks you to act in its browser";

  return wait.by_caller
    ? "A tool call waits for your approval"
    : "A tool call waits for another approver";
};

/** What `run` waits on, as its page lists it, in the order the run gave. */
export const waitsOf = (run: Pick<RunDetail, "waiting">, now: number): ReadonlyArray<WaitItem> =>
  (run.waiting ?? []).map((wait) => {
    const left = Date.parse(wait.until) - now;

    return {
      kind: wait.kind,
      id: wait.id,
      here: wait.by_caller,
      title: waitTitle(wait),
      left: left <= 0 ? "Its time is up" : `${formatDuration(left)} left`,
      ...(wait.run === undefined ? {} : { run: wait.run }),
    };
  });

const WAIT_NOUNS: Readonly<Record<RunWaiting["kind"], string>> = {
  approval: "an approval",
  handoff: "a handoff",
};

/**
 * What a run waits on, in a few words for its status: "Waits for you: an approval and a handoff", or "Waits for an
 * approver" when only others decide; `undefined` when it waits on nothing.
 */
export const waitingText = (run: Pick<RunDetail, "waiting">): string | undefined => {
  const waiting = run.waiting ?? [];

  if (waiting.length === 0) return undefined;
  const mine = waiting.filter((wait) => wait.by_caller);

  if (mine.length === 0) return "Waits for an approver";
  const nouns = mine.map((wait) => WAIT_NOUNS[wait.kind]);

  const listed =
    nouns.length === 1
      ? nouns[0]
      : `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;

  return `Waits for you: ${listed}`;
};

// ---------------------------------------------------------------------------------------------------------------
// The transcript

/** One line of the transcript as the run's page shows it. */
export interface TranscriptItem {
  readonly kind: "input" | "delivery" | "answer" | "tool_call" | "tool_result";
  readonly text: string;
  /** The tool, for a call or a result. */
  readonly tool?: string;
  /** A tool's result that is an error. */
  readonly error?: boolean;
  /** The child run it started or that delivered it (#229), which the page links. */
  readonly child?: string;
  readonly at: string;
}

/** A run's id, as the Agents area makes them (`ar_` and 32 hex digits). */
const RUN_ID = /^ar_[0-9a-f]{32}$/;

/** What a child run's finished turn says to the run that started it (`deliveryText` of the run's object, #229). */
const DELIVERY = /^\[agents\] Run (ar_[0-9a-f]{32}) /;

/** The agents toolkit's tool that starts a child run. */
const START_TOOL = "agents_start";

/** A call's arguments as JSON, indented when they parse. */
const argumentsText = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** The child run `agents_start` answered it started, if its result names one. */
const startedChild = (text: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== "object" || parsed === null || !("run" in parsed)) return undefined;
    const run = parsed.run;

    return typeof run === "string" && RUN_ID.test(run) ? run : undefined;
  } catch {
    return undefined;
  }
};

/** A run's transcript as its page shows it, oldest first, the child runs it started or heard from linked. */
export const transcriptItems = (
  entries: ReadonlyArray<TranscriptEntry>,
): ReadonlyArray<TranscriptItem> =>
  entries.flatMap((entry): ReadonlyArray<TranscriptItem> => {
    switch (entry.role) {
      case "user": {
        const child = DELIVERY.exec(entry.text)?.[1];

        return [
          child === undefined
            ? { kind: "input", text: entry.text, at: entry.at }
            : { kind: "delivery", text: entry.text, child, at: entry.at },
        ];
      }

      case "assistant":
        return [
          ...(entry.text === ""
            ? []
            : [{ kind: "answer" as const, text: entry.text, at: entry.at }]),
          ...(entry.tool_calls ?? []).map((call) => ({
            kind: "tool_call" as const,
            tool: call.name,
            text: argumentsText(call.arguments),
            at: entry.at,
          })),
        ];

      case "tool": {
        const child =
          entry.tool === START_TOOL && entry.is_error !== true
            ? startedChild(entry.text)
            : undefined;

        return [
          {
            kind: "tool_result",
            text: entry.text,
            ...(entry.tool === undefined ? {} : { tool: entry.tool }),
            error: entry.is_error === true,
            ...(child === undefined ? {} : { child }),
            at: entry.at,
          },
        ];
      }
    }
  });

// ---------------------------------------------------------------------------------------------------------------
// The runs list

const TRIGGERS: Readonly<Record<TriggerKind, string>> = {
  chat: "Chat",
  mcp: "Agents toolkit",
  schedule: "Schedule",
  webhook: "Webhook",
};

/** How a run was started, as the list and the run's page say it. */
export const triggerText = (trigger: TriggerKind): string => TRIGGERS[trigger];

const STATES: Readonly<Record<RunView["state"], string>> = {
  running: "Running",
  idle: "Idle",
  ended: "Ended",
};

/** A run's state in a word. */
export const stateText = (run: Pick<RunView, "state">): string => STATES[run.state];

/**
 * Who started a run: "You", a member by email (an org admin reads the members, `emails`), the run that started a child
 * run, or no one (a shared agent's trigger).
 */
export const starterText = (
  run: Pick<RunView, "starter" | "access">,
  emails: ReadonlyMap<string, string> = new Map(),
): string => {
  if (run.access === "starter") return "You";
  const { starter } = run;

  if (starter === undefined) return "No one: its trigger";

  if (starter.kind === "run") return starter.id === undefined ? "Another run" : `Run ${starter.id}`;

  return starter.id === undefined ? "A member" : (emails.get(starter.id) ?? "A member");
};

/** What a run cost so far (`$0.00` with no priced usage yet), or that the panel could not read it. */
export const costText = (run: Pick<RunView, "cost_micros">): string =>
  run.cost_micros === undefined ? "Not known" : formatCost(run.cost_micros);

/** One run of the list. */
export interface RunRow {
  readonly run: RunView;
  readonly agent: string;
  readonly trigger: string;
  readonly starter: string;
  /** The run that started a child run, which the row links. */
  readonly starterRun?: string;
  readonly status: string;
  readonly activity: string;
  readonly cost: string;
  /** An org admin's row of a running run: they cancel its turn from the list. */
  readonly cancel: boolean;
}

export const runRow = (
  run: RunView,
  now: number,
  emails: ReadonlyMap<string, string> = new Map(),
): RunRow => ({
  run,
  agent: run.agent.name ?? "A removed agent",
  trigger: triggerText(run.trigger),
  starter: starterText(run, emails),
  ...(run.starter?.kind === "run" && run.starter.id !== undefined
    ? { starterRun: run.starter.id }
    : {}),
  status: stateText(run),
  activity: formatAgo(Math.max(0, now - Date.parse(run.updated_at))),
  cost: costText(run),
  cancel: run.access === "admin" && run.state === "running",
});

/** Why the list shows a run: all of them, those the caller started, those they watch, or the org's (admins). */
export type RunFilter = "all" | "started" | "watching" | "org";

const FILTER_ACCESS: Readonly<Record<Exclude<RunFilter, "all">, RunView["access"]>> = {
  started: "starter",
  watching: "watcher",
  org: "admin",
};

/** The runs a filter keeps. */
export const filterRuns = (
  runs: ReadonlyArray<RunView>,
  filter: RunFilter,
): ReadonlyArray<RunView> =>
  filter === "all" ? runs : runs.filter((run) => run.access === FILTER_ACCESS[filter]);

/** The list's filters with their counts; the org's runs only for an org admin. */
export const runFilters = (
  runs: ReadonlyArray<RunView>,
  admin: boolean,
): ReadonlyArray<{ readonly id: RunFilter; readonly label: string; readonly count: number }> => {
  const filters: ReadonlyArray<{ readonly id: RunFilter; readonly label: string }> = [
    { id: "all", label: "All" },
    { id: "started", label: "Started by you" },
    { id: "watching", label: "Watching" },
    ...(admin ? [{ id: "org" as const, label: "Org's shared agents" }] : []),
  ];

  return filters.map((filter) => ({ ...filter, count: filterRuns(runs, filter.id).length }));
};

/** What the list says while a filter shows nothing. */
export const emptyRunsText = (filter: RunFilter): string => {
  switch (filter) {
    case "all":
      return "No runs yet. Start a chat from an agent's page; the runs its triggers start show here too.";
    case "started":
      return "You have started no runs. Start a chat from an agent's page.";
    case "watching":
      return "No runs to watch: the shared agents you watch, and the child runs of your runs, have none.";
    case "org":
      return "No runs of the org's shared agents.";
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Retention (#228)

const DAY_MS = 86_400_000;

/**
 * When the run is pruned under the org's retention period for agent runs (`days`; `null` keeps them), counted from its
 * last activity; a running run is never pruned.
 */
export const prunedText = (
  run: Pick<RunView, "state" | "updated_at">,
  days: number | null,
): string => {
  if (days === null)
    return "The org keeps agent runs until they are deleted. Deleting this one is at once, and nothing brings it back.";

  if (run.state === "running")
    return `A run is never pruned while a turn runs. Once it settles, it is deleted ${days} days after its last activity. Deleting it now is at once.`;

  const at = Date.parse(run.updated_at) + days * DAY_MS;

  return `This run is deleted on ${formatDate(at)}, ${days} days after its last activity, unless it is active again before. Deleting it now is at once.`;
};

// ---------------------------------------------------------------------------------------------------------------
// Refusals

/** Whether a turn's error or a tool's result is a plan's refusal (Commissary Cloud, `plan_limit_reached`, #241). */
const PLAN_LIMIT = "plan_limit_reached";

/**
 * Where a run's error that is a plan's refusal leads (#239): the org's Billing page, for its owners and admins on
 * Commissary Cloud; nowhere for anyone else, or for another error.
 */
export const billingLinkOf = (
  text: string,
  me: Pick<Me, "role" | "platform_admin"> & {
    readonly deployment: Pick<Me["deployment"], "hosted">;
  },
): string | undefined =>
  text.includes(PLAN_LIMIT) && me.deployment.hosted && atLeast(effectiveRole(me), "admin")
    ? BILLING_PAGE
    : undefined;

/** What a refused start, message, cancel or deletion says, by the server's error code. */
export const runProblem = (error: string | undefined, message: string, detail?: string): string => {
  switch (error) {
    case "run_ended":
      return "This run ended: its agent was disabled or removed, or whoever it acted for may no longer use it. Start a new chat.";
    case "agent_disabled":
      return "This agent is disabled: it starts no new runs.";
    case "forbidden":
      return "You see this run's metadata only, as an org admin: its starter or its watchers steer and delete it.";
    case "not_found":
      return "This run, or its agent, is gone, or is not yours to see.";
    case "invalid":
      return detail === undefined ? "Write a message first." : asSentence(detail);
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

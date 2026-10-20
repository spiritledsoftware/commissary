/**
 * The agents toolkit's tools (ADR 0040, #229; GLOSSARY "Agents toolkit"): their names, classes, descriptions and
 * arguments, which Tools lists on the MCP endpoint (the built-in toolkit `agents`, `AGENTS_TOOLKIT`) and Agents decodes
 * when it answers a call. The shape is pi's subagent tools', with the agent as an argument: a start returns the run's
 * ids at once, a message steers the running turn or starts a new one, and a wait claims a turn's result, with a timeout
 * that never cancels anything. Shared with the browser: imports `effect` and `./agent-runs.ts` only.
 */
import { Schema } from "effect";
import { MAX_WAIT_MS } from "./agent-runs.ts";

const optional = Schema.optionalKey;

/** The tools' upstream names (their full names are `agents_<name>`), in the order the toolkit lists them. */
export const AGENTS_TOOL_NAMES = ["start", "message", "wait", "status", "cancel"] as const;

export type AgentsToolName = (typeof AGENTS_TOOL_NAMES)[number];

/** How long `agents_wait` waits when the call names no timeout, in seconds. */
export const DEFAULT_WAIT_SECONDS = 30;

/** The longest `agents_wait` may be asked to wait, in seconds. */
export const MAX_WAIT_SECONDS = MAX_WAIT_MS / 1000;

const RunId = Schema.String.annotate({ description: "The run's id, as agents_start returned it." });

const IdempotencyKey = Schema.String.annotate({
  description:
    "Optional: a key of at most 200 characters; a call again with the same key returns what the first one started.",
});

export const StartArguments = Schema.Struct({
  agent: Schema.String.annotate({ description: "The name of the agent to run." }),
  input: Schema.String.annotate({ description: "The first turn's input: what to ask the agent." }),
  idempotency_key: optional(IdempotencyKey),
});

export const MessageArguments = Schema.Struct({
  run: RunId,
  message: Schema.String.annotate({ description: "The message to send into the run." }),
  idempotency_key: optional(IdempotencyKey),
});

export const WaitArguments = Schema.Struct({
  run: RunId,
  turn: optional(
    Schema.String.annotate({
      description:
        "Optional: the turn whose result to wait for. Without it, the oldest result not yet claimed, or the running turn's.",
    }),
  ),
  timeout: optional(
    Schema.Number.annotate({
      description: `Optional: how long to wait, in seconds (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}).`,
    }),
  ),
});

export const StatusArguments = Schema.Struct({
  run: optional(
    Schema.String.annotate({
      description: "Optional: the run to show. Without it, the runs you started are listed.",
    }),
  ),
});

export const CancelArguments = Schema.Struct({ run: RunId });

/** A tool of the agents toolkit: what it does, whether it reads or writes (ADR 0038), and its arguments. */
export interface AgentsTool {
  readonly description: string;
  readonly toolClass: "read" | "write";
  readonly arguments: Schema.Top;
}

/**
 * The agents toolkit's tools. `start`'s description is completed, for each caller, with the agents they may run
 * (Tools' part does it when it lists the tool).
 */
export const AGENTS_TOOLS = {
  start: {
    description:
      "Starts a run of a hosted agent with an input, and returns at once the run's id, its first turn's id and its " +
      "status. The run works on its own: use agents_wait for its result, agents_message to steer it or continue it, " +
      "agents_status to watch it, and agents_cancel to stop its running turn.",
    toolClass: "write",
    arguments: StartArguments,
  },
  message: {
    description:
      "Sends a message into a run: it steers the running turn, or starts a new turn when the run is idle. Returns the " +
      "turn it joined or started, and which (disposition `steering` or `turn`).",
    toolClass: "write",
    arguments: MessageArguments,
  },
  wait: {
    description:
      "Waits for a run's result: the oldest finished turn whose result was not claimed yet (or the named turn's), " +
      "which it claims. When the timeout passes first it returns the run's status and latest activity instead; it " +
      "never cancels anything, so wait again.",
    toolClass: "read",
    arguments: WaitArguments,
  },
  status: {
    description:
      "Without a run, lists the runs you started. With one, shows its state, its turns and its recent activity.",
    toolClass: "read",
    arguments: StatusArguments,
  },
  cancel: {
    description:
      "Cancels a run's running turn. The run stays: a message starts its next turn. Runs it started go on.",
    toolClass: "write",
    arguments: CancelArguments,
  },
} as const satisfies { readonly [Name in AgentsToolName]: AgentsTool };

/** Whether `name` is one of the agents toolkit's tools (an upstream name). */
export const isAgentsTool = (name: string): name is AgentsToolName =>
  Object.hasOwn(AGENTS_TOOLS, name);

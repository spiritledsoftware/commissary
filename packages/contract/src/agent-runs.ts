/**
 * Agent runs (`/v9/management/agents/:id/runs`, `/v9/management/agent-runs`; `packages/agents/src/management/run-routes.ts`;
 * ADR 0040, #227): starting a run of a hosted agent, sending it messages, waiting for a turn's result, showing and
 * listing runs, and cancelling a turn. The panel's chat (#234) and the agents toolkit (#229) are built on these
 * operations. Shared with the browser: imports `effect` and `./errors.ts` only.
 *
 * An **agent run** is one conversation of a hosted agent, made of **turns**: a turn is one input and the work up to its
 * answer. A message sent while a turn runs joins it as steering; a message to an idle run starts a new turn. Cancelling
 * aborts the active turn, and the run takes a new message afterwards. Each turn reads the agent's definition as it stands
 * when the turn starts; a run whose agent was disabled or removed since ends at its next turn (`state: "ended"`).
 *
 * Only a run's starter sees it here (`404` for anyone else, as for a run that does not exist); watchers and org admins
 * come with #232. Starting a run needs the agent to be one the caller may use (`GET /agents/mine`). Resubmitting a start
 * or a message with the same `idempotency_key` returns the run or turn it started the first time.
 *
 * Without the deployment's Agents area (the `LOADER` binding) every route here answers 404, as the definitions' do.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/**
 * How a run was started (GLOSSARY "Trigger kind"): the panel's chat, a trigger configured on the agent, a schedule or
 * a webhook (`./agent-triggers.ts`, #231), or a call of the agents toolkit (`mcp`, #229) by a client or another run.
 */
export const TriggerKind = Schema.Literals(["chat", "schedule", "webhook", "mcp"]);

export type TriggerKind = typeof TriggerKind.Type;

/** A run's state: `running` while a turn works, `idle` between turns, `ended` once its agent is disabled or removed. */
export const RunState = Schema.Literals(["idle", "running", "ended"]);

export type RunState = typeof RunState.Type;

/**
 * A turn's status: `running` until its answer; `done` with an answer (a spend limit's refusal is one); `failed` when it
 * could not be answered (`error` says why); `cancelled` when it was cancelled.
 */
export const TurnStatus = Schema.Literals(["running", "done", "failed", "cancelled"]);

export type TurnStatus = typeof TurnStatus.Type;

/** Who started a run: a member, or the run that started it through the agents toolkit (a child run, #229). */
export const RunStarterView = Schema.Struct({
  kind: Schema.Literals(["member", "run"]),
  id: Schema.String,
});

export type RunStarterView = typeof RunStarterView.Type;

export const TurnView = Schema.Struct({
  id: Schema.String,
  status: TurnStatus,
  /** The input that started it. */
  input: Schema.String,
  /** The answer's text, once `done`. */
  answer: optional(Schema.String),
  /** Why it failed, once `failed`. */
  error: optional(Schema.String),
  started_at: Schema.String,
  finished_at: optional(Schema.String),
});

export type TurnView = typeof TurnView.Type;

/** One thing a run did, newest last: an input or steering message, a model's answer or tool calls, a tool's result. */
export const RunActivity = Schema.Struct({
  kind: Schema.Literals(["input", "answer", "tool_call", "tool_result", "error"]),
  /** Its text, at most a few hundred characters here (the transcript has it whole). */
  text: Schema.String,
  /** The tool, for a tool call or result. */
  tool: optional(Schema.String),
  at: Schema.String,
});

export type RunActivity = typeof RunActivity.Type;

/** An entry of a run's transcript, oldest first. */
export const TranscriptEntry = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool"]),
  text: Schema.String,
  /** An assistant message's tool calls: the tool and its arguments as JSON. */
  tool_calls: optional(
    Schema.Array(Schema.Struct({ name: Schema.String, arguments: Schema.String })),
  ),
  /** A tool result's tool, and whether it was an error. */
  tool: optional(Schema.String),
  is_error: optional(Schema.Boolean),
  at: Schema.String,
});

export type TranscriptEntry = typeof TranscriptEntry.Type;

/** A run as lists show it. */
export const RunView = Schema.Struct({
  id: Schema.String,
  agent: Schema.Struct({ id: Schema.String, name: optional(Schema.String) }),
  trigger: TriggerKind,
  /** The trigger configured on the agent that started it (a schedule or a webhook); none for a chat. */
  trigger_id: optional(Schema.String),
  /** Who started it; none for a run no one started (a shared agent's schedule or webhook, #231). */
  starter: optional(RunStarterView),
  state: RunState,
  created_at: Schema.String,
  /** Its last activity. */
  updated_at: Schema.String,
});

export type RunView = typeof RunView.Type;

/** `GET /agent-runs/:run`: the run, its turns (oldest first), its recent activity and its transcript. */
export const RunDetail = Schema.Struct({
  ...RunView.fields,
  turns: Schema.Array(TurnView),
  activity: Schema.Array(RunActivity),
  transcript: Schema.Array(TranscriptEntry),
});

export type RunDetail = typeof RunDetail.Type;

/** `GET /agent-runs`: the caller's runs, the latest activity first. */
export const RunsList = Schema.Struct({ runs: Schema.Array(RunView) });

export type RunsList = typeof RunsList.Type;

/** An idempotency key: at most 200 characters. */
const IdempotencyKey = Schema.String;

/** `POST /agents/:id/runs`: the first turn's input. */
export const StartRun = Schema.Struct({
  input: Schema.String,
  idempotency_key: optional(IdempotencyKey),
});

export type StartRun = typeof StartRun.Type;

/** A started run (or the one the idempotency key started before), with its first turn. */
export const StartedRun = Schema.Struct({ run: RunView, turn: TurnView });

export type StartedRun = typeof StartedRun.Type;

/** `POST /agent-runs/:run/messages`. */
export const SendMessage = Schema.Struct({
  message: Schema.String,
  idempotency_key: optional(IdempotencyKey),
});

export type SendMessage = typeof SendMessage.Type;

/**
 * A message sent: the turn it joined as steering (`steering`), or the new turn it started on an idle run (`turn`).
 */
export const MessageSent = Schema.Struct({
  turn: TurnView,
  delivery: Schema.Literals(["steering", "turn"]),
});

export type MessageSent = typeof MessageSent.Type;

/** The longest a wait may be asked to take, in milliseconds. */
export const MAX_WAIT_MS = 300_000;

/**
 * `POST /agent-runs/:run/wait`: waits for `turn` (the run's latest turn when left out) to finish, for at most
 * `timeout_ms` (default 30 seconds, at most {@link MAX_WAIT_MS}). It never cancels anything.
 */
export const WaitRun = Schema.Struct({
  turn: optional(Schema.String),
  timeout_ms: optional(Schema.Int),
});

export type WaitRun = typeof WaitRun.Type;

/**
 * What a wait found: the finished turn (`finished: true`), or on timeout the turn as it is (`running`) with the run's
 * latest activity.
 */
export const WaitResult = Schema.Struct({
  finished: Schema.Boolean,
  state: RunState,
  turn: TurnView,
  activity: optional(Schema.Array(RunActivity)),
});

export type WaitResult = typeof WaitResult.Type;

/** `POST /agent-runs/:run/cancel`: whether a turn was running, and the run as it is now. */
export const CancelledRun = Schema.Struct({ run: RunView, cancelled: Schema.Boolean });

export type CancelledRun = typeof CancelledRun.Type;

const runParam = { params: { run: Schema.String } };

export class AgentRunsGroup extends HttpApiGroup.make("agentRuns").add(
  /**
   * `404 not_found` for an agent the caller may not use (or an unknown one), `409 agent_disabled` when it is disabled,
   * `422 invalid` for an empty input or a key longer than 200 characters.
   */
  HttpApiEndpoint.post("start", "/agents/:id/runs", {
    params: { id: Schema.String },
    payload: StartRun,
    success: StartedRun.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  HttpApiEndpoint.get("list", "/agent-runs", { success: RunsList, error: managementErrors }),
  HttpApiEndpoint.get("get", "/agent-runs/:run", {
    ...runParam,
    success: RunDetail,
    error: managementErrors,
  }),
  /** `409 run_ended` once the run's agent was disabled or removed. */
  HttpApiEndpoint.post("message", "/agent-runs/:run/messages", {
    ...runParam,
    payload: SendMessage,
    success: MessageSent,
    error: managementErrors,
  }),
  /** `404 not_found` also for a turn the run does not have. */
  HttpApiEndpoint.post("wait", "/agent-runs/:run/wait", {
    ...runParam,
    payload: WaitRun,
    success: WaitResult,
    error: managementErrors,
  }),
  HttpApiEndpoint.post("cancel", "/agent-runs/:run/cancel", {
    ...runParam,
    success: CancelledRun,
    error: managementErrors,
  }),
) {}

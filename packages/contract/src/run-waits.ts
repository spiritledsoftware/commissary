/**
 * What an agent run waits on (#232, ADR 0040 "Who watches and steers"): a pending approval of one of its tool calls
 * (#201), or a browser session's handoff its `browser_ask_human` started (#216). Shared by the run
 * (`@commissary/agents`), the API Worker's run gateway and the MCP endpoint (`@commissary/tools`), which name each
 * other only through these plain types; and by the panel, which shows what a run waits on (`RunDetail.waiting`).
 * Imports `effect` only.
 *
 * The MCP endpoint answers a run's call that waits with the tool result it gives any client (the approval's or the
 * session's link in words), and, for a run only, what it waits on in the result's `_meta` ({@link RUN_WAITS_META}). The
 * run then **parks** the call: the turn waits, no connection stays open, and the run asks the run gateway now and then
 * how it stands ({@link RunWaitState}). Once decided (approved, denied, or the handoff ended), the run makes the same
 * call again, which takes the outcome; once it expired (an approval's hour, a handoff's thirty minutes), the call
 * answers the model as refused and the turn goes on.
 */
import { Schema } from "effect";

/** The `_meta` key of a run's tool result that says what the call waits on (a run's call only). */
export const RUN_WAITS_META = "commissary/run-waits";

/**
 * What a run's call waits on: a pending approval (`approval`, its id) or a handoff in a browser session (`handoff`, the
 * session's id), until when (ISO 8601), and the panel's page where its person answers it, when the panel's URL is
 * known. `by_caller`: the run's starter (or, for a run no one started, its watchers) answers it themselves, as an
 * approval under a rule of the caller, or a handoff; `false` for an approval that another approver decides. `run`: the
 * child run (#229) whose call waits on it, when it is not the run's own: a run shows what the child runs below it wait
 * on too, as the same person, the head of the chain's, answers them.
 */
export const RunWaiting = Schema.Struct({
  kind: Schema.Literals(["approval", "handoff"]),
  id: Schema.String,
  until: Schema.String,
  link: Schema.optionalKey(Schema.String),
  by_caller: Schema.Boolean,
  run: Schema.optionalKey(Schema.String),
});

export type RunWaiting = typeof RunWaiting.Type;

/**
 * How what a run's call waits on stands, as the run gateway answers it: `waiting` (still undecided), `ready` (decided,
 * or the handoff ended: the same call made again takes the outcome), `expired` (the approval's hour passed undecided:
 * the call is refused), or `gone` (nothing of it is kept: the run decides by its own clock, refusing it once its time
 * passed and making the call again before).
 */
export type RunWaitState = "waiting" | "ready" | "expired" | "gone";

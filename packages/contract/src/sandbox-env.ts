/**
 * How an agent run's coding tools reach its sandbox session (#230), between the run (`@commissary/agents`), the API
 * Worker's run gateway and the Tools part (`@commissary/tools`), which name each other only through these plain types.
 *
 * A run's call of pi's `bash`, `read`, `write` or `edit` is gated first as the sandbox toolkit's tool of the same name:
 * the run calls that tool through the MCP endpoint with {@link RUN_EXECUTES_META} set in the request's `_meta`, and the
 * Tools part, once every gate passed (grant, tool scope, approval rules, Spend limits, price), answers a
 * {@link RunToolTicket} in the result's `_meta` ({@link RUN_TICKET_META}) instead of making the call. The run then
 * executes pi's tool on its session, each of the tool's operations a {@link SandboxEnvRequest} the Tools part runs only
 * with the ticket, and settles the ticket once the tool answered ({@link RunToolReport}), which writes the call's one
 * usage record.
 */

/** The `_meta` key of a run's `tools/call` that asks for a ticket rather than the call (a run's call only). */
export const RUN_EXECUTES_META = "commissary/run-executes";

/** The `_meta` key of the result that carries the ticket of a gated call. */
export const RUN_TICKET_META = "commissary/run-ticket";

/**
 * The `_meta` key of a run's `sandbox_open` that opens the run's own session (a run's call only): that session lasts as
 * long as the run, which purges it when it is deleted. Any other session a run opens ends after a day without a call.
 */
export const RUN_SESSION_META = "commissary/run-session";

/** The longest a command of a run's coding tools runs, in ms: the sandbox toolkit's ten minutes (`sandbox_bash`). */
export const SANDBOX_MAX_TIMEOUT_MS = 600_000;

/** A gated call's ticket: the run's operations of that one call name it, and its settling ends it. */
export interface RunToolTicket {
  readonly id: string;
}

/** A command's answer: its exit code and output, each stream's tail when it was cut, and the file holding the whole. */
export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** A sandbox file holding the whole output, when the session cut it and saved it. */
  readonly savedAt?: string | undefined;
}

/** What a path is, as the session answers it. */
export interface SandboxFileStat {
  readonly kind: "file" | "directory" | "symlink";
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * One operation of a gated call on the run's session: a command in its working directory (`exec`), what a path is
 * (`stat`, `null` for none), a range of a file's bytes (`read`), a file's text (`readText`), or a file written whole
 * with its directories (`write`).
 */
export type SandboxEnvRequest =
  | { readonly op: "exec"; readonly command: string; readonly timeoutMs: number }
  | { readonly op: "stat"; readonly path: string }
  | {
      readonly op: "read";
      readonly path: string;
      readonly offset: number;
      readonly length: number;
    }
  | { readonly op: "readText"; readonly path: string }
  | { readonly op: "write"; readonly path: string; readonly content: string };

/** What each operation answers. */
export interface SandboxEnvValues {
  readonly exec: SandboxExecResult;
  readonly stat: SandboxFileStat | null;
  readonly read: Uint8Array;
  readonly readText: string;
  readonly write: null;
}

export type SandboxEnvOp = SandboxEnvRequest["op"];

/**
 * Why an operation was not done: `ticket`, the call has no valid ticket (unknown, settled, expired, another run's, or
 * an operation its tool does not make); `lost`, the run's session is gone (unknown or closed); `failed`, the operation
 * failed (`message` says why, in words for the model).
 */
export type SandboxEnvRefusal = "ticket" | "lost" | "failed";

/**
 * An operation's answer: its value, or why not. Either may carry a `note` for the model, which the run adds to the
 * tool's answer: the operation stopped the session's running computer, as a Spend limit its time counts toward has no
 * room (#224).
 */
export type SandboxEnvReply<Op extends SandboxEnvOp = SandboxEnvOp> = (
  | { readonly ok: true; readonly value: SandboxEnvValues[Op] }
  | { readonly ok: false; readonly reason: SandboxEnvRefusal; readonly message: string }
) & { readonly note?: string | undefined };

/**
 * How the gated call ended, as the run reports it when it settles the ticket: pi's tool answered (`success`, or
 * `tool_error` for an error result), or the run could not finish it (`upstream_failure`: it was cut off, or the run
 * stopped before it answered). `responseBytes`: the bytes of its answer as JSON.
 */
export interface RunToolReport {
  readonly outcome: "success" | "tool_error" | "upstream_failure";
  readonly responseBytes: number;
}

/**
 * What settling a ticket did: whether it wrote the call's usage record (not for a ticket that was settled already,
 * expired or is another run's), and, when a Spend limit refused the call after all, the refusal's words.
 */
export interface RunToolSettled {
  readonly recorded: boolean;
  readonly refusal?: string | undefined;
}

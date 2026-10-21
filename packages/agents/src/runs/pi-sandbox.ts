/**
 * The run's sandbox (#230, ADR 0041), beside the pi-durable adapter (`pi.ts`): pi-durable's built-in coding tools
 * `bash`, `read`, `write` and `edit`, executed on the run's own sandbox session. Each is pi's tool as the model knows
 * it (its name, its parameters, its repair of arguments models get wrong, its output), and each call is gated first as
 * the sandbox toolkit's tool of the same name (`sandbox_bash`, `sandbox_read`, `sandbox_write`, `sandbox_edit`): the
 * MCP endpoint's `tools/call` as the run's principal, on its session, which every gate of that tool applies to (its
 * grant or the shared agent's definition, the tool scope's tool classes, its approval rules, its Spend limits and
 * price) and which answers a ticket instead of making the call (`@commissary/contract/sandbox-env`). pi's tool then
 * runs with an execution environment over the session (`sandbox-env.ts`) whose every operation the Tools part runs with
 * that ticket, and the call is settled once pi's tool answered, which writes its one usage record however many
 * operations it made. Each tool is described as the sandbox tool it is gated as. The run holds no files: they are its
 * session's, which the run opens at its first call of one of them (`sandbox_open`, with the network and computer its
 * definition names, a call of its own) and which lasts as long as the run.
 */
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { LlmContent } from "@earendil-works/pi-mcp";
import { Option, Schema } from "effect";
import type { AgentSandbox } from "@commissary/contract/agents";
import {
  type RunToolReport,
  type RunToolSettled,
  SANDBOX_MAX_TIMEOUT_MS,
  type SandboxEnvReply,
  type SandboxEnvRequest,
} from "@commissary/contract/sandbox-env";
import { SandboxExecutionEnv } from "./sandbox-env.ts";

/** The sandbox toolkit's tools a run's coding tools call, by their upstream names (`<toolkit>_<name>`). */
export const SANDBOX_TOOL_NAMES = [
  "open",
  "bash",
  "read",
  "write",
  "edit",
  "list",
  "close",
] as const;

/** pi's coding tools, each with the sandbox tool it is gated as. */
const CODING_TOOLS: ReadonlyArray<{ readonly tool: ToolRegistration; readonly calls: string }> = [
  { tool: createBashTool(), calls: "bash" },
  { tool: createReadTool(), calls: "read" },
  { tool: createWriteTool(), calls: "write" },
  { tool: createEditTool(), calls: "edit" },
];

/** What the model is told when the run's session was gone, and the call was made again in a new one. */
const SESSION_LOST =
  "The run's sandbox session was gone, and its files with it: a new, empty session was opened for this call.";

/** The bytes of a tool's answer as JSON (UTF-8), as a usage record counts it. */
const answerBytes = (answer: ToolExecutionResult | string): number =>
  new TextEncoder().encode(
    JSON.stringify(
      typeof answer === "string" ? answer : (answer.output ?? answer.structuredOutput ?? null),
    ),
  ).byteLength;

/** A call's arguments, as the model sent them: a JSON object. */
const decodeArguments = Schema.decodeUnknownOption(Schema.JsonObject);

/** What one call of a sandbox tool answered, as the model gets it. */
export interface SandboxAnswer {
  readonly output: Array<LlmContent>;
  readonly isError: boolean;
  /** `sandbox_open`'s session id, when the call opened one. */
  readonly session?: string | undefined;
  /** The call named a session that is gone (unknown, or closed): the run opens another. */
  readonly lost?: boolean | undefined;
}

/** How the run's coding tools reach its sandbox. */
export interface RunSandboxPort {
  /**
   * Opens the run's own session: calls the sandbox tool `name` (`sandbox_open`, its full name) with `args`, as the run,
   * through the MCP endpoint, marked as the run's own session (`RUN_SESSION_META`), which lasts as long as the run.
   */
  readonly open: (
    name: string,
    args: JsonObject,
    signal: AbortSignal | undefined,
  ) => Promise<SandboxAnswer>;
  /**
   * Gates the call of the sandbox tool `name` with `args` for the run to execute: the call's ticket once every gate
   * passed, or the tool's answer (a refusal, a call waiting for approval) when one did not.
   */
  readonly gate: (
    name: string,
    args: JsonObject,
    signal: AbortSignal | undefined,
  ) => Promise<{ readonly ticket: string } | SandboxAnswer>;
  /** Runs one operation of the gated call `ticket` on the run's session. */
  readonly operate: (ticket: string, request: SandboxEnvRequest) => Promise<SandboxEnvReply>;
  /** Settles the gated call `ticket` with how it ended, which writes its usage record. */
  readonly settle: (ticket: string, report: RunToolReport) => Promise<RunToolSettled>;
  /** The run's session, if it opened one. */
  readonly session: () => string | undefined;
  /** Keeps the session the run opened; `undefined` forgets one that is gone. */
  readonly opened: (session: string | undefined) => void;
  /**
   * Why the run left its previous session, once (the turn found it no longer fits the definition's sandbox, #230): the
   * call that opens the next one tells the model.
   */
  readonly notice: () => string | undefined;
}

/** `done` with the notes its operations answered (#224: the session's computer stopped) as warnings for the model. */
const withNotes = (done: ToolExecutionResult, notes: ReadonlyArray<string>): ToolExecutionResult =>
  notes.length === 0
    ? done
    : {
        ...done,
        diagnostics: [
          ...(done.diagnostics ?? []),
          ...notes.map((message) => ({
            severity: "warn" as const,
            code: "sandbox_computer",
            message,
          })),
        ],
      };

/** `done` with `notice`, why the run's previous session was left, as a warning for the model. */
const withNotice = (done: ToolExecutionResult, notice: string | undefined): ToolExecutionResult =>
  notice === undefined
    ? done
    : {
        ...done,
        diagnostics: [
          ...(done.diagnostics ?? []),
          { severity: "warn", code: "sandbox_session", message: notice },
        ],
      };

/** One attempt of a coding tool's call: pi's tool's answer, or what it threw, and whether the session was gone. */
type Attempt =
  | { readonly done: ToolExecutionResult; readonly lost: boolean }
  | { readonly failed: unknown; readonly lost: true };

/** An attempt's answer: what it threw is thrown, as pi's tool threw it (an error result). */
const answered = (attempt: Attempt): ToolExecutionResult => {
  if ("failed" in attempt) throw attempt.failed;

  return attempt.done;
};

/**
 * The full name of the sandbox toolkit `toolkit`'s tool `name`, as the MCP endpoint lists it: the toolkit's id is its
 * name, as the sandbox toolkit is a built-in one.
 */
export const sandboxToolName = (toolkit: string, name: string): string => `${toolkit}_${name}`;

/**
 * pi's coding tools routed to the run's sandbox session in the sandbox toolkit `sandbox` names, as far as the run
 * reaches that toolkit's tools: `listed` (the MCP endpoint's tool list for the run, by full name, with each one's
 * description). None unless the run may open a session (`sandbox_open`); then each of pi's tools whose sandbox tool
 * the run reaches (a read-only tool scope gives `read` alone).
 */
export const sandboxTools = (
  sandbox: AgentSandbox,
  listed: ReadonlyMap<string, string | undefined>,
  port: RunSandboxPort,
): ReadonlyArray<ToolRegistration> => {
  const full = (name: string) => sandboxToolName(sandbox.toolkit, name);

  if (!listed.has(full("open"))) return [];

  // The sandbox's answers name its own tools (a call waiting for approval says to call it again): the model knows them
  // as pi's, and opens no session itself, so `sandbox_open` is the tool whose call opened it.
  const names = new Map(
    CODING_TOOLS.map(({ tool, calls }): [string, string] => [full(calls), tool.name]),
  );

  const pattern = new RegExp(
    `\\b(${[full("open"), ...names.keys()].map((name) => name.replace(/[^A-Za-z0-9_]/g, "\\$&")).join("|")})\\b`,
    "g",
  );

  const named =
    (calling: string) =>
    (content: LlmContent): LlmContent =>
      content.type === "text"
        ? {
            ...content,
            text: content.text.replace(pattern, (name) => names.get(name) ?? calling),
          }
        : content;

  let opening: Promise<string | SandboxAnswer> | undefined;

  /** The run's session, opened with its definition's settings on first use; or why it could not be opened. */
  const session = async (signal: AbortSignal | undefined): Promise<string | SandboxAnswer> => {
    const known = port.session();

    if (known !== undefined) return known;

    opening ??= (async () => {
      const answer = await port.open(
        full("open"),
        {
          ...(sandbox.network === undefined ? {} : { network: sandbox.network }),
          ...(sandbox.computer === undefined ? {} : { computer: sandbox.computer }),
        },
        signal,
      );

      if (answer.isError || answer.session === undefined) return answer;
      port.opened(answer.session);

      return answer.session;
    })().finally(() => {
      opening = undefined;
    });

    return await opening;
  };

  return CODING_TOOLS.flatMap(({ tool, calls }): ReadonlyArray<ToolRegistration> => {
    const name = full(calls);

    if (!listed.has(name)) return [];

    return [
      {
        ...tool,
        description: listed.get(name) ?? tool.description,
        // A call cut off by a restart is not made again: the model gets it as interrupted, as for any MCP tool, and
        // the run settles its ticket as interrupted when it reopens.
        replay: "unsafe",
        execute: async (args, api, context) => {
          const asked: JsonObject = { ...Option.getOrElse(decodeArguments(args), () => ({})) };

          // pi's bash takes any timeout; the sandbox's commands run ten minutes at most.
          if (calls === "bash" && typeof asked["timeout"] === "number")
            asked["timeout"] = Math.min(asked["timeout"], SANDBOX_MAX_TIMEOUT_MS / 1000);

          /** One gated call of pi's tool on the run's session, settled once it answered. */
          const attempt = async (): Promise<Attempt> => {
            const fresh = port.session() === undefined;
            const opened = await session(context.abortSignal);

            if (typeof opened !== "string")
              return { done: { output: opened.output, isError: true }, lost: false };

            // The call that opened a new session tells why the previous one was left, if the turn left it.
            const notice = fresh ? port.notice() : undefined;

            const gated = await port.gate(name, { ...asked, session: opened }, context.abortSignal);

            if (!("ticket" in gated))
              return {
                done: withNotice(
                  { output: gated.output.map(named(tool.name)), isError: gated.isError },
                  notice,
                ),
                lost: gated.lost === true,
              };

            const env = new SandboxExecutionEnv(
              opened,
              // SAFETY: the Tools part answers each operation with its own operation's value.
              async (request) => (await port.operate(gated.ticket, request)) as never,
            );

            let report: RunToolReport = { outcome: "upstream_failure", responseBytes: 0 };

            try {
              const done = await tool.execute(args, { ...api, env }, context);

              report = {
                outcome: done.isError === true ? "tool_error" : "success",
                responseBytes: answerBytes(done),
              };

              return { done: withNotice(withNotes(done, env.notes), notice), lost: env.lost };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);

              report = {
                outcome: context.abortSignal?.aborted === true ? "upstream_failure" : "tool_error",
                responseBytes: answerBytes(message),
              };

              // A session that is gone is replaced (below): only another failure is the tool's answer.
              if (env.lost) return { failed: error, lost: true };

              throw error;
            } finally {
              await port.settle(
                gated.ticket,
                env.lost ? { ...report, outcome: "upstream_failure" } : report,
              );
            }
          };

          const first = await attempt();

          if (!first.lost) return answered(first);

          // A session that is gone (its sandbox lost it) is replaced once; its files are gone, and the model is told
          // so.
          port.opened(undefined);
          const again = await attempt();
          const done = answered(again);

          return {
            ...done,
            diagnostics: [
              ...(done.diagnostics ?? []),
              { severity: "warn", code: "sandbox_session", message: SESSION_LOST },
            ],
          };
        },
      },
    ];
  });
};

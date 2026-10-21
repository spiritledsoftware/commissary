/**
 * The sandbox toolkit's tools (ADR 0041, #222), as Commissary lists and calls them whatever sandbox provider is behind
 * the toolkit (`provider.ts`). Their shape follows pi's coding tools (bash, read, write, edit, ls), so a hosted agent's
 * tools map onto them one to one (#230): `sandbox_open` answers a session id, which the others take, since MCP calls
 * are stateless; `sandbox_close` ends it. Reading and listing read; the rest write (ADR 0038). Output is cut as pi cuts
 * it (`truncate.ts`), and the cut is stated.
 *
 * A call decodes the client's arguments and asks the provider as the caller's principal in the org ({@link
 * SandboxCall}). Invalid arguments, a network above the org's ceiling and the provider's failures are tool results with
 * `isError`, so the model can correct itself: an id that is not one of the caller's sessions is an unknown session,
 * whoever's it is.
 */
import { Effect, Result, Schema } from "effect";
import { isRunPrincipalId } from "@commissary/auth";
import type { OutboundPolicy } from "@commissary/core";
import { SANDBOX_MAX_TIMEOUT_MS } from "@commissary/contract/sandbox-env";
import { SandboxNetwork } from "@commissary/contract/tools";
import {
  describeNetwork,
  NO_NETWORK,
  type SandboxAllowance,
  networkProblem,
  normalizedNetwork,
  withinCeiling,
} from "./network.ts";
import {
  type CommandOutput,
  type ComputerMeter,
  addedTime,
  type ComputerTime,
  type Metered,
  SANDBOX_HOME,
  SandboxError,
  type SandboxOwner,
  type SandboxProvider,
  type SessionOpener,
} from "./provider.ts";
import {
  byteLength,
  formatSize,
  MAX_BYTES,
  MAX_LINES,
  truncateHead,
  truncateTail,
} from "./truncate.ts";

/**
 * What the Tools part keeps of its org's sandbox sessions (`sessions.ts`, #222): told when the caller opened one, used
 * one, or found or made one ended, so a member's leaving and the org's deletion reach every open session.
 */
export interface SandboxSessionLog {
  readonly opened: (session: string) => void;
  readonly used: (session: string) => void;
  readonly ended: (session: string) => void;
}

/** A call as the Tools part makes it: whose, under which ceiling and outbound policy, and when. */
export interface SandboxCall {
  readonly owner: SandboxOwner;
  readonly sessions: SandboxSessionLog;
  /**
   * The call opens an agent run's own session (#230, `RUN_SESSION_META`, a run principal's only): it lasts as long as
   * the run, which purges it when it is deleted. Any other session ends after a day without a call.
   */
  readonly runSession?: boolean | undefined;
  /** The org's ceiling, the sandbox toolkit's: the widest network a session may ask for, and whether the computer. */
  readonly ceiling: SandboxAllowance;
  readonly policy: OutboundPolicy;
  /** Epoch ms, the Tools part's clock. */
  readonly now: number;
  /** The session's computer time's metering (#224), which every call of a session passes to the provider. */
  readonly meter?: ComputerMeter | undefined;
  /** Who opens a session, which its usage record of computer time names (#224). */
  readonly opener?: SessionOpener | undefined;
}

/**
 * What a sandbox tool's call answers: its tool result, with its session's computer time since the call before when it
 * was metered (#224), which the call charges, and `needed` when the session refused it because a Spend limit has no
 * room and the command would have run on the computer, with `computerStopped` when the call stopped the computer,
 * which ran, first.
 */
export interface SandboxAnswer {
  readonly result: Schema.JsonObject;
  readonly computerTime?: ComputerTime | undefined;
  readonly computer?: "needed" | undefined;
  readonly computerStopped?: true | undefined;
}

/**
 * The note a call's result carries when the call stopped the session's running computer because a Spend limit its time
 * counts toward has no room (#224): `sandbox_bash`'s `note`, and a text block after any other tool's result.
 */
export const COMPUTER_STOPPED_NOTE =
  "The sandbox session's computer was stopped: a Spend limit its computer time counts toward is reached. Commands just-bash can run still run; one that needs the computer is refused.";

/** `result` with `note` after it, as a text block of its own. */
const noted = (result: Schema.JsonObject, note: string): Schema.JsonObject => {
  const content = Array.isArray(result["content"]) ? result["content"] : [];

  return Object.assign({}, result, { content: [...content, { type: "text", text: note }] });
};

/**
 * A tool result with the computer time of the provider's answer that it renders, and the note that the call stopped
 * the computer, when it did: `render` takes the note when it words it itself (`sandbox_bash`), else it follows.
 */
const answered = <A>(
  metered: Metered<A>,
  render: (value: A, note: string | undefined) => Schema.JsonObject,
  ownNote = false,
): SandboxAnswer => {
  const note = metered.computerStopped === true ? COMPUTER_STOPPED_NOTE : undefined;
  const rendered = render(metered.value, note);
  const result = note === undefined || ownNote ? rendered : noted(rendered, note);

  return metered.computerTime === undefined
    ? { result }
    : { result, computerTime: metered.computerTime };
};

/** A command's longest run: ten minutes (`SANDBOX_MAX_TIMEOUT_MS`). Without a timeout it may run two. */
export const MAX_TIMEOUT_SECONDS = SANDBOX_MAX_TIMEOUT_MS / 1000;

const DEFAULT_TIMEOUT_SECONDS = 120;

/** Entries `sandbox_list` answers unless told otherwise, as pi's ls. */
const DEFAULT_LIST_LIMIT = 500;

const optional = Schema.optionalKey;

const session = Schema.String.annotate({
  description: "The sandbox session's id, as sandbox_open answered it.",
});

const path = (description: string) => Schema.String.annotate({ description });

const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The tools, one record each, in the order the toolkit lists them. */
const TOOLS = {
  open: {
    description:
      "Open a sandbox session: a private working directory (/workspace) where sandbox_bash runs shell commands and the file tools read and write. Answers the session id the other sandbox tools take. Its files are deleted when it is closed, or after a day without use. No network unless one is asked for, within what the org allows. Commands run with just-bash; ask for the computer to run what just-bash cannot (node, python, git, other binaries, installed with mise), when the org allows it.",
    arguments: Schema.Struct({
      network: optional(
        SandboxNetwork.annotate({
          description:
            'The network its commands may reach: {"kind":"none"} (the default), {"kind":"hosts","hosts":["example.com","*.example.org"],"presets":["package_registries"]} for only those hosts, or {"kind":"open"} for the internet. It must be within what the org allows.',
        }),
      ),
      computer: optional(
        Schema.Boolean.annotate({
          description:
            "Whether the session may use the computer (default false): a Linux machine on the same files, where a command just-bash cannot run at all is run instead. It starts with the first such command, and stops after 10 idle minutes. Install runtimes with mise (mise use node@22); installs last as long as the session. The org must allow it.",
        }),
      ),
    }),
    read: false,
  },
  bash: {
    description: `Run a shell command in a sandbox session's working directory (/workspace), with a bash-like shell (just-bash: cat, ls, grep, sed, awk, jq, find, sort, curl and more; no npm, node, python, git or other binaries). In a session that may use the computer, a command just-bash cannot run at all (one it lacks, or syntax it does not support) runs on the computer instead, where mise installs runtimes (mise use node@22). Returns the exit code, stdout and stderr. Output is truncated to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB of each (whichever is hit first); the full output is saved in a file it names. Optionally provide a timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}).`,
    arguments: Schema.Struct({
      session,
      command: Schema.String.annotate({ description: "Shell command to execute" }),
      timeout: optional(
        Schema.Number.check(
          Schema.isGreaterThan(0),
          Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS),
        ).annotate({ description: "Timeout in seconds" }),
      ),
    }),
    read: false,
  },
  read: {
    description: `Read the contents of a file in a sandbox session. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    arguments: Schema.Struct({
      session,
      path: path("Path to the file to read (relative to /workspace, or absolute)"),
      offset: optional(
        positiveInt.annotate({ description: "Line number to start reading from (1-indexed)" }),
      ),
      limit: optional(positiveInt.annotate({ description: "Maximum number of lines to read" })),
    }),
    read: true,
  },
  write: {
    description:
      "Write content to a file in a sandbox session. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    arguments: Schema.Struct({
      session,
      path: path("Path to the file to write (relative to /workspace, or absolute)"),
      content: Schema.String.annotate({ description: "Content to write to the file" }),
    }),
    read: false,
  },
  edit: {
    description:
      "Edit a single file in a sandbox session using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.",
    arguments: Schema.Struct({
      session,
      path: path("Path to the file to edit (relative to /workspace, or absolute)"),
      edits: Schema.Array(
        Schema.Struct({
          oldText: Schema.String.annotate({
            description:
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          }),
          newText: Schema.String.annotate({
            description: "Replacement text for this targeted edit.",
          }),
        }),
      )
        .check(Schema.isMinLength(1))
        .annotate({
          description:
            "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
        }),
    }),
    read: false,
  },
  list: {
    description: `List a directory in a sandbox session. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIST_LIMIT} entries or ${MAX_BYTES / 1024}KB (whichever is hit first).`,
    arguments: Schema.Struct({
      session,
      path: optional(path("Directory to list (default: /workspace)")),
      limit: optional(
        positiveInt.annotate({
          description: `Maximum number of entries to return (default: ${DEFAULT_LIST_LIMIT})`,
        }),
      ),
    }),
    read: true,
  },
  close: {
    description: "Close a sandbox session. Its files are deleted at once.",
    arguments: Schema.Struct({ session }),
    read: false,
  },
} as const;

type SandboxToolName = keyof typeof TOOLS;

type Arguments<K extends SandboxToolName> = (typeof TOOLS)[K]["arguments"]["Type"];

/** A tool of the sandbox toolkit as its tool list holds it. */
export interface SandboxTool {
  /** Its upstream name (the full name is `sandbox_<name>`). */
  readonly name: SandboxToolName;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
  /** Reading and listing read (`readOnlyHint`, the class `read`); the rest write. */
  readonly annotations: Schema.JsonObject;
}

// SAFETY: `TOOLS`'s own keys are exactly its names.
const TOOL_NAMES = Object.keys(TOOLS) as ReadonlyArray<SandboxToolName>;

/** The sandbox toolkit's tools, in the order it lists them. */
export const SANDBOX_TOOLS: ReadonlyArray<SandboxTool> = TOOL_NAMES.map((name) => ({
  name,
  description: TOOLS[name].description,
  // SAFETY: a JSON Schema document's schema is a JSON object.
  inputSchema: Schema.toJsonSchemaDocument(TOOLS[name].arguments).schema as Schema.JsonObject,
  annotations: TOOLS[name].read
    ? { readOnlyHint: true }
    : { readOnlyHint: false, destructiveHint: name === "close" || name === "write" },
}));

const isTool = (name: string): name is SandboxToolName => Object.hasOwn(TOOLS, name);

/**
 * Whether a call of the sandbox tool `name` meets its session's computer, so that a Spend limit its computer time counts
 * toward is checked on it (#224): every tool of an open session but `sandbox_close`, which stops the computer anyway.
 * `sandbox_open` has no session yet.
 */
export const meetsComputer = (name: string): boolean =>
  isTool(name) && name !== "open" && name !== "close";

/** An MCP tool result of one text block. */
interface TextResult {
  [field: string]: Schema.Json;
  content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  structuredContent?: Schema.JsonObject;
  isError?: true;
}

/** A tool result of text, with what else it carries: its structured content, and whether it reports a failure. */
const text = (
  body: string,
  extra: { readonly structuredContent?: Schema.JsonObject; readonly isError?: boolean } = {},
): Schema.JsonObject => {
  const result: TextResult = { content: [{ type: "text", text: body }] };

  if (extra.structuredContent !== undefined) result["structuredContent"] = extra.structuredContent;

  if (extra.isError === true) result["isError"] = true;

  return result;
};

/** A tool result that reports a failure to the model. */
const toolError = (body: string): Schema.JsonObject => text(body, { isError: true });

/**
 * The answer to a call that names no principal (an endpoint from before calls carried one): a session is one
 * principal's, so the sandbox cannot be used without knowing whose.
 */
export const NO_PRINCIPAL: Schema.JsonObject = toolError(
  "Commissary could not tell who is calling, so the sandbox cannot be used from this call.",
);

/** A path as the provider takes it: absolute, relative ones under the working directory, `.` and `..` resolved. */
export const resolvePath = (input: string): string => {
  const parts: Array<string> = [];

  for (const part of (input.startsWith("/") ? input : `${SANDBOX_HOME}/${input}`).split("/")) {
    if (part === "" || part === ".") continue;

    if (part === "..") parts.pop();
    else parts.push(part);
  }

  return `/${parts.join("/")}`;
};

/** What `sandbox_open` answers a session that asks for the computer on a deployment without one (ADR 0043). */
export const NO_COMPUTER =
  'This deployment has no computer, so a sandbox runs every command with just-bash. Its operator can add one (docs/DEPLOY.md, "Optional pieces").';

/** What a call naming no session of the caller's answers (#230: a run's gated call of another's session too). */
export const unknownSessionResult = (sessionId: string): Schema.JsonObject =>
  text(`Unknown sandbox session ${sessionId}. Open one with sandbox_open.`, {
    isError: true,
    structuredContent: { reason: "unknown_session" },
  });

/**
 * A provider failure as the model reads it. A session that is gone also says so in its structured content (`reason`),
 * so an agent run, which opens its session itself (#230), opens another.
 */
const failure = (error: SandboxError, sessionId: string | undefined): Schema.JsonObject => {
  switch (error.reason) {
    case "unknown_session":
      return unknownSessionResult(sessionId ?? "");
    case "closed":
      return text(
        `The sandbox session ${sessionId ?? ""} is closed, and its files are gone. Open a new one with sandbox_open.`,
        { isError: true, structuredContent: { reason: error.reason } },
      );
    case "file":
    case "unavailable":
    case "refused":
      return toolError(error.message);
  }
};

/**
 * The note pi's bash tool puts after output it cut, keeping its end: the last bytes of one long line, or the lines kept
 * and, when bytes cut them, the limit; and where the whole output is, when it was saved.
 */
export const cutNote = (cut: {
  readonly kept: string;
  readonly totalLines: number;
  readonly firstLine: number;
  readonly partialLine: boolean;
  readonly limit: "lines" | "bytes";
  readonly savedAt?: string | undefined;
}): string => {
  const saved = cut.savedAt === undefined ? "" : ` Full output: ${cut.savedAt}`;
  const lines = `lines ${cut.firstLine}-${cut.totalLines} of ${cut.totalLines}`;

  if (cut.partialLine && cut.firstLine === cut.totalLines)
    return `[Showing last ${formatSize(byteLength(cut.kept))} of line ${cut.totalLines}.${saved}]`;

  if (cut.partialLine)
    return `[Showing ${lines} (${formatSize(MAX_BYTES)} limit; line ${cut.firstLine} only in part).${saved}]`;

  return cut.limit === "lines"
    ? `[Showing ${lines}.${saved}]`
    : `[Showing ${lines} (${formatSize(MAX_BYTES)} limit).${saved}]`;
};

/** One stream of a command's output, cut as pi's bash tool cuts it, with the cut stated. */
const renderedOutput = (output: CommandOutput): string => {
  if (output.cut !== undefined)
    return `${output.text}\n\n${cutNote({ kept: output.text, ...output.cut })}`;

  const cut = truncateTail(output.text);

  if (!cut.truncated) return cut.content;

  return `${cut.content}\n\n${cutNote({
    kept: cut.content,
    totalLines: cut.totalLines,
    firstLine: cut.totalLines - cut.outputLines + 1,
    partialLine: cut.lastLinePartial,
    limit: cut.truncatedBy === "lines" ? "lines" : "bytes",
  })}`;
};

/** A file's text from line `offset`, as pi's read tool answers it. */
const renderedRead = (
  content: string,
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
): Schema.JsonObject => {
  const lines = content.split("\n");
  const start = offset === undefined ? 0 : offset - 1;

  if (start >= lines.length)
    return toolError(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);

  const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
  const cut = truncateHead(lines.slice(start, end).join("\n"));
  const first = start + 1;

  if (cut.firstLineExceedsLimit)
    return text(
      `[Line ${first} is ${formatSize(byteLength(lines[start] ?? ""))}, exceeds ${formatSize(MAX_BYTES)} limit. Use sandbox_bash: sed -n '${first}p' ${filePath} | head -c ${MAX_BYTES}]`,
    );

  if (cut.truncated) {
    const last = first + cut.outputLines - 1;

    return text(
      `${cut.content}\n\n[Showing lines ${first}-${last} of ${lines.length}${cut.truncatedBy === "bytes" ? ` (${formatSize(MAX_BYTES)} limit)` : ""}. Use offset=${last + 1} to continue.]`,
    );
  }

  return end < lines.length
    ? text(
        `${cut.content}\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`,
      )
    : text(cut.content);
};

/** `content` with `edits` applied, each matched once against the original, or why they cannot be. */
export const applyEdits = (
  content: string,
  edits: ReadonlyArray<{ readonly oldText: string; readonly newText: string }>,
  filePath: string,
): Result.Result<string, string> => {
  const spans: Array<{ start: number; end: number; newText: string }> = [];

  for (const [index, edit] of edits.entries()) {
    const which = edits.length === 1 ? "the text" : `edits[${index}].oldText`;

    if (edit.oldText === "") return Result.fail(`${which} is empty.`);
    const start = content.indexOf(edit.oldText);

    if (start === -1)
      return Result.fail(
        `Could not find ${which} in ${filePath}. It must match exactly, including whitespace and newlines.`,
      );

    if (content.indexOf(edit.oldText, start + 1) !== -1)
      return Result.fail(
        `Found ${which} more than once in ${filePath}. Give more context to make it unique.`,
      );

    spans.push({ start, end: start + edit.oldText.length, newText: edit.newText });
  }

  spans.sort((a, b) => a.start - b.start);

  for (const [index, span] of spans.entries()) {
    const next = spans[index + 1];

    if (next !== undefined && next.start < span.end)
      return Result.fail(`Edits overlap in ${filePath}; merge them into one.`);
  }

  let edited = content;

  for (const span of spans.toReversed())
    edited = edited.slice(0, span.start) + span.newText + edited.slice(span.end);

  return Result.succeed(edited);
};

/** A directory's entries as pi's ls tool answers them. */
const renderedList = (
  entries: ReadonlyArray<{ readonly name: string; readonly directory: boolean }>,
  limit: number,
): Schema.JsonObject => {
  if (entries.length === 0) return text("(empty directory)");

  const sorted = entries.toSorted((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );

  const listed = sorted
    .slice(0, limit)
    .map((entry) => `${entry.name}${entry.directory ? "/" : ""}`);

  const cut = truncateHead(listed.join("\n"), Number.MAX_SAFE_INTEGER);

  const notices = [
    ...(sorted.length > limit
      ? [`${limit} entries limit reached. Use limit=${limit * 2} for more`]
      : []),
    ...(cut.truncated ? [`${formatSize(MAX_BYTES)} limit reached`] : []),
  ];

  return text(notices.length === 0 ? cut.content : `${cut.content}\n\n[${notices.join(". ")}]`);
};

/** The decoded arguments of a call of `name`, or why they are invalid. */
const argumentsOf = <K extends SandboxToolName>(
  name: K,
  args: Schema.JsonObject,
): Result.Result<Arguments<K>, string> => {
  const decoded = Schema.decodeUnknownResult(TOOLS[name].arguments)(args);

  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure.message)
    : Result.succeed(decoded.success);
};

/** Runs one decoded call. */
const run = (
  provider: SandboxProvider,
  call: SandboxCall,
  request: {
    readonly [K in SandboxToolName]: { readonly tool: K; readonly args: Arguments<K> };
  }[SandboxToolName],
): Effect.Effect<SandboxAnswer, SandboxError> => {
  const { owner, now, meter } = call;

  switch (request.tool) {
    case "open": {
      const asked = request.args.network ?? NO_NETWORK;
      const problem = networkProblem(asked);

      if (problem !== undefined)
        return Effect.succeed({ result: toolError(`Invalid network: ${problem}`) });
      const network = normalizedNetwork(asked);

      if (!withinCeiling(network, call.ceiling.network))
        return Effect.succeed({
          result: toolError(
            `The org does not allow that network: a sandbox may have at most ${describeNetwork(call.ceiling.network)}.`,
          ),
        });
      const computer = request.args.computer ?? false;

      if (computer && !provider.computer) return Effect.succeed({ result: toolError(NO_COMPUTER) });

      if (computer && !call.ceiling.computer)
        return Effect.succeed({
          result: toolError(
            "The org does not allow the computer: a sandbox runs every command with just-bash. An org admin may allow it on the sandbox toolkit.",
          ),
        });

      // An agent run's own session lasts as long as the run (#230), which purges it when it is deleted.
      const untilPurged = call.runSession === true && isRunPrincipalId(owner.principal);

      return provider
        .open(owner, {
          network,
          computer,
          policy: call.policy,
          now,
          meter,
          opener: call.opener,
          untilPurged,
        })
        .pipe(
          Effect.tap((id) => Effect.sync(() => call.sessions.opened(id))),
          Effect.map((id) => ({
            result: text(
              `Opened sandbox session ${id} (working directory ${SANDBOX_HOME}, ${describeNetwork(network)}, ${computer ? "the computer allowed" : "the computer off"}). Pass session="${id}" to the other sandbox tools.`,
              { structuredContent: { session: id, network, computer } },
            ),
          })),
        );
    }

    case "bash": {
      const { session: id, command, timeout } = request.args;

      return provider
        .run(
          owner,
          id,
          { command, timeoutMs: Math.round((timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000), now },
          meter,
        )
        .pipe(
          Effect.map((metered) =>
            answered(
              metered,
              (result, stoppedNote) => {
                const stdout = renderedOutput(result.stdout);
                const stderr = renderedOutput(result.stderr);

                // The provider's note, and that the call stopped the computer (#224).
                const note = [result.note, stoppedNote]
                  .filter((part) => part !== undefined)
                  .join("\n\n");

                const body = [
                  stdout === "" && stderr === "" ? "(no output)" : stdout,
                  ...(stderr === "" ? [] : [`stderr:\n${stderr}`]),
                  ...(result.exitCode === 0 ? [] : [`Command exited with code ${result.exitCode}`]),
                  note,
                ]
                  .filter((part) => part !== "")
                  .join("\n\n");

                return text(body, {
                  structuredContent: {
                    exit_code: result.exitCode,
                    stdout,
                    stderr,
                    ...(note === "" ? {} : { note }),
                  },
                  isError: result.exitCode !== 0,
                });
              },
              true,
            ),
          ),
        );
    }

    case "read": {
      const { session: id, offset, limit } = request.args;
      const filePath = resolvePath(request.args.path);

      return provider
        .readFile(owner, id, filePath, now, meter)
        .pipe(
          Effect.map((metered) =>
            answered(metered, (content) => renderedRead(content, filePath, offset, limit)),
          ),
        );
    }

    case "write": {
      const { session: id, content } = request.args;
      const filePath = resolvePath(request.args.path);

      return provider
        .writeFile(owner, id, filePath, content, now, meter)
        .pipe(
          Effect.map((metered) =>
            answered(metered, () =>
              text(`Successfully wrote ${byteLength(content)} bytes to ${filePath}`),
            ),
          ),
        );
    }

    case "edit": {
      const { session: id, edits } = request.args;
      const filePath = resolvePath(request.args.path);

      return provider.readFile(owner, id, filePath, now, meter).pipe(
        Effect.flatMap((read) => {
          const edited = applyEdits(read.value, edits, filePath);

          if (Result.isFailure(edited))
            return Effect.succeed(answered(read, () => toolError(edited.failure)));

          // The write answers the computer time since the read: the call's is both, and the read may have stopped the
          // computer.
          const both = (written: { readonly computerTime?: ComputerTime | undefined }) => {
            const computerTime = addedTime(read.computerTime, written.computerTime);

            return {
              ...(computerTime === undefined ? {} : { computerTime }),
              ...(read.computerStopped === true ? { computerStopped: true as const } : {}),
            };
          };

          return provider.writeFile(owner, id, filePath, edited.success, now, meter).pipe(
            Effect.map((written) =>
              answered({ value: undefined, ...both(written) }, () =>
                text(`Successfully replaced ${edits.length} block(s) in ${filePath}.`),
              ),
            ),
            Effect.mapError(
              (error) =>
                new SandboxError({
                  reason: error.reason,
                  message: error.message,
                  ...(error.computerStopped === true ? { computerStopped: true as const } : {}),
                  ...both(error),
                }),
            ),
          );
        }),
      );
    }

    case "list": {
      const { session: id, limit } = request.args;

      return provider
        .list(owner, id, resolvePath(request.args.path ?? SANDBOX_HOME), now, meter)
        .pipe(
          Effect.map((metered) =>
            answered(metered, (entries) => renderedList(entries, limit ?? DEFAULT_LIST_LIMIT)),
          ),
        );
    }

    case "close": {
      const { session: id } = request.args;

      return provider
        .close(owner, id, now, meter)
        .pipe(
          Effect.map((metered) =>
            answered(metered, () => text(`Closed sandbox session ${id}; its files are deleted.`)),
          ),
        );
    }
  }
};

/**
 * Calls the sandbox tool `name` (its upstream name) with the client's arguments on `provider`, as `call` says, with the
 * computer time it answered (#224). Never fails: an unknown tool, invalid arguments and the provider's failures are tool
 * results with `isError`.
 */
export const callSandboxTool = (
  provider: SandboxProvider,
  call: SandboxCall,
  name: string,
  args: Schema.JsonObject | undefined,
): Effect.Effect<SandboxAnswer> => {
  if (!isTool(name))
    return Effect.succeed({ result: toolError(`The sandbox has no tool ${name}.`) });
  const decoded = argumentsOf(name, args ?? {});

  if (Result.isFailure(decoded))
    return Effect.succeed({ result: toolError(`Invalid arguments: ${decoded.failure}`) });
  // SAFETY: `decoded` holds the arguments of `name`.
  const request = { tool: name, args: decoded.success } as Parameters<typeof run>[2];
  const sessionId = "session" in decoded.success ? decoded.success.session : undefined;

  /** Tells the Tools part what the call found of the session: still there, or ended. */
  const logged = (outcome: "used" | "ended") =>
    Effect.sync(() => {
      if (sessionId !== undefined) call.sessions[outcome](sessionId);
    });

  return run(provider, call, request).pipe(
    Effect.tap(() => logged(name === "close" ? "ended" : "used")),
    Effect.catchTag("SandboxError", (error) =>
      Effect.gen(function* () {
        if (error.reason === "unavailable")
          yield* Effect.logWarning("sandbox provider failed").pipe(
            Effect.annotateLogs({
              provider: provider.id,
              tool: name,
              reason: error.reason,
              message: error.message,
            }),
          );

        // A session found closed stays logged: its close, by its alarm, is the session's to report (#224). A failure
        // of the sandbox is a use too: the session's object counts the call (its idle day starts over).
        if (error.reason === "file" || error.reason === "refused" || error.reason === "unavailable")
          yield* logged("used");

        const result = failure(error, sessionId);

        return {
          result:
            error.computerStopped === true && error.reason !== "refused"
              ? noted(result, COMPUTER_STOPPED_NOTE)
              : result,
          ...(error.computerTime === undefined ? {} : { computerTime: error.computerTime }),
          ...(error.reason === "refused" ? { computer: "needed" as const } : {}),
          ...(error.reason === "refused" && error.computerStopped === true
            ? { computerStopped: true as const }
            : {}),
        };
      }),
    ),
  );
};

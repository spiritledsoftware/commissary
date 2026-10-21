/**
 * The execution environment of one gated call of a run's coding tools (#230): pi-durable's `ExecutionEnv` over the
 * run's sandbox session, each operation one request of the gated call (`@commissary/contract/sandbox-env`) that the
 * Tools part runs with the call's ticket. It lives in the run's Durable Object, trusted code: nothing here holds a
 * binding or a stub of the session; every operation goes through the run gateway to the org's ControlPlane, which
 * reaches the session (docs/ARCHITECTURE.md, "Agents").
 *
 * It does what pi's `bash`, `read`, `write` and `edit` ask of an environment: run a command in the session's working
 * directory, say what a path is, read a file (its text, or its bytes by range), and write one. The rest of the
 * interface fails with `not_supported`. The design follows cloudpid's `ComputerExecutionEnv`
 * (`packages/computer-env`), a pi-durable environment over a `@cloudflare/computer` Workspace's Durable Object, with
 * one gated call in place of its owner's open access. A command's output reaches pi once the command ended; a cut
 * output's whole is the file the session saved it to (the call's `spillPath`).
 */
import type { Context } from "@earendil-works/chord";
import {
  type BinaryReader,
  err,
  ExecutionError,
  FileError,
  type FileInfo,
  LineScanner,
  type LineScan,
  ok,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import {
  SANDBOX_MAX_TIMEOUT_MS,
  type SandboxEnvOp,
  type SandboxEnvReply,
  type SandboxEnvRequest,
  type SandboxEnvValues,
  type SandboxFileStat,
} from "@commissary/contract/sandbox-env";

/** The session's working directory, where relative paths resolve (the sandbox toolkit's `SANDBOX_HOME`). */
export const SANDBOX_HOME = "/workspace";

/** How many bytes a line scan reads at a time. */
const SCAN_CHUNK = 1024 * 1024;

/** Runs one operation of the gated call. */
export type SandboxOperate = <Op extends SandboxEnvOp>(
  request: Extract<SandboxEnvRequest, { op: Op }>,
) => Promise<SandboxEnvReply<Op>>;

/** What the model is told when the run's session answered that it is gone. */
const SESSION_GONE = "The run's sandbox session is gone, and its files with it.";

/** `path` without `.` and `..` segments, absolute. */
const normalized = (path: string): string => {
  const segments: Array<string> = [];

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  return `/${segments.join("/")}`;
};

const notSupported = <A>(what: string): Result<A, FileError> =>
  err(new FileError("not_supported", `The run's sandbox does not support ${what}`));

/** `bytes` as UTF-8 text; `undefined` when they are not UTF-8. */
const utf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const fileInfo = (path: string, stat: SandboxFileStat): FileInfo => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind: stat.kind,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
});

/** pi-durable's environment over one gated call of the run's sandbox session. */
export class SandboxExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd = SANDBOX_HOME;
  readonly #operate: SandboxOperate;
  #lost = false;
  /** What the session's answers told the model (#224: its computer stopped), each once. */
  readonly #notes = new Set<string>();

  constructor(session: string, operate: SandboxOperate) {
    this.id = `commissary-sandbox:${session}`;
    this.#operate = operate;
  }

  /** Whether the session answered that it is gone (unknown, or closed): the run opens another. */
  get lost(): boolean {
    return this.#lost;
  }

  /** The notes for the model the call's operations answered, which the run adds to the tool's answer. */
  get notes(): ReadonlyArray<string> {
    return [...this.#notes];
  }

  /** Runs `request`, keeping its note. */
  async #run<Op extends SandboxEnvOp>(
    request: Extract<SandboxEnvRequest, { op: Op }>,
  ): Promise<SandboxEnvReply<Op>> {
    const reply = await this.#operate<Op>(request);

    if (reply.note !== undefined) this.#notes.add(reply.note);

    return reply;
  }

  /** The value of `request`'s answer, or its failure as a `FileError` at `path`. */
  async #file<Op extends SandboxEnvOp>(
    request: Extract<SandboxEnvRequest, { op: Op }>,
    path: string,
  ): Promise<Result<SandboxEnvValues[Op], FileError>> {
    const reply = await this.#run<Op>(request);

    if (reply.ok) return ok(reply.value);

    if (reply.reason === "lost") this.#lost = true;

    return err(
      new FileError(
        reply.reason === "ticket" ? "permission_denied" : "unknown",
        reply.reason === "lost" ? SESSION_GONE : reply.message,
        path,
      ),
    );
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(normalized(path.startsWith("/") ? path : `${this.cwd}/${path}`));
  }

  async joinPath(parts: Array<string>, _context: Context): Promise<Result<string, FileError>> {
    return ok(parts.join("/").replace(/\/+/g, "/"));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return await this.absolutePath(path, context);
  }

  async fileInfo(path: string, _context: Context): Promise<Result<FileInfo, FileError>> {
    const stat = await this.#file<"stat">({ op: "stat", path }, path);

    if (!stat.ok) return stat;

    return stat.value === null
      ? err(new FileError("not_found", `No such file or directory: ${path}`, path))
      : ok(fileInfo(path, stat.value));
  }

  async exists(path: string, _context: Context): Promise<Result<boolean, FileError>> {
    const stat = await this.#file<"stat">({ op: "stat", path }, path);

    return stat.ok ? ok(stat.value !== null) : stat;
  }

  async readTextFile(path: string, _context: Context): Promise<Result<string, FileError>> {
    return await this.#file<"readText">({ op: "readText", path }, path);
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const info = await this.fileInfo(path, context);

    if (!info.ok) return info;

    return await this.#file<"read">({ op: "read", path, offset: 0, length: info.value.size }, path);
  }

  async openBinaryReader(
    path: string,
    _options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const info = await this.fileInfo(path, context);

    if (!info.ok) return info;

    if (info.value.kind === "directory")
      return err(new FileError("is_directory", `${path} is a directory`, path));

    const read = async (offset: number, length: number) =>
      await this.#file<"read">({ op: "read", path, offset, length }, path);

    return ok({
      info: async (infoContext) => await this.fileInfo(path, infoContext),
      read: async (offset, length) => await read(offset, length),
      scanLines: async ({ startLine, endLine }, scanContext) => {
        const current = await this.fileInfo(path, scanContext);

        if (!current.ok) return current;
        const scanner = new LineScanner(startLine, endLine);

        for (let offset = 0; offset < current.value.size; offset += SCAN_CHUNK) {
          const chunk = await read(offset, Math.min(SCAN_CHUNK, current.value.size - offset));

          if (!chunk.ok) return chunk;

          if (chunk.value.length === 0) break;
          scanner.push(chunk.value);
        }

        return ok<LineScan, FileError>(scanner.finish());
      },
      close: async () => undefined,
    });
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    _context: Context,
  ): Promise<Result<void, FileError>> {
    const text = typeof content === "string" ? content : utf8(content);

    // The sandbox writes text: bytes that are not UTF-8 would be written changed, so they are not written at all.
    if (text === undefined) return notSupported("writing bytes that are not UTF-8 text");
    const written = await this.#file<"write">({ op: "write", path, content: text }, path);

    return written.ok ? ok(undefined) : written;
  }

  async exec(
    command: string | ReadonlyArray<string>,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (typeof command !== "string")
      return err(
        new ExecutionError("spawn_error", "The run's sandbox runs shell command lines only"),
      );

    if (context.abortSignal?.aborted === true)
      return err(new ExecutionError("aborted", "Command aborted"));

    const timeout =
      options?.timeout === undefined ? SANDBOX_MAX_TIMEOUT_MS : options.timeout * 1000;

    const timeoutMs = Math.max(1, Math.min(Math.round(timeout), SANDBOX_MAX_TIMEOUT_MS));
    const reply = await this.#run<"exec">({ op: "exec", command, timeoutMs });

    if (!reply.ok) {
      if (reply.reason === "lost") this.#lost = true;

      return err(
        new ExecutionError("unknown", reply.reason === "lost" ? SESSION_GONE : reply.message),
      );
    }

    const { exitCode, stdout, stderr, savedAt } = reply.value;

    if (stdout !== "") options?.onOutput?.(stdout, context, { stream: "stdout" });

    if (stderr !== "") options?.onOutput?.(stderr, context, { stream: "stderr" });

    return ok(savedAt === undefined ? { exitCode } : { exitCode, spillPath: savedAt });
  }

  async openTextLineReader(): Promise<Result<never, FileError>> {
    return notSupported("line readers");
  }

  async readTextLines(): Promise<Result<Array<string>, FileError>> {
    return notSupported("reading lines");
  }

  async appendFile(): Promise<Result<void, FileError>> {
    return notSupported("appending");
  }

  async truncateFile(): Promise<Result<void, FileError>> {
    return notSupported("truncating");
  }

  async flushFile(): Promise<Result<void, FileError>> {
    return ok(undefined);
  }

  async renameFile(): Promise<Result<void, FileError>> {
    return notSupported("renaming");
  }

  async listDir(): Promise<Result<Array<FileInfo>, FileError>> {
    return notSupported("listing directories");
  }

  async openDirReader(): Promise<Result<never, FileError>> {
    return notSupported("directory readers");
  }

  async watch(): Promise<Result<never, FileError>> {
    return notSupported("watching");
  }

  async createDir(): Promise<Result<void, FileError>> {
    return notSupported("creating directories");
  }

  async remove(): Promise<Result<void, FileError>> {
    return notSupported("removing");
  }

  async createTempDir(): Promise<Result<string, FileError>> {
    return notSupported("temporary directories");
  }

  async createTempFile(): Promise<Result<string, FileError>> {
    return notSupported("temporary files");
  }

  async cleanup(): Promise<void> {
    // Nothing to clean: the session is the run's, and the call holds nothing open.
  }
}

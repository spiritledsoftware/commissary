/**
 * `SandboxSession` (ADR 0041, #222): one sandbox session of Cloudflare's sandbox provider, a Durable Object in the state
 * Worker beside the ControlPlane (ADR 0030), named `<org>:<session id>` (`provider.ts`). It holds the session's
 * `@cloudflare/computer` Workspace, a filesystem in its own SQLite, and runs commands on it with just-bash, the
 * worker-shell backend: a Dynamic Worker loaded through the `LOADER` binding.
 *
 * That Dynamic Worker gets nothing but its files: its one binding is the Workspace's proxy back to this object (`HOST`,
 * `proxy.ts`), and its `globalOutbound` is the sandbox's egress entrypoint (`egress.ts`) with the session's network and
 * the outbound guard's policy, never the runtime's default. The loader is wrapped so that both hold whatever the backend
 * asks for (`loader.ts`). No credential and no secret enter it: no environment variables, no Commissary token.
 *
 * `@cloudflare/computer` and just-bash are loaded when a session first needs its Workspace (a literal dynamic import),
 * never at module load: the state Worker's main module exports this class, and every ControlPlane's cold start would
 * evaluate them otherwise.
 *
 * The object knows its org and its owner, a principal, from when the session opened; any other owner's call is
 * answered as a session that does not exist. It is deleted with its files at once on close, or after a day without use
 * (its alarm), and then keeps only a note that it was closed, for a week, so its owner's later calls answer that it is
 * closed; after that week they answer that it is unknown. `purge` deletes it with no note (its owner left, or the org
 * is being deleted). Commissary sets no limits of its own on it: the Durable Object's storage limit applies, and a
 * write past it is an error that says so.
 *
 * **The computer** (#223, `computer.ts`): a session that may use it, on a deployment that attached the computer's
 * container to this class (`ctx.container`), has a second backend in its Workspace. A command goes there only when
 * just-bash cannot run it at all (`fallback.ts`, decided before it runs); in a session without the computer, such a
 * command runs on just-bash, whose error it answers with a note that the computer is off. The computer's outbound
 * requests come back to this object (`fetch`, through `WorkspaceProxy`), which hands them to the same egress point.
 */
import { DurableObject } from "cloudflare:workers";
import type { Workspace, WorkspaceBackend, WorkspaceStub } from "@cloudflare/computer";
import {
  computerInstanceOf,
  DEFAULT_COMPUTER_INSTANCE,
  type OutboundPolicy,
} from "@commissary/core";
import type { SandboxAllowance } from "../network.ts";
import { MAX_BYTES, MAX_LINES } from "../truncate.ts";
import {
  type CommandResult,
  type DirectoryEntry,
  type OutputCut,
  SANDBOX_HOME,
  type SandboxError,
  SESSION_IDLE_MS,
} from "../provider.ts";
import { atLimit, COMPUTER_BACKEND, computerBackend } from "./computer.ts";
import type { SandboxEgressProps } from "./egress.ts";
import { computerOffNote, shellRefusal } from "./fallback.ts";
import { fileFailure } from "./files.ts";
import { guardedLoader } from "./loader.ts";

/**
 * A session's computer, as its Workspace runs commands on it and the session hands it the requests that come back
 * through `WorkspaceProxy` (computerd's connection, the computer's outbound requests). The test Worker's is a fake.
 */
export type ComputerBackend = WorkspaceBackend & {
  handleFetch(request: Request): Promise<Response>;
};

/** The binding the state Worker gives `SandboxSession`'s namespace; the Workspace's proxy finds the object through it. */
export const SANDBOX_SESSION_BINDING = "SANDBOX_SESSION";

/** What `SandboxSession` reads from the state Worker's env. */
export interface SandboxSessionEnv {
  /** Dynamic Workers (ADR 0043: every deployment has them), where just-bash runs. */
  readonly LOADER: WorkerLoader;
  /** Its own namespace, which the Workspace's proxy reaches it through ({@link SANDBOX_SESSION_BINDING}). */
  readonly SANDBOX_SESSION: DurableObjectNamespace;
  /**
   * The computer's instance size (#223), bound with its container (`COMMISSARY_COMPUTER_INSTANCE`); unset, or not one
   * of Cloudflare's sizes: `standard-1`.
   */
  readonly COMPUTER_INSTANCE?: string | undefined;
}

/** How long a closed session remembers that it was, so its owner hears it is closed rather than unknown. */
export const CLOSED_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** The key of the session's record in the object's storage. */
const RECORD = "sandbox:session";

/** What the object keeps of its session beside the Workspace. */
type SessionRecord =
  | ({
      readonly state: "open";
      readonly org: string;
      readonly owner: string;
      readonly policy: OutboundPolicy;
    } & StoredAllowance)
  | { readonly state: "closed"; readonly org: string; readonly owner: string };

/**
 * What an open session may have, as stored: a session opened before the computer (#223) has no `computer`, and may not
 * use it.
 */
type StoredAllowance = Omit<SandboxAllowance, "computer"> &
  Partial<Pick<SandboxAllowance, "computer">>;

type OpenRecord = Extract<SessionRecord, { state: "open" }>;

/** Who calls: the org and the principal, as the provider's adapter hands them over. */
export interface SessionCaller {
  readonly org: string;
  readonly owner: string;
  /** Epoch ms, the caller's clock. */
  readonly now: number;
}

/** An answer over RPC: the value, or why not (a `SandboxError`'s reason and message, as plain data). */
export type SessionReply<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: SandboxError["reason"]; readonly message: string };

const ok = <A>(value: A): SessionReply<A> => ({ ok: true, value });

const refused = <A>(reason: SandboxError["reason"], message = ""): SessionReply<A> => ({
  ok: false,
  reason,
  message,
});

/** What the Worker's main module exports, as `ctx.exports` holds it. */
interface SandboxExports {
  SandboxEgress(options: { readonly props: SandboxEgressProps }): Fetcher;
}

/**
 * Whether `exports` (`ctx.exports`) has the egress entrypoint: the Worker that binds `SANDBOX_SESSION` exports
 * `SandboxEgress` from its main module (the state Worker, apps/state/src/index.ts; the test Workers).
 */
const hasEgress = (exports: Cloudflare.Exports): exports is Cloudflare.Exports & SandboxExports =>
  "SandboxEgress" in exports && typeof exports.SandboxEgress === "function";

/** The parent directory of an absolute path. */
const parentOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf("/")));

/** A Workspace's cut of one stream, as the toolkit states it. */
const cutOf = (
  truncated:
    | {
        readonly totalLines: number;
        readonly firstLine: number;
        readonly partialLine: boolean;
        readonly status: "saved" | "not-saved";
        readonly path?: string;
      }
    | undefined,
): OutputCut | undefined => {
  if (truncated === undefined) return undefined;
  const kept = truncated.totalLines - truncated.firstLine + 1;

  return {
    totalLines: truncated.totalLines,
    firstLine: truncated.firstLine,
    partialLine: truncated.partialLine,
    // The kept part is cut to MAX_LINES lines or MAX_BYTES bytes, whichever comes first.
    limit: truncated.partialLine || kept < MAX_LINES ? "bytes" : "lines",
    savedAt: truncated.status === "saved" ? truncated.path : undefined,
  };
};

/** The words a session answers a computer's failure with. */
const computerFailure = (error: Error): string => {
  const limit = atLimit(error);

  return limit === undefined
    ? `The computer could not run the command: ${error.message}`
    : `${limit.message} Try again later.`;
};

/** Loads `@cloudflare/computer` and the parts of it a session uses, the first time a session needs them. */
const loadComputer = async () => {
  const [{ Workspace }, { WorkerShellBackend }, { default: curl }] = await Promise.all([
    import("@cloudflare/computer"),
    import("@cloudflare/computer/backends/worker-shell"),
    import("@cloudflare/computer/shell/curl"),
  ]);

  return { Workspace, WorkerShellBackend, curl };
};

export class SandboxSession extends DurableObject<SandboxSessionEnv> {
  #workspace: Promise<Workspace> | undefined;
  /** The commands running now, killed when the session closes. */
  readonly #running = new Set<{ kill(): Promise<void> }>();
  /** The Workspace stubs handed to the shell, disposed of when the session closes. */
  readonly #stubs = new Set<WorkspaceStub>();
  /** The session's computer, when its Workspace has one: it takes the computer's requests back (`fetch`). */
  #computer: ComputerBackend | undefined;

  /**
   * The object's state with the computer's container (`ctx.container`), or undefined when the deployment attached none
   * to this class. The test Worker's subclass hands one with a fake container.
   */
  protected containerState(): DurableObjectState | undefined {
    return this.ctx.container === undefined ? undefined : this.ctx;
  }

  /**
   * The computer's backend for this session, or undefined when the deployment has none. The test Worker's subclass
   * hands a fake one.
   */
  protected computerBackend(gateway: Fetcher): Promise<ComputerBackend> | undefined {
    const state = this.containerState();

    if (state === undefined) return undefined;

    return computerBackend({
      state,
      workspace: { binding: SANDBOX_SESSION_BINDING, id: this.ctx.id.toString() },
      gateway,
      instance: computerInstanceOf(this.env.COMPUTER_INSTANCE ?? "") ?? DEFAULT_COMPUTER_INSTANCE,
    });
  }

  /** Whether the deployment attached the computer's container to this class. */
  protected hasComputer(): boolean {
    return this.containerState() !== undefined;
  }

  /** Stops the session's computer, if one runs, before its files go: its copy of them goes with it. */
  protected async stopComputer(): Promise<void> {
    const container = this.containerState()?.container;

    if (container?.running === true) await container.destroy().catch(() => undefined);
  }

  /** computerd's connection and the computer's outbound requests, through `WorkspaceProxy`; nothing else is served. */
  override async fetch(request: Request): Promise<Response> {
    const computer = this.#computer;

    return computer === undefined
      ? new Response("not found", { status: 404 })
      : await computer.handleFetch(request);
  }

  #record(): SessionRecord | undefined {
    return this.ctx.storage.kv.get<SessionRecord>(RECORD);
  }

  /** The session's Workspace, made on first use: its shell's egress is the session's network. */
  #workspaceOf(record: OpenRecord): Promise<Workspace> {
    this.#workspace ??= this.#newWorkspace(record);

    return this.#workspace;
  }

  async #newWorkspace(record: OpenRecord): Promise<Workspace> {
    const { exports } = this.ctx;

    if (!hasEgress(exports)) throw new Error("the Worker exports no SandboxEgress entrypoint");
    const { Workspace, WorkerShellBackend, curl } = await loadComputer();

    const gateway = exports.SandboxEgress({
      props: { network: record.network, policy: record.policy },
    });

    // The computer, for a session that may use it on a deployment that has it: its requests leave through `gateway`
    // too.
    const computer = record.computer === true ? await this.computerBackend(gateway) : undefined;

    this.#computer = computer;

    // The one egress point (ADR 0044): the shell's every request leaves through `gateway`. The Workspace's `git`,
    // `assets` and `artifacts` stay unconfigured, and no command but `curl` is added: they would fetch from this object,
    // with the state Worker's own `fetch`, not through `SandboxEgress`.
    return new Workspace({
      storage: this.ctx.storage,
      // just-bash first: the first backend is the Workspace's default.
      backends: [
        new WorkerShellBackend({
          loader: guardedLoader(this.env.LOADER, gateway),
          workspace: { binding: SANDBOX_SESSION_BINDING, id: this.ctx.id.toString() },
          ctx: this.ctx,
          commands: [curl],
          // A session's network never changes, so one Dynamic Worker per session serves it.
          egress: { mode: "http-gateway", gateway, revision: "session" },
        }),
        ...(computer === undefined ? [] : [computer]),
      ],
      // As pi cuts a command's output; the whole is saved in the Workspace, where the model can read it.
      output: { maxLines: MAX_LINES, maxBytes: MAX_BYTES },
    });
  }

  /** The caller's open session, or why there is none: another org's or owner's is unknown. */
  async #session(caller: SessionCaller): Promise<SessionReply<OpenRecord>> {
    const record = this.#record();

    if (record === undefined || record.org !== caller.org || record.owner !== caller.owner)
      return refused("unknown_session");

    if (record.state === "closed") return refused("closed");
    // A call is a use: the session stays a day from now.
    await this.ctx.storage.setAlarm(caller.now + SESSION_IDLE_MS);

    return ok(record);
  }

  /** Whether the session is still open: a call that waited may find it closed or purged since. */
  #stillOpen(): boolean {
    return this.#record()?.state === "open";
  }

  /** The Workspace for the Dynamic Worker's shell (`WorkspaceServiceProxy`): an open session's only. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    const record = this.#record();

    if (record?.state !== "open") throw new Error("the sandbox session is closed");
    const workspace = await this.#workspaceOf(record);

    await workspace.ready();

    if (!this.#stillOpen()) throw new Error("the sandbox session is closed");
    const stub = workspace.stub();

    this.#stubs.add(stub);

    return stub;
  }

  /**
   * Opens the session for `caller`, with what it may have (its network, and the computer when the deployment has one)
   * and the outbound guard's `policy`; a used object is refused.
   */
  async open(
    caller: SessionCaller,
    { network, computer }: SandboxAllowance,
    policy: OutboundPolicy,
  ): Promise<SessionReply<null>> {
    if (this.#record() !== undefined) return refused("unavailable", "the session id is taken");

    const record: OpenRecord = {
      state: "open",
      org: caller.org,
      owner: caller.owner,
      network,
      computer,
      policy,
    };

    this.ctx.storage.kv.put(RECORD, record);
    await this.ctx.storage.setAlarm(caller.now + SESSION_IDLE_MS);
    await (await this.#workspaceOf(record)).fs.mkdir(SANDBOX_HOME, { recursive: true });

    return ok(null);
  }

  async run(
    caller: SessionCaller,
    command: string,
    timeoutMs: number,
  ): Promise<SessionReply<CommandResult>> {
    const session = await this.#session(caller);

    if (!session.ok) return session;

    // The fallback rule (`fallback.ts`): decided before the line runs, so a line just-bash runs is never run again.
    const refusal = await shellRefusal(command);
    let onComputer = false;

    try {
      const workspace = await this.#workspaceOf(session.value);

      onComputer = refusal !== undefined && this.#computer !== undefined;

      const handle = await workspace.runtime.exec(command, {
        encoding: "utf8",
        cwd: SANDBOX_HOME,
        timeoutMs,
        ...(onComputer ? { backend: COMPUTER_BACKEND } : {}),
      });

      this.#running.add(handle);

      try {
        const result = await handle.result();

        if (!this.#stillOpen()) return refused("closed");

        return ok({
          exitCode: result.exitCode,
          stdout: { text: result.stdout, cut: cutOf(result.truncated?.stdout) },
          stderr: { text: result.stderr, cut: cutOf(result.truncated?.stderr) },
          // Only a failed run: a line that tests for a command and copes without it needs no note.
          ...(refusal === undefined || onComputer || result.exitCode === 0
            ? {}
            : { note: computerOffNote(refusal, this.hasComputer()) }),
        });
      } finally {
        this.#running.delete(handle);
        handle[Symbol.dispose]();
      }
    } catch (error) {
      if (!this.#stillOpen()) return refused("closed");
      const failure = error instanceof Error ? error : new Error(String(error));

      return refused(
        "unavailable",
        onComputer
          ? computerFailure(failure)
          : `The sandbox could not run the command: ${failure.message}`,
      );
    }
  }

  async readFile(caller: SessionCaller, path: string): Promise<SessionReply<string>> {
    const session = await this.#session(caller);

    if (!session.ok) return session;

    try {
      return ok(await (await this.#workspaceOf(session.value)).fs.readFile(path, "utf8"));
    } catch (error) {
      return fileFailure(error instanceof Error ? error : new Error(String(error)), path, "read");
    }
  }

  async writeFile(caller: SessionCaller, path: string, text: string): Promise<SessionReply<null>> {
    const session = await this.#session(caller);

    if (!session.ok) return session;

    try {
      const { fs } = await this.#workspaceOf(session.value);

      await fs.mkdir(parentOf(path), { recursive: true });
      await fs.writeFile(path, text);

      return ok(null);
    } catch (error) {
      return fileFailure(error instanceof Error ? error : new Error(String(error)), path, "write");
    }
  }

  async list(
    caller: SessionCaller,
    path: string,
  ): Promise<SessionReply<ReadonlyArray<DirectoryEntry>>> {
    const session = await this.#session(caller);

    if (!session.ok) return session;

    try {
      const entries = await (await this.#workspaceOf(session.value)).fs.readdir(path);

      return ok(entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory })));
    } catch (error) {
      return fileFailure(error instanceof Error ? error : new Error(String(error)), path, "list");
    }
  }

  async close(caller: SessionCaller): Promise<SessionReply<null>> {
    const session = await this.#session(caller);

    if (!session.ok) return session;
    await this.#forget(session.value, caller.now);

    return ok(null);
  }

  /**
   * Deletes the session and everything of it, with no note that it was, whoever's it is: its owner left `org`, or `org`
   * is being deleted (ADR 0027). Another org's session is left alone; one that is gone already is done.
   */
  async purge(org: string): Promise<SessionReply<null>> {
    const record = this.#record();

    if (record !== undefined && record.org !== org) return refused("unknown_session");
    await this.#stop();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    return ok(null);
  }

  /** A day without a call closes the session; a week after that, the note that it was goes too. */
  override async alarm(): Promise<void> {
    const record = this.#record();

    if (record?.state === "open") await this.#forget(record, Date.now());
    else await this.ctx.storage.deleteAll();
  }

  /**
   * Stops what still uses the Workspace before its files are deleted, so nothing writes them back: the running
   * commands are killed, the stubs the shell holds are disposed of, and the Workspace is closed.
   */
  async #stop(): Promise<void> {
    const running = [...this.#running];
    const stubs = [...this.#stubs];
    const workspace = this.#workspace;

    this.#running.clear();
    this.#stubs.clear();
    this.#workspace = undefined;
    this.#computer = undefined;

    await Promise.allSettled(running.map(async (handle) => await handle.kill()));

    for (const stub of stubs) stub[Symbol.dispose]();

    if (workspace !== undefined)
      await workspace.then(
        async (opened) => await opened.close(),
        () => undefined,
      );

    await this.stopComputer();
  }

  /** Deletes the session's files and everything else the object holds, keeping only a note that it was closed. */
  async #forget(record: SessionRecord, now: number): Promise<void> {
    // The note goes first, so a call that waits while the rest is deleted finds the session closed.
    this.ctx.storage.kv.put(RECORD, { state: "closed", org: record.org, owner: record.owner });
    await this.#stop();
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(RECORD, { state: "closed", org: record.org, owner: record.owner });
    await this.ctx.storage.setAlarm(now + CLOSED_KEPT_MS);
  }
}

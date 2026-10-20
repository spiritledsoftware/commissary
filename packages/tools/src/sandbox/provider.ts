/**
 * The sandbox-provider interface (ADR 0041, #222): the service behind a sandbox toolkit, reached only through it, as a
 * browser provider is behind the browser toolkit (`../browser/provider.ts`). It covers what the sandbox tools need:
 * open a session with a network, run a command, read, write and list files, and close it. Cloudflare's sandbox
 * (`cloudflare/`, `@cloudflare/computer` with just-bash) is the one provider built; another (Daytona, E2B, Modal, Vercel
 * Sandbox) is a new adapter behind the same interface, with the org's or a member's key for it as the toolkit's
 * credential, serving the same tools (`toolkit.ts`).
 *
 * A session belongs to one principal in one org ({@link SandboxOwner}): a client's member or API key, or later one agent
 * run (#230). A call with another owner's session id is answered as one with an id that does not exist
 * (`unknown_session`), and a session never crosses orgs. A session the provider closed (on `sandbox_close`, or idle for
 * a day) answers `closed` to its owner for a while (Cloudflare's: a week), and then `unknown_session`.
 */
import type { OutboundPolicy } from "@commissary/core";
import { type Effect, Schema } from "effect";
import type { SandboxAllowance } from "./network.ts";

/** Who a sandbox session belongs to: a principal (`user:<email>`, `key:<id>`, later an agent run) in one org. */
export interface SandboxOwner {
  readonly org: string;
  readonly principal: string;
}

/**
 * What a session is opened with: what it may have (its network, and the computer when the provider has one, {@link
 * SandboxProvider.computer}), the outbound guard's policy its egress applies, and the time.
 */
export interface OpenSandbox extends SandboxAllowance {
  readonly policy: OutboundPolicy;
  /** Epoch ms, the caller's clock: the session is idle from then. */
  readonly now: number;
}

/**
 * How a provider cut a stream of a command's output, keeping its end, as pi's bash tool states a cut: the lines kept,
 * the limit that cut them, whether the kept part starts partway through a line and, when it saved the whole, where.
 */
export interface OutputCut {
  /** Lines in the whole output. */
  readonly totalLines: number;
  /** One-based number of the first line kept. */
  readonly firstLine: number;
  /** Whether the kept part starts partway through its first line (a line longer than the byte limit). */
  readonly partialLine: boolean;
  /** The limit that cut it: the most lines, or the most bytes (`truncate.ts`). */
  readonly limit: "lines" | "bytes";
  /** A sandbox file holding the whole output, when the provider saved it. */
  readonly savedAt?: string | undefined;
}

/**
 * One stream of a command's output. A provider that cut it itself says so in `cut`; one that did not hands it over
 * whole, and the toolkit cuts it.
 */
export interface CommandOutput {
  readonly text: string;
  readonly cut?: OutputCut | undefined;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: CommandOutput;
  readonly stderr: CommandOutput;
  /**
   * What the provider says about how it ran the command, told to the model after its output: Cloudflare's, that its
   * shell could not run it and the session's computer is off (#223).
   */
  readonly note?: string | undefined;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
}

/**
 * What a sandbox could not do. `unknown_session`: no session of the caller's has that id; `closed`: the caller's
 * session is closed; `file`: a file operation failed (`message` says why: a missing file, a directory, the storage
 * limit); `unavailable`: the provider could not be reached. `message` is told to the model, never a secret.
 */
export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  reason: Schema.Literals(["unknown_session", "closed", "file", "unavailable"]),
  message: Schema.String,
}) {}

/** What a provider's operation answers. */
type Sandboxed<A> = Effect.Effect<A, SandboxError>;

/** The service behind a sandbox toolkit, reached only through this interface. */
export interface SandboxProvider {
  /** Which provider it is: the sandbox toolkit's source (`cloudflare`). */
  readonly id: string;
  /**
   * Whether its sessions may be given a computer (#223): Cloudflare's sandbox, when the deployment has the container
   * (ADR 0043). Without one, "may use the computer" cannot be turned on. Another provider runs every command on its own
   * machine and has none.
   */
  readonly computer: boolean;
  /** Opens a session of `owner`'s; answers its id. */
  readonly open: (owner: SandboxOwner, options: OpenSandbox) => Sandboxed<string>;
  /** Runs `command` (a shell command line) in the session's working directory. */
  readonly run: (
    owner: SandboxOwner,
    session: string,
    command: { readonly command: string; readonly timeoutMs: number; readonly now: number },
  ) => Sandboxed<CommandResult>;
  /** A file's text (UTF-8). */
  readonly readFile: (
    owner: SandboxOwner,
    session: string,
    path: string,
    now: number,
  ) => Sandboxed<string>;
  /** Writes a file's text, creating its directories. */
  readonly writeFile: (
    owner: SandboxOwner,
    session: string,
    path: string,
    text: string,
    now: number,
  ) => Sandboxed<void>;
  /** A directory's entries. */
  readonly list: (
    owner: SandboxOwner,
    session: string,
    path: string,
    now: number,
  ) => Sandboxed<ReadonlyArray<DirectoryEntry>>;
  /** Closes the session and deletes its files at once. */
  readonly close: (owner: SandboxOwner, session: string, now: number) => Sandboxed<void>;
  /**
   * Deletes the session `session` of `org` and everything of it at once, whoever's it is and whatever its state, with
   * no note that it was: its owner left the org, or the org is being deleted (ADR 0027). Done for a session that no
   * longer exists.
   */
  readonly purge: (org: string, session: string) => Sandboxed<void>;
}

/** How long a session lasts without a call: a day (ADR 0041). */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

/** The working directory of every session, where relative paths resolve. */
export const SANDBOX_HOME = "/workspace";

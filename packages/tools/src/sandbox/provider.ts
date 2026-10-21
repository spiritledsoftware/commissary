/**
 * The sandbox-provider interface (ADR 0041, #222): the service behind a sandbox toolkit, reached only through it, as a
 * browser provider is behind the browser toolkit (`../browser/provider.ts`). It covers what the sandbox tools need:
 * open a session with a network, run a command, read, write and list files, and close it. Cloudflare's sandbox
 * (`cloudflare/`, `@cloudflare/computer` with just-bash) is the one provider built; another (Daytona, E2B, Modal,
 * Vercel Sandbox) is a new adapter behind the same interface, with the org's or a member's key for it as the toolkit's
 * credential, serving the same tools (`toolkit.ts`).
 *
 * A session belongs to one principal in one org ({@link SandboxOwner}): a client's member or API key, or one agent run
 * (#230), whose own session lasts as long as the run ({@link OpenSandbox.untilPurged}). A call with another owner's
 * session id is answered as one with an id that does not exist (`unknown_session`), and a session never crosses orgs.
 * A session the provider closed (on `sandbox_close`, or idle for a day) answers `closed` to its owner for a while
 * (Cloudflare's: a week), and then `unknown_session`.
 */
import type { UsageRun } from "@commissary/auth";
import type { OutboundPolicy } from "@commissary/core";
import { type Effect, Schema } from "effect";
import type { SandboxAllowance } from "./network.ts";

/** Who a sandbox session belongs to: a principal (`user:<email>`, `key:<id>`, an agent run's `run:<id>`) in one org. */
export interface SandboxOwner {
  readonly org: string;
  readonly principal: string;
}

/**
 * Computer time (#224, ADR 0041): how long a session's computer ran, in ms, and what that cost at the sandbox toolkit's
 * price per computer hour, in micro-USD (0 without one). just-bash's time is not metered.
 */
export interface ComputerTime {
  readonly computerMs: number;
  readonly costMicros: number;
}

/** Two stretches of computer time together; either may be none. */
export const addedTime = (
  a: ComputerTime | undefined,
  b: ComputerTime | undefined,
): ComputerTime | undefined =>
  a === undefined || b === undefined
    ? (a ?? b)
    : { computerMs: a.computerMs + b.computerMs, costMicros: a.costMicros + b.costMicros };

/**
 * What the Tools part passes with each call of a session about its computer time (#224): the sandbox toolkit's price
 * per computer hour from the call on, and whether a Spend limit the computer's time counts toward has no room. A
 * session meters its computer from the command that starts it to its last command and its idle minutes, or to when it
 * stops it, answers each call its computer time since the call before ({@link Metered}), and writes one usage record of
 * it when it closes. A provider without a computer meters nothing.
 */
export interface ComputerMeter {
  /** The price per computer hour from this call on, in micro-USD; 0: the computer's time is free. */
  readonly hourPriceMicros: number;
  /**
   * A Spend limit the computer's time counts toward has no room: a running computer is stopped and the call goes on
   * (`computerStopped`), and a command that would run on the computer is refused (`reason` `refused`).
   */
  readonly limitReached: boolean;
}

/** Who opened a session, as its usage record of computer time names them (#224): the toolkit, member and agent run. */
export interface SessionOpener {
  readonly toolkitId: string;
  readonly member?: string | undefined;
  /** The agent run (#228) that opened it. */
  readonly run?: UsageRun | undefined;
}

/**
 * An operation's answer, with the session's computer time since the call before when it was metered (#224), and
 * whether the call stopped the session's running computer for want of room ({@link ComputerMeter.limitReached}).
 */
export interface Metered<A> {
  readonly value: A;
  readonly computerTime?: ComputerTime | undefined;
  readonly computerStopped?: true | undefined;
}

/**
 * How long a provider may take to report the close of a session it closed for want of use, or computer time it metered
 * with no call to answer it (#224): every provider reports within this time or not at all, and the Tools part forgets
 * a session it heard nothing of once it passed.
 */
export const CLOSE_REPORT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What a session is opened with: what it may have (its network, and the computer when the provider has one, {@link
 * SandboxProvider.computer}), the outbound guard's policy its egress applies, and the time; and, from a Tools part from
 * #224 on, its computer time's metering and who opened it.
 */
export interface OpenSandbox extends SandboxAllowance {
  readonly policy: OutboundPolicy;
  /** Epoch ms, the caller's clock: the session is idle from then. */
  readonly now: number;
  /** Its computer time's metering (#224); absent, as from a part before it: the session meters nothing. */
  readonly meter?: ComputerMeter | undefined;
  readonly opener?: SessionOpener | undefined;
  /**
   * The session lasts until it is closed or purged, however long it goes without a call: an agent run's own (#230, ADR
   * 0041, the one its harness opens), which lives as long as the run and is purged with it. Otherwise a day without a
   * call ends it.
   */
  readonly untilPurged?: boolean | undefined;
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

/** What a path is: its kind, its size in bytes and when it was last modified (epoch ms). */
export interface FileStat {
  readonly kind: "file" | "directory" | "symlink";
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * What a sandbox could not do. `unknown_session`: no session of the caller's has that id; `closed`: the caller's
 * session is closed; `file`: a file operation failed (`message` says why: a missing file, a directory, the storage
 * limit); `unavailable`: the provider could not be reached; `refused`: a Spend limit the computer's time counts toward
 * has no room (#224, {@link ComputerMeter.limitReached}): the command would have run on the computer. `message` is
 * told to the model, never a secret. A metered call's failure carries the session's computer time since the call
 * before, and whether it stopped a running computer, as its answer would (#224).
 */
export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  reason: Schema.Literals(["unknown_session", "closed", "file", "unavailable", "refused"]),
  message: Schema.String,
  computerStopped: Schema.optionalKey(Schema.Literal(true)),
  computerTime: Schema.optionalKey(
    Schema.Struct({ computerMs: Schema.Number, costMicros: Schema.Number }),
  ),
}) {}

/** What a provider's operation answers. */
type Sandboxed<A> = Effect.Effect<A, SandboxError>;

/** What a provider's operation on a session answers: its value, with the session's computer time (#224). */
type MeteredSandboxed<A> = Sandboxed<Metered<A>>;

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
  /**
   * Runs `command` (a shell command line) in the session's working directory. Each operation on a session takes its
   * computer time's metering last (#224, {@link ComputerMeter}); without it, it meters nothing.
   */
  readonly run: (
    owner: SandboxOwner,
    session: string,
    command: { readonly command: string; readonly timeoutMs: number; readonly now: number },
    meter?: ComputerMeter,
  ) => MeteredSandboxed<CommandResult>;
  /** A file's text (UTF-8). */
  readonly readFile: (
    owner: SandboxOwner,
    session: string,
    path: string,
    now: number,
    meter?: ComputerMeter,
  ) => MeteredSandboxed<string>;
  /** What a path is (#230: an agent run's coding tools), or `null` when nothing is there. */
  readonly stat: (
    owner: SandboxOwner,
    session: string,
    path: string,
    now: number,
    meter?: ComputerMeter,
  ) => MeteredSandboxed<FileStat | null>;
  /** Up to `length` bytes of a file from `offset` (#230); fewer only at its end. */
  readonly readBytes: (
    owner: SandboxOwner,
    session: string,
    path: string,
    range: { readonly offset: number; readonly length: number },
    now: number,
    meter?: ComputerMeter,
  ) => MeteredSandboxed<Uint8Array>;
  /** Writes a file's text, creating its directories. */
  readonly writeFile: (
    owner: SandboxOwner,
    session: string,
    path: string,
    text: string,
    now: number,
    meter?: ComputerMeter,
  ) => MeteredSandboxed<void>;
  /** A directory's entries. */
  readonly list: (
    owner: SandboxOwner,
    session: string,
    path: string,
    now: number,
    meter?: ComputerMeter,
  ) => MeteredSandboxed<ReadonlyArray<DirectoryEntry>>;
  /** Closes the session and deletes its files at once. */
  readonly close: (
    owner: SandboxOwner,
    session: string,
    now: number,
    meter?: ComputerMeter,
  ) => MeteredSandboxed<void>;
  /**
   * Stops the session's computer, if it runs, as a Spend limit its time counts toward has no room (#224): the Tools part
   * refused a call of a priced tool in it, or a priced `sandbox_close`. Answers whether one ran, with its last stretch.
   * Done for a session that is gone, or has no computer.
   */
  readonly stopComputer: (
    owner: SandboxOwner,
    session: string,
    now: number,
    meter: ComputerMeter,
  ) => MeteredSandboxed<boolean>;
  /**
   * Deletes the session `session` of `org` and everything of it at once, whoever's it is and whatever its state, with
   * no note that it was: its owner left the org, or the org is being deleted (ADR 0027). Done for a session that no
   * longer exists. When its owner left (`settle`, #224), it first settles as a close does: its usage record is written,
   * and its computer time no call charged is answered, for the Tools part to charge.
   */
  readonly purge: (org: string, session: string, settle?: boolean) => MeteredSandboxed<void>;
}

/**
 * How long a session lasts without a call: a day (ADR 0041), but for an agent run's own
 * ({@link OpenSandbox.untilPurged}).
 */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

/** The working directory of every session, where relative paths resolve. */
export const SANDBOX_HOME = "/workspace";

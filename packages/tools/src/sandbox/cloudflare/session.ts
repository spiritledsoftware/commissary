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
 * closed; after that week they answer that it is unknown. `purge` deletes it with no note: the org is being deleted, or
 * its owner left (then it first settles as a close does, #224). Commissary sets no limits of its own on it: the Durable Object's storage limit applies, and a
 * write past it is an error that says so.
 *
 * **The computer** (#223, `computer.ts`): a session that may use it, on a deployment that attached the computer's
 * container to this class (`ctx.container`), has a second backend in its Workspace. A command goes there only when
 * just-bash cannot run it at all (`fallback.ts`, decided before it runs); in a session without the computer, such a
 * command runs on just-bash, whose error it answers with a note that the computer is off. The computer's outbound
 * requests come back to this object (`fetch`, through `WorkspaceProxy`), which hands them to the same egress point.
 *
 * **Computer time** (#224, `computer-time.ts`). A session opened by a Tools part from #224 on meters its computer, from
 * the command that starts it to its last command and its idle minutes, or to when the session stops it, at the sandbox
 * toolkit's price per computer hour, which each call passes ({@link SessionMetering}): every call answers the time since
 * the call before and its cost, which the Tools part charges to the Spend limits it counts toward. When the computer
 * stops by itself, its idle minutes over, no call may come for a day, so the object's alarm meters that run then and
 * reports its cost to the org's ControlPlane (`sandboxComputerTime`), tried again until it goes through or a call
 * answers it. A call that passes `limitReached` (a limit has no room) stops a running computer quietly and goes on,
 * saying so (`computerStopped`); only a command that would run on the computer is refused (`#stopForLimit`). When the
 * session closes it writes one usage record of its computer time and cost (`insertSessionRecord`); when its alarm closed
 * it, no call is there to charge what is left, so it reports the close with that cost. A record or report that fails is
 * kept in its closed note and tried again from the alarm (`usage/session-close.ts`) until the note goes. A session
 * opened before #224 meters nothing and writes no record.
 *
 * **Deploys** (docs/DEVELOPMENT.md, "State RPC: expand, then contract"): the metering is an optional last argument of
 * the object's calls, and its answers only add `computerTime`; a Tools part from before passes none, and its sessions
 * meter nothing.
 */
import { DurableObject } from "cloudflare:workers";
import type { Workspace, WorkspaceBackend, WorkspaceStub } from "@cloudflare/computer";
import { Clock } from "effect";
import {
  computerInstanceOf,
  DEFAULT_COMPUTER_INSTANCE,
  type OrgId,
  type OutboundPolicy,
} from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import type { ToolsControlPlane } from "../../env.ts";
import { insertSessionRecord, type SessionRecord } from "../../usage/record.ts";
import {
  forgottenUnsettled,
  remaining,
  SETTLE_RETRY_MS,
  sessionIdOf,
  settleClose,
  type Unsettled,
} from "../../usage/session-close.ts";
import type { SandboxAllowance } from "../network.ts";
import { MAX_BYTES, MAX_LINES } from "../truncate.ts";
import {
  addedTime,
  CLOSE_REPORT_MS,
  type CommandResult,
  type ComputerTime,
  type DirectoryEntry,
  type OutputCut,
  SANDBOX_HOME,
  type SandboxError,
  type SessionOpener,
  SESSION_IDLE_MS,
} from "../provider.ts";
import { atLimit, COMPUTER_BACKEND, computerBackend } from "./computer.ts";
import {
  type ComputerMetering,
  computerNotStarted,
  computerRuns,
  computerStarted,
  computerStopped,
  computerUsed,
  computerEndsAt,
  meterComputer,
} from "./computer-time.ts";
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
  /** The usage database, which a closing session writes its record of computer time into (#224). */
  readonly USAGE: D1Database;
  /** The orgs' ControlPlanes, whose Tools part hears of the computer time a session's alarm meters, and charges it (#224). */
  readonly CONTROL_PLANE: DurableObjectNamespace<ToolsControlPlane>;
}

/** The key of the session's record in the object's storage. */
const RECORD = "sandbox:session";

/**
 * What the object keeps of its session beside the Workspace: while it is open, its computer time's metering when a
 * Tools part from #224 on opened it; once closed, a note, with its usage record and the cost it reports while either is
 * left to do (#224).
 */
type StoredSession =
  | ({
      readonly state: "open";
      readonly org: string;
      readonly owner: string;
      readonly policy: OutboundPolicy;
      readonly metering?: ComputerMetering | undefined;
      /** When it closes unless a call comes first: a day after the last (absent before #224: its alarm is then). */
      readonly idleAt?: number | undefined;
    } & StoredAllowance)
  | ClosedNote;

/**
 * A closed session's note, kept for {@link CLOSE_REPORT_MS}, so its owner hears it is closed rather than unknown: when
 * it closed (absent before #224), and what of its close is left to do: its usage record while it is not written, and
 * the cost its alarm's close reports while it is not reported.
 */
interface ClosedNote {
  readonly state: "closed";
  readonly org: string;
  readonly owner: string;
  readonly closedAt?: number | undefined;
  readonly record?: SessionRecord | undefined;
  readonly owed?: number | undefined;
}

/** What of a closed session's close is left to do, as `settleClose` takes it. */
const unsettledOf = (note: ClosedNote): Unsettled => ({
  ...(note.record === undefined ? {} : { unrecorded: true }),
  ...(note.owed === undefined ? {} : { owed: note.owed }),
});

/**
 * What an open session may have, as stored: a session opened before the computer (#223) has no `computer`, and may not
 * use it.
 */
type StoredAllowance = Omit<SandboxAllowance, "computer"> &
  Partial<Pick<SandboxAllowance, "computer">>;

type OpenRecord = Extract<StoredSession, { state: "open" }>;

/** Who calls: the org and the principal, as the provider's adapter hands them over. */
export interface SessionCaller {
  readonly org: string;
  readonly owner: string;
  /** Epoch ms, the caller's clock. */
  readonly now: number;
}

/**
 * What a Tools part from #224 on passes with each call (absent: a part from before, whose calls meter nothing): the
 * sandbox toolkit's price per computer hour from the call on (a close costs its last stretch at the price in force
 * before it), and whether a Spend limit the computer's time counts toward has no room. Opening, it passes who opens
 * too (`SessionOpener`), which the usage record names.
 */
export interface SessionMetering {
  readonly hourPriceMicros: number;
  readonly limitReached?: boolean | undefined;
}

/**
 * An answer over RPC: the value, or why not (a `SandboxError`'s reason and message, as plain data); to a metered call,
 * with the session's computer time since the call before (#224), and whether the call stopped a running computer for
 * want of room (`computerStopped`).
 */
export type SessionReply<A> = (
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: SandboxError["reason"]; readonly message: string }
) & {
  readonly computerTime?: ComputerTime | undefined;
  readonly computerStopped?: true | undefined;
};

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

/** What a command that would run on the computer answers once a Spend limit its time counts toward has no room. */
const COMPUTER_REFUSED =
  "The computer cannot run this command: a Spend limit its time counts toward is reached. Commands just-bash can run still run.";

export class SandboxSession extends DurableObject<SandboxSessionEnv> {
  #workspace: Promise<Workspace> | undefined;
  /** The commands running now, killed when the session closes. */
  readonly #running = new Set<{ kill(): Promise<void> }>();
  /** The Workspace stubs handed to the shell, disposed of when the session closes. */
  readonly #stubs = new Set<WorkspaceStub>();
  /** The session's computer, when its Workspace has one: it takes the computer's requests back (`fetch`). */
  #computer: ComputerBackend | undefined;
  /** How many commands run on the computer now, which keep it running (#224); none after the object restarts. */
  #onComputer = 0;
  /** What the object reads the time from for its computer time (#224): the live clock, or a test's (`useClock`). */
  #clock: Clock.Clock = Clock.Clock.defaultValue();
  /**
   * The alarm's report of computer time no call charged while it is in flight (#224): a close waits for it, so the
   * report finds the session still kept by the Tools part, and what it could not report is in what the close charges.
   */
  #reporting: Promise<void> | undefined;

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

  /**
   * The ControlPlane of the session's org, which hears of its alarm's closes (#224; a test's subclass reaches its own).
   */
  protected controlPlane(org: string): DurableObjectStub<ToolsControlPlane> {
    // SAFETY: a session's org is the org id of the ControlPlane whose Tools part opened it.
    return controlPlaneOf(this.env, org as OrgId);
  }

  /** Writes the usage record of a session (#224; a test's subclass may fail it). */
  protected writeRecord(record: SessionRecord): Promise<void> {
    return insertSessionRecord(this.env.USAGE, record);
  }

  /**
   * Makes the object read the time of its computer from `clock` (a test's `TestClock`). In the object's isolate only.
   */
  useClock(clock: Clock.Clock): void {
    this.#clock = clock;
  }

  #now(): number {
    return this.#clock.currentTimeMillisUnsafe();
  }

  /** computerd's connection and the computer's outbound requests, through `WorkspaceProxy`; nothing else is served. */
  override async fetch(request: Request): Promise<Response> {
    const computer = this.#computer;

    return computer === undefined
      ? new Response("not found", { status: 404 })
      : await computer.handleFetch(request);
  }

  #record(): StoredSession | undefined {
    return this.ctx.storage.kv.get<StoredSession>(RECORD);
  }

  /** Changes the open session's computer time's metering (#224), when it has one; a closed session's stays as it is. */
  #meter(change: (metering: ComputerMetering) => ComputerMetering): void {
    const record = this.#record();

    if (record?.state === "open" && record.metering !== undefined)
      this.ctx.storage.kv.put(RECORD, { ...record, metering: change(record.metering) });
  }

  /**
   * `reply`, to a metered call of an open session opened by a Tools part from #224 on, with its computer time since the
   * call before at the price in force since then, and `metering`'s price from now on.
   */
  #answer<A>(reply: SessionReply<A>, metering: SessionMetering | undefined): SessionReply<A> {
    const record = this.#record();

    if (metering === undefined || record?.state !== "open" || record.metering === undefined)
      return reply;

    const metered = meterComputer(record.metering, this.#now(), {
      busy: this.#onComputer > 0,
      hourPriceMicros: metering.hourPriceMicros,
    });

    // What the alarm metered and could not report yet goes with this answer.
    const { owed } = record.metering;

    this.ctx.storage.kv.put(RECORD, {
      ...record,
      metering: { ...metered.metering, owed: undefined },
    });

    return { ...reply, computerTime: addedTime(metered.time, owed) ?? metered.time };
  }

  /**
   * Stops the session's running computer once a Spend limit its time counts toward has no room (#224, `limitReached`):
   * quietly, its last stretch answered by the call, which goes on; answers whether it ran. A command that would start
   * the computer is refused in `run`. The one place that decides what a call meeting a running computer does then.
   */
  async #stopForLimit(metering: SessionMetering | undefined): Promise<boolean> {
    const record = this.#record();
    const now = this.#now();
    const busy = this.#onComputer > 0;

    if (
      metering?.limitReached !== true ||
      record?.state !== "open" ||
      record.metering === undefined ||
      !computerRuns(record.metering, now, busy)
    )
      return false;

    this.#meter((current) => computerStopped(current, now, busy));
    await this.stopComputer();

    return true;
  }

  /**
   * Runs a call of the caller's open session: `body`'s answer, with the session's computer time to a metered call, and
   * whether the call first stopped the computer for want of room (`#stopForLimit`).
   */
  async #call<A>(
    caller: SessionCaller,
    metering: SessionMetering | undefined,
    body: (record: OpenRecord) => Promise<SessionReply<A>>,
  ): Promise<SessionReply<A>> {
    const session = await this.#session(caller);

    if (!session.ok) return session;
    const stopped = await this.#stopForLimit(metering);
    const reply = await body(session.value);

    return this.#answer(stopped ? { ...reply, computerStopped: true } : reply, metering);
  }

  /**
   * Sets the object's alarm for the first thing it has to do (#224): close the session when it has been idle a day,
   * meter the computer's run when its idle minutes are over (a command on it sets it again when it ends), or try again
   * to report what it metered. A session from before #224 knows only the first, which its call set.
   */
  async #schedule(): Promise<void> {
    const record = this.#record();

    if (record?.state !== "open" || record.idleAt === undefined) return;
    const { metering } = record;

    const due = [
      record.idleAt,
      ...(metering === undefined ? [] : [computerEndsAt(metering, this.#onComputer > 0)]),
      ...(metering?.owed === undefined ? [] : [this.#now() + SETTLE_RETRY_MS]),
    ].filter((at) => at !== undefined);

    await this.ctx.storage.setAlarm(Math.min(...due));
  }

  /**
   * Meters the computer's run once its idle minutes are over, as no call may come to answer it (#224), and reports what
   * is owed to the org's ControlPlane, which charges it; what it could not report stays owed, for the next call to
   * answer or the next alarm to report.
   */
  async #meterStopped(record: OpenRecord): Promise<void> {
    const { metering } = record;

    if (metering === undefined) return;
    const now = this.#now();
    const busy = this.#onComputer > 0;
    let current = metering;

    if (
      !computerRuns(metering, now, busy) &&
      (metering.running !== undefined || metering.pendingMs > 0)
    ) {
      const metered = meterComputer(metering, now, {
        busy,
        hourPriceMicros: metering.hourPriceMicros,
      });

      current = { ...metered.metering, owed: addedTime(metering.owed, metered.time) };
    }

    const { owed } = current;

    // Taken off before the report, so a call meanwhile does not answer it too.
    this.ctx.storage.kv.put(RECORD, { ...record, metering: { ...current, owed: undefined } });

    if (owed === undefined || owed.costMicros <= 0) return;
    const reporting = this.#report(record.org, owed);

    this.#reporting = reporting;

    try {
      await reporting;
    } finally {
      if (this.#reporting === reporting) this.#reporting = undefined;
    }
  }

  /** Reports `owed` to `org`'s ControlPlane (`#meterStopped`); what it could not report is owed again. */
  async #report(org: string, owed: ComputerTime): Promise<void> {
    const reported = await settleClose(
      { owed: owed.costMicros },
      {
        what: "sandbox session computer time",
        record: async () => {},
        report: (costMicros) =>
          this.controlPlane(org).tools().sandboxComputerTime(this.#nameId(), costMicros, false),
      },
    );

    if (reported.reported) return;

    // Not reported: owed again, wherever the session is now.
    const after = this.#record();

    if (after?.state === "open" && after.metering !== undefined)
      this.ctx.storage.kv.put(RECORD, {
        ...after,
        metering: { ...after.metering, owed: addedTime(after.metering.owed, owed) },
      });
    else if (after?.state === "closed")
      this.ctx.storage.kv.put(RECORD, { ...after, owed: (after.owed ?? 0) + owed.costMicros });
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

  /**
   * The caller's open session, or why there is none: another org's or owner's is unknown. A call is a use, unless
   * `use` is false: the session stays a day from now.
   */
  async #session(caller: SessionCaller, use = true): Promise<SessionReply<OpenRecord>> {
    const record = this.#record();

    if (record === undefined || record.org !== caller.org || record.owner !== caller.owner)
      return refused("unknown_session");

    if (record.state === "closed") return refused("closed");

    if (!use) return ok(record);

    const used = { ...record, idleAt: caller.now + SESSION_IDLE_MS };

    this.ctx.storage.kv.put(RECORD, used);
    await this.#schedule();

    return ok(used);
  }

  /**
   * The open session once the alarm's report in flight, if any, is done (#224), read again, so that what the report
   * could not report is in it; `undefined` when it closed or went meanwhile.
   */
  async #reported(): Promise<OpenRecord | undefined> {
    await this.#reporting;
    const record = this.#record();

    return record?.state === "open" ? record : undefined;
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
   * and the outbound guard's `policy`; a used object is refused. A metered opening (#224), with who opens, meters its
   * computer time from then on.
   */
  async open(
    caller: SessionCaller,
    { network, computer }: SandboxAllowance,
    policy: OutboundPolicy,
    metering?: SessionMetering,
    opener?: SessionOpener,
  ): Promise<SessionReply<null>> {
    if (this.#record() !== undefined) return refused("unavailable", "the session id is taken");

    const record: OpenRecord = {
      state: "open",
      org: caller.org,
      owner: caller.owner,
      network,
      computer,
      policy,
      idleAt: caller.now + SESSION_IDLE_MS,
      ...(metering === undefined || opener === undefined
        ? {}
        : {
            metering: {
              toolkitId: opener.toolkitId,
              member: opener.member,
              run: opener.run,
              openedAt: this.#now(),
              computerMs: 0,
              costMicros: 0,
              hourPriceMicros: metering.hourPriceMicros,
              pendingMs: 0,
            },
          }),
    };

    this.ctx.storage.kv.put(RECORD, record);
    await this.#schedule();
    await (await this.#workspaceOf(record)).fs.mkdir(SANDBOX_HOME, { recursive: true });

    return ok(null);
  }

  run(
    caller: SessionCaller,
    command: string,
    timeoutMs: number,
    metering?: SessionMetering,
  ): Promise<SessionReply<CommandResult>> {
    return this.#call(caller, metering, async (record) => {
      // The fallback rule (`fallback.ts`): decided before the line runs, so a line just-bash runs is never run again.
      const refusal = await shellRefusal(command);
      let onComputer = false;
      let metered = false;
      // When this command started the computer's run (#224), and whether the computer could not start for it.
      let startedAt: number | undefined;
      let notStarted = false;

      try {
        const workspace = await this.#workspaceOf(record);

        onComputer = refusal !== undefined && this.#computer !== undefined;

        if (onComputer && record.metering !== undefined) {
          // A command that would start or use the computer is refused once its time has no room (#224).
          if (metering?.limitReached === true)
            return { ok: false, reason: "refused", message: COMPUTER_REFUSED };
          const started = this.#now();
          const busy = this.#onComputer > 0;

          if (!computerRuns(record.metering, started, busy)) startedAt = started;
          this.#meter((current) => computerStarted(current, started, busy));
          this.#onComputer += 1;
          metered = true;
        }

        // A command that fails before it has a handle never reached the computer.
        notStarted = true;

        const handle = await workspace.runtime.exec(command, {
          encoding: "utf8",
          cwd: SANDBOX_HOME,
          timeoutMs,
          ...(onComputer ? { backend: COMPUTER_BACKEND } : {}),
        });

        notStarted = false;

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

        // A container Cloudflare refused to start ran nothing either.
        if (atLimit(failure) !== undefined) notStarted = true;

        return refused(
          "unavailable",
          onComputer
            ? computerFailure(failure)
            : `The sandbox could not run the command: ${failure.message}`,
        );
      } finally {
        // The computer's idle minutes count from the end of its last command; a run this command could not start is
        // dropped, as no computer ran.
        if (metered) {
          this.#onComputer -= 1;
          const used = this.#now();
          const dropped = notStarted ? startedAt : undefined;

          this.#meter((current) =>
            dropped === undefined
              ? computerUsed(current, used)
              : computerNotStarted(current, dropped),
          );
          // Its alarm meters the run when its idle minutes are over.
          await this.#schedule();
        }
      }
    });
  }

  readFile(
    caller: SessionCaller,
    path: string,
    metering?: SessionMetering,
  ): Promise<SessionReply<string>> {
    return this.#call(caller, metering, async (record) => {
      try {
        return ok(await (await this.#workspaceOf(record)).fs.readFile(path, "utf8"));
      } catch (error) {
        return fileFailure(error instanceof Error ? error : new Error(String(error)), path, "read");
      }
    });
  }

  writeFile(
    caller: SessionCaller,
    path: string,
    text: string,
    metering?: SessionMetering,
  ): Promise<SessionReply<null>> {
    return this.#call(caller, metering, async (record) => {
      try {
        const { fs } = await this.#workspaceOf(record);

        await fs.mkdir(parentOf(path), { recursive: true });
        await fs.writeFile(path, text);

        return ok(null);
      } catch (error) {
        return fileFailure(
          error instanceof Error ? error : new Error(String(error)),
          path,
          "write",
        );
      }
    });
  }

  list(
    caller: SessionCaller,
    path: string,
    metering?: SessionMetering,
  ): Promise<SessionReply<ReadonlyArray<DirectoryEntry>>> {
    return this.#call(caller, metering, async (record) => {
      try {
        const entries = await (await this.#workspaceOf(record)).fs.readdir(path);

        return ok(entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory })));
      } catch (error) {
        return fileFailure(error instanceof Error ? error : new Error(String(error)), path, "list");
      }
    });
  }

  /**
   * Stops the session's computer, if it runs, as a Spend limit its time counts toward has no room (#224): the Tools part
   * refused a call of a priced tool in it, or a priced `sandbox_close`. Answers whether one ran, with its last stretch.
   * The refused call is no use of the session: its idle day goes on.
   */
  async stopForLimit(
    caller: SessionCaller,
    metering: SessionMetering,
  ): Promise<SessionReply<boolean>> {
    const session = await this.#session(caller, false);

    if (!session.ok) return session;
    const stopped = await this.#stopForLimit({ ...metering, limitReached: true });

    return this.#answer(ok(stopped), metering);
  }

  /**
   * Closes the session; to a metered call (#224), with its computer time since the call before, which the call charges.
   */
  async close(caller: SessionCaller, metering?: SessionMetering): Promise<SessionReply<null>> {
    const session = await this.#session(caller);

    if (!session.ok) return session;
    const record = await this.#reported();

    if (record === undefined) return refused("closed");
    const time = await this.#forget(record, metering === undefined ? "none" : "call");

    return time === undefined || metering === undefined
      ? ok(null)
      : { ...ok(null), computerTime: time };
  }

  /**
   * Deletes the session and everything of it, with no note that it was, whoever's it is: its owner left `org`, or `org`
   * is being deleted (ADR 0027). Another org's session is left alone; one that is gone already is done. When its owner
   * left (`settle`, #224), an open metered session first settles as a close does: its computer time is metered and
   * answered, for the Tools part to charge, and its usage record written; a record that could not be written is kept
   * in a closed note, without the files, for the alarm to try again. A session found closed then is left to its alarm,
   * which finishes its close (its files are gone already), and answered as closed, so the Tools part keeps it until its
   * close is reported. On the org's deletion it writes none.
   */
  async purge(org: string, settle?: boolean): Promise<SessionReply<null>> {
    const found = this.#record();

    if (found !== undefined && found.org !== org) return refused("unknown_session");
    const record = settle === true && found?.state === "open" ? await this.#reported() : found;

    if (settle === true && this.#record()?.state === "closed") return refused("closed");

    if (settle === true && record?.state === "open" && record.metering !== undefined) {
      const time = await this.#forget(record, "call");
      const note = this.#record();

      // A record not written stays in the closed note, for the alarm to try again.
      if (note?.state !== "closed" || note.record === undefined) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
      }

      return { ...ok(null), ...(time === undefined ? {} : { computerTime: time }) };
    }

    await this.#stop();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    return ok(null);
  }

  /**
   * A day without a call closes the session, and what of its computer time no call charged is reported to its org's
   * Tools part (#224); before that, the computer's run is metered and reported when its idle minutes are over. A closed
   * session's alarm tries again what of its close is left to do, and a week after it closed the note that it was goes
   * too.
   */
  override async alarm(): Promise<void> {
    const record = this.#record();

    if (record?.state === "open") {
      // A session from before #224 knows no time it is idle until: its alarm is its close.
      if (record.idleAt === undefined || this.#now() >= record.idleAt)
        await this.#forget(record, "object");
      else {
        await this.#meterStopped(record);
        await this.#schedule();
      }

      return;
    }

    // A note from before #224 has no time it closed: its alarm is the one that forgets it.
    if (record?.closedAt !== undefined && this.#now() < record.closedAt + CLOSE_REPORT_MS) {
      await this.#settle(record);

      return;
    }

    if (record !== undefined) await forgottenUnsettled("sandbox session", unsettledOf(record));
    await this.ctx.storage.deleteAll();
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

  /** The session's id from the name its object was reached by, `<org>:<id>` (`provider.ts`). */
  #nameId(): string {
    return sessionIdOf(this.ctx.id.name);
  }

  /**
   * Deletes the session's files and everything else the object holds, keeping only a note that it was closed. A session
   * that meters its computer (#224) meters its last stretch first, which with what its alarm metered and did not report
   * yet is charged by `charge`: the closing call, the object (its alarm: reported to the Tools part), or no one (a call
   * from a part before #224); its note keeps its usage record until it is written. Answers what the call charges.
   */
  async #forget(
    record: OpenRecord,
    charge: "call" | "object" | "none",
  ): Promise<ComputerTime | undefined> {
    const now = this.#now();
    const { metering } = record;
    const busy = this.#onComputer > 0;

    const final =
      metering === undefined
        ? undefined
        : meterComputer(computerStopped(metering, now, busy), now, {
            busy: false,
            hourPriceMicros: metering.hourPriceMicros,
            free: charge === "none",
          });

    // What is left to charge: the last stretch, and what the alarm metered before and could not report.
    const left = final === undefined ? undefined : addedTime(final.time, metering?.owed);

    const note: ClosedNote = {
      state: "closed",
      org: record.org,
      owner: record.owner,
      closedAt: now,
      ...(final === undefined
        ? {}
        : {
            record: {
              sessionId: this.#nameId(),
              orgId: record.org,
              principalId: record.owner,
              memberId: final.metering.member,
              run: final.metering.run,
              toolkitId: final.metering.toolkitId,
              openedAt: final.metering.openedAt,
              computerMs: final.metering.computerMs,
              costMicros: final.metering.costMicros,
            },
          }),
      // Its alarm closed it: the Tools part hears of it, and charges what is left.
      ...(charge === "object" ? { owed: left?.costMicros ?? 0 } : {}),
    };

    // The note goes first, so a call that waits while the rest is deleted finds the session closed.
    this.ctx.storage.kv.put(RECORD, note);
    await this.#stop();
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(RECORD, note);
    await this.#settle(note);

    return left;
  }

  /**
   * Does what is left of closing the session (#224): writes its usage record and reports its alarm's close to the Tools
   * part, each that is not done yet, keeps what failed in its note for the alarm to try again, and sets the alarm: soon
   * while anything is left, else when the note goes.
   */
  async #settle(note: ClosedNote): Promise<void> {
    const { record } = note;
    const closedAt = note.closedAt ?? this.#now();

    const done = await settleClose(unsettledOf(note), {
      what: "sandbox session",
      record: async () => {
        if (record !== undefined) await this.writeRecord(record);
      },
      // Its org's Tools part charges the cost and forgets the session.
      report: (owed) =>
        this.controlPlane(note.org).tools().sandboxComputerTime(this.#nameId(), owed, true),
    });

    const left = remaining(unsettledOf(note), done);

    this.ctx.storage.kv.put(RECORD, {
      state: "closed",
      org: note.org,
      owner: note.owner,
      closedAt,
      ...(left.unrecorded === true ? { record } : {}),
      ...(left.owed === undefined ? {} : { owed: left.owed }),
    } satisfies ClosedNote);
    await this.ctx.storage.setAlarm(
      done.recorded && done.reported ? closedAt + CLOSE_REPORT_MS : this.#now() + SETTLE_RETRY_MS,
    );
  }
}

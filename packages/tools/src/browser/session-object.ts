/**
 * The browser session's Durable Object (#213, ADR 0039): one object per session, in the state Worker beside the
 * ControlPlane (ADR 0030), which holds the session's browser at the provider and runs its tools' calls
 * (`session.ts`). The org's Tools part opens and reaches it ({@link browserSessions}): MCP calls are stateless, so
 * `browser_open` answers the session's id and the other tools take it.
 *
 * **Ownership.** A session belongs to the org, member and principal that opened it ({@link SessionCaller}: an API key's
 * principal is the key, an Access user's the person, a hosted agent's run the run; its record names the run, #228). The
 * object is named by its org and id, so another org's call with the same id reaches another, empty object, and it
 * keeps its owner: a call of anyone else answers "unknown session", exactly as an id that was never opened.
 *
 * **Lifetime.** It closes after `IDLE_TIMEOUT_MS` (10 minutes) without a call (its alarm), or with `browser_close`,
 * well within Browser Run's `keep_alive` of 20 minutes, which counts from the browser's last command. A browser the
 * provider closed itself (Browser Run on a release of its own) closes the session too. A closed session answers that it
 * is closed for {@link CLOSED_KEPT_MS}, then forgets everything and answers as unknown. Nothing of the pages is stored:
 * only the owner, the provider and its id of the browser, the browser profile it opened from, whether the browser was
 * reached again, the current tab, the fields to mask and the times. The org's deletion deletes it at once
 * ({@link BrowserSession.purge}), without a usage record.
 *
 * **Profiles.** A session opened from a browser profile (#215) starts with the profile's state (its cookies and site
 * storage), which the Tools part unsealed and hands over, and keeps only the profile's id. Closing it with a save
 * ({@link BrowserSession.close}) reads the browser's state back and hands it to the part, which decides whether the
 * caller may save into the profile and seals it: the object never stores it. A browser reached again on a new
 * connection (the object restarted, or the connection dropped) reads back its cookies, but the local storage of only
 * the sites visited since (Playwright knows a context's sites per connection): the session keeps that it was
 * (`reconnected`), and a save says what it missed.
 *
 * **Masking.** Password fields are always masked; {@link BrowserSession.maskFields} adds the fields a person filled
 * during a handoff (#216), which are masked from then on in the session's snapshots and screenshots.
 *
 * **Browser time** (#214). The object meters the session's browser time, from asking the provider for its browser to
 * closing it (when the provider ended the browser itself: to when the session learnt so), at the toolkit's price per
 * browser hour, which each call passes ({@link SessionMetering}): every call answers the time since the call before and
 * its cost at the price in force since then (a new price costs from the call that passes it on), which the Tools part
 * charges to the Spend limits it counts toward. A call's stretch is committed with the call's last write, so a call
 * that fails before it leaves the stretch to the next. When the session closes, it writes one usage record of its
 * whole browser time and cost, naming the browser profile it opened from (`insertSessionRecord`); when its
 * alarm closed it, no call is there to charge the last stretch, so the object reports the close with that cost to the
 * org's ControlPlane itself (`browserSessionClosed`). A record or report that fails is kept to do (`unrecorded`,
 * `owed`) and tried again from the alarm, every {@link SETTLE_RETRY_MS}, until the closed session is forgotten.
 *
 * **Deploys** (docs/DEVELOPMENT.md, "State RPC: expand, then contract"). The metering is an optional last argument of
 * `open`, `operate` and `close`: a Tools part from before #214 passes none, and gets the bare tool result it expects,
 * its calls metering nothing (the stretch is the next metered call's, or free at a close); {@link browserSessions}
 * takes an object from before #214's bare answer as one that used no browser time.
 */
import { DurableObject } from "cloudflare:workers";
import { Clock, Duration, Effect, Option, Schema } from "effect";
import type { UsageRun } from "@commissary/auth";
import type { OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import type { ToolsControlPlane } from "../env.ts";
import { BROWSER_TOOLKIT } from "../toolkits/built-in.ts";
import { hourlyCost } from "../toolkits/price.ts";
import { insertSessionRecord, type SessionRecord } from "../usage/record.ts";
import {
  forgottenUnsettled,
  remaining,
  SETTLE_RETRY_MS,
  type Settled,
  sessionIdOf,
  settleClose,
} from "../usage/session-close.ts";
import { BROWSER_RUN } from "./browser-run.ts";
import { browserRunSessions, type BrowserRunSessionBinding } from "./browser-run-sessions.ts";
import { type BrowserTime, type Timed, untimed } from "./browser-time.ts";
import type {
  BrowserFailure,
  BrowserSessionProvider,
  BrowserTab,
  HandoffResult,
  ProviderBrowser,
  StorageState,
} from "./provider.ts";
import { currentTab, runOperation, textResult, toolError } from "./session.ts";
import {
  HANDOFF_TIMEOUT_MS,
  IDLE_TIME,
  IDLE_TIMEOUT_MS,
  notCss,
  type SessionOperation,
} from "./session-tools.ts";

/** How long a closed session answers that it is closed, before it answers as unknown. */
export const CLOSED_KEPT_MS = 24 * 60 * 60_000;

/**
 * What the session's object reads from the state Worker's env: the optional `browser` binding, over which it reaches
 * Browser Run's browsers (`@cloudflare/playwright` reaches them with its `fetch`); the usage database its record goes
 * into when it closes, and the org's ControlPlane, whose Tools part hears of the closes of its alarm and charges the
 * browser time before them (#214).
 */
export interface BrowserSessionEnv {
  readonly BROWSER?: BrowserRunSessionBinding | undefined;
  readonly USAGE: D1Database;
  readonly CONTROL_PLANE: DurableObjectNamespace<ToolsControlPlane>;
}

/**
 * The browsers of the provider `source` (a browser toolkit's source, as the session was opened with), or `undefined`
 * when the deployment has none: Browser Run's, over the `browser` binding.
 */
const sessionProviderOf = (
  source: string,
  env: BrowserSessionEnv,
): BrowserSessionProvider | undefined =>
  source === BROWSER_RUN && env.BROWSER !== undefined ? browserRunSessions(env.BROWSER) : undefined;

/**
 * A call's caller: its org, and the member and the principal of the call (`principalId`: `key:<id>` for an API key,
 * `user:<email>` for a person signed in through Access). A session belongs to the caller that opened it, and a call
 * matches only with all three.
 */
export interface SessionCaller {
  readonly org: string;
  readonly member: string | undefined;
  readonly principal: string;
}

/**
 * What a Tools part from #214 on passes with each call (absent: a part from before, whose calls meter nothing): the
 * toolkit's price per browser hour from the call on (a close costs its last stretch at the price in force before it),
 * and, opening, the toolkit the session opens from and the agent run opening it (#228), which its record names.
 */
export interface SessionMetering {
  readonly hourPriceMicros: number;
  readonly toolkitId?: string | undefined;
  readonly run?: UsageRun | undefined;
}

/** An agent run as a session keeps it for its usage record (#228, `UsageRun`). */
const StoredRun = Schema.Struct({
  agentId: Schema.String,
  runId: Schema.String,
  starter: Schema.optionalKey(Schema.String),
  private: Schema.optionalKey(Schema.Boolean),
});

/**
 * A metered call's answer: its tool result, with the session's browser time since the call before and its cost, when
 * it reached an open session, and what it did to the session, when it opened it (`browser_open`) or closed it (its
 * browser was gone), which the Tools part logs.
 */
export interface SessionAnswer extends Timed {
  readonly session?: "opened" | "closed" | undefined;
  /**
   * The call dropped the outcome of the session's handoff (#216): it acted on the page first, so no call waits on the
   * handoff any more, which the Tools part's log of sessions forgets.
   */
  readonly handoffCleared?: true | undefined;
}

/**
 * What `browser_ask_human` answers (#216): a session answer, and, while its handoff waits for the person, whether this
 * call `started` it or it is still `waiting` (one before started it; or a call waited on it as long as one waits, and the
 * client calls again), and until when it waits (epoch ms).
 */
export interface HandoffAnswer extends SessionAnswer {
  readonly handoff?: { readonly state: "started" | "waiting"; readonly until: number } | undefined;
}

/** What the panel sees of a session (#216): unknown (to its org), closed, or open with the handoff that waits. */
export type SessionWatch =
  | { readonly kind: "unknown" }
  | { readonly kind: "closed" }
  | {
      readonly kind: "open";
      readonly handoff?: { readonly reason: string; readonly until: number } | undefined;
    };

/** A Live View link minted (#216), with when it stops starting connections (epoch ms), or why there is none. */
export type LiveViewAnswer =
  | { readonly kind: "unknown" }
  | { readonly kind: "closed" }
  // Why is not told: the provider's message could quote the link.
  | { readonly kind: "failed" }
  | { readonly kind: "minted"; readonly url: string; readonly expiresAt: number };

/** A session ended from the panel (#216), with its browser time since the call before, or why it could not be. */
export type SessionEnded =
  | { readonly kind: "unknown" }
  | { readonly kind: "closed" }
  | { readonly kind: "ended"; readonly browserTime: BrowserTime };

/**
 * Why a session closed: `browser_close`, its idle time, the provider closing its browser, or someone ending it in the
 * panel (#216: its member, or an org admin).
 */
const ClosedReason = Schema.Literals(["closed", "idle", "provider", "ended"]);

type ClosedReason = typeof ClosedReason.Type;

/**
 * How a handoff ended (#216): the person clicked Done (`done`) or Failed (`failed`), nobody finished it in time
 * (`timed_out`), the person declined it when their client asked (`declined`), or it ended without the session hearing
 * how (`ended`: its object restarted meanwhile, and the provider no longer had it).
 */
const HandoffOutcome = Schema.Literals(["done", "failed", "timed_out", "declined", "ended"]);

export type HandoffOutcome = typeof HandoffOutcome.Type;

/** How a session's handoff ended (#216), which one (`startedAt`), and when a call first answered it. */
const StoredEnded = Schema.Struct({
  outcome: HandoffOutcome,
  /** When the handoff that ended started: a call woken by its end answers it, not a newer one's. */
  startedAt: Schema.Number,
  /** The person's reason, as the provider told it. */
  why: Schema.optionalKey(Schema.String),
  at: Schema.Number,
  /** When a call first answered it: it is answered alike for {@link OUTCOME_KEPT_MS} from then. */
  takenAt: Schema.optionalKey(Schema.Number),
});

type StoredEnded = typeof StoredEnded.Type;

/**
 * The handoff of a session (#216): what the person is asked (the call's `reason`, kept only while the handoff waits, to
 * show them on the session's page, and dropped when it ends), when it started and until when it waits, whether what
 * the person types could not be marked (`unwatched`: every text field that is not empty is masked at its end), and how
 * it ended, kept until {@link OUTCOME_KEPT_MS} after a call first answered it or until another tool acts on the page.
 */
const StoredHandoff = Schema.Struct({
  reason: Schema.optionalKey(Schema.String),
  startedAt: Schema.Number,
  until: Schema.Number,
  unwatched: Schema.optionalKey(Schema.Boolean),
  ended: Schema.optionalKey(StoredEnded),
});

type StoredHandoff = typeof StoredHandoff.Type;

/** What the object keeps of its session. */
const StoredSession = Schema.Struct({
  org: Schema.String,
  member: Schema.NullOr(Schema.String),
  principal: Schema.String,
  /** The provider of its browser: the browser toolkit's source when it opened (`browser-run`). */
  source: Schema.String,
  /** The provider's id of the browser. */
  browser: Schema.String,
  /** The browser profile it opened from (#215), which a save goes into; absent: none. */
  profile: Schema.optionalKey(Schema.String),
  /** Whether its browser was reached on a connection other than the one it opened on; absent: not yet. */
  reconnected: Schema.optionalKey(Schema.Boolean),
  openedAt: Schema.Number,
  usedAt: Schema.Number,
  tab: Schema.Int,
  masks: Schema.Array(Schema.String),
  closed: Schema.NullOr(Schema.Struct({ at: Schema.Number, reason: ClosedReason })),
  /** Its id (kept since #214; before, its object's name says it). */
  id: Schema.optionalKey(Schema.String),
  // Browser time (#214); a session opened before kept none: the browser toolkit's, metered from its opening, free so far.
  /** The toolkit it was opened from. */
  toolkit: Schema.optionalKey(Schema.String),
  /** The agent run that opened it (#228), which its record names; absent: none (or opened before #228). */
  run: Schema.optionalKey(StoredRun),
  /** Up to when its browser time was answered or charged. */
  meteredAt: Schema.optionalKey(Schema.Number),
  /** What its browser time cost up to `meteredAt`, in micro-USD. */
  costMicros: Schema.optionalKey(Schema.Number),
  /** The price per browser hour its browser time costs since `meteredAt`. */
  hourPriceMicros: Schema.optionalKey(Schema.Number),
  /** Closed, and its usage record not written yet: its alarm writes it. */
  unrecorded: Schema.optionalKey(Schema.Boolean),
  /** Closed by its alarm, and the close not reported to the Tools part yet, with the cost it charges: its alarm does. */
  owed: Schema.optionalKey(Schema.Number),
  /** Its handoff (#216), from when a call asked for one until a call took how it ended. */
  handoff: Schema.optionalKey(StoredHandoff),
  /** A handoff ended in it, or someone watched it (#216): the query of every address it shows is masked from then on. */
  maskUrls: Schema.optionalKey(Schema.Boolean),
  /**
   * A Live View of it was minted (#216), so its member may type in it for as long as they keep it open, which outlives
   * its link: from then on what they type is marked (`marked`), or could not be (`unmarked`: every text field that is
   * not empty is masked), and every call masks what they filled before it acts.
   */
  watched: Schema.optionalKey(Schema.Literals(["marked", "unmarked"])),
  /** The browser time, in ms, of the stretch `owed` charges, which the report carries for the org's plan (#241). */
  owedMs: Schema.optionalKey(Schema.Number),
});

type StoredSession = typeof StoredSession.Type;

const decodeStored = Schema.decodeUnknownOption(StoredSession);

const SESSION = "session";

/** A session id: `bs_` and 32 hex digits, random. */
export const SESSION_ID = /^bs_[0-9a-f]{32}$/;

const newSessionId = (): string =>
  `bs_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

const unknownSession = (id: string): Schema.JsonObject =>
  toolError(`Unknown browser session ${id}. Open one with browser_open.`);

const CLOSED_BECAUSE: Record<ClosedReason, string> = {
  closed: "it was closed",
  idle: `it was idle for ${IDLE_TIMEOUT_MS / 60_000} minutes`,
  provider: "the browser provider ended its browser",
  ended: "it was ended in the panel",
};

/** How often a call waiting on a handoff asks the provider whether it is still active (#216). */
const HANDOFF_POLL_MS = 15_000;

/**
 * How long one `browser_ask_human` call waits on a handoff (#216) before it answers that the handoff still waits, so the
 * client calls again: a client's request, and the Workers that carry it, do not wait half an hour.
 */
export const HANDOFF_WAIT_MS = 45_000;

/**
 * How long a handoff's outcome is answered alike after a call first answered it (#216): every call that waited on it,
 * and a client's retry of the same call, get it; after that a `browser_ask_human` asks a person anew.
 */
export const OUTCOME_KEPT_MS = 2 * 60_000;

/**
 * How often the session's alarm asks the provider about its handoff while no call waits (#216): it hears an end its
 * object missed, and its command keeps the browser alive (Browser Run's `keep_alive` counts from the last command).
 */
const HANDOFF_ALARM_MS = 60_000;

/** How long a minted Live View link starts a connection for: Browser Run's shortest (ADR 0044, #216). */
export const LIVE_VIEW_EXPIRES_MS = 60_000;

/**
 * Every field that takes text: what a handoff masks when the provider could not tell which fields the person filled
 * (#216), so masking fails closed.
 */
const EVERY_TEXT_FIELD =
  'input:not([type="hidden" i]):not([type="checkbox" i]):not([type="radio" i]):not([type="submit" i]):not([type="button" i]), textarea';

/**
 * The fields the person's typing was marked on (`page-scripts.ts`): masked from the first watch on, so that a field
 * typed into while a call reads the page is masked at that read, before any filled-field step names it.
 */
const TYPED_FIELDS = "[data-commissary-typed]";

/** The most selectors a session masks: past them it masks every field that takes text instead (#216). */
export const MAX_MASKS = 256;

/** The session's masks with `added`, without repeats; past {@link MAX_MASKS}, every field that takes text. */
const withMasks = (
  masks: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const all = [...new Set([...masks, ...added])];

  return all.length <= MAX_MASKS
    ? all
    : [EVERY_TEXT_FIELD, ...(all.includes(TYPED_FIELDS) ? [TYPED_FIELDS] : [])];
};

/** What a call answers once a handoff ended, in words, and in `structuredContent` for a client that reads it. */
const handoffEnded = (
  id: string,
  ended: NonNullable<StoredHandoff["ended"]>,
): Schema.JsonObject => {
  const why = ended.why === undefined || ended.why === "" ? "" : ` (${ended.why})`;

  const text: Record<HandoffOutcome, string> = {
    done:
      `The person clicked Done in browser session ${id}${why}. The fields they filled are masked in snapshots and ` +
      `screenshots; take a browser_snapshot to see the page now.`,
    failed: `The person clicked Failed in browser session ${id}${why}.`,
    timed_out: `Nobody finished the handoff in browser session ${id} within ${HANDOFF_TIMEOUT_MS / 60_000} minutes: it timed out.`,
    declined: `The person declined to act in browser session ${id}.`,
    ended:
      `The handoff in browser session ${id} ended, but the session did not hear how. Take a browser_snapshot to see ` +
      `the page now.`,
  };

  return {
    content: [{ type: "text", text: text[ended.outcome] }],
    structuredContent: {
      outcome: ended.outcome,
      ...(ended.why === undefined ? {} : { reason: ended.why }),
    },
  };
};

/** What waiting on a handoff answers when the session has none (#216). */
const NO_HANDOFF = (id: string): Schema.JsonObject =>
  toolError(
    `No handoff waits in browser session ${id}: ask a person to act in it with browser_ask_human.`,
  );

/** What a call that waited on a handoff as long as one waits answers while it still waits for its person (#216). */
const stillWaiting = (id: string, until: number): HandoffAnswer => ({
  ...untimed(
    textResult(
      `A person is still asked to act in browser session ${id}, until ${new Date(until).toISOString()}. Call ` +
        `browser_ask_human again with the same sessionId to keep waiting for them.`,
    ),
  ),
  handoff: { state: "waiting", until },
});

/** What a call that acts on the page answers while a person acts in it (#216). */
const handedOff = (id: string, handoff: StoredHandoff): Schema.JsonObject =>
  toolError(
    `A person is acting in browser session ${id} (a handoff) until ${new Date(handoff.until).toISOString()}: wait ` +
      `for them with browser_ask_human and the same sessionId, or close the session.`,
  );

const closedSession = (id: string, reason: ClosedReason): Schema.JsonObject =>
  toolError(
    `Browser session ${id} is closed (${CLOSED_BECAUSE[reason]}). Open a new one with browser_open.`,
  );

/** The browser profile a session opens from (#215): its id, and the state it holds (none while it is empty). */
export interface SessionProfile {
  readonly id: string;
  readonly state: StorageState | undefined;
}

/**
 * The browser's state read back for a save: `reconnected` when it was read over a connection other than the session's
 * first, whose local storage misses the sites visited before it; or why it could not be read.
 */
export type SavedState =
  | { readonly state: StorageState; readonly reconnected: boolean }
  | { readonly failed: string };

/**
 * What closing a session answers: the tool result of a session that could not be closed (unknown, or closed already),
 * or that it closed, with the profile it was opened from and, when a save was asked of a session opened from one, the
 * browser's state to save into it, and, to a metered call, its browser time since the call before and its cost (#214;
 * absent from an object from before).
 */
export type SessionClosed =
  | { readonly kind: "answer"; readonly result: Schema.JsonObject }
  | {
      readonly kind: "closed";
      readonly profile?: string;
      readonly saved?: SavedState;
      readonly browserTime?: BrowserTime;
    };

/** Who pays a closing session's last stretch of browser time: the call closing it, the object itself, or no one. */
type ClosingCharge = "call" | "object" | "none";

/** A session metered up to a time, and the browser time since it was metered before, with its cost. */
interface Metered {
  readonly session: StoredSession;
  readonly browserTime: BrowserTime;
}

/**
 * `session` metered up to `at`: its browser time since it was last metered, at the price in force since then (none:
 * `free`), and `hourPriceMicros` in force from `at` on.
 */
const meterSession = (
  session: StoredSession,
  at: number,
  hourPriceMicros: number,
  free = false,
): Metered => {
  const from = session.meteredAt ?? session.openedAt;
  const browserMs = Math.max(0, at - from);
  const costMicros = free ? 0 : hourlyCost(browserMs, session.hourPriceMicros ?? 0);

  return {
    session: {
      ...session,
      meteredAt: Math.max(at, from),
      costMicros: (session.costMicros ?? 0) + costMicros,
      hourPriceMicros,
    },
    browserTime: { browserMs, costMicros },
  };
};

/** `session` without what is left to do once it closed. */
const settled = (session: StoredSession, done: Settled): StoredSession => {
  const { unrecorded: _unrecorded, owed: _owed, owedMs, ...rest } = session;
  const left = remaining(session, done);

  return {
    ...rest,
    ...left,
    ...(left.owed === undefined || owedMs === undefined ? {} : { owedMs }),
  };
};

const owns = (stored: StoredSession, caller: SessionCaller): boolean =>
  stored.org === caller.org &&
  stored.member === (caller.member ?? null) &&
  stored.principal === caller.principal;

/**
 * The browser session's Durable Object. The deployed class reaches its provider's browsers through the state Worker's
 * env ({@link BrowserSessionEnv}); a test's subclass gives it a fake provider ({@link BrowserSession.sessionProvider}).
 *
 * Its calls and its alarm run one at a time (`#serial`): a Durable Object takes another call while one waits on the
 * browser, and two calls of a session would otherwise act on its page at once, or close it under each other.
 */
export class BrowserSession extends DurableObject<BrowserSessionEnv> {
  /** The browser as this instance last reached it; reached again after the object restarts. */
  #browser: ProviderBrowser | undefined;
  /** What the object reads the time from: the live clock, or a test's (`useClock`). */
  #clock: Clock.Clock = Clock.Clock.defaultValue();
  /** The call running now: the next one starts once it settled. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The calls waiting on the session's handoff (#216), woken when it ends or the session closes. */
  readonly #waiters = new Set<(ended: StoredEnded | undefined) => void>();
  /**
   * When a poll first found the handoff no longer active without its end heard: a poll that finds it so again at least
   * {@link HANDOFF_POLL_MS} later ends it (`ended`), as its end may still have been on its way.
   */
  #inactiveSince: number | undefined;

  /** The browsers of the provider `source`; `undefined` on a deployment without them. */
  protected sessionProvider(source: string): BrowserSessionProvider | undefined {
    return sessionProviderOf(source, this.env);
  }

  /** The ControlPlane of the session's org, which hears of its alarm's closes (a test's subclass reaches its own). */
  protected controlPlane(org: string): DurableObjectStub<ToolsControlPlane> {
    // SAFETY: a session's org is the org id of the ControlPlane whose Tools part opened it.
    return controlPlaneOf(this.env, org as OrgId);
  }

  /** Writes the usage record of a session (a test's subclass may fail it). */
  protected writeRecord(record: SessionRecord): Promise<void> {
    return insertSessionRecord(this.env.USAGE, record);
  }

  /**
   * How long one call waits on a handoff before it answers that it still waits. A test's subclass waits less, on the
   * live clock: a test cannot know when a waiting call has reached its sleep, so it cannot move a `TestClock` on after.
   */
  protected handoffWait(): number {
    return HANDOFF_WAIT_MS;
  }

  /** Makes the object read the time from `clock` (a test's `TestClock`). In the object's isolate only. */
  useClock(clock: Clock.Clock): void {
    this.#clock = clock;
  }

  /** Runs `call` once every call before it settled. */
  #serial<A>(call: () => Promise<A>): Promise<A> {
    const running = this.#queue.then(call, call);

    this.#queue = running.catch(() => undefined);

    return running;
  }

  #now(): number {
    return this.#clock.currentTimeMillisUnsafe();
  }

  /** The stored session; one that does not decode answers as unknown. */
  #stored(): StoredSession | undefined {
    const stored = this.ctx.storage.kv.get(SESSION);

    return stored === undefined ? undefined : Option.getOrUndefined(decodeStored(stored));
  }

  #save(session: StoredSession): void {
    this.ctx.storage.kv.put(SESSION, session);
  }

  /**
   * Marks the session closed, with its last stretch of browser time metered and charged by `charge`, ends its browser
   * unless the provider did, writes its usage record (and, for the alarm, reports the close with the stretch's cost),
   * and keeps that it closed for a day. Answers the last stretch, which a closing call charges. Nothing after the
   * write that closes it fails: a record or report that does not go through is left to the alarm.
   */
  async #close(
    session: StoredSession,
    reason: ClosedReason,
    charge: ClosingCharge,
  ): Promise<BrowserTime> {
    const now = this.#now();
    const closing = meterSession(session, now, session.hourPriceMicros ?? 0, charge === "none");

    const closed: StoredSession = {
      ...closing.session,
      closed: { at: now, reason },
      unrecorded: true,
      ...(charge === "object"
        ? { owed: closing.browserTime.costMicros, owedMs: closing.browserTime.browserMs }
        : {}),
    };

    this.#save(closed);
    await this.ctx.storage.setAlarm(now + SETTLE_RETRY_MS);
    // A call waiting on its handoff answers that it closed.
    this.#wake();
    const browser = this.#browser;

    this.#browser = undefined;

    if (reason !== "provider") {
      const provider = this.sessionProvider(session.source);

      const ending =
        browser ??
        (provider === undefined
          ? undefined
          : await Effect.runPromise(
              provider.connect(session.browser).pipe(Effect.orElseSucceed(() => undefined)),
            ));

      if (ending !== undefined) await Effect.runPromise(ending.close());
    }

    await this.#settle(closed);

    return closing.browserTime;
  }

  /**
   * Does what is left of closing `session`: writes its usage record and reports its alarm's close to the Tools part,
   * each that is not done yet, keeps what failed for the alarm to try again, and sets the alarm: soon while anything is
   * left, else when the session is forgotten.
   */
  async #settle(session: StoredSession): Promise<void> {
    if (session.closed === null) return;

    const { closed } = session;

    const done = await settleClose(session, {
      what: "browser session",
      record: () =>
        this.writeRecord({
          sessionId: session.id ?? this.#nameId(),
          orgId: session.org,
          principalId: session.principal,
          memberId: session.member ?? undefined,
          toolkitId: session.toolkit ?? BROWSER_TOOLKIT,
          openedAt: session.openedAt,
          browserMs: Math.max(0, closed.at - session.openedAt),
          costMicros: session.costMicros ?? 0,
          profileId: session.profile,
          run: session.run,
        }),
      // Its org's Tools part charges the cost and forgets the session.
      report: (owed) =>
        this.controlPlane(session.org)
          .tools()
          .browserSessionClosed(session.id ?? this.#nameId(), owed, session.owedMs),
    });

    const left = settled(session, done);

    this.#save(left);
    await this.ctx.storage.setAlarm(
      done.recorded && done.reported ? closed.at + CLOSED_KEPT_MS : this.#now() + SETTLE_RETRY_MS,
    );
  }

  /** The session's id from the name its object was reached by, `<org>:<id>` ({@link browserSessionStub}). */
  #nameId(): string {
    return sessionIdOf(this.ctx.id.name);
  }

  /**
   * Opens the session `id` for `caller`, with a new browser of the provider `source` (the browser toolkit's), started
   * from the browser profile `profile` when given (#215), and loads `url` in it when given. Answers the tool result: the
   * id, or why the provider refused (its account's limit included); to a metered call (`metering`, #214), with the
   * browser time the opening used.
   */
  open(
    caller: SessionCaller,
    id: string,
    source: string,
    url?: string,
    profile?: SessionProfile,
    metering?: SessionMetering,
  ): Promise<SessionAnswer | Schema.JsonObject> {
    return this.#serial(async () => {
      const answer = await this.#open(caller, id, source, url, profile, metering);

      return metering === undefined ? answer.result : answer;
    });
  }

  async #open(
    caller: SessionCaller,
    id: string,
    source: string,
    url: string | undefined,
    profile: SessionProfile | undefined,
    metering: SessionMetering | undefined,
  ): Promise<SessionAnswer> {
    const provider = this.sessionProvider(source);

    if (provider === undefined || this.ctx.storage.kv.get(SESSION) !== undefined)
      return untimed(toolError("The browser could not open a session here."));

    // Its browser time counts from asking the provider for the browser.
    const asked = this.#now();

    const opened = await Effect.runPromise(
      provider.open(profile?.state).pipe(
        Effect.map((browser) => ({ browser })),
        Effect.catchTags({
          BrowserLimitReached: (error) => Effect.succeed({ refused: error.message }),
          BrowserProviderError: (error) =>
            Effect.logWarning("browser session did not open").pipe(
              Effect.as({ refused: error.message }),
            ),
        }),
      ),
    );

    if ("refused" in opened) return untimed(toolError(opened.refused));
    const now = this.#now();

    this.#browser = opened.browser;

    const session: StoredSession = {
      org: caller.org,
      member: caller.member ?? null,
      principal: caller.principal,
      source,
      browser: opened.browser.id,
      ...(profile === undefined ? {} : { profile: profile.id }),
      openedAt: asked,
      usedAt: now,
      tab: 0,
      masks: [],
      closed: null,
      id,
      ...(metering?.toolkitId === undefined ? {} : { toolkit: metering.toolkitId }),
      ...(metering?.run === undefined ? {} : { run: metering.run }),
      meteredAt: asked,
      costMicros: 0,
      hourPriceMicros: metering?.hourPriceMicros ?? 0,
    };

    this.#save(session);
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

    const intro = textResult(
      `Browser session ${id} is open. Pass ${id} as sessionId to the other browser tools; the session closes after ` +
        `${IDLE_TIME}, or with browser_close.`,
    );

    if (url === undefined) {
      if (metering === undefined) return { result: intro, session: "opened" };
      const first = meterSession(session, now, metering.hourPriceMicros);

      this.#save(first.session);

      return { result: intro, browserTime: first.browserTime, session: "opened" };
    }

    const loaded = await this.#operate(
      session,
      id,
      { tool: "navigate", args: { sessionId: id, url } },
      metering,
    );

    // SAFETY: every tool result of a session's is built with a `content` array (`session.ts`).
    const content = [
      ...(intro["content"] as Schema.MutableJsonArray),
      ...(loaded.result["content"] as Schema.MutableJsonArray),
    ];

    return {
      ...loaded,
      result: loaded.result["isError"] === true ? { content, isError: true } : { content },
      // A browser gone already closed it again.
      session: loaded.session ?? "opened",
    };
  }

  /**
   * Runs `operation` in the session `id` for `caller`: its tool result, or that the session is unknown or closed; to a
   * metered call (`metering`, #214), with the session's browser time since the call before and its cost, at the price
   * `metering` says from now on.
   */
  operate(
    caller: SessionCaller,
    id: string,
    operation: Exclude<SessionOperation, { readonly tool: "close" }>,
    metering?: SessionMetering,
  ): Promise<SessionAnswer | Schema.JsonObject> {
    return this.#serial(async () => {
      const answer = await this.#operateOwned(caller, id, operation, metering);

      return metering === undefined ? answer.result : answer;
    });
  }

  async #operateOwned(
    caller: SessionCaller,
    id: string,
    operation: Exclude<SessionOperation, { readonly tool: "close" }>,
    metering: SessionMetering | undefined,
  ): Promise<SessionAnswer> {
    const session = this.#stored();

    if (session === undefined || !owns(session, caller)) return untimed(unknownSession(id));

    if (session.closed !== null) return untimed(closedSession(id, session.closed.reason));

    const { handoff, ...rest } = session;

    // While a person acts in the page, no tool does (#216): a snapshot would show what they are typing.
    if (handoff !== undefined && handoff.ended === undefined)
      return untimed(handedOff(id, handoff));

    // How an ended handoff ended is for `browser_ask_human`; another tool acting on the page drops it.
    if (handoff !== undefined) this.#save(rest);

    // The member may have typed in a Live View: what they filled is masked before the call acts (#216).
    const answer = await this.#operate(await this.#afterWatch(rest), id, operation, metering);

    return handoff === undefined ? answer : { ...answer, handoffCleared: true };
  }

  /**
   * Closes the session `id` for `caller`: the session's own `browser_close`. With `save`, the browser's state is read
   * first and handed back with the profile the session opened from, for the Tools part to save (or refuse); without a
   * profile there is nothing to read. The session closes whether or not the state could be read. A metered call
   * (`metering`, #214) gets the last stretch of browser time to charge; any other leaves it free.
   */
  close(
    caller: SessionCaller,
    id: string,
    save: boolean,
    metering?: SessionMetering,
  ): Promise<SessionClosed> {
    return this.#serial(async (): Promise<SessionClosed> => {
      const session = this.#stored();

      if (session === undefined || !owns(session, caller))
        return { kind: "answer", result: unknownSession(id) };

      if (session.closed !== null)
        return { kind: "answer", result: closedSession(id, session.closed.reason) };

      const { profile } = session;
      const saved = profile !== undefined && save ? await this.#state(session) : undefined;

      const browserTime = await this.#close(
        session,
        "closed",
        metering === undefined ? "none" : "call",
      );

      return {
        kind: "closed",
        ...(profile === undefined ? {} : { profile }),
        ...(saved === undefined ? {} : { saved }),
        ...(metering === undefined ? {} : { browserTime }),
      };
    });
  }

  /**
   * Deletes the session at once, its browser ended, without a usage record or a report: the org was deleted (Tools'
   * org-deletion step, through `ToolsPart.purgeBrowserSessions`). Safe to repeat.
   */
  purge(): Promise<void> {
    return this.#serial(async () => {
      const session = this.#stored();
      const browser = this.#browser;

      this.#browser = undefined;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();

      if (session === undefined || session.closed !== null) return;
      const provider = this.sessionProvider(session.source);

      const ending =
        browser ??
        (provider === undefined
          ? undefined
          : await Effect.runPromise(
              provider.connect(session.browser).pipe(Effect.orElseSucceed(() => undefined)),
            ));

      if (ending !== undefined) await Effect.runPromise(ending.close());
    });
  }

  /** The browser's state now, for a save; why it could not be read when it could not. */
  async #state(session: StoredSession): Promise<SavedState> {
    const provider = this.sessionProvider(session.source);

    if (provider === undefined) return { failed: CLOSED_BECAUSE.provider };

    const read = (browser: ProviderBrowser) =>
      browser.storageState().pipe(Effect.map((state) => ({ browser, state })));

    const reach = Effect.flatMap(provider.connect(session.browser), read);
    const cached = this.#browser;

    return await Effect.runPromise(
      (cached === undefined
        ? reach
        : read(cached).pipe(Effect.catchTag("BrowserGone", () => reach))
      ).pipe(
        Effect.map(({ browser, state }) => {
          this.#browser = browser;

          return { state, reconnected: session.reconnected === true || browser !== cached };
        }),
        Effect.catchTags({
          BrowserGone: () => Effect.succeed({ failed: CLOSED_BECAUSE.provider }),
          BrowserProviderError: (error) =>
            Effect.logWarning("browser session state not read").pipe(
              Effect.as({ failed: error.message }),
            ),
        }),
      ),
    );
  }

  /**
   * Masks the fields matching the CSS `selectors` in the session's snapshots and screenshots from now on, besides its
   * password fields, and the query of every address it shows: the hook for the fields a person filled during a handoff
   * (#216). False for a caller who does not own the session, a session that is closed, or a selector that is not bare
   * CSS (`notCss`).
   */
  maskFields(caller: SessionCaller, selectors: ReadonlyArray<string>): Promise<boolean> {
    return this.#serial(async () => {
      const session = this.#stored();

      if (session === undefined || !owns(session, caller) || session.closed !== null) return false;

      if (selectors.some((selector) => notCss(selector) !== undefined)) return false;
      this.#save({ ...session, masks: withMasks(session.masks, selectors) });

      return true;
    });
  }

  // --- handoff (#216) ------------------------------------------------------------------------------------------------

  /**
   * `browser_ask_human` in the session `id` for `caller`: asks a person to act in its current tab, with `reason` as the
   * instructions the provider shows them, for at most {@link HANDOFF_TIMEOUT_MS}, and marks what they type
   * (`watchInputs`). Answers that the handoff `started` (the Tools part has the person reached: an elicitation, or a
   * link), that one asked before still `waiting` (the part then waits on it, {@link awaitHandoff}), or, when one ended
   * and its outcome is still kept ({@link OUTCOME_KEPT_MS} from when a call first took it), how. With `mayStart` false
   * (the Tools part let the call through its approvals as one that continues a handoff) it starts none, and answers
   * that none waits, decided in turn with the object's other calls. The session's browser time since the call before
   * comes with the answer, as for any metered call.
   */
  askHuman(
    caller: SessionCaller,
    id: string,
    reason: string,
    metering: SessionMetering,
    options: { readonly mayStart?: boolean } = {},
  ): Promise<HandoffAnswer> {
    return this.#serial(async (): Promise<HandoffAnswer> => {
      const stored = this.#stored();

      if (stored === undefined || !owns(stored, caller)) return untimed(unknownSession(id));

      if (stored.closed !== null) return untimed(closedSession(id, stored.closed.reason));
      const { handoff, ...withoutHandoff } = stored;

      if (handoff?.ended !== undefined && this.#kept(handoff.ended))
        return this.#take(stored, id, handoff.ended, metering);

      if (handoff !== undefined && handoff.ended === undefined)
        return {
          ...untimed(textResult(`A person is already asked to act in browser session ${id}.`)),
          handoff: { state: "waiting", until: handoff.until },
        };

      // A call the Tools part let through its approvals as one that continues a handoff starts none (`mayStart`): the
      // handoff it saw may have gone since (another tool dropped it, its outcome no longer kept).
      if (options.mayStart === false) return untimed(NO_HANDOFF(id));

      // An outcome no longer kept is dropped: this call asks anew.
      const session: StoredSession = withoutHandoff;
      // Which handoff the provider's end belongs to: one started later is another.
      const startedAt = Math.max(this.#now(), (handoff?.startedAt ?? 0) + 1);

      // What the person types is marked from the start; a page that cannot be marked has every filled field masked.
      const started = await this.#onTab(session, (tab) =>
        tab.watchInputs().pipe(
          Effect.as(true),
          Effect.catchTag("BrowserProviderError", () => Effect.succeed(false)),
          Effect.flatMap((watched) =>
            tab.handoff(reason, HANDOFF_TIMEOUT_MS, this.#hear(startedAt)).pipe(Effect.as(watched)),
          ),
        ),
      );

      if ("gone" in started) {
        const browserTime = await this.#close(session, "provider", "call");

        return this.#closedAnswer(closedSession(id, "provider"), browserTime, metering);
      }

      const now = this.#now();
      const metered = meterSession(session, now, metering.hourPriceMicros);

      if ("failed" in started) {
        this.#save({ ...metered.session, usedAt: now });
        await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

        return { result: toolError(started.failed), browserTime: metered.browserTime };
      }

      const until = now + HANDOFF_TIMEOUT_MS;

      this.#inactiveSince = undefined;
      this.#save({
        ...metered.session,
        // What the person types is masked at every read from now on.
        masks: withMasks(metered.session.masks, [TYPED_FIELDS]),
        usedAt: now,
        handoff: {
          reason,
          startedAt,
          until,
          ...(started.ok ? {} : { unwatched: true }),
        },
        ...(started.reconnected ? { reconnected: true } : {}),
      });
      await this.ctx.storage.setAlarm(Math.min(now + HANDOFF_ALARM_MS, until));

      return {
        result: textResult(`A person is asked to act in browser session ${id}.`),
        browserTime: metered.browserTime,
        handoff: { state: "started", until },
      };
    });
  }

  /**
   * Waits, for `caller`, on the handoff of the session `id` (#216) for at most {@link HANDOFF_WAIT_MS}: answers how it
   * ended (the person's Done or Failed, the provider's timeout, a decline) as soon as it does, every call waiting on it
   * alike; or, while it still waits for its person, that it does, until when (`handoff.state` `waiting`), so that the
   * client calls again. Not one of the object's calls in turn (`#serial`): the session's other calls (the panel's Live
   * View, its end, the alarm) go on meanwhile. While it waits it asks the provider every {@link HANDOFF_POLL_MS} whether
   * the handoff is still active, in case its end was not heard; nothing goes on once it answered.
   */
  async awaitHandoff(
    caller: SessionCaller,
    id: string,
    metering: SessionMetering,
  ): Promise<HandoffAnswer> {
    const deadline = this.#now() + this.handoffWait();

    for (;;) {
      const session = this.#stored();

      if (session === undefined || !owns(session, caller)) return untimed(unknownSession(id));

      if (session.closed !== null) return untimed(closedSession(id, session.closed.reason));
      const { handoff } = session;

      if (handoff === undefined) return untimed(NO_HANDOFF(id));

      if (handoff.ended !== undefined)
        return this.#kept(handoff.ended)
          ? await this.#serial(() => this.#takeKept(caller, id, undefined, metering))
          : untimed(NO_HANDOFF(id));

      const now = this.#now();

      if (now >= handoff.until) {
        await this.#serial(async () => {
          const latest = this.#stored();

          // The handoff this call waited on, not one started since.
          if (
            latest?.closed === null &&
            latest.handoff?.ended === undefined &&
            latest.handoff?.startedAt === handoff.startedAt
          )
            await this.#endHandoff(latest, { outcome: "timed_out" });
        });
        continue;
      }

      if (now >= deadline) return stillWaiting(id, handoff.until);

      const woke = await this.#sleepOrHear(
        Math.min(HANDOFF_POLL_MS, handoff.until - now, deadline - now),
      );

      // The handoff ended while this call waited: it answers that outcome, whatever another call did with it since.
      if (woke !== "slept") {
        const { heard } = woke;

        if (heard !== undefined)
          return await this.#serial(() => this.#takeKept(caller, id, heard, metering));
        continue;
      }

      if (this.#now() < deadline)
        await this.#serial(async () => {
          const latest = this.#stored();

          if (latest?.closed === null) await this.#pollHandoff(latest);
        });
    }
  }

  /**
   * The person declined the handoff of the session `id` when their client asked them (#216): it is ended as failed at
   * the provider, and the call takes that it was declined. A handoff that ended already answers how it did.
   */
  declineHandoff(
    caller: SessionCaller,
    id: string,
    metering: SessionMetering,
  ): Promise<SessionAnswer> {
    return this.#serial(async (): Promise<SessionAnswer> => {
      const session = this.#stored();

      if (session === undefined || !owns(session, caller)) return untimed(unknownSession(id));

      if (session.closed !== null) return untimed(closedSession(id, session.closed.reason));
      const { handoff } = session;

      if (handoff === undefined) return untimed(NO_HANDOFF(id));

      if (handoff.ended === undefined) {
        await this.#onTab(session, (tab) => tab.endHandoff("declined"));
        await this.#endHandoff(this.#stored() ?? session, { outcome: "declined" });
      }

      const latest = this.#stored() ?? session;

      return latest.closed === null && latest.handoff?.ended !== undefined
        ? this.#take(latest, id, latest.handoff.ended, metering)
        : untimed(closedSession(id, latest.closed?.reason ?? "provider"));
    });
  }

  /**
   * Whether `caller` has a handoff in the session (#216): one that waits for its person, or one that ended whose
   * outcome is still answered. A `browser_ask_human` call then waits on it or answers how it ended rather than asking a
   * person anew, which an approval rule does not hold again (the Tools part asks before its approvals).
   */
  hasHandoff(caller: SessionCaller): Promise<boolean> {
    const session = this.#stored();
    const handoff = session?.handoff;

    return Promise.resolve(
      session !== undefined &&
        owns(session, caller) &&
        session.closed === null &&
        handoff !== undefined &&
        (handoff.ended === undefined || this.#kept(handoff.ended)),
    );
  }

  /**
   * What the panel shows of the session (#216) to whom the Tools part lets watch it: whether it is open, and the handoff
   * that waits for its person, with what they are asked. The part has decided who may see it; the object checks the org.
   */
  watch(org: string): Promise<SessionWatch> {
    return Promise.resolve(this.#watch(org));
  }

  #watch(org: string): SessionWatch {
    const session = this.#stored();

    if (session === undefined || session.org !== org) return { kind: "unknown" };

    if (session.closed !== null) return { kind: "closed" };
    const { handoff } = session;

    return handoff === undefined || handoff.ended !== undefined
      ? { kind: "open" }
      : { kind: "open", handoff: { reason: handoff.reason ?? "", until: handoff.until } };
  }

  /**
   * A Live View link of the session's current tab (#216, ADR 0044), which starts a connection only within
   * {@link LIVE_VIEW_EXPIRES_MS}: a bearer link, minted for the panel of whom the Tools part lets watch (the session's
   * member) and never stored or logged. The member may type in it as in a handoff, so what they type is marked from now
   * on (`watched`), and the session's next call masks the fields they filled before it acts. Watching is a use of the
   * session: its idle minutes start again.
   */
  liveView(org: string): Promise<LiveViewAnswer> {
    return this.#serial(async (): Promise<LiveViewAnswer> => {
      const session = this.#stored();

      if (session === undefined || session.org !== org) return { kind: "unknown" };

      if (session.closed !== null) return { kind: "closed" };

      const minted = await this.#onTab(session, (tab) =>
        tab.liveView(LIVE_VIEW_EXPIRES_MS).pipe(
          Effect.flatMap((url) =>
            tab.watchInputs().pipe(
              Effect.as({ url, watched: true }),
              Effect.catchTag("BrowserProviderError", () =>
                Effect.succeed({ url, watched: false }),
              ),
            ),
          ),
        ),
      );

      if ("gone" in minted) {
        await this.#close(this.#stored() ?? session, "provider", "object");

        return { kind: "closed" };
      }

      if ("failed" in minted) return { kind: "failed" };
      const now = this.#now();
      const latest = this.#stored() ?? session;

      this.#save({
        ...latest,
        masks: withMasks(latest.masks, [TYPED_FIELDS]),
        usedAt: now,
        watched: latest.watched === "unmarked" || !minted.ok.watched ? "unmarked" : "marked",
        ...(minted.reconnected ? { reconnected: true } : {}),
      });

      if (latest.handoff === undefined || latest.handoff.ended !== undefined)
        await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

      return { kind: "minted", url: minted.ok.url, expiresAt: now + LIVE_VIEW_EXPIRES_MS };
    });
  }

  /**
   * Ends the session from the panel (#216: its member, or an org admin, as the Tools part decided): it closes as
   * `browser_close` would, and later calls answer that it is closed (`ended`). Answers its browser time since the call
   * before, which the part charges to its opener.
   */
  end(org: string): Promise<SessionEnded> {
    return this.#serial(async (): Promise<SessionEnded> => {
      const session = this.#stored();

      if (session === undefined || session.org !== org) return { kind: "unknown" };

      if (session.closed !== null) return { kind: "closed" };

      return { kind: "ended", browserTime: await this.#close(session, "ended", "call") };
    });
  }

  /**
   * What hears that the handoff started at `startedAt` ended at the provider: ends it, in turn with the object's other
   * calls. An end heard for another handoff (one before, whose listener lingered) is no end of the session's.
   */
  #hear(startedAt: number): (result: HandoffResult) => void {
    return (result) => this.#heard(startedAt, result);
  }

  #heard(startedAt: number, result: HandoffResult): void {
    this.#serial(async () => {
      const session = this.#stored();
      const handoff = session?.handoff;

      if (
        session?.closed !== null ||
        handoff === undefined ||
        handoff.ended !== undefined ||
        handoff.startedAt !== startedAt
      )
        return;

      const timedOut =
        !result.success &&
        (this.#now() >= handoff.until - HANDOFF_POLL_MS ||
          /time[ds]? ?out/i.test(result.reason ?? ""));

      await this.#endHandoff(session, {
        outcome: result.success ? "done" : timedOut ? "timed_out" : "failed",
        ...(result.reason === undefined ? {} : { why: result.reason }),
      });
    }).catch(() => undefined);
  }

  /**
   * The fields a person filled in the session's current tab (#216), as selectors to mask: those marked as typed into or
   * changed from their default, or, when `everyNonEmpty` (their typing could not be marked), every text field that is
   * not empty. Stops marking what they type unless `keepWatching` (a Live View is still open to them). Fails closed:
   * anything but a list of bare CSS selectors from the provider (a failure, a page's odd answer) masks every field that
   * takes text. Never throws.
   */
  async #filled(
    session: StoredSession,
    everyNonEmpty: boolean,
    keepWatching: boolean,
  ): Promise<ReadonlyArray<string>> {
    try {
      // Watching on, the listener is installed again: an object that restarted lost its on-new-document script.
      const filled = await this.#onTab(session, (tab) =>
        keepWatching
          ? tab.filledFields(everyNonEmpty).pipe(Effect.tap(() => Effect.ignore(tab.watchInputs())))
          : tab
              .filledFields(everyNonEmpty)
              .pipe(Effect.ensuring(Effect.ignore(tab.unwatchInputs()))),
      );

      if (!("ok" in filled)) return [EVERY_TEXT_FIELD];
      const fields = filled.ok.filter((field) => notCss(field) === undefined);

      return fields.length === filled.ok.length ? fields : [...fields, EVERY_TEXT_FIELD];
    } catch {
      return [EVERY_TEXT_FIELD];
    }
  }

  /**
   * The session before a call acts on its page, once a Live View was minted (#216): the fields its member filled in it
   * masked from then on, as after a handoff, and the query of every address. The member may still be watching (the frame
   * outlives its link), so what they type stays marked for the session's life. Unchanged when no one watched.
   */
  async #afterWatch(session: StoredSession): Promise<StoredSession> {
    const { watched } = session;

    if (watched === undefined) return session;
    const fields = await this.#filled(session, watched === "unmarked", true);
    const latest = this.#stored() ?? session;

    const masked: StoredSession = {
      ...latest,
      masks: withMasks(latest.masks, fields),
      maskUrls: true,
    };

    this.#save(masked);

    return masked;
  }

  /**
   * Ends the session's handoff with `ended`: masks the fields the person filled from then on (`#filled`), and the query
   * of every address, and wakes the calls waiting on it with how it ended. Its idle minutes start again.
   */
  async #endHandoff(
    session: StoredSession,
    ended: { readonly outcome: HandoffOutcome; readonly why?: string },
  ): Promise<void> {
    const { handoff } = session;

    if (handoff === undefined || handoff.ended !== undefined) return;

    // A Live View still open to the member keeps their typing marked until the session's next call.
    const fields = await this.#filled(
      session,
      handoff.unwatched === true || session.watched === "unmarked",
      session.watched !== undefined,
    );

    const now = this.#now();
    const latest = this.#stored() ?? session;

    if (latest.closed !== null) return;
    const done = { ...ended, at: now, startedAt: handoff.startedAt };
    // What the person was asked is for the session's page while the handoff waits only.
    const { reason: _reason, ...asked } = handoff;

    this.#save({
      ...latest,
      masks: withMasks(latest.masks, fields),
      maskUrls: true,
      handoff: { ...asked, ended: done },
      usedAt: now,
    });

    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);
    this.#wake(done);
  }

  /**
   * Asks the provider whether the session's handoff is still active, listening again for its end on the connection the
   * object holds, and marking what the person types on it (an object that restarted lost its on-new-document script).
   * One not active whose end was not heard is ended (`ended`) by a poll that finds it so at least
   * {@link HANDOFF_POLL_MS} after the first did: its end may still be on its way at the first. A browser gone closes the
   * session.
   */
  async #pollHandoff(session: StoredSession): Promise<void> {
    if (session.handoff === undefined || session.handoff.ended !== undefined) return;
    const { startedAt } = session.handoff;

    const active = await this.#onTab(session, (tab) =>
      tab.handoffActive(this.#hear(startedAt)).pipe(
        Effect.flatMap(
          (
            on,
          ): Effect.Effect<{ readonly on: boolean; readonly watched: boolean }, BrowserFailure> =>
            on
              ? tab.watchInputs().pipe(
                  Effect.as({ on, watched: true }),
                  Effect.catchTag("BrowserProviderError", () =>
                    Effect.succeed({ on, watched: false }),
                  ),
                )
              : Effect.succeed({ on, watched: true }),
        ),
      ),
    );

    if ("gone" in active) {
      await this.#close(this.#stored() ?? session, "provider", "object");

      return;
    }

    if (!("ok" in active)) {
      this.#inactiveSince = undefined;

      return;
    }

    if (active.ok.on) {
      this.#inactiveSince = undefined;
      const latest = this.#stored() ?? session;

      if (!active.ok.watched && latest.handoff !== undefined && latest.handoff.unwatched !== true)
        this.#save({ ...latest, handoff: { ...latest.handoff, unwatched: true } });

      return;
    }

    const now = this.#now();

    if (this.#inactiveSince === undefined) this.#inactiveSince = now;
    else if (now - this.#inactiveSince >= HANDOFF_POLL_MS)
      await this.#endHandoff(this.#stored() ?? session, { outcome: "ended" });
  }

  /** Whether a handoff's outcome is still answered: until {@link OUTCOME_KEPT_MS} after a call first took it. */
  #kept(ended: StoredEnded): boolean {
    return ended.takenAt === undefined || this.#now() - ended.takenAt < OUTCOME_KEPT_MS;
  }

  /**
   * The call's answer once the handoff ended: how, and the browser time since the call before. The outcome is kept, for
   * the other calls waiting on it and those within {@link OUTCOME_KEPT_MS} of its first answer, in the session's handoff
   * only when that is the one that ended: a call woken by its end may answer after a newer handoff started.
   */
  #take(
    session: StoredSession,
    id: string,
    ended: StoredEnded,
    metering: SessionMetering,
  ): SessionAnswer {
    const now = this.#now();
    const taken = ended.takenAt === undefined ? { ...ended, takenAt: now } : ended;
    const { handoff } = session;
    const metered = meterSession(session, now, metering.hourPriceMicros);

    this.#save(
      handoff?.startedAt === ended.startedAt
        ? { ...metered.session, handoff: { ...handoff, ended: taken } }
        : metered.session,
    );

    return { result: handoffEnded(id, ended), browserTime: metered.browserTime };
  }

  /**
   * The answer, in turn, of a call that waited on the handoff of the session `id`: the outcome it `heard` (kept or not:
   * another tool may have dropped it since), else the kept one.
   */
  async #takeKept(
    caller: SessionCaller,
    id: string,
    heard: StoredEnded | undefined,
    metering: SessionMetering,
  ): Promise<SessionAnswer> {
    const session = this.#stored();

    if (session === undefined || !owns(session, caller)) return untimed(unknownSession(id));

    if (session.closed !== null) return untimed(closedSession(id, session.closed.reason));
    const ended = session.handoff?.ended ?? heard;

    if (ended === undefined || (heard === undefined && !this.#kept(ended)))
      return untimed(NO_HANDOFF(id));

    return this.#take(session, id, heard ?? ended, metering);
  }

  /**
   * Waits `millis` on the object's clock, or less when the handoff ends (`heard`: how) or the session closes first
   * (`heard` absent).
   */
  async #sleepOrHear(
    millis: number,
  ): Promise<"slept" | { readonly heard: StoredEnded | undefined }> {
    let wake: ((ended: StoredEnded | undefined) => void) | undefined;

    const heard = new Promise<{ readonly heard: StoredEnded | undefined }>(
      (resolve) => (wake = (ended) => resolve({ heard: ended })),
    );

    // SAFETY: the promise's executor ran at once and set `wake`.
    const waiter = wake as (ended: StoredEnded | undefined) => void;

    this.#waiters.add(waiter);

    try {
      return await Effect.runPromise(
        Effect.race(
          Effect.promise(() => heard),
          this.#clock.sleep(Duration.millis(Math.max(0, millis))).pipe(Effect.as("slept" as const)),
        ),
      );
    } finally {
      this.#waiters.delete(waiter);
    }
  }

  /** Wakes the calls waiting on the handoff: with how it ended, or with nothing when the session closed. */
  #wake(ended?: StoredEnded): void {
    for (const waiter of this.#waiters) waiter(ended);
    this.#waiters.clear();
  }

  /**
   * Runs `use` on the session's current tab, on the connection the object holds (one that dropped is reached again
   * once) or a new one: its value, and whether it took a new connection; `gone` when the provider no longer has the
   * browser; or the provider's words when it failed.
   */
  async #onTab<A>(
    session: StoredSession,
    use: (tab: BrowserTab) => Effect.Effect<A, BrowserFailure>,
  ): Promise<
    | { readonly ok: A; readonly reconnected: boolean }
    | { readonly gone: true }
    | { readonly failed: string }
  > {
    const provider = this.sessionProvider(session.source);

    if (provider === undefined) return { gone: true };
    const view = { tab: session.tab, masks: session.masks };

    const run = (browser: ProviderBrowser) =>
      currentTab(browser, view).pipe(
        Effect.flatMap(({ tab }) => use(tab)),
        Effect.map((value) => ({ browser, value })),
      );

    const reach = provider.connect(session.browser);
    const cached = this.#browser;

    return await Effect.runPromise(
      (cached === undefined
        ? Effect.flatMap(reach, run)
        : run(cached).pipe(Effect.catchTag("BrowserGone", () => Effect.flatMap(reach, run)))
      ).pipe(
        Effect.map(({ browser, value }) => {
          this.#browser = browser;

          return { ok: value, reconnected: browser !== cached };
        }),
        Effect.catchTags({
          BrowserGone: () => Effect.succeed({ gone: true as const }),
          BrowserProviderError: (error) =>
            Effect.logWarning("browser session handoff step failed").pipe(
              Effect.as({ failed: error.message }),
            ),
        }),
      ),
    );
  }

  async #operate(
    session: StoredSession,
    id: string,
    operation: Exclude<SessionOperation, { readonly tool: "close" }>,
    metering: SessionMetering | undefined,
  ): Promise<SessionAnswer> {
    const charge: ClosingCharge = metering === undefined ? "none" : "call";
    const provider = this.sessionProvider(session.source);

    if (provider === undefined) {
      const browserTime = await this.#close(session, "provider", charge);

      return this.#closedAnswer(closedSession(id, "provider"), browserTime, metering);
    }

    const view = { tab: session.tab, masks: session.masks, maskUrls: session.maskUrls };

    const run = (browser: ProviderBrowser) =>
      runOperation(browser, view, operation).pipe(Effect.map((done) => ({ browser, done })));

    const reach = provider.connect(session.browser);
    const cached = this.#browser;

    const outcome = await Effect.runPromise(
      (cached === undefined
        ? Effect.flatMap(reach, run)
        : // A kept connection that dropped is reached again once; the browser is gone only if that fails too.
          run(cached).pipe(Effect.catchTag("BrowserGone", () => Effect.flatMap(reach, run)))
      ).pipe(
        Effect.map((ran) => ({ ran })),
        Effect.catchTags({
          BrowserGone: () => Effect.succeed({ gone: true as const }),
          BrowserProviderError: (error) =>
            Effect.logWarning("browser session operation failed").pipe(
              Effect.annotateLogs({ tool: operation.tool }),
              Effect.as({ failed: error.message }),
            ),
        }),
      ),
    );

    if ("gone" in outcome) {
      const browserTime = await this.#close(this.#stored() ?? session, "provider", charge);

      return this.#closedAnswer(closedSession(id, "provider"), browserTime, metering);
    }

    const now = this.#now();
    const latest = this.#stored() ?? session;

    // The stretch since the call before is committed with the call's last write (an unmetered call leaves it to the
    // next): a call that fails before it is not charged, and its stretch is not lost.
    const metered =
      metering === undefined ? undefined : meterSession(latest, now, metering.hourPriceMicros);

    const done =
      "failed" in outcome
        ? { result: toolError(outcome.failed), changes: {} }
        : {
            result: outcome.ran.done.result,
            changes: {
              tab: outcome.ran.done.tab,
              reconnected: latest.reconnected === true || outcome.ran.browser !== cached,
            },
          };

    if ("ran" in outcome) this.#browser = outcome.ran.browser;
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);
    this.#save({ ...(metered?.session ?? latest), usedAt: now, ...done.changes });

    return metered === undefined
      ? untimed(done.result)
      : { result: done.result, browserTime: metered.browserTime };
  }

  /** A call's answer when it found the session's browser gone and closed the session. */
  #closedAnswer(
    result: Schema.JsonObject,
    browserTime: BrowserTime,
    metering: SessionMetering | undefined,
  ): SessionAnswer {
    return metering === undefined
      ? { result, session: "closed" }
      : { result, browserTime, session: "closed" };
  }

  /**
   * Closes the session once it was idle long enough, does what is left of a close (its usage record, its report), and
   * forgets a closed one once its day is over.
   */
  override alarm(): Promise<void> {
    return this.#serial(async () => {
      const session = this.#stored();

      if (session === undefined) {
        // Nothing to keep: a session that does not decode is forgotten.
        await this.ctx.storage.deleteAll();

        return;
      }

      const now = this.#now();

      if (session.closed !== null) {
        const forgetAt = session.closed.at + CLOSED_KEPT_MS;

        if (now >= forgetAt) {
          await forgottenUnsettled("browser session", session);
          await this.ctx.storage.deleteAll();
        } else if (session.unrecorded === true || session.owed !== undefined)
          await this.#settle(session);
        else await this.ctx.storage.setAlarm(forgetAt);

        return;
      }

      const { handoff } = session;

      // While a handoff waits for its person (#216) the session stays open: its alarm asks the provider about it, which
      // keeps the browser alive and hears an end its object missed, until the handoff times out.
      if (handoff !== undefined && handoff.ended === undefined) {
        if (now >= handoff.until) await this.#endHandoff(session, { outcome: "timed_out" });
        else await this.#pollHandoff(session);
        const after = this.#stored();

        if (after?.closed === null) {
          const waiting = after.handoff !== undefined && after.handoff.ended === undefined;

          await this.ctx.storage.setAlarm(
            waiting
              ? Math.min(this.#now() + HANDOFF_ALARM_MS, after.handoff.until)
              : after.usedAt + IDLE_TIMEOUT_MS,
          );
        }

        return;
      }

      const idleAt = session.usedAt + IDLE_TIMEOUT_MS;

      if (now < idleAt) {
        await this.ctx.storage.setAlarm(idleAt);

        return;
      }

      // No call is there to charge the browser time since the last one: the object reports it to the Tools part.
      await this.#close(session, "idle", "object");
    });
  }
}

/** The namespace of the sessions' objects, in the state Worker (`BROWSER_SESSIONS`). */
export type BrowserSessionNamespace = DurableObjectNamespace<BrowserSession>;

/** The object of the session `id` of `org`: named by both, so an id reaches only its own org's session. */
export const browserSessionStub = (namespace: BrowserSessionNamespace, org: string, id: string) =>
  namespace.getByName(`${org}:${id}`);

/**
 * A metered call's answer, from an object from #214 on, or the bare tool result of one from before (docs/DEVELOPMENT.md,
 * "State RPC: expand, then contract"), which used no browser time: a tool result has no `result`.
 */
const asAnswer = (answer: SessionAnswer | Schema.JsonObject): SessionAnswer =>
  // SAFETY: an object from #214 on answers a metered call with a `SessionAnswer`, whose `result` a tool result lacks.
  "result" in answer ? (answer as SessionAnswer) : untimed(answer as Schema.JsonObject);

/**
 * How the Tools part reaches its org's sessions: opening one (with its id), calling a tool in one, and closing one,
 * each metered (#214): with the session's browser time since the call before and its cost.
 */
export interface BrowserSessions {
  /**
   * Opens a session on a browser of the provider `source` (the browser toolkit's source), from the browser profile
   * `profile` when given.
   */
  readonly open: (
    caller: SessionCaller,
    source: string,
    url: string | undefined,
    metering: SessionMetering,
    profile?: SessionProfile,
  ) => Promise<SessionAnswer & { readonly id: string }>;
  readonly operate: (
    caller: SessionCaller,
    operation: Exclude<SessionOperation, { readonly tool: "close" }>,
    metering: SessionMetering,
  ) => Promise<SessionAnswer>;
  /** Closes the session `sessionId`, reading its state first for a save. */
  readonly close: (
    caller: SessionCaller,
    sessionId: string,
    save: boolean,
    metering: SessionMetering,
  ) => Promise<SessionClosed>;
  /** Deletes the session `sessionId` of `org` at once, without a usage record: the org was deleted. */
  readonly purge: (org: string, sessionId: string) => Promise<void>;
  /** `browser_ask_human` (#216): starts a handoff, or answers the one asked before, waiting or ended. */
  readonly askHuman: (
    caller: SessionCaller,
    sessionId: string,
    reason: string,
    metering: SessionMetering,
    options?: { readonly mayStart?: boolean },
  ) => Promise<HandoffAnswer>;
  /**
   * Waits on the handoff of the session `sessionId` (#216) for at most {@link HANDOFF_WAIT_MS} (45 seconds): how it
   * ended, or that it still waits.
   */
  readonly awaitHandoff: (
    caller: SessionCaller,
    sessionId: string,
    metering: SessionMetering,
  ) => Promise<HandoffAnswer>;
  /** The person declined the handoff when their client asked them (#216). */
  readonly declineHandoff: (
    caller: SessionCaller,
    sessionId: string,
    metering: SessionMetering,
  ) => Promise<SessionAnswer>;
  /** Whether `caller` has a handoff in the session `sessionId`, waiting or with its outcome kept (#216). */
  readonly hasHandoff: (caller: SessionCaller, sessionId: string) => Promise<boolean>;
  /** What the panel shows of the session `sessionId` of `org` (#216); the Tools part decided who may see it. */
  readonly watch: (org: string, sessionId: string) => Promise<SessionWatch>;
  /** A Live View link of the session `sessionId` of `org` (#216), for whom the Tools part lets watch it. */
  readonly liveView: (org: string, sessionId: string) => Promise<LiveViewAnswer>;
  /** Ends the session `sessionId` of `org` from the panel (#216). */
  readonly end: (org: string, sessionId: string) => Promise<SessionEnded>;
}

/** The sessions behind `namespace`. An id that is not one of a session's answers as unknown without reaching any. */
export const browserSessions = (namespace: BrowserSessionNamespace): BrowserSessions => ({
  open: async (caller, source, url, metering, profile) => {
    const id = newSessionId();

    const answer = await browserSessionStub(namespace, caller.org, id).open(
      caller,
      id,
      source,
      url,
      profile,
      metering,
    );

    return { ...asAnswer(answer), id };
  },
  operate: async (caller, operation, metering) => {
    const id = operation.args.sessionId;

    if (!SESSION_ID.test(id)) return untimed(unknownSession(id));

    return asAnswer(
      await browserSessionStub(namespace, caller.org, id).operate(caller, id, operation, metering),
    );
  },
  close: async (caller, id, save, metering) => {
    if (!SESSION_ID.test(id)) return { kind: "answer", result: unknownSession(id) };

    return await browserSessionStub(namespace, caller.org, id).close(caller, id, save, metering);
  },
  purge: async (org, id) => {
    if (SESSION_ID.test(id)) await browserSessionStub(namespace, org, id).purge();
  },
  askHuman: async (caller, id, reason, metering, options = {}) =>
    SESSION_ID.test(id)
      ? await browserSessionStub(namespace, caller.org, id).askHuman(
          caller,
          id,
          reason,
          metering,
          options,
        )
      : untimed(unknownSession(id)),
  awaitHandoff: async (caller, id, metering) =>
    SESSION_ID.test(id)
      ? await browserSessionStub(namespace, caller.org, id).awaitHandoff(caller, id, metering)
      : untimed(unknownSession(id)),
  declineHandoff: async (caller, id, metering) =>
    SESSION_ID.test(id)
      ? await browserSessionStub(namespace, caller.org, id).declineHandoff(caller, id, metering)
      : untimed(unknownSession(id)),
  hasHandoff: async (caller, id) =>
    SESSION_ID.test(id)
      ? await browserSessionStub(namespace, caller.org, id).hasHandoff(caller)
      : false,
  watch: async (org, id) =>
    SESSION_ID.test(id)
      ? await browserSessionStub(namespace, org, id).watch(org)
      : { kind: "unknown" },
  liveView: async (org, id) =>
    SESSION_ID.test(id)
      ? await browserSessionStub(namespace, org, id).liveView(org)
      : { kind: "unknown" },
  end: async (org, id) =>
    SESSION_ID.test(id)
      ? await browserSessionStub(namespace, org, id).end(org)
      : { kind: "unknown" },
});

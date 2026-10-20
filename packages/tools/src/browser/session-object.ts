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
 * whole browser time and cost, naming the browser profile it opened from (`insertBrowserSessionRecord`); when its
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
import { Clock, Effect, Option, Schema } from "effect";
import type { UsageRun } from "@commissary/auth";
import type { OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import type { ToolsControlPlane } from "../env.ts";
import { BROWSER_TOOLKIT } from "../toolkits/built-in.ts";
import { type BrowserSessionRecord, insertBrowserSessionRecord } from "../usage/record.ts";
import { BROWSER_RUN } from "./browser-run.ts";
import { browserRunSessions, type BrowserRunSessionBinding } from "./browser-run-sessions.ts";
import { type BrowserTime, browserTimeCost, type Timed, untimed } from "./browser-time.ts";
import type { BrowserSessionProvider, ProviderBrowser, StorageState } from "./provider.ts";
import { runOperation, textResult, toolError } from "./session.ts";
import { IDLE_TIME, IDLE_TIMEOUT_MS, notCss, type SessionOperation } from "./session-tools.ts";

/** How long a closed session answers that it is closed, before it answers as unknown. */
export const CLOSED_KEPT_MS = 24 * 60 * 60_000;

/** How soon a closed session's alarm tries again to write its usage record or report its close (#214). */
export const SETTLE_RETRY_MS = 60_000;

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
}

/** Why a session closed: `browser_close`, its idle time, or the provider closing its browser. */
const ClosedReason = Schema.Literals(["closed", "idle", "provider"]);

type ClosedReason = typeof ClosedReason.Type;

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
};

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
  const costMicros = free ? 0 : browserTimeCost(browserMs, session.hourPriceMicros ?? 0);

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
const settled = (
  session: StoredSession,
  done: { readonly recorded: boolean; readonly reported: boolean },
): StoredSession => {
  const { unrecorded, owed, ...rest } = session;

  return {
    ...rest,
    ...(unrecorded === true && !done.recorded ? { unrecorded } : {}),
    ...(owed !== undefined && !done.reported ? { owed } : {}),
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
  protected writeRecord(record: BrowserSessionRecord): Promise<void> {
    return insertBrowserSessionRecord(this.env.USAGE, record);
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
      ...(charge === "object" ? { owed: closing.browserTime.costMicros } : {}),
    };

    this.#save(closed);
    await this.ctx.storage.setAlarm(now + SETTLE_RETRY_MS);
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

    const recorded =
      session.unrecorded !== true || (await this.#record(session, session.closed.at));

    const reported = session.owed === undefined || (await this.#report(session, session.owed));
    const left = settled(session, { recorded, reported });

    this.#save(left);
    await this.ctx.storage.setAlarm(
      recorded && reported ? session.closed.at + CLOSED_KEPT_MS : this.#now() + SETTLE_RETRY_MS,
    );
  }

  /** Writes the usage record of `session`, closed at `at` (#214); whether it was written (a failure is logged). */
  async #record(session: StoredSession, at: number): Promise<boolean> {
    return await Effect.runPromise(
      Effect.tryPromise(() =>
        this.writeRecord({
          sessionId: session.id ?? this.#nameId(),
          orgId: session.org,
          principalId: session.principal,
          memberId: session.member ?? undefined,
          toolkitId: session.toolkit ?? BROWSER_TOOLKIT,
          openedAt: session.openedAt,
          browserMs: Math.max(0, at - session.openedAt),
          costMicros: session.costMicros ?? 0,
          profileId: session.profile,
          run: session.run,
        }),
      ).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("browser session usage record write failed").pipe(
            Effect.annotateLogs({ error: error.message }),
            Effect.as(false),
          ),
        ),
      ),
    );
  }

  /**
   * Reports the alarm's close of `session` to its org's Tools part, which charges `costMicros` of its browser time and
   * forgets the session; whether it went through (a failure is logged).
   */
  async #report(session: StoredSession, costMicros: number): Promise<boolean> {
    return await Effect.runPromise(
      Effect.tryPromise(() =>
        this.controlPlane(session.org)
          .tools()
          .browserSessionClosed(session.id ?? this.#nameId(), costMicros),
      ).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("browser session close not reported").pipe(
            Effect.annotateLogs({ error: error.message }),
            Effect.as(false),
          ),
        ),
      ),
    );
  }

  /** The session's id from the name its object was reached by, `<org>:<id>` ({@link browserSessionStub}). */
  #nameId(): string {
    const name = this.ctx.id.name ?? "";

    return name.slice(name.lastIndexOf(":") + 1);
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

    return await this.#operate(session, id, operation, metering);
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
      this.#save({ ...session, masks: [...new Set([...session.masks, ...selectors])] });

      return true;
    });
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

    const view = { tab: session.tab, masks: session.masks };

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
          if (session.unrecorded === true || session.owed !== undefined)
            await Effect.runPromise(
              Effect.logError("browser session forgotten before its close was recorded").pipe(
                Effect.annotateLogs({
                  unrecorded: session.unrecorded === true,
                  owed: session.owed ?? 0,
                }),
              ),
            );

          await this.ctx.storage.deleteAll();
        } else if (session.unrecorded === true || session.owed !== undefined)
          await this.#settle(session);
        else await this.ctx.storage.setAlarm(forgetAt);

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
});

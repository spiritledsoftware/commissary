/**
 * The browser session's Durable Object (#213, ADR 0039): one object per session, in the state Worker beside the
 * ControlPlane (ADR 0030), which holds the session's browser at the provider and runs its tools' calls
 * (`session.ts`). The org's Tools part opens and reaches it ({@link browserSessions}): MCP calls are stateless, so
 * `browser_open` answers the session's id and the other tools take it.
 *
 * **Ownership.** A session belongs to the org, member and principal that opened it ({@link SessionCaller}: an API key's
 * principal is the key, an Access user's the person; a hosted agent's run, #232, will be a principal of its own). The
 * object is named by its org and id, so another org's call with the same id reaches another, empty object, and it
 * keeps its owner: a call of anyone else answers "unknown session", exactly as an id that was never opened.
 *
 * **Lifetime.** It closes after `IDLE_TIMEOUT_MS` (10 minutes) without a call (its alarm), or with `browser_close`,
 * well within Browser Run's `keep_alive` of 20 minutes, which counts from the browser's last command. A browser the
 * provider closed itself (Browser Run on a release of its own) closes the session too. A closed session answers that it
 * is closed for {@link CLOSED_KEPT_MS}, then forgets everything and answers as unknown. Nothing of the pages is stored:
 * only the owner, the provider and its id of the browser, the browser profile it opened from, whether the browser was
 * reached again, the current tab, the fields to mask and the times.
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
 */
import { DurableObject } from "cloudflare:workers";
import { Clock, Effect, Option, Schema } from "effect";
import { BROWSER_RUN } from "./browser-run.ts";
import { browserRunSessions, type BrowserRunSessionBinding } from "./browser-run-sessions.ts";
import type { BrowserSessionProvider, ProviderBrowser, StorageState } from "./provider.ts";
import { runOperation, textResult, toolError } from "./session.ts";
import { IDLE_TIME, IDLE_TIMEOUT_MS, notCss, type SessionOperation } from "./session-tools.ts";

/** How long a closed session answers that it is closed, before it answers as unknown. */
export const CLOSED_KEPT_MS = 24 * 60 * 60_000;

/**
 * What the session's object reads from the state Worker's env: the optional `browser` binding, over which it reaches
 * Browser Run's browsers (`@cloudflare/playwright` reaches them with its `fetch`).
 */
export interface BrowserSessionEnv {
  readonly BROWSER?: BrowserRunSessionBinding | undefined;
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
});

type StoredSession = typeof StoredSession.Type;

const decodeStored = Schema.decodeUnknownOption(StoredSession);

const SESSION = "session";

/** A session id: `bs_` and 32 hex digits, random. */
const SESSION_ID = /^bs_[0-9a-f]{32}$/;

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
 * browser's state to save into it.
 */
export type SessionClosed =
  | { readonly kind: "answer"; readonly result: Schema.JsonObject }
  | { readonly kind: "closed"; readonly profile?: string; readonly saved?: SavedState };

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

  /** Marks the session closed, ends its browser unless the provider did, and keeps that it closed for a day. */
  async #close(session: StoredSession, reason: ClosedReason): Promise<void> {
    const now = this.#now();

    this.#save({ ...session, closed: { at: now, reason } });
    await this.ctx.storage.setAlarm(now + CLOSED_KEPT_MS);
    const browser = this.#browser;

    this.#browser = undefined;

    if (reason === "provider") return;
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

  /**
   * Opens the session `id` for `caller`, with a new browser of the provider `source` (the browser toolkit's), started
   * from the browser profile `profile` when given (#215), and loads `url` in it when given. Answers the tool result: the
   * id, or why the provider refused (its account's limit included).
   */
  open(
    caller: SessionCaller,
    id: string,
    source: string,
    url?: string,
    profile?: SessionProfile,
  ): Promise<Schema.JsonObject> {
    return this.#serial(() => this.#open(caller, id, source, url, profile));
  }

  async #open(
    caller: SessionCaller,
    id: string,
    source: string,
    url: string | undefined,
    profile: SessionProfile | undefined,
  ): Promise<Schema.JsonObject> {
    const provider = this.sessionProvider(source);

    if (provider === undefined || this.ctx.storage.kv.get(SESSION) !== undefined)
      return toolError("The browser could not open a session here.");

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

    if ("refused" in opened) return toolError(opened.refused);
    const now = this.#now();

    this.#browser = opened.browser;

    const session: StoredSession = {
      org: caller.org,
      member: caller.member ?? null,
      principal: caller.principal,
      source,
      browser: opened.browser.id,
      ...(profile === undefined ? {} : { profile: profile.id }),
      openedAt: now,
      usedAt: now,
      tab: 0,
      masks: [],
      closed: null,
    };

    this.#save(session);
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

    const intro = textResult(
      `Browser session ${id} is open. Pass ${id} as sessionId to the other browser tools; the session closes after ` +
        `${IDLE_TIME}, or with browser_close.`,
    );

    if (url === undefined) return intro;

    const loaded = await this.#operate(session, id, {
      tool: "navigate",
      args: { sessionId: id, url },
    });

    // SAFETY: every tool result of a session's is built with a `content` array (`session.ts`).
    const content = [
      ...(intro["content"] as Schema.MutableJsonArray),
      ...(loaded["content"] as Schema.MutableJsonArray),
    ];

    return loaded["isError"] === true ? { content, isError: true } : { content };
  }

  /** Runs `operation` in the session `id` for `caller`: its tool result, or that the session is unknown or closed. */
  operate(
    caller: SessionCaller,
    id: string,
    operation: Exclude<SessionOperation, { readonly tool: "close" }>,
  ): Promise<Schema.JsonObject> {
    return this.#serial(async () => {
      const session = this.#stored();

      if (session === undefined || !owns(session, caller)) return unknownSession(id);

      if (session.closed !== null) return closedSession(id, session.closed.reason);

      return await this.#operate(session, id, operation);
    });
  }

  /**
   * Closes the session `id` for `caller`: the session's own `browser_close`. With `save`, the browser's state is read
   * first and handed back with the profile the session opened from, for the Tools part to save (or refuse); without a
   * profile there is nothing to read. The session closes whether or not the state could be read.
   */
  close(caller: SessionCaller, id: string, save: boolean): Promise<SessionClosed> {
    return this.#serial(async (): Promise<SessionClosed> => {
      const session = this.#stored();

      if (session === undefined || !owns(session, caller))
        return { kind: "answer", result: unknownSession(id) };

      if (session.closed !== null)
        return { kind: "answer", result: closedSession(id, session.closed.reason) };

      const { profile } = session;

      if (profile === undefined) {
        await this.#close(session, "closed");

        return { kind: "closed" };
      }

      if (!save) {
        await this.#close(session, "closed");

        return { kind: "closed", profile };
      }

      const saved = await this.#state(session);

      await this.#close(session, "closed");

      return { kind: "closed", profile, saved };
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
  ): Promise<Schema.JsonObject> {
    const provider = this.sessionProvider(session.source);

    if (provider === undefined) {
      await this.#close(session, "provider");

      return closedSession(id, "provider");
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
      await this.#close(session, "provider");

      return closedSession(id, "provider");
    }

    const now = this.#now();
    const latest = this.#stored() ?? session;

    if ("failed" in outcome) {
      this.#save({ ...latest, usedAt: now });
      await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

      return toolError(outcome.failed);
    }

    const { browser, done } = outcome.ran;
    const reconnected = latest.reconnected === true || browser !== cached;

    this.#browser = browser;
    this.#save({ ...latest, usedAt: now, tab: done.tab, reconnected });
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

    return done.result;
  }

  /** Closes the session once it was idle long enough, and forgets a closed one once its day is over. */
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

        if (now >= forgetAt) await this.ctx.storage.deleteAll();
        else await this.ctx.storage.setAlarm(forgetAt);

        return;
      }

      const idleAt = session.usedAt + IDLE_TIMEOUT_MS;

      if (now >= idleAt) await this.#close(session, "idle");
      else await this.ctx.storage.setAlarm(idleAt);
    });
  }
}

/** The namespace of the sessions' objects, in the state Worker (`BROWSER_SESSIONS`). */
export type BrowserSessionNamespace = DurableObjectNamespace<BrowserSession>;

/** The object of the session `id` of `org`: named by both, so an id reaches only its own org's session. */
export const browserSessionStub = (namespace: BrowserSessionNamespace, org: string, id: string) =>
  namespace.getByName(`${org}:${id}`);

/** How the Tools part reaches its org's sessions: opening one, calling a tool in one, and closing one. */
export interface BrowserSessions {
  /**
   * Opens a session on a browser of the provider `source` (the browser toolkit's source), from the browser profile
   * `profile` when given.
   */
  readonly open: (
    caller: SessionCaller,
    source: string,
    url: string | undefined,
    profile?: SessionProfile,
  ) => Promise<Schema.JsonObject>;
  readonly operate: (
    caller: SessionCaller,
    operation: Exclude<SessionOperation, { readonly tool: "close" }>,
  ) => Promise<Schema.JsonObject>;
  /** Closes the session `sessionId`, reading its state first for a save. */
  readonly close: (
    caller: SessionCaller,
    sessionId: string,
    save: boolean,
  ) => Promise<SessionClosed>;
}

/** The sessions behind `namespace`. An id that is not one of a session's answers as unknown without reaching any. */
export const browserSessions = (namespace: BrowserSessionNamespace): BrowserSessions => ({
  open: async (caller, source, url, profile) => {
    const id = newSessionId();

    return await browserSessionStub(namespace, caller.org, id).open(
      caller,
      id,
      source,
      url,
      profile,
    );
  },
  operate: async (caller, operation) => {
    const id = operation.args.sessionId;

    if (!SESSION_ID.test(id)) return unknownSession(id);

    return await browserSessionStub(namespace, caller.org, id).operate(caller, id, operation);
  },
  close: async (caller, id, save) => {
    if (!SESSION_ID.test(id)) return { kind: "answer", result: unknownSession(id) };

    return await browserSessionStub(namespace, caller.org, id).close(caller, id, save);
  },
});

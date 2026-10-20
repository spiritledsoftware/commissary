/**
 * Browser Run's browsers for interactive sessions (#213), over the deployment's `browser` binding with
 * `@cloudflare/playwright` (Cloudflare's fork of Playwright; `@cloudflare/playwright-mcp` is archived, so the session
 * tools are Commissary's own code on it): a {@link BrowserSessionProvider}. Playwright is imported on a session's first
 * call ({@link playwright}), not when the state Worker starts.
 *
 * A session's browser is acquired once with a `keep_alive` of {@link KEEP_ALIVE_MS} and reached again by its session
 * id with `connect()` on later calls (Browser Run's session reuse); its tabs are the pages of the browser's default
 * context, which outlives a connection. Closing it sends CDP's `Browser.close`, as closing a connected browser only
 * disconnects.
 *
 * Failures: Browser Run's refusal of a new browser with 429 (the account's concurrent browsers, or new browsers per
 * second) is {@link BrowserLimitReached}; a session Browser Run no longer lists (closed on a release of its own, or
 * after its `keep_alive`), or a connection that dropped during a call, is {@link BrowserGone}; Playwright's own
 * failures (a ref that names nothing, a timeout) are its message's first line, at most 500 characters. Every operation
 * is bounded by Playwright's timeouts and by {@link OPERATION_TIMEOUT}. A browser acquired but not reached is ended, as
 * it would stay open until its `keep_alive`.
 *
 * The snapshot is Playwright's snapshot for a model (`_snapshotForAI`, which Playwright MCP uses: its elements' refs
 * are what `aria-ref=` locators resolve); nothing here evaluates JavaScript in the page. The selectors the session
 * gives (masked fields, `wait_for`'s) go to Playwright as CSS (`css=`), never as another selector engine.
 */
import type { Browser, BrowserContext, Page } from "@cloudflare/playwright";
import { Effect, Predicate } from "effect";
import {
  BrowserGone,
  BrowserLimitReached,
  BrowserProviderError,
  type BrowserFailure,
  type BrowserSessionProvider,
  type BrowserTab,
  type ProviderBrowser,
} from "./provider.ts";

/**
 * Browser Run's `keep_alive`: how long a browser stays open without commands. Cloudflare's documentation (Browser Run's
 * limits, and its Playwright and Puppeteer pages, October 2026) allows up to 20 minutes; the comment of
 * `@cloudflare/playwright` 1.3.6's types (10 seconds to 10 minutes) predates that. A session closes after 10 idle
 * minutes (`IDLE_TIMEOUT_MS`, `session-tools.ts`), and its last command counts from about its last call, so its own
 * alarm ends the browser first.
 */
const KEEP_ALIVE_MS = 20 * 60_000;

/** Playwright's timeout for an action on a page. */
const ACTION_TIMEOUT_MS = 30_000;

/** How long one operation may take, whatever Playwright waits for. */
const OPERATION_TIMEOUT = "2 minutes";

/** How long ending a browser that was acquired but not reached may take. */
const END_TIMEOUT = "10 seconds";

const MAX_MESSAGE_LENGTH = 500;

/** The binding as `@cloudflare/playwright` reaches it (its `fetch`), beside the Quick Actions' `quickAction()`. */
export type BrowserRunSessionBinding = Pick<BrowserRun, "fetch">;

const fail = (message: string) => new BrowserProviderError({ message });

/**
 * `@cloudflare/playwright`, imported when a session first needs it: the module is large, and a state Worker that
 * never opens a session does not load it (docs/ARCHITECTURE.md "Tools" has the bundle's numbers).
 */
const playwright = Effect.tryPromise({
  try: () => import("@cloudflare/playwright"),
  catch: () => fail("Browser Run's Playwright could not be loaded"),
});

/** The first line of a failure's message, at most {@link MAX_MESSAGE_LENGTH} characters. */
const firstLine = (message: string): string =>
  (message.split("\n", 1)[0] ?? "").slice(0, MAX_MESSAGE_LENGTH);

/** Browser Run's HTTP status in `@cloudflare/playwright`'s failure message (`… code: 429: message: …`). */
const statusOf = (message: string): number | undefined => {
  const match = /code: (\d{3})\b/.exec(message);

  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** `effect`, failing once it took longer than {@link OPERATION_TIMEOUT}. */
const bounded = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: OPERATION_TIMEOUT,
      orElse: () => Effect.fail(fail(`Browser Run did not answer within ${OPERATION_TIMEOUT}`)),
    }),
  );

/** Runs `run` on `browser`: a failure once the connection dropped is {@link BrowserGone}, else Playwright's words. */
const attempt = <A>(browser: Browser, run: () => Promise<A>): Effect.Effect<A, BrowserFailure> =>
  bounded(
    Effect.tryPromise({
      try: run,
      catch: (error): BrowserFailure =>
        browser.isConnected()
          ? fail(firstLine(error instanceof Error ? error.message : String(error)))
          : new BrowserGone(),
    }),
  );

/** Playwright's snapshot for a model, which its client page has but does not type (`Page._snapshotForAI`). */
interface SnapshotForAi {
  _snapshotForAI(options?: { readonly timeout?: number }): Promise<{ readonly full: string }>;
}

/**
 * Whether `page` has Playwright's snapshot for a model: `@cloudflare/playwright`'s client page does
 * (lib/playwright-core/src/client/page.js), untyped as Playwright keeps it internal; Playwright MCP reads its
 * snapshots the same way.
 */
const snapshotsForAi = (page: Page): page is Page & SnapshotForAi =>
  Predicate.hasProperty(page, "_snapshotForAI") && Predicate.isFunction(page._snapshotForAI);

const tab = (browser: Browser, page: Page): BrowserTab => {
  const run = <A>(body: () => Promise<A>) => attempt(browser, body);
  const element = (ref: string) => page.locator(`aria-ref=${ref}`);

  return {
    url: () => page.url(),
    title: () => run(() => page.title()),
    goto: (url, timeout) => run(() => page.goto(url, { timeout })).pipe(Effect.asVoid),
    back: (timeout) => run(() => page.goBack({ timeout })).pipe(Effect.asVoid),
    forward: (timeout) => run(() => page.goForward({ timeout })).pipe(Effect.asVoid),
    snapshot: () =>
      snapshotsForAi(page)
        ? run(async () => (await page._snapshotForAI({ timeout: ACTION_TIMEOUT_MS })).full)
        : Effect.fail(fail("this Playwright takes no snapshots")),
    countMatching: (selector) =>
      run(async () => {
        const counts = await Promise.all(
          page.frames().map((frame) => frame.locator(`css=${selector}`).count()),
        );

        return counts.reduce((sum, count) => sum + count, 0);
      }),
    maskedRefs: (refs, selector) =>
      run(async () => {
        const masked = await Promise.all(
          refs.map(async (ref) => {
            const found = element(ref);

            // An element that cannot be found cannot be cleared: it counts as matching (masking fails closed).
            if ((await found.count()) === 0) return true;

            return (await found.and(page.locator(`css=${selector}`)).count()) > 0;
          }),
        );

        return new Set(refs.filter((_, index) => masked[index] === true));
      }),
    click: (ref, { button, doubleClick }) =>
      run(() => (doubleClick ? element(ref).dblclick({ button }) : element(ref).click({ button }))),
    fill: (ref, text) => run(() => element(ref).fill(text)),
    press: (key) => run(() => page.keyboard.press(key)),
    selectOption: (ref, values) =>
      run(() => element(ref).selectOption([...values])).pipe(Effect.asVoid),
    hover: (ref) => run(() => element(ref).hover()),
    waitFor: (condition, timeout) =>
      run(() =>
        ("text" in condition
          ? page.getByText(condition.text)
          : page.locator(`css=${condition.selector}`)
        )
          .first()
          .waitFor({ state: "visible", timeout }),
      ),
    screenshot: ({ fullPage, type, mask }) =>
      run(async () => {
        // Every frame's fields: a locator of the page does not reach into its frames.
        const masked = page
          .frames()
          .flatMap((frame) => mask.map((each) => frame.locator(`css=${each}`)));

        return new Uint8Array(await page.screenshot({ fullPage, type, mask: masked }));
      }),
    focus: () => run(() => page.bringToFront()),
  };
};

/** The context whose pages are the session's tabs: the browser's default one, which outlives a connection. */
const contextOf = async (browser: Browser): Promise<BrowserContext> => {
  const context = browser.contexts()[0] ?? (await browser.newContext());

  context.setDefaultTimeout(ACTION_TIMEOUT_MS);

  return context;
};

/** Ends `browser` at Browser Run: CDP's `Browser.close`, as closing a connected browser only disconnects. */
const end = (browser: Browser) =>
  Effect.tryPromise(async () => {
    const cdp = await browser.newBrowserCDPSession();

    await cdp.send("Browser.close");
  }).pipe(
    Effect.ignore,
    Effect.andThen(Effect.tryPromise(() => browser.close()).pipe(Effect.ignore)),
  );

const reached = (browser: Browser, id: string, context: BrowserContext): ProviderBrowser => ({
  id,
  tabs: () =>
    browser.isConnected()
      ? Effect.succeed(context.pages().map((page) => tab(browser, page)))
      : Effect.fail(new BrowserGone()),
  newTab: () =>
    attempt(browser, () => context.newPage()).pipe(Effect.map((page) => tab(browser, page))),
  close: () => end(browser).pipe(Effect.timeout(OPERATION_TIMEOUT), Effect.ignore),
});

/** Browser Run's session `id` reached over `browser`, with its default context. */
const withContext = (browser: Browser, id: string) =>
  Effect.tryPromise({
    try: () => contextOf(browser),
    catch: (error): BrowserFailure =>
      browser.isConnected()
        ? fail(firstLine(error instanceof Error ? error.message : String(error)))
        : new BrowserGone(),
  }).pipe(Effect.map((context) => reached(browser, id, context)));

/** `@cloudflare/playwright`'s functions over the binding. */
type Playwright = typeof import("@cloudflare/playwright");

/** Whether Browser Run still lists its session `id` as open; when it cannot tell, it is. */
const stillOpen = (pw: Playwright, binding: BrowserRunSessionBinding, id: string) =>
  Effect.tryPromise(() => pw.sessions(binding)).pipe(
    Effect.map((open) => open.some((session) => session.sessionId === id)),
    Effect.orElseSucceed(() => true),
  );

/** Ends Browser Run's session `id`, as far as it can be reached: for a browser acquired but not reached. */
const endById = (pw: Playwright, binding: BrowserRunSessionBinding, id: string) =>
  Effect.tryPromise(() => pw.connect(binding, id)).pipe(
    Effect.flatMap(end),
    Effect.timeout(END_TIMEOUT),
    Effect.ignore,
  );

const unreachable = () => fail("Browser Run could not be reached");

const LIMIT_MESSAGE =
  "Browser Run refused a new browser: the Cloudflare account is at its limit of browsers (its concurrent " +
  "browsers, or new browsers per second). Close a browser session you no longer need with browser_close, or try " +
  "again in a moment.";

/** Browser Run's browsers behind the deployment's `browser` binding, as a {@link BrowserSessionProvider}. */
export const browserRunSessions = (binding: BrowserRunSessionBinding): BrowserSessionProvider => ({
  open: () =>
    bounded(
      Effect.gen(function* () {
        const pw = yield* playwright;

        const { sessionId } = yield* Effect.tryPromise({
          try: () => pw.acquire(binding, { keep_alive: KEEP_ALIVE_MS }),
          catch: (error) => {
            const message = error instanceof Error ? error.message : String(error);

            return statusOf(message) === 429
              ? new BrowserLimitReached({ message: LIMIT_MESSAGE })
              : fail(`Browser Run could not open a browser (${firstLine(message)})`);
          },
        });

        return yield* Effect.gen(function* () {
          const browser = yield* Effect.tryPromise(() => pw.connect(binding, sessionId)).pipe(
            Effect.flatMap((connected) => withContext(connected, sessionId)),
          );

          const tabs = yield* browser.tabs();

          if (tabs.length === 0) yield* browser.newTab();

          return browser;
        }).pipe(
          Effect.mapError(unreachable),
          Effect.tapError(() => endById(pw, binding, sessionId)),
        );
      }),
    ),
  connect: (id) =>
    bounded(
      Effect.gen(function* () {
        const pw = yield* playwright;

        const browser = yield* Effect.tryPromise(() => pw.connect(binding, id)).pipe(
          // A refused connection: the session is gone when Browser Run no longer lists it.
          Effect.catch(() =>
            stillOpen(pw, binding, id).pipe(
              Effect.flatMap((open) => Effect.fail(open ? unreachable() : new BrowserGone())),
            ),
          ),
        );

        return yield* withContext(browser, id);
      }),
    ),
});

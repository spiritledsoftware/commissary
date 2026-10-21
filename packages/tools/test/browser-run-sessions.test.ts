// Browser Run's browsers for interactive sessions (#213, `browser-run-sessions.ts`) over a fake `browser` binding's
// `fetch`, which `@cloudflare/playwright` reaches Browser Run with: its refusal of a new browser at the account's limit
// (429), a browser acquired but not reached (ended again), and a session it no longer lists (gone). Plus a canary of
// what the adapter takes from Playwright's internals: the installed client page still has `_snapshotForAI`. And the
// fields a person filled (#216), asked of every frame of every tab, a page's odd answer refused.
import type { Browser, Page } from "@cloudflare/playwright";
import { describe, expect, it } from "vitest";
import { Effect, Predicate } from "effect";
import {
  browserRunSessions,
  type BrowserRunSessionBinding,
  tab,
} from "../src/browser/browser-run-sessions.ts";
import { FILLED_FIELDS, NONEMPTY_FIELDS } from "../src/browser/page-scripts.ts";
import { BrowserGone, BrowserLimitReached, BrowserProviderError } from "../src/browser/provider.ts";

interface Recorded {
  readonly method: string;
  readonly path: string;
}

/** A binding whose `fetch` answers with `answer`, recording each request. */
const fakeBinding = (answer: (method: string, path: string) => Response) => {
  const requests: Array<Recorded> = [];

  const binding: BrowserRunSessionBinding = {
    fetch: (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);

      requests.push({ method: request.method, path: pathname });

      return Promise.resolve(answer(request.method, pathname));
    },
  };

  return { binding, requests };
};

describe("Browser Run's session browsers", () => {
  it("refuse a new browser at the account's limit (429) with what to do about it", async () => {
    const { binding, requests } = fakeBinding(() => new Response("Rate limit", { status: 429 }));

    const failed = await Effect.runPromise(Effect.flip(browserRunSessions(binding).open()));

    expect(failed).toBeInstanceOf(BrowserLimitReached);
    expect(failed.message).toMatch(
      /^Browser Run refused a new browser: the Cloudflare account is at its limit/,
    );
    expect(requests).toEqual([{ method: "POST", path: "/v1/devtools/browser" }]);
  });

  it("answer another refusal of a new browser with Browser Run's words", async () => {
    const { binding } = fakeBinding(() => new Response("boom", { status: 500 }));

    const failed = await Effect.runPromise(Effect.flip(browserRunSessions(binding).open()));

    expect(failed).toBeInstanceOf(BrowserProviderError);
    expect(failed.message).toBe(
      "Browser Run could not open a browser (Unable to create new browser: code: 500: message: boom)",
    );
  });

  it("end a browser acquired but not reached, as far as it can", async () => {
    const { binding, requests } = fakeBinding((method) =>
      method === "POST"
        ? Response.json({ sessionId: "s-1" })
        : new Response("down", { status: 502 }),
    );

    const failed = await Effect.runPromise(Effect.flip(browserRunSessions(binding).open()));

    expect(failed).toBeInstanceOf(BrowserProviderError);
    expect(failed.message).toBe("Browser Run could not be reached");
    // Its connection, then another to end it: neither reached it here.
    expect(requests).toEqual([
      { method: "POST", path: "/v1/devtools/browser" },
      { method: "GET", path: "/v1/devtools/browser/s-1" },
      { method: "GET", path: "/v1/devtools/browser/s-1" },
    ]);
  });

  it("answer a browser Browser Run no longer lists as gone, and one it lists as unreachable", async () => {
    const { binding } = fakeBinding((_method, path) =>
      path === "/v1/sessions"
        ? Response.json({ sessions: [{ sessionId: "s-open", startTime: 0 }] })
        : new Response("no", { status: 404 }),
    );

    const sessions = browserRunSessions(binding);

    expect(await Effect.runPromise(Effect.flip(sessions.connect("s-ended")))).toBeInstanceOf(
      BrowserGone,
    );

    const unreachable = await Effect.runPromise(Effect.flip(sessions.connect("s-open")));

    expect(unreachable).toBeInstanceOf(BrowserProviderError);
    expect(unreachable.message).toBe("Browser Run could not be reached");
  });

  it("rely on the installed client page having Playwright's snapshot for a model", async () => {
    // The client page is internal to `@cloudflare/playwright` (not in its exports): vitest.config.ts aliases its file.
    const { Page } = await import("playwright-client-page");

    expect(
      Predicate.hasProperty(Page.prototype, "_snapshotForAI") &&
        Predicate.isFunction(Page.prototype._snapshotForAI),
    ).toBe(true);
  });
});

describe("a Browser Run tab's filled fields", () => {
  /** Tabs whose frames answer `answers` (one list per frame, per tab), recording the scripts each frame ran. */
  const tabsAnswering = (answers: ReadonlyArray<ReadonlyArray<unknown>>) => {
    const ran: Array<string> = [];

    const pages: Array<Page> = [];

    for (const [index, frames] of answers.entries()) {
      const page = {
        context: () => ({ pages: () => pages }),
        frames: () =>
          frames.map((answer, frame) => ({
            evaluate: (script: string) => {
              const which =
                script === FILLED_FIELDS
                  ? "filled"
                  : script === NONEMPTY_FIELDS
                    ? "nonempty"
                    : "other";

              ran.push(`${index}.${frame}:${which}`);

              return Promise.resolve(answer);
            },
          })),
      };

      // SAFETY: the adapter reads only `context().pages()` and `frames()[].evaluate` of a page for its filled fields.
      pages.push(page as unknown as Page);
    }

    // SAFETY: the adapter asks the browser only whether it is still connected when a call fails.
    const browser = { isConnected: () => true } as unknown as Browser;

    return { current: tab(browser, pages[0] as Page), ran };
  };

  it("are asked of every frame of every tab, the current one's and the others'", async () => {
    const { current, ran } = tabsAnswering([
      [['input[name="user"]'], []],
      [["[data-commissary-filled]"]],
    ]);

    expect(await Effect.runPromise(current.filledFields(false))).toEqual([
      'input[name="user"]',
      "[data-commissary-filled]",
    ]);
    expect(ran).toEqual(["0.0:filled", "0.1:filled", "1.0:filled"]);
  });

  it("fail when any frame answers anything but a short list of selectors", async () => {
    const { current } = tabsAnswering([[['input[name="user"]']], [{ selectors: [] }]]);

    expect(await Effect.runPromise(Effect.flip(current.filledFields(true)))).toBeInstanceOf(
      BrowserProviderError,
    );
  });
});

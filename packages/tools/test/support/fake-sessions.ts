// A fake browser provider's sessions (#213), for the browser session tests: browsers of a small fake web, kept in this
// module (one world per isolate: the test Worker's session objects and its tests share it), which render their tabs as
// Playwright does. Its snapshot copies input values as Playwright's does (a password field's included), and its
// screenshot is the page's text with the masked fields painted over, so a test sees what masking left.
//
// The web: `/login` (a username field, a password field with a placeholder, a sign-in button that sets the site's
// `session` cookie, `secret-cookie-<username>`, and loads `/welcome?user=<username>`), `/account` (who the site's
// `session` cookie signs in, or that none does), `/prefs` (the site's `theme` in local storage; `?theme=<theme>` sets
// it first), `/code` (a one-time code field, and a PIN field the browser gives no ref), any other page (its heading and
// a link to `<url>/next`). A browser keeps its cookies and local storage as a storage state (#215): opened from one, it
// has them, and reads them back, the local storage of the sites its current connection visited (or loaded from the
// state) only, as Playwright's `storageState()` over a connection to a running browser does. `fakeBrowsers` lets a test
// refuse new browsers (an account at its limit), end a browser as the provider would, drop the connections to one
// (which a later connection reaches again), and see which browsers are open.
import { Effect } from "effect";
import {
  BrowserGone,
  BrowserLimitReached,
  BrowserProviderError,
  type BrowserSessionProvider,
  type BrowserTab,
  type ProviderBrowser,
  type StorageState,
} from "../../src/browser/provider.ts";

type FakeCookie = StorageState["cookies"][number];

type FakeOrigins = StorageState["origins"];

interface FakeElement {
  readonly role: string;
  readonly name: string;
  readonly tag: "input" | "button" | "a" | "h1" | "select";
  readonly attributes: Readonly<Record<string, string>>;
  /** Its value, for an input or a select. */
  value?: string;
  /** Where clicking it goes: a link's page, or a button's form submitted. */
  readonly goes?: (page: FakePage) => string;
  /** A placeholder: Playwright renders the value in a child line then. */
  readonly placeholder?: string;
  /** Not interactable: Playwright gives it no ref. */
  readonly noRef?: boolean;
  readonly options?: ReadonlyArray<string>;
  /** Signs in as the page's username when clicked: sets the site's `session` cookie. */
  readonly signsIn?: boolean;
}

interface FakePage {
  readonly url: string;
  readonly title: string;
  readonly elements: ReadonlyArray<FakeElement>;
}

const field = (name: string, attributes: Record<string, string>, more: Partial<FakeElement> = {}) =>
  ({ role: "textbox", name, tag: "input", attributes, value: "", ...more }) satisfies FakeElement;

/** The value of the cookie `name` of the site of `url` among `cookies`. */
const cookieOf = (cookies: ReadonlyArray<FakeCookie>, url: string, name: string) => {
  const { hostname } = new URL(url);

  return cookies.find((cookie) => cookie.domain === hostname && cookie.name === name)?.value;
};

/** The value of the local storage entry `name` of the site of `url` among `origins`. */
const storedOf = (origins: FakeOrigins, url: string, name: string) => {
  const { origin } = new URL(url);

  return origins
    .find((each) => each.origin === origin)
    ?.localStorage.find((entry) => entry.name === name)?.value;
};

/** The page at `url` of the fake web, freshly loaded in a browser with `cookies` and the local storage `origins`. */
const load = (
  url: string,
  cookies: ReadonlyArray<FakeCookie> = [],
  origins: FakeOrigins = [],
): FakePage => {
  const { pathname, searchParams, origin } = new URL(url);

  switch (pathname) {
    case "/login":
      return {
        url,
        title: "Sign in",
        elements: [
          { role: "heading", name: "Sign in", tag: "h1", attributes: {} },
          field("Username", { name: "user", type: "text" }),
          field(
            "Password",
            { name: "password", type: "password" },
            { placeholder: "Your password" },
          ),
          {
            role: "button",
            name: "Sign in",
            tag: "button",
            attributes: {},
            signsIn: true,
            goes: (page) =>
              `${origin}/welcome?user=${encodeURIComponent(
                page.elements.find((element) => element.attributes["name"] === "user")?.value ?? "",
              )}`,
          },
        ],
      };
    case "/account": {
      const session = cookieOf(cookies, url, "session");

      return {
        url,
        title: "Account",
        elements: [
          {
            role: "heading",
            name:
              session === undefined
                ? "Not signed in"
                : `Signed in as ${session.replace(/^secret-cookie-/, "")}`,
            tag: "h1",
            attributes: {},
          },
        ],
      };
    }

    case "/prefs":
      return {
        url,
        title: "Preferences",
        elements: [
          {
            role: "heading",
            name: `Theme: ${storedOf(origins, url, "theme") ?? "none"}`,
            tag: "h1",
            attributes: {},
          },
        ],
      };
    case "/welcome":
      return {
        url,
        title: "Welcome",
        elements: [
          {
            role: "heading",
            name: `Welcome, ${searchParams.get("user") ?? ""}`,
            tag: "h1",
            attributes: {},
          },
        ],
      };
    case "/code":
      return {
        url,
        title: "One-time code",
        elements: [
          field("One-time code", { name: "otp", type: "text" }),
          field("PIN", { name: "pin", type: "text" }, { value: "4321", noRef: true }),
          {
            role: "combobox",
            name: "Country",
            tag: "select",
            attributes: { name: "country" },
            value: "fr",
            options: ["fr", "de"],
          },
        ],
      };
    default:
      return {
        url,
        title: `Page at ${url}`,
        elements: [
          { role: "heading", name: `Page at ${url}`, tag: "h1", attributes: {} },
          {
            role: "link",
            name: "Next",
            tag: "a",
            attributes: {},
            goes: () => `${url.replace(/\/$/, "")}/next`,
          },
        ],
      };
  }
};

/** A simple selector of the fake's: `tag`, `#id` or `[attr="value"]` (with ` i`), alone or combined. */
const SIMPLE = /^([a-z][a-z0-9]*)?(?:#([\w-]+))?(?:\[([\w-]+)="([^"]*)"( i)?\])?$/;

const matchesSelector = (element: FakeElement, selector: string): boolean =>
  selector
    .split(",")
    .map((part) => part.trim())
    .some((part) => {
      const match = SIMPLE.exec(part);

      if (match === null) throw new Error(`the fake supports no selector ${part}`);
      const [, tag, id, attribute, value, insensitive] = match;

      if (tag !== undefined && tag !== element.tag) return false;

      if (id !== undefined && element.attributes["id"] !== id) return false;

      if (attribute === undefined) return true;
      const actual = element.attributes[attribute];

      return insensitive === undefined
        ? actual === value
        : actual?.toLowerCase() === value?.toLowerCase();
    });

interface FakeTabState {
  history: Array<FakePage>;
  at: number;
}

interface FakeBrowserState {
  readonly id: string;
  readonly tabs: Array<FakeTabState>;
  ended: boolean;
  /** The connection now: a browser reached on an earlier one answers as gone. */
  connection: number;
  /** Its cookies and local storage. */
  cookies: Array<FakeCookie>;
  origins: FakeOrigins;
  /** The sites whose local storage its current connection knows: those it visited, or loaded from a state. */
  seen: Set<string>;
}

const browsers = new Map<string, FakeBrowserState>();

/** What a test controls and sees of the fake provider. */
export const fakeBrowsers = {
  /** While true, a new browser is refused, as at Browser Run's account limit. */
  refuseNew: false,
  /** The browsers opened so far, the latest last. */
  opened: [] as Array<string>,
  /** Ends the browser `id`, as Browser Run does on a release of its own. */
  end: (id: string) => {
    const browser = browsers.get(id);

    if (browser !== undefined) browser.ended = true;
  },
  /** Drops every connection to the browser `id`, as a network failure does: it stays open, to be reached again. */
  drop: (id: string) => {
    const browser = browsers.get(id);

    if (browser === undefined) return;
    browser.connection++;
    browser.seen = new Set();
  },
  /** Whether the browser `id` is still open at the provider. */
  isOpen: (id: string) => browsers.get(id)?.ended === false,
};

const page = (state: FakeTabState): FakePage => {
  const current = state.history[state.at];

  if (current === undefined) throw new Error("the fake tab has no page");

  return current;
};

/** The elements of the tab's page with their refs (`e1`, `e2`…), as its latest snapshot names them. */
const withRefs = (current: FakePage) => {
  let next = 0;

  return current.elements.map((element) => ({
    element,
    ref: element.noRef === true ? undefined : `e${++next}`,
  }));
};

const quoted = (name: string) => JSON.stringify(name);

/** The page rendered as Playwright renders its snapshot for a model: input values included. */
const renderSnapshot = (current: FakePage): string =>
  withRefs(current)
    .flatMap(({ element, ref }) => {
      const key = `- ${element.role} ${quoted(element.name)}${ref === undefined ? "" : ` [ref=${ref}]`}`;

      if (element.tag === "select")
        return [
          `${key}:`,
          ...(element.options ?? []).map(
            (option) =>
              `  - option ${quoted(option)}${option === element.value ? " [selected]" : ""}`,
          ),
        ];

      if (element.tag !== "input" || element.value === undefined || element.value === "")
        return [element.tag === "a" ? `${key}:\n  - /url: ${element.goes?.(current)}` : key];

      return element.placeholder === undefined
        ? [`${key}: ${element.value}`]
        : [`${key}:`, `  - /placeholder: ${element.placeholder}`, `  - text: ${element.value}`];
    })
    .join("\n");

const gone = () => new BrowserGone();

/** The site of `url`, for a page of the web (`about:blank` has none). */
const siteOf = (url: string): string | undefined => {
  const { origin } = new URL(url);

  return origin === "null" ? undefined : origin;
};

/** Sets the site's local storage entry `theme`, as `/prefs?theme=<theme>` does. */
const storeTheme = (browser: FakeBrowserState, url: string) => {
  const { origin, pathname, searchParams } = new URL(url);
  const theme = searchParams.get("theme");

  if (pathname !== "/prefs" || theme === null) return;
  const others = browser.origins.filter((each) => each.origin !== origin);
  const entries = browser.origins.find((each) => each.origin === origin)?.localStorage ?? [];

  browser.origins = [
    ...others,
    {
      origin,
      localStorage: [
        ...entries.filter((entry) => entry.name !== "theme"),
        { name: "theme", value: theme },
      ],
    },
  ];
};

/**
 * The browser's storage state as its current connection reads it: every cookie, and the local storage of the sites it
 * visited, or loaded from a state, or that a tab shows.
 */
const storageOf = (browser: FakeBrowserState): StorageState => {
  const showing = browser.tabs.flatMap((tab) => siteOf(page(tab).url) ?? []);
  const known = new Set([...browser.seen, ...showing]);

  return {
    cookies: [...browser.cookies],
    origins: browser.origins.filter((each) => known.has(each.origin)),
  };
};

/** Sets the site's `session` cookie for the username typed on `current`, as its sign-in form does. */
const signIn = (browser: FakeBrowserState, current: FakePage) => {
  const user = current.elements.find((element) => element.attributes["name"] === "user")?.value;
  const { hostname } = new URL(current.url);

  browser.cookies = [
    ...browser.cookies.filter((cookie) => cookie.domain !== hostname || cookie.name !== "session"),
    {
      name: "session",
      value: `secret-cookie-${user ?? ""}`,
      domain: hostname,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ];
};

const fakeTab = (
  browser: FakeBrowserState,
  connection: number,
  state: FakeTabState,
): BrowserTab => {
  const live = <A>(body: () => A) =>
    Effect.suspend(() =>
      browser.ended || browser.connection !== connection ? Effect.fail(gone()) : Effect.sync(body),
    );

  const element = (ref: string) =>
    Effect.flatMap(
      live(() => withRefs(page(state)).find((entry) => entry.ref === ref)?.element),
      (found) =>
        found === undefined
          ? Effect.fail(
              new BrowserProviderError({ message: `Ref ${ref} not found in the current page` }),
            )
          : Effect.succeed(found),
    );

  const visit = (url: string) => {
    const site = siteOf(url);

    if (site !== undefined) browser.seen.add(site);
    storeTheme(browser, url);
    state.history.splice(state.at + 1);
    state.history.push(load(url, browser.cookies, browser.origins));
    state.at = state.history.length - 1;
  };

  return {
    url: () => page(state).url,
    title: () => live(() => page(state).title),
    goto: (url) =>
      url.includes("unreachable.invalid")
        ? Effect.fail(new BrowserProviderError({ message: `net::ERR_NAME_NOT_RESOLVED at ${url}` }))
        : live(() => visit(url)),
    back: () => live(() => void (state.at = Math.max(state.at - 1, 0))),
    forward: () => live(() => void (state.at = Math.min(state.at + 1, state.history.length - 1))),
    snapshot: () => live(() => renderSnapshot(page(state))),
    countMatching: (selector) =>
      live(() => page(state).elements.filter((each) => matchesSelector(each, selector)).length),
    maskedRefs: (refs, selector) =>
      live(() => {
        const elements = withRefs(page(state));

        return new Set(
          refs.filter((ref) => {
            const found = elements.find((entry) => entry.ref === ref)?.element;

            return found === undefined || matchesSelector(found, selector);
          }),
        );
      }),
    click: (ref) =>
      Effect.flatMap(element(ref), (found) =>
        Effect.sync(() => {
          if (found.signsIn === true) signIn(browser, page(state));

          if (found.goes !== undefined) visit(found.goes(page(state)));
        }),
      ),
    fill: (ref, text) =>
      Effect.flatMap(element(ref), (found) =>
        found.tag === "input"
          ? Effect.sync(() => void (found.value = text))
          : Effect.fail(new BrowserProviderError({ message: `Element ${ref} is not an input` })),
      ),
    press: () => live(() => undefined),
    selectOption: (ref, values) =>
      Effect.flatMap(element(ref), (found) =>
        Effect.sync(() => void (found.value = values[0] ?? "")),
      ),
    hover: (ref) => Effect.asVoid(element(ref)),
    waitFor: (condition, timeout) =>
      Effect.flatMap(
        live(() =>
          "text" in condition
            ? renderSnapshot(page(state)).includes(condition.text)
            : page(state).elements.some((each) => matchesSelector(each, condition.selector)),
        ),
        (found) =>
          found
            ? Effect.void
            : Effect.fail(new BrowserProviderError({ message: `Timeout ${timeout}ms exceeded` })),
      ),
    screenshot: ({ mask }) =>
      live(() =>
        new TextEncoder().encode(
          page(state)
            .elements.map((each) =>
              each.value === undefined || each.value === ""
                ? each.name
                : `${each.name}: ${mask.some((selector) => matchesSelector(each, selector)) ? "█████" : each.value}`,
            )
            .join("\n"),
        ),
      ),
    focus: () => live(() => undefined),
  };
};

/** The browser as reached on its current connection. */
const fakeBrowser = (browser: FakeBrowserState): ProviderBrowser => {
  const { connection } = browser;
  const lost = () => browser.ended || browser.connection !== connection;

  return {
    id: browser.id,
    tabs: () =>
      lost()
        ? Effect.fail(gone())
        : Effect.succeed(browser.tabs.map((state) => fakeTab(browser, connection, state))),
    newTab: () =>
      lost()
        ? Effect.fail(gone())
        : Effect.sync(() => {
            const state = { history: [load("about:blank")], at: 0 };

            browser.tabs.push(state);

            return fakeTab(browser, connection, state);
          }),
    storageState: () => (lost() ? Effect.fail(gone()) : Effect.sync(() => storageOf(browser))),
    close: () => Effect.sync(() => fakeBrowsers.end(browser.id)),
  };
};

/** The fake provider's sessions, over the module's fake web. */
export const fakeSessionProvider = (): BrowserSessionProvider => ({
  open: (loaded) =>
    Effect.suspend(() => {
      if (fakeBrowsers.refuseNew)
        return Effect.fail(
          new BrowserLimitReached({ message: "The fake browser is at its account's limit." }),
        );
      const id = crypto.randomUUID();

      const state: FakeBrowserState = {
        id,
        tabs: [{ history: [load("about:blank")], at: 0 }],
        ended: false,
        connection: 0,
        cookies: [...(loaded?.cookies ?? [])],
        origins: [...(loaded?.origins ?? [])],
        seen: new Set(loaded?.origins.map((each) => each.origin)),
      };

      browsers.set(id, state);
      fakeBrowsers.opened.push(id);

      return Effect.succeed(fakeBrowser(state));
    }),
  connect: (id) =>
    Effect.suspend(() => {
      const state = browsers.get(id);

      return state === undefined || state.ended
        ? Effect.fail(gone())
        : Effect.succeed(fakeBrowser(state));
    }),
});

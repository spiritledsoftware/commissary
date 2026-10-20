// A fake browser provider's sessions (#213), for the browser session tests: browsers of a small fake web, kept in this
// module (one world per isolate: the test Worker's session objects and its tests share it), which render their tabs as
// Playwright does. Its snapshot copies input values as Playwright's does (a password field's included), and its
// screenshot is the page's text with the masked fields painted over, so a test sees what masking left.
//
// The web: `/login` (a username field, a password field with a placeholder, a sign-in button that loads
// `/welcome?user=<username>`), `/code` (a one-time code field, and a PIN field the browser gives no ref), any other
// page (its heading and a link to `<url>/next`). `fakeBrowsers` lets a test refuse new browsers (an account at its
// limit), end a browser as the provider would, drop the connections to one (which a later connection reaches again),
// and see which browsers are open.
import { Effect } from "effect";
import {
  BrowserGone,
  BrowserLimitReached,
  BrowserProviderError,
  type BrowserSessionProvider,
  type BrowserTab,
  type ProviderBrowser,
} from "../../src/browser/provider.ts";

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
}

interface FakePage {
  readonly url: string;
  readonly title: string;
  readonly elements: ReadonlyArray<FakeElement>;
}

const field = (name: string, attributes: Record<string, string>, more: Partial<FakeElement> = {}) =>
  ({ role: "textbox", name, tag: "input", attributes, value: "", ...more }) satisfies FakeElement;

/** The page at `url` of the fake web, freshly loaded. */
const load = (url: string): FakePage => {
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
            goes: (page) =>
              `${origin}/welcome?user=${encodeURIComponent(
                page.elements.find((element) => element.attributes["name"] === "user")?.value ?? "",
              )}`,
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

    if (browser !== undefined) browser.connection++;
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
    state.history.splice(state.at + 1);
    state.history.push(load(url));
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
    close: () => Effect.sync(() => fakeBrowsers.end(browser.id)),
  };
};

/** The fake provider's sessions, over the module's fake web. */
export const fakeSessionProvider = (): BrowserSessionProvider => ({
  open: () =>
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

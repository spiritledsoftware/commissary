/**
 * The browser-provider seam (ADR 0041, GLOSSARY "Browser provider"): the one interface through which the browser
 * toolkit reaches the service behind it. Browser Run (`browser-run.ts`, the deployment's own binding) is the only
 * adapter built; a later provider (Browserbase, Kernel) is another adapter of this interface, made from the toolkit's
 * credential, plus a catalog entry, and serves the same tools. The interface covers the stateless Quick Actions (#212)
 * and the browsers of interactive sessions (#213, {@link BrowserSessionProvider}): opening one, reaching it again by
 * its id, and driving its tabs, in Commissary's own words (references from an accessibility snapshot, CSS selectors to
 * mask). What a session makes of them (ownership, lifetime, masking, tool results) is Commissary's code above the
 * interface (`session.ts`).
 *
 * A Quick Action is asked in Commissary's own words, provider-neutral: the action and its arguments as a client gave
 * them, decoded with the schemas of {@link QUICK_ACTIONS} (which the toolkit lists as the tools' input schemas). The
 * arguments are a subset of Browser Run's options, under its names: those that make sense for a client. Left out are
 * the options that would run script in the page (`addScriptTag`, ADR 0039: no tool runs JavaScript in the page), carry
 * sign-ins (`cookies`, `authenticate`, extra headers: logins are browser profiles' and handoff's, #213), render HTML
 * instead of a URL, choose a backend, or set Browser Run's cache (the provider never caches: results are not stored).
 *
 * Crawling a site (#270, {@link BrowserCrawlProvider}) is asynchronous: starting a crawl answers the provider's id of
 * the crawl job, by which its status and pages are read and it is cancelled. A provider may have no crawls: Browser
 * Run's `/crawl` is on its REST API only, which needs an account API token (`browser-run-crawls.ts`). Who may reach a
 * crawl (the member and principal that started it) is Commissary's code above the interface (`crawl-tools.ts`).
 */
import { Schema } from "effect";
import type { Effect } from "effect";

const optional = Schema.optionalKey;

const milliseconds = (maximum: number, description: string) =>
  optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum })).annotate({ description }));

/** How the page is loaded: what every Quick Action takes. */
const PAGE = {
  url: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/i)).annotate({
    description: "The page's address, an http or https URL.",
  }),
  waitUntil: optional(
    Schema.Literals(["load", "domcontentloaded", "networkidle0", "networkidle2"]).annotate({
      description: "When the page counts as loaded (default domcontentloaded).",
    }),
  ),
  timeout: milliseconds(60_000, "How long the navigation may take, in ms (default 30000)."),
  waitForSelector: optional(
    Schema.String.annotate({ description: "A CSS selector to wait for before acting." }),
  ),
  waitForTimeout: milliseconds(60_000, "A fixed delay after loading, in ms."),
  viewport: optional(
    Schema.Struct({
      width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7680 })),
      height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7680 })),
      deviceScaleFactor: optional(
        Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 4 })),
      ),
      isMobile: optional(Schema.Boolean),
    }).annotate({ description: "The viewport (default 1920x1080)." }),
  ),
  userAgent: optional(Schema.String.annotate({ description: "The user agent to send." })),
  rejectResourceTypes: optional(
    Schema.Array(
      Schema.Literals([
        "document",
        "stylesheet",
        "image",
        "media",
        "font",
        "script",
        "texttrack",
        "xhr",
        "fetch",
        "eventsource",
        "websocket",
        "manifest",
        "other",
      ]),
    ).annotate({ description: "Resource types not to load, e.g. image and font, for speed." }),
  ),
  javaScriptEnabled: optional(
    Schema.Boolean.annotate({
      description: "Whether the page's own JavaScript runs (default true).",
    }),
  ),
};

/**
 * One Quick Action as every provider serves it: what its tool tells a client it does, and its arguments, decoded from
 * the client's call (their schema is the tool's input schema).
 */
interface QuickAction<Fields extends Schema.Struct.Fields> {
  readonly description: string;
  readonly arguments: Schema.Struct<Fields>;
}

const quickAction = <Fields extends Schema.Struct.Fields>(
  description: string,
  fields: Fields,
): QuickAction<Fields> => ({ description, arguments: Schema.Struct(fields) });

/**
 * The Quick Actions, one record each, in the order the toolkit lists them. A provider's adapter keys what it does for
 * each by the same names (`browser-run.ts`).
 */
export const QUICK_ACTIONS = {
  markdown: quickAction("Load a web page in a browser and return its content as Markdown.", PAGE),
  html: quickAction("Load a web page in a browser and return its rendered HTML.", PAGE),
  screenshot: quickAction(
    "Load a web page in a browser and return a screenshot of it, or of one element.",
    {
      ...PAGE,
      selector: optional(
        Schema.String.annotate({ description: "A CSS selector: capture that element only." }),
      ),
      fullPage: optional(
        Schema.Boolean.annotate({ description: "Capture the whole page, not just the viewport." }),
      ),
      type: optional(
        Schema.Literals(["png", "jpeg", "webp"]).annotate({ description: "Default png." }),
      ),
      quality: optional(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })).annotate({
          description: "jpeg and webp only.",
        }),
      ),
    },
  ),
  pdf: quickAction("Load a web page in a browser and return it printed as a PDF.", {
    ...PAGE,
    format: optional(
      Schema.Literals([
        "letter",
        "legal",
        "tabloid",
        "ledger",
        "a0",
        "a1",
        "a2",
        "a3",
        "a4",
        "a5",
        "a6",
      ]).annotate({ description: "The paper size (default letter)." }),
    ),
    landscape: optional(Schema.Boolean),
    printBackground: optional(Schema.Boolean),
    scale: optional(Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 2 }))),
    pageRanges: optional(Schema.String.annotate({ description: "Pages to print, e.g. 1-5, 8." })),
  }),
  links: quickAction("Load a web page in a browser and return the links on it.", {
    ...PAGE,
    visibleLinksOnly: optional(
      Schema.Boolean.annotate({ description: "Only links a person would see on the page." }),
    ),
    excludeExternalLinks: optional(
      Schema.Boolean.annotate({ description: "Leave out links to other domains." }),
    ),
  }),
  scrape: quickAction(
    "Load a web page in a browser and return the elements matching CSS selectors: their text, HTML, attributes and position.",
    {
      ...PAGE,
      selectors: Schema.Array(Schema.String)
        .check(Schema.isMinLength(1))
        .annotate({ description: "The CSS selectors whose elements to return." }),
    },
  ),
  accessibility_tree: quickAction(
    "Load a web page in a browser and return its accessibility tree: roles, names and values of what is on the page.",
    {
      ...PAGE,
      root: optional(
        Schema.String.annotate({ description: "A CSS selector: the tree of that element only." }),
      ),
      interestingOnly: optional(
        Schema.Boolean.annotate({
          description:
            "Leave out nodes without meaning, such as generic containers (default true).",
        }),
      ),
    },
  ),
} as const;

export type QuickActionName = keyof typeof QUICK_ACTIONS;

/** The Quick Actions' names, in the order of {@link QUICK_ACTIONS}. */
// SAFETY: `QUICK_ACTIONS`'s own keys are exactly its names.
export const QUICK_ACTION_NAMES = Object.keys(QUICK_ACTIONS) as ReadonlyArray<QuickActionName>;

/** The decoded arguments of the Quick Action `K`. */
export type QuickActionArguments<K extends QuickActionName> =
  (typeof QUICK_ACTIONS)[K]["arguments"]["Type"];

export type PageArguments = Schema.Struct<typeof PAGE>["Type"];

const wildcards = (description: string) =>
  optional(Schema.Array(Schema.String).annotate({ description }));

/** The most pages one crawl may take unless the deployment says otherwise (`COMMISSARY_CRAWL_MAX_PAGES`). */
export const DEFAULT_CRAWL_MAX_PAGES = 1000;

/** Browser Run's own ceiling on a crawl's pages, above which no deployment may raise its own. */
export const BROWSER_RUN_CRAWL_MAX_PAGES = 100_000;

/** The most links deep a crawl follows from its starting URL. */
export const MAX_CRAWL_DEPTH = 100;

/**
 * What a crawl takes, in Commissary's own words (Browser Run's names): the URL it starts from, how far it goes (at most
 * `maxPages` pages, the deployment's cap, and {@link MAX_CRAWL_DEPTH} links deep: its browser time lands on the
 * deployment's account), what it returns of each page and how a page is loaded. Left out, as for the Quick Actions:
 * sign-ins (`cookies`, `authenticate`, extra headers), script in the page, Browser Run's cache (`maxAge`: results are
 * not kept, #212), and the `json` format, which runs an AI model under the deployment's account (#212 leaves out
 * `/json` for the same reason). A crawl's user agent is Browser Run's own. Arguments beyond these are dropped.
 */
export const crawlStartArguments = (maxPages: number) =>
  Schema.Struct({
    url: Schema.String.annotate({
      description:
        "The address the crawl starts from: a public https URL. Commissary refuses private addresses and its own hosts.",
    }),
    limit: optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxPages })).annotate({
        description: `The most pages to crawl (default 10, at most ${maxPages}).`,
      }),
    ),
    depth: optional(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CRAWL_DEPTH })).annotate({
        description: `How many links deep to follow from the starting URL (at most ${MAX_CRAWL_DEPTH}).`,
      }),
    ),
    source: optional(
      Schema.Literals(["all", "sitemaps", "links"]).annotate({
        description:
          "Where to find pages: the site's sitemaps, the links on its pages, or both (default all).",
      }),
    ),
    formats: optional(
      Schema.Array(Schema.Literals(["html", "markdown"]))
        .check(Schema.isMinLength(1))
        .annotate({ description: "What each page is returned as (default html)." }),
    ),
    render: optional(
      Schema.Boolean.annotate({
        description:
          "Whether to load each page in a browser and run its JavaScript (default true); false fetches the HTML only, faster.",
      }),
    ),
    modifiedSince: optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "Only pages modified since this time, in Unix seconds.",
      }),
    ),
    options: optional(
      Schema.Struct({
        includeExternalLinks: optional(
          Schema.Boolean.annotate({
            description: "Follow links to other domains (default false).",
          }),
        ),
        includeSubdomains: optional(
          Schema.Boolean.annotate({
            description: "Follow links to subdomains of the starting URL (default false).",
          }),
        ),
        includePatterns: wildcards(
          "Only URLs matching one of these wildcard patterns (* any characters but /, ** any characters).",
        ),
        excludePatterns: wildcards(
          "No URL matching one of these wildcard patterns; they win over includePatterns.",
        ),
      }).annotate({ description: "Which links the crawl follows." }),
    ),
    crawlPurposes: optional(
      Schema.Array(Schema.Literals(["search", "ai-input", "ai-train"])).annotate({
        description:
          "What the content is for, checked against the sites' Content Signals (default all three); a site that refuses one of them refuses the crawl.",
      }),
    ),
    contentUse: optional(
      Schema.Literals(["reference", "full"]).annotate({
        description:
          "How fully the content is used, checked against the sites' Content Signals (default full).",
      }),
    ),
    waitUntil: PAGE.waitUntil,
    timeout: PAGE.timeout,
    waitForSelector: PAGE.waitForSelector,
    rejectResourceTypes: PAGE.rejectResourceTypes,
  });

export type CrawlStartArguments = ReturnType<typeof crawlStartArguments>["Type"];

/** The status of one page of a crawl. */
export const CRAWL_RECORD_STATUSES = [
  "queued",
  "completed",
  "disallowed",
  "skipped",
  "errored",
  "cancelled",
] as const;

/** Which of a crawl's pages to read: from where (a previous answer's cursor), how many, and of which status. */
export interface CrawlPage {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly status?: (typeof CRAWL_RECORD_STATUSES)[number] | undefined;
}

/**
 * A crawl job as its provider tells it: its status (Browser Run: `running`, `completed`, `errored`,
 * `cancelled_by_user`, …), how many pages it has found and crawled, the pages asked for, each as the provider records it
 * (its URL, status and content in the formats asked), and the cursor of the next pages, if there are more.
 */
export interface CrawlJob {
  readonly id: string;
  readonly status: string;
  readonly total?: number | undefined;
  readonly finished?: number | undefined;
  readonly skipped?: number | undefined;
  readonly records: ReadonlyArray<Schema.Json>;
  readonly cursor?: string | undefined;
}

/** One Quick Action as the toolkit asks it of a provider. */
export type QuickActionRequest = {
  readonly [K in QuickActionName]: {
    readonly action: K;
    readonly args: QuickActionArguments<K>;
  };
}[QuickActionName];

/**
 * What a Quick Action answers: the page as text (Markdown, HTML), as JSON (links, scraped elements, the accessibility
 * tree), or as a file (a screenshot, a PDF).
 */
export type QuickActionResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "json"; readonly value: Schema.Json }
  | { readonly kind: "file"; readonly mimeType: string; readonly data: Uint8Array };

/**
 * A Quick Action's answer, and the browser time it used in milliseconds when the provider reports it (#214: Browser
 * Run's `X-Browser-Ms-Used`), which its call's usage record carries and a price per browser hour costs.
 */
export interface QuickActionAnswer {
  readonly result: QuickActionResult;
  readonly browserMs: number | undefined;
}

/**
 * A Quick Action the provider could not do. `message` is told to the model: the provider's own words about the page or
 * the arguments (a navigation that timed out, a malformed selector), never a secret.
 */
export class BrowserProviderError extends Schema.TaggedError<BrowserProviderError>()(
  "BrowserProviderError",
  {
    message: Schema.String,
    /** The provider's HTTP status, when it answered one. */
    status: optional(Schema.Number),
    /** The browser time the failed action used anyway, in milliseconds, when the provider reports it (#214). */
    browserMs: optional(Schema.Number),
  },
) {}

/**
 * The provider refused a new browser because its account is at its limit of browsers (Browser Run: the Cloudflare
 * account's concurrent browsers, or new browsers per second). `message` is told to the model.
 */
export class BrowserLimitReached extends Schema.TaggedError<BrowserLimitReached>()(
  "BrowserLimitReached",
  { message: Schema.String },
) {}

/**
 * The browser is gone: the provider closed it (Browser Run on a release of its own, or after its `keep_alive`), or the
 * connection to it dropped for good. The session answers as closed from then on.
 */
export class BrowserGone extends Schema.TaggedError<BrowserGone>()("BrowserGone", {}) {}

/** What a browser's operations fail with: the provider's words about the page, or the browser being gone. */
export type BrowserFailure = BrowserProviderError | BrowserGone;

/**
 * One tab of a session's browser. An element is named by its reference in the tab's latest accessibility snapshot
 * (`ref`, Playwright's `[ref=e3]`); a reference from an older snapshot, or from before the browser was reached again,
 * may no longer name anything, which fails with the provider's words. Nothing here runs a caller's JavaScript in the
 * page, and nothing returns an element's value: the snapshot is the only view of the page's content besides the
 * screenshot.
 */
export interface BrowserTab {
  /** Its address now. */
  readonly url: () => string;
  readonly title: () => Effect.Effect<string, BrowserFailure>;
  /** Loads `url`, waiting at most `timeout` ms for the page to load. */
  readonly goto: (url: string, timeout: number) => Effect.Effect<void, BrowserFailure>;
  readonly back: (timeout: number) => Effect.Effect<void, BrowserFailure>;
  readonly forward: (timeout: number) => Effect.Effect<void, BrowserFailure>;
  /**
   * The page's accessibility snapshot as Playwright renders it for a model (YAML, each element that can be acted on
   * with its `[ref=…]`), unmasked: input fields carry their values. Only the session's code reads it, and masks it
   * before a caller sees it.
   */
  readonly snapshot: () => Effect.Effect<string, BrowserFailure>;
  /** How many elements match the CSS `selector`, in every frame of the page (masking asks first whether any do). */
  readonly countMatching: (selector: string) => Effect.Effect<number, BrowserFailure>;
  /**
   * Which of the elements `refs` match the CSS `selector`. A ref that names no element is among them: it cannot be
   * cleared, so masking fails closed.
   */
  readonly maskedRefs: (
    refs: ReadonlyArray<string>,
    selector: string,
  ) => Effect.Effect<ReadonlySet<string>, BrowserFailure>;
  readonly click: (
    ref: string,
    options: { readonly button: "left" | "right" | "middle"; readonly doubleClick: boolean },
  ) => Effect.Effect<void, BrowserFailure>;
  /** Replaces the field's value with `text`. */
  readonly fill: (ref: string, text: string) => Effect.Effect<void, BrowserFailure>;
  /** Presses a key, in Playwright's words (`Enter`, `ArrowDown`, `Control+A`, a character). */
  readonly press: (key: string) => Effect.Effect<void, BrowserFailure>;
  readonly selectOption: (
    ref: string,
    values: ReadonlyArray<string>,
  ) => Effect.Effect<void, BrowserFailure>;
  readonly hover: (ref: string) => Effect.Effect<void, BrowserFailure>;
  /**
   * Waits until the text is shown, or an element matches the CSS selector, for at most `timeout` ms. The selector is
   * CSS only, and one that cannot probe a field's value (`session-tools.ts`): the provider reads it as CSS.
   */
  readonly waitFor: (
    condition: { readonly text: string } | { readonly selector: string },
    timeout: number,
  ) => Effect.Effect<void, BrowserFailure>;
  /**
   * A screenshot, with every element that matches one of the CSS selectors of `mask` painted over, in every frame of
   * the page: the provider's job, as only the browser can paint them.
   */
  readonly screenshot: (options: {
    readonly fullPage: boolean;
    readonly type: "png" | "jpeg";
    readonly mask: ReadonlyArray<string>;
  }) => Effect.Effect<Uint8Array, BrowserFailure>;
  /** Brings the tab to the front, as the one the session acts in. */
  readonly focus: () => Effect.Effect<void, BrowserFailure>;
}

/**
 * A browser's logins and site data (#215, a browser profile's content): its cookies and the local storage of each origin,
 * in Playwright's storage state's shape (`BrowserContext.storageState()`), which every provider's browsers are loaded
 * from and read into. Only the session's code and the Tools part, which seals it, see it: never a tool result.
 */
export const StorageState = Schema.Struct({
  cookies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
      domain: Schema.String,
      path: Schema.String,
      /** Unix time in seconds; -1 for a session cookie. */
      expires: Schema.Number,
      httpOnly: Schema.Boolean,
      secure: Schema.Boolean,
      sameSite: Schema.Literals(["Strict", "Lax", "None"]),
    }),
  ),
  origins: Schema.Array(
    Schema.Struct({
      origin: Schema.String,
      localStorage: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    }),
  ),
});

export type StorageState = typeof StorageState.Type;

/** A browser of the provider's, reached: its tabs, in the order they were opened. */
export interface ProviderBrowser {
  /** The provider's id of the browser, by which it is reached again. */
  readonly id: string;
  readonly tabs: () => Effect.Effect<ReadonlyArray<BrowserTab>, BrowserFailure>;
  readonly newTab: () => Effect.Effect<BrowserTab, BrowserFailure>;
  /** Its cookies and site storage now: what saving into a browser profile keeps (#215). */
  readonly storageState: () => Effect.Effect<StorageState, BrowserFailure>;
  /** Ends the browser at the provider; a browser already gone is no failure. */
  readonly close: () => Effect.Effect<void>;
}

/**
 * The browsers behind interactive sessions (#213): one per session, kept open at the provider between the session's
 * calls and reached again by its id.
 */
export interface BrowserSessionProvider {
  /** Opens a new browser with one blank tab, loaded with `state` (a browser profile's, #215) when given. */
  readonly open: (
    state?: StorageState,
  ) => Effect.Effect<ProviderBrowser, BrowserProviderError | BrowserLimitReached>;
  /** Reaches the browser `id` again; {@link BrowserGone} when the provider no longer has it. */
  readonly connect: (id: string) => Effect.Effect<ProviderBrowser, BrowserFailure>;
}

/**
 * Crawls of a site (#270): started, read page by page while and after they run, and cancelled, each by the provider's
 * id of the crawl job. The provider keeps a crawl's pages for a time of its own (Browser Run: 14 days after it ends).
 */
export interface BrowserCrawlProvider {
  /** Starts a crawl; answers its id. The URL has passed the outbound guard. */
  readonly start: (args: CrawlStartArguments) => Effect.Effect<string, BrowserProviderError>;
  readonly result: (id: string, page: CrawlPage) => Effect.Effect<CrawlJob, BrowserProviderError>;
  readonly cancel: (id: string) => Effect.Effect<void, BrowserProviderError>;
}

/** The service behind a browser toolkit, reached only through this interface. */
export interface BrowserProvider {
  /** Which provider it is: the browser toolkit's source (`browser-run`). */
  readonly id: string;
  readonly quickAction: (
    request: QuickActionRequest,
  ) => Effect.Effect<QuickActionAnswer, BrowserProviderError>;
  /**
   * Whether it has browsers for interactive sessions; a provider without serves the Quick Actions only. The session's
   * Durable Object reaches them by the provider's id (`sessionProviderOf`, `session-object.ts`), as it outlives the
   * call that opened it.
   */
  readonly sessions: boolean;
  /** Its crawls, when it has them; without, the toolkit has no crawl tools. */
  readonly crawls?: BrowserCrawlProvider | undefined;
}

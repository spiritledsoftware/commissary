/**
 * The browser-provider seam (ADR 0041, GLOSSARY "Browser provider"): the one interface through which the browser toolkit
 * reaches the service behind it. Browser Run (`browser-run.ts`, the deployment's own binding) is the only adapter built;
 * a later provider (Browserbase, Kernel) is another adapter of this interface, made from the toolkit's credential, plus
 * a catalog entry, and serves the same tools. The interface covers the stateless Quick Actions (#212); the interactive
 * sessions of #213 join it.
 *
 * A Quick Action is asked in Commissary's own words, provider-neutral: the action and its arguments as a client gave
 * them, decoded with the schemas of {@link QUICK_ACTIONS} (which the toolkit lists as the tools' input schemas). The
 * arguments are a subset of Browser Run's options, under its names: those that make sense for a client. Left out are
 * the options that would run script in the page (`addScriptTag`, ADR 0039: no tool runs JavaScript in the page), carry
 * sign-ins (`cookies`, `authenticate`, extra headers: logins are browser profiles' and handoff's, #213), render HTML
 * instead of a URL, choose a backend, or set Browser Run's cache (the provider never caches: results are not stored).
 * Crawling is not a Quick Action here: Browser Run's `/crawl` is on its REST API only, which needs an account API token
 * (docs/ARCHITECTURE.md "Tools").
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
 * A Quick Action the provider could not do. `message` is told to the model: the provider's own words about the page or
 * the arguments (a navigation that timed out, a malformed selector), never a secret.
 */
export class BrowserProviderError extends Schema.TaggedError<BrowserProviderError>()(
  "BrowserProviderError",
  {
    message: Schema.String,
    /** The provider's HTTP status, when it answered one. */
    status: optional(Schema.Number),
  },
) {}

/** The service behind a browser toolkit, reached only through this interface. */
export interface BrowserProvider {
  /** Which provider it is: the browser toolkit's source (`browser-run`). */
  readonly id: string;
  readonly quickAction: (
    request: QuickActionRequest,
  ) => Effect.Effect<QuickActionResult, BrowserProviderError>;
}

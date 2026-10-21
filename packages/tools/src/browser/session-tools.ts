/**
 * The browser toolkit's session tools (#213, ADR 0039): an interactive browser a client opens with `browser_open`,
 * which answers the browser session's id, and drives through the other tools, each of which takes that id (MCP calls
 * are stateless). Modelled on Playwright MCP's tool set, as Commissary's own code: navigate, back and forward, an
 * accessibility snapshot whose element references the actions take, click, type, press a key, select an option, hover,
 * wait for text or a selector, a screenshot, tabs (list, open, switch) and close. No tool runs JavaScript in the page
 * or returns an element's value beyond what the (masked) snapshot shows. A session may start from a browser profile
 * (`open`'s `profile`, #215), which `profile_list` lists, and save into it when it closes (`close`'s `save`).
 *
 * Each tool is one record of {@link SESSION_TOOLS}: its description, the Effect schema of its arguments (also its
 * input schema) and its class. Snapshot, screenshot, the tab list and the profile list read; the rest write (ADR
 * 0038). The calls go to the session's Durable Object (`session-object.ts`), which holds the browser.
 */
import { Result, Schema } from "effect";

const optional = Schema.optionalKey;

/** The longest a navigation or a wait may take, in ms. */
const MAX_TIMEOUT = 60_000;

/** How long a session stays open without a call (its Durable Object's alarm, `session-object.ts`). */
export const IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * How long a handoff waits for its person (#216, ADR 0039): thirty minutes, Browser Run's longest. `browser_ask_human`
 * answers by then at the latest.
 */
export const HANDOFF_TIMEOUT_MS = 30 * 60_000;

/** The longest reason a handoff takes: Browser Run's longest instructions. */
const MAX_REASON_LENGTH = 4096;

/** {@link IDLE_TIMEOUT_MS} in words, for what the tools tell a client. */
export const IDLE_TIME = `${IDLE_TIMEOUT_MS / 60_000} idle minutes`;

/**
 * Why `selector` is not bare CSS, or `undefined` when it is. Playwright reads a selector as a chain of engines (`a >>
 * b`) whose parts may name another engine (`xpath=`, `text=`, `internal:…=`); the session's selectors go to Playwright
 * as CSS only (`css=`, `browser-run-sessions.ts`), and anything that could reach another engine is refused: a chain, an
 * engine's prefix, a CSS escape or comment (which could spell one, or an attribute's name, past these checks).
 */
export const notCss = (selector: string): string | undefined => {
  if (selector.includes(">>")) return "a selector chain (>>) is not CSS";

  if (/^\s*[\w+*:-]+=/.test(selector))
    return "only CSS selectors are taken, without an engine's prefix";

  if (selector.includes("\\") || selector.includes("/*"))
    return "a CSS escape or comment is not taken";

  return undefined;
};

/**
 * Why `selector` cannot be waited for, or `undefined` when it can: it must be bare CSS ({@link notCss}) that cannot
 * probe a field's value. A wait answers whether its selector matched, so `input[value^="a"]` would tell a password's
 * first character, one call at a time: an attribute selector on `value`, or any attribute selector on an input or a
 * text area, is refused.
 */
const probesValue = (selector: string): string | undefined => {
  const css = notCss(selector);

  if (css !== undefined) return css;
  const attributes = selector.match(/\[[^\]]*\]?/g) ?? [];

  if (attributes.some((attribute) => /value/i.test(attribute)))
    return "a selector on an element's value is not taken";

  if (attributes.length > 0 && /\b(?:input|textarea)\b/i.test(selector))
    return "an attribute selector on an input field is not taken";

  return undefined;
};

const sessionId = Schema.String.annotate({
  description: "The browser session's id, as browser_open answered it.",
});

const ref = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The element's ref in the latest browser_snapshot of the tab, such as e3.",
});

const url = Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/i)).annotate({
  description: "The page's address, an http or https URL.",
});

const timeout = (description: string) =>
  optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_TIMEOUT })).annotate({
      description,
    }),
  );

const SESSION = { sessionId };

/** The tool class Commissary gives a session tool (ADR 0038). */
type SessionToolClass = "read" | "write";

/**
 * What a call of a session tool does with browser time (#214): `uses` it (it reaches the session's browser, which runs
 * on for it), `ends` it (it closes the session), or `none` (it reaches no browser). A call that uses browser time is
 * refused once a Spend limit it counts toward has no room while browser time has a price; one that ends it never is.
 */
export type BrowserTimeUse = "uses" | "ends" | "none";

interface SessionTool<S extends Schema.Top> {
  readonly description: string;
  readonly arguments: S;
  readonly toolClass: SessionToolClass;
  readonly browserTime: BrowserTimeUse;
}

const tool = <Fields extends Schema.Struct.Fields>(
  toolClass: SessionToolClass,
  description: string,
  fields: Fields,
  browserTime: BrowserTimeUse = "uses",
): SessionTool<Schema.Struct<Fields>> => ({
  description,
  arguments: Schema.Struct(fields),
  toolClass,
  browserTime,
});

/** `browser_wait_for`'s arguments: exactly one of a text and a selector. */
const WAIT_FOR = Schema.Struct({
  ...SESSION,
  text: optional(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "Text to wait for on the page.",
  }),
  selector: optional(
    Schema.String.check(Schema.isMinLength(1), Schema.makeFilter(probesValue)),
  ).annotate({
    description:
      "A CSS selector to wait for an element of: CSS only, without attribute selectors on values or input fields.",
  }),
  timeout: timeout(`How long to wait, in ms (default 10000, at most ${MAX_TIMEOUT}).`),
}).check(
  Schema.makeFilter((args) =>
    (args.text === undefined) === (args.selector === undefined)
      ? "give exactly one of text and selector"
      : undefined,
  ),
);

/**
 * The session tools, one record each, in the order the toolkit lists them (after the Quick Actions). Their upstream
 * names are Playwright MCP's, without its `browser_` prefix (the toolkit's full names add it back).
 */
export const SESSION_TOOLS = {
  open: tool(
    "write",
    "Open an interactive browser session, optionally at a page and from a browser profile (saved logins and site " +
      "data: browser_profile_list lists the ones you may use), and answer its id, which the other browser tools " +
      `take. It closes after ${IDLE_TIME}, or with browser_close.`,
    {
      url: optional(url),
      profile: optional(
        Schema.String.check(Schema.isMinLength(1)).annotate({
          description:
            "The name of a browser profile to start from, as browser_profile_list lists it: the session starts with its logins.",
        }),
      ),
    },
  ),
  navigate: tool("write", "Load a page in the session's current tab.", {
    ...SESSION,
    url,
    timeout: timeout(`How long the page may take to load, in ms (default 30000).`),
  }),
  navigate_back: tool(
    "write",
    "Go back to the previous page in the session's current tab.",
    SESSION,
  ),
  navigate_forward: tool(
    "write",
    "Go forward to the next page in the session's current tab.",
    SESSION,
  ),
  snapshot: tool(
    "read",
    "The accessibility snapshot of the session's current tab: its elements with their roles, names, text and refs, which click, type, select_option and hover take. Password fields are masked.",
    SESSION,
  ),
  click: tool("write", "Click an element of the current tab.", {
    ...SESSION,
    ref,
    button: optional(
      Schema.Literals(["left", "right", "middle"]).annotate({ description: "Default left." }),
    ),
    doubleClick: optional(Schema.Boolean),
  }),
  type: tool("write", "Type text into an input field of the current tab, replacing its value.", {
    ...SESSION,
    ref,
    text: Schema.String,
    submit: optional(
      Schema.Boolean.annotate({ description: "Press Enter afterwards, to submit the form." }),
    ),
  }),
  press_key: tool("write", "Press a key in the current tab.", {
    ...SESSION,
    key: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "The key, such as Enter, ArrowDown, Control+A or a character.",
    }),
  }),
  select_option: tool("write", "Select options of a drop-down in the current tab.", {
    ...SESSION,
    ref,
    values: Schema.Array(Schema.String)
      .check(Schema.isMinLength(1))
      .annotate({ description: "The values (or labels) of the options to select." }),
  }),
  hover: tool("write", "Move the mouse over an element of the current tab.", { ...SESSION, ref }),
  wait_for: {
    toolClass: "write",
    browserTime: "uses",
    description:
      "Wait until a text is shown, or an element matches a CSS selector, in the current tab.",
    arguments: WAIT_FOR,
  } satisfies SessionTool<typeof WAIT_FOR>,
  take_screenshot: tool("read", "A screenshot of the current tab. Password fields are masked.", {
    ...SESSION,
    fullPage: optional(
      Schema.Boolean.annotate({ description: "Capture the whole page, not just the viewport." }),
    ),
    type: optional(Schema.Literals(["png", "jpeg"]).annotate({ description: "Default png." })),
  }),
  tab_list: tool("read", "List the session's tabs, the current one marked.", SESSION),
  tab_new: tool("write", "Open a new tab, optionally at a page, and make it the current one.", {
    ...SESSION,
    url: optional(url),
  }),
  tab_select: tool("write", "Make a tab the current one, by its index in browser_tab_list.", {
    ...SESSION,
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  close: tool(
    "write",
    "Close the browser session, optionally saving its logins and site data back into the browser profile it was " +
      "opened from.",
    {
      ...SESSION,
      save: optional(
        Schema.Boolean.annotate({
          description:
            "Save the session's cookies and site storage into the profile it was opened from, replacing what it held. " +
            "Only the member of a private profile, or an org admin for a shared one, may save; the session closes either way.",
        }),
      ),
    },
    "ends",
  ),
  profile_list: tool(
    "read",
    "List the browser profiles you may open a session from (browser_open's profile), by name.",
    {},
    "none",
  ),
  ask_human: tool(
    "write",
    "Ask the person whose session it is to act in its current tab themselves, such as to sign in with a password or " +
      "solve a CAPTCHA: what they type never reaches you. They are asked in your client, or you get a link to give " +
      "them; then call this tool again with the same sessionId to wait. It answers when they click Done or Failed, " +
      `or after ${HANDOFF_TIMEOUT_MS / 60_000} minutes; a call that waited a while may answer that they are still ` +
      "acting: then call it again. The fields they filled stay masked in snapshots and screenshots.",
    {
      ...SESSION,
      reason: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(MAX_REASON_LENGTH),
      ).annotate({
        description:
          "What the person should do, shown to them in the browser, such as: Sign in to example.com, then click Done.",
      }),
    },
  ),
} as const;

export type SessionToolName = keyof typeof SESSION_TOOLS;

/** The session tool that closes a session, the one that ends its browser time. */
export const CLOSE_TOOL = "close" satisfies SessionToolName;

// SAFETY: `SESSION_TOOLS`'s own keys are exactly its names.
export const SESSION_TOOL_NAMES = Object.keys(SESSION_TOOLS) as ReadonlyArray<SessionToolName>;

/** The decoded arguments of the session tool `K`. */
type SessionToolArguments<K extends SessionToolName> =
  (typeof SESSION_TOOLS)[K]["arguments"]["Type"];

/** One call of a session tool, decoded. */
type SessionRequest = {
  readonly [K in SessionToolName]: { readonly tool: K; readonly args: SessionToolArguments<K> };
}[SessionToolName];

/**
 * A call that acts on the page of a session that is open: every tool but `open` and `profile_list`, which need none,
 * and `ask_human` (#216), which hands the page to a person (`session-object.ts`).
 */
export type SessionOperation = Exclude<
  SessionRequest,
  { readonly tool: "open" | "profile_list" | "ask_human" }
>;

export const isSessionTool = (name: string): name is SessionToolName =>
  Object.hasOwn(SESSION_TOOLS, name);

/** The request of a call of the session tool `name` with `args`, or why the arguments are invalid. */
export const sessionRequestOf = (
  name: SessionToolName,
  args: Schema.JsonObject,
): Result.Result<SessionRequest, string> => {
  const decoded = Schema.decodeUnknownResult(SESSION_TOOLS[name].arguments)(args);

  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure.message)
    : // SAFETY: the arguments were decoded with the schema of `name`.
      Result.succeed({ tool: name, args: decoded.success } as SessionRequest);
};

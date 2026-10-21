/**
 * What a browser session does with its browser (#213): the session tools' calls (`session-tools.ts`) as operations on
 * a provider's browser (`provider.ts`), whichever provider it is, and their MCP tool results. The session's Durable
 * Object (`session-object.ts`) holds the browser and its state (the current tab, the fields to mask) and runs these.
 *
 * **Masking.** A snapshot never shows the value of a password field, nor of a field the session was told to mask (the
 * fields a person filled during a handoff, #216: {@link SessionView.masks}). Playwright's snapshot copies every input's
 * value (`input.value`) as the element's text, whatever its role, so the session masks it before anyone sees it
 * ({@link maskSnapshot}): on a page where some element matches a masked selector, every element that shows a value and
 * matches one, or that the browser gave no ref (one that is not interactable, which cannot be asked), shows
 * {@link MASK} instead. The session never reads a field's value itself. A screenshot paints the same fields over (the
 * provider's `mask`). Once a handoff marked fields, the query of every address the session shows is masked too
 * ({@link maskUrl}), as a form sent with GET puts its fields there.
 *
 * The masking reads Playwright's rendering of its snapshot for a model (`renderAriaTree` in `@cloudflare/playwright`
 * 1.3.6), which Playwright keeps internal: `test/fixtures/` holds that rendering of a sign-in page, which a new version
 * of the package must be checked against (docs/ARCHITECTURE.md "Tools").
 */
import { Buffer } from "node:buffer";
import { Effect, type Schema } from "effect";
import { MAX_FILE_BYTES } from "./browser-run.ts";
import type { BrowserFailure, BrowserTab, ProviderBrowser } from "./provider.ts";
import type { SessionOperation } from "./session-tools.ts";

/** What masks every password field. */
export const PASSWORD_FIELDS = 'input[type="password" i]';

/** What a masked value shows instead: the same whatever its length. */
export const MASK = "••••••••";

const DEFAULT_NAVIGATION_TIMEOUT = 30_000;

const DEFAULT_WAIT_TIMEOUT = 10_000;

/** What an operation needs to know of its session. */
interface SessionView {
  /** The index of the current tab among the browser's tabs. */
  readonly tab: number;
  /** CSS selectors of the fields masked besides password fields (#216's handoff fields). */
  readonly masks: ReadonlyArray<string>;
  /**
   * Whether a handoff ended in the session (#216), whose fields may have gone with the page (a sign-in form sent and
   * left): the query of every address is masked from then on, whatever `masks` holds.
   */
  readonly maskUrls?: boolean | undefined;
}

/** A tool result that reports a failure to the model. */
export const toolError = (text: string): Schema.JsonObject => ({
  content: [{ type: "text", text }],
  isError: true,
});

export const textResult = (text: string): Schema.JsonObject => ({
  content: [{ type: "text", text }],
});

/** The selectors whose fields a session masks: password fields and `masks`. */
const maskedSelectors = (masks: ReadonlyArray<string>): ReadonlyArray<string> => [
  PASSWORD_FIELDS,
  ...masks,
];

/** One node line of a snapshot, read: its indent, its ref, and where its inline value starts. */
interface SnapshotLine {
  readonly indent: number;
  readonly ref: string | undefined;
  /** The line up to and including the `:` after its key, when a value or children follow. */
  readonly head: string | undefined;
  /** Whether the value is on the line (`key: value`), not in child lines. */
  readonly inlineValue: boolean;
}

/** The end of a single-quoted YAML key that starts at `start` (`''` is a quote inside it), or -1. */
const quotedKeyEnd = (line: string, start: number): number => {
  for (let index = start + 1; index < line.length; index++) {
    if (line[index] !== "'") continue;

    if (line[index + 1] === "'") index++;
    else return index;
  }

  return -1;
};

/** The key's attributes Playwright puts last: its ref, and maybe its pointer cursor. */
const REF_AT_END = / \[ref=([^\]\s]+)\](?: \[cursor=pointer\])?$/;

/**
 * Reads a line of Playwright's rendering of a snapshot (`renderAriaTree`); `undefined` for one that is not a node: a
 * text line (`- text: …`) or a property (`- /url: …`).
 */
const readLine = (line: string): SnapshotLine | undefined => {
  const bullet = /^( *)- /.exec(line);

  if (bullet === null) return undefined;
  const indent = bullet[1]?.length ?? 0;
  const start = bullet[0].length;
  let key: string;
  let rest: string;

  if (line[start] === "'") {
    const end = quotedKeyEnd(line, start);

    if (end === -1) return undefined;
    key = line.slice(start + 1, end).replaceAll("''", "'");
    rest = line.slice(end + 1);
  } else {
    // An unquoted key holds no `: ` and does not end in `:` (Playwright quotes those).
    const colon = /:( |$)/.exec(line.slice(start));

    key = colon === null ? line.slice(start) : line.slice(start, start + colon.index);
    rest = colon === null ? "" : line.slice(start + colon.index);
  }

  if (key === "text" || key.startsWith("/")) return undefined;
  const ref = REF_AT_END.exec(key)?.[1];
  const head = rest.startsWith(":") ? line.slice(0, line.length - rest.length + 1) : undefined;

  return { indent, ref, head, inlineValue: rest.startsWith(": ") };
};

/** A node line that shows a value: inline, or in `- text:` lines right under it (`textAt`, their indexes). */
interface ValuedLine extends SnapshotLine {
  readonly at: number;
  readonly textAt: ReadonlyArray<number>;
}

/** The node lines of `lines` that show a value. */
const valuedLines = (lines: ReadonlyArray<string>): ReadonlyArray<ValuedLine> => {
  const valued: Array<ValuedLine> = [];

  for (const [at, line] of lines.entries()) {
    const read = readLine(line);

    if (read === undefined || read.head === undefined) continue;

    if (read.inlineValue) {
      valued.push({ ...read, at, textAt: [] });
      continue;
    }

    // Its children: the lines below it indented deeper; its own text lines are those one level in.
    const childIndent = " ".repeat(read.indent + 2);
    const textAt: Array<number> = [];

    for (let index = at + 1; (lines[index] ?? "").startsWith(childIndent); index++)
      if ((lines[index] ?? "").startsWith(`${childIndent}- text:`)) textAt.push(index);

    if (textAt.length > 0) valued.push({ ...read, at, textAt });
  }

  return valued;
};

/**
 * `snapshot` (Playwright's rendering) with the values of the masked elements of `tab` replaced by {@link MASK}. When
 * no element of the page, in any frame, matches `selectors`, it is shown as it is. Otherwise every element that shows a
 * value (on its line, or in its `- text:` lines) is masked when it matches `selectors`, or when the browser gave it no
 * ref, as it cannot be asked: whatever its role, as an input with a role of its own (`<input role="button">`) shows its
 * value too.
 */
export const maskSnapshot = Effect.fnUntraced(function* (
  tab: BrowserTab,
  snapshot: string,
  selectors: ReadonlyArray<string>,
): Effect.fn.Return<string, BrowserFailure> {
  const selector = selectors.join(", ");

  if ((yield* tab.countMatching(selector)) === 0) return snapshot;
  const lines = snapshot.split("\n");
  const valued = valuedLines(lines);
  const refs = valued.flatMap((line) => (line.ref === undefined ? [] : [line.ref]));
  const masked = refs.length === 0 ? new Set<string>() : yield* tab.maskedRefs(refs, selector);

  for (const line of valued) {
    if (line.ref !== undefined && !masked.has(line.ref)) continue;

    if (line.inlineValue) lines[line.at] = `${line.head} ${MASK}`;

    for (const at of line.textAt) lines[at] = `${" ".repeat(line.indent + 2)}- text: ${MASK}`;
  }

  return lines.join("\n");
});

/**
 * `url` with the values of its query masked (`?user=••••••••`), once a handoff marked fields to mask: a form sent
 * with GET carries its fields in the next page's address. A URL that cannot be read is masked whole.
 */
const maskUrl = (url: string, view: SessionView): string => {
  if (view.masks.length === 0 && view.maskUrls !== true) return url;

  try {
    const parsed = new URL(url);

    if (parsed.search === "") return url;

    const masked = [...parsed.searchParams.keys()].map(
      (key) => `${encodeURIComponent(key)}=${MASK}`,
    );

    return `${parsed.origin}${parsed.pathname}?${masked.join("&")}${parsed.hash}`;
  } catch {
    return MASK;
  }
};

const pageLines = Effect.fnUntraced(function* (tab: BrowserTab, view: SessionView) {
  return `- Page URL: ${maskUrl(tab.url(), view)}\n- Page Title: ${yield* tab.title()}`;
});

/** The tab the session acts in, and its index: the current one, or the last one when that was closed. */
export const currentTab = Effect.fnUntraced(function* (
  browser: ProviderBrowser,
  view: SessionView,
) {
  const tabs = yield* browser.tabs();
  const tab = tabs[view.tab];

  if (tab !== undefined) return { tab, index: view.tab };
  const last = tabs.at(-1);

  if (last !== undefined) return { tab: last, index: tabs.length - 1 };

  return { tab: yield* browser.newTab(), index: 0 };
});

/** What an operation answers: its tool result, and the session's current tab afterwards. */
interface OperationResult {
  readonly result: Schema.JsonObject;
  readonly tab: number;
}

/**
 * Runs `operation` on `browser`, in the tab `view` names. Fails with the provider's failures; a call the session
 * cannot do (a tab that does not exist, an oversized screenshot) is a tool result with `isError`.
 */
export const runOperation = Effect.fnUntraced(function* (
  browser: ProviderBrowser,
  view: SessionView,
  operation: Exclude<SessionOperation, { readonly tool: "close" }>,
): Effect.fn.Return<OperationResult, BrowserFailure> {
  const { tab, index } = yield* currentTab(browser, view);

  /** The page after an action, as the action's result. */
  const acted = Effect.map(pageLines(tab, view), (text) => ({
    result: textResult(text),
    tab: index,
  }));

  switch (operation.tool) {
    case "navigate":
      yield* tab.goto(operation.args.url, operation.args.timeout ?? DEFAULT_NAVIGATION_TIMEOUT);

      return yield* acted;
    case "navigate_back":
      yield* tab.back(DEFAULT_NAVIGATION_TIMEOUT);

      return yield* acted;
    case "navigate_forward":
      yield* tab.forward(DEFAULT_NAVIGATION_TIMEOUT);

      return yield* acted;
    case "snapshot": {
      const snapshot = yield* tab.snapshot();
      const masked = yield* maskSnapshot(tab, snapshot, maskedSelectors(view.masks));

      return {
        result: textResult(
          `${yield* pageLines(tab, view)}\n- Page Snapshot:\n\`\`\`yaml\n${masked}\n\`\`\``,
        ),
        tab: index,
      };
    }

    case "click":
      yield* tab.click(operation.args.ref, {
        button: operation.args.button ?? "left",
        doubleClick: operation.args.doubleClick ?? false,
      });

      return yield* acted;
    case "type":
      yield* tab.fill(operation.args.ref, operation.args.text);

      if (operation.args.submit === true) yield* tab.press("Enter");

      return yield* acted;
    case "press_key":
      yield* tab.press(operation.args.key);

      return yield* acted;
    case "select_option":
      yield* tab.selectOption(operation.args.ref, operation.args.values);

      return yield* acted;
    case "hover":
      yield* tab.hover(operation.args.ref);

      return yield* acted;
    case "wait_for": {
      const { text, selector } = operation.args;
      const wait = operation.args.timeout ?? DEFAULT_WAIT_TIMEOUT;

      if (text !== undefined) yield* tab.waitFor({ text }, wait);
      else if (selector !== undefined) yield* tab.waitFor({ selector }, wait);

      return yield* acted;
    }

    case "take_screenshot": {
      const type = operation.args.type ?? "png";

      const data = yield* tab.screenshot({
        fullPage: operation.args.fullPage ?? false,
        type,
        mask: maskedSelectors(view.masks),
      });

      if (data.byteLength > MAX_FILE_BYTES)
        return {
          result: toolError(`the screenshot is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`),
          tab: index,
        };

      return {
        result: {
          content: [
            {
              type: "image",
              data: Buffer.from(data).toString("base64"),
              mimeType: `image/${type}`,
            },
          ],
        },
        tab: index,
      };
    }

    case "tab_list": {
      const tabs = yield* browser.tabs();
      const lines: Array<string> = [];

      for (const [position, each] of tabs.entries())
        lines.push(
          `- ${position}: ${yield* each.title()} (${maskUrl(each.url(), view)})${position === index ? " [current]" : ""}`,
        );

      return { result: textResult(lines.join("\n")), tab: index };
    }

    case "tab_new": {
      const opened = yield* browser.newTab();

      if (operation.args.url !== undefined)
        yield* opened.goto(operation.args.url, DEFAULT_NAVIGATION_TIMEOUT);

      yield* opened.focus();
      const tabs = yield* browser.tabs();

      return {
        result: textResult(yield* pageLines(opened, view)),
        tab: Math.max(tabs.length - 1, 0),
      };
    }

    case "tab_select": {
      const tabs = yield* browser.tabs();
      const selected = tabs[operation.args.index];

      if (selected === undefined)
        return {
          result: toolError(
            `The session has no tab ${operation.args.index}; browser_tab_list lists its tabs.`,
          ),
          tab: index,
        };

      yield* selected.focus();

      return { result: textResult(yield* pageLines(selected, view)), tab: operation.args.index };
    }
  }
});

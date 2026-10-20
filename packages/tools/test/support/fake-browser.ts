// A fake Browser Run binding (`quickAction()` only) and a fake second browser provider, for the browser toolkit's tests
// (#212). The binding answers the way Browser Run's does, from the options it was asked with, and records each call:
// Markdown, HTML, links, scraped elements and the accessibility tree as JSON; a screenshot and a PDF as bytes; a page on
// `unreachable.invalid` as Browser Run's refusal; each answer says it used {@link BROWSER_MS} of browser time
// (`X-Browser-Ms-Used`, #214), as Browser Run's do below status 500. The second provider answers every Quick Action as text naming itself,
// so a test tells which provider served a call.
import type { BrowserRunBinding } from "../../src/browser/browser-run.ts";
import type { BrowserProvider } from "../../src/browser/provider.ts";
import { Effect, type Schema } from "effect";

export interface RecordedQuickAction {
  readonly action: string;
  readonly options: Record<string, unknown>;
}

export interface FakeBrowserRun extends BrowserRunBinding {
  readonly calls: Array<RecordedQuickAction>;
}

/** The browser time every answer of the fake binding reports, in milliseconds (#214). */
export const BROWSER_MS = 1_500;

/** The first bytes of a PNG, as a screenshot. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The first bytes of a PDF. */
export const PDF_BYTES = new TextEncoder().encode("%PDF-1.7");

/** A body of Browser Run's: a success with its `result`, or a refusal with its `errors`. */
type Answer =
  | {
      readonly success: true;
      readonly result: Schema.Json;
      readonly meta: { readonly status: number; readonly title: string };
    }
  | { readonly success: false; readonly errors: ReadonlyArray<{ readonly message: string }> };

const json = (body: Answer, status = 200) => Response.json(body, { status });

const success = (result: Schema.Json, url: string) =>
  json({ success: true, result, meta: { status: 200, title: `Page at ${url}` } });

const answer = (action: string, options: Record<string, unknown>, bytes?: Uint8Array) => {
  const url = String(options["url"]);

  if (url.includes("unreachable.invalid"))
    return json(
      { success: false, errors: [{ message: `net::ERR_NAME_NOT_RESOLVED at ${url}` }] },
      422,
    );

  switch (action) {
    case "markdown":
      return success(`# Page at ${url}`, url);
    case "content":
      return success(`<html><body>Page at ${url}</body></html>`, url);
    case "links":
      return success([`${url}/a`, `${url}/b`], url);
    case "scrape":
      return success(
        // SAFETY: the toolkit always sends `elements` to scrape.
        (options["elements"] as ReadonlyArray<{ selector: string }>).map(({ selector }) => ({
          selector,
          results: [{ text: `${selector} text`, html: "", attributes: [] }],
        })),
        url,
      );
    case "accessibilityTree":
      return success({ accessibilityTree: { role: "RootWebArea", name: url } }, url);
    case "screenshot":
      return new Response(bytes ?? PNG_BYTES, { headers: { "content-type": "image/png" } });
    case "pdf":
      return new Response(bytes ?? PDF_BYTES, { headers: { "content-type": "application/pdf" } });
    default:
      return json({ success: false, errors: [{ message: `no action ${action}` }] }, 400);
  }
};

/** `response` with the browser time Browser Run reports below status 500. */
const used = (response: Response): Response => {
  if (response.status < 500) response.headers.set("x-browser-ms-used", String(BROWSER_MS));

  return response;
};

/** A fake `browser` binding; `screenshotBytes` replaces the screenshot it answers. */
export const fakeBrowserRun = (screenshotBytes?: Uint8Array): FakeBrowserRun => {
  const calls: Array<RecordedQuickAction> = [];

  const quickAction = async (action: string, given: BrowserRunCommonOptions) => {
    const options: Record<string, unknown> = Object.fromEntries(Object.entries(given));

    calls.push({ action, options });

    return used(answer(action, options, action === "screenshot" ? screenshotBytes : undefined));
  };

  return {
    calls,
    // SAFETY: one implementation answers every overload of `quickAction`, from the action it is asked.
    quickAction: quickAction as BrowserRunBinding["quickAction"],
  };
};

/**
 * Another browser provider, answering every Quick Action as text that names it and the page, with browsers for sessions
 * (the test Worker's session objects give every provider the fake's, `fake-sessions.ts`).
 */
export const fakeOtherProvider = (): BrowserProvider => ({
  id: "other-browser",
  sessions: true,
  quickAction: (request) =>
    Effect.succeed({
      result: { kind: "text", text: `other-browser ${request.action} ${request.args.url}` },
      browserMs: undefined,
    }),
});

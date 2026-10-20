/**
 * Browser Run's crawls (#270, https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/), as a
 * {@link BrowserCrawlProvider}: `/crawl` is on Browser Run's REST API only, not its binding, so the adapter calls
 * `https://api.cloudflare.com/client/v4/accounts/<account>/browser-run/crawl` with an API token of the account that has
 * "Browser Run - Edit" (the deploy's optional `BROWSER_RUN_ACCOUNT_ID` and `BROWSER_RUN_API_TOKEN`). The API reference
 * still names the path by the product's old name, `/browser-rendering/crawl`; the product's docs use `/browser-run/`,
 * which is the one called here (the other is the one to fall back to should it stop answering). A crawl starts with a
 * `POST` that answers its job id; a `GET` of the job answers its status and its pages, a page of them at a time; a
 * `DELETE` cancels it. Browser Run keeps a crawl's pages 14 days after it ends, and ends one that runs seven days.
 *
 * The request goes to Cloudflare's API, a fixed host, so it does not pass the outbound guard; the URL a crawl starts
 * from does, before it gets here (`crawl-tools.ts`). Failures are as the Quick Actions' (`browser-run-http.ts`):
 * Browser Run's own words, or Commissary's when it could not be reached or answered something unreadable. A page of a
 * crawl's results larger than {@link MAX_CRAWL_RESULT_BYTES} is refused unread, so a few large pages cannot fill the
 * ControlPlane's memory and the model's context: the caller asks for fewer at a time.
 */
import { Effect, Redacted, Schema } from "effect";
import { cappedJson, compact, decoded, fail, refusal } from "./browser-run-http.ts";
import type { BrowserCrawlProvider, CrawlJob, CrawlStartArguments } from "./provider.ts";

/** Cloudflare's API. */
const API = "https://api.cloudflare.com/client/v4";

/** How long one request of the crawl API may take: it answers at once, as the crawl runs on its own. */
const REQUEST_TIMEOUT = "1 minute";

/** The largest page of a crawl's results read: its pages' content in one tool result. */
export const MAX_CRAWL_RESULT_BYTES = 1024 * 1024;

/** The account the crawls run under, and its API token with "Browser Run - Edit", unwrapped only to send it. */
export interface BrowserRunCrawlCredentials {
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted<string>;
}

/**
 * The crawl credentials a deployment's settings give (both set, trimmed), or `undefined`: a deployment without them has
 * no crawl tools.
 */
export const crawlCredentialsOf = (settings: {
  readonly BROWSER_RUN_ACCOUNT_ID?: string | undefined;
  readonly BROWSER_RUN_API_TOKEN?: string | undefined;
}): BrowserRunCrawlCredentials | undefined => {
  const accountId = settings.BROWSER_RUN_ACCOUNT_ID?.trim() ?? "";
  const apiToken = settings.BROWSER_RUN_API_TOKEN?.trim() ?? "";

  return accountId === "" || apiToken === ""
    ? undefined
    : { accountId, apiToken: Redacted.make(apiToken) };
};

const StartBody = Schema.Struct({ result: Schema.String });

const JobBody = Schema.Struct({
  result: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    total: Schema.optionalKey(Schema.Finite),
    finished: Schema.optionalKey(Schema.Finite),
    skipped: Schema.optionalKey(Schema.Finite),
    records: Schema.optionalKey(Schema.Array(Schema.Json)),
    cursor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  }),
});

/** Browser Run's body for a crawl of `args`: the client's arguments under its names, the page's load as its options. */
const startBody = (args: CrawlStartArguments) => {
  const { waitUntil, timeout, waitForSelector, ...crawl } = args;

  return {
    ...crawl,
    ...(waitUntil === undefined && timeout === undefined
      ? {}
      : { gotoOptions: compact({ waitUntil, timeout }) }),
    ...(waitForSelector === undefined ? {} : { waitForSelector: { selector: waitForSelector } }),
  };
};

/** The path of the crawl job `id`, under the crawls'. */
const job = (id: string) => `/${encodeURIComponent(id)}`;

/** What a crawl is started with: Browser Run's JSON body. */
type CrawlBody = ReturnType<typeof startBody>;

const tooLarge = fail(
  `the pages asked for come to more than ${MAX_CRAWL_RESULT_BYTES / 1024 / 1024} MiB: ask for fewer at a time with a smaller limit, going on from the same cursor`,
);

/** Browser Run's crawls under `credentials`; `fetcher` is the global `fetch` but in tests. */
export const browserRunCrawls = (
  credentials: BrowserRunCrawlCredentials,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): BrowserCrawlProvider => {
  const base = `${API}/accounts/${encodeURIComponent(credentials.accountId)}/browser-run/crawl`;

  /**
   * Sends one request of the crawl API; a response that is not ok fails with Browser Run's words. A request that takes
   * longer than {@link REQUEST_TIMEOUT} is aborted (the timeout interrupts it, which aborts its `signal`). One race is
   * left: Browser Run may have started a crawl whose answer was lost (a timeout or a dropped connection after it
   * accepted the `POST`); that crawl is logged for no one, so no one reaches or cancels it, and it ends by itself at
   * its page limit, or after seven days.
   */
  const send = (method: "POST" | "GET" | "DELETE", path: string, body?: CrawlBody) =>
    Effect.tryPromise({
      try: (signal) =>
        fetcher(`${base}${path}`, {
          method,
          signal,
          headers: {
            authorization: `Bearer ${Redacted.value(credentials.apiToken)}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      catch: () => fail("Browser Run could not be reached"),
    }).pipe(
      Effect.flatMap((response) => (response.ok ? Effect.succeed(response) : refusal(response))),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(fail(`Browser Run did not answer within ${REQUEST_TIMEOUT}`)),
      }),
    );

  return {
    start: (args) =>
      send("POST", "", startBody(args)).pipe(
        Effect.flatMap((response) => decoded(response, StartBody)),
        Effect.map(({ result }) => result),
      ),
    result: (id, page) => {
      const query = new URLSearchParams({ limit: String(page.limit) });

      if (page.cursor !== undefined) query.set("cursor", page.cursor);

      if (page.status !== undefined) query.set("status", page.status);

      return send("GET", `${job(id)}?${query.toString()}`).pipe(
        Effect.flatMap((response) =>
          cappedJson(response, MAX_CRAWL_RESULT_BYTES, tooLarge, JobBody),
        ),
        Effect.map(({ result }): CrawlJob => ({
          id: result.id,
          status: result.status,
          total: result.total,
          finished: result.finished,
          skipped: result.skipped,
          records: result.records ?? [],
          cursor: result.cursor === undefined ? undefined : String(result.cursor),
        })),
      );
    },
    cancel: (id) => send("DELETE", job(id)).pipe(Effect.asVoid),
  };
};

/**
 * The browser toolkit's crawl tools (#270, ADR 0039): `browser_crawl_start` starts crawling a site from a URL and
 * answers the crawl's id; `browser_crawl_result` reads its status and its pages, a page of them at a time;
 * `browser_crawl_cancel` stops it. A crawl runs at the browser provider on its own (Browser Run: up to seven days) and
 * the provider keeps its pages (Browser Run: 14 days after it ends); Commissary keeps none of them. The toolkit has them
 * only when its provider has crawls (`BrowserProvider.crawls`). Starting and cancelling write; reading reads (ADR 0038).
 *
 * Two rules are Commissary's, above the provider:
 * - The URL a crawl starts from is a URL a member supplied, so it passes the outbound guard (ADR 0044): public `https:`
 *   addresses only, none of the deployment's own hosts. The pages the crawl then follows are the provider's to fetch,
 *   from its own network, as a browser session's navigations are.
 * - A crawl belongs to the member and principal that started it, as a browser session does: the provider's ids are
 *   account-wide, so the Tools part logs each crawl it starts for its caller ({@link CrawlLog}), and a crawl the caller
 *   did not start is no crawl of theirs, whoever started it.
 *
 * Invalid arguments, a refused URL, an unknown crawl and the provider's failures are tool results with `isError`, so the
 * model can correct itself.
 */
import { checkOutboundUrl, type OutboundPolicy } from "@commissary/core";
import { Effect, Result, Schema } from "effect";
import { textResult, toolError } from "./session.ts";
import {
  type BrowserCrawlProvider,
  type BrowserProviderError,
  CRAWL_RECORD_STATUSES,
  type CrawlJob,
  crawlStartArguments,
} from "./provider.ts";

const optional = Schema.optionalKey;

/**
 * The pages `browser_crawl_result` answers unless told otherwise, and the most it answers at once: a page's content is
 * HTML or Markdown, and the adapter refuses an answer above its byte cut (Browser Run's: `MAX_CRAWL_RESULT_BYTES`).
 */
const DEFAULT_PAGES = 5;

const MAX_PAGES = 20;

/** A crawl's id as providers spell them (Browser Run: a UUID): nothing that could reach another path of their API. */
const crawlId = Schema.String.check(Schema.isPattern(/^[\w-]{1,128}$/)).annotate({
  description: "The crawl's id, as browser_crawl_start answered it.",
});

const CRAWL_RESULT = Schema.Struct({
  crawlId,
  cursor: optional(
    Schema.Union([Schema.String, Schema.Int]).annotate({
      description:
        "Where to go on from: the cursor of the previous answer, when it had more pages.",
    }),
  ),
  limit: optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGES })).annotate({
      description: `The most pages to answer (default ${DEFAULT_PAGES}).`,
    }),
  ),
  status: optional(
    Schema.Literals(CRAWL_RECORD_STATUSES).annotate({
      description: "Only the pages of this status.",
    }),
  ),
});

const CRAWL_CANCEL = Schema.Struct({ crawlId });

/** The crawl tools, one record each, in the order the toolkit lists them; a crawl takes at most `maxPages` pages. */
const crawlTools = (maxPages: number) => ({
  crawl_start: {
    description:
      "Start crawling a website from a URL: following its links and sitemaps, load each page in a browser and keep it as HTML or Markdown. Answers the crawl's id at once; the crawl runs on its own, for minutes or longer. Read it with browser_crawl_result.",
    arguments: crawlStartArguments(maxPages),
    reads: false,
  },
  crawl_result: {
    description:
      "Read a crawl browser_crawl_start started: its status (running, completed, errored, cancelled_...), how many pages it found and crawled, and its pages with their content, a page of them at a time (cursor).",
    arguments: CRAWL_RESULT,
    reads: true,
  },
  crawl_cancel: {
    description: "Cancel a crawl browser_crawl_start started; the pages it crawled stay readable.",
    arguments: CRAWL_CANCEL,
    reads: false,
  },
});

export type CrawlToolName = keyof ReturnType<typeof crawlTools>;

/** The crawl tools' names, in the order the toolkit lists them. */
const CRAWL_TOOL_NAMES: ReadonlyArray<CrawlToolName> = [
  "crawl_start",
  "crawl_result",
  "crawl_cancel",
];

export const isCrawlTool = (name: string): name is CrawlToolName =>
  CRAWL_TOOL_NAMES.some((tool) => tool === name);

/** A crawl tool as the toolkit lists it. */
export interface CrawlTool {
  /** Its upstream name (the full name is `browser_<name>`). */
  readonly name: CrawlToolName;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
  /** `readOnlyHint` gives a tool the class `read` (ADR 0038). */
  readonly annotations: Schema.JsonObject;
}

/** The crawl tools of a deployment whose crawls take at most `maxPages` pages, in the order the toolkit lists them. */
export const crawlToolList = (maxPages: number): ReadonlyArray<CrawlTool> => {
  const tools = crawlTools(maxPages);

  return CRAWL_TOOL_NAMES.map((name) => ({
    name,
    description: tools[name].description,
    // SAFETY: a JSON Schema document's schema is a JSON object.
    inputSchema: Schema.toJsonSchemaDocument(tools[name].arguments).schema as Schema.JsonObject,
    annotations: { readOnlyHint: tools[name].reads },
  }));
};

/** The crawls of the caller: the Tools part's log of who started each (`crawls.ts`). */
export interface CrawlLog {
  /** The caller started the crawl `id`. */
  readonly started: (id: string) => void;
  /** Whether the caller started the crawl `id` (and it is still kept). */
  readonly owns: (id: string) => boolean;
}

/**
 * A crawl tool's call as the Tools part makes it: under which outbound policy, with the caller's crawls, and the most
 * pages a crawl may take on the deployment (`COMMISSARY_CRAWL_MAX_PAGES`).
 */
export interface CrawlCall {
  readonly policy: OutboundPolicy;
  readonly log: CrawlLog;
  readonly maxPages: number;
}

/** `schema`'s decoding of a client's arguments, or why they are invalid. */
const decode = <S extends Schema.Decoder<unknown>>(schema: S, args: Schema.JsonObject) =>
  Result.mapError(
    Schema.decodeUnknownResult(schema)(args),
    (error) => `Invalid arguments: ${error.message}`,
  );

/** A crawl job as a tool result: its JSON. */
const rendered = (job: CrawlJob): Schema.JsonObject => textResult(JSON.stringify(job));

const unknownCrawl = (id: string) => toolError(`There is no crawl ${id}.`);

/** The provider's call for the crawl tool `name` with the client's `args`, or the tool result that refuses it. */
const request = (
  crawls: BrowserCrawlProvider,
  name: CrawlToolName,
  args: Schema.JsonObject,
  call: CrawlCall,
): Result.Result<Effect.Effect<Schema.JsonObject, BrowserProviderError>, Schema.JsonObject> => {
  switch (name) {
    case "crawl_start": {
      const decoded = decode(crawlStartArguments(call.maxPages), args);

      if (Result.isFailure(decoded)) return Result.fail(toolError(decoded.failure));
      const checked = checkOutboundUrl(decoded.success.url, call.policy);

      if (Result.isFailure(checked))
        return Result.fail(toolError(`Invalid arguments: ${checked.failure.message}`));

      return Result.succeed(
        crawls.start({ ...decoded.success, url: checked.success.href }).pipe(
          Effect.tap((id) => Effect.sync(() => call.log.started(id))),
          Effect.map((id): Schema.JsonObject => ({
            content: [
              {
                type: "text",
                text: `Started crawl ${id}. Read its status and pages with browser_crawl_result, and stop it with browser_crawl_cancel.`,
              },
            ],
            structuredContent: { crawlId: id },
          })),
        ),
      );
    }

    case "crawl_result": {
      const decoded = decode(CRAWL_RESULT, args);

      if (Result.isFailure(decoded)) return Result.fail(toolError(decoded.failure));
      const { crawlId: id, cursor, limit, status } = decoded.success;

      if (!call.log.owns(id)) return Result.fail(unknownCrawl(id));

      return Result.succeed(
        crawls
          .result(id, {
            cursor: cursor === undefined ? undefined : String(cursor),
            limit: limit ?? DEFAULT_PAGES,
            status,
          })
          .pipe(Effect.map(rendered)),
      );
    }

    case "crawl_cancel": {
      const decoded = decode(CRAWL_CANCEL, args);

      if (Result.isFailure(decoded)) return Result.fail(toolError(decoded.failure));
      const id = decoded.success.crawlId;

      if (!call.log.owns(id)) return Result.fail(unknownCrawl(id));

      return Result.succeed(
        crawls.cancel(id).pipe(Effect.as(textResult(`Cancelled crawl ${id}.`))),
      );
    }
  }
};

/**
 * Calls the crawl tool `name` (its upstream name) with the client's arguments on `crawls`, for the caller whose crawls
 * `call.log` holds. Never fails: an unknown tool, invalid arguments, a refused URL, a crawl not the caller's and the
 * provider's failures are tool results with `isError`.
 */
export const callCrawlTool = (
  crawls: BrowserCrawlProvider,
  name: string,
  args: Schema.JsonObject | undefined,
  call: CrawlCall,
): Effect.Effect<Schema.JsonObject> => {
  if (!isCrawlTool(name)) return Effect.succeed(toolError(`The browser has no tool ${name}.`));
  const asked = request(crawls, name, args ?? {}, call);

  if (Result.isFailure(asked)) return Effect.succeed(asked.failure);

  return asked.success.pipe(
    Effect.catchTag("BrowserProviderError", (error) =>
      Effect.logWarning("browser crawl failed").pipe(
        Effect.annotateLogs({
          tool: name,
          ...(error.status === undefined ? {} : { status: error.status }),
        }),
        Effect.as(toolError(error.message)),
      ),
    ),
  );
};

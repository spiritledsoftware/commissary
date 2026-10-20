// The browser toolkit's crawl tools (#270) over Browser Run's crawl REST API (a fake, test/support/fake-crawl.ts): the
// tools they list and their class, what a call asks Browser Run for (and what it never does), the deployment's cap on a
// crawl's pages, the outbound guard on the URL a crawl starts from, the crawls a caller may reach (the ones the log says
// they started), the cut on a result's size, a request that does not answer (driven by TestClock), and Browser Run's
// refusals as tool results.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Redacted, type Schema } from "effect";
import { TestClock } from "effect/testing";
import { browserRunCrawls } from "../../src/browser/browser-run-crawls.ts";
import { callCrawlTool, type CrawlLog, crawlToolList } from "../../src/browser/crawl-tools.ts";
import {
  CRAWL_ACCOUNT,
  CRAWL_TOKEN,
  type FakeCrawlApi,
  fakeCrawlApi,
} from "../support/fake-crawl.ts";
import { textOf } from "../support/tool-result.ts";

const POLICY = { ownHosts: ["app.example.com"], localDevelopment: false };

const CRAWL_PATH = `/client/v4/accounts/${CRAWL_ACCOUNT}/browser-run/crawl`;

/** The deployment's cap on a crawl's pages in these tests. */
const MAX_PAGES = 50;

/** A log of the crawls the caller started, in memory. */
const crawlLog = (): CrawlLog & { readonly ids: Set<string> } => {
  const ids = new Set<string>();

  return { ids, started: (id) => void ids.add(id), owns: (id) => ids.has(id) };
};

const call = (
  api: Pick<FakeCrawlApi, "fetch">,
  log: CrawlLog,
  tool: string,
  args?: Schema.JsonObject,
  token = CRAWL_TOKEN,
) =>
  callCrawlTool(
    browserRunCrawls({ accountId: CRAWL_ACCOUNT, apiToken: Redacted.make(token) }, api.fetch),
    tool,
    args,
    { policy: POLICY, log, maxPages: MAX_PAGES },
  );

/** Starts a crawl of `url` for `log`'s caller; answers its id. */
const started = (api: FakeCrawlApi, log: CrawlLog, url = "https://docs.example.com/") =>
  Effect.gen(function* () {
    const result = yield* call(api, log, "crawl_start", { url });

    // SAFETY: a started crawl answers its id in the structured content.
    return (result["structuredContent"] as { crawlId: string }).crawlId;
  });

describe("the crawl tools", () => {
  it("are start and cancel, which write, and result, which reads", () => {
    const tools = crawlToolList(MAX_PAGES);

    expect(
      tools.map((tool) => [tool.name, tool.annotations, tool.inputSchema["required"]]),
    ).toEqual([
      ["crawl_start", { readOnlyHint: false }, ["url"]],
      ["crawl_result", { readOnlyHint: true }, ["crawlId"]],
      ["crawl_cancel", { readOnlyHint: false }, ["crawlId"]],
    ]);

    // SAFETY: the start's input schema is an object schema with its properties.
    const start = tools[0]?.inputSchema["properties"] as Record<string, Record<string, unknown>>;

    expect(start["limit"]?.["description"]).toBe(
      `The most pages to crawl (default 10, at most ${MAX_PAGES}).`,
    );
    expect(Object.keys(start)).not.toContain("maxAge");
  });

  it.effect(
    "refuse a crawl of more pages than the deployment allows, or deeper than 100 links, without asking Browser Run",
    () =>
      Effect.gen(function* () {
        const api = fakeCrawlApi();
        const url = "https://docs.example.com/";

        for (const args of [
          { url, limit: MAX_PAGES + 1 },
          { url, limit: 0 },
          { url, depth: 101 },
        ]) {
          const result = yield* call(api, crawlLog(), "crawl_start", args);

          expect(result["isError"]).toBe(true);
          expect(textOf(result)).toMatch(/^Invalid arguments: /);
        }

        expect(api.requests).toEqual([]);
        yield* call(api, crawlLog(), "crawl_start", { url, limit: MAX_PAGES, depth: 100 });
        expect(api.requests).toHaveLength(1);
      }),
  );

  it.effect(
    "never send Browser Run sign-ins, extra headers, script or its cache, whatever the arguments say",
    () =>
      Effect.gen(function* () {
        const api = fakeCrawlApi();

        yield* call(api, crawlLog(), "crawl_start", {
          url: "https://docs.example.com/",
          cookies: [{ name: "session", value: "secret", domain: "docs.example.com" }],
          authenticate: { username: "user", password: "pass" },
          setExtraHTTPHeaders: { "x-api-key": "secret" },
          addScriptTag: [{ content: "alert(1)" }],
          maxAge: 604_800,
          userAgent: "Commissary",
        });

        expect(api.requests.map((request) => request.body)).toEqual([
          { url: "https://docs.example.com/" },
        ]);
      }),
  );

  it.effect(
    "start a crawl through Browser Run's REST API with the account's token, and log it as the caller's",
    () =>
      Effect.gen(function* () {
        const api = fakeCrawlApi();
        const log = crawlLog();

        const result = yield* call(api, log, "crawl_start", {
          url: "https://docs.example.com/",
          limit: 50,
          depth: 2,
          formats: ["markdown"],
          render: false,
          options: { includePatterns: ["https://docs.example.com/**"] },
          crawlPurposes: ["search"],
          waitUntil: "networkidle2",
          timeout: 20_000,
          waitForSelector: "main",
        });

        const [id] = api.jobs.keys();

        expect(id).toBeDefined();
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: `Started crawl ${id}. Read its status and pages with browser_crawl_result, and stop it with browser_crawl_cancel.`,
            },
          ],
          structuredContent: { crawlId: id },
        });
        expect([...log.ids]).toEqual([id]);
        expect(api.requests).toEqual([
          {
            method: "POST",
            path: CRAWL_PATH,
            body: {
              url: "https://docs.example.com/",
              limit: 50,
              depth: 2,
              formats: ["markdown"],
              render: false,
              options: { includePatterns: ["https://docs.example.com/**"] },
              crawlPurposes: ["search"],
              gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
              waitForSelector: { selector: "main" },
            },
          },
        ]);
      }),
  );

  it.effect(
    "refuse to start from a URL the outbound guard refuses, without asking Browser Run",
    () =>
      Effect.gen(function* () {
        const api = fakeCrawlApi();
        const log = crawlLog();

        for (const url of [
          "http://docs.example.com/",
          "https://10.0.0.1/",
          "https://[::1]/",
          "https://app.example.com/",
          "not a url",
        ])
          expect(yield* call(api, log, "crawl_start", { url })).toEqual({
            content: [
              {
                type: "text",
                text: "Invalid arguments: Commissary only reaches public HTTPS addresses",
              },
            ],
            isError: true,
          });

        expect(api.requests).toEqual([]);
        expect(log.ids.size).toBe(0);
      }),
  );

  it.effect("refuse the json format, which would run an AI model", () =>
    Effect.gen(function* () {
      const api = fakeCrawlApi();

      const result = yield* call(api, crawlLog(), "crawl_start", {
        url: "https://docs.example.com/",
        formats: ["json"],
      });

      expect(result["isError"]).toBe(true);
      expect(textOf(result)).toMatch(/^Invalid arguments: /);
      expect(api.requests).toEqual([]);
    }),
  );

  it.effect("read a crawl's status and pages, a page of them at a time", () =>
    Effect.gen(function* () {
      const api = fakeCrawlApi();
      const log = crawlLog();
      const id = yield* started(api, log);

      const first = yield* call(api, log, "crawl_result", { crawlId: id, limit: 1 });

      expect(JSON.parse(textOf(first) ?? "")).toEqual({
        id,
        status: "running",
        total: 2,
        finished: 2,
        skipped: 0,
        records: [
          {
            url: "https://docs.example.com/",
            status: "completed",
            markdown: "# https://docs.example.com/",
            metadata: {
              status: 200,
              title: "Page at https://docs.example.com/",
              url: "https://docs.example.com/",
            },
          },
        ],
        cursor: "1",
      });

      const next = yield* call(api, log, "crawl_result", {
        crawlId: id,
        cursor: "1",
        status: "completed",
      });

      // SAFETY: the result is a crawl job, as above.
      const page = JSON.parse(textOf(next) ?? "") as { records: Array<{ url: string }> };

      expect(page.records.map((record) => record.url)).toEqual(["https://docs.example.com/about"]);
      expect(api.requests.slice(1).map((request) => [request.method, request.path])).toEqual([
        ["GET", `${CRAWL_PATH}/${id}?limit=1`],
        ["GET", `${CRAWL_PATH}/${id}?limit=5&cursor=1&status=completed`],
      ]);
    }),
  );

  it.effect("cancel a crawl", () =>
    Effect.gen(function* () {
      const api = fakeCrawlApi();
      const log = crawlLog();
      const id = yield* started(api, log);

      expect(yield* call(api, log, "crawl_cancel", { crawlId: id })).toEqual({
        content: [{ type: "text", text: `Cancelled crawl ${id}.` }],
      });
      expect(api.requests.at(-1)).toEqual({
        method: "DELETE",
        path: `${CRAWL_PATH}/${id}`,
        body: undefined,
      });
      expect(api.jobs.get(id)?.status).toBe("cancelled_by_user");
    }),
  );

  it.effect(
    "reach only the crawls the caller started: any other is no such crawl, and Browser Run is not asked",
    () =>
      Effect.gen(function* () {
        const api = fakeCrawlApi();
        const id = yield* started(api, crawlLog());
        const other = crawlLog();

        for (const tool of ["crawl_result", "crawl_cancel"])
          expect(yield* call(api, other, tool, { crawlId: id })).toEqual({
            content: [{ type: "text", text: `There is no crawl ${id}.` }],
            isError: true,
          });

        expect(api.requests).toHaveLength(1);
        expect(api.jobs.get(id)?.status).toBe("running");
      }),
  );

  it.effect(
    "refuse a page of results larger than 1 MiB unread, telling the caller to ask for fewer",
    () =>
      Effect.gen(function* () {
        const api = fakeCrawlApi();
        const log = crawlLog();
        const id = yield* started(api, log, "https://huge.example.com/");

        expect(yield* call(api, log, "crawl_result", { crawlId: id, limit: 2 })).toEqual({
          content: [
            {
              type: "text",
              text: "the pages asked for come to more than 1 MiB: ask for fewer at a time with a smaller limit, going on from the same cursor",
            },
          ],
          isError: true,
        });

        // One page at a time is within the cut.
        const one = yield* call(api, log, "crawl_result", { crawlId: id, limit: 1 });

        expect(one["isError"]).toBeUndefined();
      }),
  );

  it.effect("abort a request Browser Run does not answer within a minute", () =>
    Effect.gen(function* () {
      const signals: Array<AbortSignal> = [];

      // A Browser Run that never answers, but drops the request once its signal aborts.
      const hanging = {
        fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;

            if (signal !== undefined && signal !== null) {
              signals.push(signal);
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            }
          }),
      };

      const log = crawlLog();

      const fiber = yield* call(hanging, log, "crawl_start", {
        url: "https://docs.example.com/",
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("1 minute");

      expect(yield* Fiber.join(fiber)).toEqual({
        content: [{ type: "text", text: "Browser Run did not answer within 1 minute" }],
        isError: true,
      });
      expect(signals.map((signal) => signal.aborted)).toEqual([true]);
      expect(log.ids.size).toBe(0);
    }),
  );

  it.effect("answer Browser Run's refusals in its own words", () =>
    Effect.gen(function* () {
      const api = fakeCrawlApi();

      expect(
        yield* call(api, crawlLog(), "crawl_start", { url: "https://no-ai.example.com/" }),
      ).toEqual({
        content: [
          {
            type: "text",
            text: "Crawl disallowed by Content-Signal directive (purpose or use level)",
          },
        ],
        isError: true,
      });

      expect(
        yield* call(api, crawlLog(), "crawl_start", { url: "https://docs.example.com/" }, "bad"),
      ).toEqual({ content: [{ type: "text", text: "Authentication error" }], isError: true });
    }),
  );
});

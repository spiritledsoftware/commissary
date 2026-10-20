// A fake of Browser Run's crawl REST API (#270), `https://api.cloudflare.com/client/v4/accounts/<id>/browser-run/crawl`,
// for the crawl tools' tests: it starts, reads and cancels crawl jobs as Browser Run does, from the token and account it
// was made with, and records each request. A crawl of a URL on `no-ai.example.com` is refused the way Browser Run refuses
// a site whose Content Signals disallow it; a started crawl has two completed pages, read a page at a time with a cursor.
// A crawl of `huge.example.com` has pages of 700 KB of Markdown each: one fits in a 1 MiB answer, two do not.

/** The account and token the fake answers; any other is refused. */
export const CRAWL_ACCOUNT = "acct-crawl";

export const CRAWL_TOKEN = "browser-run-test-token";

/** The most pages a crawl may take on the test deployment (`COMMISSARY_CRAWL_MAX_PAGES`, test/worker.ts). */
export const CRAWL_MAX_PAGES = 50;

/** Where the fake answers. */
export const CRAWL_ORIGIN = "https://api.cloudflare.com";

export interface RecordedCrawlRequest {
  readonly method: string;
  /** The path and query, e.g. `/client/v4/accounts/acct-crawl/browser-run/crawl/<id>?limit=10`. */
  readonly path: string;
  readonly body: unknown;
}

interface Job {
  status: string;
  readonly url: string;
}

export interface FakeCrawlApi {
  /** Answers one request, as `routeFakeServer` (fake-fetch.ts) hands it on. */
  readonly handle: (request: Request) => Promise<Response>;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly requests: Array<RecordedCrawlRequest>;
  /** The jobs started, by id. */
  readonly jobs: Map<string, Job>;
}

const refusal = (status: number, message: string) =>
  Response.json({ success: false, errors: [{ code: status, message }] }, { status });

export const fakeCrawlApi = (): FakeCrawlApi => {
  const requests: Array<RecordedCrawlRequest> = [];
  const jobs = new Map<string, Job>();
  const base = `/client/v4/accounts/${CRAWL_ACCOUNT}/browser-run/crawl`;

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : undefined;

    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body });

    if (request.headers.get("authorization") !== `Bearer ${CRAWL_TOKEN}`)
      return refusal(401, "Authentication error");

    if (url.origin !== CRAWL_ORIGIN || !url.pathname.startsWith(base))
      return refusal(404, "No route for that URI");

    const id = url.pathname.slice(base.length + 1);

    if (id === "") {
      if (request.method !== "POST") return refusal(405, "Method not allowed");
      // SAFETY: the crawl tools send a JSON object with the URL to start from.
      const start = String((body as { url: unknown }).url);

      if (start.includes("no-ai.example.com"))
        return refusal(400, "Crawl disallowed by Content-Signal directive (purpose or use level)");

      const job = crypto.randomUUID();

      jobs.set(job, { status: "running", url: start });

      return Response.json({ success: true, result: job });
    }

    const job = jobs.get(id);

    if (job === undefined) return refusal(404, "Crawl job not found");

    if (request.method === "DELETE") {
      job.status = "cancelled_by_user";

      return Response.json({ success: true, result: null });
    }

    const records = [job.url, `${job.url}about`].map((page) => ({
      url: page,
      status: "completed",
      markdown: job.url.includes("huge.example.com")
        ? `# ${page}\n${"x".repeat(700_000)}`
        : `# ${page}`,
      metadata: { status: 200, title: `Page at ${page}`, url: page },
    }));

    const from = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? `${records.length}`);
    const next = from + limit;

    return Response.json({
      success: true,
      result: {
        id,
        status: job.status,
        browserSecondsUsed: 4.2,
        total: records.length,
        finished: records.length,
        skipped: 0,
        records: records.slice(from, next),
        ...(next < records.length ? { cursor: String(next) } : {}),
      },
    });
  };

  return {
    handle,
    fetch: async (input, init) =>
      await handle(input instanceof Request ? input : new Request(input, init)),
    requests,
    jobs,
  };
};

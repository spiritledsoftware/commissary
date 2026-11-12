// End-to-end tests of the production Worker: `exports.default.fetch` (and the default export with a recording
// ExecutionContext) with the real ControlPlane picker, model registry, D1 usage sink and Access gate (dev bypass on
// localhost, see vitest.config.ts). Only the upstream provider is mocked, through the global `fetch`.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import worker from "../src/index.ts";
import { FULL_ACCESS, resetUsageDb, zstdRleBomb } from "@commissary/models/testing";

// Effect's FetchHttpClient resolves `globalThis.fetch` once: install one stable fetch that delegates to the current
// test's upstream.
type Upstream = (request: Request) => Response | Promise<Response>;

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

const upstreamCalls: string[] = [];

const realFetch = globalThis.fetch;

const YAML = `
api-keys:
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1
      models:
        - name: upstream-model
          alias: alias-model
      keys:
        - api-key: sk-e2e-1
`;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

const chunk = (content: string) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;

interface UsageRow {
  readonly provider: string;
  readonly model: string;
  readonly alias: string;
  readonly principal_id: string;
  readonly auth_id: string;
  readonly stream: number;
  readonly failed: number;
  readonly fail_status: number | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

const usageRows = async (): Promise<UsageRow[]> =>
  (await env.USAGE.prepare("SELECT * FROM usage_records ORDER BY requested_at").all<UsageRow>())
    .results;

/** Credential id prefix of the synthesised config key (`<provider>:<name>:<hash>`). */
const CONFIG_KEY_ID = "openai-compatibility:mock:";

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

/** Counters the ControlPlane keeps for the provider key (written by `report`). */
const reportedCounts = async () => {
  const entry = (await controlPlane().models().listCredentials(FULL_ACCESS)).find((summary) =>
    summary.id.startsWith(CONFIG_KEY_ID),
  );

  return { success: entry?.success ?? 0, failed: entry?.failed ?? 0 };
};

const chatRequest = (body: Record<string, unknown>, init: RequestInit = {}) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "alias-model",
      messages: [{ role: "user", content: "hi" }],
      ...body,
    }),
    ...init,
  });

/**
 * An upstream SSE stream that produces chunks on demand (bounded) until Commissary cancels it. Chunks are produced in
 * `pull` (inside the Worker's request context): workerd only notices a client disconnect when it writes the next
 * bytes to the client, so the upstream must keep producing.
 */
const openStream = (maxChunks = 5_000) => {
  const state = { cancelled: false, produced: 0 };
  const encoder = new TextEncoder();

  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.produced >= maxChunks) {
          controller.close();

          return;
        }

        controller.enqueue(
          encoder.encode(chunk(state.produced === 0 ? "partial" : `more-${state.produced}`)),
        );
        state.produced++;
      },
      cancel() {
        state.cancelled = true;
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  return { state, response };
};

/** Reads the downstream body until the first SSE payload arrives, then cancels it (client disconnect). */
const readFirstFrameAndCancel = async (response: Response): Promise<string> => {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (!text.includes("partial")) {
    const { value, done } = await reader.read();

    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  await reader.cancel();

  return text;
};

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamCalls.push(`${request.method} ${request.url}`);

    return await upstream(request);
  };

  const stored = await controlPlane().models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  upstreamCalls.length = 0;
  await resetUsageDb();
});

describe("production Worker end to end", () => {
  it("serves a chat completion through the ControlPlane picker, registry and D1 sink", async () => {
    let upstreamBody: Record<string, unknown> = {};
    let upstreamAuth = "";
    upstream = async (request) => {
      upstreamBody = (await request.json()) as Record<string, unknown>;
      upstreamAuth = request.headers.get("authorization") ?? "";

      return Response.json(COMPLETION);
    };

    const before = await reportedCounts();

    // A non-browser client: no Origin, no Sec-Fetch-* headers.
    const response = await exports.default.fetch(chatRequest({}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("hello");
    expect(upstreamCalls).toEqual(["POST https://upstream.test/v1/chat/completions"]);
    // The registry resolved the alias; the ControlPlane picked the config key and mapped it to the upstream model.
    expect(upstreamBody["model"]).toBe("upstream-model");
    expect(upstreamAuth).toBe("Bearer sk-e2e-1");

    await vi.waitFor(
      async () => {
        const rows = await usageRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          model: "upstream-model",
          alias: "alias-model",
          principal_id: "user:dev@localhost",
          stream: 0,
          failed: 0,
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
        });
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(await reportedCounts()).toEqual({ success: before.success + 1, failed: before.failed });
  });

  it.each([
    ["/chat/completions", { messages: [{ role: "user", content: "hi" }] }, "chat.completion"],
    ["/responses", { input: "hi" }, "response"],
  ])("serves the unprefixed alias %s like its /v1 route", async (path, body, object) => {
    upstream = () => Response.json(COMPLETION);

    const response = await exports.default.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "alias-model", ...body }),
      }),
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { object: string }).object).toBe(object);
    expect(upstreamCalls).toEqual(["POST https://upstream.test/v1/chat/completions"]);
  });

  // A client disconnect is not propagated through the `exports.default.fetch` loopback of the test pool (neither the
  // body cancel nor `request.signal` reaches the Worker), so this test calls the production default export directly
  // with a recording ExecutionContext and cancels the very stream the runtime would cancel.
  it("records usage and reports the attempt when the client cancels a streamed body (under waitUntil)", async () => {
    const stream = openStream();
    upstream = () => stream.response;
    const before = await reportedCounts();
    const pending: Array<Promise<unknown>> = [];

    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    const request = chatRequest({ stream: true }) as Request<unknown, IncomingRequestCfProperties>;
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    // The attempt holds the invocation open (`waitUntil`) from its start until its report is written.
    expect(pending).toHaveLength(1);
    let released = false;
    void pending[0]?.then(() => (released = true));
    expect(await readFirstFrameAndCancel(response)).toContain("partial");

    // Only wait for what the Worker handed to `waitUntil` (as the runtime does after a disconnect): the report and
    // the D1 write must be complete once those promises settle.
    let settled = 0;

    while (settled < pending.length) {
      const batch = pending.slice(settled);
      settled = pending.length;
      await Promise.allSettled(batch);
    }

    expect(released).toBe(true);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    // Client aborts are connection-lifecycle failures (499, no cooldown); the upstream stream is closed too.
    expect(rows[0]).toMatchObject({
      model: "upstream-model",
      stream: 1,
      failed: 1,
      fail_status: 499,
    });
    expect(await reportedCounts()).toEqual({ success: before.success, failed: before.failed + 1 });
    expect(stream.state.cancelled).toBe(true);

    const summary = (await controlPlane().models().listCredentials(FULL_ACCESS)).find((entry) =>
      entry.id.startsWith(CONFIG_KEY_ID),
    );

    expect(summary?.unavailable).toBe(false);
  });

  it("answers 413 for zstd bodies that decompress beyond the limit", async () => {
    upstream = () => Response.json(COMPLETION);

    const response = await exports.default.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "zstd" },
        body: zstdRleBomb(33 * 1024 * 1024),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.text()).toContain("exceeds");
    expect(upstreamCalls).toEqual([]);
  });
});

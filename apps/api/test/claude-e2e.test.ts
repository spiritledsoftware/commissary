// The Claude routes through the production API Worker, against a mocked Anthropic upstream: gzip request bodies
// (CLIProxyAPI 6e7a1b29), server-side fallbacks off by default (fa11a573; the opt-in is in claude-fallback-e2e) and
// the Anthropic-Ratelimit-Unified-* headers of a local cooldown 429 (cb70eacf).
import { gzipSync } from "node:zlib";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Upstream = (request: Request) => Response | Promise<Response>;

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

const upstreamCalls: Array<{ readonly headers: Headers; readonly body: string }> = [];

const realFetch = globalThis.fetch;

// A cloaked provider key (Claude Code shaping without OAuth); passthrough headers expose the cooldown's addon headers.
const YAML = `
requests:
  passthrough-headers: true
api-keys:
  claude:
    - base-url: https://claude.test
      keys:
        - api-key: sk-ant-api03-e2e
          cloak: { mode: always }
      models:
        - name: claude-opus-5-5
        - name: claude-sonnet-4-5
`;

const MESSAGE = {
  id: "msg_e2e",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

const body = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 64,
  messages: [{ role: "user", content: "Hello there" }],
  ...extra,
});

const messages = (payload: BodyInit, headers: Record<string, string> = {}) =>
  exports.default.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: payload,
    }),
  );

const lastUpstreamBody = (): Record<string, unknown> =>
  JSON.parse(upstreamCalls.at(-1)?.body ?? "{}") as Record<string, unknown>;

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamCalls.push({ headers: request.headers, body: await request.clone().text() });

    return await upstream(request);
  };

  const stored = await env.CONTROL_PLANE.getByName("global").models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  upstreamCalls.length = 0;
  upstream = () => Response.json(MESSAGE);
});

describe("Claude routes through the API Worker", () => {
  it("decodes a gzip request body and sends no Content-Encoding upstream", async () => {
    const response = await messages(gzipSync(JSON.stringify(body("claude-opus-5-5"))), {
      "content-encoding": "gzip",
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "hello",
    );
    expect(upstreamCalls).toHaveLength(1);
    expect(lastUpstreamBody()["model"]).toBe("claude-opus-5-5");
    expect(upstreamCalls[0]?.headers.get("content-encoding")).toBeNull();
  });

  it("answers 400 for a corrupt gzip body without calling upstream", async () => {
    const response = await messages(Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x01), {
      "content-encoding": "gzip",
    });

    expect(response.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers 413 for a gzip body that decodes past 32 MiB without calling upstream", async () => {
    // A few KiB on the wire, 33 MiB decoded: workerd's gunzipSync stops at maxOutputLength.
    const bomb = gzipSync(new Uint8Array(33 * 1024 * 1024));
    const response = await messages(bomb, { "content-encoding": "gzip" });

    // 413 only comes from the RangeError branch of body.ts; the message proves which one.
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("decoded request body exceeds");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("injects no server-side fallback unless upstream.claude.server-side-fallback opts in", async () => {
    expect((await messages(JSON.stringify(body("claude-opus-5-5")))).status).toBe(200);
    expect(lastUpstreamBody()["fallbacks"]).toBeUndefined();

    // A caller's own fallbacks stay as sent.
    const own = [{ model: "claude-sonnet-4-5" }];

    expect(
      (await messages(JSON.stringify(body("claude-opus-5-5", { fallbacks: own })))).status,
    ).toBe(200);
    expect(lastUpstreamBody()["fallbacks"]).toEqual(own);
  });

  it("answers a local cooldown with Anthropic-Ratelimit-Unified headers aligned with Retry-After", async () => {
    const rejected = {
      "retry-after": "7200",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    };

    upstream = () =>
      Response.json(
        { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
        { status: 429, headers: rejected },
      );

    expect((await messages(JSON.stringify(body("claude-sonnet-4-5")))).status).toBe(429);
    // Real time, not TestClock: the Worker computes the reset from its own clock, so the test bounds it by Date.now().
    const before = Math.floor(Date.now() / 1000);

    // The cooldown is reported after the answer: ask until the Worker answers locally.
    const local = await vi.waitFor(
      async () => {
        const response = await messages(JSON.stringify(body("claude-sonnet-4-5")));
        const text = await response.text();

        expect(text).toContain("cooling down");

        return { response, text };
      },
      { timeout: 5000, interval: 100 },
    );

    const after = Math.floor(Date.now() / 1000);
    const { response } = local;
    const retryAfter = Number(response.headers.get("retry-after"));

    expect(response.status).toBe(429);
    expect(retryAfter).toBeGreaterThan(7000);
    expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
    expect(response.headers.get("anthropic-ratelimit-unified-5h-status")).toBe("rejected");
    expect(response.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe(
      "five_hour",
    );
    expect(response.headers.get("anthropic-ratelimit-unified-overage-status")).toBe("rejected");
    const reset = Number(response.headers.get("anthropic-ratelimit-unified-reset"));

    expect(reset).toBeGreaterThanOrEqual(before + retryAfter - 1);
    expect(reset).toBeLessThanOrEqual(after + retryAfter);
    expect(response.headers.get("anthropic-ratelimit-unified-5h-reset")).toBe(String(reset));
    expect(JSON.parse(local.text)).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error" },
    });
  });
});

// Meta (Muse) executor against a mocked `/responses` upstream: request shaping, SSE aggregation, error rules and
// credential resolution.
import { claudeSignature } from "./support/signatures.ts";
import { Clock, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { metaCreds, requireMetaToken } from "../src/executor/meta/credentials.ts";
import {
  isMetaSubscriptionQuota,
  META_NOT_FOUND_COOLDOWN_MS,
  metaStreamEventError,
  parseMetaRetryAfterMs,
  wrapMetaUpstreamError,
} from "../src/executor/meta/errors.ts";
import { makeMetaExecutor } from "../src/executor/meta/executor.ts";
import { sanitizeMetaWebSearchTools } from "../src/executor/meta/request.ts";
import type { Json } from "@commissary/json";
import {
  collectStream,
  credential,
  execute,
  harness,
  json,
  options,
  runFail,
} from "./support/executor-run.ts";

/** Loosely typed JSON object of an event/item/tool in the assertions below. */
interface Item {
  [key: string]: unknown;
  parameters?: { required?: string[] };
}

const executor = makeMetaExecutor();

const metaKey = () =>
  credential("meta", {
    kind: "apikey",
    attributes: { api_key: "meta-key-1", base_url: "https://meta.test/v1" },
  });

const sse = (events: ReadonlyArray<unknown>): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const completed = (output: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "muse-spark",
    output,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    ...extra,
  },
});

const message = (text: string) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

const responsesRequest = (extra: Record<string, unknown> = {}) => ({
  model: "muse-spark",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  ...extra,
});

const responsesOptions = (stream = false) =>
  options({
    stream,
    sourceFormat: "openai-response",
    metadata: { ...options().metadata, requestPath: "/v1/responses" },
  });

describe("credentials", () => {
  it("never uses a DCA token as the bearer token", () => {
    expect(
      metaCreds(credential("meta", { metadata: { access_token: "dca:abc", dca_token: "dca:abc" } }))
        .token,
    ).toBe("");
    expect(
      metaCreds(credential("meta", { metadata: { api_key: "key", access_token: "dca:abc" } }))
        .token,
    ).toBe("key");
    expect(
      metaCreds(credential("meta", { attributes: { api_key: "dca:x", access_token: "tok" } }))
        .token,
    ).toBe("tok");
  });

  it("resolves the base URL from attributes, then metadata, then the default", () => {
    expect(
      metaCreds(credential("meta", { attributes: { base_url: "https://a.test/v1" } })).baseUrl,
    ).toBe("https://a.test/v1");
    expect(
      metaCreds(credential("meta", { metadata: { base_url: "https://m.test/v1" } })).baseUrl,
    ).toBe("https://m.test/v1");
    expect(metaCreds(credential("meta")).baseUrl).toBe("https://api.meta.ai/v1");
  });

  it("fails with the Go 401 messages when no key is usable", () => {
    expect(() => requireMetaToken(credential("meta"))).toThrow(
      /missing provider key or access token/,
    );
    expect(() => requireMetaToken(credential("meta", { kind: "apikey" }))).toThrow(
      /meta-api-key requires a valid provider key/,
    );
  });
});

describe("error rules", () => {
  const now = 1_000_000_000_000;
  const reset = Math.floor(now / 1000) + 90;

  it("turns a future resets_at into the retry delay (429 and 404)", () => {
    const body = JSON.stringify({ error: { resets_at: reset, message: "later" } });
    expect(wrapMetaUpstreamError(429, body, now).retryAfterMs).toBe(90_000);
    expect(wrapMetaUpstreamError(404, body, now).retryAfterMs).toBe(90_000);
    expect(parseMetaRetryAfterMs(500, { error: { resets_at: reset } }, now)).toBeUndefined();
    expect(
      wrapMetaUpstreamError(429, JSON.stringify({ error: { resets_at: reset - 1000 } }), now)
        .retryAfterMs,
    ).toBeUndefined();
  });

  it("cools a 404 without resets_at for five minutes", () => {
    expect(wrapMetaUpstreamError(404, '{"error":{"message":"gone"}}', now).retryAfterMs).toBe(
      META_NOT_FOUND_COOLDOWN_MS,
    );
    expect(wrapMetaUpstreamError(404, "", now).retryAfterMs).toBe(300_000);
  });

  it("scopes subscription-quota 429s to the credential", () => {
    for (const error of [
      { message: "Your subscription quota is exhausted" },
      { message: "Quota exhausted" },
      { code: "rate_limit_exceeded", resets_at: reset },
      { code: "monthly_quota", resets_at: reset },
    ]) {
      expect(wrapMetaUpstreamError(429, JSON.stringify({ error }), now).credentialScoped).toBe(
        true,
      );
    }

    expect(
      wrapMetaUpstreamError(429, '{"error":{"code":"rate_limit_exceeded"}}', now).credentialScoped,
    ).toBeUndefined();
    expect(isMetaSubscriptionQuota(500, { error: { message: "subscription quota" } })).toBe(false);
    expect(wrapMetaUpstreamError(500, "boom", now)).toMatchObject({ status: 500, message: "boom" });
  });

  it("maps in-stream error events to a status (error.code in 400..599, else 502)", () => {
    const failed = (code: Json) => json({ type: "response.failed", error: { code, message: "x" } });
    expect(metaStreamEventError(failed(429), "p", now)?.status).toBe(429);
    expect(metaStreamEventError(failed("rate_limit"), "p", now)?.status).toBe(502);
    expect(metaStreamEventError(failed(200), "p", now)?.status).toBe(502);
    expect(metaStreamEventError(json({ type: "response.created" }), "p", now)).toBeUndefined();
  });
});

describe("web_search sanitising", () => {
  it("drops search_content_types from web_search tools, also inside namespaces", () => {
    const body = json({
      tools: [
        { type: "web_search", search_content_types: ["text"], keep: 1 },
        { type: "web_search_preview", search_content_types: ["text"] },
        {
          type: "namespace",
          tools: [
            { type: "web_search", search_content_types: ["image"] },
            { type: "function", name: "f" },
          ],
        },
      ],
    });

    expect(sanitizeMetaWebSearchTools(body)).toEqual({
      tools: [
        { type: "web_search", keep: 1 },
        { type: "web_search_preview", search_content_types: ["text"] },
        { type: "namespace", tools: [{ type: "web_search" }, { type: "function", name: "f" }] },
      ],
    });
  });
});

describe("Meta executor", () => {
  it("posts a shaped streaming Responses request with the Muse headers", async () => {
    const h = await harness(metaKey(), () => sse([completed([message("hello")])]));

    const response = await execute(
      executor,
      h,
      {
        model: "muse-spark",
        payload: json(
          responsesRequest({
            stream: false,
            generate: true,
            safety_identifier: "s",
            prompt_cache_retention: "24h",
            client_metadata: { a: 1 },
            stream_options: { include_obfuscation: true },
            tools: [{ type: "web_search", search_content_types: ["text"] }],
            input: [
              { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
              {
                type: "reasoning",
                id: "rs_foreign",
                summary: [],
                encrypted_content: "opaque-muse-state",
              },
              {
                type: "reasoning",
                id: "rs_claude",
                summary: [],
                encrypted_content: claudeSignature(),
              },
            ],
          }),
        ),
      },
      responsesOptions(),
    );

    const call = h.calls[0];
    expect(call?.url).toBe("https://meta.test/v1/responses");
    expect(call?.headers["authorization"]).toBe("Bearer meta-key-1");
    expect(call?.headers["user-agent"]).toMatch(
      /^muse-build\/1\.4\.14 \(non-interactive; [a-z]+-[a-z0-9_]+; build dec7d7497fecdad135ec5835a8161dbc92e55b58\)$/,
    );
    expect(call?.headers["x-client-id"]).toBe("tbh:exec");
    const sessionId = call?.headers["x-tbh-session-id"] ?? "";
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    for (const name of [
      "x-meta-ai-gateway-session-id",
      "x-tbh-thread-id",
      "x-tbh-root-session-id",
    ]) {
      expect(call?.headers[name]).toBe(sessionId);
    }

    expect(call?.headers["x-tbh-agent-role"]).toBe("main");
    expect(call?.headers).not.toHaveProperty("x-tbh-contributor-mode");
    expect(call?.headers["accept"]).toBe("text/event-stream");
    expect(call?.headers["cache-control"]).toBe("no-cache");

    const body = JSON.parse(call?.text ?? "{}") as Record<string, unknown> & {
      input: Array<Record<string, unknown>>;
    };

    expect(body["stream"]).toBe(true);

    for (const field of [
      "generate",
      "safety_identifier",
      "prompt_cache_retention",
      "client_metadata",
      "stream_options",
    ]) {
      expect(body).not.toHaveProperty(field);
    }

    expect(body["instructions"]).toBe("");
    expect(body["tools"]).toMatchObject([
      { type: "web_search" },
      { type: "namespace", name: "muse" },
    ]);
    expect((body["tools"] as Item[])[0]).toEqual({ type: "web_search" });
    // Foreign reasoning blobs are replayed; recognisable other-provider signatures are dropped.
    const reasoning = body.input.filter((item) => item["type"] === "reasoning");
    expect(reasoning.some((item) => item["encrypted_content"] === "opaque-muse-state")).toBe(true);
    expect(
      reasoning.some((item) => item["id"] === "rs_claude" && "encrypted_content" in item),
    ).toBe(false);
    expect(JSON.parse(response.payload)).toMatchObject({ object: "response", status: "completed" });
    expect(h.usage.failed).toBe(false);
  });

  it("patches an empty completed output from output_item.done events", async () => {
    const item = message("assembled");

    const h = await harness(metaKey(), () =>
      sse([{ type: "response.output_item.done", output_index: 0, item }, completed([])]),
    );

    const response = await execute(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(),
    );

    expect((JSON.parse(response.payload) as { output: unknown[] }).output).toEqual([item]);
  });

  it("accepts a plain JSON response body instead of SSE", async () => {
    const body = {
      id: "resp_9",
      object: "response",
      status: "completed",
      output: [message("plain")],
      usage: {},
    };

    const h = await harness(metaKey(), () => new Response(JSON.stringify(body)));

    const response = await execute(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(),
    );

    expect((JSON.parse(response.payload) as { output: unknown[] }).output).toEqual([
      message("plain"),
    ]);
  });

  it("fails with 408 when the stream ends before a terminal event", async () => {
    const h = await harness(metaKey(), () =>
      sse([{ type: "response.created", response: { id: "r" } }]),
    );

    const error = await runFail(
      executor.execute(
        h.context,
        { model: "muse-spark", payload: json(responsesRequest()) },
        responsesOptions(),
      ),
      h.layers,
    );

    expect(error.status).toBe(408);
    expect(error.message).toContain(
      "stream disconnected before response.completed or response.incomplete",
    );
  });

  it("applies the 429/404 rules to upstream HTTP errors", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 120;

    const quota = await harness(
      metaKey(),
      () =>
        new Response(
          JSON.stringify({ error: { message: "subscription quota used", resets_at: resetsAt } }),
          {
            status: 429,
          },
        ),
    );

    const quotaError = await runFail(
      executor.execute(
        quota.context,
        { model: "muse-spark", payload: json(responsesRequest()) },
        responsesOptions(),
      ),
      quota.layers,
    );

    expect(quotaError).toMatchObject({ status: 429, credentialScoped: true });
    expect(quotaError.retryAfterMs).toBeGreaterThan(100_000);
    expect(quotaError.retryAfterMs).toBeLessThanOrEqual(120_000);

    const missing = await harness(
      metaKey(),
      () => new Response('{"error":{"message":"no model"}}', { status: 404 }),
    );

    const missingError = await runFail(
      executor.execute(
        missing.context,
        { model: "muse-spark", payload: json(responsesRequest()) },
        responsesOptions(),
      ),
      missing.layers,
    );

    expect(missingError).toMatchObject({ status: 404, retryAfterMs: META_NOT_FOUND_COOLDOWN_MS });
    expect(missing.usage.failed).toBe(true);
  });

  it("answers /responses/compact with 501 and fails without a key", async () => {
    const h = await harness(metaKey(), () => sse([completed()]));

    const compact = await runFail(
      executor.execute(
        h.context,
        { model: "muse-spark", payload: json(responsesRequest()) },
        { ...responsesOptions(), alt: "responses/compact" },
      ),
      h.layers,
    );

    expect(compact.status).toBe(501);
    const noKey = await harness(credential("meta"), () => sse([completed()]));

    const unauthorized = await runFail(
      executor.execute(
        noKey.context,
        { model: "muse-spark", payload: json(responsesRequest()) },
        responsesOptions(),
      ),
      noKey.layers,
    );

    expect(unauthorized.status).toBe(401);
    expect(noKey.calls).toHaveLength(0);
  });

  it("applies payload rules last (protocol = meta)", async () => {
    const yaml = `payload:\n  override:\n    - models: [{ name: "muse*", protocol: meta }]\n      params:\n        temperature: 0.1\n        stream: false\n`;
    const h = await harness(metaKey(), () => sse([completed([message("x")])]), yaml);
    await execute(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(),
    );
    const body = JSON.parse(h.calls[0]?.text ?? "{}") as Record<string, unknown>;
    expect(body["temperature"]).toBe(0.1);
    // The rule is the final mutation: it wins over the built-in `stream: true`.
    expect(body["stream"]).toBe(false);
  });

  it("streams Responses events, patching the terminal output and reporting usage", async () => {
    const item = message("streamed");

    const h = await harness(
      metaKey(),
      () =>
        sse([
          { type: "response.created", response: { id: "r" } },
          { type: "response.output_item.done", output_index: 0, item },
          completed([]),
        ]),
      undefined,
      true,
    );

    const collected = await collectStream(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(true),
    );

    expect(collected.error).toBeUndefined();
    const joined = collected.chunks.join("");
    expect(joined).toContain("response.created");

    const terminal = collected.chunks
      .filter((chunk) => chunk.startsWith("data:") && chunk.includes("response.completed"))
      .map((chunk) => JSON.parse(chunk.slice(5)) as { response: { output: unknown[] } })[0];

    expect(terminal?.response.output).toEqual([item]);
    expect(h.usage.failed).toBe(false);
  });

  it("fails a stream that carries an error event", async () => {
    const h = await harness(
      metaKey(),
      () =>
        sse([
          {
            type: "error",
            error: {
              code: 429,
              message: "slow down",
              resets_at: Math.floor(Date.now() / 1000) + 60,
            },
          },
        ]),
      undefined,
      true,
    );

    const collected = await collectStream(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(true),
    );

    expect(collected.error?.status).toBe(429);
    expect(collected.error?.retryAfterMs).toBeGreaterThan(0);
    expect(h.usage.failed).toBe(true);
  });

  it("counts tokens locally without calling the upstream", async () => {
    const h = await harness(metaKey(), () => sse([completed()]));

    const response = await Effect.runPromise(
      executor
        .countTokens(
          h.context,
          { model: "muse-spark", payload: json(responsesRequest()) },
          responsesOptions(),
        )
        .pipe(Effect.provide(h.layers)),
    );

    expect(JSON.parse(response.payload)).toEqual({
      response: { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
    });
    expect(h.calls).toHaveLength(0);
  });
});

const ping = { type: "response.subscription_usage", subscription: { tier: "1234567890123456" } };

describe("subscription usage telemetry", () => {
  const upstream = () =>
    new Response(
      [
        `event: response.subscription_usage\ndata: ${JSON.stringify(ping)}\n\n`,
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r" } })}\n\n`,
        `data: ${JSON.stringify({ subscription: { tier: "1234567890123456" } })}\n\n`,
        `event: response.subscription_usage\ndata: ${JSON.stringify(ping)}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify(completed([message("hello")]))}\n\n`,
        `event: response.subscription_usage\ndata: ${JSON.stringify(ping)}\n\n`,
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  it("drops subscription_usage frames (event and bare data) from streams", async () => {
    const h = await harness(metaKey(), upstream, undefined, true);

    const collected = await collectStream(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(true),
    );

    const joined = collected.chunks.join("");
    expect(collected.error).toBeUndefined();
    expect(joined).not.toContain("subscription");
    expect(joined).not.toContain("1234567890123456");
    expect(joined).toContain("response.created");
    expect(joined).toContain("hello");
  });

  it("drops the event line held for an error frame, as Go emits it only after the error check", async () => {
    const h = await harness(
      metaKey(),
      () =>
        new Response(
          `event: response.created\n${`data: ${JSON.stringify({ type: "response.created", response: { id: "r" } })}`}\n\n` +
            `event: error\ndata: ${JSON.stringify({ type: "error", error: { code: 502, message: "boom" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      undefined,
      true,
    );

    const collected = await collectStream(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(true),
    );

    expect(collected.error?.status).toBe(502);
    expect(collected.chunks.join("")).toContain("response.created");
    expect(collected.chunks.join("")).not.toContain("event: error");
  });

  it("drops them from the aggregated non-stream answer", async () => {
    const h = await harness(metaKey(), upstream);

    const response = await execute(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(),
    );

    expect(response.payload).not.toContain("subscription");
    expect(response.payload).toContain("hello");
  });
});

/** A mocked upstream whose frames arrive at virtual times; the executor reads the same virtual clock. */
interface Frame {
  readonly at: number;
  readonly text?: string;
  readonly fail?: boolean;
}

describe("TTFT (Go meta_executor_ttft_test.go, virtual clock)", () => {
  const created = { type: "response.created", response: { id: "r", model: "muse-spark-1.3" } };
  const frame = (event: Json) => `data: ${JSON.stringify(event)}\n\n`;
  const telemetry = { ...ping, model: "subscription-telemetry" };

  const metadata =
    `event: response.subscription_usage\n${frame(telemetry)}` +
    frame(created) +
    frame({
      type: "response.output_item.added",
      item: { type: "reasoning", encrypted_content: "opaque", summary: [] },
    }) +
    frame({ type: "response.output_text.delta", delta: "" });

  const text = frame({ type: "response.output_text.delta", output_index: 0, delta: "hello" });

  const terminal = completed([message("hello")], { model: "muse-spark-1.3" });
  const done = `data: ${JSON.stringify(terminal)}\n\n`;

  const emptyTerminal = (type: string) =>
    frame({
      type,
      response: { id: "r", status: "completed", output: [], usage: { input_tokens: 0 } },
    });

  const run = async (
    frames: ReadonlyArray<Frame>,
    options: { nonstream?: boolean; status?: number } = {},
  ) => {
    let now = 0;
    const base = Clock.Clock.defaultValue();

    const clock: Clock.Clock = Object.assign(Object.create(base) as Clock.Clock, {
      currentTimeMillis: Effect.sync(() => now),
      currentTimeMillisUnsafe: () => now,
    });

    const h = await harness(
      metaKey(),
      () => {
        // Headers arrive at 10ms; every frame is delivered at its own time, one pull at a time.
        now = 10;
        const queue = [...frames];

        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const next = queue.shift();

              if (next === undefined) return controller.close();
              now = next.at;

              if (next.fail === true) return controller.error(new Error("boom"));
              controller.enqueue(new TextEncoder().encode(next.text ?? ""));
            },
          },
          { highWaterMark: 0 },
        );

        return new Response(body, {
          status: options.status ?? 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
      undefined,
      options.nonstream !== true,
    );

    const program = Effect.gen(function* () {
      const request = { model: "muse-spark", payload: json(responsesRequest()) };

      if (options.nonstream === true) {
        yield* executor.execute(h.context, request, responsesOptions(false));
      } else {
        const result = yield* executor.executeStream(h.context, request, responsesOptions(true));
        yield* Stream.runDrain(result.chunks);
      }
    }).pipe(Effect.exit, Effect.provideService(Clock.Clock, clock), Effect.provide(h.layers));

    await Effect.runPromise(program);

    return h.usage.finish(now);
  };

  const content = (event: string): ReadonlyArray<Frame> => [
    { at: 100, text: metadata },
    { at: 1000, text: event },
    { at: 1100, text: done },
  ];

  it.each([
    ["text", text],
    [
      "reasoning summary",
      frame({ type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "thinking" }),
    ],
    [
      "function arguments",
      frame({ type: "response.function_call_arguments.delta", delta: '{"query":"hi"}' }),
    ],
    [
      "done-only reasoning summary",
      frame({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", summary: [{ type: "summary_text", text: "done-only" }] },
      }),
    ],
  ])("takes the first effective token frame (%s)", async (_name, event) => {
    expect((await run(content(event)))?.ttftMs).toBe(1000);
  });

  it.each([
    ["empty reasoning done", { type: "reasoning", summary: [{ type: "summary_text", text: "" }] }],
    ["encrypted-only reasoning done", { type: "reasoning", summary: [], encrypted_content: "x" }],
  ])("does not take %s as a token; the terminal event does", async (_name, item) => {
    const event = frame({ type: "response.output_item.done", output_index: 0, item });
    expect((await run(content(event)))?.ttftMs).toBe(1100);
  });

  it("takes a terminal event that arrives without any delta", async () => {
    const record = await run([
      { at: 100, text: metadata },
      { at: 1000, text: done },
    ]);

    expect(record?.ttftMs).toBe(1000);
  });

  it.each(["response.completed", "response.incomplete"])(
    "takes an empty %s as the first effective frame",
    async (type) => {
      const record = await run([
        { at: 100, text: metadata },
        { at: 1000, text: emptyTerminal(type) },
      ]);

      expect(record?.ttftMs).toBe(1000);
    },
  );

  it.each([
    [
      "response.failed",
      frame({ type: "response.failed", response: { error: { message: "upstream failed" } } }),
    ],
    ["error", frame({ type: "error", error: { code: 502, message: "upstream failed" } })],
  ])("takes a %s event as the first frame and fails the attempt", async (_name, event) => {
    const record = await run([
      { at: 100, text: metadata },
      { at: 1000, text: event },
    ]);

    expect(record?.ttftMs).toBe(1000);
    expect(record?.failed).toBe(true);
  });

  it("keeps the first-packet fallback when the body fails before any token", async () => {
    const record = await run([
      { at: 100, text: metadata },
      { at: 1000, fail: true },
    ]);

    // Go times the first body byte (100ms); the port records the response headers (10ms), as the Codex executor does.
    expect(record?.ttftMs).toBe(10);
    expect(record?.failed).toBe(true);
  });

  it("keeps the fallback for an HTTP error", async () => {
    const record = await run([{ at: 100, text: '{"error":{"message":"rate limited"}}' }], {
      status: 429,
    });

    expect(record?.ttftMs).toBe(10);
    expect(record?.failed).toBe(true);
  });

  it("keeps first-byte timing for non-stream calls", async () => {
    const record = await run(content(text), { nonstream: true });
    expect(record?.ttftMs).toBe(10);
  });

  it("does not take the response model from subscription telemetry", async () => {
    const record = await run(content(text));
    // Only the Responses events set it (created and completed), never the telemetry's `model`.
    expect(record?.responseModel).toBe("muse-spark-1.3");
  });
});

describe("contributor header and muse namespace", () => {
  const send = async (model: string, extra: Record<string, unknown> = {}, yaml?: string) => {
    const h = await harness(metaKey(), () => sse([completed([message("x")])]), yaml);

    await execute(
      executor,
      h,
      { model, payload: json(responsesRequest({ model, ...extra })) },
      responsesOptions(),
    );

    return h.calls[0];
  };

  it("sends X-Tbh-Contributor-Mode only for -contributor models", async () => {
    expect((await send("muse-spark"))?.headers["x-tbh-contributor-mode"]).toBeUndefined();
    expect((await send("muse-spark-contributor"))?.headers["x-tbh-contributor-mode"]).toBe("1");
    expect((await send("Muse-Spark-Contributor(high)"))?.headers["x-tbh-contributor-mode"]).toBe(
      "1",
    );
  });

  it("decides on the effective model after payload rules", async () => {
    const yaml = `payload:\n  override:\n    - models: [{ name: "muse*", protocol: meta }]\n      params:\n        model: muse-spark-contributor\n`;
    expect((await send("muse-spark", {}, yaml))?.headers["x-tbh-contributor-mode"]).toBe("1");
  });

  it("appends the canonical muse namespace to tool-bearing requests only", async () => {
    const fn = { type: "function", name: "lookup", parameters: { type: "object" } };
    const call = await send("muse-spark", { tools: [fn] });
    const tools = (JSON.parse(call?.text ?? "{}") as { tools: Item[] }).tools;
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ type: "function", name: "lookup" });

    expect(tools[1]).toMatchObject({
      type: "namespace",
      name: "muse",
      description: "Muse Code tool set.",
      tools: [{ type: "function", name: "submit_reminder_decision", strict: true }],
    });

    const none = JSON.parse((await send("muse-spark"))?.text ?? "{}") as Record<string, unknown>;
    expect(none).not.toHaveProperty("tools");

    const empty = JSON.parse((await send("muse-spark", { tools: [] }))?.text ?? "{}") as {
      tools?: unknown[];
    };

    expect(empty.tools ?? []).toEqual([]);
  });

  it("keeps a caller's muse namespace and lets payload rules stay final", async () => {
    const own = { type: "namespace", name: "muse", tools: [] };

    const kept = JSON.parse((await send("muse-spark", { tools: [own] }))?.text ?? "{}") as {
      tools: Item[];
    };

    expect(kept.tools).toEqual([own]);

    const yaml = `payload:\n  override:\n    - models: [{ name: "muse*", protocol: meta }]\n      params:\n        tools: []\n`;
    const fn = { type: "function", name: "lookup", parameters: { type: "object" } };

    const ruled = JSON.parse((await send("muse-spark", { tools: [fn] }, yaml))?.text ?? "{}") as {
      tools: Item[];
    };

    expect(ruled.tools).toEqual([]);
  });
});

describe("apply_patch bridge", () => {
  const PATCH = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
  const ARGS = JSON.stringify({ input: PATCH });

  const call = (args: string) => ({
    id: "fc_1",
    type: "function_call",
    call_id: "call_1",
    name: "apply_patch",
    arguments: args,
    status: "completed",
  });

  const patchRequest = () =>
    responsesRequest({
      tools: [{ type: "custom", name: "apply_patch", description: "Patch files" }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "custom_tool_call", call_id: "c0", name: "apply_patch", input: PATCH },
        { type: "custom_tool_call_output", call_id: "c0", output: "ok" },
      ],
    });

  it("sends the strict function and restores custom_tool_call output (non-stream)", async () => {
    const item = call(ARGS);

    const h = await harness(metaKey(), () =>
      sse([{ type: "response.output_item.done", output_index: 0, item }, completed([item])]),
    );

    const response = await execute(
      executor,
      h,
      { model: "muse-spark", payload: json(patchRequest()) },
      responsesOptions(),
    );

    const upstream = JSON.parse(h.calls[0]?.text ?? "{}") as {
      tools: Array<Item>;
      input: Array<Item>;
    };

    expect(upstream.tools[0]).toMatchObject({ type: "function", name: "apply_patch" });
    expect(upstream.tools[0]?.parameters?.required).toEqual(["input"]);
    expect(upstream.input[1]).toMatchObject({ type: "function_call", arguments: ARGS });
    expect(upstream.input[2]).toMatchObject({ type: "function_call_output" });
    const body = JSON.parse(response.payload) as { output: Array<Item> };
    expect(body.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      input: PATCH,
    });
  });

  it("restores a plain JSON response through the non-stream bridge", async () => {
    const item = call(ARGS);

    const h = await harness(
      metaKey(),
      () =>
        new Response(
          JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [item] }),
          {
            status: 200,
          },
        ),
    );

    const response = await execute(
      executor,
      h,
      { model: "muse-spark", payload: json(patchRequest()) },
      responsesOptions(),
    );

    expect((JSON.parse(response.payload) as { output: Array<Item> }).output[0]).toMatchObject({
      type: "custom_tool_call",
      input: PATCH,
    });
  });

  it("streams custom tool input events and fails on malformed arguments without leaking them", async () => {
    const good = call(ARGS);

    const h = await harness(
      metaKey(),
      () =>
        sse([
          { type: "response.output_item.added", output_index: 0, item: { ...good, arguments: "" } },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            output_index: 0,
            delta: ARGS,
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "fc_1",
            output_index: 0,
            arguments: ARGS,
          },
          { type: "response.output_item.done", output_index: 0, item: good },
          completed([good]),
        ]),
      undefined,
      true,
    );

    const collected = await collectStream(
      executor,
      h,
      { model: "muse-spark", payload: json(patchRequest()) },
      responsesOptions(true),
    );

    const text = collected.chunks.join("");
    expect(collected.error).toBeUndefined();
    expect(text).toContain("response.custom_tool_call_input.delta");
    expect(text).not.toContain("response.function_call_arguments.delta");

    const bad = call('{"nope":"secret text"}');

    const failing = await harness(
      metaKey(),
      () =>
        sse([{ type: "response.output_item.done", output_index: 0, item: bad }, completed([bad])]),
      undefined,
      true,
    );

    const failed = await collectStream(
      executor,
      failing,
      { model: "muse-spark", payload: json(patchRequest()) },
      responsesOptions(true),
    );

    expect(failed.error?.status).toBe(502);
    expect(failed.chunks.join("")).not.toContain("secret text");
    expect(failed.chunks.join("")).toContain("invalid_tool_arguments");
  });

  it("fails a non-stream call whose arguments are malformed with a sanitised 502", async () => {
    const bad = call('{"nope":"secret text"}');

    const h = await harness(metaKey(), () =>
      sse([{ type: "response.output_item.done", output_index: 0, item: bad }, completed([bad])]),
    );

    const error = await runFail(
      executor.execute(
        h.context,
        { model: "muse-spark", payload: json(patchRequest()) },
        responsesOptions(),
      ),
      h.layers,
    );

    expect(error.status).toBe(502);
    expect(error.message).not.toContain("secret text");
  });
});

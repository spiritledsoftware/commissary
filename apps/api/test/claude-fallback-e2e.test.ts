// Anthropic server-side fallback through the production API Worker (CLIProxyAPI fa11a573): with
// upstream.claude.server-side-fallback on, a cloaked Opus 5.5 request gets the refusal fallback, and an OpenAI client
// sees the model that served the answer and the fallback hop.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

type Upstream = (request: Request) => Response | Promise<Response>;

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

const upstreamBodies: Array<Record<string, unknown>> = [];

const realFetch = globalThis.fetch;

const YAML = `
upstream:
  claude:
    server-side-fallback: true
api-keys:
  claude:
    - base-url: https://claude.test
      keys:
        - api-key: sk-ant-api03-e2e
          cloak: { mode: always }
      models:
        - name: claude-opus-5-5
`;

const sse = (events: ReadonlyArray<Record<string, unknown>>): Response =>
  new Response(
    events
      .map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const FALLBACK_STREAM = [
  {
    type: "message_start",
    message: {
      id: "msg_fb",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial " } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "fallback",
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { type: "refusal", category: "cyber" },
    },
  },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "answer" } },
  { type: "content_block_stop", index: 2 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: {
      output_tokens: 3,
      iterations: [
        { type: "message", model: "claude-opus-5-5", output_tokens: 1 },
        { type: "fallback_message", model: "claude-opus-4-8", output_tokens: 2 },
      ],
    },
  },
  { type: "message_stop" },
];

const post = (path: string, payload: Record<string, unknown>) =>
  exports.default.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamBodies.push((await request.clone().json()) as Record<string, unknown>);

    return await upstream(request);
  };

  const stored = await env.CONTROL_PLANE.getByName("global").models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  upstreamBodies.length = 0;
  upstream = () => sse(FALLBACK_STREAM);
});

describe("server-side fallback opted in", () => {
  it("adds the Opus 4.8 refusal fallback to a cloaked Opus 5.5 request, keeping a caller's own", async () => {
    const request = { model: "claude-opus-5-5", max_tokens: 64, stream: true };
    const user = [{ role: "user", content: "Hello there" }];

    expect((await post("/v1/messages", { ...request, messages: user })).status).toBe(200);
    expect(upstreamBodies.at(-1)?.["fallbacks"]).toEqual([{ model: "claude-opus-4-8" }]);

    const own = [{ model: "claude-sonnet-4-5" }];
    await post("/v1/messages", { ...request, messages: user, fallbacks: own });
    expect(upstreamBodies.at(-1)?.["fallbacks"]).toEqual(own);
  });

  it("reports the serving model and the fallback hop to an OpenAI Chat Completions client", async () => {
    const response = await post("/v1/chat/completions", {
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "Hello there" }],
    });

    expect(response.status).toBe(200);

    const completion = (await response.json()) as {
      model: string;
      choices: Array<{ message: { content: string; fallback?: Record<string, unknown> } }>;
    };

    expect(completion.model).toBe("claude-opus-4-8");
    expect(completion.choices[0]?.message.content).toBe("partial answer");
    expect(completion.choices[0]?.message.fallback).toEqual({
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { type: "refusal", category: "cyber" },
      content_offset: 8,
    });
  });
});

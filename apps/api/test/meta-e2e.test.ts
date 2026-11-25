// Meta (Muse) Responses streams end to end: the production Worker (`exports.default.fetch`) with the real ControlPlane;
// only the Muse upstream is mocked, through the global `fetch`. A message only the terminal event carries (a refusal)
// reaches the client (Go ca459712), a clean EOF before the terminal event fails the stream (Go 32625f13), and an
// explicit client `prompt_cache_retention` passes through (Go f77a3c10).
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { withModelsPart } from "@commissary/models/testing";

type Upstream = (request: Request) => Response | Promise<Response>;

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

const upstreamBodies: Array<Record<string, unknown>> = [];

const realFetch = globalThis.fetch;

const MODEL = "muse-spark-1.2";

const YAML = `
api-keys:
  meta:
    - base-url: https://meta.e2e/v1
      keys:
        - api-key: meta-e2e-key
      models:
        - name: ${MODEL}
`;

const REFUSAL = "I'm sorry, but I can't help with that request.";

const sse = (events: ReadonlyArray<unknown>): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const created = { type: "response.created", response: { id: "resp_1", model: MODEL } };

const completed = {
  type: "response.completed",
  response: {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: MODEL,
    output: [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: REFUSAL }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  },
};

const post = (path: string, body: Record<string, unknown>) =>
  exports.default.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const chat = (extra: Record<string, unknown> = {}) =>
  post("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

/** The `data:` payloads of an SSE body, `[DONE]` left out. */
const dataLines = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data !== "[DONE]");

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    if (!request.url.startsWith("https://meta.e2e/")) return await realFetch(request);
    // SAFETY: the Meta executor always posts a JSON object.
    upstreamBodies.push((await request.clone().json()) as Record<string, unknown>);

    return await upstream(request);
  };

  const stored = await withModelsPart(env.CONTROL_PLANE.getByName("global"), (part) =>
    part.importConfig(YAML, "test"),
  );

  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  upstreamBodies.length = 0;
});

describe("Meta streams through the client API", () => {
  it("streams a refusal only the terminal event carries to a chat client", async () => {
    upstream = () => sse([created, completed]);

    const response = await chat();
    expect(response.status).toBe(200);

    const content = dataLines(await response.text())
      .map(
        (data) =>
          // SAFETY: chat completion chunks (OpenAI Chat Completions stream contract).
          JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> },
      )
      .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
      .join("");

    expect(content).toBe(REFUSAL);
  });

  it("synthesises the item events of the refusal for a Responses client", async () => {
    upstream = () => sse([created, completed]);

    const response = await post("/v1/responses", {
      model: MODEL,
      stream: true,
      input: "hi",
    });

    expect(response.status).toBe(200);

    const events = dataLines(await response.text()).map(
      // SAFETY: Responses stream events carry a string `type`.
      (data) => JSON.parse(data) as { type: string; delta?: string },
    );

    expect(events.map((event) => event.type)).toContain("response.refusal.delta");
    expect(events.find((event) => event.type === "response.refusal.delta")?.delta).toBe(REFUSAL);
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("fails a stream that ends cleanly before its terminal event", async () => {
    upstream = () =>
      sse([
        created,
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "hel",
        },
      ]);

    const response = await chat();
    const text = await response.text();
    expect(text).toContain("hel");
    expect(text).toContain("upstream stream closed before terminal event");
    expect(text).not.toContain('"finish_reason":"stop"');
  });

  it("passes the client's explicit prompt_cache_retention through, and injects none", async () => {
    upstream = () => sse([created, completed]);

    await (await chat({ prompt_cache_retention: "24h" })).text();
    await (await chat()).text();

    expect(upstreamBodies.map((body) => body["prompt_cache_retention"])).toEqual([
      "24h",
      undefined,
    ]);
  });
});

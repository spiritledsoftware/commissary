// xAI non-stream Responses answers end to end: the production Worker (`exports.default.fetch`) with the real
// ControlPlane; only the xAI upstream is mocked, through the global `fetch`. Terminal `error`/`response.failed` events
// fail with a status mapped from their type and code (policy blocks are 400s), and an empty or unclosed 2xx stream is a
// 502 (Go 949b43b3, 1f76e479).
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { withModelsPart } from "@commissary/models/testing";

let upstream: () => Response = () => new Response("no upstream", { status: 599 });

const realFetch = globalThis.fetch;

const MODEL = "grok-4.3";

/** Served by a key of its own, so the 429 test is not answered by the 502 test's cooldown (or the reverse). */
const RATE_LIMITED_MODEL = "grok-4.3-limited";

const YAML = `
api-keys:
  xai:
    - base-url: https://xai.e2e/v1
      keys:
        - api-key: xai-e2e-key
      models:
        - name: ${MODEL}
    - base-url: https://xai.e2e/v1
      keys:
        - api-key: xai-e2e-key-2
      models:
        - name: ${RATE_LIMITED_MODEL}
`;

const frame = (type: string, event: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...event })}\n\n`;

const sse = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

const created = frame("response.created", {
  response: { id: "resp_1", object: "response", model: MODEL, status: "in_progress" },
});

const respond = async (body: string, model = MODEL) => {
  upstream = () => sse(body);

  const response = await exports.default.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "hi" }),
    }),
  );

  return { status: response.status, text: await response.text() };
};

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    return request.url.startsWith("https://xai.e2e/") ? upstream() : await realFetch(request);
  };

  const stored = await withModelsPart(env.CONTROL_PLANE.getByName("global"), (part) =>
    part.importConfig(YAML, "test"),
  );

  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// Request-scoped failures first: the 502 below cools its key down.
describe("xAI non-stream terminal failures through the client API", () => {
  it("answers 400 for a policy block named only by its code", async () => {
    const { status, text } = await respond(
      created + frame("error", { error: { code: "bio_policy" } }),
    );

    expect(status).toBe(400);
    expect(text).toContain("bio_policy");
  });

  it("answers 502 for an empty stream", async () => {
    const { status, text } = await respond("");

    expect(status).toBe(502);
    expect(text).toContain("xai stream error: empty upstream stream");
  });

  it("answers 502 for a stream that closes before its terminal event", async () => {
    const { status, text } = await respond(created);

    expect(status).toBe(502);
    expect(text).toContain(
      "xai stream error: stream closed before response.completed or response.incomplete",
    );
  });

  it("answers the mapped status of a response.failed event", async () => {
    const { status, text } = await respond(
      created +
        frame("response.failed", {
          response: { error: { code: "rate_limit_exceeded", message: "slow down" } },
        }),
      RATE_LIMITED_MODEL,
    );

    expect(status).toBe(429);
    expect(text).toContain("slow down");
  });

  it("answers 502 for an error event it cannot classify", async () => {
    const { status, text } = await respond(
      created + frame("error", { error: { code: "server_error", message: "boom" } }),
    );

    expect(status).toBe(502);
    expect(text).toContain("boom");
  });
});

// A terminal 429 carries the pool's cooldown reset (CLIProxyAPI 4da9f685), end to end through the production Worker
// (`exports.default.fetch`) and the real ControlPlane; only the upstream is mocked, through the global `fetch`. Both
// keys of the model answer 429, the first with the shorter window: the client is told when the first recovers, not
// what the last attempt said, and a Claude client reads the reset in the message.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { withModelsPart } from "@commissary/models/testing";

const SHORT_KEY = "sk-pool-short-0001";

const LONG_KEY = "sk-pool-long-0002";

const SHORT_SECONDS = 95 * 60;

const LONG_SECONDS = 3 * 3600;

const YAML = `
api-keys:
  openai-compatibility:
    - name: Pool
      base-url: https://pool.upstream.test/v1
      models:
        - name: upstream-model
          alias: pool-model
      keys:
        - api-key: ${SHORT_KEY}
        - api-key: ${LONG_KEY}
`;

const realFetch = globalThis.fetch;

const calls: string[] = [];

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

/** The request bodies these tests send: a Claude Messages or an OpenAI chat request. */
interface ChatBody {
  readonly model: string;
  readonly max_tokens?: number;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}

const post = (path: string, body: ChatBody) =>
  exports.default.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    calls.push(key);
    const short = key === SHORT_KEY;

    return Response.json(
      {
        error: {
          type: "rate_limit_error",
          message: short ? "First account rate limited." : "Monthly spend limit reached.",
        },
      },
      {
        status: 429,
        headers: { "retry-after": String(short ? SHORT_SECONDS : LONG_SECONDS) },
      },
    );
  };

  const stored = await withModelsPart(controlPlane(), (part) => part.importConfig(YAML, "test"));
  expect(stored.ok).toBe(true);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await withModelsPart(controlPlane(), (part) => part.importConfig("", "test"));
});

describe("the terminal 429 of a cooling pool", () => {
  it("tells a Claude client when the pool recovers, in Retry-After and the message", async () => {
    const response = await post("/v1/messages", {
      model: "pool-model",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(429);
    expect([...new Set(calls)].toSorted()).toEqual([LONG_KEY, SHORT_KEY].toSorted());

    const retryAfter = Number(response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(SHORT_SECONDS - 60);
    expect(retryAfter).toBeLessThanOrEqual(SHORT_SECONDS);

    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toMatch(/\(reset after 1h3[45]m\d+s\)$/);
  });

  it("answers later requests with the same reset while every key cools", async () => {
    calls.length = 0;

    const response = await post("/v1/chat/completions", {
      model: "pool-model",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(429);
    expect(calls).toEqual([]);

    const retryAfter = Number(response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(SHORT_SECONDS - 60);
    expect(retryAfter).toBeLessThanOrEqual(SHORT_SECONDS);
    await response.text();
  });
});

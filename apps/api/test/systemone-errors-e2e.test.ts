// System One (ADR 0032) upstream errors end to end on TypeSafe: the production Worker (`exports.default.fetch`) with the
// real ControlPlane picker and `markResult`; only TypeSafe is mocked, through the global `fetch`. Each case has a key
// group of its own (`force-model-prefix`), so one case's cooldowns cannot reach another.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type Upstream = (request: Request) => Response | Promise<Response>;

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

const upstreamKeys: string[] = [];

const realFetch = globalThis.fetch;

const YAML = `
routing:
  force-model-prefix: true
api-keys:
  typesafe:
    - prefix: limited
      keys:
        - api-key: ts-limited
    - prefix: overloaded
      keys:
        - api-key: ts-overloaded
    - prefix: rejected
      keys:
        - api-key: ts-rejected
        - api-key: ts-accepted
    - prefix: aliased
      models:
        - name: jev-1.13.0
          alias: my-jev
      keys:
        - api-key: ts-aliased
`;

const ANSWER = {
  model: "jev-1.13.0",
  answers: { q: { type: "noul", noul: 0.4 } },
  usage: { input_tokens: 10, output_tokens: 2 },
};

const detail = (error_type: string, message: string) =>
  JSON.stringify({ detail: { error_type, message } });

const systemOne = (model: string) =>
  exports.default.fetch(
    new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        state: "hello",
        questions: { q: { type: "noul", instructions: "Is this a greeting?" } },
      }),
    }),
  );

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamKeys.push((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

    return await upstream(request);
  };

  const stored = await env.CONTROL_PLANE.getByName("global").models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  upstreamKeys.length = 0;
});

describe("TypeSafe errors through /v1/systemone", () => {
  it("passes a 429 through with its Retry-After, TypeSafe-shaped", async () => {
    upstream = () =>
      new Response(detail("rate_limit_error", "Too many requests"), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "3" },
      });

    const response = await systemOne("limited/jev-latest");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toEqual({
      detail: { error_type: "rate_limit_error", message: "Too many requests" },
    });
    expect(upstreamKeys).toEqual(["ts-limited"]);
  });

  it("keeps TypeSafe's 529 Overloaded, TypeSafe-shaped", async () => {
    upstream = () =>
      new Response(detail("overloaded_error", "Overloaded"), {
        status: 529,
        headers: { "content-type": "application/json" },
      });

    const response = await systemOne("overloaded/jev-latest");

    expect(response.status).toBe(529);
    expect(await response.json()).toEqual({
      detail: { error_type: "overloaded_error", message: "Overloaded" },
    });
  });

  it("cools a rejected key and fails over to the next one", async () => {
    upstream = (request) =>
      request.headers.get("authorization") === "Bearer ts-rejected"
        ? new Response(
            detail(
              "authentication_error",
              "Cannot authenticate with the server. Please check your API key and try again.",
            ),
            { status: 401, headers: { "content-type": "application/json" } },
          )
        : Response.json(ANSWER);

    for (let round = 0; round < 3; round += 1) {
      const response = await systemOne("rejected/jev-latest");
      expect(response.status).toBe(200);
      expect(((await response.json()) as typeof ANSWER).answers.q.noul).toBe(0.4);
    }

    // The rejected key was tried once (its 401 failed over to the other key) and then cooled.
    expect(upstreamKeys.filter((key) => key === "ts-rejected")).toHaveLength(1);
    expect(upstreamKeys.filter((key) => key === "ts-accepted")).toHaveLength(3);
  });

  it("guards prefixed, aliased and suffixed System One names on other endpoints, and serves them here", async () => {
    upstream = () => Response.json(ANSWER);

    for (const model of ["limited/jev-latest", "aliased/my-jev", "aliased/my-jev(high)"]) {
      const chat = await exports.default.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        }),
      );

      expect(chat.status).toBe(400);
      expect(((await chat.json()) as { error: { message: string } }).error.message).toMatch(
        /is a System One model: it is only supported on \/v1\/systemone$/,
      );
    }

    expect(upstreamKeys).toEqual([]);
    const served = await systemOne("aliased/my-jev");
    expect(served.status).toBe(200);
    await served.text();
    expect(upstreamKeys).toEqual(["ts-aliased"]);
  });
});

// The Muse Code CLI relay end to end (Go 7fd90c7a, internal/client/musecode/relay.go): the production Worker
// (`exports.default.fetch`) with the real ControlPlane; only the Meta upstream is mocked, through the global `fetch`.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { withModelsPart } from "@commissary/models/testing";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

let upstream: (call: Call) => Response = () => new Response("no upstream", { status: 599 });

const calls: Call[] = [];

const realFetch = globalThis.fetch;

const YAML = `
api-keys:
  meta:
    - base-url: https://meta.e2e/v1
      keys:
        - api-key: meta-key-a
        - api-key: meta-key-b
      models:
        - name: muse-spark-1.2
`;

const relay = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    if (!request.url.startsWith("https://meta.e2e/")) return await realFetch(request);

    const call = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    };

    calls.push(call);

    return upstream(call);
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
  calls.length = 0;
});

describe("Muse Code relay through the client API", () => {
  it("relays GET /muse-code/config to the credential's origin with the Muse identity", async () => {
    upstream = () =>
      Response.json(
        { features: { search: true } },
        { headers: { etag: '"v1"', "x-internal": "secret", "set-cookie": "a=b" } },
      );

    const response = await relay("/muse-code/config?key=leak&auth_token=leak&channel=beta", {
      headers: {
        "x-tbh-session-id": "client-session",
        "if-none-match": '"v0"',
        "x-unlisted": "dropped",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ features: { search: true } });
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(response.headers.get("x-internal")).toBeNull();

    const [call] = calls;
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe("https://meta.e2e/muse-code/config?channel=beta");
    expect(call?.headers.get("authorization")).toMatch(/^Bearer meta-key-[ab]$/);
    expect(call?.headers.get("x-client-id")).toBe("tbh:exec");
    expect(call?.headers.get("user-agent")).toMatch(/^muse-build\//);
    // The client's own Muse session is kept; nothing outside the allowlist is forwarded.
    expect(call?.headers.get("x-tbh-session-id")).toBe("client-session");
    expect(call?.headers.get("if-none-match")).toBe('"v0"');
    expect(call?.headers.get("x-unlisted")).toBeNull();
  });

  it("relays the POST body of /muse-code/search and the upstream status", async () => {
    upstream = () => Response.json({ error: "bad query" }, { status: 400 });

    const response = await relay("/muse-code/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "effect v4" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad query" });
    expect(calls[0]?.url).toBe("https://meta.e2e/muse-code/search");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ query: "effect v4" });
    // A fresh Muse session when the client sent none.
    expect(calls[0]?.headers.get("x-tbh-session-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers 404 for other paths and methods without calling the upstream", async () => {
    for (const [path, method] of [
      ["/muse-code/models/extra", "GET"],
      ["/muse-code/search", "GET"],
    ] as const) {
      const response = await relay(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      await response.arrayBuffer();
    }

    expect(calls).toEqual([]);
  });

  it("cools a credential down without a model after a 429, so later calls use the other key", async () => {
    upstream = () =>
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "600" },
      });

    const limited = await relay("/muse-code/browser_open", { method: "POST", body: "{}" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    await limited.arrayBuffer();
    const cooled = calls[0]?.headers.get("authorization");

    upstream = () => Response.json({ ok: true });

    for (let i = 0; i < 2; i++) {
      const response = await relay("/muse-code/browser_open", { method: "POST", body: "{}" });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }

    expect(calls.slice(1).map((call) => call.headers.get("authorization"))).not.toContain(cooled);
  });
});

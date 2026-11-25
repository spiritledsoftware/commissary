// The Muse Code CLI relay end to end (Go 7fd90c7a, internal/client/musecode/relay.go): the production Worker
// (`exports.default.fetch`) with the real ControlPlane; only the Meta upstream is mocked, through the global `fetch`.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
  readonly bytes: ReadonlyArray<number>;
}

let upstream: (call: Call) => Response = () => new Response("no upstream", { status: 599 });

/** The default Meta mint endpoint (`META_MINT_URL` is blank in the tests). */
const MINT_URL = "https://api.meta.ai/muse-code/key";

let mints = 0;

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
        - name: muse-spark-1.3
`;

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

const metaCredentials = async () =>
  (await controlPlane().models().listCredentials(FULL_ACCESS)).filter(
    (summary) => summary.provider === "meta",
  );

const relay = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    if (request.url === MINT_URL) {
      mints += 1;

      return Response.json({ api_key: "minted-key", base_url: "https://meta.e2e/v1" });
    }

    if (!request.url.startsWith("https://meta.e2e/")) return await realFetch(request);

    const bytes = new Uint8Array(await request.arrayBuffer());

    const call = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: new TextDecoder().decode(bytes),
      bytes: [...bytes],
    };

    calls.push(call);

    return upstream(call);
  };

  const stored = await withModelsPart(controlPlane(), (part) => part.importConfig(YAML, "test"));

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

  it("cools a credential down without a model for the upstream's Retry-After, so neither model uses it", async () => {
    upstream = () =>
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "600" },
      });

    const before = Date.now();
    const limited = await relay("/muse-code/browser_open", { method: "POST", body: "{}" });

    // The upstream answer comes back as it was sent.
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    expect(await limited.text()).toBe('{"error":"slow down"}');
    const cooledKey = calls[0]?.headers.get("authorization");
    const credentials = await metaCredentials();
    const cooled = credentials.find((summary) => summary.unavailable);

    // The credential itself is cooled, for the 600 s the upstream asked, and no model state holds it.
    expect(credentials.filter((summary) => summary.unavailable)).toHaveLength(1);
    expect(cooled?.nextRetryAfter).toBeGreaterThanOrEqual(before + 600_000);
    expect(cooled?.nextRetryAfter).toBeLessThan(Date.now() + 600_000 + 5_000);
    expect(cooled?.modelStates).toEqual({});

    upstream = () => Response.json({ ok: true });

    for (let i = 0; i < 4; i++) {
      const response = await relay("/muse-code/browser_open", { method: "POST", body: "{}" });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }

    expect(calls.slice(1).map((call) => call.headers.get("authorization"))).not.toContain(
      cooledKey,
    );
  });

  it("forwards the request body's bytes unchanged", async () => {
    upstream = () => Response.json({ ok: true });
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);

    const response = await relay("/muse-code/search", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });

    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(calls[0]?.bytes).toEqual([...bytes]);
  });

  // Last: it replaces the configured keys with one DCA auth file.
  it("refreshes a credential once after a 401 and relays the retried answer", async () => {
    const cleared = await withModelsPart(controlPlane(), (part) =>
      part.importConfig("api-keys: {}\n", "test"),
    );

    expect(cleared.ok).toBe(true);

    const imported = await controlPlane().models().importAuthFile(
      "meta-dca.json",
      {
        type: "meta",
        dca_token: "dca:device",
        api_key: "stale-key",
        base_url: "https://meta.e2e/v1",
      },
      {},
      FULL_ACCESS,
    );

    expect(imported.ok).toBe(true);

    upstream = (call) =>
      call.headers.get("authorization") === "Bearer stale-key"
        ? Response.json({ error: "expired" }, { status: 401 })
        : Response.json({ features: {} });

    const response = await relay("/muse-code/config");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ features: {} });
    expect(mints).toBe(1);
    expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer stale-key",
      "Bearer minted-key",
    ]);
  });
});

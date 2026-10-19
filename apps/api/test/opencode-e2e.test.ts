// OpenCode model-level cooldowns end to end: the production Worker (`exports.default.fetch`) with the real ControlPlane
// picker and `markResult`; only the gateway is mocked, through the global `fetch`.
import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";

type Upstream = (request: Request) => Response | Promise<Response>;

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

const upstreamCalls: string[] = [];

const realFetch = globalThis.fetch;

// The Zen group mirrors the live setup (prefix, catalog models); the Go group lists its models explicitly.
const YAML = `
api-keys:
  opencode-zen:
    - prefix: opencode-zen
      keys:
        - api-key: sk-zen-e2e
  opencode-go:
    - keys:
        - api-key: sk-go-e2e
      models:
        - name: disabled-model
          protocol: chat
        - name: open-model
          protocol: chat
`;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "open-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

// The body the Zen gateway answered in the live check.
const DISABLED = JSON.stringify({
  type: "error",
  error: { type: "api_error", message: "Upstream request failed: Model access is disabled" },
});

const disabled = () =>
  new Response(DISABLED, { status: 403, headers: { "content-type": "application/json" } });

const chat = (model: string) =>
  exports.default.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
  );

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

interface Cooldown {
  readonly scope: string;
  readonly model_key: string;
}

interface Listed {
  readonly families: Record<
    string,
    ReadonlyArray<{
      readonly group: {
        readonly keys: ReadonlyArray<{
          readonly runtime: { readonly cooldowns: ReadonlyArray<Cooldown> } | null;
        }>;
      };
    }>
  >;
}

/**
 * Runtime cooldowns of the single key of a family, as `GET /v9/management/provider-keys` (the app Worker's) shows them
 * to an org admin: the Models part's `providerKeysView`, which that route answers unchanged.
 */
const cooldowns = async (family: string): Promise<ReadonlyArray<Cooldown>> => {
  // SAFETY: the api-keys list contract (`@commissary/contract/provider-keys` ProviderKeysList).
  const listed = (await withModelsPart(controlPlane(), (part) =>
    part.providerKeysView(FULL_ACCESS),
  )) as unknown as Listed;

  return listed.families[family]?.[0]?.group.keys[0]?.runtime?.cooldowns ?? [];
};

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamCalls.push(`${request.method} ${request.url}`);

    return await upstream(request);
  };

  const stored = await withModelsPart(controlPlane(), (part) => part.importConfig(YAML, "test"));
  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  upstreamCalls.length = 0;
});

describe("OpenCode model cooldown through the ControlPlane", () => {
  it("cools only the disabled model of the key: no second upstream call, the other model stays usable", async () => {
    upstream = async (request) => {
      // SAFETY: the executor always posts a JSON object.
      const body = (await request.json()) as { model?: string };

      return body.model === "disabled-model" ? disabled() : Response.json(COMPLETION);
    };

    const first = await chat("disabled-model");
    expect(first.status).toBe(403);
    await first.text();
    expect(upstreamCalls).toEqual(["POST https://opencode.ai/inference/go/v1/chat/completions"]);

    upstreamCalls.length = 0;
    const other = await chat("open-model");
    expect(other.status).toBe(200);
    await other.text();
    expect(upstreamCalls).toEqual(["POST https://opencode.ai/inference/go/v1/chat/completions"]);

    // A success on another model of the key leaves the cooldown alone.
    upstreamCalls.length = 0;
    const second = await chat("disabled-model");
    expect(second.status).toBe(503);
    expect(await second.text()).toContain("no auth available");
    expect(upstreamCalls).toEqual([]);
    expect(await cooldowns("opencode-go")).toMatchObject([
      { scope: "model", model_key: "disabled-model" },
    ]);
  });

  it("keeps the cooldown of a prefixed catalog model across a ControlPlane eviction", async () => {
    upstream = async (request) => {
      // SAFETY: the executor always posts a JSON object.
      const body = (await request.json()) as { model?: string };

      return body.model === "claude-haiku-4-5" ? disabled() : Response.json(COMPLETION);
    };

    const first = await chat("opencode-zen/claude-haiku-4-5");
    expect(first.status).toBe(403);
    await first.text();
    expect(upstreamCalls).toEqual(["POST https://opencode.ai/inference/v1/messages"]);

    // The live check went idle long enough for the Durable Object to be evicted.
    await evictDurableObject(controlPlane());
    upstreamCalls.length = 0;

    for (const model of ["opencode-zen/claude-haiku-4-5", "claude-haiku-4-5"]) {
      const again = await chat(model);
      expect(again.status).toBe(503);
      await again.text();
    }

    expect(upstreamCalls).toEqual([]);
    expect(await cooldowns("opencode-zen")).toMatchObject([
      { scope: "model", model_key: "claude-haiku-4-5" },
    ]);

    const other = await chat("opencode-zen/glm-5.3-flash");
    expect(other.status).toBe(200);
    await other.text();
    expect(upstreamCalls).toEqual(["POST https://opencode.ai/inference/v1/chat/completions"]);
  });
});

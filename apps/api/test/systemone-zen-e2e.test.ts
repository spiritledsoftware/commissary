// System One (ADR 0032) end to end on OpenCode Zen's `systemone` protocol: TypeSafe's JavaScript SDK and plain requests,
// pointed at the production Worker (`exports.default.fetch`), against the real ControlPlane picker, `markResult`, model
// registry and D1 usage sink; only the gateway is mocked, through the global `fetch`. Error cases have key groups of
// their own (`force-model-prefix`), so one case's cooldowns cannot reach another.
import { env, exports } from "cloudflare:workers";
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_ORG } from "@commissary/core";
import { FULL_ACCESS, resetUsageDb, withModelsPart } from "@commissary/models/testing";
import { addMember, issueKey } from "./support/client.ts";

type Upstream = (request: Request) => Response | Promise<Response>;

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

interface Captured {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

const upstreamCalls: Captured[] = [];

const realFetch = globalThis.fetch;

const YAML = `
routing:
  force-model-prefix: true
api-keys:
  opencode-zen:
    - keys:
        - api-key: zen-key
    - prefix: rejected
      keys:
        - api-key: zen-rejected
    - prefix: unavailable
      keys:
        - api-key: zen-unavailable
    - prefix: aliased
      models:
        - name: jev-1.13
          alias: my-jev
      keys:
        - api-key: zen-aliased
  opencode-go:
    - keys:
        - api-key: go-key
`;

/** What Zen answers (TypeSafe's answer, the model echoing Zen's id). */
const ANSWER = {
  model: "jev-1.13",
  answers: { is_billing: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 100_000, output_tokens: 3 },
};

const BILLING = {
  model: "jev-1.13",
  state: "The customer says the bill is wrong.",
  questions: { is_billing: noul("Is this about billing?") },
};

let apiKey = "";

/** TypeSafe's SDK with Commissary as its base URL; no retries, so a refusal is seen once. */
const client = () =>
  new TypeSafeClient({
    apiKey,
    baseURL: "http://localhost",
    compression: false,
    retry: { maxRetries: 0 },
    logLevel: "off",
    fetch: (input, init) => exports.default.fetch(new Request(input, init)),
  });

const systemOne = (body: Record<string, unknown>) =>
  exports.default.fetch(
    new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }),
  );

interface UsageRow {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly failed: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_micros: number | null;
  readonly unpriced: number;
}

const usageRows = async (): Promise<UsageRow[]> =>
  (await env.USAGE.prepare("SELECT * FROM usage_records ORDER BY requested_at").all<UsageRow>())
    .results;

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

interface Listed {
  readonly families: Record<
    string,
    ReadonlyArray<{
      readonly group: {
        readonly prefix?: string;
        readonly keys: ReadonlyArray<{
          readonly runtime: {
            readonly cooldowns: ReadonlyArray<{
              readonly scope: string;
              readonly model_key: string;
            }>;
          } | null;
        }>;
      };
    }>
  >;
}

/** Runtime cooldowns of the single key of Zen's group `prefix`, as the provider keys view shows them. */
const zenCooldowns = async (prefix: string) => {
  // SAFETY: the api-keys list contract (`@commissary/contract/provider-keys` ProviderKeysList).
  const listed = (await withModelsPart(controlPlane(), (part) =>
    part.providerKeysView(FULL_ACCESS),
  )) as unknown as Listed;

  const entry = listed.families["opencode-zen"]?.find(({ group }) => group.prefix === prefix);

  return entry?.group.keys[0]?.runtime?.cooldowns ?? [];
};

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.clone().text();
    upstreamCalls.push({ url: `${request.method} ${request.url}`, headers: request.headers, body });

    return await upstream(request);
  };

  const stored = await controlPlane().models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
  apiKey = (await issueKey(GLOBAL_ORG, await addMember(GLOBAL_ORG, "zen@example.com", "admin")))
    .key;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  upstreamCalls.length = 0;
  upstream = () => Response.json(ANSWER);
  await resetUsageDb();
});

describe("System One on OpenCode Zen", () => {
  it("answers the SDK through {base}/systemone with the gateway headers and records usage at the catalog price", async () => {
    const result = await client().systemOne(BILLING, {
      headers: { "TypeSafe-Danger-Zone-Long-Context": "true" },
    });

    expect(result.answers.is_billing).toEqual({ type: "noul", noul: 0.9 });
    expect(result.usage).toEqual({ input_tokens: 100_000, output_tokens: 3 });
    expect(upstreamCalls.map((call) => call.url)).toEqual([
      "POST https://opencode.ai/inference/v1/systemone",
    ]);

    const [call] = upstreamCalls;
    expect(call?.headers.get("authorization")).toBe("Bearer zen-key");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.get("x-opencode-client")).toBe("commissary");
    expect(call?.headers.get("user-agent")).toBe("commissary");
    expect(call?.headers.get("x-opencode-session")).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.headers.get("typesafe-danger-zone-long-context")).toBe("true");
    expect(JSON.parse(call?.body ?? "")).toEqual({
      model: "jev-1.13",
      state: "The customer says the bill is wrong.",
      questions: { is_billing: { type: "noul", instructions: "Is this about billing?" } },
    });

    await vi.waitFor(
      async () => {
        expect(await usageRows()).toMatchObject([
          {
            provider: "opencode-zen",
            model: "jev-1.13",
            endpoint: "POST /v1/systemone",
            failed: 0,
            input_tokens: 100_000,
            output_tokens: 3,
            // $0.042 per million input tokens, output free.
            cost_micros: 4_200,
            unpriced: 0,
          },
        ]);
      },
      { timeout: 10_000, interval: 20 },
    );
  });

  it("serves jev-1.13-free at no cost", async () => {
    upstream = () => Response.json({ ...ANSWER, model: "jev-1.13-free" });
    const response = await systemOne({ ...BILLING, model: "jev-1.13-free" });

    expect(response.status).toBe(200);
    expect(((await response.json()) as typeof ANSWER).model).toBe("jev-1.13-free");

    await vi.waitFor(
      async () => {
        expect(await usageRows()).toMatchObject([
          { provider: "opencode-zen", model: "jev-1.13-free", cost_micros: 0, unpriced: 0 },
        ]);
      },
      { timeout: 10_000, interval: 20 },
    );
  });

  it("refuses an image to jev-1.13 locally, as JSON or multipart, TypeSafe-shaped", async () => {
    const refused = {
      detail: {
        error_type: "api_usage_error",
        message: "jev-1.13 on OpenCode Zen does not accept images",
      },
    };

    const json = await systemOne({
      ...BILLING,
      state: "<image:a>",
      assets: { "<image:a>": { format: "png", data_base64: "iVBORw0K" } },
    });

    expect(json.status).toBe(400);
    expect(await json.json()).toEqual(refused);

    const form = new FormData();
    form.append(
      "request",
      JSON.stringify({ ...BILLING, state: "<image:a>", assets: { "<image:a>": { part: "img" } } }),
    );
    form.append(
      "img",
      new File([new Uint8Array([137, 80, 78, 71])], "img.png", { type: "image/png" }),
    );

    const multipart = await exports.default.fetch(
      new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      }),
    );

    expect(multipart.status).toBe(400);
    expect(await multipart.json()).toEqual(refused);
    expect(upstreamCalls).toEqual([]);
  });

  it("refuses a Box question on jev-1.13 locally", async () => {
    const response = await systemOne({
      ...BILLING,
      questions: { total: { type: "box", instructions: "Where is the total?" } },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      detail: {
        error_type: "api_usage_error",
        message: "jev-1.13 on OpenCode Zen does not support Box questions",
      },
    });
    expect(upstreamCalls).toEqual([]);
  });

  it("answers Zen's {error:{type,message}} 401 TypeSafe-shaped and cools the key", async () => {
    upstream = () =>
      Response.json(
        { error: { type: "server_error", message: "Upstream request failed: Invalid credential" } },
        { status: 401 },
      );

    const response = await systemOne({ ...BILLING, model: "rejected/jev-1.13" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      detail: {
        error_type: "authentication_error",
        message: "Upstream request failed: Invalid credential",
      },
    });
    expect(upstreamCalls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer zen-rejected",
    ]);

    const group = (await controlPlane().models().listCredentials(FULL_ACCESS))
      .filter((summary) => summary.prefix === "rejected")
      .map(({ failed, unavailable }) => ({ failed, unavailable }));

    expect(group).toEqual([{ failed: 1, unavailable: true }]);

    upstreamCalls.length = 0;
    const again = await systemOne({ ...BILLING, model: "rejected/jev-1.13" });
    expect(again.status).toBe(503);
    expect(Object.keys(await again.json())).toEqual(["detail"]);
    expect(upstreamCalls).toEqual([]);
  });

  it('keeps OpenCode\'s model-level cooldown for "Model is unavailable"', async () => {
    upstream = () =>
      Response.json(
        {
          error: {
            type: "server_error",
            message: "Upstream request failed: Model is unavailable.",
          },
        },
        { status: 400 },
      );

    const first = await systemOne({ ...BILLING, model: "unavailable/jev-1.13-free" });
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({
      detail: {
        error_type: "api_usage_error",
        message: "Upstream request failed: Model is unavailable.",
      },
    });
    expect(await zenCooldowns("unavailable")).toMatchObject([
      { scope: "model", model_key: "jev-1.13-free" },
    ]);

    upstreamCalls.length = 0;
    upstream = () => Response.json(ANSWER);
    const other = await systemOne({ ...BILLING, model: "unavailable/jev-1.13" });
    expect(other.status).toBe(200);
    await other.text();
    expect(upstreamCalls).toHaveLength(1);
  });

  it("serves an org model alias and a suffixed name, refusing images through them too", async () => {
    const served = await systemOne({ ...BILLING, model: "aliased/my-jev" });
    expect(served.status).toBe(200);
    await served.text();
    expect(upstreamCalls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer zen-aliased",
    ]);
    expect(JSON.parse(upstreamCalls[0]?.body ?? "")).toMatchObject({ model: "jev-1.13" });

    upstreamCalls.length = 0;

    const refused = await systemOne({
      ...BILLING,
      model: "aliased/my-jev(high)",
      state: "<image:a>",
      assets: { "<image:a>": { format: "png", data_base64: "iVBORw0K" } },
    });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      detail: {
        error_type: "api_usage_error",
        message: "jev-1.13 on OpenCode Zen does not accept images",
      },
    });
    expect(upstreamCalls).toEqual([]);
  });

  it("registers jev-1.13 and jev-1.13-free for Zen only, typed systemone, and guards them on chat", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${apiKey}` } }),
    );

    const listed = (await response.json()) as {
      data: Array<{ id: string; owned_by: string; type?: string }>;
    };

    expect(
      listed.data.filter((model) => model.type === "systemone").map((model) => model.id),
    ).toEqual([
      "aliased/my-jev",
      "jev-1.13",
      "jev-1.13-free",
      "rejected/jev-1.13",
      "rejected/jev-1.13-free",
      "unavailable/jev-1.13",
      "unavailable/jev-1.13-free",
    ]);

    const chat = await exports.default.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "rejected/jev-1.13",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(chat.status).toBe(400);
    expect(((await chat.json()) as { error: { message: string } }).error.message).toMatch(
      /is a System One model: it is only supported on \/v1\/systemone$/,
    );
    expect(upstreamCalls).toEqual([]);
  });
});

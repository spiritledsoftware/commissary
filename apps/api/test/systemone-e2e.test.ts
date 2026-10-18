// System One (ADR 0032) end to end on TypeSafe: TypeSafe's own JavaScript SDK, pointed at the production Worker
// (`exports.default.fetch`) with a Commissary API key, against the real ControlPlane picker, model registry and D1 usage
// sink; only TypeSafe is mocked, through the global `fetch`. Text and multipart image requests, payload rules, local
// refusals, the endpoint guard both ways and the model listing.
import { env, exports } from "cloudflare:workers";
import { image, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mintApiKey } from "@commissary/auth";
import { GLOBAL_ORG } from "@commissary/core";
import { resetUsageDb } from "@commissary/models/testing";
import { addMember, issueKey } from "./support/client.ts";

type Upstream = (request: Request) => Response | Promise<Response>;

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

interface Captured {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

const upstreamCalls: Captured[] = [];

const realFetch = globalThis.fetch;

const YAML = `
api-keys:
  typesafe:
    - keys:
        - api-key: ts-e2e-key
  subq:
    - keys:
        - api-key: subq-e2e-key
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1
      models:
        - name: upstream-model
          alias: chat-model
      keys:
        - api-key: sk-e2e
payload:
  override:
    - models:
        - name: "jev-*"
          protocol: systemone
          headers:
            X-Rule: "on"
      params:
        state.note: added by a payload rule
`;

/** What TypeSafe answers (https://docs.typesafe.ai/api). */
const ANSWER = {
  model: "jev-1.13.0",
  answers: { is_billing: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 100_000, output_tokens: 3 },
};

// A 1x1 PNG (TypeSafe's live API wants at least 280x280; the mock does not look).
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

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

const systemOne = (body: Record<string, unknown> | string, headers: Record<string, string> = {}) =>
  exports.default.fetch(
    new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
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

const BILLING = {
  model: "jev-latest",
  state: "The customer says the bill is wrong.",
  questions: { is_billing: noul("Is this about billing?") },
};

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    upstreamCalls.push({ url: `${request.method} ${request.url}`, headers: request.headers, body });

    return await upstream(request);
  };

  const stored = await env.CONTROL_PLANE.getByName("global").models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
  apiKey = (await issueKey(GLOBAL_ORG, await addMember(GLOBAL_ORG, "sdk@example.com", "admin")))
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

describe("System One on TypeSafe through the SDK", () => {
  it("answers a text request in TypeSafe's shape and records its usage at the catalog price", async () => {
    const result = await client().systemOne(BILLING);

    expect(result.answers.is_billing).toEqual({ type: "noul", noul: 0.9 });
    expect(result.usage).toEqual({ input_tokens: 100_000, output_tokens: 3 });
    expect(upstreamCalls.map((call) => call.url)).toEqual([
      "POST https://api.typesafe.ai/v1/systemone",
    ]);
    const [call] = upstreamCalls;
    expect(call?.headers.get("authorization")).toBe("Bearer ts-e2e-key");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(call?.body))).toEqual({
      model: "jev-latest",
      state: "The customer says the bill is wrong.",
      questions: { is_billing: { type: "noul", instructions: "Is this about billing?" } },
    });

    await vi.waitFor(
      async () => {
        expect(await usageRows()).toMatchObject([
          {
            provider: "typesafe",
            model: "jev-latest",
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

  it("sends a multipart image request on as multipart, the file bytes unchanged and the opt-in forwarded", async () => {
    const result = await client().systemOne(
      {
        model: "jev-preview",
        state: { text: "The bill", photo: image(PNG) },
        questions: { is_billing: noul("Is the photo `photo` a bill?") },
      },
      { headers: { "TypeSafe-Danger-Zone-Images": "true", "X-Rule": "on" } },
    );

    expect(result.answers.is_billing).toEqual({ type: "noul", noul: 0.9 });
    const [call] = upstreamCalls;
    expect(call?.headers.get("typesafe-danger-zone-images")).toBe("true");
    const contentType = call?.headers.get("content-type") ?? "";
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);

    const form = await new Request("http://x", {
      method: "POST",
      headers: { "content-type": contentType },
      body: call?.body ?? null,
    }).formData();

    expect([...form.keys()]).toEqual(["request", "asset-0"]);

    const requestPart = form.get("request");

    expect(typeof requestPart).toBe("string");

    const json = JSON.parse(typeof requestPart === "string" ? requestPart : "") as {
      readonly model: string;
      readonly state: { readonly photo: string; readonly note: string };
      readonly assets: Record<string, unknown>;
    };

    // The payload rule changed the JSON request (and only it).
    expect(json.model).toBe("jev-preview");
    expect(json.state.note).toBe("added by a payload rule");
    expect(json.assets[json.state.photo]).toEqual({ type: "image", part: "asset-0" });

    const file = form.get("asset-0");

    if (!(file instanceof File)) throw new Error("asset-0 is not a file part");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });

  it("refuses a Box question on Jev 1.13 locally, TypeSafe-shaped", async () => {
    const response = await systemOne({
      model: "jev-1.13.0",
      state: "a receipt",
      questions: { total: { type: "box", instructions: "Where is the total?" } },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      detail: {
        error_type: "api_usage_error",
        message: "jev-1.13.0 on TypeSafe does not support Box questions",
      },
    });
    expect(upstreamCalls).toEqual([]);
  });

  it("refuses a body over TypeSafe's 32 MiB with 413", async () => {
    const response = await systemOne(
      JSON.stringify({ ...BILLING, state: "x".repeat(32 * 1024 * 1024) }),
    );

    expect(response.status).toBe(413);
    expect(((await response.json()) as { detail: { error_type: string } }).detail.error_type).toBe(
      "request_too_large",
    );
    expect(upstreamCalls).toEqual([]);
  });

  it("refuses a multipart part no asset uses", async () => {
    const form = new FormData();
    form.append("request", JSON.stringify(BILLING));
    form.append("stray", new File([PNG], "stray.png", { type: "image/png" }));

    const response = await exports.default.fetch(
      new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      detail: {
        error_type: "api_usage_error",
        message: 'multipart part "stray" is not used by any asset',
      },
    });
    expect(upstreamCalls).toEqual([]);
  });
});

// SubQ's images, refusals and errors: systemone-subq-e2e.test.ts.
describe("System One on SubQ", () => {
  it("sends a text request as JSON without TypeSafe's opt-in headers", async () => {
    upstream = () => Response.json({ ...ANSWER, model: "subq-snap-preview" });

    const response = await systemOne(
      { ...BILLING, model: "subq-snap-preview" },
      { "TypeSafe-Danger-Zone-Long-Context": "true" },
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as typeof ANSWER).model).toBe("subq-snap-preview");
    const [call] = upstreamCalls;
    expect(call?.url).toBe("POST https://api.subq.ai/v1/systemone");
    expect(call?.headers.get("authorization")).toBe("Bearer subq-e2e-key");
    expect(call?.headers.get("typesafe-danger-zone-long-context")).toBeNull();
  });
});

describe("the System One endpoint guard", () => {
  it("refuses a System One model on chat completions and a chat model on /v1/systemone", async () => {
    const chat = await exports.default.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "jev-latest", messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    expect(chat.status).toBe(400);
    expect(((await chat.json()) as { error: { message: string } }).error.message).toBe(
      "model jev-latest is a System One model: it is only supported on /v1/systemone",
    );

    const systemOneChat = await systemOne({ ...BILLING, model: "chat-model" });
    expect(systemOneChat.status).toBe(400);
    expect(await systemOneChat.json()).toEqual({
      detail: {
        error_type: "api_usage_error",
        message:
          "model chat-model is not a System One model: /v1/systemone only serves System One models",
      },
    });
    expect(upstreamCalls).toEqual([]);
  });

  it("lists System One models in /v1/models with their type", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${apiKey}` } }),
    );

    const listed = (await response.json()) as {
      data: Array<{ id: string; owned_by: string; type?: string }>;
    };

    expect(
      listed.data.filter((model) => model.type === "systemone").map((model) => model.id),
    ).toEqual(["jev-1.13.0", "jev-1.14.0", "jev-latest", "jev-preview", "subq-snap-preview"]);
    expect(listed.data.find((model) => model.id === "chat-model")).not.toHaveProperty("type");
  });

  it("answers an unknown API key TypeSafe-shaped", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${mintApiKey(GLOBAL_ORG).key}`,
        },
        body: JSON.stringify(BILLING),
      }),
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as { detail: { error_type: string } }).detail.error_type).toBe(
      "authentication_error",
    );
  });
});

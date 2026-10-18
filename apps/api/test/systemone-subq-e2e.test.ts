// System One (ADR 0032) end to end on SubQ: TypeSafe's JavaScript SDK, pointed at the production Worker
// (`exports.default.fetch`) with a Commissary API key, against the real ControlPlane picker, model registry, D1 usage
// sink and `markResult`; only SubQ is mocked, through the global `fetch`. The TypeSafe request becomes SubQ's JSON
// (images, labels), SubQ's limits and Box are refused locally, and a 402 cools the key.
import { env, exports } from "cloudflare:workers";
import { image, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_ORG } from "@commissary/core";
import { FULL_ACCESS, resetUsageDb } from "@commissary/models/testing";
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

// The first group (no models) registers SubQ's catalog model; the second, behind a forced prefix, serves only
// `broke/subq-snap-preview`, so its cooldowns stay its own.
const YAML = `
routing:
  force-model-prefix: true
api-keys:
  subq:
    - keys:
        - api-key: subq-e2e-key
    - prefix: broke
      keys:
        - api-key: subq-broke
        - api-key: subq-funded
`;

/** What SubQ answers (https://docs.subq.ai, Decisions API): `output_tokens` is always 0. */
const ANSWER = {
  model: "subq-snap-preview",
  answers: { is_billing: { type: "noul", noul: 0.8 } },
  usage: { input_tokens: 100_000, output_tokens: 0 },
};

// A 1x1 PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PNG = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));

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
  model: "subq-snap-preview",
  state: "The customer says the bill is wrong.",
  questions: { is_billing: noul("Is this about billing?") },
};

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.clone().text();
    upstreamCalls.push({ url: `${request.method} ${request.url}`, headers: request.headers, body });

    return await upstream(request);
  };

  const stored = await controlPlane().models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
  apiKey = (await issueKey(GLOBAL_ORG, await addMember(GLOBAL_ORG, "subq@example.com", "admin")))
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

describe("System One on SubQ through the SDK", () => {
  it("answers a text request in TypeSafe's shape and records its usage at the catalog price", async () => {
    const result = await client().systemOne(BILLING);

    expect(result.answers.is_billing).toEqual({ type: "noul", noul: 0.8 });
    expect(result.usage).toEqual({ input_tokens: 100_000, output_tokens: 0 });
    expect(upstreamCalls.map((call) => call.url)).toEqual([
      "POST https://api.subq.ai/v1/systemone",
    ]);
    const [call] = upstreamCalls;
    expect(call?.headers.get("authorization")).toBe("Bearer subq-e2e-key");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call?.body ?? "")).toEqual({
      model: "subq-snap-preview",
      state: "The customer says the bill is wrong.",
      questions: { is_billing: { type: "noul", instructions: "Is this about billing?" } },
    });

    await vi.waitFor(
      async () => {
        expect(await usageRows()).toMatchObject([
          {
            provider: "subq",
            model: "subq-snap-preview",
            failed: 0,
            input_tokens: 100_000,
            output_tokens: 0,
            // $0.05 per million input tokens.
            cost_micros: 5_000,
            unpriced: 0,
          },
        ]);
      },
      { timeout: 10_000, interval: 20 },
    );
  });

  it("sends a multipart image request as JSON, the image in images and its reference replaced by a label", async () => {
    const result = await client().systemOne(
      {
        model: "subq-snap-preview",
        state: { text: "The bill", photo: image(PNG) },
        questions: { is_billing: noul("Is the photo `photo` a bill?") },
      },
      { headers: { "TypeSafe-Danger-Zone-Images": "true" } },
    );

    expect(result.answers.is_billing).toEqual({ type: "noul", noul: 0.8 });
    const [call] = upstreamCalls;
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.get("typesafe-danger-zone-images")).toBeNull();

    // SAFETY: the SubQ executor always posts a JSON object; the expectations below check its fields.
    const sent = JSON.parse(call?.body ?? "") as {
      readonly state: Record<string, unknown>;
      readonly images: ReadonlyArray<{ readonly mediaType: string; readonly base64: string }>;
    };

    expect(sent).not.toHaveProperty("assets");
    expect(sent.state).toEqual({ text: "The bill", photo: "[image 1]" });
    expect(sent.images).toEqual([{ mediaType: "image/png", base64: PNG_BASE64 }]);
  });

  it("refuses a Box question locally, TypeSafe-shaped", async () => {
    const response = await systemOne({
      ...BILLING,
      questions: { total: { type: "box", instructions: "Where is the total?" } },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      detail: {
        error_type: "api_usage_error",
        message: "subq-snap-preview on SubQ does not support Box questions",
      },
    });
    expect(upstreamCalls).toEqual([]);
  });

  it("refuses five images locally, TypeSafe-shaped", async () => {
    const refs = ["<a>", "<b>", "<c>", "<d>", "<e>"];

    const response = await systemOne({
      ...BILLING,
      state: refs.join(" "),
      assets: Object.fromEntries(
        refs.map((ref) => [ref, { format: "png", data_base64: PNG_BASE64 }]),
      ),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      detail: {
        error_type: "api_usage_error",
        message: "SubQ takes at most 4 images per request; this request has 5",
      },
    });
    expect(upstreamCalls).toEqual([]);
  });
});

describe("SubQ errors through /v1/systemone", () => {
  it("cools a key without credits (402) and fails over to the next one", async () => {
    upstream = (request) =>
      request.headers.get("authorization") === "Bearer subq-broke"
        ? Response.json(
            { detail: { error_type: "billing_error", message: "Insufficient credits." } },
            { status: 402 },
          )
        : Response.json(ANSWER);

    for (let round = 0; round < 3; round += 1) {
      const response = await systemOne({ ...BILLING, model: "broke/subq-snap-preview" });
      expect(response.status).toBe(200);
      await response.text();
    }

    const keys = upstreamCalls.map((call) => call.headers.get("authorization"));
    expect(keys.filter((key) => key === "Bearer subq-broke")).toHaveLength(1);
    expect(keys.filter((key) => key === "Bearer subq-funded")).toHaveLength(3);

    const group = (await controlPlane().models().listCredentials(FULL_ACCESS))
      .filter((summary) => summary.prefix === "broke")
      .map(({ failed, success, unavailable }) => ({ failed, success, unavailable }))
      .toSorted((a, b) => b.failed - a.failed);

    expect(group).toEqual([
      { failed: 1, success: 0, unavailable: true },
      { failed: 0, success: 3, unavailable: false },
    ]);
  });
});

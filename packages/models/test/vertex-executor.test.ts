// End-to-end tests (workerd) of the Vertex executor: service-account and provider-key endpoints, token handling through the
// ControlPlane stub, Imagen conversion, native Interactions and the payload-rules-last ordering.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import {
  convertImagenToGeminiResponse,
  convertToImagenRequest,
} from "../src/executor/gemini/google.ts";
import { stripVertexOpenAIResponsesToolCallIds } from "../src/executor/gemini/shaping.ts";
import {
  vertexApiKeyModelsUrl,
  vertexBaseUrl,
  vertexInteractionsUrl,
} from "../src/executor/gemini/targets.ts";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
import {
  jsonResponse,
  loadConfig,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import type { Json, JsonObject } from "@commissary/json";

const YAML = `
requests:
  payload:
    override:
      - models: [{ name: "gemini-2.5-pro", protocol: gemini }]
        params:
          "generationConfig.topK": 9
          "session_id": "from-rule"
`;

const GEMINI_RESPONSE = {
  candidates: [
    { content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP", index: 0 },
  ],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
  modelVersion: "gemini-2.5-pro",
  responseId: "r1",
};

let config: Config;

beforeAll(async () => {
  config = await loadConfig(YAML);
});

const models = { "gemini-2.5-pro": ["vertex"], "imagen-4.0-generate-001": ["vertex"] };

const saMetadata = {
  project_id: "proj-1",
  location: "europe-west4",
  service_account: { client_email: "sa@proj-1.iam", private_key: "x" },
};

const harness = (
  respond: UpstreamResponder,
  cred: ReturnType<typeof credential>,
  env: Record<string, unknown> = {},
) => makeGeminiHarness({ config, respond, credential: cred, models, env });

const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

type RealStub = ReturnType<Cloudflare.Env["CONTROL_PLANE"]["getByName"]>;

describe("vertex service account", () => {
  it("uses the regional endpoint with the cached bearer token and applies payload rules last", async () => {
    const cred = credential("vertex", "vertex:sa", {
      kind: "oauth",
      metadata: { ...saMetadata, access_token: "ya29.cached" },
    });

    const h = harness(() => jsonResponse(GEMINI_RESPONSE), cred);
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      postJson({ ...body, session_id: "x" }),
    );

    expect(response.status).toBe(200);
    expect(h.calls[0]?.url).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/projects/proj-1/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent",
    );
    expect(h.calls[0]?.headers["authorization"]).toBe("Bearer ya29.cached");
    expect(h.calls[0]?.headers["x-goog-api-key"]).toBeUndefined();
    const upstream = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(upstream.generationConfig.topK).toBe(9);
    expect(upstream.session_id).toBe("from-rule");
  });

  /**
   * A ControlPlane stub whose `ensureFresh` returns `result` (the wire credential carries the minted metadata); the
   * Access gate's membership calls reach the real ControlPlane.
   */
  const controlPlane = (ensured: string[], result: (id: string) => Json) => ({
    getByName: (name: string) => ({
      admit: async (...args: Parameters<RealStub["admit"]>) =>
        await env.CONTROL_PLANE.getByName(name).admit(...args),
      membershipIndex: async () => await env.CONTROL_PLANE.getByName(name).membershipIndex(),
      markIndexSynced: async (counter: number) =>
        await env.CONTROL_PLANE.getByName(name).markIndexSynced(counter),
      models: () => ({
        ensureFresh: async (id: string) => {
          ensured.push(id);

          return result(id);
        },
        refreshNow: async () => ({
          ok: false,
          error: { code: "not_refreshable", message: "no" },
          terminal: false,
        }),
      }),
    }),
  });

  const mintedCredential = (metadata: JsonObject) => ({
    ok: true,
    refreshed: true,
    credential: {
      id: "vertex:sa",
      executor: "vertex",
      authKind: "oauth",
      label: "sa",
      credentialVersion: 2,
      attributes: {},
      headers: {},
      metadata,
    },
  });

  it("mints a token through the ControlPlane when the snapshot has none", async () => {
    const ensured: string[] = [];

    const cp = controlPlane(ensured, () =>
      mintedCredential({ ...saMetadata, access_token: "ya29.minted" }),
    );

    const cred = credential("vertex", "vertex:sa", { kind: "oauth", metadata: saMetadata });
    const h = harness(() => jsonResponse(GEMINI_RESPONSE), cred, { CONTROL_PLANE: cp });
    afterAll(h.dispose);
    const response = await h.call("/v1beta/models/gemini-2.5-pro:generateContent", postJson(body));
    expect(response.status).toBe(200);
    expect(ensured).toEqual(["vertex:sa"]);
    expect(h.calls[0]?.headers["authorization"]).toBe("Bearer ya29.minted");
  });

  it("fails the attempt without upstream details when minting fails and answers 401 for a missing token", async () => {
    const failing = controlPlane([], () => ({
      ok: false,
      error: { code: "refresh_failed", message: "secret detail" },
      terminal: false,
    }));

    const cred = credential("vertex", "vertex:sa", { kind: "oauth", metadata: saMetadata });
    const h1 = harness(() => jsonResponse(GEMINI_RESPONSE), cred, { CONTROL_PLANE: failing });
    afterAll(h1.dispose);
    const failed = await h1.call("/v1beta/models/gemini-2.5-pro:generateContent", postJson(body));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(h1.calls).toHaveLength(0);

    const empty = controlPlane([], () => mintedCredential(saMetadata));
    const h2 = harness(() => jsonResponse(GEMINI_RESPONSE), cred, { CONTROL_PLANE: empty });
    afterAll(h2.dispose);
    const missing = await h2.call("/v1beta/models/gemini-2.5-pro:generateContent", postJson(body));
    expect(missing.status).toBe(401);
    expect(await missing.text()).toContain("missing access token");
  });

  it("requires project_id and service_account in the credential", async () => {
    const cred = credential("vertex", "vertex:bad", {
      kind: "oauth",
      metadata: { location: "global" },
    });

    const h = harness(() => jsonResponse(GEMINI_RESPONSE), cred);
    afterAll(h.dispose);
    const response = await h.call("/v1beta/models/gemini-2.5-pro:generateContent", postJson(body));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("missing project_id");
  });

  it("streams without usage filtering and counts tokens against the project endpoint", async () => {
    const cred = credential("vertex", "vertex:sa", {
      kind: "oauth",
      metadata: { ...saMetadata, location: "global", access_token: "t" },
    });

    const h = harness(
      (call) =>
        call.url.endsWith(":countTokens")
          ? jsonResponse({ totalTokens: 3 })
          : sseResponse([
              `data: ${JSON.stringify({ ...GEMINI_RESPONSE, usageMetadata: { totalTokenCount: 5 } })}\n\n`,
            ]),
      cred,
    );

    afterAll(h.dispose);

    const stream = await h.call(
      "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      postJson(body),
    );

    expect(h.calls[0]?.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    const text = await stream.text();
    expect(text).toContain('"usageMetadata"');
    const count = await h.call("/v1beta/models/gemini-2.5-pro:countTokens", postJson(body));
    expect(h.calls[1]?.url.endsWith("/models/gemini-2.5-pro:countTokens")).toBe(true);
    expect(await count.json()).toMatchObject({ totalTokens: 3 });
  });
});

describe("vertex provider key", () => {
  it("uses the project-less endpoint with x-goog-api-key", async () => {
    const cred = credential("vertex", "vertex:apikey", {
      attributes: { api_key: "vk-1", base_url: "https://vx.test/" },
    });

    const h = harness(() => jsonResponse(GEMINI_RESPONSE), cred);
    afterAll(h.dispose);
    await h.call("/v1beta/models/gemini-2.5-pro:generateContent", postJson(body));
    expect(h.calls[0]?.url).toBe(
      "https://vx.test/v1/publishers/google/models/gemini-2.5-pro:generateContent",
    );
    expect(h.calls[0]?.headers["x-goog-api-key"]).toBe("vk-1");
    expect(h.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("defaults to the global Vertex host", async () => {
    const cred = credential("vertex", "vertex:apikey", { attributes: { api_key: "vk-1" } });
    const h = harness(() => jsonResponse(GEMINI_RESPONSE), cred);
    afterAll(h.dispose);
    await h.call("/v1beta/models/gemini-2.5-pro:generateContent", postJson(body));
    expect(h.calls[0]?.url).toBe(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:generateContent",
    );
  });
});

describe("vertex imagen", () => {
  it("converts the request to predict and the response back to a Gemini response", async () => {
    const cred = credential("vertex", "vertex:apikey", { attributes: { api_key: "vk-1" } });

    const h = harness(
      () => jsonResponse({ predictions: [{ bytesBase64Encoded: "QUJD", mimeType: "image/jpeg" }] }),
      cred,
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/imagen-4.0-generate-001:generateContent",
      postJson({
        contents: [{ role: "user", parts: [{ text: "a red cat" }] }],
        aspectRatio: "1:1",
        sampleCount: 2,
      }),
    );

    expect(h.calls[0]?.url).toBe(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/imagen-4.0-generate-001:predict",
    );
    expect(JSON.parse(h.calls[0]?.body ?? "{}")).toEqual({
      instances: [{ prompt: "a red cat" }],
      parameters: { sampleCount: 2, aspectRatio: "1:1" },
    });

    const out = (await response.json()) as {
      candidates: Array<{
        content: { parts: Array<{ inlineData: { data: string; mimeType: string } }> };
      }>;
    };

    expect(out.candidates[0]?.content.parts[0]?.inlineData).toEqual({
      mimeType: "image/jpeg",
      data: "QUJD",
    });
  });

  it("rejects requests without a prompt", async () => {
    const cred = credential("vertex", "vertex:apikey", { attributes: { api_key: "vk-1" } });
    const h = harness(() => jsonResponse({}), cred);
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/imagen-4.0-generate-001:generateContent",
      postJson({ contents: [] }),
    );

    expect(response.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("pure converters keep Go's fallbacks", () => {
    expect(
      convertToImagenRequest({ messages: [{ content: "" }, { content: "from messages" }] }),
    ).toEqual({
      instances: [{ prompt: "from messages" }],
      parameters: { sampleCount: 1 },
    });
    expect(convertToImagenRequest({ prompt: "direct", negativePrompt: "blurry" })).toEqual({
      instances: [{ prompt: "direct", negativePrompt: "blurry" }],
      parameters: { sampleCount: 1 },
    });
    expect(convertToImagenRequest({})).toBeUndefined();
    expect(
      JSON.parse(
        convertImagenToGeminiResponse(
          '{"predictions":[{"bytesBase64Encoded":"QQ=="}]}',
          "m",
          "123",
        ),
      ),
    ).toMatchObject({
      responseId: "imagen-123",
      modelVersion: "m",
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [{ inlineData: { mimeType: "image/png", data: "QQ==" } }],
          },
        },
      ],
    });
    expect(convertImagenToGeminiResponse("not json", "m", "1")).toBe("not json");
  });
});

describe("vertex helpers", () => {
  it("builds base URLs", () => {
    expect(vertexBaseUrl("")).toBe("https://us-central1-aiplatform.googleapis.com");
    expect(vertexBaseUrl("global")).toBe("https://aiplatform.googleapis.com");
    expect(vertexBaseUrl("asia-east1")).toBe("https://asia-east1-aiplatform.googleapis.com");
    expect(vertexBaseUrl("us")).toBe("https://aiplatform.us.rep.googleapis.com");
    expect(vertexBaseUrl("EU")).toBe("https://aiplatform.eu.rep.googleapis.com");
    expect(vertexBaseUrl("GLOBAL")).toBe("https://aiplatform.googleapis.com");
    expect(vertexInteractionsUrl("", "", false)).toBe(
      "https://aiplatform.googleapis.com/v1beta1/interactions",
    );
    expect(vertexInteractionsUrl("https://x.test/", "p1", true)).toBe(
      "https://x.test/v1beta1/projects/p1/locations/global/interactions?alt=sse",
    );
  });

  it.each([
    ["", "https://aiplatform.googleapis.com/v1/publishers/google/models/m:generateContent"],
    ["https://zenmux.ai", "https://zenmux.ai/v1/publishers/google/models/m:generateContent"],
    ["https://zenmux.ai/", "https://zenmux.ai/v1/publishers/google/models/m:generateContent"],
    ["https://zenmux.ai/v1", "https://zenmux.ai/v1/publishers/google/models/m:generateContent"],
    [
      "https://api.zenmux.ai/v1/publishers/google/models",
      "https://api.zenmux.ai/v1/publishers/google/models/m:generateContent",
    ],
    [
      "https://aiplatform.googleapis.com/v1/projects/279/locations/us-central1/publishers/google/models",
      "https://aiplatform.googleapis.com/v1/projects/279/locations/us-central1/publishers/google/models/m:generateContent",
    ],
    [
      "https://aiplatform.googleapis.com/v1beta1/projects/279/locations/us-central1/publishers/google/models",
      "https://aiplatform.googleapis.com/v1beta1/projects/279/locations/us-central1/publishers/google/models/m:generateContent",
    ],
    [
      "https://aiplatform.googleapis.com/v1beta1",
      "https://aiplatform.googleapis.com/v1beta1/publishers/google/models/m:generateContent",
    ],
    ["  https://zenmux.ai  ", "https://zenmux.ai/v1/publishers/google/models/m:generateContent"],
  ])("builds the API-key models URL for base %j", (base, expected) => {
    expect(vertexApiKeyModelsUrl(base, "m", "generateContent")).toBe(expected);
  });

  it("strips OpenAI Responses call ids only for that source format", () => {
    const make = () => ({
      contents: [
        { role: "model", parts: [{ functionCall: { id: "call_1", name: "f", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { id: "call_1", name: "f", response: {} } }] },
      ],
    });

    const stripped = stripVertexOpenAIResponsesToolCallIds(make(), "openai-response");
    expect(JSON.stringify(stripped)).not.toContain("call_1");
    expect(JSON.stringify(stripVertexOpenAIResponsesToolCallIds(make(), "openai"))).toContain(
      "call_1",
    );
  });
});

// CLIProxyAPI ceb4397f (gemini_vertex_executor_trailing_reasoning_test.go, #6630): Vertex rejects a request that ends with a
// thought-only model turn even when an empty user turn follows it.
describe("vertex trailing reasoning turns", () => {
  const hi = { role: "user", parts: [{ text: "say hi" }] };
  const thought = { role: "model", parts: [{ text: "I should say hi briefly.", thought: true }] };

  const signedThought = {
    role: "model",
    parts: [{ text: "I should say hi briefly.", thought: true, thoughtSignature: "sig" }],
  };

  const apiKey = credential("vertex", "vertex:apikey", { attributes: { api_key: "vk-1" } });

  const serviceAccount = credential("vertex", "vertex:sa", {
    kind: "oauth",
    metadata: { ...saMetadata, access_token: "ya29.cached" },
  });

  const sentContents = async (
    cred: ReturnType<typeof credential>,
    action: string,
    contents: Json[],
  ): Promise<Json> => {
    const h = harness(
      () =>
        action === "streamGenerateContent"
          ? sseResponse([`data: ${JSON.stringify(GEMINI_RESPONSE)}\n\n`])
          : jsonResponse(GEMINI_RESPONSE),
      cred,
    );

    const response = await h.call(
      `/v1beta/models/gemini-2.5-pro:${action}`,
      postJson({ contents }),
    );

    await response.text();
    await h.dispose();

    return JSON.parse(h.calls[0]?.body ?? "{}").contents;
  };

  describe.each([
    ["provider key", apiKey],
    ["service account", serviceAccount],
  ])("%s", (_name, cred) => {
    it.each(["generateContent", "streamGenerateContent"])(
      "%s drops the trailing thought-only turns",
      async (action) => {
        expect(await sentContents(cred, action, [hi, thought, signedThought])).toEqual([hi]);
      },
    );

    it.each(["generateContent", "streamGenerateContent"])(
      "%s keeps reasoning that precedes a user turn",
      async (action) => {
        const again = { role: "user", parts: [{ text: "again" }] };

        expect(await sentContents(cred, action, [hi, thought, again])).toEqual([
          hi,
          thought,
          again,
        ]);
      },
    );

    it("leaves a countTokens request as sent", async () => {
      expect(await sentContents(cred, "countTokens", [hi, thought])).toEqual([hi, thought]);
    });
  });

  it("applies payload rules after the drop, so configured contents are sent as configured", async () => {
    const configured = [hi, thought];

    const withRule = await loadConfig(`
requests:
  payload:
    override:
      - models: [{ name: "gemini-2.5-pro", protocol: gemini }]
        params:
          contents: ${JSON.stringify(configured)}
`);

    const h = makeGeminiHarness({
      config: withRule,
      respond: () => jsonResponse(GEMINI_RESPONSE),
      credential: apiKey,
      models,
    });

    afterAll(h.dispose);
    await h.call(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      postJson({ contents: [hi, thought] }),
    );
    expect(JSON.parse(h.calls[0]?.body ?? "{}").contents).toEqual(configured);
  });
});

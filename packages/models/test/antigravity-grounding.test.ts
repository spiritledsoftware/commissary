// Antigravity web-search grounding: Vertex Search redirect URLs are resolved with HEAD (no redirect follow) before the
// response is translated (Go helps/antigravity_grounding_urls_test.go plus the executor wiring).
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  isVertexSearchRedirect,
  resolveGroundingUrl,
  resolveGroundingUrlsInPayload,
  shouldResolveGroundingUrls,
} from "../src/executor/antigravity/grounding.ts";
import { resetMemoryAntigravityState } from "../src/executor/antigravity/state.ts";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
import {
  jsonResponse,
  loadConfig,
  mockHttpClient,
  postJson,
  sseResponse,
  type UpstreamCall,
} from "./support/pipeline.ts";

const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example-token";

const TARGET = "https://example.com/weather";

const redirecting =
  (location: string | undefined, status = 302) =>
  (call: UpstreamCall) => {
    expect(call.method).toBe("HEAD");

    return new Response(null, {
      status,
      ...(location === undefined ? {} : { headers: { location } }),
    });
  };

const run = <A>(
  effect: Effect.Effect<A, never, import("effect/http").HttpClient.HttpClient>,
  calls: UpstreamCall[],
  respond: (call: UpstreamCall) => Response,
) => Effect.runPromise(effect.pipe(Effect.provide(mockHttpClient(calls, respond))));

const payload = (uris: string[]) =>
  JSON.stringify({
    response: {
      candidates: [
        {
          groundingMetadata: { groundingChunks: uris.map((uri) => ({ web: { uri, title: "T" } })) },
        },
      ],
    },
  });

describe("grounding URL resolution", () => {
  it("recognises only https Vertex Search redirect URLs", () => {
    expect(isVertexSearchRedirect(REDIRECT)).toBe(true);
    expect(
      isVertexSearchRedirect("http://vertexaisearch.cloud.google.com/grounding-api-redirect/x"),
    ).toBe(false);
    expect(isVertexSearchRedirect("https://vertexaisearch.cloud.google.com/other/x")).toBe(false);
    expect(isVertexSearchRedirect("https://example.com/grounding-api-redirect/x")).toBe(false);
    expect(isVertexSearchRedirect("not a url")).toBe(false);
  });

  it("replaces redirect URIs with their Location and leaves other chunks alone (HEAD, deduplicated)", async () => {
    const calls: UpstreamCall[] = [];

    const out = await run(
      resolveGroundingUrlsInPayload(
        payload([REDIRECT, "https://already.example/source", REDIRECT]),
      ),
      calls,
      redirecting(TARGET),
    );

    expect(calls.map((call) => [call.method, call.url])).toEqual([["HEAD", REDIRECT]]);

    const uris = JSON.parse(out).response.candidates[0].groundingMetadata.groundingChunks.map(
      (chunk: { web: { uri: string } }) => chunk.web.uri,
    );

    expect(uris).toEqual([TARGET, "https://already.example/source", TARGET]);
  });

  it("reads bare candidates payloads and returns the text untouched without redirects", async () => {
    const calls: UpstreamCall[] = [];

    const bare = JSON.stringify({
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: REDIRECT } }] } }],
    });

    const out = await run(resolveGroundingUrlsInPayload(bare), calls, redirecting(TARGET));
    expect(JSON.parse(out).candidates[0].groundingMetadata.groundingChunks[0].web.uri).toBe(TARGET);
    const plain = payload(["https://a.example/x"]);
    expect(await run(resolveGroundingUrlsInPayload(plain), calls, redirecting(TARGET))).toBe(plain);
    expect(calls).toHaveLength(1);
  });

  it("keeps the original URL on non-3xx answers, missing or non-https locations and transport failures", async () => {
    for (const respond of [
      redirecting(TARGET, 200),
      redirecting(TARGET, 404),
      redirecting(undefined),
      redirecting("http://example.com/plain"),
      redirecting("/relative"),
      () => {
        throw new Error("network down");
      },
    ]) {
      expect(await run(resolveGroundingUrl(REDIRECT), [], respond)).toBe(REDIRECT);
    }
  });

  it("only resolves for typed web search requests that were translated to googleSearch", () => {
    const translated = { request: { tools: [{ googleSearch: {} }] } };
    const claude = { tools: [{ type: "web_search_20250305", name: "web_search" }] };
    const responses = { tools: [{ type: "web_search_preview" }] };
    expect(shouldResolveGroundingUrls("claude", claude, translated)).toBe(true);
    expect(shouldResolveGroundingUrls("openai-response", responses, translated)).toBe(true);
    expect(shouldResolveGroundingUrls("claude", responses, translated)).toBe(false);
    expect(shouldResolveGroundingUrls("openai-response", claude, translated)).toBe(false);
    expect(shouldResolveGroundingUrls("openai", responses, translated)).toBe(false);
    expect(shouldResolveGroundingUrls("claude", claude, { request: { tools: [] } })).toBe(false);
  });
});

describe("grounding URL resolution in the Antigravity executor", () => {
  const cred = credential("antigravity", "antigravity-grounding.json", {
    kind: "oauth",
    metadata: { access_token: "t", project_id: "p" },
  });

  const grounded = {
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Sunny" }] },
          finishReason: "STOP",
          groundingMetadata: {
            webSearchQueries: ["weather"],
            groundingChunks: [{ web: { uri: REDIRECT, title: "Weather" } }],
            groundingSupports: [
              {
                segment: { startIndex: 0, endIndex: 5, text: "Sunny" },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
  };

  const search = {
    model: "gemini-3-flash",
    tools: [{ type: "web_search" }],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] }],
  };

  const harness = async (stream: boolean) => {
    resetMemoryAntigravityState();

    const h = makeGeminiHarness({
      config: await loadConfig(""),
      credential: cred,
      models: { "gemini-3-flash": ["antigravity"] },
      respond: (call) => {
        if (call.method === "HEAD")
          return new Response(null, { status: 302, headers: { location: TARGET } });

        return stream
          ? sseResponse([`data: ${JSON.stringify(grounded)}\n\n`])
          : jsonResponse(grounded);
      },
    });

    afterAll(h.dispose);

    return h;
  };

  it("resolves the redirect of a non-stream Responses web search answer", async () => {
    const h = await harness(false);
    const response = await h.call("/v1/responses", postJson(search));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(TARGET);
    expect(text).not.toContain("vertexaisearch");
    expect(h.calls.map((call) => call.method)).toEqual(["POST", "HEAD"]);
    expect(JSON.parse(h.calls[0]?.body ?? "{}").request.tools[0].googleSearch).toBeDefined();
  });

  it("resolves the redirect inside a streamed answer", async () => {
    const h = await harness(true);
    const response = await h.call("/v1/responses", postJson({ ...search, stream: true }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(TARGET);
    expect(text).not.toContain("vertexaisearch");
    expect(h.calls.filter((call) => call.method === "HEAD")).toHaveLength(1);
  });

  it("does not resolve for requests without typed web search tools", async () => {
    const h = await harness(false);

    const response = await h.call(
      "/v1/responses",
      postJson({ model: "gemini-3-flash", input: "hi" }),
    );

    expect(response.status).toBe(200);
    expect(h.calls.every((call) => call.method === "POST")).toBe(true);
  });
});

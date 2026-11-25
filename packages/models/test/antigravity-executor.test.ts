// End-to-end tests (workerd) of the Antigravity executor: Access gate -> routes -> conductor -> executor -> mocked
// Cloud Code upstream. Covers the envelope, header whitelist, stream aggregation, 429 handling and token counting.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Config } from "../src/config/schema.ts";
import { resetMemoryAntigravityState } from "../src/executor/antigravity/state.ts";
import {
  antigravitySignatureScope,
  scopedSignatureText,
} from "../src/executor/antigravity/signature-scope.ts";
import { orgSignatureCache } from "../src/signature/store.ts";
import { env } from "cloudflare:workers";
import {
  antigravityCatalogScope,
  antigravityModelsName,
  type ModelsRecord,
} from "../src/executor/antigravity/models.ts";
import { orgKvOf } from "../src/kv.ts";
import { GLOBAL_ORG } from "@commissary/core";
import type { Json, JsonObject } from "@commissary/json";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
import {
  nativeGeminiSignature,
  signedToolRound,
  vertexBareTink,
} from "./support/gemini-signatures.ts";
import {
  jsonResponse,
  loadConfig,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";

const YAML = `
oauth:
  providers:
    antigravity:
      sensitive-words: ["secret"]
requests:
  payload:
    override:
      - models: [{ name: "gemini-2.5-flash", protocol: antigravity }]
        params:
          "generationConfig.topK": 7
`;

let config: Config;

beforeAll(async () => {
  config = await loadConfig(YAML);
});

const cred = credential("antigravity", "antigravity-dev@example.com.json", {
  kind: "oauth",
  attributes: { "header:X-Extra": "yes" },
  metadata: { access_token: "ya29.token", project_id: "proj-1", email: "dev@example.com" },
});

const unique = (name: string) =>
  credential("antigravity", `antigravity-${name}-${crypto.randomUUID()}.json`, {
    kind: "oauth",
    metadata: { access_token: "ya29.token", project_id: "proj-1" },
  });

const models = {
  "claude-sonnet-4-5": ["antigravity"],
  "claude-opus-5-5": ["antigravity"],
  "claude-sonnet-5-5": ["antigravity"],
  "gemini-2.5-flash": ["antigravity"],
  "gemini-3-pro-high": ["antigravity"],
};

const harness = (
  respond: UpstreamResponder,
  overrides: { config?: Config; credential?: typeof cred } = {},
) =>
  makeGeminiHarness({
    config: overrides.config ?? config,
    respond,
    credential: overrides.credential ?? cred,
    models,
  });

const upstream = (parts: Json[], extra: JsonObject = {}) => ({
  response: {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 3,
      thoughtsTokenCount: 1,
      totalTokenCount: 14,
    },
    modelVersion: "gemini-2.5-flash",
    responseId: "r1",
    ...extra,
  },
  traceId: "t1",
});

const sse = (events: Json[]) =>
  sseResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`));

const streamChat = (model = "gemini-2.5-flash"): JsonObject => ({
  model,
  stream: true,
  messages: [{ role: "user", content: "hi" }],
});

const chat = (model = "gemini-2.5-flash"): JsonObject => ({
  model,
  messages: [{ role: "user", content: "hi" }],
});

describe("antigravity executor: non-stream", () => {
  it("wraps the request in the Cloud Code envelope with the whitelisted headers and applies payload rules last", async () => {
    resetMemoryAntigravityState();
    const h = harness(() => jsonResponse(upstream([{ text: "Hello" }])));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({
        model: "gemini-2.5-flash",
        max_tokens: 50,
        messages: [
          { role: "system", content: "keep the secret safe" },
          { role: "user", content: "hi" },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("Hello");

    const call = h.calls[0];
    expect(call?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(call?.headers["authorization"]).toBe("Bearer ya29.token");
    expect(call?.headers["user-agent"]).toBe(
      "antigravity/hub/2.29.0 (aidev_client; os_type=darwin; arch=arm64; cl=1013060670)",
    );
    expect(call?.headers["x-extra"]).toBe("yes");
    expect(call?.headers["accept"]).toBeUndefined();
    expect(call?.headers["x-goog-api-client"]).toBeUndefined();

    const sent = JSON.parse(call?.body ?? "{}");
    expect(sent.project).toBe("proj-1");
    expect(sent.model).toBe("gemini-2.5-flash");
    expect(sent.userAgent).toBe("antigravity");
    expect(sent.requestType).toBe("agent");
    // The agent envelope (CLIProxyAPI b8e3bc66): agent/<cascade>/<millis>/<trajectory>/<step>, signed int64 session.
    expect(sent.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/1$/);
    expect(sent.request.sessionId).toMatch(/^-?\d+$/);
    expect(sent.request.labels.used_non_gemini_model).toBe("false");
    expect(sent.request.systemInstruction.role).toBe("user");
    // The native key order of an agent request.
    expect(Object.keys(sent)).toEqual([
      "project",
      "requestId",
      "request",
      "model",
      "userAgent",
      "requestType",
    ]);
    expect(sent.request.safetySettings).toBeUndefined();
    // Non-Claude models lose maxOutputTokens; the payload rule (root `request`) still lands afterwards.
    expect(sent.request.generationConfig.maxOutputTokens).toBeUndefined();
    expect(sent.request.generationConfig.topK).toBe(7);
    // Sensitive words of the system instruction are obfuscated with a combining grapheme joiner (U+034F).
    expect(sent.request.systemInstruction.parts[0].text).toBe("keep the s\u034Fecret safe");
    expect(h.records[0]?.detail).toMatchObject({
      inputTokens: 10,
      outputTokens: 3,
      reasoningTokens: 1,
      totalTokens: 14,
    });
  });

  it("discovers a missing project id through loadCodeAssist and uses it for the request", async () => {
    const h = harness(
      (call) =>
        call.url.endsWith(":loadCodeAssist")
          ? jsonResponse({ cloudaicompanionProject: { id: "found-proj" } })
          : jsonResponse(upstream([{ text: "x" }])),
      {
        credential: credential("antigravity", "ag-2", {
          kind: "oauth",
          metadata: { access_token: "t" },
        }),
      },
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
    );

    expect(response.status).toBe(200);
    expect(h.calls[0]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    );
    expect(JSON.parse(h.calls[1]?.body ?? "{}").project).toBe("found-proj");
  });

  it("answers 400 when the project id cannot be discovered", async () => {
    const h = harness(() => new Response("nope", { status: 500 }), {
      credential: credential("antigravity", "ag-3", {
        kind: "oauth",
        metadata: { access_token: "t" },
      }),
    });

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("antigravity auth missing project_id");
    expect(h.calls).toHaveLength(1);
  });

  it("streams Claude models upstream and merges the SSE for non-stream callers", async () => {
    resetMemoryAntigravityState();

    const h = harness(() =>
      sse([
        upstream([{ text: "think", thought: true }], { usageMetadata: { promptTokenCount: 5 } }),
        upstream([{ text: "Hi " }]),
        upstream([{ text: "there" }]),
      ]),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/messages",
      postJson({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        tools: [{ name: "t", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(response.status).toBe(200);

    const message = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
    };

    expect(message.content.find((block) => block.type === "text")?.text).toBe("Hi there");
    expect(message.stop_reason).toBe("end_turn");

    const call = h.calls[0];
    expect(call?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    const sent = JSON.parse(call?.body ?? "{}");
    expect(sent.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
    // Claude keeps maxOutputTokens (the registry limit is the cap) and receives no synthetic boundary turns.
    expect(sent.request.generationConfig.maxOutputTokens).toBe(100);
    expect(sent.request.tools[0].functionDeclarations[0].parameters).toBeDefined();
    expect(sent.request.tools[0].functionDeclarations[0].parametersJsonSchema).toBeUndefined();
  });
});

// CLIProxyAPI 1d45a5f3: Claude 5.5 rejects the forced tool use behind native structured output, so the schema is sent
// as a system prompt and forced function calling is downgraded to AUTO.
const ruleYaml = (kind: "override" | "filter", params: string): string => `
oauth:
  providers:
    antigravity:
      sensitive-words: ["secret"]
requests:
  payload:
    ${kind}:
      - models: [{ name: "claude-*", protocol: antigravity }]
        params:${params}
`;

describe("antigravity executor: Claude 5.5 structured output", () => {
  const schema = {
    type: "object",
    properties: { title: { type: "string" }, description: { type: "string" } },
    required: ["title", "description"],
    additionalProperties: false,
  };

  const tool = {
    type: "function",
    function: {
      name: "get_time",
      description: "Get the current time.",
      parameters: {
        type: "object",
        properties: { timezone: { type: "string" } },
        required: ["timezone"],
      },
    },
  };

  const chat = (model: string): JsonObject => ({
    model,
    messages: [
      { role: "system", content: "keep the secret safe" },
      { role: "user", content: "Provide title and description for: fix bug" },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "codex_output_schema", strict: true, schema },
    },
    tools: [tool],
    tool_choice: "required",
  });

  it.each(["claude-opus-5-5", "claude-sonnet-5-5"])(
    "sends the schema of %s as prompt text, keeps the tools and no forced mode",
    async (model) => {
      resetMemoryAntigravityState();
      const h = harness(() => sse([upstream([{ text: "{}" }])]));
      afterAll(h.dispose);

      const response = await h.call("/v1/chat/completions", postJson(chat(model)));
      expect(response.status).toBe(200);

      const sent = JSON.parse(h.calls[0]?.body ?? "{}");
      const parts = sent.request.systemInstruction.parts as Array<{ text: string }>;
      // The original system text (obfuscated) stays first; the schema instruction follows, complete. The native wire
      // format joins the parts into one (`NormalizeAntigravityRequestDoc`, CLIProxyAPI 38067a29).
      expect(parts).toHaveLength(1);
      expect(parts[0]?.text.startsWith("keep the s\u034Fecret safe\n\n")).toBe(true);
      expect(parts[0]?.text).toContain(JSON.stringify(schema));
      expect(sent.request.generationConfig.responseSchema).toBeUndefined();
      expect(sent.request.generationConfig.responseJsonSchema).toBeUndefined();
      expect(sent.request.generationConfig.responseMimeType).toBeUndefined();
      expect(sent.request.tools[0].functionDeclarations[0].name).toBe("get_time");
      expect(sent.request.toolConfig.functionCallingConfig.mode).toBe("AUTO");
    },
  );

  it("keeps the native schema and VALIDATED for other Claude models", async () => {
    resetMemoryAntigravityState();
    const h = harness(() => sse([upstream([{ text: "{}" }])]));
    afterAll(h.dispose);

    const response = await h.call("/v1/chat/completions", postJson(chat("claude-sonnet-4-5")));
    expect(response.status).toBe(200);
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
    const generation = sent.request.generationConfig;
    expect(generation.responseSchema ?? generation.responseJsonSchema).toBeDefined();
  });

  // Payload rules stay the final mutation: the built-in conversion neither undoes them nor survives them.
  const longChat = (): JsonObject => ({
    ...chat("claude-opus-5-5"),
    messages: [
      { role: "system", content: "keep the secret safe" },
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ],
  });

  it("lets an override rule set the system instruction, tool mode and MIME type after the conversion", async () => {
    const ruled = await loadConfig(
      ruleYaml(
        "override",
        `
          systemInstruction:
            parts: [{ text: "configured system" }]
          toolConfig.functionCallingConfig.mode: NONE
          generationConfig.responseMimeType: configured/mime`,
      ),
    );

    const h = harness(() => sse([upstream([{ text: "{}" }])]), { config: ruled });
    afterAll(h.dispose);

    expect((await h.call("/v1/chat/completions", postJson(longChat()))).status).toBe(200);
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.request.systemInstruction.parts).toEqual([{ text: "configured system" }]);
    expect(sent.request.toolConfig.functionCallingConfig.mode).toBe("NONE");
    expect(sent.request.generationConfig.responseMimeType).toBe("configured/mime");
  });

  it("lets a filter rule remove what the conversion built, once", async () => {
    const ruled = await loadConfig(
      ruleYaml(
        "filter",
        `
          - systemInstruction
          - toolConfig
          - contents.0`,
      ),
    );

    const h = harness(() => sse([upstream([{ text: "{}" }])]), { config: ruled });
    afterAll(h.dispose);

    expect((await h.call("/v1/chat/completions", postJson(longChat()))).status).toBe(200);
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.request.systemInstruction).toBeUndefined();
    expect(sent.request.toolConfig).toBeUndefined();
    // Four turns with the system one, the first content filtered out: applied once, not again after the conversion.
    expect(sent.request.contents).toHaveLength(2);
  });

  it("counts the schema as prompt text", async () => {
    const h = harness(() => jsonResponse({ totalTokens: 42 }));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/claude-opus-5-5:countTokens",
      postJson({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema },
      }),
    );

    expect(response.status).toBe(200);
    const call = h.calls[0];
    expect(call?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:countTokens");
    const sent = JSON.parse(call?.body ?? "{}");
    const parts = sent.request.systemInstruction.parts as Array<{ text: string }>;
    expect(parts.map((part) => part.text).join("\n")).toContain(JSON.stringify(schema));
    expect(sent.request.generationConfig?.responseSchema).toBeUndefined();
    expect(sent.request.generationConfig?.responseMimeType).toBeUndefined();
  });
});

describe("antigravity executor: Interactions clients", () => {
  it("serves /v1beta/interactions through the Interactions -> Antigravity translators", async () => {
    const h = harness(() => jsonResponse(upstream([{ text: "Hello" }])));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/interactions",
      postJson({ model: "gemini-3-pro-high", input: "hi", system_instruction: "be brief" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; steps: Array<{ type: string }> };
    expect(body.object).toBe("interaction");
    expect(body.steps[0]?.type).toBe("model_output");
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.request.contents[0].parts[0].text).toBe("hi");
    expect(sent.request.systemInstruction.parts[0].text).toBe("be brief");
  });
});

describe("antigravity executor: stream", () => {
  it("translates SSE lines, renames non-terminal usage and synthesises the terminal event", async () => {
    resetMemoryAntigravityState();

    const h = harness(() =>
      sse([
        upstream([{ text: "Hel" }], {
          candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }],
        }),
        upstream([{ text: "lo" }]),
      ]),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({
        model: "gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("[DONE]");
    expect(h.calls[0]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    expect(JSON.parse(h.calls[0]?.body ?? "{}").request.stream).toBeUndefined();
  });

  it("reports an in-stream error object with its status", async () => {
    const h = harness(() =>
      sse([{ error: { code: 429, message: "slow down", status: "RESOURCE_EXHAUSTED" } }]),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({
        model: "gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(response.status).toBe(429);
  });

  it("fails a successful stream without a single JSON frame with a zero-output 502 (CLIProxyAPI 20be744e)", async () => {
    const h = harness(() => sseResponse([": keep-alive\n\n"]), {
      credential: unique("empty-stream"),
    });

    afterAll(h.dispose);

    const response = await h.call("/v1/chat/completions", postJson(streamChat()));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("upstream stream closed with zero output");
  });

  it("fails a signature-only stream without a finish reason before the 200 (CLIProxyAPI f2efe2c4)", async () => {
    const h = harness(
      () =>
        sse([
          {
            response: {
              candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "c2ln" }] } }],
              usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
            },
          },
        ]),
      { credential: unique("signature-only") },
    );

    afterAll(h.dispose);

    const response = await h.call("/v1/chat/completions", postJson(streamChat()));
    expect(response.status).toBe(502);
  });

  it("fails an abnormal zero-output finish inside the response envelope before the 200", async () => {
    const h = harness(
      () =>
        sse([
          {
            response: {
              candidates: [
                { content: { role: "model", parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" },
              ],
              usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
            },
          },
        ]),
      { credential: unique("malformed") },
    );

    afterAll(h.dispose);

    const response = await h.call("/v1/chat/completions", postJson(streamChat()));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("MALFORMED_FUNCTION_CALL");
  });
});

describe("antigravity executor: errors", () => {
  const rateLimit = (delay: string) => ({
    error: {
      code: 429,
      message: "Resource exhausted",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "RATE_LIMIT_EXCEEDED",
          domain: "x",
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay },
      ],
    },
  });

  it("records a short cooldown for a rate limit under five minutes and answers the next call without upstream", async () => {
    resetMemoryAntigravityState();

    // KV state outlives a test: a unique credential id keeps the cooldown of this test to itself.
    const h = harness(() => jsonResponse(rateLimit("30.000s"), { status: 429 }), {
      credential: unique("cooldown"),
    });

    afterAll(h.dispose);

    const payload = postJson({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });

    const first = await h.call("/v1/chat/completions", payload);
    expect(first.status).toBe(429);
    const upstreamCalls = h.calls.length;
    expect(upstreamCalls).toBeGreaterThan(0);
    const second = await h.call("/v1/chat/completions", payload);
    expect(second.status).toBe(429);
    expect(await second.text()).toContain("auth in short cooldown");
    expect(h.calls).toHaveLength(upstreamCalls);
    // The failure carries the upstream retry delay for the credential cooldown bookkeeping.
    expect(h.reports.some((report) => report.retryAfterMs === 30_000)).toBe(true);
  });

  it("passes other upstream errors through verbatim", async () => {
    resetMemoryAntigravityState();

    const h = harness(
      () => jsonResponse({ error: { code: 400, message: "bad" } }, { status: 400 }),
      {
        credential: unique("passthrough"),
      },
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("bad");
  });

  it("fails an in-band error of an HTTP 200 body with its status and records the cooldown (CLIProxyAPI ec25cc83)", async () => {
    resetMemoryAntigravityState();
    const h = harness(() => jsonResponse(rateLimit("30.000s")), { credential: unique("in-band") });
    afterAll(h.dispose);

    const first = await h.call("/v1/chat/completions", postJson(chat()));
    expect(first.status).toBe(429);
    const upstreamCalls = h.calls.length;
    const second = await h.call("/v1/chat/completions", postJson(chat()));
    expect(await second.text()).toContain("auth in short cooldown");
    expect(h.calls).toHaveLength(upstreamCalls);
  });

  it("fails an aggregated stream without a JSON frame with a zero-output 502 (CLIProxyAPI d1bdee85)", async () => {
    const h = harness(() => sseResponse(["\n\n"]), { credential: unique("empty-aggregate") });
    afterAll(h.dispose);

    const response = await h.call("/v1/chat/completions", postJson(chat("claude-sonnet-4-5")));
    expect(response.status).toBe(502);
  });

  it("falls back on the Retry-After header of a 429 without a body delay (CLIProxyAPI 84b838e1)", async () => {
    resetMemoryAntigravityState();
    const limit = rateLimit("1s");
    const details = limit.error.details.slice(0, 1);

    const h = harness(
      () =>
        jsonResponse(
          { error: { ...limit.error, details } },
          { status: 429, headers: { "content-type": "application/json", "retry-after": "45" } },
        ),
      { credential: unique("retry-after") },
    );

    afterAll(h.dispose);

    const first = await h.call("/v1/chat/completions", postJson(chat()));
    expect(first.status).toBe(429);
    expect(h.reports.some((report) => report.retryAfterMs === 45_000)).toBe(true);
    const second = await h.call("/v1/chat/completions", postJson(chat()));
    expect(await second.text()).toContain("auth in short cooldown");
  });

  it("carries the retry hint of a 503 capacity error (CLIProxyAPI ae3d80f7)", async () => {
    const h = harness(
      () =>
        jsonResponse(
          { error: { code: 503, message: "No capacity available", status: "UNAVAILABLE" } },
          { status: 503, headers: { "content-type": "application/json", "retry-after": "7" } },
        ),
      { credential: unique("capacity") },
    );

    afterAll(h.dispose);

    const response = await h.call("/v1/chat/completions", postJson(chat()));
    expect(response.status).toBe(503);
    expect(h.reports.some((report) => report.retryAfterMs === 7_000)).toBe(true);
  });
});

describe("antigravity executor: token counting", () => {
  it("posts the bare request to countTokens and renders the Claude input_tokens", async () => {
    const h = harness(() => jsonResponse({ totalTokens: 42 }));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/messages/count_tokens",
      postJson({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 42 });
    const call = h.calls[0];
    expect(call?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:countTokens");
    const sent = JSON.parse(call?.body ?? "{}");
    expect(Object.keys(sent)).toEqual(["request"]);
    expect(sent.request.safetySettings).toBeUndefined();
    expect(sent.request.sessionId).toBeUndefined();
    expect(sent.request.contents[0].parts[0].text).toBe("hello");
    // The tokenizer model (CLIProxyAPI fb989e5f); a stream flag never reaches countTokens.
    expect(sent.request.model).toBe("models/claude-sonnet-4-5");
    expect(sent.request.stream).toBeUndefined();
  });

  const count = (respond: UpstreamResponder, name: string) => {
    const h = harness(respond, { credential: unique(name) });
    afterAll(h.dispose);

    return h
      .call(
        "/v1/messages/count_tokens",
        postJson({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] }),
      )
      .then(async (response) => ({ status: response.status, text: await response.text(), h }));
  };

  it("rejects an HTTP 200 that is not a count (CLIProxyAPI 9bce4825)", async () => {
    const notJson = await count(() => jsonResponse("<html>oops</html>"), "count-html");
    expect(notJson.status).toBe(502);
    expect(notJson.text).toContain("not a valid JSON object");
    const missing = await count(() => jsonResponse({ total: 3 }), "count-missing");
    expect(missing.status).toBe(502);
    expect(missing.text).toContain("missing numeric totalTokens");
    const negative = await count(() => jsonResponse({ totalTokens: -1 }), "count-negative");
    expect(negative.text).toContain("invalid totalTokens");
  });

  // Go `strconv.ParseUint(totalTokens.Raw, 10, 63)`: the count as written must be plain digits.
  it("rejects a count written as a fraction or an exponent (CLIProxyAPI 9bce4825)", async () => {
    for (const [written, name] of [
      ["1.0", "count-fraction"],
      ["1e3", "count-exponent"],
    ] as const) {
      const result = await count(
        () =>
          new Response(`{"totalTokens":${written}}`, {
            headers: { "content-type": "application/json" },
          }),
        name,
      );

      expect(result.status).toBe(502);
      expect(result.text).toContain("invalid totalTokens");
    }

    // A nested `totalTokens` is not the count.
    const nested = await count(
      () =>
        new Response('{"meta":{"totalTokens":1.5},"totalTokens":7}', {
          headers: { "content-type": "application/json" },
        }),
      "count-nested",
    );

    expect(nested.status).toBe(200);
  });

  it("reads the first of duplicate totalTokens members, as Go does", async () => {
    const raw = (body: string) => () =>
      new Response(body, { headers: { "content-type": "application/json" } });

    const first = await count(
      raw('{"a":{"totalTokens":"x","b":[1,{"c":"}"}]},"totalTokens":5,"totalTokens":"x"}'),
      "count-duplicate-first",
    );

    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toEqual({ input_tokens: 5 });

    const later = await count(raw('{"totalTokens":"x","totalTokens":5}'), "count-duplicate-later");
    expect(later.status).toBe(502);
    expect(later.text).toContain("missing numeric totalTokens");

    const fraction = await count(
      raw('{"totalTokens":1.5,"totalTokens":5}'),
      "count-duplicate-fraction",
    );

    expect(fraction.status).toBe(502);
    expect(fraction.text).toContain("invalid totalTokens");
  });

  it("limits the body by its UTF-8 bytes, not its characters", async () => {
    // 400,000 three-byte characters: 1.2 MB, under a million characters.
    const padding = "€".repeat(400_000);
    const result = await count(() => jsonResponse({ totalTokens: 3, padding }), "count-utf8");

    expect(result.status).toBe(502);
    expect(result.text).toContain("exceeded 1048576 bytes");
  });

  it("answers an in-band error with its status (CLIProxyAPI 4087007c)", async () => {
    const result = await count(
      () => jsonResponse({ error: { code: 400, message: "bad request" } }),
      "count-in-band",
    );

    expect(result.status).toBe(400);
    expect(result.text).toContain("bad request");
  });
});

describe("antigravity executor: Responses compaction summary", () => {
  const trigger = (extra: JsonObject = {}): JsonObject => ({
    model: "gemini-2.5-flash",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
      { type: "compaction_trigger" },
    ],
    ...extra,
  });

  it("keeps the summary's cached and reasoning tokens in the compaction response (CLIProxyAPI dc2455d9)", async () => {
    const h = harness(
      () =>
        jsonResponse(
          upstream([{ text: "the summary" }], {
            usageMetadata: {
              promptTokenCount: 10,
              cachedContentTokenCount: 4,
              candidatesTokenCount: 3,
              thoughtsTokenCount: 2,
              totalTokenCount: 15,
            },
          }),
        ),
      { credential: unique("compaction-usage") },
    );

    afterAll(h.dispose);

    const response = await h.call("/v1/responses", postJson(trigger()));
    expect(response.status).toBe(200);

    const { usage } = (await response.json()) as {
      usage: {
        input_tokens_details: { cached_tokens: number };
        output_tokens_details: { reasoning_tokens: number };
      };
    };

    expect(usage.input_tokens_details.cached_tokens).toBe(4);
    expect(usage.output_tokens_details.reasoning_tokens).toBe(2);
  });

  it("answers a summary without text with a request-scoped 502, not a 500", async () => {
    const h = harness(() => jsonResponse(upstream([{ thought: true, text: "thinking" }])));
    afterAll(h.dispose);

    const response = await h.call("/v1/responses", postJson(trigger()));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("no summary text");
    expect(h.reports.at(-1)).toMatchObject({
      success: false,
      httpStatus: 502,
      error: { code: "request_scoped" },
    });
  });

  it("answers a summary cut off by the output budget with a 502", async () => {
    const h = harness(() =>
      jsonResponse(
        upstream([{ text: "half a summ" }], {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "half a summ" }] },
              finishReason: "MAX_TOKENS",
              index: 0,
            },
          ],
        }),
      ),
    );

    afterAll(h.dispose);
    const response = await h.call("/v1/responses", postJson(trigger()));
    expect(response.status).toBe(502);
  });

  it("does not send the client's text.format with the summary request", async () => {
    const h = harness(() => jsonResponse(upstream([{ text: "the summary" }])));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/responses",
      postJson(
        trigger({
          text: { format: { type: "json_schema", name: "plan", schema: { type: "object" } } },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(h.calls[0]?.body).not.toContain("responseSchema");
    expect(h.calls[0]?.body).not.toContain("application/json");
  });
});

// CLIProxyAPI a2718314 (antigravity_executor_trailing_reasoning_test.go, #6530) and 15d2148b
// (antigravity_executor_signature_test.go, #6524): the Cloud Code upstream rejects a request that ends with a thought-only
// model turn, or with a model-role functionResponse turn that carries nested media.
describe("antigravity executor: trailing turns", () => {
  const userItem = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Say OK." }],
  };

  const ok = upstream([{ text: "OK" }]);

  const sentContents = async (input: Json[], stream: boolean, model = "gemini-2.5-flash") => {
    resetMemoryAntigravityState();
    const h = harness(() => (stream ? sse([ok]) : jsonResponse(ok)));
    const response = await h.call("/v1/responses", postJson({ model, stream, input }));

    expect(response.status).toBe(200);
    await response.text();
    await h.dispose();

    return JSON.parse(h.calls[0]?.body ?? "{}").request.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
  };

  const reasoning = {
    type: "reasoning",
    id: "rs_repro_0",
    summary: [{ type: "summary_text", text: "thinking" }],
  };

  const toolRound = [
    { type: "function_call", call_id: "call_1", name: "run", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "done" },
  ];

  it.each([true, false])("drops a trailing reasoning turn (stream: %s)", async (stream) => {
    const contents = await sentContents([userItem, reasoning], stream);

    expect(JSON.stringify(contents)).not.toContain('"thought":true');
    expect(contents.at(-1)?.role).toBe("user");
  });

  it("drops a trailing reasoning turn after tool output and keeps the function response last", async () => {
    const contents = await sentContents([userItem, ...toolRound, reasoning], true);

    expect(JSON.stringify(contents)).not.toContain('"thought":true');
    expect(contents.at(-1)?.parts[0]).toHaveProperty("functionResponse");
  });

  it("appends an empty user turn after a function response with an image", async () => {
    const contents = await sentContents(
      [
        userItem,
        toolRound[0] as Json,
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            {
              type: "input_image",
              image_url:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            },
          ],
        },
      ],
      true,
    );

    expect(contents.at(-1)).toEqual({ role: "user", parts: [{ text: "" }] });
    expect(contents.at(-2)?.parts[0]).toHaveProperty("functionResponse.parts.0.inlineData");
  });

  it("keeps a text function response last", async () => {
    const contents = await sentContents([userItem, ...toolRound], true);

    expect(contents.at(-1)?.parts[0]).toHaveProperty("functionResponse");
  });
});

// CLIProxyAPI 1398f273 (antigravity_executor_signature_test.go): Cloud Code answers 400 "Corrupted thought signature"
// to a Vertex bare-Tink signature, so history issued by Vertex gets the bypass sentinel there.
describe("antigravity executor: Vertex bare-Tink thought signatures", () => {
  const sentParts = async (signature: string) => {
    resetMemoryAntigravityState();
    const h = harness(() => jsonResponse(upstream([{ text: "OK" }])));

    const response = await h.call(
      "/v1beta/models/gemini-3-pro-high:generateContent",
      postJson({ contents: signedToolRound(signature) }),
    );

    expect(response.status).toBe(200);
    await response.text();
    await h.dispose();

    return JSON.parse(h.calls[0]?.body ?? "{}").request.contents[1].parts as Array<
      Record<string, unknown>
    >;
  };

  it("sends the bypass sentinel for the first functionCall and drops the text part's signature", async () => {
    const parts = await sentParts(vertexBareTink());

    expect(parts[0]?.["thoughtSignature"]).toBeUndefined();
    expect(parts[1]?.["thoughtSignature"]).toBe("skip_thought_signature_validator");
  });

  it("keeps a native Gemini signature", async () => {
    const native = nativeGeminiSignature();
    const parts = await sentParts(native);

    expect(parts[0]?.["thoughtSignature"]).toBe(native);
    expect(parts[1]?.["thoughtSignature"]).toBe(native);
  });
});

// CLIProxyAPI 85225381, 06225fcf: a thinking signature belongs to the credential whose upstream issued it.
describe("antigravity executor: signature cache per credential", () => {
  it("records a returned signature under the credential's scope, never the org-wide key", async () => {
    resetMemoryAntigravityState();
    const signature = `sig-${"a".repeat(60)}`;
    const thinking = `plan-${crypto.randomUUID()}`;
    const owner = unique("signature-owner");

    const h = harness(
      () =>
        sse([
          upstream([{ text: thinking, thought: true, thoughtSignature: signature }]),
          upstream([{ text: "done" }]),
        ]),
      { credential: owner },
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/messages",
      postJson({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(response.status).toBe(200);
    await response.text();

    const cache = orgSignatureCache(GLOBAL_ORG);

    const scope = (id: string) =>
      antigravitySignatureScope(id, { access_token: "ya29.token", project_id: "proj-1" });

    expect(cache.has("claude-sonnet-4-5", scopedSignatureText(scope(owner.id), thinking))).toBe(
      true,
    );

    expect(cache.has("claude-sonnet-4-5", thinking)).toBe(false);
    expect(
      cache.has("claude-sonnet-4-5", scopedSignatureText(scope("another-credential"), thinking)),
    ).toBe(false);
  });
});

// CLIProxyAPI cf07c78a (antigravity_executor_execute.go, antigravity_executor_stream.go): an Anthropic error the
// translator writes (a malformed function call the zero-output guard did not see, here one with grounding only) is a
// 502 on both paths.
describe("antigravity executor: translated Claude errors", () => {
  const malformed = (): JsonObject => ({
    response: {
      candidates: [
        {
          content: { role: "model", parts: [] },
          finishReason: "MALFORMED_FUNCTION_CALL",
          groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com" } }] },
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
    },
  });

  const message = (stream: boolean): JsonObject => ({
    model: "gemini-2.5-flash",
    max_tokens: 16,
    stream,
    messages: [{ role: "user", content: "hi" }],
  });

  it("fails a non-stream answer with 502", async () => {
    resetMemoryAntigravityState();

    const h = harness(() => jsonResponse(malformed()), {
      credential: unique("translated-error"),
    });

    afterAll(h.dispose);

    const response = await h.call("/v1/messages", postJson(message(false)));

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("MALFORMED_FUNCTION_CALL");
  });

  it("fails a stream after the error event instead of ending it cleanly", async () => {
    resetMemoryAntigravityState();
    const h = harness(() => sse([malformed()]), { credential: unique("translated-error-stream") });

    afterAll(h.dispose);

    const response = await h.call("/v1/messages", postJson(message(true)));
    const text = await response.text();

    expect(text).toContain("MALFORMED_FUNCTION_CALL");
    expect(text).not.toContain("message_stop");
    // The stream failed with the 502 rather than ending as a success.
    expect(h.records[0]).toMatchObject({ failed: true, fail: { statusCode: 502 } });
  });
});

// CLIProxyAPI 2f86992c, 14a95b19, b8e3bc66: the credential's fetchAvailableModels catalog routes an explicit thinking
// level to its grouped variant, names the variant's enum in the labels and caps the output at the variant's limit.
describe("antigravity executor: thinking groups", () => {
  const seed = async (owner: typeof cred) => {
    const stored: ModelsRecord = {
      hints: {
        webSearchModelIds: [],
        modelEnums: { "gemini-3-pro-high": "M_HIGH", "gemini-3-pro-low": "M_LOW" },
        thinkingGroups: { "gemini-3-pro": { low: 4096, high: 8192 } },
      },
      scope: antigravityCatalogScope(owner.attributes, owner.metadata),
    };

    await orgKvOf(env, GLOBAL_ORG).put(antigravityModelsName(owner.id), JSON.stringify(stored));
  };

  const owner = credential("antigravity", `antigravity-groups-${crypto.randomUUID()}.json`, {
    kind: "oauth",
    metadata: { refresh_token: "1//r", access_token: "ya29.token", project_id: "proj-1" },
  });

  it("sends the variant of the requested level with its enum and output cap, and reports usage against it", async () => {
    resetMemoryAntigravityState();
    await seed(owner);
    const h = harness(() => jsonResponse(upstream([{ text: "ok" }])), { credential: owner });
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({ ...chat("gemini-3-pro-high"), reasoning_effort: "low", max_tokens: 50_000 }),
    );

    expect(response.status).toBe(200);
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.model).toBe("gemini-3-pro-low");
    expect(sent.request.labels.model_enum).toBe("M_LOW");
    expect(sent.request.generationConfig.maxOutputTokens).toBe(4096);
    expect(sent.request.generationConfig.thinkingConfig.thinkingLevel).toBe("LOW");
    expect(h.records[0]?.model).toBe("gemini-3-pro-low");
  });

  it("counts tokens as the variant a numeric suffix selects, under its output cap", async () => {
    resetMemoryAntigravityState();
    await seed(owner);
    const h = harness(() => jsonResponse({ totalTokens: 7 }), { credential: owner });
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/messages/count_tokens",
      postJson({
        model: "gemini-3-pro-high(1024)",
        max_tokens: 50_000,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(response.status).toBe(200);
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.request.model).toBe("models/gemini-3-pro-low");
    expect(sent.request.labels).toBeUndefined();
    expect(sent.request.generationConfig.maxOutputTokens).toBe(4096);
  });

  // Go `TestAntigravityThinkingGroupsPayloadRulesLast`: rules for the requested model and for the variant both apply.
  it("applies payload rules of the requested model and of the selected variant last", async () => {
    resetMemoryAntigravityState();
    await seed(owner);

    const rules = await loadConfig(`
requests:
  payload:
    override:
      - models: [{ name: "gemini-3-pro-high", protocol: antigravity }]
        params:
          "generationConfig.maxOutputTokens": 1234
          "labels.model_enum": "FILTER_ME"
    filter:
      - models: [{ name: "gemini-3-pro-low", protocol: antigravity }]
        params: ["labels.model_enum"]
`);

    const h = harness(() => jsonResponse(upstream([{ text: "ok" }])), {
      credential: owner,
      config: rules,
    });

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({ ...chat("gemini-3-pro-high"), reasoning_effort: "low" }),
    );

    expect(response.status).toBe(200);
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.model).toBe("gemini-3-pro-low");
    expect(sent.request.generationConfig.maxOutputTokens).toBe(1234);
    expect(sent.request.labels.model_enum).toBeUndefined();
  });

  // Go marks a variant's result under the variant (`SetUpstreamAttemptModel`); Commissary keeps marking the base model
  // until the pre-pick target check is ported, so an exhausted variant cools every level on the credential (SPI-1421).
  it("short-cools the variant itself but reports the result against the base model", async () => {
    resetMemoryAntigravityState();

    const cooled = credential(
      "antigravity",
      `antigravity-groups-cool-${crypto.randomUUID()}.json`,
      {
        kind: "oauth",
        metadata: { refresh_token: "1//r", access_token: "ya29.token", project_id: "proj-1" },
      },
    );

    await seed(cooled);

    const h = harness(
      (request) =>
        JSON.parse(request.body ?? "{}").model === "gemini-3-pro-low"
          ? jsonResponse(
              {
                error: {
                  code: 429,
                  message: "Resource exhausted",
                  status: "RESOURCE_EXHAUSTED",
                  details: [
                    {
                      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                      reason: "RATE_LIMIT_EXCEEDED",
                      domain: "x",
                    },
                    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30.000s" },
                  ],
                },
              },
              { status: 429 },
            )
          : jsonResponse(upstream([{ text: "ok" }])),
      { credential: cooled },
    );

    afterAll(h.dispose);
    const low = postJson({ ...chat("gemini-3-pro-high"), reasoning_effort: "low" });

    expect((await h.call("/v1/chat/completions", low)).status).toBe(429);
    // The conductor marks the lease's model: the requested base model, not the variant.
    expect(h.picks[0]?.model).toBe("gemini-3-pro-high");
    expect(h.reports[0]).toMatchObject({ success: false, retryAfterMs: 30_000 });
    expect(h.reports[0]?.model).toBeUndefined();

    // The variant's short cooldown answers the next low request without upstream, and records no usage for the variant.
    const calls = h.calls.length;
    const records = h.records.length;
    const again = await h.call("/v1/chat/completions", low);
    expect(again.status).toBe(429);
    expect(await again.text()).toContain("auth in short cooldown");
    expect(h.calls).toHaveLength(calls);
    expect(h.records.slice(records).map((record) => record.model)).not.toContain(
      "gemini-3-pro-low",
    );

    // The base model itself is not short-cooled by the executor.
    expect((await h.call("/v1/chat/completions", postJson(chat("gemini-3-pro-high")))).status).toBe(
      200,
    );
  });

  it("ignores a stored catalog over 2 MiB", async () => {
    resetMemoryAntigravityState();

    const big = credential("antigravity", `antigravity-groups-big-${crypto.randomUUID()}.json`, {
      kind: "oauth",
      metadata: { refresh_token: "1//r", access_token: "ya29.token", project_id: "proj-1" },
    });

    const stored: ModelsRecord = {
      hints: {
        webSearchModelIds: ["x".repeat(2 << 20)],
        modelEnums: { "gemini-3-pro-high": "M_HIGH", "gemini-3-pro-low": "M_LOW" },
        thinkingGroups: { "gemini-3-pro": { low: 4096, high: 8192 } },
      },
      scope: antigravityCatalogScope(big.attributes, big.metadata),
    };

    await orgKvOf(env, GLOBAL_ORG).put(antigravityModelsName(big.id), JSON.stringify(stored));
    const h = harness(() => jsonResponse(upstream([{ text: "ok" }])), { credential: big });
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({ ...chat("gemini-3-pro-high"), reasoning_effort: "low" }),
    );

    expect(response.status).toBe(200);
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.model).toBe("gemini-3-pro-high");
    expect(sent.request.labels.model_enum).toBeUndefined();
  });

  it("keeps the requested model, with its own enum, without a thinking level", async () => {
    resetMemoryAntigravityState();
    await seed(owner);
    const h = harness(() => jsonResponse(upstream([{ text: "ok" }])), { credential: owner });
    afterAll(h.dispose);

    expect((await h.call("/v1/chat/completions", postJson(chat("gemini-3-pro-high")))).status).toBe(
      200,
    );

    const sent = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(sent.model).toBe("gemini-3-pro-high");
    expect(sent.request.labels.model_enum).toBe("M_HIGH");
    expect(h.records[0]?.model).toBe("gemini-3-pro-high");
  });
});

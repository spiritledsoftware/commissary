// End-to-end tests (workerd) of the Antigravity executor: Access gate -> routes -> conductor -> executor -> mocked
// Cloud Code upstream. Covers the envelope, header whitelist, stream aggregation, 429 handling and token counting.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import { resetMemoryAntigravityState } from "../src/executor/antigravity/state.ts";
import type { Json, JsonObject } from "@commissary/json";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
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
    expect(sent.requestId).toMatch(/^agent-/);
    expect(sent.request.sessionId).toMatch(/^-\d+$/);
    expect(sent.request.safetySettings).toBeUndefined();
    // Non-Claude models lose maxOutputTokens; the payload rule (root `request`) still lands afterwards.
    expect(sent.request.generationConfig.maxOutputTokens).toBeUndefined();
    expect(sent.request.generationConfig.topK).toBe(7);
    // Sensitive words of the system instruction are obfuscated with a zero-width space.
    expect(sent.request.systemInstruction.parts[0].text).toBe("keep the s\u200Becret safe");
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
      // The original system text (obfuscated) stays first; the schema instruction follows, complete.
      expect(parts[0]?.text).toBe("keep the s\u200Becret safe");
      expect(parts.map((part) => part.text).join("\n")).toContain(JSON.stringify(schema));
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

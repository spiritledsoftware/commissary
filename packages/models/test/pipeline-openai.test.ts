// End-to-end tests (workerd) of the OpenAI-compatible vertical: /v1/chat/completions and /v1/completions through
// Access, model resolution, the static credential picker, the OpenAI-compatible executor and a mocked upstream.
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import { Thinking } from "../src/executor/thinking.ts";
import { set } from "@commissary/json";
import { noopSummaryHooks } from "@commissary/translation";
import { structuralBody } from "@commissary/translation/testing";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";

const YAML = `
api-keys:
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1/
      prefix: team
      headers:
        X-Custom: fixed
        X-Forward: $X-Client-Trace
      models:
        - name: upstream-model
          alias: alias-model
        - name: mct-model
          use-max-completion-tokens: true
      keys:
        - api-key: sk-test-1
requests:
  payload:
    override:
      - models: [{ name: "upstream-model", protocol: openai }]
        params: { "metadata.via": "payload-rule" }
`;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

const chunk = (
  content: string | undefined,
  finish: string | null = null,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finish }],
    ...extra,
  });

let config: Config;

beforeAll(async () => {
  config = await loadConfig(YAML);
});

const pipeline = (
  respond: UpstreamResponder,
  overrides: { config?: Config; thinking?: Layer.Layer<Thinking> } = {},
) =>
  makePipeline({
    config: overrides.config ?? config,
    respond,
    ...(overrides.thinking !== undefined ? { thinking: overrides.thinking } : {}),
  });

// CLIProxyAPI 07b5a7a1: the usage record reports the service tier that went out, after the payload rules.
describe("the recorded service tier", () => {
  const send = async (yaml: string, tier: string) => {
    const p = pipeline(() => jsonResponse(COMPLETION), { config: await loadConfig(yaml) });
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({
        model: "team/alias-model",
        messages: [{ role: "user", content: "hi" }],
        service_tier: tier,
      }),
    );

    expect(response.status).toBe(200);

    return {
      sent: (JSON.parse(p.calls[0]!.body) as { service_tier?: string }).service_tier,
      recorded: p.records[0]?.serviceTier,
    };
  };

  it("is the one a payload rule set, not the client's", async () => {
    const yaml = YAML.replace(
      'params: { "metadata.via": "payload-rule" }',
      'params: { "metadata.via": "payload-rule", "service_tier": "priority" }',
    );

    expect(await send(yaml, "flex")).toEqual({ sent: "priority", recorded: "priority" });
  });

  it("is the client's when no rule touches it", async () => {
    expect(await send(YAML, "flex")).toEqual({ sent: "flex", recorded: "flex" });
  });
});

describe("POST /v1/chat/completions (non-stream)", () => {
  it("translates, resolves the alias and forwards to the upstream with credentials", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson(
        { model: "team/alias-model", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
        { "X-Client-Trace": "trace-1" },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(COMPLETION);

    expect(p.calls).toHaveLength(1);
    const call = p.calls[0]!;
    expect(call.url).toBe("https://upstream.test/v1/chat/completions");
    expect(call.method).toBe("POST");
    expect(call.headers["authorization"]).toBe("Bearer sk-test-1");
    expect(call.headers["user-agent"]).toBe("cli-proxy-openai-compat");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["x-custom"]).toBe("fixed");
    expect(call.headers["x-forward"]).toBe("trace-1");
    expect(call.headers["accept"]).toBeUndefined();
    expect(call.headers["traceparent"]).toBeUndefined();
    expect(JSON.parse(call.body)).toEqual({
      model: "upstream-model",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      metadata: { via: "payload-rule" },
    });

    expect(p.records).toHaveLength(1);
    const record = p.records[0]!;
    expect(record).toMatchObject({
      provider: "openai-compatible-mock",
      model: "upstream-model",
      alias: "team/alias-model",
      endpoint: "POST /v1/chat/completions",
      principalId: "user:dev@example.com",
      authType: "apikey",
      stream: false,
      failed: false,
      responseModel: "upstream-model",
      serviceTier: "auto",
    });
    expect(record.detail).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    expect(JSON.stringify(record)).not.toContain("sk-test-1");
  });

  it("normalises max_tokens for use-max-completion-tokens models", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);
    await p.call(
      "/v1/chat/completions",
      postJson({ model: "mct-model", messages: [], max_tokens: 9 }),
    );
    expect(JSON.parse(p.calls[0]!.body)).toEqual({
      model: "mct-model",
      messages: [],
      max_completion_tokens: 9,
    });
  });

  it("passes upstream JSON errors through with the upstream status", async () => {
    const upstreamError =
      '{ "error": { "message": "slow down", "type": "rate_limit_error", "code": "rate_limit" } }';

    const p = pipeline(() =>
      jsonResponse(upstreamError, { status: 429, headers: { "retry-after": "7" } }),
    );

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [] }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    // Upstream headers are only exposed with passthrough-headers.
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).toBe(
      '{"error":{"message":"slow down","type":"rate_limit_error","code":"rate_limit"}}',
    );
    expect(p.records[0]).toMatchObject({ failed: true, fail: { statusCode: 429 } });
  });

  it("wraps plain-text upstream errors in an OpenAI error body", async () => {
    const p = pipeline(() => new Response("bad gateway <html>", { status: 502 }));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [] }),
    );

    expect(response.status).toBe(502);
    expect(structuralBody(await response.text())).toEqual(
      structuralBody(
        '{"error":{"message":"bad gateway <html>","type":"server_error","code":"internal_server_error"}}',
      ),
    );
  });

  it("rejects unknown models with 400 model_not_found", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "nope", messages: [] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "unknown provider for model nope",
        type: "invalid_request_error",
        code: "model_not_found",
        param: "model",
      },
    });
    expect(p.calls).toHaveLength(0);
  });

  it("rejects invalid JSON and unsupported encodings with 400", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);
    const invalid = await p.call("/v1/chat/completions", postJson("{not json"));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        message: "Invalid request: request body is not valid JSON",
        type: "invalid_request_error",
      },
    });

    const gzip = await p.call(
      "/v1/chat/completions",
      postJson("\u0001\u0002", { "content-encoding": "gzip" }),
    );

    expect(gzip.status).toBe(400);
    expect(await gzip.json()).toEqual({
      error: {
        message: "Invalid request: unsupported request content encoding: gzip",
        type: "invalid_request_error",
      },
    });
  });

  it("decodes zstd request bodies (Codex CLI)", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);

    const compressed = Uint8Array.from(
      atob(
        "KLUv/QRYLQIAckQPFaA5B6CriVBEOMhKPjCrOvJnTAKAT41oPgdgVhOfN32TKly8rojPT7XMhrPeQNUjl0DxJAoIvz7njUJmAQEAbZhMkfTeyQ==",
      ),
      (ch) => ch.charCodeAt(0),
    );

    const response = await p.call("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: compressed,
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(p.calls[0]!.body)).toMatchObject({
      model: "upstream-model",
      messages: [{ role: "user", content: "zstd hi" }],
    });
  });

  it("treats models of disabled entries as unknown", async () => {
    const empty = await loadConfig(
      YAML.replace("keys:\n        - api-key: sk-test-1", "disabled: true\n      keys: []"),
    );

    const p = pipeline(() => jsonResponse(COMPLETION), { config: empty });
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [] }),
    );

    expect(response.status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });
});

describe("payload rules are the final mutation (regression)", () => {
  it("overrides fields set by the executor, translator and thinking hook", async () => {
    const rules = await loadConfig(
      YAML.replace(
        'params: { "metadata.via": "payload-rule" }',
        'params: { "stream_options.include_usage": false, "reasoning_effort": "low", "max_tokens": 3 }',
      ),
    );

    // A thinking implementation that writes reasoning_effort: payload rules must still win.
    const thinking = Layer.succeed(
      Thinking,
      Thinking.of({
        apply: (request) => Effect.succeed(set(request.body, "reasoning_effort", "high")),
        summary: noopSummaryHooks,
      }),
    );

    const p = pipeline(() => sseResponse([`data: ${chunk("a", "stop")}\n\n`, "data: [DONE]\n\n"]), {
      config: rules,
      thinking,
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [], stream: true, max_tokens: 100 }),
    );

    expect(response.status).toBe(200);
    await response.text();
    const body = JSON.parse(p.calls[0]!.body);
    expect(body.stream_options).toEqual({ include_usage: false });
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_tokens).toBe(3);
    expect(p.records[0]?.reasoningEffort).toBe("high");
  });
});

describe("POST /v1/chat/completions (stream)", () => {
  it("streams translated chunks as SSE and ends with [DONE]", async () => {
    const usageChunk = JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });

    // Pieces split frames and lines at arbitrary points.
    const pieces = [
      `: comment\nevent: message\ndata: ${chunk("Hel")}\n`,
      `\ndata: ${chunk("lo")}`,
      `\r\n\r\ndata: ${chunk(undefined, "stop")}\n\ndata: ${usageChunk}\n\n`,
      'data: [DONE]\n\ndata: {"trailing":true}\n\n',
    ];

    const p = pipeline(() => sseResponse(pieces));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [], stream: true }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe(
      `data: ${chunk("Hel")}\n\ndata: ${chunk("lo")}\n\ndata: ${chunk(undefined, "stop")}\n\ndata: ${usageChunk}\n\ndata: [DONE]\n\n`,
    );
    const call = p.calls[0]!;
    expect(call.headers["accept"]).toBe("text/event-stream");
    expect(call.headers["cache-control"]).toBe("no-cache");
    expect(JSON.parse(call.body)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(p.records[0]).toMatchObject({
      stream: true,
      failed: false,
      detail: { inputTokens: 3, totalTokens: 5 },
    });
  });

  it("returns a real HTTP error when the upstream fails before the first chunk", async () => {
    const p = pipeline(() =>
      jsonResponse({ error: { message: "nope", type: "invalid_request_error" } }, { status: 401 }),
    );

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [], stream: true }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: { message: "nope", type: "invalid_request_error" },
    });
  });

  it("maps an error payload before any chunk to an HTTP error with its status", async () => {
    const p = pipeline(() => sseResponse([`data: {"error":{"message":"quota","status":429}}\n\n`]));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [], stream: true }),
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toBe('{"error":{"message":"quota","status":429}}');
    expect(p.records[0]).toMatchObject({
      failed: true,
      fail: { statusCode: 429 },
    });
    expect(p.records[0]?.fail).not.toHaveProperty("body");
  });

  it("writes a terminal error frame for mid-stream upstream errors", async () => {
    const p = pipeline(() =>
      sseResponse([
        `data: ${chunk("partial")}\n\n`,
        'event: error\ndata: {"message":"boom","code":"overloaded"}\n\n',
      ]),
    );

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [], stream: true }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `data: ${chunk("partial")}\n\ndata: {"message":"boom","code":"overloaded"}\n\n`,
    );
    expect(p.records[0]).toMatchObject({ failed: true, fail: { statusCode: 502 } });
  });

  it("fails a stream that closes without any finish_reason", async () => {
    const p = pipeline(() => sseResponse([`data: ${chunk("partial")}\n\n`]));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [], stream: true }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `data: ${chunk("partial")}\n\ndata: {"error":{"message":"upstream stream closed before any chunk carried finish_reason","type":"server_error","code":"internal_server_error"}}\n\n`,
    );
  });

  it("treats an upstream stream without any payload as a failed attempt (empty_stream)", async () => {
    // conductor_stream.go readStreamBootstrap: a stream that closes before the first payload fails over.
    const p = pipeline(() => sseResponse(["data: [DONE]\n\n"]));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [], stream: true }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("upstream stream closed before first payload");
  });

  it("rejects a bare JSON document inside a 200 stream", async () => {
    const p = pipeline(() => sseResponse(['{"error":{"message":"not sse"}}\n']));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", messages: [], stream: true }),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":{"message":"not sse"}}');
  });
});

describe("POST /v1/completions", () => {
  it("converts the legacy request and the chat response", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/completions",
      postJson({
        model: "alias-model",
        prompt: "Say hi",
        max_tokens: 5,
        temperature: 0.5,
        stop: ["\n"],
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(p.calls[0]!.body)).toEqual({
      model: "upstream-model",
      messages: [{ role: "user", content: "Say hi" }],
      max_tokens: 5,
      temperature: 0.5,
      stop: ["\n"],
      metadata: { via: "payload-rule" },
    });
    expect(structuralBody(await response.text())).toEqual(
      structuralBody(
        '{"id":"chatcmpl-1","object":"text_completion","created":1700000000,"model":"upstream-model","choices":[{"finish_reason":"stop","index":0,"text":"hello"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      ),
    );
  });

  // Go reads a null finish_reason with gjson String() (""), so converted chunks carry `"finish_reason":""`.
  it("streams converted chunks and drops empty ones", async () => {
    const p = pipeline(() =>
      sseResponse([
        `data: ${chunk(undefined)}\n\n`,
        `data: ${chunk("Hi")}\n\n`,
        `data: ${chunk(undefined, "stop")}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/completions",
      postJson({ model: "alias-model", prompt: "x", stream: true }),
    );

    expect(response.status).toBe(200);
    expect(structuralBody(await response.text())).toEqual(
      structuralBody(
        'data: {"id":"chatcmpl-1","object":"text_completion","created":1700000000,"model":"upstream-model","choices":[{"finish_reason":"","index":0,"text":"Hi"}]}\n\n' +
          'data: {"id":"chatcmpl-1","object":"text_completion","created":1700000000,"model":"upstream-model","choices":[{"finish_reason":"stop","index":0,"text":""}]}\n\n' +
          "data: [DONE]\n\n",
      ),
    );
  });
});

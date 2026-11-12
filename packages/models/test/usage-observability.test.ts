// X-CPA-TRACE-ID, structured request logs and per-attempt usage records through the full pipeline.
import { Layer, Logger, References } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Config } from "../src/config/schema.ts";
import { authIndexOf, unkeyedAuthIndexOf } from "./support/auth-index.ts";
import { TraceLayer } from "../src/observability/trace.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
} from "./support/pipeline.ts";

const YAML = `
api-keys:
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1/
      models:
        - name: upstream-model
      keys:
        - api-key: sk-test-1
`;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

interface LogLine {
  readonly level: string;
  readonly message: unknown;
  readonly annotations: Record<string, unknown>;
}

const logs: Array<LogLine> = [];

const capture = Logger.layer([
  Logger.make((options) => {
    logs.push({
      level: options.logLevel,
      message: options.message,
      annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
    });
  }),
]);

let config: Config;

beforeAll(async () => {
  config = await loadConfig(YAML);
});

/** The header is the bare request id (a random UUID): never derived from the credential (deviation from Go). */
const TRACE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const pipeline = (respond: Parameters<typeof makePipeline>[0]["respond"]) => {
  const p = makePipeline({ config, respond, extraLayers: Layer.mergeAll(TraceLayer, capture) });
  afterAll(p.dispose);

  return p;
};

const chat = {
  model: "upstream-model",
  messages: [{ role: "user", content: "secret prompt text" }],
};

describe("X-CPA-TRACE-ID", () => {
  it("carries the request id only, never the credential's index or id", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    const response = await p.call("/v1/chat/completions", postJson(chat));
    expect(response.status).toBe(200);
    const header = response.headers.get("x-cpa-trace-id") ?? "";
    expect(header).toMatch(TRACE);
    const record = p.records[0]!;
    expect(header).not.toContain(authIndexOf(record.authId));
    expect(header).not.toContain(unkeyedAuthIndexOf(record.authId));
    // The usage record shares the request id of the inbound request: admins join through it.
    expect(record.traceId).toBe(header);
    expect(record.requestId).not.toBe(record.traceId);
  });

  it("is also set on streamed responses", async () => {
    const p = pipeline(() =>
      sseResponse([
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "upstream-model", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "upstream-model", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );

    const response = await p.call("/v1/chat/completions", postJson({ ...chat, stream: true }));
    expect(response.headers.get("x-cpa-trace-id")).toMatch(TRACE);
    await response.text();
    expect(p.records).toHaveLength(1);
    const record = p.records[0]!;
    expect(record).toMatchObject({ stream: true, failed: false });
    expect(record.detail).toMatchObject({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
    expect(record.detail.tokenBreakdown).toMatchObject({ quality: "complete", totalTokens: 4 });
    expect(record.ttftMs).toBeDefined();
    expect(record.ttftMs).toBeLessThanOrEqual(record.latencyMs);
  });

  it("falls back to the bare request id when no credential was selected, and skips health probes", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ ...chat, model: "no-such-model" }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("x-cpa-trace-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.records).toHaveLength(0);
    const health = await p.call("/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("x-cpa-trace-id")).toBeNull();
  });

  it("gives every request its own id", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    const ids = new Set<string>();

    for (let index = 0; index < 3; index += 1) {
      const response = await p.call("/v1/chat/completions", postJson(chat));

      ids.add(response.headers.get("x-cpa-trace-id") ?? "");
    }

    expect(ids.size).toBe(3);
  });
});

describe("structured request log", () => {
  it("logs one line per request without secrets, bodies or query strings", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    logs.length = 0;

    const response = await p.call(
      "/v1/chat/completions?key=QUERY-SECRET",
      postJson(chat, { authorization: "Bearer HEADER-SECRET" }),
    );

    expect(response.status).toBe(200);

    const lines = logs.filter(
      (line) => Array.isArray(line.message) && line.message[0] === "request",
    );

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe("Info");
    expect(line.annotations).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      principal: "user:dev@example.com",
      provider: "openai-compatible-mock",
      model: "upstream-model",
      attempts: 1,
    });
    expect(line.annotations["requestId"]).toMatch(/^[0-9a-f-]{36}$/);
    // The log carries the keyed index of the credential that served the request.
    expect(line.annotations["authIndex"]).toBe(authIndexOf(p.records[0]!.authId));
    expect(typeof line.annotations["latencyMs"]).toBe("number");
    const serialised = JSON.stringify(logs);

    for (const secret of [
      "QUERY-SECRET",
      "HEADER-SECRET",
      "sk-test-1",
      "secret prompt text",
      "eyJ",
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("logs upstream failures as warnings or errors and keeps the failed usage record", async () => {
    const p = pipeline(() => jsonResponse({ error: { message: "overloaded" } }, { status: 503 }));
    logs.length = 0;
    const response = await p.call("/v1/chat/completions", postJson(chat));
    expect(response.status).toBe(503);

    const line = logs.find(
      (entry) => Array.isArray(entry.message) && entry.message[0] === "request",
    );

    expect(line).toMatchObject({ level: "Error", annotations: { status: 503 } });
    expect(p.records.length).toBeGreaterThanOrEqual(1);
    expect(p.records.every((record) => record.failed && record.fail?.statusCode === 503)).toBe(
      true,
    );
    expect(new Set(p.records.map((record) => record.traceId)).size).toBe(1);
    expect(new Set(p.records.map((record) => record.requestId)).size).toBe(p.records.length);
  });
});

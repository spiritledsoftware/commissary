// Unit tests for the Codex building blocks: Responses frame assembler, tool schema normalisation, input id
// sanitising, uuid v5, reasoning replay, the interactions terminal event and the executor-level replay round trip.
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config/schema.ts";
import { makeCodexExecutor } from "../src/executor/codex/executor.ts";
import {
  codexTerminalFailure,
  newCodexStatusError,
  parseCodexRetryAfterMs,
} from "../src/executor/codex/errors.ts";
import { ensureResponsesUsageDetails } from "../src/executor/codex/output.ts";
import {
  CODEX_REASONING_REPLAY_TURN_TYPE,
  insertReplayTurns,
  makeInMemoryReplayStore,
} from "../src/executor/codex/replay.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import { sanitizeCodexInputItemIds } from "../src/executor/helps/codex-input-ids.ts";
import {
  normalizeCodexToolIntegerTypes,
  normalizeCodexToolSchemas,
} from "../src/executor/helps/codex-tool-schema.ts";
import { finalizePayload } from "../src/executor/helps/payload.ts";
import { uuidV5Oid } from "../src/executor/helps/uuid.ts";
import type { ExecutionContext, ExecutorOptions } from "../src/executor/types.ts";
import { Thinking } from "../src/executor/thinking.ts";
import { responsesFramer } from "../src/handlers/responses/framer.ts";
import { get, type Json } from "@commissary/json";
import { builtinTranslators, makeTranslationState } from "@commissary/translation";
import { UsageReporter } from "../src/usage/reporter.ts";
import { oauthCredential } from "./support/codex.ts";
import { loadConfig } from "./support/pipeline.ts";
import { GLOBAL_ORG } from "@commissary/core";

describe("Responses frame assembler", () => {
  const created = 'event: response.created\ndata: {"type":"response.created","sequence_number":0}';

  it("joins line-wise chunks into frames and ignores blank separators", () => {
    const framer = responsesFramer({ codexClient: false });
    expect(framer.chunk("event: response.created")).toBe("");
    expect(framer.chunk('data: {"type":"response.created"}')).toBe(
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    );
    expect(framer.chunk("")).toBe("");
    // A data frame without an event line is emitted when the next data line starts.
    expect(framer.chunk('data: {"type":"response.in_progress"}')).toBe("");
    expect(framer.chunk('data: {"type":"response.output_text.delta","delta":"x"}')).toBe(
      'data: {"type":"response.in_progress"}\n\n',
    );
    expect(framer.done()).toBe('data: {"type":"response.output_text.delta","delta":"x"}\n\n\n');
  });

  it("drops everything after a terminal event and rebuilds an empty output", () => {
    const framer = responsesFramer({ codexClient: false });
    framer.chunk(
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"b"}}\n\n',
    );
    framer.chunk(
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"a"}}\n\n',
    );

    const out = framer.chunk(
      'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
    );

    const payload = JSON.parse(out.split("data: ")[1] as string) as {
      response: { output: Array<{ id: string }> };
    };

    expect(payload.response.output.map((item) => item.id)).toEqual(["a", "b"]);
    expect(framer.chunk('event: response.created\ndata: {"type":"response.created"}\n\n')).toBe("");
    expect(framer.closeError()).toBeUndefined();
  });

  it("normalises error payloads, redacting secrets, and reports the last event on early close", () => {
    const framer = responsesFramer({ codexClient: false });
    framer.chunk(`${created}\n\n`);
    framer.chunk("event: error");

    const out = framer.chunk(
      'data: {"type":"error","status":429,"error":{"message":"bad Bearer abc.def-ghi key","api_key":"sk-1","code":"rate_limit_exceeded"}}',
    );

    expect(out).toMatch(/^event: error\ndata: /);
    expect(out).not.toContain("sk-1");
    expect(out).not.toContain("abc.def-ghi");
    expect(out).toContain('"sequence_number":1');
    const early = responsesFramer({ codexClient: true });
    early.chunk(`${created}\n\n`);
    expect(early.closeError()?.message).toContain("last event: response.created");
  });

  it("drops response.metadata for standard clients and keeps it for Codex clients", () => {
    const metadata =
      'event: response.metadata\ndata: {"type":"response.metadata","metadata":{"marker":"private"}}\n\n';

    const dataOnly = 'data: {"type":"response.metadata","metadata":{"marker":"private"}}\n\n';
    const standard = responsesFramer({ codexClient: false });

    expect(standard.chunk(metadata)).toBe("");
    expect(standard.chunk(dataOnly)).toBe("");
    expect(responsesFramer({ codexClient: true }).chunk(metadata)).toBe(metadata);
  });

  it("keeps partial frames until they are valid and flushes them on close", () => {
    const framer = responsesFramer({ codexClient: false });
    expect(framer.chunk('data: {"type":"response.output_text.delta"')).toBe("");
    expect(framer.chunk(',"delta":"a"}')).toBe("");
    expect(framer.closeError()?.status).toBe(502);
    expect(framer.done()).toBe('data: {"type":"response.output_text.delta","delta":"a"}\n\n\n');
  });
});

describe("tool schema normalisation", () => {
  const constUnion = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ const: `v${i}`, description: `d${i}` }));

  it("collapses pure constant unions of 8+ branches into enum and strips unsupported patterns", () => {
    const body: Json = {
      tools: [
        {
          type: "function",
          name: "t",
          parameters: {
            type: "object",
            properties: {
              mode: { description: "m", oneOf: constUnion(8) },
              short: { oneOf: constUnion(7) },
              mixed: { anyOf: [...constUnion(8), { type: "string" }] },
              name: { type: "string", pattern: "^\\p{L}+$" },
              dup: { oneOf: [...constUnion(7), { const: "v0" }] },
            },
          },
        },
      ],
    };

    normalizeCodexToolSchemas(body);

    const properties = get(body, "tools.0.parameters.properties");

    expect(get(properties, "mode")).toEqual({
      description: "m",
      enum: Array.from({ length: 8 }, (_, i) => `v${i}`),
    });
    expect(get(properties, "short.oneOf")).toHaveLength(7);
    expect(get(properties, "mixed.anyOf")).toHaveLength(9);
    expect(get(properties, "dup.oneOf")).toHaveLength(8);
    expect(get(properties, "name")).toEqual({ type: "string" });
  });

  it("drops the union when an identical enum already exists", () => {
    const body: Json = {
      tools: [
        {
          type: "function",
          name: "t",
          parameters: {
            properties: {
              a: { enum: ["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"], oneOf: constUnion(8) },
            },
          },
        },
      ],
    };

    normalizeCodexToolSchemas(body);
    expect(JSON.stringify(body)).not.toContain("oneOf");
  });

  it("rewrites number to integer for Codex CLI tools, only for Codex clients", () => {
    const make = (): Json => ({
      tools: [
        {
          type: "function",
          name: "exec_command",
          parameters: {
            properties: { timeout_ms: { type: "number" }, other: { type: "number" } },
          },
        },
        {
          type: "namespace",
          name: "notes",
          tools: [
            {
              type: "function",
              name: "read_file",
              parameters: {
                properties: {
                  start_line: { type: ["number", "null"], anyOf: [{ type: "number" }] },
                },
              },
            },
          ],
        },
        { name: "wait_agent", input_schema: { properties: { timeout_ms: { type: "number" } } } },
      ],
    });

    const untouched = make();
    normalizeCodexToolIntegerTypes(untouched, new Headers({ "user-agent": "curl/8" }));
    expect(JSON.stringify(untouched)).not.toContain("integer");
    const body = make();
    normalizeCodexToolIntegerTypes(body, new Headers({ "user-agent": "codex_cli_rs/0.1" }));
    expect(get(body, "tools.0.parameters.properties.timeout_ms.type")).toBe("integer");
    expect(get(body, "tools.0.parameters.properties.other.type")).toBe("number");
    expect(get(body, "tools.1.tools.0.parameters.properties.start_line.type")).toEqual([
      "integer",
      "null",
    ]);
    expect(get(body, "tools.2.input_schema.properties.timeout_ms.type")).toBe("integer");
  });

  it("only normalises integers in the payload barrier of non-Codex targets", async () => {
    const config = await loadConfig("requests: {}");

    const make = (): Json => ({
      tools: [
        {
          type: "function",
          name: "sleep",
          parameters: { properties: { duration_ms: { type: "number" } } },
        },
      ],
    });

    const request = {
      model: "m",
      protocol: "openai",
      headers: new Headers({ "user-agent": "codex-tui/1" }),
    };

    const forOpenAI = finalizePayload(config, "openai-compatible-x", request, make());
    expect(JSON.stringify(forOpenAI)).toContain('"integer"');
    const forCodex = finalizePayload(config, "codex", request, make());
    expect(JSON.stringify(forCodex)).toContain('"number"');
  });
});

describe("helpers", () => {
  it("sanitises input item ids like Go", () => {
    const long = `msg_${"a".repeat(80)}`;

    const body = {
      input: [
        { type: "reasoning", id: `rs_${"b".repeat(70)}`, encrypted_content: "enc" },
        { type: "message", id: "plain", role: "user" },
        { type: "message", id: "msg_plain", role: "user" },
        { type: "message", id: long, role: "user" },
        { type: "function_call_output", id: "keep", call_id: "c" },
      ],
    };

    sanitizeCodexInputItemIds(body as unknown as Json);
    const ids = body.input.map((item) => item.id);
    expect(body.input).toHaveLength(4);
    // "plain" becomes msg_plain, colliding with the preserved "msg_plain": it gets a hash suffix.
    expect(ids[0]).toMatch(/^msg_plain_[0-9a-f]{16}$/);
    expect(ids[1]).toBe("msg_plain");
    expect(ids[2]).toHaveLength(64);
    expect(ids[2]).toMatch(/^msg_a+_[0-9a-f]{16}$/);
    expect(ids[3]).toBe("keep");
  });

  it("derives name-based uuids like google/uuid", () => {
    expect(uuidV5Oid("cli-proxy-api:codex:prompt-cache:x")).toBe(
      "4e124907-d1b8-51c8-a7dc-9f524b7ce9e5",
    );
    expect(uuidV5Oid("cli-proxy-api\u0000codex\u0000derived-session\u0000abc")).toBe(
      "744b54df-ddd6-5aad-b158-0290b4ee91fa",
    );
  });

  it("classifies status errors, capacity errors and terminal failures", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");

    const capacity = newCodexStatusError(
      503,
      '{"error":{"message":"Selected model is at capacity"}}',
      {
        modelLevelCooling: false,
        nowMs: now,
      },
    );

    expect(capacity.status).toBe(429);
    expect(capacity.credentialScoped).toBeUndefined();

    const usage = newCodexStatusError(
      400,
      '{"error":{"type":"usage_limit_reached","resets_in_seconds":90}}',
      {
        modelLevelCooling: true,
        nowMs: now,
      },
    );

    expect(usage).toMatchObject({ status: 429, retryAfterMs: 90_000 });
    expect(usage.credentialScoped).toBeUndefined();
    expect(
      parseCodexRetryAfterMs(
        500,
        '{"error":{"type":"usage_limit_reached","resets_in_seconds":9}}',
        now,
      ),
    ).toBeUndefined();

    const failure = codexTerminalFailure(
      {
        type: "response.failed",
        sequence_number: 7,
        response: { error: { code: "model_not_found", message: "x" } },
      },
      { modelLevelCooling: false, nowMs: now },
    );

    expect(failure?.error.status).toBe(404);
    expect(JSON.parse(failure!.body)).toMatchObject({ sequence_number: 7 });
    expect(
      codexTerminalFailure(
        { type: "response.completed" },
        { modelLevelCooling: false, nowMs: now },
      ),
    ).toBeUndefined();
  });

  it("adds missing Responses usage details to JSON and SSE payloads but not to compactions", () => {
    const sse = 'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1}}}\n\n';
    expect(ensureResponsesUsageDetails(sse)).toContain(
      '"output_tokens_details":{"reasoning_tokens":0}',
    );
    const compaction = '{"object":"response.compaction","usage":{"input_tokens":1}}';
    expect(ensureResponsesUsageDetails(compaction)).toBe(compaction);
  });
});

describe("interactions terminal event", () => {
  afterEach(() => vi.useRealTimers());

  it("completes with the created time and a fixed update time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-03T04:05:06Z"));

    const context = {
      model: "gpt-5.4",
      originalRequest: {},
      translatedRequest: {},
      state: makeTranslationState(),
    };

    const translate = (line: string) =>
      builtinTranslators.translateStream("interactions", "codex", context, line);

    translate(
      'data: {"type":"response.created","response":{"id":"resp_1","created_at":1767225600,"model":"gpt-5.4"}}',
    );

    const chunks = translate(
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2,"input_tokens_details":{"cached_tokens":1},"output_tokens_details":{"reasoning_tokens":1}}}}',
    );

    expect(chunks.map((chunk) => chunk.split("\n")[0])).toEqual([
      "event: interaction.completed",
      "event: done",
    ]);

    const completed = JSON.parse(chunks[0]!.split("data: ")[1]!) as {
      interaction: Record<string, unknown>;
    };

    expect(completed.interaction).toMatchObject({
      id: "resp_1",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-02-03T04:05:06Z",
      usage: {
        total_tokens: 5,
        total_input_tokens: 3,
        total_cached_tokens: 1,
        total_output_tokens: 2,
        total_thought_tokens: 1,
      },
    });
  });
});

describe("reasoning replay", () => {
  // A structurally valid GPT reasoning signature (version 0x80, 73 bytes).
  const signature = (() => {
    const bytes = new Uint8Array(73);
    bytes[0] = 0x80;
    bytes.fill(7, 5);

    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  })();

  it("inserts cached reasoning and tool calls before the matching tool output", async () => {
    const store = makeInMemoryReplayStore(() => 0);
    await Effect.runPromise(
      store.append("gpt-5.4", "claude:s:agent:main", [
        { type: CODEX_REASONING_REPLAY_TURN_TYPE, id: "t1", call_ids: ["call_1"] },
        { type: "reasoning", summary: [], content: null, encrypted_content: signature },
        { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
      ]),
    );
    const items = await Effect.runPromise(store.get("gpt-5.4", "claude:s:agent:main"));

    const body: Json = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    };

    expect(insertReplayTurns(body, items ?? [])).toBe(true);
    expect(get(body, "input.#.type")).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    // Already present items are not duplicated.
    expect(insertReplayTurns(body, items ?? [])).toBe(false);
  });

  it("expires entries and clears them on demand", async () => {
    let now = 0;
    const store = makeInMemoryReplayStore(() => now);
    const marker = { type: CODEX_REASONING_REPLAY_TURN_TYPE, id: "t" };
    const reasoning = { type: "reasoning", encrypted_content: signature };
    await Effect.runPromise(store.append("m", "k", [marker, reasoning]));
    expect(await Effect.runPromise(store.get("m", "k"))).toHaveLength(2);
    await Effect.runPromise(store.clear("m", "k"));
    expect(await Effect.runPromise(store.get("m", "k"))).toBeUndefined();
    await Effect.runPromise(store.append("m", "k", [marker, reasoning]));
    now = 61 * 60 * 1000;
    expect(await Effect.runPromise(store.get("m", "k"))).toBeUndefined();
  });
});

describe("Codex executor replay round trip (Claude source)", () => {
  let config: Config;
  beforeAll(async () => {
    config = await loadConfig("requests: {}");
  });

  const signature = (() => {
    const bytes = new Uint8Array(73);
    bytes[0] = 0x80;
    bytes.fill(9, 5);

    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  })();

  it("caches reasoning from a completed response and replays it into the next request, then clears it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let respondWith: Response;

    const client = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.promise(async () => {
          bodies.push(
            JSON.parse(new TextDecoder().decode((request.body as { body: Uint8Array }).body)),
          );

          return HttpClientResponse.fromWeb(request, respondWith.clone());
        }),
      ),
    );

    const output = [
      { id: "rs_1", type: "reasoning", summary: [], encrypted_content: signature },
      { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: '{"p":1}' },
    ];

    const stream = `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output, usage: {} } })}\n\n`;
    respondWith = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const store = makeInMemoryReplayStore(() => 0);
    const executor = makeCodexExecutor({ replayStore: store });

    const usage = new UsageReporter({
      requestId: "r",
      provider: "codex",
      executorType: "codex",
      model: "gpt-5.4",
      alias: "gpt-5.4",
      endpoint: "POST /v1/messages",
      principalId: "user:x",
      orgId: GLOBAL_ORG,
      authId: "a",
      authType: "oauth",
      source: "s",
      stream: false,
      serviceTier: "auto",
      requestedAt: 0,
    });

    const context: ExecutionContext = { credential: oauthCredential(), config, usage };

    const options: ExecutorOptions = {
      stream: false,
      alt: "",
      headers: new Headers({ "x-claude-code-session-id": "sess-1" }),
      query: new URLSearchParams(),
      originalRequest: undefined,
      sourceFormat: "claude",
      metadata: {
        requestPath: "/v1/messages",
        requestedModel: "gpt-5.4",
        serviceTier: "auto",
        generate: true,
        callerScope: "scope",
      },
    };

    const first = {
      model: "gpt-5.4",
      max_tokens: 10,
      messages: [{ role: "user", content: "read it" }],
    };

    const layers = Layer.mergeAll(client, Thinking.live);
    await Effect.runPromise(
      executor
        .execute(context, { model: "gpt-5.4", payload: first }, options)
        .pipe(Effect.provide(layers)),
    );

    const second = {
      model: "gpt-5.4",
      max_tokens: 10,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Read", input: { p: 1 } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }],
        },
      ],
    };

    respondWith = new Response(stream, { status: 200 });
    await Effect.runPromise(
      executor
        .execute(context, { model: "gpt-5.4", payload: second }, options)
        .pipe(Effect.provide(layers)),
    );
    const input = bodies[1]!["input"] as Array<{ type: string; encrypted_content?: string }>;
    expect(input.map((item) => item.type)).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(input[1]!.encrypted_content).toBe(signature);
    // The prompt cache key is derived from the Claude Code session.
    expect(bodies[1]!["prompt_cache_key"]).toBe(
      uuidV5Oid("cli-proxy-api:codex:claude-code\u0000gpt-5.4\u0000claude:sess-1:agent:main"),
    );

    // An invalid-signature rejection clears the cache.
    respondWith = new Response('{"error":{"message":"invalid_encrypted_content"}}', {
      status: 400,
    });

    const failed = await Effect.runPromise(
      Effect.flip(
        executor
          .execute(context, { model: "gpt-5.4", payload: second }, options)
          .pipe(Effect.provide(layers)),
      ),
    );

    expect(failed).toBeInstanceOf(ExecutionError);
    expect(failed.message).toContain("thinking_signature_invalid");
    expect(
      await Effect.runPromise(store.get("gpt-5.4", "claude:sess-1:agent:main")),
    ).toBeUndefined();
  });

  it("streams through executeStream and fails a stream that never completes", async () => {
    const client = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('data: {"type":"response.created","response":{"id":"r"}}\n\n'),
          ),
        ),
      ),
    );

    const executor = makeCodexExecutor();

    const usage = new UsageReporter({
      requestId: "r",
      provider: "codex",
      executorType: "codex",
      model: "m",
      alias: "m",
      endpoint: "e",
      principalId: "p",
      orgId: GLOBAL_ORG,
      authId: "a",
      authType: "oauth",
      source: "s",
      stream: true,
      serviceTier: "auto",
      requestedAt: 0,
    });

    const result = await Effect.runPromise(
      executor
        .executeStream(
          { credential: oauthCredential(), config, usage },
          { model: "gpt-5.4", payload: { model: "gpt-5.4", input: "x" } },
          {
            stream: true,
            alt: "",
            headers: new Headers(),
            query: new URLSearchParams(),
            originalRequest: undefined,
            sourceFormat: "openai-response",
            metadata: {
              requestPath: "/v1/responses",
              requestedModel: "gpt-5.4",
              serviceTier: "auto",
              generate: true,
              callerScope: "s",
            },
          },
        )
        .pipe(Effect.provide(Layer.mergeAll(client, Thinking.live))),
    );

    const outcome = await Effect.runPromise(Effect.result(Stream.runCollect(result.chunks)));
    expect(outcome._tag).toBe("Failure");
    expect(usage.failed).toBe(true);
  });
});

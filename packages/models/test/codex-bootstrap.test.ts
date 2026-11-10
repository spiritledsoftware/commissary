// Codex stream bootstrap buffering (`upstream.codex.stream-bootstrap-buffering` / `-timeout`): reader unit tests with an
// injected clock, the Go duration parser, and end-to-end failover through the conductor (Go
// codex_executor_stream_*_test.go scenarios).
import { Effect, Layer, Result, Stream } from "effect";
import type { Json, JsonObject } from "@commissary/json";
import type { HttpServerRequest } from "effect/http";
import { describe, expect, it } from "vitest";
import { AccessPrincipal } from "@commissary/auth";
import {
  BOOTSTRAP_MAX_BUFFERED_BYTES,
  BOOTSTRAP_MAX_BUFFERED_FRAMES,
  bootstrapTimeoutMs,
  isBootstrapBufferableEvent,
  isGrokClientHeaders,
  isOverloadBootstrapFailure,
} from "../src/executor/codex/bootstrap.ts";
import { CodexStreamReader, type CodexStreamOptions } from "../src/executor/codex/stream.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import { CredentialRefresher } from "../src/executor/helps/credential-refresh.ts";
import { ExecutorRegistry } from "../src/executor/registry.ts";
import { Thinking } from "../src/executor/thinking.ts";
import { executeStream } from "../src/handlers/execute.ts";
import { ModelCapabilities } from "../src/handlers/model-capabilities.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import { builtinTranslators, makeTranslationState } from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import { UsageReporter } from "../src/usage/reporter.ts";
import type { UsageRecord } from "../src/usage/record.ts";
import { UsageSink } from "../src/usage/sink.ts";
import {
  mockHttpClient,
  sseResponse,
  staticConfigReader,
  type UpstreamCall,
} from "./support/pipeline.ts";
import { makePool, poolPickerLayer } from "./support/pool.ts";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { envContext } from "./support/context.ts";

const data = (event: Json): string => `data: ${JSON.stringify(event)}`;

const created = data({ type: "response.created", response: { id: "r1", status: "in_progress" } });

const inProgress = data({ type: "response.in_progress", response: { id: "r1" } });

const messageAdded = data({
  type: "response.output_item.added",
  output_index: 0,
  item: { type: "message", role: "assistant", content: [] },
});

const delta = data({
  type: "response.output_text.delta",
  item_id: "m",
  output_index: 0,
  content_index: 0,
  delta: "Hi",
});

const completed = data({
  type: "response.completed",
  response: {
    id: "r1",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
});

const overload = data({
  type: "response.failed",
  response: {
    id: "r1",
    error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." },
  },
});

const invalid = data({
  type: "response.failed",
  response: { id: "r1", error: { code: "invalid_prompt", message: "bad prompt" } },
});

let clock = 0;

const reader = (overrides: Partial<CodexStreamOptions> = {}) => {
  clock = 1_000;

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

  return new CodexStreamReader({
    registry: builtinTranslators,
    responseFormat: Formats.OpenAIResponse,
    providerFormat: Formats.Codex,
    context: {
      model: "m",
      originalRequest: {},
      translatedRequest: {},
      state: makeTranslationState(),
    },
    usage,
    preserveNativeOutput: true,
    modelLevelCooling: false,
    nowMs: () => clock,
    replayScope: { modelName: "", sessionKey: "", requestFingerprint: "" },
    bootstrap: { timeoutMs: 0 },
    ...overrides,
  });
};

const feed = (r: CodexStreamReader, lines: ReadonlyArray<string>) =>
  lines.map((line) => r.push(line));

const text = (steps: ReadonlyArray<{ chunks: ReadonlyArray<string> }>): string =>
  steps.flatMap((s) => s.chunks).join("");

describe("bootstrap buffering reader", () => {
  it("holds the handshake until the first real event and releases it in order", () => {
    const r = reader();
    const held = feed(r, [created, "", inProgress, "", messageAdded, ""]);
    expect(
      held.every((step) => step.chunks.length === 0 && !step.stop && step.error === undefined),
    ).toBe(true);
    const released = r.push(delta);
    const out = released.chunks.join("");
    expect(out.indexOf("response.created")).toBeLessThan(out.indexOf("response.in_progress"));
    expect(out.indexOf("response.in_progress")).toBeLessThan(
      out.indexOf("response.output_item.added"),
    );
    expect(out.indexOf("response.output_item.added")).toBeLessThan(
      out.indexOf("response.output_text.delta"),
    );
    // Buffering is over: the next frame flows straight through.
    expect(
      r.push(data({ type: "response.output_text.delta", delta: "!" })).chunks.join(""),
    ).toContain('"delta":"!"');
  });

  it("without the option nothing is held", () => {
    const r = reader({ bootstrap: undefined });
    expect(r.push(created).chunks.join("")).toContain("response.created");
  });

  it("fails the attempt with a 503 on an overload rejection and releases nothing", () => {
    const r = reader();
    feed(r, [created, "", inProgress, ""]);
    const step = r.push(overload);
    expect(step.stop).toBe(true);
    expect(step.chunks).toEqual([]);
    expect(step.error).toBeInstanceOf(ExecutionError);
    expect(step.error?.status).toBe(503);
    expect(step.error?.message).toContain("server_is_overloaded");
  });

  it("delivers other terminal failures in-stream after the held handshake", () => {
    const r = reader();
    feed(r, [created, ""]);
    const step = r.push(invalid);
    expect(step.stop).toBe(true);
    expect(step.error?.status).not.toBe(503);
    expect(step.error?.message).toContain("invalid_prompt");
    expect(step.chunks.join("")).toContain("response.created");
  });

  it("an overload after the budget is exhausted is delivered in-stream (time budget)", () => {
    const r = reader({ bootstrap: { timeoutMs: 500 } });
    feed(r, [created, ""]);
    clock += 600;
    const step = r.push(overload);
    expect(step.error?.status).not.toBe(503);
    expect(step.chunks.join("")).toContain("response.created");
  });

  it("the time budget releases the stream at the next handshake frame", () => {
    const r = reader({ bootstrap: { timeoutMs: 500 } });
    expect(r.push(created).chunks).toEqual([]);
    clock += 500;
    expect(r.push(inProgress).chunks.join("")).toContain("response.created");
  });

  it("releases after 48 held lines (frame budget)", () => {
    const r = reader();
    const steps = Array.from({ length: BOOTSTRAP_MAX_BUFFERED_FRAMES }, () => r.push(inProgress));
    expect(text(steps)).toBe("");
    expect(r.push(inProgress).chunks.join("")).toContain("response.in_progress");
  });

  it("releases when the byte budget would be exceeded", () => {
    const r = reader();

    const big = data({
      type: "response.in_progress",
      response: { id: "x".repeat(BOOTSTRAP_MAX_BUFFERED_BYTES) },
    });

    expect(r.push(created).chunks).toEqual([]);
    expect(r.push(big).chunks.join("")).toContain("response.created");
  });

  it("an unknown or non-empty frame releases immediately", () => {
    for (const frame of [
      data({ type: "response.web_search_call.in_progress", item_id: "w" }),
      data({
        type: "response.output_item.added",
        item: { type: "function_call", name: "f", arguments: '{"a":1}', call_id: "c" },
      }),
      data({
        type: "response.output_item.added",
        item: { type: "web_search_call", status: "in_progress" },
      }),
      data({ type: "response.content_part.added", part: { type: "output_text", text: "x" } }),
    ]) {
      const r = reader();
      expect(r.push(created).chunks).toEqual([]);
      expect(r.push(frame).chunks.join(""), frame).toContain("response.created");
    }
  });

  it("a clean EOF while holding fails the attempt without releasing; no data at all is a closed stream", () => {
    const r = reader();
    feed(r, [created, ""]);
    const end = r.end();
    expect(end.chunks).toEqual([]);
    expect(end.error?.status).toBe(408);
    const empty = reader().end();
    expect(empty.error?.status).toBe(502);
  });

  it("a terminal success releases everything at once", () => {
    const r = reader();
    feed(r, [created, ""]);
    const step = r.push(completed);
    expect(step.stop).toBe(true);
    expect(step.chunks.join("")).toContain("response.created");
    expect(step.chunks.join("")).toContain("response.completed");
  });

  it("grok clients get keepalive events as SSE comments (and they count as handshake)", () => {
    const r = reader({ grokClient: true });
    expect(r.push("event: keepalive").chunks).toEqual([]);
    expect(r.push(data({ type: "keepalive", sequence_number: 1 })).chunks).toEqual([]);
    const out = r.push(delta).chunks.join("");
    expect(out.match(/: keepalive/g)).toHaveLength(2);
    expect(isGrokClientHeaders(new Headers({ "user-agent": "grok-shell/1.0" }))).toBe(true);
    expect(isGrokClientHeaders(new Headers({ "user-agent": "curl" }))).toBe(false);
  });
});

describe("bootstrap helpers", () => {
  it("parses the timeout like StreamBootstrapTimeoutDuration", () => {
    const table: Array<[string, number]> = [
      ["", 0],
      ["0", 0],
      ["none", 0],
      ["Unlimited", 0],
      ["off", 0],
      ["10s", 10_000],
      ["500ms", 500],
      ["1h30m", 5_400_000],
      ["1.5s", 1500],
      ["15", 15_000],
      ["-5s", 0],
      ["-5", 0],
      ["abc", 0],
      ["10 s", 0],
      ["0s", 0],
    ];

    for (const [raw, ms] of table) expect(bootstrapTimeoutMs(raw), raw).toBe(ms);
  });

  it("classifies overload failures", () => {
    for (const body of [
      '{"error":{"code":"server_is_overloaded"}}',
      '{"error":{"type":"service_unavailable_error"}}',
      '{"error":{"type":"rate_limit_error"}}',
      '{"error":{"code":"rate_limit_exceeded"}}',
      '{"error":{"message":"Selected model is at capacity"}}',
      '{"error":{"type":"server_error","message":"An error occurred. You can retry your request."}}',
    ]) {
      expect(isOverloadBootstrapFailure(body), body).toBe(true);
    }

    for (const body of [
      '{"error":{"code":"invalid_prompt"}}',
      '{"error":{"type":"server_error","message":"boom"}}',
      "not json",
    ]) {
      expect(isOverloadBootstrapFailure(body), body).toBe(false);
    }
  });

  it("only buffers events that carry nothing observable", () => {
    const empty = (type: string, event: JsonObject = {}) =>
      isBootstrapBufferableEvent(type, "{}", { type, ...event });

    expect(isBootstrapBufferableEvent("", "  ", undefined)).toBe(true);
    expect(empty("keepalive")).toBe(true);
    expect(empty("codex.rate_limits")).toBe(true);
    expect(empty("response.metadata")).toBe(true);
    expect(empty("response.output_text.delta")).toBe(false);
    expect(
      empty("response.output_item.added", {
        item: { type: "reasoning", summary: [], content: [] },
      }),
    ).toBe(true);
    expect(
      empty("response.output_item.added", {
        item: { type: "reasoning", encrypted_content: "x", summary: [] },
      }),
    ).toBe(false);
    expect(
      empty("response.output_item.added", { item: { type: "custom_tool_call", input: "" } }),
    ).toBe(true);
    expect(
      empty("response.output_item.added", { item: { type: "custom_tool_call", input: "x" } }),
    ).toBe(false);
    expect(
      empty("response.output_item.added", {
        item: { type: "message", content: [{ type: "output_audio", audio: "x" }] },
      }),
    ).toBe(false);
    expect(
      empty("response.reasoning_summary_part.added", { part: { type: "summary_text", text: "" } }),
    ).toBe(true);
    expect(empty("response.content_part.added", { part: { type: "refusal", refusal: "no" } })).toBe(
      false,
    );
  });
});

describe("bootstrap failover through the conductor", () => {
  const identity = {
    principal: { kind: "user", email: "dev@example.com", sub: "sub" },
    principalId: "user:dev@example.com",
    callerScope: "scope-1",
    org: GLOBAL_ORG,
    platformAdmin: false,
  } as const;

  const request = {
    url: "/v1/responses",
    method: "POST",
    headers: {},
  } as unknown as HttpServerRequest.HttpServerRequest;

  const run = async (yaml: string, respond: (call: UpstreamCall) => Response) => {
    const harness = await makePool(yaml);

    for (const name of ["a", "b"]) {
      harness.store.upsert(`codex-${name}.json`, "codex", {
        type: "codex",
        access_token: `tok-${name}`,
        account_id: `acct-${name}`,
        expired: new Date(harness.clock.now() + 3_600_000).toISOString(),
      });
    }

    const calls: UpstreamCall[] = [];
    const records: UsageRecord[] = [];

    const layer = Layer.mergeAll(
      poolPickerLayer(harness.pool),
      Layer.succeed(
        ModelProviders,
        ModelProviders.of({
          providersFor: () => Effect.succeed(["codex"]),
          firstAvailableModel: Effect.succeed(undefined),
        }),
      ),
      ModelCapabilities.configLayer,
      ExecutorRegistry.layer,
      CredentialRefresher.none,
      UsageSink.memory(records),
      mockHttpClient(calls, respond),
      Thinking.live,
    ).pipe(Layer.provideMerge(staticConfigReader(harness.config)));

    const result = await Effect.runPromise(
      Effect.scoped(
        executeStream({
          entryProtocol: Formats.OpenAIResponse,
          model: "gpt-5.4",
          body: { model: "gpt-5.4", input: "hi", stream: true },
          alt: "",
          request,
        }).pipe(
          Effect.flatMap((output) =>
            Stream.runCollect(output.chunks).pipe(Effect.map((chunks) => [...chunks])),
          ),
        ),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(AccessPrincipal, identity),
        Effect.provideContext(envContext({} as Cloudflare.Env)),
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
        Effect.result,
      ),
    );

    return { calls, records, result };
  };

  const bearer = (call: UpstreamCall): string =>
    (call.headers["authorization"] ?? "").replace("Bearer ", "");

  const frames = (...lines: string[]): Response => sseResponse(lines.map((line) => `${line}\n\n`));

  const servedBy = (call: UpstreamCall) =>
    bearer(call) === "tok-a"
      ? frames(created, inProgress, overload)
      : frames(created, delta, completed);

  it("fails over to another credential when an overload rejection arrives inside an HTTP 200 stream", async () => {
    const outcome = await run(
      "upstream:\n  codex:\n    stream-bootstrap-buffering: true\n",
      servedBy,
    );

    expect(outcome.result._tag).toBe("Success");
    const out = Result.isSuccess(outcome.result) ? outcome.result.success.join("") : "";
    expect(out).toContain("response.completed");
    // The overloaded stream never reached the client.
    expect(out).not.toContain("server_is_overloaded");
    expect(outcome.calls.map(bearer).toSorted()).toEqual(["tok-a", "tok-b"]);
    expect(
      outcome.records.map((record) => record.failed).toSorted((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
  });

  it("fails an overload after a response.metadata frame over before any frame reaches the client", async () => {
    // Captured from upstream on 2026-10-21 (CLIProxyAPI 9e79552f).
    const moderation = data({
      type: "response.metadata",
      response_id: "r1",
      sequence_number: 2,
      metadata: { openai_chatgpt_moderation_metadata: { prompt: { omnimod: {} } } },
    });

    const outcome = await run(
      "upstream:\n  codex:\n    stream-bootstrap-buffering: true\n",
      (call) =>
        bearer(call) === "tok-a"
          ? frames(created, inProgress, moderation, overload)
          : frames(created, delta, completed),
    );

    expect(outcome.result._tag).toBe("Success");
    const out = Result.isSuccess(outcome.result) ? outcome.result.success.join("") : "";
    expect(out).toContain("response.completed");
    expect(out).not.toContain("response.metadata");
    expect(out).not.toContain("server_is_overloaded");
    expect(outcome.calls.map(bearer).toSorted()).toEqual(["tok-a", "tok-b"]);
  });

  it("without buffering the rejection is delivered in-stream (no failover)", async () => {
    const outcome = await run("", servedBy);
    // First call: whichever credential the picker chose; only the overloaded one fails the stream.
    const first = outcome.calls[0];

    if (first !== undefined && bearer(first) === "tok-a") {
      expect(outcome.calls).toHaveLength(1);
      expect(outcome.result._tag).toBe("Failure");
    } else {
      expect(outcome.result._tag).toBe("Success");
    }
  });
});

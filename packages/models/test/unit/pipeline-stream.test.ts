// Stream responder (bootstrap peek, framing, keep-alives with TestClock), protocol framers, the translator
// registry fallbacks and the legacy completions conversion.
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Predicate, Stream } from "effect";
import type { HttpBody } from "effect/http";
import { TestClock } from "effect/testing";
import { ExecutionError } from "../../src/executor/errors.ts";
import {
  chatResponseToCompletions,
  completionsRequestToChat,
} from "../../src/handlers/openai/completions.ts";
import {
  chunkHasFinishReason,
  claudeFramer,
  geminiFramer,
  interactionsFramer,
  openAIFramer,
  responsesFramer,
} from "../../src/handlers/framing.ts";
import { errorResponse, streamResponse } from "../../src/handlers/respond.ts";
import { get, type Json, set } from "@commissary/json";
import { structuralBody } from "@commissary/translation/testing";
import { type SummaryHooks, TranslationError, TranslatorRegistry } from "@commissary/translation";

const decoder = new TextDecoder();

const collectBody = (body: HttpBody.HttpBody) => {
  if (!Predicate.isTagged(body, "Stream")) return Effect.die("expected a stream body");

  return Stream.runCollect(Stream.orDie(body.stream)).pipe(
    Effect.map((parts) => parts.map((part) => decoder.decode(part)).join("")),
  );
};

const onError = (error: ExecutionError) =>
  errorResponse("openai", error, { passthroughHeaders: false });

const finished = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });

describe("streamResponse", () => {
  it.effect("writes keep-alive comments while the upstream is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const chunks = Stream.concat(
          Stream.make('{"choices":[]}'),
          Stream.fromEffect(Effect.sleep("25 seconds").pipe(Effect.as(finished))),
        );

        const response = yield* streamResponse(Effect.succeed({ chunks, headers: undefined }), {
          framer: openAIFramer(),
          onError,
          keepAliveSeconds: 10,
        });

        assert.strictEqual(response.status, 200);
        const fiber = yield* Effect.forkChild(collectBody(response.body));

        // Advance in small steps so the forked body fiber registers its timers before time moves on.
        for (let second = 0; second < 30; second++) {
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
        }

        const text = yield* Fiber.join(fiber);
        assert.strictEqual(
          text,
          `data: {"choices":[]}\n\n: keep-alive\n\n: keep-alive\n\ndata: ${finished}\n\ndata: [DONE]\n\n`,
        );
      }),
    ),
  );

  it.effect("turns a failure before the first chunk into an HTTP error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const chunks = Stream.fail(new ExecutionError({ status: 429, message: "busy" }));

        const response = yield* streamResponse(Effect.succeed({ chunks, headers: undefined }), {
          framer: openAIFramer(),
          onError,
          keepAliveSeconds: 0,
        });

        assert.strictEqual(response.status, 429);
      }),
    ),
  );

  it.effect("merges upstream headers without overriding SSE headers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* streamResponse(
          Effect.succeed({
            chunks: Stream.make(finished),
            headers: new Headers({ "content-type": "application/json", "x-request-id": "r1" }),
          }),
          { framer: openAIFramer(), onError, keepAliveSeconds: 0 },
        );

        assert.strictEqual(response.headers["content-type"], "text/event-stream");
        assert.strictEqual(response.headers["x-request-id"], "r1");
        assert.strictEqual(
          yield* collectBody(response.body),
          `data: ${finished}\n\ndata: [DONE]\n\n`,
        );
      }),
    ),
  );
});

describe("framers", () => {
  it("detects finish reasons like gjson", () => {
    expect(chunkHasFinishReason('data: {"choices":[{"finish_reason":"stop"}]}')).toBe(true);
    expect(chunkHasFinishReason('{"choices":[{"finish_reason":null}]}')).toBe(false);
    expect(chunkHasFinishReason('{"choices":[{"finish_reason":""}]}')).toBe(false);
    expect(chunkHasFinishReason('{"choices":[{"finish_reason":false}]}')).toBe(true);
  });

  it("claude frames errors as event: error", () => {
    const framer = claudeFramer();
    expect(framer.chunk("event: ping\ndata: {}\n\n")).toBe("event: ping\ndata: {}\n\n");
    expect(framer.terminalError(new ExecutionError({ status: 529, message: "busy" }))).toBe(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
    );
    expect(framer.emptyBody).toContain("message_stop");
  });

  describe("claude framer event boundaries and completion (Go 4f2e5270)", () => {
    const bad = new ExecutionError({ status: 502, message: "cut" });
    const errorEvent = '{"type":"error","error":{"type":"api_error","message":"failed"}}';

    it("starts the terminal error on a fresh line after a partial line", () => {
      const framer = claudeFramer();
      framer.chunk('event: content_block_delta\ndata: {"type":"content_block_delta"');
      expect(framer.terminalError(bad)).toMatch(/^\n\nevent: error\ndata: /);
    });

    it("inserts the blank line after a single newline", () => {
      const framer = claudeFramer();
      framer.chunk('event: content_block_delta\ndata: {"type":"content_block_delta"}\n');
      expect(framer.terminalError(bad)).toMatch(/^\nevent: error\ndata: /);
    });

    it.each(["", "\n"])(
      "terminates an error event cut after %j and writes nothing more",
      (suffix) => {
        const framer = claudeFramer();
        framer.chunk(`event: error\ndata: ${errorEvent}${suffix}`);
        expect(framer.closeError()).toBeUndefined();
        expect(framer.terminalError(bad)).toBe(suffix === "" ? "\n\n" : "\n");
      },
    );

    it.each(["", "\n"])("terminates a message_stop cut after %j on close", (suffix) => {
      const framer = claudeFramer();
      framer.chunk(`event: message_stop\ndata: {"type":"message_stop"}${suffix}`);
      expect(framer.closeError()).toBeUndefined();
      expect(framer.done()).toBe(suffix === "" ? "\n\n" : "\n");
    });

    it("reads message_stop across a multi-line data event and ignores one inside another event", () => {
      const split = claudeFramer();
      split.chunk('event: message_stop\ndata: {"type":\n');
      split.chunk('data: "message_stop"}\n\n');
      expect(split.closeError()).toBeUndefined();

      const nested = claudeFramer();
      nested.chunk('event: content_block_delta\ndata: {"type":"content_block_delta","delta":\n');
      nested.chunk('data: {"type":"message_stop"}}\n\n');
      expect(nested.closeError()?.status).toBe(502);
    });

    it("fails a truncated error-event header and a stream without message_stop", () => {
      const framer = claudeFramer();
      framer.chunk("event: error\n");
      expect(framer.closeError()?.message).toBe("upstream stream closed before message_stop");
      expect(framer.terminalError(bad)).toContain('event: error\ndata: {"type":"error"');
    });

    it("accepts a bare completed message JSON without framing", () => {
      const framer = claudeFramer();
      framer.chunk('{"type":"message","id":"msg_1","stop_reason":"end_turn"}');
      expect(framer.closeError()).toBeUndefined();
      expect(framer.done()).toBe("");
    });
  });

  it("gemini honours alt", () => {
    expect(geminiFramer("").chunk("{}")).toBe("data: {}\n\n");
    expect(geminiFramer("json").chunk("{}")).toBe("{}");
    expect(geminiFramer("json").keepAlive).toBeUndefined();
    expect(geminiFramer("").terminalError(new ExecutionError({ status: 500, message: "x" }))).toBe(
      'event: error\ndata: {"error":{"message":"x","type":"server_error","code":"internal_server_error"}}\n\n',
    );
  });

  it("interactions adds missing SSE framing", () => {
    const framer = interactionsFramer();
    expect(framer.chunk("{}")).toBe("data: {}\n\n");
    expect(framer.chunk("event: x\ndata: {}\n")).toBe("event: x\ndata: {}\n\n");
  });

  it("responses requires a terminal event and numbers error frames", () => {
    const framer = responsesFramer({ codexClient: false });
    framer.chunk(
      'event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n',
    );
    expect(framer.closeError()?.message).toBe(
      "upstream stream closed before a terminal event (last event: response.created)",
    );
    expect(
      structuralBody(framer.terminalError(new ExecutionError({ status: 502, message: "x" }))),
    ).toEqual(
      structuralBody(
        'event: error\ndata: {"type":"error","error":{"code":"internal_server_error","message":"x","param":null,"type":"server_error"},"sequence_number":1}\n\n',
      ),
    );
    framer.chunk('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    expect(framer.closeError()).toBeUndefined();
    expect(framer.done()).toBe("\n");
    const codex = responsesFramer({ codexClient: true });
    expect(codex.closeError()?.message).toBe("upstream stream closed before first payload");
    expect(codex.terminalError(new ExecutionError({ status: 401, message: "no" }))).toMatch(
      /^event: response\.failed\n/,
    );
  });
});

describe("TranslatorRegistry", () => {
  it("falls back to forcing the model on a copy", () => {
    const registry = new TranslatorRegistry();
    const body = { model: "a", x: 1 };

    const out = registry.translateRequest("claude", "claude", {
      format: "claude",
      model: "b",
      stream: false,
      body,
    });

    expect(out.body).toEqual({ model: "b", x: 1 });
    expect(out.format).toBe("claude");
    expect(body.model).toBe("a");
    expect(registry.translateStream("claude", "claude", ctx(), "event: x")).toEqual(["event: x"]);
    expect(registry.translateNonStream("claude", "claude", ctx(), "raw")).toBe("raw");
    expect(registry.translateTokenCount("claude", "claude", 3, '{"n":3}')).toBe('{"n":3}');
  });

  it("wraps request transforms in the summary hooks and reports refusals", () => {
    const registry = new TranslatorRegistry()
      .register("a", "b", (model, body) => ({ ...(body as object), model, translated: true }), {})
      .register(
        "a",
        "c",
        () => {
          throw new TranslationError("unsupported part");
        },
        {},
      );

    const hooks: SummaryHooks = {
      extract: (body) => get(body, "summary"),
      apply: (body, _to, _model, summary) => set(body, "applied", summary as Json),
    };

    const out = registry.translateRequest(
      "a",
      "b",
      { format: "a", model: "m", stream: false, body: { summary: "s" } },
      hooks,
    );

    expect(out.body).toEqual({ summary: "s", model: "m", translated: true, applied: "s" });
    expect(registry.hasResponseTransformer("a", "b")).toBe(false);

    const refused = registry.translateRequest("a", "c", {
      format: "a",
      model: "m",
      stream: false,
      body: {},
    });

    expect(refused.error?.message).toBe("unsupported part");
    expect(refused.error?.status).toBe(400);
  });

  it("suppresses non-stream output after a retained tool-input error", () => {
    const registry = new TranslatorRegistry().register("a", "b", undefined, {
      nonStream: (context, body) => {
        context.state.toolInputError = "bad";

        return body;
      },
    });

    expect(registry.translateNonStream("a", "b", ctx(), "x")).toBeUndefined();
  });
});

const ctx = () => ({
  model: "m",
  originalRequest: undefined,
  translatedRequest: undefined,
  state: { value: undefined },
});

describe("legacy completions conversion", () => {
  it("builds chat requests like Go", () => {
    expect(
      completionsRequestToChat({ prompt: ["a", "b"], max_tokens: 3.7, stream: "true", echo: 1 }),
    ).toEqual({
      model: "",
      messages: [{ role: "user", content: '["a","b"]' }],
      max_tokens: 3,
      stream: true,
      echo: true,
    });
    expect(completionsRequestToChat({ model: "m" })).toEqual({
      model: "m",
      messages: [{ role: "user", content: "Complete this:" }],
    });
  });

  it("converts responses with null finish reasons and logprobs", () => {
    expect(
      JSON.parse(
        chatResponseToCompletions(
          '{"id":"x","choices":[{"index":1,"message":{"content":null},"finish_reason":null,"logprobs":{"b":1,"a":2}}]}',
        ),
      ),
    ).toEqual(
      JSON.parse(
        '{"id":"x","object":"text_completion","created":0,"model":"","choices":[{"finish_reason":"","index":1,"logprobs":{"a":2,"b":1},"text":""}]}',
      ),
    );
  });
});

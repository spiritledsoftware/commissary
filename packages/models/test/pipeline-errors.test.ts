// Error bodies per protocol (Go: handlers.go BuildErrorResponseBodyWithError, claude/code_handlers.go,
// openai_responses_stream_error.go) and related HTTP helpers.
import { describe, expect, it } from "vitest";
import { claudeFramer } from "../src/handlers/framing.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import { enrichSelectionError } from "../src/handlers/execute.ts";
import { decodeRequestBody, RequestBodyDecodeError } from "../src/http/body.ts";
import {
  claudeCooldownRetryAfter,
  claudeErrorBody,
  openAIErrorBody,
  responsesStreamErrorChunk,
  responsesStreamFailedChunk,
} from "../src/http/errors.ts";
import { filterUpstreamHeaders, mergeUpstreamHeaders } from "../src/http/headers.ts";
import { compactJson, stableStringify } from "@commissary/json";

describe("openAIErrorBody", () => {
  it.each([
    [401, '{"error":{"message":"m","type":"authentication_error","code":"invalid_api_key"}}'],
    [403, '{"error":{"message":"m","type":"permission_error","code":"insufficient_quota"}}'],
    [429, '{"error":{"message":"m","type":"rate_limit_error","code":"rate_limit_exceeded"}}'],
    [404, '{"error":{"message":"m","type":"invalid_request_error","code":"model_not_found"}}'],
    [408, '{"error":{"message":"m","type":"server_error","code":"request_timeout"}}'],
    [503, '{"error":{"message":"m","type":"server_error","code":"internal_server_error"}}'],
    [400, '{"error":{"message":"m","type":"invalid_request_error"}}'],
  ])("maps status %i", (status, body) => {
    expect(openAIErrorBody(status, "m")).toBe(body);
  });

  it("uses the status text for empty messages and 500 for invalid statuses", () => {
    expect(openAIErrorBody(502, "  ")).toBe(
      '{"error":{"message":"Bad Gateway","type":"server_error","code":"internal_server_error"}}',
    );
    expect(openAIErrorBody(0, "")).toBe(
      '{"error":{"message":"Internal Server Error","type":"server_error","code":"internal_server_error"}}',
    );
  });

  it("compacts JSON text verbatim (number text and escapes preserved)", () => {
    expect(openAIErrorBody(400, ' {\n "error" : { "n": 1.50, "s": "a b\\u00e9" } }\n')).toBe(
      '{"error":{"n":1.50,"s":"a b\\u00e9"}}',
    );
  });

  it("does not HTML-escape messages", () => {
    expect(openAIErrorBody(400, "<a & b>")).toBe(
      '{"error":{"message":"<a & b>","type":"invalid_request_error"}}',
    );
  });

  it("builds terminal auth errors from nested messages", () => {
    expect(
      openAIErrorBody(401, '{"error":{"message":"token revoked"}}', { terminalAuth: true }),
    ).toBe(
      '{"error":{"message":"token revoked","type":"authentication_error","code":"upstream_authentication_required","retryable":false}}',
    );
  });
});

describe("claudeErrorBody", () => {
  it.each([
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [409, "conflict_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [408, "timeout_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"],
    [500, "api_error"],
    [422, "invalid_request_error"],
  ])("maps status %i to %s", (status, type) => {
    expect(JSON.parse(claudeErrorBody(status, "x"))).toEqual({
      type: "error",
      error: { type, message: "x" },
    });
  });

  it("takes type and message from JSON error text", () => {
    expect(claudeErrorBody(400, '{"error":{"type":"overloaded_error","message":" busy "}}')).toBe(
      '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}',
    );
    expect(claudeErrorBody(400, '{"error":{"code":"some_code"}}')).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"some_code"}}',
    );
    expect(claudeErrorBody(500, '{"type":"error","message":"top"}')).toBe(
      '{"type":"error","error":{"type":"api_error","message":"top"}}',
    );
  });

  it("marks thread_not_found", () => {
    const body = claudeErrorBody(
      404,
      '{"error":{"type":"not_found_error","message":"Thread state for previous_message_id was not found"}}',
    );

    expect(JSON.parse(body)).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Thread state for previous_message_id was not found",
        details: { error_code: "thread_not_found" },
      },
    });
  });
});

const COOLDOWN_MESSAGE =
  "All credentials for model claude-sonnet-4-5-20250929 are cooling down via provider claude";

const cooldown = (seconds: number, status = 429) =>
  new ExecutionError({
    status,
    code: "model_cooldown",
    message: JSON.stringify({
      error: {
        code: "model_cooldown",
        message: COOLDOWN_MESSAGE,
      },
    }),
    safeHeaders: { "retry-after": String(seconds) },
  });

const messageOf = (body: string): string => JSON.parse(body).error.message;

// Go e458999b: a 429 model-cooldown error says when it resets (code_handlers.go toClaudeErrorWithRetryAfter).
describe("Claude model-cooldown reset hint", () => {
  it.each([
    [8250, "2h17m30s"],
    [61, "1m1s"],
    [9223372037, "9223372037s"],
  ])("appends the Retry-After %i s as (reset after %s)", (seconds, shown) => {
    const error = cooldown(seconds);

    const body = claudeErrorBody(429, error.message, claudeCooldownRetryAfter(error));

    expect(messageOf(body)).toBe(`${COOLDOWN_MESSAGE} (reset after ${shown})`);
  });

  it("reaches the committed stream error event", () => {
    const frame = claudeFramer().terminalError(cooldown(8250));

    expect(messageOf(frame.replace(/^event: error\ndata: /, "").trim())).toBe(
      `${COOLDOWN_MESSAGE} (reset after 2h17m30s)`,
    );
  });

  it("leaves an ordinary upstream 429 message unchanged", () => {
    const ordinary = new ExecutionError({
      status: 429,
      message: '{"error":{"type":"rate_limit_error","message":"upstream quota exceeded"}}',
      safeHeaders: { "retry-after": "300" },
    });

    expect(
      messageOf(claudeErrorBody(429, ordinary.message, claudeCooldownRetryAfter(ordinary))),
    ).toBe("upstream quota exceeded");
  });

  it("adds no hint for a zero delay", () => {
    const zero = cooldown(0);

    expect(messageOf(claudeErrorBody(429, zero.message, claudeCooldownRetryAfter(zero)))).toBe(
      COOLDOWN_MESSAGE,
    );
  });

  it("adds no hint for a Retry-After above int64", () => {
    const huge = cooldown(0);
    const body = claudeErrorBody(429, huge.message, "9223372036854775808");

    expect(messageOf(body)).toBe(COOLDOWN_MESSAGE);
  });

  it("adds no hint for other statuses", () => {
    const unavailable = cooldown(60, 503);

    expect(
      messageOf(claudeErrorBody(503, unavailable.message, claudeCooldownRetryAfter(unavailable))),
    ).toBe(COOLDOWN_MESSAGE);
  });
});

describe("Responses stream error chunks", () => {
  it("builds error events with detail keys in build order", () => {
    expect(responsesStreamErrorChunk(429, "slow down", 3)).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","code":"rate_limit_exceeded","message":"slow down","param":null},"sequence_number":3}',
    );
  });

  it("reuses upstream error objects and sequence numbers", () => {
    expect(
      responsesStreamErrorChunk(500, '{"error":{"message":"x","code":"c"},"sequence_number":9}', 1),
    ).toBe('{"type":"error","error":{"message":"x","code":"c"},"sequence_number":9}');
  });

  it("maps an Anthropic prompt overflow to context_length_exceeded (Go 43f27e3a)", () => {
    const overflow =
      '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}';

    const error = JSON.parse(responsesStreamErrorChunk(400, overflow, 0)).error;

    const failed = JSON.parse(responsesStreamFailedChunk(400, overflow, 0)).response.error;

    for (const detail of [error, failed]) {
      expect(detail).toEqual({
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "prompt is too long: 210000 tokens > 200000 maximum",
      });
    }

    const withCode = JSON.parse(
      responsesStreamFailedChunk(
        400,
        '{"type":"error","error":{"type":"invalid_request_error","code":"custom_code","message":"prompt is too long: 1"}}',
        0,
      ),
    ).response.error;

    expect(withCode.code).toBe("custom_code");

    const nested = JSON.parse(
      responsesStreamFailedChunk(
        400,
        '{"response":{"error":{"type":"invalid_request_error","message":"prompt is too long: 1"}}}',
        0,
      ),
    ).response.error;

    expect(nested.code).toBe("context_length_exceeded");
  });

  it("builds response.failed events", () => {
    expect(responsesStreamFailedChunk(502, "gone", 0)).toBe(
      '{"type":"response.failed","sequence_number":0,"response":{"status":"failed","error":{"type":"server_error","code":"internal_server_error","message":"gone","param":null}}}',
    );
  });
});

describe("json-text helpers", () => {
  it("compacts without touching strings", () => {
    expect(compactJson('{ "a" : "x  y\\" z" ,\n "b":[1, 2] }')).toBe('{"a":"x  y\\" z","b":[1,2]}');
  });

  it("stableStringify sorts keys recursively with plain JSON.stringify escaping", () => {
    expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: "<&>\u2028" } })).toBe(
      '{"a":{"c":"<&>\u2028","d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it("stableStringify is independent of key insertion order", () => {
    expect(stableStringify({ a: [{ y: 1, x: null }], b: "s" })).toBe(
      stableStringify({ b: "s", a: [{ x: null, y: 1 }] }),
    );
    expect(stableStringify(JSON.parse('{"__proto__":1,"a":2}'))).toBe('{"__proto__":1,"a":2}');
  });
});

describe("enrichSelectionError", () => {
  it("adds providers and model to auth selection errors", () => {
    const error = enrichSelectionError(
      new ExecutionError({ status: 503, code: "auth_not_found", message: "no auth available" }),
      ["claude", "x"],
      "m(high)",
    );

    expect(error.message).toBe(
      "no auth available (providers=claude,x, model=m(high)); check Claude auth/key session and cooldown state via /v0/management/auth-files",
    );
    expect(error.status).toBe(503);
  });

  it("leaves other errors alone", () => {
    const original = new ExecutionError({ status: 429, message: "x" });
    expect(enrichSelectionError(original, ["a"], "m")).toBe(original);
  });
});

describe("upstream header filtering", () => {
  it("drops hop-by-hop, reserved, connection-scoped and gateway headers", () => {
    const filtered = filterUpstreamHeaders(
      new Headers({
        connection: "keep-alive, X-Drop",
        "x-drop": "1",
        "transfer-encoding": "chunked",
        "content-length": "10",
        "set-cookie": "a=b",
        "access-control-allow-origin": "x",
        "cf-aig-cache-status": "HIT",
        "x-litellm-version": "1",
        "x-request-id": "keep",
      }),
    );

    expect([...filtered.keys()]).toEqual(["x-request-id"]);
  });

  it("does not overwrite Commissary's headers", () => {
    expect(
      mergeUpstreamHeaders(
        { "content-type": "application/json" },
        new Headers({ "Content-Type": "x", "x-a": "1" }),
      ),
    ).toEqual({ "content-type": "application/json", "x-a": "1" });
  });
});

describe("request body decoding", () => {
  const zstd = Uint8Array.from(atob("KLUv/QRYaQAAeyJtb2RlbCI6Im0ifSeLfGQ="), (ch) =>
    ch.charCodeAt(0),
  );

  it("decodes zstd and identity lists right to left", () => {
    expect(decodeRequestBody(zstd, "zstd")).toBe('{"model":"m"}');
    expect(decodeRequestBody(zstd, "identity, zstd")).toBe('{"model":"m"}');
    expect(decodeRequestBody(new TextEncoder().encode("{}"), "identity")).toBe("{}");
  });

  it("falls back to raw JSON and rejects unknown encodings", () => {
    expect(decodeRequestBody(new TextEncoder().encode('{"a":1}'), "zstd")).toBe('{"a":1}');
    expect(() => decodeRequestBody(new TextEncoder().encode("x"), "br")).toThrow(
      RequestBodyDecodeError,
    );
    expect(() => decodeRequestBody(new TextEncoder().encode("x"), "zstd")).toThrow(
      /failed to decode zstd/,
    );
  });
});

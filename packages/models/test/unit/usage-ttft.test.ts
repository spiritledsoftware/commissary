// TTFT: token-event detection per protocol (helps/*_ttft_helpers.go) and the reporter's first-packet fallback.
import { describe, expect, it } from "vitest";
import { UsageReporter } from "../../src/usage/reporter.ts";
import {
  isChatTokenEvent,
  isClaudeTokenEvent,
  isGeminiTokenEvent,
  isResponsesTokenEvent,
  isTokenEvent,
  tokenEventProtocolOf,
} from "../../src/usage/ttft.ts";
import { GLOBAL_ORG } from "@commissary/core";

describe("token events", () => {
  it("chat completions", () => {
    expect(isChatTokenEvent('data: {"choices":[{"delta":{"role":"assistant"}}]}')).toBe(false);
    expect(isChatTokenEvent('data: {"choices":[{"delta":{"content":""}}]}')).toBe(false);
    expect(isChatTokenEvent('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBe(true);
    expect(isChatTokenEvent('data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}')).toBe(true);
    expect(
      isChatTokenEvent('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"f"}}]}}]}'),
    ).toBe(true);
    expect(isChatTokenEvent('{"choices":[{"message":{"content":"full"}}]}')).toBe(true);
    expect(isChatTokenEvent('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}')).toBe(true);
    expect(isChatTokenEvent("data: [DONE]")).toBe(true);
    expect(isChatTokenEvent('data: {"error":{"message":"x"}}')).toBe(true);
    expect(isChatTokenEvent('data: {"usage":{"prompt_tokens":1}}')).toBe(false);
    expect(isChatTokenEvent("")).toBe(false);
  });

  it("Claude messages", () => {
    expect(isClaudeTokenEvent('data: {"type":"message_start","message":{}}')).toBe(false);
    expect(isClaudeTokenEvent('data: {"type":"ping"}')).toBe(false);
    expect(
      isClaudeTokenEvent(
        'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}',
      ),
    ).toBe(false);
    expect(
      isClaudeTokenEvent(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}',
      ),
    ).toBe(true);
    expect(
      isClaudeTokenEvent('data: {"type":"content_block_delta","delta":{"thinking":"x"}}'),
    ).toBe(true);
    expect(
      isClaudeTokenEvent(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"partial_json":"{"}}',
      ),
    ).toBe(true);
    expect(
      isClaudeTokenEvent('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}'),
    ).toBe(true);
    expect(isClaudeTokenEvent('data: {"type":"message_delta","delta":{}}')).toBe(false);
    expect(isClaudeTokenEvent('data: {"type":"message_stop"}')).toBe(true);
    expect(isClaudeTokenEvent('{"content":[{"type":"tool_use","name":"f"}]}')).toBe(true);
  });

  it("Gemini and Antigravity", () => {
    expect(isGeminiTokenEvent('data: {"usageMetadata":{"promptTokenCount":3}}')).toBe(false);
    expect(isGeminiTokenEvent('data: {"candidates":[{"content":{"parts":[{"text":""}]}}]}')).toBe(
      false,
    );
    expect(isGeminiTokenEvent('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}')).toBe(
      true,
    );
    expect(
      isGeminiTokenEvent(
        'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"f"}}]}}]}}',
      ),
    ).toBe(true);
    expect(isGeminiTokenEvent('data: {"candidates":[{"finishReason":"STOP"}]}')).toBe(true);
    expect(isGeminiTokenEvent('data: {"error":{"message":"x"}}')).toBe(true);
  });

  // Go f434192a TestIsResponsesTokenEvent_CompletedReasoning.
  it.each([
    [
      "summary text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]}}',
      true,
    ],
    [
      "content text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","content":[{"type":"reasoning_text","text":"thinking"}]}}',
      true,
    ],
    [
      "later summary part",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":""},{"text":"thinking"}]}}',
      true,
    ],
    [
      "empty summary with content text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":""}],"content":[{"text":"thinking"}]}}',
      true,
    ],
    [
      "whitespace text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":" "}]}}',
      true,
    ],
    [
      "SSE text",
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":"thinking"}]}}',
      true,
    ],
    [
      "empty arrays",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[],"content":[]}}',
      false,
    ],
    [
      "empty text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":""}],"content":[{"text":""}]}}',
      false,
    ],
    [
      "missing text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"type":"summary_text"}],"content":[{}]}}',
      false,
    ],
    [
      "null text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":null}]}}',
      false,
    ],
    ["missing parts", '{"type":"response.output_item.done","item":{"type":"reasoning"}}', false],
    [
      "encrypted only",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[],"encrypted_content":"opaque"}}',
      false,
    ],
    [
      "malformed numeric text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":123}]}}',
      false,
    ],
    [
      "malformed object text",
      '{"type":"response.output_item.done","item":{"type":"reasoning","content":[{"text":{"value":"thinking"}}]}}',
      false,
    ],
    [
      "added stays metadata",
      '{"type":"response.output_item.added","item":{"type":"reasoning","summary":[{"text":"thinking"}]}}',
      false,
    ],
  ])("Responses completed reasoning: %s", (_name, payload, want) => {
    expect(isResponsesTokenEvent(payload)).toBe(want);
  });

  it("a completed reasoning item keeps the earlier first-token time", () => {
    const usage = new UsageReporter({
      requestId: "r",
      provider: "meta",
      executorType: "meta",
      model: "m",
      alias: "m",
      endpoint: "POST /x",
      principalId: "p",
      orgId: GLOBAL_ORG,
      authId: "a",
      authType: "apikey",
      source: "s",
      stream: true,
      serviceTier: "auto",
      requestedAt: 0,
    });

    usage.observeTokenEvent(
      100,
      isResponsesTokenEvent('{"type":"response.reasoning_summary_text.delta","delta":"thinking"}'),
    );

    usage.observeTokenEvent(
      1100,
      isResponsesTokenEvent(
        '{"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":"thinking"}]}}',
      ),
    );

    expect(usage.finish(1200)?.ttftMs).toBe(100);
  });

  it("Responses", () => {
    expect(isResponsesTokenEvent('data: {"type":"response.created","response":{}}')).toBe(false);
    expect(isResponsesTokenEvent('data: {"type":"response.output_text.delta","delta":""}')).toBe(
      false,
    );
    expect(isResponsesTokenEvent('data: {"type":"response.output_text.delta","delta":"x"}')).toBe(
      true,
    );
    expect(isResponsesTokenEvent('data: {"type":"response.output_text.done","text":"x"}')).toBe(
      true,
    );
    expect(
      isResponsesTokenEvent(
        'data: {"type":"response.output_item.done","item":{"type":"function_call","arguments":"{}"}}',
      ),
    ).toBe(true);
    expect(
      isResponsesTokenEvent(
        'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"text":"x"}]}}',
      ),
    ).toBe(true);
    expect(
      isResponsesTokenEvent(
        'data: {"type":"response.output_item.done","item":{"type":"reasoning"}}',
      ),
    ).toBe(false);
    expect(isResponsesTokenEvent('data: {"type":"response.completed","response":{}}')).toBe(true);
    expect(isResponsesTokenEvent('data: {"type":"error"}')).toBe(true);
  });

  it("dispatches by protocol", () => {
    expect(tokenEventProtocolOf("codex")).toBe("responses");
    expect(tokenEventProtocolOf("openai-response")).toBe("responses");
    expect(tokenEventProtocolOf("Claude")).toBe("claude");
    expect(tokenEventProtocolOf("antigravity")).toBe("gemini");
    expect(tokenEventProtocolOf("openai")).toBe("chat");
    expect(isTokenEvent("gemini", 'data: {"candidates":[{"finishReason":"STOP"}]}')).toBe(true);
  });
});

describe("UsageReporter TTFT", () => {
  const reporter = () =>
    new UsageReporter({
      requestId: "r",
      provider: "codex",
      executorType: "codex",
      model: "m",
      alias: "m",
      endpoint: "POST /v1/responses",
      principalId: "p",
      orgId: GLOBAL_ORG,
      authId: "a",
      authType: "oauth",
      source: "s",
      stream: true,
      serviceTier: "auto",
      requestedAt: 1000,
    });

  it("the first byte is the effective TTFT", () => {
    const usage = reporter();
    usage.markFirstByte(1250);
    usage.markFirstByte(1900);
    expect(usage.finish(3000)?.ttftMs).toBe(250);
  });

  it("a token event wins over the first-packet fallback; later events are ignored", () => {
    const usage = reporter();
    usage.recordFirstPacket(1100);
    usage.observeTokenEvent(1150, false);
    expect(usage.ttftObserved).toBe(false);
    usage.observeTokenEvent(1400, true);
    usage.observeTokenEvent(1500, true);
    expect(usage.ttftObserved).toBe(true);
    expect(usage.finish(3000)?.ttftMs).toBe(400);
  });

  it("falls back to the first packet when no token event arrived", () => {
    const usage = reporter();
    usage.observeTokenEvent(1100, false);
    usage.observeTokenEvent(1200, false);
    expect(usage.finish(3000)?.ttftMs).toBe(100);
  });

  it("has no TTFT without any upstream byte", () => {
    expect(reporter().finish(3000)?.ttftMs).toBeUndefined();
  });
});

// Token accounting v2 and the usage parsers, ported from sdk/cliproxy/usage/accounting_test.go and
// internal/runtime/executor/helps/usage_helpers_test.go (+ plugin_executor_usage.go merge rules).
import { describe, expect, it } from "vitest";
import { parseCodexUsage } from "../../src/executor/codex/output.ts";
import {
  ensureTokenBreakdown,
  independentTokenBreakdown,
  isValidTokenBreakdown,
  partialSubsetTokenBreakdown,
  separateReasoningTokenBreakdown,
  subsetTokenBreakdown,
  tokenAccountingSemanticsFor,
  unclassifiedTokenBreakdown,
} from "../../src/usage/accounting.ts";
import {
  mergeStreamUsageDetail,
  parseAntigravityStreamUsage,
  parseAntigravityUsage,
  parseClaudeStreamUsage,
  parseClaudeUsage,
  parseGeminiStreamUsage,
  parseGeminiUsage,
  parseInteractionsStreamUsage,
  parseInteractionsUsage,
} from "../../src/usage/parsers.ts";
import {
  emptyUsageDetail,
  parseOpenAIStreamUsage,
  parseOpenAIUsage,
  type UsageDetail,
} from "../../src/usage/record.ts";
import { UsageReporter } from "../../src/usage/reporter.ts";
import { GLOBAL_ORG } from "@commissary/core";

const MAX = Number.MAX_SAFE_INTEGER;

const detail = (fields: Partial<UsageDetail>): UsageDetail => ({ ...emptyUsageDetail, ...fields });

describe("token breakdown constructors (accounting_test.go)", () => {
  it("subset: cache and reasoning are not double counted", () => {
    const b = subsetTokenBreakdown(100, 40, 10, 30, 12, 130);
    expect(isValidTokenBreakdown(b)).toBe(true);
    expect(b.input.uncachedTokens).toBe(50);
    expect(b.output.nonReasoningTokens).toBe(18);
    expect(b.totalTokens).toBe(130);
  });

  it("partial subset keeps the known buckets and the authoritative remainder", () => {
    const b = partialSubsetTokenBreakdown(10, 4, 0, 0, 0, 15);
    expect(isValidTokenBreakdown(b)).toBe(true);
    expect(b).toMatchObject({
      quality: "unclassified",
      unclassifiedTokens: 5,
      input: { totalTokens: 10 },
    });
  });

  it("independent keeps Claude cache buckets outside the input", () => {
    const b = independentTokenBreakdown(30, 7, 13, 5, 0, 55);
    expect(isValidTokenBreakdown(b)).toBe(true);
    expect(b.input.totalTokens).toBe(50);
    expect(b.totalTokens).toBe(55);
  });

  it("separate reasoning adds reasoning to the output", () => {
    const b = separateReasoningTokenBreakdown(20, 5, 0, 7, 3, 30);
    expect(isValidTokenBreakdown(b)).toBe(true);
    expect(b.output.totalTokens).toBe(10);
    expect(b.totalTokens).toBe(30);
  });

  it("contradictory parents are inconsistent", () => {
    const b = subsetTokenBreakdown(10, 4, 0, 3, 1, 20);
    expect(isValidTokenBreakdown(b)).toBe(true);
    expect(b).toMatchObject({ quality: "inconsistent", unclassifiedTokens: 20 });
  });

  it("unclassified does not guess buckets", () => {
    const b = unclassifiedTokenBreakdown(42);
    expect(isValidTokenBreakdown(b)).toBe(true);
    expect(b).toMatchObject({ quality: "unclassified", unclassifiedTokens: 42 });
  });

  it("rejects arithmetic overflow", () => {
    const subset = subsetTokenBreakdown(MAX, MAX, MAX, 0, 0, MAX);
    expect(subset.quality).not.toBe("complete");
    expect(subset.input.uncachedTokens).toBeGreaterThanOrEqual(0);
    const separate = separateReasoningTokenBreakdown(MAX, MAX, MAX, 0, 0, MAX);
    expect(separate.quality).not.toBe("complete");
    expect(separate.input.uncachedTokens).toBeGreaterThanOrEqual(0);

    const overflowing = {
      schemaVersion: 2,
      quality: "complete" as const,
      totalTokens: 0,
      input: { totalTokens: 0, uncachedTokens: MAX, cacheReadTokens: MAX, cacheWriteTokens: 2 },
      output: { totalTokens: 0, nonReasoningTokens: 0, reasoningTokens: 0 },
      unclassifiedTokens: 0,
    };

    expect(isValidTokenBreakdown(overflowing)).toBe(false);
  });
});

describe("ensureTokenBreakdown per provider semantics", () => {
  const sample = detail({
    inputTokens: 100,
    outputTokens: 30,
    reasoningTokens: 12,
    cacheReadTokens: 40,
    cacheCreationTokens: 10,
  });

  it.each([
    {
      name: "OpenAI subsets cache and reasoning",
      provider: "openai",
      executor: "",
      total: 130,
      input: 100,
      output: 30,
    },
    {
      name: "openai-compatible executor takes precedence",
      provider: "anthropic",
      executor: "OpenAICompatExecutor",
      total: 130,
      input: 100,
      output: 30,
    },
    {
      name: "openai-compatible provider",
      provider: "openai-compatible-x",
      executor: "",
      total: 130,
      input: 100,
      output: 30,
    },
    {
      name: "Gemini keeps reasoning separate",
      provider: "gemini",
      executor: "",
      total: 142,
      input: 100,
      output: 42,
    },
    {
      name: "Antigravity is separate-reasoning",
      provider: "antigravity",
      executor: "",
      total: 142,
      input: 100,
      output: 42,
    },
    {
      name: "Claude keeps cache and reasoning independent",
      provider: "claude",
      executor: "",
      total: 192,
      input: 150,
      output: 42,
    },
  ])("$name", ({ provider, executor, total, input, output }) => {
    const result = ensureTokenBreakdown(sample, provider, executor);
    expect(isValidTokenBreakdown(result.tokenBreakdown)).toBe(true);
    expect(result.tokenBreakdown?.quality).toBe("complete");
    expect(result.totalTokens).toBe(total);
    expect(result.tokenBreakdown).toMatchObject({
      totalTokens: total,
      input: { totalTokens: input },
      output: { totalTokens: output },
    });
  });

  it("semantics lookup", () => {
    expect(tokenAccountingSemanticsFor("xai", "")).toBe("subset");
    expect(tokenAccountingSemanticsFor("kimi", "")).toBe("subset");
    expect(tokenAccountingSemanticsFor("vertex", "")).toBe("separate-reasoning");
    expect(tokenAccountingSemanticsFor("gemini-interactions", "")).toBe("separate-reasoning");
    expect(tokenAccountingSemanticsFor("plugin-provider", "")).toBe("unknown");
    expect(tokenAccountingSemanticsFor("unknown", "unknown")).toBe("unknown");
  });

  it("unknown providers do not guess reasoning", () => {
    const result = ensureTokenBreakdown(
      detail({ inputTokens: 100, outputTokens: 30, reasoningTokens: 12 }),
      "plugin-provider",
    );

    expect(result.totalTokens).toBe(130);
    expect(result.tokenBreakdown).toMatchObject({
      quality: "unclassified",
      unclassifiedTokens: 130,
    });
  });

  it("unknown providers keep auxiliary-only usage", () => {
    const result = ensureTokenBreakdown(
      detail({ reasoningTokens: 12, cacheReadTokens: 7 }),
      "plugin-provider",
    );

    expect(result.totalTokens).toBe(19);
    expect(result.tokenBreakdown).toMatchObject({
      quality: "unclassified",
      unclassifiedTokens: 19,
    });
  });

  it("Gemini classifies reasoning-only usage", () => {
    const result = ensureTokenBreakdown(detail({ reasoningTokens: 12 }), "gemini");
    expect(result.totalTokens).toBe(12);
    expect(result.tokenBreakdown).toMatchObject({
      quality: "complete",
      output: { reasoningTokens: 12 },
    });
  });

  it("legacy cached-only usage becomes cache reads", () => {
    const result = ensureTokenBreakdown(detail({ cachedTokens: 13 }), "openai");
    expect(result).toMatchObject({ totalTokens: 13, cacheReadTokens: 13 });
    expect(result.tokenBreakdown).toMatchObject({
      quality: "unclassified",
      unclassifiedTokens: 13,
    });
  });

  it("does not override a canonical zero cache read", () => {
    expect(
      ensureTokenBreakdown(detail({ cachedTokens: 13, cacheCreationTokens: 13 }), "openai")
        .cacheReadTokens,
    ).toBe(0);
  });

  it("does not double count reasoning in the total", () => {
    const result = ensureTokenBreakdown(
      detail({ inputTokens: 100, outputTokens: 30, reasoningTokens: 12 }),
      "openai",
    );

    expect(result.totalTokens).toBe(130);
    expect(result.tokenBreakdown).toMatchObject({
      quality: "complete",
      output: { reasoningTokens: 12 },
    });
  });

  it("keeps a valid breakdown", () => {
    const parsed = parseClaudeUsage(
      '{"usage":{"input_tokens":3,"output_tokens":10,"thinking_tokens":4}}',
    );

    expect(ensureTokenBreakdown(parsed, "openai").tokenBreakdown).toBe(parsed.tokenBreakdown);
  });
});

describe("OpenAI-style parsers", () => {
  it("chat completions", () => {
    const parsed = parseOpenAIUsage(
      '{"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":5}}}',
    );

    expect(parsed).toMatchObject({
      inputTokens: 10,
      outputTokens: 6,
      totalTokens: 16,
      cachedTokens: 4,
      cacheReadTokens: 4,
      reasoningTokens: 5,
    });
    expect(parsed.tokenBreakdown).toMatchObject({
      quality: "complete",
      input: { uncachedTokens: 6 },
      output: { nonReasoningTokens: 1 },
    });
  });

  it("responses", () => {
    const parsed = parseOpenAIUsage(
      '{"service_tier":"default","usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30,"input_tokens_details":{"cached_tokens":7},"output_tokens_details":{"reasoning_tokens":9}}}',
    );

    expect(parsed).toMatchObject({
      cachedTokens: 7,
      cacheReadTokens: 7,
      reasoningTokens: 9,
      responseServiceTier: "default",
    });
    expect(parsed.tokenBreakdown).toMatchObject({
      input: { uncachedTokens: 3 },
      output: { nonReasoningTokens: 11 },
    });
  });

  it("reads the flat reasoning_tokens dialect (SGLang, e198f3cd)", () => {
    const parsed = parseOpenAIUsage(
      '{"usage":{"prompt_tokens":241114,"total_tokens":242270,"completion_tokens":1156,"prompt_tokens_details":{"cached_tokens":240896},"reasoning_tokens":530}}',
    );

    expect(parsed).toMatchObject({
      inputTokens: 241114,
      outputTokens: 1156,
      totalTokens: 242270,
      cachedTokens: 240896,
      cacheReadTokens: 240896,
      reasoningTokens: 530,
    });
    expect(isValidTokenBreakdown(parsed.tokenBreakdown)).toBe(true);
    expect(parsed.tokenBreakdown?.output.reasoningTokens).toBe(530);

    const stream = parseOpenAIStreamUsage(
      'data: {"id":"x","object":"chat.completion.chunk","usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16,"reasoning_tokens":4}}',
    );

    expect(stream?.reasoningTokens).toBe(4);
  });

  it("total-only usage is unclassified", () => {
    const parsed = parseOpenAIUsage('{"usage":{"total_tokens":42}}');
    expect(parsed.totalTokens).toBe(42);
    expect(parsed.tokenBreakdown).toMatchObject({
      quality: "unclassified",
      unclassifiedTokens: 42,
    });
  });

  it("partial buckets preserve the known tokens", () => {
    const parsed = parseOpenAIUsage('{"usage":{"input_tokens":10,"total_tokens":15}}');
    expect(parsed.tokenBreakdown).toMatchObject({
      quality: "unclassified",
      input: { totalTokens: 10 },
      unclassifiedTokens: 5,
    });
  });

  it("explicit zero buckets with a total stay inconsistent", () => {
    const parsed = parseOpenAIUsage(
      '{"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":42}}',
    );

    expect(parsed.tokenBreakdown?.quality).toBe("inconsistent");
  });

  it("Codex usage includes cache write tokens", () => {
    const parsed = parseCodexUsage({
      response: {
        service_tier: "priority",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 30, cache_write_tokens: 40 },
        },
      },
    });

    expect(parsed).toMatchObject({
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      totalTokens: 120,
      responseServiceTier: "priority",
    });
    expect(parsed?.tokenBreakdown).toMatchObject({
      input: { uncachedTokens: 30, cacheWriteTokens: 40 },
    });
  });

  it("normalises the cache creation alias and ignores null usage", () => {
    expect(
      parseOpenAIUsage(
        '{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cache_creation_tokens":4}}}',
      ).cacheCreationTokens,
    ).toBe(4);
    expect(parseOpenAIUsage('{"usage":null}')).toEqual(emptyUsageDetail);
    expect(parseOpenAIUsage('{"service_tier":"default"}').responseServiceTier).toBe("default");
  });

  it("stream lines", () => {
    expect(
      parseOpenAIStreamUsage(
        'data: {"choices":[{"index":0,"delta":{"content":"hi"}}],"usage":null}',
      ),
    ).toBeUndefined();

    const parsed = parseOpenAIStreamUsage(
      'data: {"service_tier":"flex","choices":[],"usage":{"input_tokens":8,"output_tokens":5,"total_tokens":13,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}',
    );

    expect(parsed).toMatchObject({
      inputTokens: 8,
      outputTokens: 5,
      totalTokens: 13,
      cachedTokens: 3,
      reasoningTokens: 2,
      responseServiceTier: "flex",
    });
  });
});

describe("Claude parsers", () => {
  it("cache tokens are part of the total and independent of the input", () => {
    const parsed = parseClaudeUsage(
      '{"usage":{"input_tokens":3085,"output_tokens":253,"cache_read_input_tokens":7,"cache_creation_input_tokens":19514}}',
    );

    expect(parsed).toMatchObject({
      cacheReadTokens: 7,
      cacheCreationTokens: 19514,
      cachedTokens: 7,
      totalTokens: 22859,
    });
    expect(parsed.tokenBreakdown).toMatchObject({
      input: { totalTokens: 22606, uncachedTokens: 3085 },
    });
  });

  it("cached tokens fall back to the cache creation tokens", () => {
    const parsed = parseClaudeUsage(
      '{"usage":{"input_tokens":3085,"output_tokens":253,"cache_creation_input_tokens":19514}}',
    );

    expect(parsed).toMatchObject({ cachedTokens: 19514, totalTokens: 22852 });
  });

  it("thinking tokens are a subset of the output", () => {
    const body =
      '"usage":{"input_tokens":2,"cache_creation_input_tokens":831,"cache_read_input_tokens":44225,"output_tokens":244,"output_tokens_details":{"thinking_tokens":40}}';

    const parsed = parseClaudeUsage(`{${body}}`);
    expect(parsed).toMatchObject({ outputTokens: 244, reasoningTokens: 40, totalTokens: 45302 });
    expect(parsed.tokenBreakdown).toMatchObject({
      output: { totalTokens: 244, nonReasoningTokens: 204, reasoningTokens: 40 },
    });

    const streamed = parseClaudeStreamUsage(
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},${body}}`,
    );

    expect(streamed).toMatchObject({ outputTokens: 244, reasoningTokens: 40, totalTokens: 45302 });
    expect(streamed?.tokenBreakdown?.output.nonReasoningTokens).toBe(204);
  });

  it("message_start carries message.usage", () => {
    const parsed = parseClaudeStreamUsage(
      'data: {"type":"message_start","message":{"id":"msg_123","model":"claude-opus-5","usage":{"input_tokens":2095,"cache_creation_input_tokens":7185,"cache_read_input_tokens":355598,"output_tokens":1}}}',
    );

    expect(parsed).toMatchObject({
      inputTokens: 2095,
      cacheReadTokens: 355598,
      cacheCreationTokens: 7185,
      cachedTokens: 355598,
    });
  });

  it("falls back to the top-level thinking_tokens", () => {
    const parsed = parseClaudeUsage(
      '{"usage":{"input_tokens":3,"output_tokens":10,"thinking_tokens":4}}',
    );

    expect(parsed).toMatchObject({ outputTokens: 10, reasoningTokens: 4, totalTokens: 13 });
    expect(parsed.tokenBreakdown?.output.nonReasoningTokens).toBe(6);
  });

  it("merges message_start and message_delta (ObserveClaudeStream)", () => {
    const start = parseClaudeStreamUsage(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":1}}}',
    ) as UsageDetail;

    const delta = parseClaudeStreamUsage(
      'data: {"type":"message_delta","usage":{"output_tokens":50,"output_tokens_details":{"thinking_tokens":10}}}',
    ) as UsageDetail;

    const merged = mergeStreamUsageDetail(start, delta);
    expect(merged).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 50,
      reasoningTokens: 10,
      totalTokens: 175,
    });
    expect(isValidTokenBreakdown(merged.tokenBreakdown)).toBe(true);
    expect(merged.tokenBreakdown).toMatchObject({
      quality: "complete",
      output: { nonReasoningTokens: 40 },
    });
  });

  it.each([
    ["fast", "fast"],
    ["standard", "standard"],
  ])("reports usage.speed %s as the response service tier (b90190db)", (speed, want) => {
    expect(
      parseClaudeUsage(`{"usage":{"input_tokens":10,"output_tokens":5,"speed":"${speed}"}}`)
        .responseServiceTier,
    ).toBe(want);
  });

  it("has no response service tier without usage.speed", () => {
    expect(
      parseClaudeUsage('{"usage":{"input_tokens":10,"output_tokens":5}}').responseServiceTier,
    ).toBeUndefined();
  });

  it.each([
    [',"speed":"fast"', "", "fast"],
    ["", ',"speed":"fast"', "fast"],
    ["", "", undefined],
  ])("keeps the speed tier across message_start %j and message_delta %j", (a, b, want) => {
    const start = parseClaudeStreamUsage(
      `data: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1${a}}}}`,
    ) as UsageDetail;

    const delta = parseClaudeStreamUsage(
      `data: {"type":"message_delta","usage":{"output_tokens":15${b}}}`,
    ) as UsageDetail;

    const merged = mergeStreamUsageDetail(start, delta);
    expect(merged).toMatchObject({ inputTokens: 20, outputTokens: 15 });
    expect(merged.responseServiceTier).toBe(want);
  });

  it("ignores non-JSON lines and events without usage", () => {
    expect(parseClaudeStreamUsage("event: ping")).toBeUndefined();
    expect(parseClaudeStreamUsage('data: {"type":"content_block_delta"}')).toBeUndefined();
  });
});

describe("Gemini family parsers", () => {
  it("normalises cached content", () => {
    const parsed = parseGeminiUsage(
      '{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"cachedContentTokenCount":4,"totalTokenCount":12}}',
    );

    expect(parsed).toMatchObject({ cachedTokens: 4, cacheReadTokens: 4 });
    expect(parsed.tokenBreakdown).toMatchObject({ input: { uncachedTokens: 6 }, totalTokens: 12 });
  });

  it("includes tool-use prompt tokens", () => {
    const parsed = parseGeminiUsage(
      '{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3,"toolUsePromptTokenCount":5,"totalTokenCount":20}}',
    );

    expect(parsed).toMatchObject({ inputTokens: 15, totalTokens: 20 });
    expect(parsed.tokenBreakdown).toMatchObject({
      quality: "complete",
      input: { uncachedTokens: 15 },
      output: { reasoningTokens: 3 },
    });
  });

  it("skips a zero placeholder in the stream", () => {
    const lines = [
      'data: {"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0,"thoughtsTokenCount":0,"totalTokenCount":0}}',
      'data: {"usageMetadata":{"promptTokenCount":17984,"candidatesTokenCount":2668,"thoughtsTokenCount":1028,"totalTokenCount":21680}}',
    ];

    const accepted = lines.flatMap((line) => parseGeminiStreamUsage(line) ?? []);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      inputTokens: 17984,
      outputTokens: 2668,
      reasoningTokens: 1028,
      totalTokens: 21680,
    });
  });

  it.each([
    [
      "negative",
      '{"usageMetadata":{"promptTokenCount":10,"toolUsePromptTokenCount":-1,"totalTokenCount":10}}',
    ],
    [
      "overflow",
      '{"usageMetadata":{"promptTokenCount":9223372036854775807,"toolUsePromptTokenCount":1,"totalTokenCount":9223372036854775807}}',
    ],
  ])("rejects invalid tool-use sums (%s)", (_name, body) => {
    const parsed = parseGeminiUsage(body);
    expect(parsed.inputTokens).toBeGreaterThanOrEqual(0);
    expect(isValidTokenBreakdown(parsed.tokenBreakdown)).toBe(true);
    expect(parsed.tokenBreakdown?.quality).toBe("inconsistent");
  });

  it("Antigravity reads the response envelope", () => {
    const body =
      '{"response":{"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"thoughtsTokenCount":2}}}';

    expect(parseAntigravityUsage(body)).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      reasoningTokens: 2,
      totalTokens: 12,
    });
    expect(parseAntigravityStreamUsage(`data: ${body}`)?.totalTokens).toBe(12);
    expect(parseAntigravityUsage("{}")).toEqual(emptyUsageDetail);
  });
});

describe("Interactions parsers", () => {
  it("parses the flat usage object", () => {
    const parsed = parseInteractionsUsage(
      '{"usage":{"input_tokens":3,"output_tokens":4,"reasoning_tokens":5,"cached_tokens":2}}',
    );

    expect(parsed).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
      reasoningTokens: 5,
      totalTokens: 12,
      cachedTokens: 2,
      cacheReadTokens: 2,
    });
    expect(parsed.tokenBreakdown).toMatchObject({
      input: { uncachedTokens: 1 },
      output: { totalTokens: 9 },
    });
  });

  it("normalises the cache write alias and includes tool-use tokens", () => {
    expect(
      parseInteractionsUsage('{"usage":{"input_tokens":3,"cache_write_tokens":2}}')
        .cacheCreationTokens,
    ).toBe(2);

    const parsed = parseInteractionsUsage(
      '{"usage":{"total_input_tokens":2,"total_output_tokens":6,"total_thought_tokens":3,"total_tool_use_tokens":4,"total_tokens":15}}',
    );

    expect(parsed).toMatchObject({
      inputTokens: 6,
      outputTokens: 6,
      reasoningTokens: 3,
      totalTokens: 15,
    });
    expect(parsed.tokenBreakdown).toMatchObject({
      quality: "complete",
      input: { uncachedTokens: 6 },
      output: { totalTokens: 9 },
    });
  });

  it("stream events", () => {
    const completed = parseInteractionsStreamUsage(
      '{"type":"interaction.completed","interaction":{"usage":{"input_tokens":2,"output_tokens":6,"total_tokens":8}}}',
    );

    expect(completed?.totalTokens).toBe(8);

    const finish = parseInteractionsStreamUsage(
      'data: {"event_type":"finish","metadata":{"total_usage":{"total_input_tokens":2,"total_output_tokens":6,"total_thought_tokens":3,"total_cached_tokens":1,"total_tokens":11}}}',
    );

    expect(finish).toMatchObject({
      inputTokens: 2,
      outputTokens: 6,
      reasoningTokens: 3,
      cachedTokens: 1,
      cacheReadTokens: 1,
      totalTokens: 11,
    });
  });

  it("reads Gemini-shaped usage and the response service tier", () => {
    const parsed = parseInteractionsUsage(
      '{"service_tier":"priority","usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}',
    );

    expect(parsed).toMatchObject({
      inputTokens: 5,
      totalTokens: 6,
      responseServiceTier: "priority",
    });
  });
});

describe("Interactions stream merge keeps separate-reasoning semantics (8289ec4c)", () => {
  const initial = parseInteractionsUsage(
    '{"usage":{"input_tokens":100,"cache_read_tokens":20,"output_tokens":0,"reasoning_tokens":0,"total_tokens":100}}',
  );

  const final = parseInteractionsUsage(
    '{"usage":{"input_tokens":100,"cache_read_tokens":20,"output_tokens":30,"reasoning_tokens":10,"total_tokens":140}}',
  );

  const partial = parseInteractionsUsage('{"usage":{"output_tokens":30,"reasoning_tokens":10}}');

  it.each([
    ["cumulative initial and final snapshots", mergeStreamUsageDetail(initial, final)],
    ["identical final snapshots", mergeStreamUsageDetail(final, final)],
    ["partial delta after the initial snapshot", mergeStreamUsageDetail(initial, partial)],
  ])("%s", (_name, merged) => {
    expect(merged).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 20,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 140,
    });
    expect(merged.tokenBreakdown).toEqual({
      schemaVersion: 2,
      quality: "complete",
      totalTokens: 140,
      input: { totalTokens: 100, uncachedTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 0 },
      output: { totalTokens: 40, nonReasoningTokens: 30, reasoningTokens: 10 },
      unclassifiedTokens: 0,
    });
  });

  it("keeps an inconsistent Claude delta inconsistent", () => {
    const start = parseClaudeUsage(
      '{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"output_tokens":0}}',
    );

    const delta = parseClaudeUsage(
      '{"usage":{"cache_read_input_tokens":20,"output_tokens":10,"output_tokens_details":{"thinking_tokens":20}}}',
    );

    expect(mergeStreamUsageDetail(start, delta).tokenBreakdown?.quality).toBe("inconsistent");
  });
});

describe("UsageReporter accounting", () => {
  const reporter = (provider: string, executorType = provider) =>
    new UsageReporter({
      requestId: "r1",
      provider,
      executorType,
      model: "m",
      alias: "m",
      endpoint: "POST /v1/x",
      principalId: "user:a@x.com",
      orgId: GLOBAL_ORG,
      authId: "a",
      authType: "oauth",
      source: "s",
      stream: true,
      serviceTier: "auto",
      requestedAt: 1000,
    });

  it("finish attaches the v2 breakdown of the provider's semantics", () => {
    const usage = reporter("openai-compatible-x");
    usage.publish(
      parseOpenAIUsage('{"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16}}'),
    );
    const record = usage.finish(2000);
    expect(record?.detail.tokenBreakdown).toMatchObject({ quality: "complete", totalTokens: 16 });
    const empty = reporter("claude").finish(2000);
    expect(empty?.detail.tokenBreakdown).toMatchObject({ quality: "complete", totalTokens: 0 });
  });

  it("exactly one record per attempt, with latency", () => {
    const usage = reporter("codex");
    expect(usage.finish(1500)).toMatchObject({ latencyMs: 500 });
    expect(usage.finish(1600)).toBeUndefined();
  });

  it("latest usage wins and the response tier survives later updates (StreamUsageBuffer)", () => {
    const usage = reporter("openai");
    usage.publish(parseOpenAIStreamUsage('data: {"service_tier":"default"}') as UsageDetail);
    usage.publish(
      parseOpenAIStreamUsage(
        'data: {"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}',
      ) as UsageDetail,
    );
    expect(usage.finish(2000)?.detail).toMatchObject({
      inputTokens: 1,
      outputTokens: 1,
      responseServiceTier: "default",
    });

    const final = reporter("openai");
    final.publish(parseOpenAIStreamUsage('data: {"service_tier":"default"}') as UsageDetail);
    final.publish(
      parseOpenAIStreamUsage(
        'data: {"service_tier":"priority","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}',
      ) as UsageDetail,
    );
    expect(final.finish(2000)?.detail.responseServiceTier).toBe("priority");

    const late = reporter("openai");
    late.publish(
      parseOpenAIStreamUsage(
        'data: {"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}',
      ) as UsageDetail,
    );
    late.publish(parseOpenAIStreamUsage('data: {"service_tier":"default"}') as UsageDetail);
    expect(late.finish(2000)?.detail).toMatchObject({
      inputTokens: 2,
      responseServiceTier: "default",
    });
  });

  it("publishMerged merges Claude stream events", () => {
    const usage = reporter("claude");
    usage.publishMerged(
      parseClaudeStreamUsage(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}',
      ) as UsageDetail,
    );
    usage.publishMerged(
      parseClaudeStreamUsage(
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
      ) as UsageDetail,
    );
    expect(usage.finish(2000)?.detail).toMatchObject({
      inputTokens: 10,
      outputTokens: 7,
      totalTokens: 17,
    });
  });
});

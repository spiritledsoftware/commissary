// The Gemini executors' usage helpers (`executor/gemini/usage.ts`) carry the v2 token accounting breakdown:
// reasoning is separate from the candidates, cache is part of the input, and invalid counts are `inconsistent`.
import { describe, expect, it } from "vite-plus/test";
import {
  parseGeminiStreamUsage,
  parseGeminiUsageBody,
  parseInteractionsStreamUsage,
  parseInteractionsUsageBody,
} from "../../src/executor/gemini/usage.ts";

describe("Gemini usage breakdown (usage.ts v2)", () => {
  it("separates reasoning and treats cache as part of the input", () => {
    const detail = parseGeminiUsageBody({
      usageMetadata: {
        promptTokenCount: 100,
        toolUsePromptTokenCount: 20,
        cachedContentTokenCount: 30,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 10,
      },
    });

    expect(detail.inputTokens).toBe(120);
    expect(detail.totalTokens).toBe(170);
    expect(detail.tokenBreakdown).toMatchObject({
      quality: "complete",
      totalTokens: 170,
      input: { totalTokens: 120, uncachedTokens: 90, cacheReadTokens: 30, cacheWriteTokens: 0 },
      output: { totalTokens: 50, nonReasoningTokens: 40, reasoningTokens: 10 },
      unclassifiedTokens: 0,
    });
  });

  it("marks a reported total that disagrees with the buckets as inconsistent", () => {
    const detail = parseGeminiUsageBody({
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 99 },
    });

    expect(detail.tokenBreakdown).toMatchObject({
      quality: "inconsistent",
      totalTokens: 99,
      unclassifiedTokens: 99,
    });
  });

  it("marks cache larger than the input as inconsistent and negative sums as invalid", () => {
    expect(
      parseGeminiUsageBody({
        usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 20, totalTokenCount: 30 },
      }).tokenBreakdown?.quality,
    ).toBe("inconsistent");

    const invalid = parseGeminiUsageBody({
      usageMetadata: { promptTokenCount: -5, totalTokenCount: 7 },
    });

    expect(invalid.tokenBreakdown).toMatchObject({ quality: "inconsistent", totalTokens: 7 });
  });

  it("stream chunks keep the breakdown and skip zero placeholders", () => {
    expect(parseGeminiStreamUsage('data: {"usageMetadata":{}}')).toBeUndefined();

    const detail = parseGeminiStreamUsage(
      'data: {"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":6,"totalTokenCount":10}}',
    );

    expect(detail?.tokenBreakdown).toMatchObject({ quality: "complete", totalTokens: 10 });
  });

  it("Interactions usage uses the same accounting", () => {
    const detail = parseInteractionsUsageBody({
      usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2, cached_tokens: 4 },
    });

    expect(detail.cacheReadTokens).toBe(4);
    expect(detail.tokenBreakdown).toMatchObject({
      quality: "complete",
      totalTokens: 17,
      input: { totalTokens: 10, uncachedTokens: 6, cacheReadTokens: 4 },
      output: { totalTokens: 7, nonReasoningTokens: 5, reasoningTokens: 2 },
    });
    expect(parseInteractionsStreamUsage('{"usage":{"input_tokens":0}}')).toBeUndefined();
  });
});

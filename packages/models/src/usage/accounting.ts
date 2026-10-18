/**
 * Token accounting v2: a canonical, non-overlapping breakdown of the tokens of one upstream attempt.
 *
 * Go source: sdk/cliproxy/usage/accounting.go (TokenBreakdown, New*TokenBreakdown, EnsureTokenBreakdownForProvider,
 * tokenAccountingSemanticsFor). Go uses int64 with overflow checks; token counts are JS numbers here, so sums that
 * leave the safe-integer range count as overflow.
 */
import type { UsageDetail } from "./record.ts";

export const TOKEN_ACCOUNTING_SCHEMA_VERSION = 2;

export type TokenAccountingQuality = "complete" | "inconsistent" | "unclassified";

/** Mutually exclusive input buckets: `totalTokens = uncached + cacheRead + cacheWrite`. */
export interface TokenInputBreakdown {
  readonly totalTokens: number;
  readonly uncachedTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Mutually exclusive output buckets: `totalTokens = nonReasoning + reasoning`. */
export interface TokenOutputBreakdown {
  readonly totalTokens: number;
  readonly nonReasoningTokens: number;
  readonly reasoningTokens: number;
}

export interface TokenBreakdown {
  readonly schemaVersion: number;
  readonly quality: TokenAccountingQuality;
  /** `input.totalTokens + output.totalTokens + unclassifiedTokens`. */
  readonly totalTokens: number;
  readonly input: TokenInputBreakdown;
  readonly output: TokenOutputBreakdown;
  readonly unclassifiedTokens: number;
}

/** How a provider's usage fields overlap (pipeline.md §8.3). */
export type TokenAccountingSemantics = "unknown" | "subset" | "independent" | "separate-reasoning";

const zeroInput: TokenInputBreakdown = {
  totalTokens: 0,
  uncachedTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const zeroOutput: TokenOutputBreakdown = {
  totalTokens: 0,
  nonReasoningTokens: 0,
  reasoningTokens: 0,
};

/** Sum of non-negative integers that stays within the safe-integer range (`nonNegativeSum`). */
const nonNegativeSum = (...values: ReadonlyArray<number>): number | undefined => {
  let total = 0;

  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value)
      return undefined;
    total += value;
  }

  return total;
};

const validQuality = (quality: string): quality is TokenAccountingQuality =>
  quality === "complete" || quality === "inconsistent" || quality === "unclassified";

/** `TokenBreakdown.Valid`: the v2 invariants hold. */
export const isValidTokenBreakdown = (b: TokenBreakdown | undefined): b is TokenBreakdown => {
  if (
    b === undefined ||
    b.schemaVersion !== TOKEN_ACCOUNTING_SCHEMA_VERSION ||
    !validQuality(b.quality)
  )
    return false;

  const inputSum = nonNegativeSum(
    b.input.uncachedTokens,
    b.input.cacheReadTokens,
    b.input.cacheWriteTokens,
  );

  if (inputSum === undefined || b.input.totalTokens !== inputSum) return false;
  const outputSum = nonNegativeSum(b.output.nonReasoningTokens, b.output.reasoningTokens);

  if (outputSum === undefined || b.output.totalTokens !== outputSum) return false;
  const totalSum = nonNegativeSum(b.input.totalTokens, b.output.totalTokens, b.unclassifiedTokens);

  if (totalSum === undefined || b.totalTokens !== totalSum) return false;

  return !(b.quality === "complete" && b.unclassifiedTokens !== 0);
};

/** `inconsistentTokenBreakdown`: keeps the best known total, all of it unclassified. */
export const inconsistentTokenBreakdown = (total: number, fallback: number): TokenBreakdown => {
  let resolved = total;

  if (resolved <= 0) resolved = fallback;

  if (resolved < 0 || !Number.isFinite(resolved)) resolved = 0;
  // Go's int64 holds any total; keep ours inside the range where sums are exact.
  resolved = Math.min(resolved, Number.MAX_SAFE_INTEGER);

  return {
    schemaVersion: TOKEN_ACCOUNTING_SCHEMA_VERSION,
    quality: "inconsistent",
    totalTokens: resolved,
    input: zeroInput,
    output: zeroOutput,
    unclassifiedTokens: resolved,
  };
};

/** `resolveAccountingTotal`: a reported total must match the sum of the buckets (0 = not reported). */
const resolveAccountingTotal = (total: number, expected: number): number | undefined => {
  if (total < 0 || expected < 0) return undefined;

  if (total === 0) return expected;

  return total === expected ? total : undefined;
};

const complete = (
  total: number,
  input: TokenInputBreakdown,
  output: TokenOutputBreakdown,
  unclassifiedTokens = 0,
): TokenBreakdown => ({
  schemaVersion: TOKEN_ACCOUNTING_SCHEMA_VERSION,
  quality: unclassifiedTokens > 0 ? "unclassified" : "complete",
  totalTokens: total,
  input,
  output,
  unclassifiedTokens,
});

const includedCacheInput = (
  inputTotal: number,
  cacheRead: number,
  cacheWrite: number,
): TokenInputBreakdown => ({
  totalTokens: inputTotal,
  uncachedTokens: inputTotal - cacheRead - cacheWrite,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

/** `NewSubsetTokenBreakdown`: cache tokens are part of the input total, reasoning is part of the output total. */
export const subsetTokenBreakdown = (
  inputTotal: number,
  cacheRead: number,
  cacheWrite: number,
  outputTotal: number,
  reasoning: number,
  total: number,
): TokenBreakdown => {
  const cacheTotal = nonNegativeSum(cacheRead, cacheWrite);
  const expected = nonNegativeSum(inputTotal, outputTotal);

  if (
    cacheTotal === undefined ||
    expected === undefined ||
    reasoning < 0 ||
    cacheTotal > inputTotal ||
    reasoning > outputTotal
  ) {
    return inconsistentTokenBreakdown(total, expected ?? 0);
  }

  const resolved = resolveAccountingTotal(total, expected);

  if (resolved === undefined) return inconsistentTokenBreakdown(total, expected);

  return complete(resolved, includedCacheInput(inputTotal, cacheRead, cacheWrite), {
    totalTokens: outputTotal,
    nonReasoningTokens: outputTotal - reasoning,
    reasoningTokens: reasoning,
  });
};

/** `NewPartialSubsetTokenBreakdown`: known subset buckets are kept, the authoritative remainder is unclassified. */
export const partialSubsetTokenBreakdown = (
  inputTotal: number,
  cacheRead: number,
  cacheWrite: number,
  outputTotal: number,
  reasoning: number,
  total: number,
): TokenBreakdown => {
  const cacheTotal = nonNegativeSum(cacheRead, cacheWrite);
  const expected = nonNegativeSum(inputTotal, outputTotal);

  if (
    cacheTotal === undefined ||
    expected === undefined ||
    inputTotal < 0 ||
    outputTotal < 0 ||
    reasoning < 0 ||
    cacheTotal > inputTotal ||
    reasoning > outputTotal ||
    total < 0
  ) {
    return inconsistentTokenBreakdown(total, expected ?? 0);
  }

  const resolved = total === 0 ? expected : total;

  if (resolved < expected) return inconsistentTokenBreakdown(total, expected);

  return complete(
    resolved,
    includedCacheInput(inputTotal, cacheRead, cacheWrite),
    {
      totalTokens: outputTotal,
      nonReasoningTokens: outputTotal - reasoning,
      reasoningTokens: reasoning,
    },
    resolved - expected,
  );
};

/** `NewIndependentTokenBreakdown`: uncached input, cache reads/writes, plain output and reasoning are separate. */
export const independentTokenBreakdown = (
  uncachedInput: number,
  cacheRead: number,
  cacheWrite: number,
  nonReasoningOutput: number,
  reasoning: number,
  total: number,
): TokenBreakdown => {
  const inputTotal = nonNegativeSum(uncachedInput, cacheRead, cacheWrite);
  const outputTotal = nonNegativeSum(nonReasoningOutput, reasoning);

  const expected =
    inputTotal === undefined || outputTotal === undefined
      ? undefined
      : nonNegativeSum(inputTotal, outputTotal);

  if (inputTotal === undefined || outputTotal === undefined || expected === undefined) {
    return inconsistentTokenBreakdown(total, expected ?? 0);
  }

  const resolved = resolveAccountingTotal(total, expected);

  if (resolved === undefined) return inconsistentTokenBreakdown(total, expected);

  return complete(
    resolved,
    {
      totalTokens: inputTotal,
      uncachedTokens: uncachedInput,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
    {
      totalTokens: outputTotal,
      nonReasoningTokens: nonReasoningOutput,
      reasoningTokens: reasoning,
    },
  );
};

/** `NewSeparateReasoningTokenBreakdown`: cache is part of the input total, reasoning is separate from the output. */
export const separateReasoningTokenBreakdown = (
  inputTotal: number,
  cacheRead: number,
  cacheWrite: number,
  nonReasoningOutput: number,
  reasoning: number,
  total: number,
): TokenBreakdown => {
  const cacheTotal = nonNegativeSum(cacheRead, cacheWrite);

  if (cacheTotal === undefined || inputTotal < 0 || cacheTotal > inputTotal)
    return inconsistentTokenBreakdown(total, 0);
  const outputTotal = nonNegativeSum(nonReasoningOutput, reasoning);
  const expected = outputTotal === undefined ? undefined : nonNegativeSum(inputTotal, outputTotal);

  if (outputTotal === undefined || expected === undefined)
    return inconsistentTokenBreakdown(total, expected ?? 0);
  const resolved = resolveAccountingTotal(total, expected);

  if (resolved === undefined) return inconsistentTokenBreakdown(total, expected);

  return complete(resolved, includedCacheInput(inputTotal, cacheRead, cacheWrite), {
    totalTokens: outputTotal,
    nonReasoningTokens: nonReasoningOutput,
    reasoningTokens: reasoning,
  });
};

/** `NewUnclassifiedTokenBreakdown`: an authoritative total without guessing how an unknown protocol splits it. */
export const unclassifiedTokenBreakdown = (total: number): TokenBreakdown => {
  if (total <= 0) {
    return {
      schemaVersion: TOKEN_ACCOUNTING_SCHEMA_VERSION,
      quality: total < 0 ? "inconsistent" : "complete",
      totalTokens: 0,
      input: zeroInput,
      output: zeroOutput,
      unclassifiedTokens: 0,
    };
  }

  return {
    schemaVersion: TOKEN_ACCOUNTING_SCHEMA_VERSION,
    quality: "unclassified",
    totalTokens: total,
    input: zeroInput,
    output: zeroOutput,
    unclassifiedTokens: total,
  };
};

/** `tokenAccountingSemanticsFor`. */
export const tokenAccountingSemanticsFor = (
  provider: string,
  executorType: string,
): TokenAccountingSemantics => {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedExecutor = executorType.trim().toLowerCase();
  const value = `${normalizedProvider} ${normalizedExecutor}`.trim();

  if (value === "" || value === "unknown" || value === "unknown unknown") return "unknown";

  if (
    normalizedExecutor === "openaicompatexecutor" ||
    normalizedProvider === "openai-compatibility" ||
    normalizedProvider.startsWith("openai-compatible-")
  ) {
    return "subset";
  }

  if (value.includes("claude") || value.includes("anthropic")) return "independent";

  // Not in Go (ADR 0032): System One providers report `input_tokens`/`output_tokens` only, never overlapping.
  if (normalizedProvider === "typesafe" || normalizedProvider === "subq") return "independent";

  for (const marker of ["gemini", "aistudio", "antigravity", "vertex", "interaction"]) {
    if (value.includes(marker)) return "separate-reasoning";
  }

  for (const marker of [
    "openai",
    "codex",
    "xai",
    "grok",
    "kimi",
    "qwen",
    "deepseek",
    "openrouter",
  ]) {
    if (value.includes(marker)) return "subset";
  }

  return "unknown";
};

/** `unclassifiedTokenLowerBound`. */
const unclassifiedTokenLowerBound = (detail: UsageDetail): number | undefined => {
  const cacheTokens = nonNegativeSum(detail.cacheReadTokens, detail.cacheCreationTokens);

  if (
    cacheTokens === undefined ||
    detail.inputTokens < 0 ||
    detail.outputTokens < 0 ||
    detail.reasoningTokens < 0 ||
    detail.cachedTokens < 0
  ) {
    return undefined;
  }

  const inputTotal = Math.max(detail.inputTokens, cacheTokens, detail.cachedTokens);
  const outputTotal = Math.max(detail.outputTokens, detail.reasoningTokens);

  return nonNegativeSum(inputTotal, outputTotal);
};

/** `tokenBreakdownForSemantics`. */
const tokenBreakdownForSemantics = (
  detail: UsageDetail,
  semantics: TokenAccountingSemantics,
): TokenBreakdown => {
  if (detail.totalTokens === 0 && detail.inputTokens === 0 && detail.outputTokens === 0) {
    const lowerBound = unclassifiedTokenLowerBound(detail);

    if (lowerBound === undefined) return inconsistentTokenBreakdown(detail.totalTokens, 0);

    if (
      lowerBound > 0 &&
      (semantics === "unknown" ||
        semantics === "subset" ||
        (semantics === "separate-reasoning" &&
          (detail.cacheReadTokens > 0 ||
            detail.cacheCreationTokens > 0 ||
            detail.cachedTokens > 0)))
    ) {
      return unclassifiedTokenBreakdown(lowerBound);
    }
  }

  const {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  } = detail;

  switch (semantics) {
    case "subset":
      return subsetTokenBreakdown(
        inputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
      );
    case "independent":
      return independentTokenBreakdown(
        inputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
      );
    case "separate-reasoning":
      return separateReasoningTokenBreakdown(
        inputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
      );
    default: {
      const total = totalTokens === 0 ? unclassifiedTokenLowerBound(detail) : totalTokens;

      return total === undefined
        ? inconsistentTokenBreakdown(totalTokens, 0)
        : unclassifiedTokenBreakdown(total);
    }
  }
};

/**
 * `EnsureTokenBreakdownForProvider`: attaches a valid v2 breakdown using the provider's token semantics (unknown
 * providers stay unclassified rather than guessing how buckets overlap). A valid existing breakdown is kept.
 */
export const ensureTokenBreakdown = (
  detail: UsageDetail,
  provider = "",
  executorType = "",
): UsageDetail => {
  let next = detail;

  if (!isValidTokenBreakdown(next.tokenBreakdown)) {
    const semantics = tokenAccountingSemanticsFor(provider, executorType);

    if (
      next.cacheReadTokens === 0 &&
      next.cachedTokens > 0 &&
      next.inputTokens === 0 &&
      next.outputTokens === 0 &&
      next.reasoningTokens === 0 &&
      next.cacheCreationTokens === 0 &&
      next.totalTokens === 0 &&
      (semantics === "subset" || semantics === "separate-reasoning")
    ) {
      next = { ...next, cacheReadTokens: next.cachedTokens };
    }

    next = { ...next, tokenBreakdown: tokenBreakdownForSemantics(next, semantics) };
  }

  if (next.totalTokens === 0 && next.tokenBreakdown !== undefined) {
    next = { ...next, totalTokens: next.tokenBreakdown.totalTokens };
  }

  return next;
};

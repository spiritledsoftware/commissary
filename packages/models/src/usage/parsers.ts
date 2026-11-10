/**
 * Usage parsers for the Claude, Gemini, Interactions and Antigravity protocols (OpenAI-style and Codex parsers live
 * in `record.ts` / `executor/codex/output.ts`) plus the stream merge rule.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (parseClaudeUsageNode, parseGeminiFamilyUsageDetail,
 * parseInteractionsUsageDetail, Parse{Claude,Gemini,Interactions,Antigravity}[Stream]Usage),
 * helps/plugin_executor_usage.go (MergeStreamUsageDetail, ObserveMergedStreamUsage).
 */
import { get, isJsonObject, type Json, tryParseJson } from "@commissary/json";
import {
  independentTokenBreakdown,
  inconsistentTokenBreakdown,
  isValidTokenBreakdown,
  separateReasoningTokenBreakdown,
  subsetTokenBreakdown,
} from "./accounting.ts";
import {
  emptyUsageDetail,
  firstExisting,
  hasNonZeroTokenUsage,
  responseServiceTier,
  ssePayloadObject,
  tokenInt,
  type UsageDetail,
} from "./record.ts";

/** `safeUsageTokenSum`. */
const safeSum = (...values: ReadonlyArray<number>): number | undefined => {
  let total = 0;

  for (const value of values) {
    if (value < 0 || total > Number.MAX_SAFE_INTEGER - value) return undefined;
    total += value;
  }

  return total;
};

const invalidDetail = (detail: UsageDetail, total: number): UsageDetail => ({
  ...detail,
  tokenBreakdown: inconsistentTokenBreakdown(Math.max(total, 0), 0),
});

// ---------------------------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------------------------

/** `parseClaudeUsageNode`: cache fields are independent of `input_tokens`, thinking is a subset of `output_tokens`. */
export const parseClaudeUsageNode = (node: Json): UsageDetail => {
  const cacheRead = tokenInt(get(node, "cache_read_input_tokens"));
  const cacheCreation = tokenInt(get(node, "cache_creation_input_tokens"));
  const rawOutput = tokenInt(get(node, "output_tokens"));

  const reasoning = Math.max(
    0,
    tokenInt(
      firstExisting(
        node,
        "output_tokens_details.thinking_tokens",
        "output_tokens_details.reasoning_tokens",
        "thinking_tokens",
      ),
    ),
  );

  // An inconsistent upstream (thinking > output) never invents extra non-reasoning output.
  const nonReasoningOutput = reasoning > rawOutput ? 0 : rawOutput - reasoning;
  const input = tokenInt(get(node, "input_tokens"));
  const total = input + rawOutput + cacheRead + cacheCreation;

  // b90190db: `usage.speed` ("fast" or "standard") is the tier the response was served and billed at.
  const speed = get(node, "speed");
  const tier = typeof speed === "string" ? speed.trim() : "";

  return {
    ...(tier === "" ? {} : { responseServiceTier: tier }),
    inputTokens: input,
    outputTokens: rawOutput,
    reasoningTokens: reasoning,
    cachedTokens: cacheRead === 0 ? cacheCreation : cacheRead,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    totalTokens: total,
    tokenBreakdown: independentTokenBreakdown(
      input,
      cacheRead,
      cacheCreation,
      nonReasoningOutput,
      reasoning,
      total,
    ),
  };
};

/** `ParseClaudeUsage` over a non-stream response body. */
export const parseClaudeUsage = (body: string): UsageDetail => {
  const node = get(tryParseJson(body), "usage");

  return node === undefined ? emptyUsageDetail : parseClaudeUsageNode(node);
};

/** `parseClaudePayloadUsage` for an already parsed event/message (`usage` or `message.usage`). */
export const parseClaudePayloadUsage = (payload: Json | undefined): UsageDetail | undefined => {
  const node = get(payload, "usage") ?? get(payload, "message.usage");

  return node === undefined ? undefined : parseClaudeUsageNode(node);
};

/** `ParseClaudeStreamUsage`: usage of one SSE line (`message_start` carries `message.usage`, `message_delta` `usage`). */
export const parseClaudeStreamUsage = (line: string): UsageDetail | undefined =>
  parseClaudePayloadUsage(ssePayloadObject(line));

// ---------------------------------------------------------------------------------------------------------------
// Gemini family
// ---------------------------------------------------------------------------------------------------------------

/** `parseGeminiFamilyUsageDetail`: `candidatesTokenCount` excludes `thoughtsTokenCount`. */
export const parseGeminiFamilyNode = (node: Json): UsageDetail => {
  const cached = tokenInt(get(node, "cachedContentTokenCount"));

  const toolUse = tokenInt(
    firstExisting(node, "toolUsePromptTokenCount", "tool_use_prompt_token_count"),
  );

  const input = safeSum(tokenInt(get(node, "promptTokenCount")), toolUse);

  const base: UsageDetail = {
    ...emptyUsageDetail,
    inputTokens: input ?? 0,
    outputTokens: tokenInt(get(node, "candidatesTokenCount")),
    reasoningTokens: tokenInt(get(node, "thoughtsTokenCount")),
    totalTokens: tokenInt(get(node, "totalTokenCount")),
    cachedTokens: cached,
    cacheReadTokens: cached,
  };

  return finishSeparateReasoning(base, input !== undefined);
};

const finishSeparateReasoning = (detail: UsageDetail, inputValid: boolean): UsageDetail => {
  if (!inputValid) return invalidDetail(detail, detail.totalTokens);
  let total = detail.totalTokens;

  if (total === 0) {
    const sum = safeSum(detail.inputTokens, detail.outputTokens, detail.reasoningTokens);

    if (sum === undefined) return invalidDetail({ ...detail, totalTokens: 0 }, 0);
    total = sum;
  }

  return {
    ...detail,
    totalTokens: total,
    tokenBreakdown: separateReasoningTokenBreakdown(
      detail.inputTokens,
      detail.cacheReadTokens,
      detail.cacheCreationTokens,
      detail.outputTokens,
      detail.reasoningTokens,
      total,
    ),
  };
};

const geminiNode = (root: Json | undefined): Json | undefined =>
  firstExisting(root, "usageMetadata", "usage_metadata");

/** `ParseGeminiUsage` over a parsed non-stream response body. */
export const parseGeminiUsageBody = (root: Json | undefined): UsageDetail => {
  const node = geminiNode(root);

  return node === undefined ? emptyUsageDetail : parseGeminiFamilyNode(node);
};

/** `ParseGeminiUsage` over a non-stream response body. */
export const parseGeminiUsage = (body: string): UsageDetail =>
  parseGeminiUsageBody(tryParseJson(body));

/** `ParseGeminiStreamUsage`: zero placeholders (`usageMetadata` without counts) are skipped. */
export const parseGeminiStreamUsage = (line: string): UsageDetail | undefined => {
  const node = geminiNode(ssePayloadObject(line));

  if (node === undefined) return undefined;
  const detail = parseGeminiFamilyNode(node);

  return hasNonZeroTokenUsage(detail) ? detail : undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Antigravity (Gemini envelope: `response.usageMetadata`)
// ---------------------------------------------------------------------------------------------------------------

const antigravityNode = (root: Json | undefined): Json | undefined =>
  firstExisting(root, "response.usageMetadata", "usageMetadata", "usage_metadata");

/** `ParseAntigravityUsage`. */
export const parseAntigravityUsage = (body: string): UsageDetail => {
  const node = antigravityNode(tryParseJson(body));

  return node === undefined ? emptyUsageDetail : parseGeminiFamilyNode(node);
};

/** `ParseAntigravityStreamUsage` (unlike Gemini, zero placeholders are kept). */
export const parseAntigravityStreamUsage = (line: string): UsageDetail | undefined => {
  const node = antigravityNode(ssePayloadObject(line));

  return node === undefined ? undefined : parseGeminiFamilyNode(node);
};

// ---------------------------------------------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------------------------------------------

const exists = (value: Json | undefined): boolean => value !== undefined;

/** `parseInteractionsUsageDetail`. */
export const parseInteractionsNode = (node: Json): UsageDetail => {
  const cacheRead = firstExisting(node, "cache_read_tokens", "cacheReadTokens");

  const toolUse = tokenInt(
    firstExisting(
      node,
      "tool_use_tokens",
      "total_tool_use_tokens",
      "toolUseTokens",
      "totalToolUseTokens",
    ),
  );

  const input = safeSum(
    tokenInt(firstExisting(node, "input_tokens", "prompt_tokens", "total_input_tokens")),
    toolUse,
  );

  const cached = tokenInt(
    firstExisting(node, "cached_tokens", "cachedContentTokenCount", "total_cached_tokens"),
  );

  const base: UsageDetail = {
    ...emptyUsageDetail,
    inputTokens: input ?? 0,
    outputTokens: tokenInt(
      firstExisting(node, "output_tokens", "completion_tokens", "total_output_tokens"),
    ),
    reasoningTokens: tokenInt(
      firstExisting(node, "reasoning_tokens", "thoughtsTokenCount", "total_thought_tokens"),
    ),
    totalTokens: tokenInt(firstExisting(node, "total_tokens", "totalTokenCount")),
    cachedTokens: cached,
    cacheReadTokens: tokenInt(cacheRead),
    cacheCreationTokens: tokenInt(
      firstExisting(
        node,
        "cache_creation_tokens",
        "cacheCreationTokens",
        "cache_write_tokens",
        "cacheWriteTokens",
      ),
    ),
  };

  if (input === undefined) return invalidDetail(base, base.totalTokens);
  const withCache = !exists(cacheRead) && cached > 0 ? { ...base, cacheReadTokens: cached } : base;

  return finishSeparateReasoning(withCache, true);
};

const INTERACTIONS_USAGE_PATHS = [
  "usage",
  "total_usage",
  "metadata.total_usage",
  "metadata.usage",
  "usageMetadata",
  "usage_metadata",
  "interaction.usage",
  "interaction.total_usage",
  "interaction.metadata.total_usage",
] as const;

const withTier = (detail: UsageDetail, root: Json | undefined): UsageDetail => {
  const tier = responseServiceTier(root);

  return tier === undefined ? detail : { ...detail, responseServiceTier: tier };
};

const parseInteractionsRoot = (root: Json | undefined): UsageDetail => {
  const node = firstExisting(root, ...INTERACTIONS_USAGE_PATHS);

  if (node === undefined) return emptyUsageDetail;

  const usesGeminiFields =
    exists(get(node, "promptTokenCount")) || exists(get(node, "candidatesTokenCount"));

  return withTier(
    usesGeminiFields ? parseGeminiFamilyNode(node) : parseInteractionsNode(node),
    root,
  );
};

/** `ParseInteractionsUsage` over a parsed non-stream response body. */
export const parseInteractionsUsageBody = (root: Json | undefined): UsageDetail =>
  parseInteractionsRoot(root);

/** `ParseInteractionsUsage` over a non-stream response body. */
export const parseInteractionsUsage = (body: string): UsageDetail =>
  parseInteractionsRoot(tryParseJson(body));

/** `ParseInteractionsStreamUsage`: the payload is the line's JSON (or the line itself). */
export const parseInteractionsStreamUsage = (line: string): UsageDetail | undefined => {
  const payload = ssePayloadObject(line) ?? tryParseJson(line.trim());

  if (!isJsonObject(payload)) return undefined;
  const detail = parseInteractionsRoot(payload);

  return hasNonZeroTokenUsage(detail) ? detail : undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Stream merging
// ---------------------------------------------------------------------------------------------------------------

const pick = (next: number, previous: number): number =>
  next === 0 && previous > 0 ? previous : next;

/**
 * `detailInputIncludesCache`: whether a complete breakdown counts the cache inside `inputTokens` (subset: `true`) or
 * next to it (independent: `false`); `undefined` when the detail does not say.
 */
const inputIncludesCache = (detail: UsageDetail): boolean | undefined => {
  const cacheSum = safeSum(detail.cacheReadTokens, detail.cacheCreationTokens);

  if (cacheSum === undefined || (cacheSum === 0 && detail.cachedTokens < 0)) return undefined;
  const cache = cacheSum === 0 ? detail.cachedTokens : cacheSum;
  const b = detail.tokenBreakdown;

  if (cache <= 0 || !isValidTokenBreakdown(b) || b.quality !== "complete") return undefined;

  if (
    b.input.totalTokens === detail.inputTokens &&
    b.input.uncachedTokens === detail.inputTokens - cache
  )
    return true;
  const independentTotal = safeSum(detail.inputTokens, cache);

  if (
    independentTotal !== undefined &&
    b.input.totalTokens === independentTotal &&
    b.input.uncachedTokens === detail.inputTokens
  )
    return false;

  return undefined;
};

/**
 * `detailOutputExcludesReasoning`: whether a complete breakdown keeps reasoning next to `outputTokens` (separate:
 * `true`) or inside it (`false`); `undefined` when the detail does not say.
 */
const outputExcludesReasoning = (detail: UsageDetail): boolean | undefined => {
  const b = detail.tokenBreakdown;

  if (detail.reasoningTokens <= 0 || !isValidTokenBreakdown(b)) return undefined;

  if (b.quality !== "complete" || b.output.reasoningTokens !== detail.reasoningTokens)
    return undefined;

  if (detail.outputTokens > 0) {
    const separateTotal = safeSum(detail.outputTokens, detail.reasoningTokens);

    if (
      separateTotal !== undefined &&
      b.output.totalTokens === separateTotal &&
      b.output.nonReasoningTokens === detail.outputTokens
    )
      return true;

    if (
      b.output.totalTokens === detail.outputTokens &&
      b.output.nonReasoningTokens === detail.outputTokens - detail.reasoningTokens
    )
      return false;

    return undefined;
  }

  if (
    b.output.totalTokens === detail.reasoningTokens &&
    b.output.nonReasoningTokens === 0 &&
    detail.totalTokens === b.totalTokens
  )
    return true;

  return undefined;
};

type MergedBuckets = Pick<
  UsageDetail,
  | "inputTokens"
  | "outputTokens"
  | "reasoningTokens"
  | "cachedTokens"
  | "cacheReadTokens"
  | "cacheCreationTokens"
>;

/**
 * Finishes a merge whose semantics are known: the total is the update's, raised to the buckets' `expected` sum, and an
 * overflowing sum (`undefined`) leaves an inconsistent breakdown.
 */
const withSemanticBreakdown = (
  buckets: MergedBuckets,
  reportedTotal: number,
  expected: number | undefined,
  breakdown: typeof subsetTokenBreakdown,
  tierField: { readonly responseServiceTier?: string },
): UsageDetail => {
  if (expected === undefined) {
    return {
      ...buckets,
      totalTokens: reportedTotal,
      tokenBreakdown: inconsistentTokenBreakdown(reportedTotal, 0),
      ...tierField,
    };
  }

  const totalTokens = reportedTotal === 0 || reportedTotal < expected ? expected : reportedTotal;

  return {
    ...buckets,
    totalTokens,
    tokenBreakdown: breakdown(
      buckets.inputTokens,
      buckets.cacheReadTokens,
      buckets.cacheCreationTokens,
      buckets.outputTokens,
      buckets.reasoningTokens,
      totalTokens,
    ),
    ...tierField,
  };
};

/**
 * `MergeStreamUsageDetail`: protocols that report usage in several events (Claude `message_start` + `message_delta`,
 * Interactions) keep the earlier non-zero buckets that the update leaves at zero. The merged breakdown keeps the
 * semantics the events were parsed with (separate reasoning, cache inside input) and falls back to the independent
 * cache and inclusive reasoning rules of the Claude stream only when neither event says.
 */
export const mergeStreamUsageDetail = (existing: UsageDetail, update: UsageDetail): UsageDetail => {
  const inputTokens = pick(update.inputTokens, existing.inputTokens);
  const cachedTokens = pick(update.cachedTokens, existing.cachedTokens);
  const cacheReadTokens = pick(update.cacheReadTokens, existing.cacheReadTokens);
  const cacheCreationTokens = pick(update.cacheCreationTokens, existing.cacheCreationTokens);
  const outputTokens = pick(update.outputTokens, existing.outputTokens);
  const reasoningTokens = pick(update.reasoningTokens, existing.reasoningTokens);
  let cache = cacheReadTokens + cacheCreationTokens;

  if (cache === 0) cache = cachedTokens;
  const calculated = inputTokens + outputTokens + cache;

  const totalTokens =
    update.totalTokens === 0 || update.totalTokens < calculated ? calculated : update.totalTokens;

  const tier = update.responseServiceTier ?? existing.responseServiceTier;
  const tierField = tier === undefined ? {} : { responseServiceTier: tier };
  const knownOutput = outputExcludesReasoning(update) ?? outputExcludesReasoning(existing);
  const knownInput = inputIncludesCache(update) ?? inputIncludesCache(existing);

  const buckets = {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };

  // Separate reasoning (Interactions, Gemini): `outputTokens` excludes the reasoning.
  if (knownOutput === true || (knownInput === true && knownOutput === undefined)) {
    return withSemanticBreakdown(
      buckets,
      update.totalTokens,
      safeSum(inputTokens, outputTokens, reasoningTokens),
      separateReasoningTokenBreakdown,
      tierField,
    );
  }

  // Subset (OpenAI style): the cache is inside `inputTokens`, the reasoning inside `outputTokens`.
  if (knownInput === true) {
    return withSemanticBreakdown(
      buckets,
      update.totalTokens,
      safeSum(inputTokens, outputTokens),
      subsetTokenBreakdown,
      tierField,
    );
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    tokenBreakdown: independentTokenBreakdown(
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      Math.max(outputTokens - reasoningTokens, 0),
      reasoningTokens,
      totalTokens,
    ),
    ...(tier === undefined ? {} : { responseServiceTier: tier }),
  };
};

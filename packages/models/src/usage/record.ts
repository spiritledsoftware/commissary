/**
 * Usage records: one per upstream attempt (successful or failed).
 *
 * Go source: sdk/cliproxy/usage/manager.go (Record, Detail), internal/runtime/executor/helps/usage_helpers.go
 * (ParseOpenAIUsage, ParseOpenAIStreamUsage, parseOpenAIStyleUsageNode, extractResponseServiceTier). The v2 token
 * breakdown lives in `accounting.ts`; the other protocols' parsers in `parsers.ts`.
 */
import { get, isJsonObject, type Json, tryParseJson } from "@commissary/json";
import {
  partialSubsetTokenBreakdown,
  subsetTokenBreakdown,
  type TokenBreakdown,
  unclassifiedTokenBreakdown,
} from "./accounting.ts";
import type { UsageRun } from "@commissary/auth";
import type { OrgId } from "@commissary/core";
import type { UsageFailure } from "./failure.ts";
import type { UsageCost } from "./pricing.ts";

export interface UsageDetail {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;
  /** v2 accounting (`accounting.ts`); attached by the parsers or, at the latest, by `UsageReporter.finish`. */
  readonly tokenBreakdown?: TokenBreakdown;
  readonly responseServiceTier?: string;
}

/** `hasNonZeroTokenUsage`. */
export const hasNonZeroTokenUsage = (detail: UsageDetail): boolean =>
  detail.inputTokens !== 0 ||
  detail.outputTokens !== 0 ||
  detail.reasoningTokens !== 0 ||
  detail.cachedTokens !== 0 ||
  detail.cacheReadTokens !== 0 ||
  detail.cacheCreationTokens !== 0 ||
  detail.totalTokens !== 0 ||
  (detail.tokenBreakdown?.totalTokens ?? 0) !== 0;

export const emptyUsageDetail: UsageDetail = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
};

export interface UsageRecord {
  /** Unique id of this attempt. */
  readonly requestId: string;
  /** Id of the inbound HTTP request (`X-CPA-TRACE-ID` carries it); shared by all attempts of a request. */
  readonly traceId?: string;
  /** Provider key of the credential (e.g. `openai-compatible-openrouter`). */
  readonly provider: string;
  /** Executor identifier. */
  readonly executorType: string;
  /** Upstream (billed) base model. */
  readonly model: string;
  /** Model string the client asked for. */
  readonly alias: string;
  /** Inbound route, e.g. `POST /v1/chat/completions`. */
  readonly endpoint: string;
  /** Access principal (replaces Go's client API key). */
  readonly principalId: string;
  /** The org the request belongs to (ADR 0021); usage queries only ever read one org's records. */
  readonly orgId: OrgId;
  /** The caller's member id in the org (ADR 0022), when they have a member record there. */
  readonly memberId?: string;
  /** Served by a private credential (ADR 0023): only its owner reads the record. */
  readonly private?: boolean;
  /** The agent run the attempt is of (#227): its agent, the run and its starter. */
  readonly run?: UsageRun;
  readonly authId: string;
  readonly authType: string;
  readonly source: string;
  readonly stream: boolean;
  /** `false` only when the client sent `generate: false`. */
  readonly generate?: boolean;
  readonly requestedAt: number;
  readonly latencyMs: number;
  readonly ttftMs?: number;
  readonly failed: boolean;
  /** Status, error type and error code of a failed attempt; never the upstream body (ADR 0027, `failure.ts`). */
  readonly fail?: UsageFailure;
  readonly detail: UsageDetail;
  readonly responseModel?: string;
  readonly reasoningEffort?: string;
  readonly serviceTier: string;
  /** Session identity (bounded id, e.g. `claude:<uuid>`, `derived:ctx:v1:<hash>`, `lcp:v1:<hash>`). */
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  /** Configured upstream base URL of the credential (Go `Record.BaseURL`). */
  readonly baseUrl?: string;
  /** The attempt's cost, priced when the record is written (`pricing.ts`, ADR 0024); absent until then. */
  readonly cost?: UsageCost;
}

/** gjson `.Int()` for numeric nodes; anything else counts as 0. */
export const tokenInt = (value: Json | undefined): number =>
  typeof value === "number" ? Math.trunc(value) : 0;

/** `firstExistingUsageNode`: the first of `paths` that exists (`null` exists). */
export const firstExisting = (
  node: Json | undefined,
  ...paths: ReadonlyArray<string>
): Json | undefined => {
  for (const path of paths) {
    const value = get(node, path);

    if (value !== undefined) return value;
  }

  return undefined;
};

const int = tokenInt;

const first = firstExisting;

const USAGE_BUCKET_PATHS = [
  "prompt_tokens",
  "input_tokens",
  "completion_tokens",
  "output_tokens",
  "prompt_tokens_details.cached_tokens",
  "input_tokens_details.cached_tokens",
  "prompt_tokens_details.cache_write_tokens",
  "prompt_tokens_details.cache_creation_tokens",
  "input_tokens_details.cache_write_tokens",
  "input_tokens_details.cache_creation_tokens",
  "completion_tokens_details.reasoning_tokens",
  "output_tokens_details.reasoning_tokens",
] as const;

export const hasUsageFields = (node: Json | undefined): node is Json =>
  isJsonObject(node) &&
  (get(node, "total_tokens") !== undefined ||
    USAGE_BUCKET_PATHS.some((path) => get(node, path) !== undefined));

/** `parseOpenAIStyleUsageNode`: subset semantics (cache inside input, reasoning inside output). */
export const parseOpenAIUsageNode = (node: Json): UsageDetail => {
  const inputNode = first(node, "prompt_tokens", "input_tokens");
  const outputNode = first(node, "completion_tokens", "output_tokens");

  const cached = first(
    node,
    "prompt_tokens_details.cached_tokens",
    "input_tokens_details.cached_tokens",
  );

  const reasoning = first(
    node,
    "completion_tokens_details.reasoning_tokens",
    "output_tokens_details.reasoning_tokens",
  );

  const cacheCreation = first(
    node,
    "input_tokens_details.cache_creation_tokens",
    "input_tokens_details.cache_write_tokens",
    "prompt_tokens_details.cache_creation_tokens",
    "prompt_tokens_details.cache_write_tokens",
  );

  const inputTokens = int(inputNode);
  const outputTokens = int(outputNode);
  const cacheRead = int(cached);
  const cacheWrite = int(cacheCreation);
  const reasoningTokens = int(reasoning);
  const reportedTotal = int(get(node, "total_tokens"));
  let tokenBreakdown: TokenBreakdown;

  if (USAGE_BUCKET_PATHS.some((path) => get(node, path) !== undefined)) {
    tokenBreakdown =
      inputNode !== undefined && outputNode !== undefined
        ? subsetTokenBreakdown(
            inputTokens,
            cacheRead,
            cacheWrite,
            outputTokens,
            reasoningTokens,
            reportedTotal,
          )
        : partialSubsetTokenBreakdown(
            inputTokens,
            inputNode === undefined ? 0 : cacheRead,
            inputNode === undefined ? 0 : cacheWrite,
            outputTokens,
            outputNode === undefined ? 0 : reasoningTokens,
            reportedTotal,
          );
  } else {
    tokenBreakdown = unclassifiedTokenBreakdown(reportedTotal);
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens: cacheRead,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    totalTokens: reportedTotal !== 0 ? reportedTotal : tokenBreakdown.totalTokens,
    tokenBreakdown,
  };
};

/** `extractResponseServiceTier`. */
export const responseServiceTier = (payload: Json | undefined): string | undefined => {
  for (const path of ["response.service_tier", "service_tier", "interaction.service_tier"]) {
    const value = get(payload, path);

    let tier = "";

    if (typeof value === "string") tier = value.trim();
    else if (typeof value === "number") tier = String(value);

    if (tier !== "") return tier;
  }

  return undefined;
};

const withTier = (detail: UsageDetail, tier: string | undefined): UsageDetail =>
  tier === undefined ? detail : { ...detail, responseServiceTier: tier };

/** `ParseOpenAIUsage` over a non-stream response body. */
export const parseOpenAIUsage = (body: string): UsageDetail => {
  const parsed = tryParseJson(body);
  const node = get(parsed, "usage");

  return withTier(
    hasUsageFields(node) ? parseOpenAIUsageNode(node) : emptyUsageDetail,
    responseServiceTier(parsed),
  );
};

/** `jsonPayload`: the JSON object carried by one SSE line, if any. */
export const ssePayloadObject = (line: string): Json | undefined => {
  let trimmed = line.trim();

  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return undefined;

  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();

  if (!trimmed.startsWith("{")) return undefined;
  const parsed = tryParseJson(trimmed);

  return isJsonObject(parsed) ? parsed : undefined;
};

/** `ParseOpenAIStreamUsage`: usage carried by one OpenAI-style stream line. */
export const parseOpenAIStreamUsage = (line: string): UsageDetail | undefined => {
  const payload = ssePayloadObject(line);

  if (payload === undefined) return undefined;
  const tier = responseServiceTier(payload);
  const node = get(payload, "usage");

  if (!hasUsageFields(node))
    return tier === undefined ? undefined : withTier(emptyUsageDetail, tier);

  return withTier(parseOpenAIUsageNode(node), tier);
};

/**
 * Model reported by the upstream (`response.model`, `interaction.model`, `model`, Claude `message.model`, Gemini
 * `modelVersion`), bounded to 256 chars (`extractGenericResponseModelEvent` without the terminal-event tracking).
 */
export const responseModelOf = (payload: Json | undefined): string | undefined => {
  for (const path of [
    "response.model",
    "interaction.model",
    "model",
    "message.model",
    "modelVersion",
    "response.modelVersion",
  ]) {
    const value = get(payload, path);

    if (typeof value === "string" && value.trim() !== "" && value.trim().length <= 256)
      return value.trim();
  }

  return undefined;
};

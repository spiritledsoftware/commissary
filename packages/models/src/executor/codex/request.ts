/**
 * Codex request body shaping.
 *
 * Go source: internal/runtime/executor/codex_executor_request.go (normalizeCodexInstructions,
 * ensureImageGenerationTool, normalizeCodexParallelToolCalls, cacheHelper prompt cache identity),
 * openai_responses_signature.go (sanitizeOpenAIResponsesReasoningEncryptedContent, non-compat variant),
 * helps/derived_session.go (ProviderSessionUUID), helps/claude_code_session.go (ClaudeCodePromptCache).
 * All functions mutate the parsed body in place and return it.
 */
import {
  asBool,
  asString,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  set,
} from "@commissary/json";
import {
  isValidGptReasoningSignature,
  detectSignatureProvider,
} from "@commissary/translation/signature";
import { uuidV5Oid } from "../helps/uuid.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import { isCodexResponsesLiteRequest } from "./headers.ts";
import { codexModelUsesResponsesLite, requestHasReasoningForHostedImage } from "./hosted-images.ts";
import { claudeCodeExecutionScope } from "./replay.ts";

/** `helps.SetStringIfDifferent` / `SetBoolIfDifferent`. */
export const setIfDifferent = (body: Json, path: string, value: string | boolean): Json =>
  get(body, path) === value ? body : set(body, path, value);

/** `normalizeCodexInstructions`: missing/null instructions become `""` (skipped for native requests). */
export const normalizeCodexInstructions = (body: Json, native: boolean): Json => {
  if (native) return body;
  const instructions = get(body, "instructions");

  return instructions === undefined || instructions === null ? set(body, "instructions", "") : body;
};

const isImageGenerationFunctionTool = (tool: Json): boolean => {
  switch (asString(get(tool, "type"))) {
    case "function":
      return asString(get(tool, "name")) === "image_gen.imagegen";
    case "namespace": {
      if (asString(get(tool, "name")) !== "image_gen") return false;
      const nested = get(tool, "tools");

      return (
        isJsonArray(nested) &&
        nested.some(
          (item) =>
            asString(get(item, "type")) === "function" &&
            asString(get(item, "name")) === "imagegen",
        )
      );
    }

    default:
      return false;
  }
};

const isFreePlan = (credential: CredentialSnapshot): boolean =>
  credential.provider.trim().toLowerCase() === "codex" &&
  (credential.attributes["plan_type"] ?? "").trim().toLowerCase() === "free";

/**
 * `ensureImageGenerationTool`: appends `{"type":"image_generation","output_format":"png"}` when absent. Skipped on
 * Responses-Lite requests, and on lite models that carry a reasoning configuration (714f0526: lite models without
 * reasoning get the tool, since the hosted tool only rejects `complexity` alongside reasoning effort).
 */
export const ensureImageGenerationTool = (
  body: Json,
  baseModel: string,
  credential: CredentialSnapshot,
  headers: Headers,
): Json => {
  if (
    isCodexResponsesLiteRequest(body, headers) ||
    (codexModelUsesResponsesLite(baseModel) &&
      requestHasReasoningForHostedImage(body, baseModel)) ||
    baseModel.endsWith("spark") ||
    isFreePlan(credential)
  )
    return body;
  const tools = get(body, "tools");

  if (!isJsonArray(tools))
    return set(body, "tools", [{ type: "image_generation", output_format: "png" }]);

  if (
    tools.some(
      (tool) =>
        asString(get(tool, "type")) === "image_generation" || isImageGenerationFunctionTool(tool),
    )
  ) {
    return body;
  }

  tools.push({ type: "image_generation", output_format: "png" });

  return body;
};

/** The smallest integer `max_output_tokens` the ChatGPT Codex backend accepts; smaller ones answer 400. */
export const CODEX_MIN_OUTPUT_TOKENS = 16;

/**
 * `normalizeCodexOutputBudgetDoc` (bfac8586): raises a positive integer `max_output_tokens` below 16 on the translated
 * body to the Codex minimum, whatever the source format. Missing, non-numeric, non-integral and non-positive budgets
 * are left for the upstream to reject. Runs before the payload rules so overrides and filters stay final.
 */
export const normalizeCodexOutputBudget = (body: Json): Json => {
  const budget = get(body, "max_output_tokens");

  if (typeof budget !== "number" || !Number.isInteger(budget)) return body;

  if (budget < 1 || budget >= CODEX_MIN_OUTPUT_TOKENS) return body;

  return set(body, "max_output_tokens", CODEX_MIN_OUTPUT_TOKENS);
};

/** `normalizeCodexParallelToolCalls`. */
export const normalizeParallelToolCalls = (body: Json, headers: Headers): Json => {
  if (isCodexResponsesLiteRequest(body, headers))
    return setIfDifferent(body, "parallel_tool_calls", false);

  if (get(body, "parallel_tool_calls") === undefined) return body;
  const tools = get(body, "tools");

  return isJsonArray(tools) && tools.length > 0 ? body : del(body, "parallel_tool_calls");
};

const summaryIsEmpty = (summary: Json | undefined): boolean =>
  summary === undefined || summary === null || (isJsonArray(summary) && summary.length === 0);

/**
 * `sanitizeOpenAIResponsesReasoningEncryptedContent`: reasoning `content` is cleared (cleartext is
 * promoted into an empty `summary`), invalid or foreign `encrypted_content` is dropped and, with `store` disabled,
 * orphan reasoning ids are removed so the backend does not look them up. With `keepForeign` (Meta) blobs of unknown
 * provenance are replayed as they are; only recognisably other providers' signatures are dropped. `isCompat`
 * (`is-compat` models such as DeepSeek) keeps the reasoning `content` and the ids, which those models replay.
 */
export const sanitizeReasoningEncryptedContent = (
  body: Json,
  keepForeign = false,
  isCompat = false,
): Json => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return body;
  const stripOrphanIds = !asBool(get(body, "store"));

  for (const item of input) {
    if (!isJsonObject(item) || asString(item["type"]).trim() !== "reasoning") continue;
    const content = item["content"];

    if (!isCompat && isJsonArray(content) && content.length > 0) {
      if (summaryIsEmpty(item["summary"])) {
        const parts: Json[] = [];

        for (const part of content) {
          if (asString(get(part, "type")).trim() !== "reasoning_text") continue;
          const text = asString(get(part, "text"));

          if (text !== "") parts.push({ type: "summary_text", text });
        }

        if (parts.length > 0) item["summary"] = parts;
      }

      item["content"] = [];
    }

    if (!("encrypted_content" in item)) {
      if (!isCompat && stripOrphanIds && "id" in item) delete item["id"];
      continue;
    }

    const encrypted = item["encrypted_content"];

    const valid =
      typeof encrypted === "string" &&
      encrypted === encrypted.trim() &&
      (isValidGptReasoningSignature(encrypted) ||
        (keepForeign && encrypted !== "" && detectSignatureProvider(encrypted) === "unknown"));

    if (valid) continue;
    delete item["encrypted_content"];

    if (!isCompat && stripOrphanIds && "id" in item) delete item["id"];
  }

  return body;
};

/** `helps.ProviderSessionUUID("codex", metadata)` for a derived session identity. */
export const providerSessionUuid = (sessionId: string | undefined): string => {
  const id = (sessionId ?? "").trim();

  return id === ""
    ? ""
    : uuidV5Oid(["cli-proxy-api", "codex", "derived-session", id].join("\u0000"));
};

export interface PromptCacheInput {
  readonly from: string;
  readonly model: string;
  /** `req.Payload` (client body). */
  readonly payload: Json;
  /** The translated body (for the model name). */
  readonly body: Json;
  readonly headers: Headers;
  readonly callerScope: string;
  readonly sessionId: string | undefined;
}

/** `cacheHelper`: the prompt cache id (`prompt_cache_key` + `Session-Id`) of the request; `""` when unknown. */
export const promptCacheId = (input: PromptCacheInput): string => {
  const from = input.from.trim().toLowerCase();
  let id = "";

  if (from === "claude") {
    let modelName = asString(get(input.body, "model")).trim();

    if (modelName === "") modelName = parseSuffix(input.model).modelName;
    const scope = claudeCodeExecutionScope(input.payload, input.headers);

    if (modelName !== "" && scope !== undefined) {
      id = uuidV5Oid(["cli-proxy-api:codex:claude-code", modelName, scope].join("\u0000"));
    }
  } else if (from === "openai-response") {
    const key = get(input.payload, "prompt_cache_key");

    if (key !== undefined) id = asString(key);
  } else if (from === "openai") {
    const key = get(input.payload, "prompt_cache_key");

    if (key !== undefined) id = asString(key).trim();

    if (id === "") id = providerSessionUuid(input.sessionId);

    if (id === "" && input.callerScope.trim() !== "") {
      id = uuidV5Oid(`cli-proxy-api:codex:prompt-cache:${input.callerScope.trim()}`);
    }
  }

  return id !== "" ? id : providerSessionUuid(input.sessionId);
};

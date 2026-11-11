/**
 * Codex request body shaping.
 *
 * Go source: internal/runtime/executor/codex_executor_request.go (normalizeCodexInstructions,
 * ensureImageGenerationTool, ensureWebSearchToolForHistory, normalizeCodexParallelToolCalls, cacheHelper prompt cache identity),
 * helps/derived_session.go (ProviderSessionUUID), helps/claude_code_session.go (ClaudeCodePromptCache).
 * All functions mutate the parsed body in place and return it.
 */
import { asString, del, get, isJsonArray, type Json, set } from "@commissary/json";
import { uuidV5Oid } from "../helps/uuid.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import { isCodexResponsesLiteRequest } from "./headers.ts";
import {
  codexModelUsesResponsesLite,
  type LiteRouteInput,
  requestHasReasoningForHostedImage,
  responsesLiteRequestForAuth,
} from "./hosted-images.ts";
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
 * `ensureImageGenerationTool`: appends `{"type":"image_generation","output_format":"png"}` when absent. `model` is the
 * requested model, suffix included. Skipped on Responses-Lite requests (body, client header, credential `header:`
 * attributes and model `override_header`), and on lite models that carry a reasoning configuration (714f0526: lite models without
 * reasoning get the tool, since the hosted tool only rejects `complexity` alongside reasoning effort).
 */
export const ensureImageGenerationTool = (
  body: Json,
  model: string,
  route: LiteRouteInput,
): Json => {
  const modelName = parseSuffix(model).modelName.trim();

  if (
    isFreePlan(route.credential) ||
    responsesLiteRequestForAuth(body, route) ||
    (codexModelUsesResponsesLite(modelName) && requestHasReasoningForHostedImage(body, model)) ||
    modelName.toLowerCase().endsWith("spark")
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

/** `isCodexWebSearchToolType`. */
const isWebSearchToolType = (type: string): boolean =>
  type === "web_search" ||
  type === "web_search_preview" ||
  type === "web_search_preview_2025_03_11";

/**
 * `ensureWebSearchToolForHistory` (CLIProxyAPI e7d4c731): reconciles replayed `web_search_call` input items with the
 * tool declarations, so Codex does not fail with "response protection is unavailable". A standard request without a
 * web search tool gets `{"type":"web_search"}` appended; a Responses-Lite request (which omits top-level hosted tools)
 * has the replayed search items stripped instead.
 */
export const ensureWebSearchToolForHistory = (body: Json, route: LiteRouteInput): Json => {
  const input = get(body, "input");

  if (
    !isJsonArray(input) ||
    !input.some((item) => asString(get(item, "type")).trim() === "web_search_call")
  )
    return body;

  const tools = get(body, "tools");

  if (
    isJsonArray(tools) &&
    tools.some((tool) => isWebSearchToolType(asString(get(tool, "type")).trim()))
  )
    return body;

  if (responsesLiteRequestForAuth(body, route)) {
    return set(
      body,
      "input",
      input.filter((item) => asString(get(item, "type")).trim() !== "web_search_call"),
    );
  }

  if (!isJsonArray(tools)) return set(body, "tools", [{ type: "web_search" }]);
  tools.push({ type: "web_search" });

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

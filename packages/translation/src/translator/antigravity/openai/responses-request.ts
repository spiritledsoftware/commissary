/**
 * OpenAI Responses client -> Antigravity provider (request envelope).
 *
 * Go source: internal/translator/antigravity/openai/responses/antigravity_openai-responses_request.go. Registered as a
 * request *envelope* transform because native web search depends on the resolved model capabilities.
 */
import {
  asString,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { signatureProviderFromModelName } from "../../../signature/provider.ts";
import { compatibleAntigravityClaudeThinkingSignature } from "../../../signature/claude.ts";
import {
  applySummaryConfig,
  extractSummaryConfig,
  parseSuffix,
  UNSPECIFIED_SUMMARY,
} from "../../../thinking/index.ts";
import { lookupModelInfo } from "../../model-info.ts";
import { type RequestEnvelope, TranslationError } from "../../registry.ts";
import {
  allowsResponsesWebSearchToolChoice,
  extractResponsesWebSearchAllowedDomains,
  hasOnlyResponsesWebSearchTools,
} from "../../gemini/openai/responses/web-search.ts";
import { convertOpenAIResponsesRequestToGemini } from "../../gemini/openai/responses/request.ts";
import { convertGeminiRequestToAntigravity } from "../gemini/request.ts";

export const ANTIGRAVITY_WEB_SEARCH_SYSTEM_INSTRUCTION =
  "You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.";

/** `antigravitySupportsNativeResponsesWebSearch`: the envelope's model info first, then the Antigravity registry record. */
const supportsNativeWebSearch = (model: string, envelope: RequestEnvelope): boolean => {
  const explicit = envelope.modelInfo?.nativeCapabilities?.webSearch;

  if (typeof explicit === "boolean") return explicit;
  const base = parseSuffix(model.trim()).modelName.trim();

  if (base === "") return false;
  const local = lookupModelInfo(base, "antigravity");

  if (local === undefined) return false;

  if (local.nativeCapabilities?.webSearch === false) return false;

  return local.supportsWebSearch === true;
};

/**
 * `stripAntigravityServerSideToolInvocations`: removes the `includeServerSideToolInvocations` the shared Gemini Responses
 * translator sets (Antigravity does not support it), and the `toolConfig` it leaves empty (CLIProxyAPI 45501610).
 */
const stripServerSideToolInvocations = (payload: Json): Json => {
  for (const toolConfigPath of ["toolConfig", "request.toolConfig"]) {
    const flagPath = `${toolConfigPath}.includeServerSideToolInvocations`;

    if (get(payload, flagPath) === undefined) continue;
    del(payload, flagPath);
    const toolConfig = get(payload, toolConfigPath);

    if (isJsonObject(toolConfig) && Object.keys(toolConfig).length === 0)
      del(payload, toolConfigPath);
  }

  return payload;
};

/** `stripAntigravityResponsesGoogleSearch`. */
const stripGoogleSearch = (payload: Json): Json => {
  for (const path of ["tools", "request.tools"]) {
    const tools = get(payload, path);

    if (!isJsonArray(tools)) continue;
    const filtered = tools.filter((tool) => get(tool, "googleSearch") === undefined);

    if (filtered.length === tools.length) continue;

    if (filtered.length === 0) del(payload, path);
    else set(payload, path, filtered);
  }

  return stripServerSideToolInvocations(payload);
};

/** `enableAntigravityResponsesThinkingSummary`: an effort without a summary choice enables summaries. */
const enableThinkingSummary = (input: Json, translated: Json): Json => {
  const effort = get(input, "reasoning.effort");

  if (typeof effort !== "string") return translated;
  const value = effort.trim().toLowerCase();

  if (value === "" || value === "none") return translated;
  let config = extractSummaryConfig(input, "openai-response");

  if (config.mode === UNSPECIFIED_SUMMARY.mode) config = { mode: "enabled", detail: "auto" };

  return applySummaryConfig(translated, "antigravity", config) ?? translated;
};

interface ClaudeReasoningSignature {
  readonly signature: string;
}

/** `antigravityClaudeReasoningSignatures`: the replayable Claude signature of every `reasoning` input item, in order. */
const claudeReasoningSignatures = (input: Json): ClaudeReasoningSignature[] => {
  const items = get(input, "input");

  if (!isJsonArray(items)) return [];
  const out: ClaudeReasoningSignature[] = [];

  for (const item of items) {
    let type = asString(get(item, "type"));

    if (type === "" && get(item, "role") !== undefined) type = "message";

    if (type !== "reasoning") continue;
    out.push({
      signature:
        compatibleAntigravityClaudeThinkingSignature(asString(get(item, "encrypted_content"))) ??
        "",
    });
  }

  return out;
};

/** `rewriteOpenAIResponsesReasoningForAntigravityClaude`: replaces thought signatures with the replayable Claude ones. */
const rewriteReasoningForClaude = (modelName: string, input: Json, gemini: Json): Json => {
  if (signatureProviderFromModelName(modelName) !== "claude") return gemini;
  const signatures = claudeReasoningSignatures(input);

  if (signatures.length === 0) return gemini;
  const contents = get(gemini, "contents");

  if (!isJsonArray(contents)) return gemini;
  let reasoningIndex = 0;
  let changed = false;
  const rewrittenContents: Json[] = [];

  for (const content of contents) {
    const parts = isJsonObject(content) ? content["parts"] : undefined;

    if (!isJsonObject(content) || !isJsonArray(parts)) {
      rewrittenContents.push(content);
      continue;
    }

    const rewrittenParts: Json[] = [];

    for (const part of parts) {
      if (!isJsonObject(part) || part["thought"] !== true) {
        rewrittenParts.push(part);
        continue;
      }

      const reasoning = signatures[reasoningIndex];
      reasoningIndex++;

      if (reasoning === undefined || reasoning.signature === "") {
        changed = true;
        continue;
      }

      if (typeof part["text"] !== "string" || part["text"].trim() === "") {
        changed = true;
        continue;
      }

      if (part["thoughtSignature"] !== reasoning.signature) changed = true;
      part["thoughtSignature"] = reasoning.signature;
      rewrittenParts.push(part);
    }

    if (rewrittenParts.length === 0) {
      changed = true;
      continue;
    }

    content["parts"] = rewrittenParts;
    rewrittenContents.push(content);
  }

  if (!changed) return gemini;
  set(gemini, "contents", rewrittenContents);

  return gemini;
};

const ensureWebSearchTool = (payload: Json, includedDomains: ReadonlyArray<string>): void => {
  const googleSearch: JsonObject = { enhancedContent: { imageSearch: { maxResultCount: 5 } } };

  if (includedDomains.length > 0) googleSearch["includedDomains"] = [...includedDomains];
  const tool: Json = { googleSearch };
  const tools = get(payload, "request.tools");

  if (!isJsonArray(tools)) {
    set(payload, "request.tools", [tool]);

    return;
  }

  let replaced = false;
  const filtered: Json[] = [];

  for (const existing of tools) {
    if (get(existing, "googleSearch") !== undefined) {
      if (!replaced) {
        filtered.push(tool);
        replaced = true;
      }

      continue;
    }

    filtered.push(existing);
  }

  if (!replaced) filtered.unshift(tool);
  set(payload, "request.tools", filtered);
};

const ensureWebSearchSystemInstruction = (payload: Json): void => {
  const searchPart: Json = { text: ANTIGRAVITY_WEB_SEARCH_SYSTEM_INSTRUCTION };
  const system = get(payload, "request.systemInstruction");

  if (system === undefined) {
    set(payload, "request.systemInstruction", { role: "user", parts: [searchPart] });

    return;
  }

  const parts: Json[] = [];
  let alreadyPresent = false;
  const existing = get(system, "parts");

  if (isJsonArray(existing)) {
    for (const part of existing) {
      if (asString(get(part, "text")) === ANTIGRAVITY_WEB_SEARCH_SYSTEM_INSTRUCTION)
        alreadyPresent = true;
      parts.push(part);
    }
  }

  if (!alreadyPresent) parts.push(searchPart);
  set(payload, "request.systemInstruction.parts", parts);
};

type ToGeminiResult = { body: Json; error?: TranslationError };

/** Runs the Gemini conversion, keeping a refusal's partial body like Go's `(body, err)` pair. */
const toGemini = (model: string, body: Json, stream: boolean): ToGeminiResult => {
  try {
    return { body: convertOpenAIResponsesRequestToGemini(model, body, stream) };
  } catch (error) {
    if (error instanceof TranslationError && error.body !== undefined)
      return { body: error.body, error };
    throw error;
  }
};

/** `ConvertOpenAIResponsesRequestEnvelopeToAntigravity`. */
export const convertOpenAIResponsesRequestEnvelopeToAntigravity = (
  envelope: RequestEnvelope,
): RequestEnvelope => {
  const input = envelope.body;
  const { model, stream } = envelope;

  const webSearch =
    hasOnlyResponsesWebSearchTools(input) &&
    supportsNativeWebSearch(model, envelope) &&
    allowsResponsesWebSearchToolChoice(input);

  if (webSearch) {
    const includedDomains = extractResponsesWebSearchAllowedDomains(input);
    const converted = toGemini(model, input, stream);

    const gemini = rewriteReasoningForClaude(
      model,
      input,
      stripServerSideToolInvocations(converted.body),
    );

    const out = convertGeminiRequestToAntigravity(model, gemini, stream);
    set(out, "requestType", "web_search");
    ensureWebSearchTool(out, includedDomains);
    ensureWebSearchSystemInstruction(out);
    const body = enableThinkingSummary(input, out);

    return {
      ...envelope,
      body,
      ...(converted.error !== undefined ? { error: converted.error } : {}),
    };
  }

  const converted = toGemini(model, input, stream);
  let gemini = stripGoogleSearch(converted.body);
  gemini = rewriteReasoningForClaude(model, input, gemini);
  let out = convertGeminiRequestToAntigravity(model, gemini, stream);
  out = stripGoogleSearch(out);
  out = enableThinkingSummary(input, out);

  return {
    ...envelope,
    body: out,
    ...(converted.error !== undefined ? { error: converted.error } : {}),
  };
};

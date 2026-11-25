/**
 * What the Antigravity web search requests of the OpenAI chat and Responses translators share.
 *
 * Go source: `antigravitySupportsNativeOpenAIWebSearch` and `buildAntigravityOpenAIWebSearchRequest` in
 * internal/translator/antigravity/openai/chat-completions/antigravity_openai_request.go, and
 * `antigravitySupportsNativeResponsesWebSearch`, `ensureAntigravityWebSearchTool` and
 * `ensureAntigravityWebSearchSystemInstruction` in
 * internal/translator/antigravity/openai/responses/antigravity_openai-responses_request.go.
 */
import { asString, get, isJsonArray, type Json, type JsonObject, set } from "@commissary/json";
import { parseSuffix, type ThinkingModelInfo } from "../../../thinking/index.ts";
import { lookupModelInfo } from "../../model-info.ts";

export const ANTIGRAVITY_WEB_SEARCH_SYSTEM_INSTRUCTION =
  "You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.";

/**
 * Whether the model runs Google Search natively: the request's model info decides when it says so, then the
 * Antigravity registry record (its capability veto first). Go's chat translator also accepts the request's
 * `supportsWebSearch` (`requestSupportsWebSearch`); its Responses translator does not.
 */
export const supportsNativeAntigravityWebSearch = (
  model: string,
  modelInfo: ThinkingModelInfo | undefined,
  options: { readonly requestSupportsWebSearch: boolean },
): boolean => {
  const explicit = modelInfo?.nativeCapabilities?.webSearch;

  if (typeof explicit === "boolean") return explicit;
  const requested = options.requestSupportsWebSearch && modelInfo?.supportsWebSearch === true;
  const base = parseSuffix(model.trim()).modelName.trim();

  if (base === "") return false;
  const local = lookupModelInfo(base, "antigravity");

  if (local === undefined) return requested;

  if (local.nativeCapabilities?.webSearch === false) return false;

  return local.supportsWebSearch === true || requested;
};

/** The `googleSearch` tool of a web search request, with the client's own settings over the defaults. */
export const antigravityGoogleSearchTool = (settings: JsonObject): Json => ({
  googleSearch: { enhancedContent: { imageSearch: { maxResultCount: 5 } }, ...settings },
});

/** The web search instruction after the request's system parts, once. */
export const appendWebSearchSystemInstruction = (payload: Json): void => {
  const existing = get(payload, "request.systemInstruction.parts");
  const parts = isJsonArray(existing) ? [...existing] : [];

  if (
    !parts.some((part) => asString(get(part, "text")) === ANTIGRAVITY_WEB_SEARCH_SYSTEM_INSTRUCTION)
  )
    parts.push({ text: ANTIGRAVITY_WEB_SEARCH_SYSTEM_INSTRUCTION });
  set(payload, "request.systemInstruction.role", "user");
  set(payload, "request.systemInstruction.parts", parts);
};

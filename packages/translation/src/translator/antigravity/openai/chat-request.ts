/**
 * OpenAI Chat Completions client -> Antigravity provider (request).
 *
 * Go source: internal/translator/antigravity/openai/chat-completions/antigravity_openai_request.go.
 */
import {
  asFloat,
  asInt,
  asString,
  del,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { extractSummaryConfig, applySummaryConfig } from "../../../thinking/index.ts";
import { sanitizeClaudeToolId } from "../../common/tool-names.ts";
import { countSendableGeminiParts, UserTurnDrops } from "../../common/parts.ts";
import { systemReminderText } from "../../common/claude-messages.ts";
import { normalizeOpenAIFileData } from "../../common/file-data.ts";
import { attachDefaultSafetySettings } from "../../gemini/common/safety.ts";
import { renameKey } from "../../gemini/gemini/gemini.ts";
import { mapSanitizedFunctionName, sanitizedFunctionNameMap } from "../../common/tool-names.ts";
import { sanitizeAntigravityClaudeGeminiRequestSignatures } from "../gemini/request.ts";
import { contentHasGeminiFunctionResponse } from "../../gemini/common/contents.ts";
import { type RequestEnvelope, TranslationError } from "../../registry.ts";
import type { ThinkingModelInfo } from "../../../thinking/index.ts";
import { normalizeAntigravityRequest } from "../common/request-format.ts";
import {
  antigravityGoogleSearchTool,
  appendWebSearchSystemInstruction,
  supportsNativeAntigravityWebSearch,
} from "../common/web-search.ts";

const FUNCTION_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const textPart = (text: string): JsonObject => ({ text });

/** Antigravity reads camelCase media fields only (CLIProxyAPI 08098d24). */
const inlineDataPart = (mimeType: string, data: string): JsonObject => ({
  inlineData: { mimeType, data },
});

const contentNode = (role: string, parts: Json[]): JsonObject => ({ role, parts });

const audioMimeType = (format: string): string => {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "webm":
      return "audio/webm";
    case "pcm16":
      return "audio/pcm";
    case "g711_ulaw":
    case "g711_alaw":
      return "audio/basic";
    case "":
    case "wav":
      return "audio/wav";
    default:
      return `audio/${format}`;
  }
};

/** `antigravityDemotedSystemText`. */
const demotedSystemText = (text: string, isDemoted: boolean): string =>
  !isDemoted || text.trim() === "" ? text : systemReminderText(text);

const sameJson = (a: Json | undefined, b: Json | undefined): boolean =>
  a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

const setRawIfDifferent = (out: Json, path: string, value: Json): void => {
  if (!sameJson(get(out, path), value)) set(out, path, structuredClone(value));
};

const setBoolIfValid = (out: Json, path: string, value: Json | undefined): void => {
  if (typeof value === "boolean" && get(out, path) !== value) set(out, path, value);
};

/** `normalizeAntigravityOpenAIThinkingConfig`. */
const normalizeThinkingConfig = (out: Json): void => {
  const target = "request.generationConfig.thinkingConfig";

  for (const prefix of [
    "request.generationConfig.thinking_config",
    "request.generationConfig.thinkingConfig",
  ]) {
    for (const key of ["includeThoughts", "include_thoughts"]) {
      const sourcePath = `${prefix}.${key}`;
      const value = get(out, sourcePath);

      if (value === undefined) continue;
      setBoolIfValid(out, `${target}.includeThoughts`, value);

      if (typeof value !== "boolean") del(out, sourcePath);
    }

    for (const [key, destination] of [
      ["thinkingLevel", "thinkingLevel"],
      ["thinking_level", "thinkingLevel"],
      ["thinkingBudget", "thinkingBudget"],
      ["thinking_budget", "thinkingBudget"],
    ] as const) {
      const value = get(out, `${prefix}.${key}`);

      if (value !== undefined) setRawIfDifferent(out, `${target}.${destination}`, value);
    }
  }

  for (const path of [
    "request.generationConfig.includeThoughts",
    "request.generationConfig.include_thoughts",
  ]) {
    const value = get(out, path);

    if (value !== undefined) setBoolIfValid(out, `${target}.includeThoughts`, value);
  }

  for (const path of [
    "request.generationConfig.thinking_config",
    `${target}.include_thoughts`,
    `${target}.thinking_level`,
    `${target}.thinking_budget`,
    "request.generationConfig.includeThoughts",
    "request.generationConfig.include_thoughts",
  ]) {
    if (exists(out, path)) del(out, path);
  }
};

const applyThinkingCompatibility = (out: Json, raw: Json): Json => {
  normalizeThinkingConfig(out);

  return applySummaryConfig(out, "antigravity", extractSummaryConfig(raw, "openai")) ?? out;
};

/** `applyOpenAIToolChoiceToAntigravity`. */
const applyToolChoice = (
  out: Json,
  raw: Json,
  nameMap: ReadonlyMap<string, string> | undefined,
): void => {
  const toolChoice = get(raw, "tool_choice");

  if (toolChoice === undefined) return;
  let mode = "";
  let allowedName = "";

  if (typeof toolChoice === "string") {
    switch (toolChoice.trim().toLowerCase()) {
      case "none":
        mode = "NONE";
        break;
      case "auto":
        mode = "AUTO";
        break;
      case "required":
      case "any":
        mode = "ANY";
        break;
    }
  } else if (isJsonObject(toolChoice)) {
    switch (asString(toolChoice["type"]).trim().toLowerCase()) {
      case "none":
        mode = "NONE";
        break;
      case "function":
        mode = "ANY";
        allowedName = asString(get(toolChoice, "function.name"));
        break;
    }
  }

  if (mode === "") return;
  set(out, "request.toolConfig.functionCallingConfig.mode", mode);

  if (allowedName.trim() !== "") {
    set(out, "request.toolConfig.functionCallingConfig.allowedFunctionNames", [
      mapSanitizedFunctionName(nameMap, allowedName),
    ]);
  }
};

/** `DeduplicateFunctionDeclarations`. */
export const deduplicateFunctionDeclarations = (declarations: ReadonlyArray<Json>): Json[] => {
  const seen = new Set<string>();
  const out: Json[] = [];

  for (const declaration of declarations) {
    const name = asString(get(declaration, "name"));

    if (name !== "") {
      if (seen.has(name)) continue;
      seen.add(name);
    }

    out.push(declaration);
  }

  return out;
};

/** A converted turn, and whether it may join a preceding tool-response turn (only real user turns may). */
interface ChatContent {
  readonly content: Json;
  readonly mergeable: boolean;
}

const convertMessages = (
  out: Json,
  messages: Json[],
  nameMap: ReadonlyMap<string, string> | undefined,
  drops: UserTurnDrops,
): void => {
  const systemParts: Json[] = [];
  const contentItems: ChatContent[] = [];

  const appendContent = (content: Json, mergeable: boolean): void => {
    contentItems.push({ content, mergeable });
  };

  let hasEncounteredConversation = false;

  for (let i = 0; i < messages.length; i++) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    const m = messages[i] as Json;
    const role = asString(get(m, "role"));
    const content = get(m, "content");

    if (
      (role === "system" || role === "developer") &&
      messages.length > 1 &&
      !hasEncounteredConversation
    ) {
      if (typeof content === "string") systemParts.push(textPart(content));
      else if (isJsonObject(content) && asString(content["type"]) === "text")
        systemParts.push(textPart(asString(content["text"])));
      else if (isJsonArray(content))
        for (const part of content) systemParts.push(textPart(asString(get(part, "text"))));
    } else if (role === "user" || role === "system" || role === "developer") {
      hasEncounteredConversation = true;
      const isDemoted = role === "system" || role === "developer";
      const partItems: JsonObject[] = [];

      if (typeof content === "string")
        partItems.push(textPart(demotedSystemText(content, isDemoted)));
      else if (isJsonObject(content) && asString(content["type"]) === "text") {
        partItems.push(textPart(demotedSystemText(asString(content["text"]), isDemoted)));
      } else if (isJsonArray(content)) {
        for (const item of content) {
          switch (asString(get(item, "type"))) {
            case "text": {
              const text = asString(get(item, "text"));

              if (text !== "") partItems.push(textPart(demotedSystemText(text, isDemoted)));
              break;
            }

            case "image_url": {
              // Only a base64 data URL can be inlined; a remote URL has no equivalent here.
              const file = normalizeOpenAIFileData("", "", asString(get(item, "image_url.url")));

              if (file !== undefined) partItems.push(inlineDataPart(file.mimeType, file.data));
              else drops.drop("image_url");
              break;
            }

            case "video_url": {
              const file = normalizeOpenAIFileData("", "", asString(get(item, "video_url.url")));

              if (file !== undefined) partItems.push(inlineDataPart(file.mimeType, file.data));
              else drops.drop("video_url");
              break;
            }

            case "file": {
              const file = normalizeOpenAIFileData(
                asString(get(item, "file.filename")),
                "",
                asString(get(item, "file.file_data")),
              );

              if (file !== undefined) partItems.push(inlineDataPart(file.mimeType, file.data));
              else drops.drop("file");
              break;
            }

            case "input_audio": {
              const data = asString(get(item, "input_audio.data"));

              if (data !== "") {
                partItems.push(
                  inlineDataPart(audioMimeType(asString(get(item, "input_audio.format"))), data),
                );
              } else drops.drop("input_audio");
              break;
            }
          }
        }
      }

      // Whitespace-only text is forwarded but never keeps an emptied turn alive.
      drops.endTurn(countSendableGeminiParts(partItems));

      if (partItems.length > 0) appendContent(contentNode("user", partItems), role === "user");
    } else if (role === "assistant") {
      hasEncounteredConversation = true;
      const partItems: Json[] = [];
      const reasoning = get(m, "reasoning_content");

      if (typeof reasoning === "string" && reasoning !== "")
        partItems.push({ ...textPart(reasoning), thought: true });

      if (typeof content === "string" && content !== "") partItems.push(textPart(content));
      else if (isJsonArray(content)) {
        for (const item of content) {
          switch (asString(get(item, "type"))) {
            case "text": {
              const text = asString(get(item, "text"));

              if (text !== "") partItems.push(textPart(text));
              break;
            }

            case "image_url": {
              // A data URL parses like a user's, parameters and all (CLIProxyAPI 3307446a).
              const file = normalizeOpenAIFileData("", "", asString(get(item, "image_url.url")));

              if (file !== undefined) partItems.push(inlineDataPart(file.mimeType, file.data));
              break;
            }
          }
        }
      }

      const toolCalls = get(m, "tool_calls");

      if (isJsonArray(toolCalls)) {
        const calls: Array<{ rawId: string; id: string; name: string }> = [];
        const usedIds = new Set<string>();

        for (const tc of toolCalls) {
          if (asString(get(tc, "type")) !== "function") continue;
          const rawId = asString(get(tc, "id"));
          const baseId = sanitizeClaudeToolId(rawId);
          let functionId = baseId;
          let suffix = 1;

          while (usedIds.has(functionId)) functionId = `${baseId}_${suffix++}`;
          usedIds.add(functionId);

          const functionName = mapSanitizedFunctionName(
            nameMap,
            asString(get(tc, "function.name")),
          );

          if (functionName === "") continue;
          const args = asString(get(tc, "function.arguments"));
          const parsed = tryParseJson(args);

          const part: JsonObject = {
            functionCall: {
              id: functionId,
              name: functionName,
              args: parsed !== undefined ? parsed : { params: args },
            },
          };

          part["thoughtSignature"] = FUNCTION_THOUGHT_SIGNATURE;
          partItems.push(part);
          calls.push({ rawId, id: functionId, name: functionName });
        }

        if (partItems.length > 0) appendContent(contentNode("model", partItems), false);

        // Tool responses scoped to this assistant turn.
        const turnResponses = new Map<string, string>();

        for (let j = i + 1; j < messages.length; j++) {
          const nextRole = asString(get(messages[j], "role"));

          if (nextRole === "assistant") break;

          if (nextRole === "tool") {
            const callId = asString(get(messages[j], "tool_call_id"));

            if (callId !== "") turnResponses.set(callId, asString(get(messages[j], "content")));
          }
        }

        const responseParts: Json[] = [];

        for (const call of calls) {
          let response = turnResponses.get(call.rawId) ?? "";

          if (response === "") response = "{}";
          // Kept as a string: parsing it as JSON may trigger an upstream 400.
          responseParts.push({
            functionResponse: { id: call.id, name: call.name, response: { result: response } },
          });
        }

        if (responseParts.length > 0) appendContent(contentNode("user", responseParts), false);
      } else if (partItems.length > 0) {
        appendContent(contentNode("model", partItems), false);
      }
    }
  }

  if (systemParts.length > 0)
    set(out, "request.systemInstruction", contentNode("user", systemParts));
  set(out, "request.contents", mergeToolResponseUserContents(contentItems));
};

/**
 * `mergeAntigravityOpenAIToolResponseUserContents`: user turns that follow a tool-response turn join it, so the
 * responses and the user's follow-up go upstream as one user turn (CLIProxyAPI 9ac1cd7d).
 */
const mergeToolResponseUserContents = (items: ReadonlyArray<ChatContent>): Json[] => {
  const contents = items.map((item) => item.content);

  if (contents.length <= 1) return contents;
  const merged: Json[] = [];

  for (let i = 0; i < contents.length; i++) {
    // SAFETY: the index is in bounds (loop bound); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    const content = contents[i] as Json;

    if (asString(get(content, "role")) !== "user" || !contentHasGeminiFunctionResponse(content)) {
      merged.push(content);
      continue;
    }

    let j = i + 1;

    while (j < items.length && items[j]?.mergeable === true) j++;

    if (j === i + 1) {
      merged.push(content);
      continue;
    }

    const parts = contents.slice(i, j).flatMap((current) => {
      const currentParts = get(current, "parts");

      return isJsonArray(currentParts) ? currentParts : [];
    });

    merged.push({ ...(isJsonObject(content) ? content : {}), parts });
    i = j - 1;
  }

  return merged;
};

const convertTools = (
  out: Json,
  tools: Json[],
  nameMap: ReadonlyMap<string, string> | undefined,
): void => {
  const functionDeclarations: Json[] = [];
  const codeExecutionNodes: Json[] = [];
  const urlContextNodes: Json[] = [];

  for (const t of tools) {
    if (asString(get(t, "type")) === "function") {
      const fn = get(t, "function");

      if (isJsonObject(fn)) {
        const declaration = structuredClone(fn);

        if (exists(declaration, "parameters"))
          renameKey(declaration, "parameters", "parametersJsonSchema");
        else {
          set(declaration, "parametersJsonSchema.type", "object");
          set(declaration, "parametersJsonSchema.properties", {});
        }

        const original = asString(get(fn, "name"));
        const mapped = mapSanitizedFunctionName(nameMap, original);

        if (typeof get(fn, "name") !== "string" || mapped !== original)
          declaration["name"] = mapped;

        if (exists(declaration, "strict")) del(declaration, "strict");
        functionDeclarations.push(declaration);
      }
    }

    // Google Search runs only in a dedicated web search request (`buildWebSearchRequest`): beside chat tools it is
    // dropped, while code execution and URL context stay (CLIProxyAPI 28134004, d3d2817d).
    const codeExecution = get(t, "code_execution");

    if (codeExecution !== undefined)
      codeExecutionNodes.push({ codeExecution: structuredClone(codeExecution) });
    const urlContext = get(t, "url_context");

    if (urlContext !== undefined) urlContextNodes.push({ urlContext: structuredClone(urlContext) });
  }

  const deduplicated = deduplicateFunctionDeclarations(functionDeclarations);
  const hasFunction = deduplicated.length > 0;

  const items: Json[] = [];

  if (hasFunction) items.push({ functionDeclarations: deduplicated });
  items.push(...codeExecutionNodes, ...urlContextNodes);

  if (items.length > 0) set(out, "request.tools", items);
};

/** The converted chat request and the user parts it had to drop. */
interface ConvertedChat {
  readonly body: Json;
  readonly drops: UserTurnDrops;
}

/** `convertOpenAIRequestToAntigravityChat`: the body, and the drops that may refuse it. */
const convertChat = (modelName: string, raw: Json): ConvertedChat => {
  const drops = new UserTurnDrops();
  const nameMap = sanitizedFunctionNameMap(raw);
  const out: Json = { project: "", request: { contents: [] }, model: modelName };

  // User-provided generationConfig passes through.
  const genConfig = get(raw, "generationConfig") ?? get(raw, "generation_config");

  if (genConfig !== undefined) set(out, "request.generationConfig", structuredClone(genConfig));

  const reasoningEffort = get(raw, "reasoning_effort");

  if (reasoningEffort !== undefined) {
    const effort = asString(reasoningEffort).trim().toLowerCase();

    if (effort !== "") {
      const path = "request.generationConfig.thinkingConfig";

      if (effort === "auto") set(out, `${path}.thinkingBudget`, -1);
      else set(out, `${path}.thinkingLevel`, effort);
    }
  }

  const compatible = applyThinkingCompatibility(out, raw);

  const numeric = (key: string): number | undefined => {
    const value = get(raw, key);

    return typeof value === "number" ? asFloat(value) : undefined;
  };

  const temperature = numeric("temperature");

  if (temperature !== undefined)
    set(compatible, "request.generationConfig.temperature", temperature);
  const topP = numeric("top_p");

  if (topP !== undefined) set(compatible, "request.generationConfig.topP", topP);
  const topK = numeric("top_k");

  if (topK !== undefined) set(compatible, "request.generationConfig.topK", topK);
  const maxTokens = numeric("max_tokens") ?? numeric("max_completion_tokens");

  if (maxTokens !== undefined)
    set(compatible, "request.generationConfig.maxOutputTokens", maxTokens);

  const responseFormat = get(raw, "response_format");

  if (responseFormat !== undefined) {
    const type = asString(get(responseFormat, "type")).trim().toLowerCase();

    if (type === "json_object" || type === "json_schema") {
      for (const key of [
        "responseSchema",
        "responseJsonSchema",
        "response_schema",
        "response_json_schema",
      ]) {
        del(compatible, `request.generationConfig.${key}`);
      }

      set(compatible, "request.generationConfig.responseMimeType", "application/json");

      if (type === "json_schema") {
        const schema = get(responseFormat, "json_schema.schema");

        if (schema !== undefined)
          set(compatible, "request.generationConfig.responseSchema", structuredClone(schema));
      }
    }
  }

  const n = get(raw, "n");

  if (typeof n === "number" && asInt(n) > 1)
    set(compatible, "request.generationConfig.candidateCount", asInt(n));

  const modalities = get(raw, "modalities");

  if (isJsonArray(modalities)) {
    const responseModalities: string[] = [];

    for (const modality of modalities) {
      switch (asString(modality).toLowerCase()) {
        case "text":
          responseModalities.push("TEXT");
          break;
        case "image":
          responseModalities.push("IMAGE");
          break;
      }
    }

    if (responseModalities.length > 0)
      set(compatible, "request.generationConfig.responseModalities", responseModalities);
  }

  const imageConfig = get(raw, "image_config");

  if (isJsonObject(imageConfig)) {
    const aspectRatio = imageConfig["aspect_ratio"];

    if (typeof aspectRatio === "string")
      set(compatible, "request.generationConfig.imageConfig.aspectRatio", aspectRatio);
    const imageSize = imageConfig["image_size"];

    if (typeof imageSize === "string")
      set(compatible, "request.generationConfig.imageConfig.imageSize", imageSize);
  }

  const messages = get(raw, "messages");

  if (isJsonArray(messages)) convertMessages(compatible, messages, nameMap, drops);

  const tools = get(raw, "tools");

  if (isJsonArray(tools) && tools.length > 0) convertTools(compatible, tools, nameMap);

  applyToolChoice(compatible, raw, nameMap);

  if (modelName.toLowerCase().includes("claude"))
    sanitizeAntigravityClaudeGeminiRequestSignatures(compatible);

  const body = normalizeAntigravityRequest(
    attachDefaultSafetySettings(compatible, "request.safetySettings"),
  );

  return { body, drops };
};

/** `hasOnlyAntigravityOpenAIWebSearchTools`: one tool, a bare `google_search`. */
const hasOnlyWebSearchTools = (raw: Json): boolean => {
  const tools = get(raw, "tools");

  if (!isJsonArray(tools) || tools.length !== 1) return false;
  const tool = tools[0];

  return (
    exists(tool, "google_search") &&
    asString(get(tool, "type")) !== "function" &&
    !exists(tool, "code_execution") &&
    !exists(tool, "url_context")
  );
};

/** `allowsAntigravityOpenAIWebSearch`. */
const allowsWebSearch = (raw: Json): boolean => {
  const toolChoice = get(raw, "tool_choice");

  if (toolChoice === undefined) return true;
  const allowed = ["", "auto", "required", "any"];

  if (typeof toolChoice === "string") return allowed.includes(toolChoice.trim().toLowerCase());

  if (!isJsonObject(toolChoice)) return false;
  const type = asString(toolChoice["type"]).trim().toLowerCase();

  return allowed.includes(type) || type === "google_search";
};

/** `buildAntigravityOpenAIWebSearchRequest`: the chat request as a dedicated web search request. */
const buildWebSearchRequest = (body: Json, raw: Json): Json => {
  set(body, "requestType", "web_search");
  set(body, "request.generationConfig.candidateCount", 1);
  appendWebSearchSystemInstruction(body);
  const source = get(raw, "tools.0.google_search");
  set(body, "request.tools", [
    antigravityGoogleSearchTool(isJsonObject(source) ? structuredClone(source) : {}),
  ]);
  del(body, "request.toolConfig.functionCallingConfig");
  const toolConfig = get(body, "request.toolConfig");

  if (isJsonObject(toolConfig) && Object.keys(toolConfig).length === 0)
    del(body, "request.toolConfig");

  return normalizeAntigravityRequest(body);
};

/**
 * `ConvertOpenAIRequestToAntigravity`: a search-only request on a model with native search becomes a web search
 * request (CLIProxyAPI 28134004).
 */
export const convertOpenAIRequestToAntigravity = (
  modelName: string,
  raw: Json,
  _stream: boolean,
  modelInfo?: ThinkingModelInfo,
): Json => {
  const webSearch =
    hasOnlyWebSearchTools(raw) &&
    supportsNativeAntigravityWebSearch(modelName, modelInfo, { requestSupportsWebSearch: true }) &&
    allowsWebSearch(raw);

  const converted = convertChat(modelName, raw);
  const body = webSearch ? buildWebSearchRequest(converted.body, raw) : converted.body;
  const refusal = converted.drops.err(body);

  if (refusal !== undefined) throw refusal;

  return body;
};

/** `ConvertOpenAIRequestEnvelopeToAntigravity`: the request with the envelope's model capabilities. */
export const convertOpenAIRequestEnvelopeToAntigravity = (
  envelope: RequestEnvelope,
): RequestEnvelope => {
  try {
    return {
      ...envelope,
      body: convertOpenAIRequestToAntigravity(
        envelope.model,
        envelope.body,
        envelope.stream,
        envelope.modelInfo,
      ),
    };
  } catch (error) {
    if (error instanceof TranslationError)
      return { ...envelope, ...(error.body !== undefined ? { body: error.body } : {}), error };
    throw error;
  }
};

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

const FUNCTION_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const textPart = (text: string): JsonObject => ({ text });

const inlineDataPart = (mimeType: string, data: string, snakeCase: boolean): JsonObject => ({
  inlineData: snakeCase ? { mime_type: mimeType, data } : { mimeType, data },
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

const convertMessages = (
  out: Json,
  messages: Json[],
  nameMap: ReadonlyMap<string, string> | undefined,
  drops: UserTurnDrops,
): void => {
  const systemParts: Json[] = [];
  const contentItems: Json[] = [];
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

              if (file !== undefined)
                partItems.push(inlineDataPart(file.mimeType, file.data, false));
              else drops.drop("image_url");
              break;
            }

            case "video_url": {
              const file = normalizeOpenAIFileData("", "", asString(get(item, "video_url.url")));

              if (file !== undefined)
                partItems.push(inlineDataPart(file.mimeType, file.data, false));
              else drops.drop("video_url");
              break;
            }

            case "file": {
              const file = normalizeOpenAIFileData(
                asString(get(item, "file.filename")),
                "",
                asString(get(item, "file.file_data")),
              );

              if (file !== undefined)
                partItems.push(inlineDataPart(file.mimeType, file.data, false));
              else drops.drop("file");
              break;
            }

            case "input_audio": {
              const data = asString(get(item, "input_audio.data"));

              if (data !== "") {
                partItems.push(
                  inlineDataPart(
                    audioMimeType(asString(get(item, "input_audio.format"))),
                    data,
                    true,
                  ),
                );
              } else drops.drop("input_audio");
              break;
            }
          }
        }
      }

      // Whitespace-only text is forwarded but never keeps an emptied turn alive.
      drops.endTurn(countSendableGeminiParts(partItems));

      if (partItems.length > 0) contentItems.push(contentNode("user", partItems));
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
              const imageUrl = asString(get(item, "image_url.url"));

              if (imageUrl.length > 5) {
                const rest = imageUrl.slice(5);
                const semicolon = rest.indexOf(";");

                if (semicolon >= 0) {
                  const mime = rest.slice(0, semicolon);
                  const tail = rest.slice(semicolon + 1);

                  if (tail.length > 7) partItems.push(inlineDataPart(mime, tail.slice(7), false));
                }
              }

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

        if (partItems.length > 0) contentItems.push(contentNode("model", partItems));

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

        if (responseParts.length > 0) contentItems.push(contentNode("user", responseParts));
      } else if (partItems.length > 0) {
        contentItems.push(contentNode("model", partItems));
      }
    }
  }

  if (systemParts.length > 0)
    set(out, "request.systemInstruction", contentNode("user", systemParts));
  set(out, "request.contents", contentItems);
};

const convertTools = (
  out: Json,
  tools: Json[],
  nameMap: ReadonlyMap<string, string> | undefined,
): void => {
  const functionDeclarations: Json[] = [];
  const googleSearchNodes: Json[] = [];
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

    const googleSearch = get(t, "google_search");

    if (googleSearch !== undefined)
      googleSearchNodes.push({ googleSearch: structuredClone(googleSearch) });
    const codeExecution = get(t, "code_execution");

    if (codeExecution !== undefined)
      codeExecutionNodes.push({ codeExecution: structuredClone(codeExecution) });
    const urlContext = get(t, "url_context");

    if (urlContext !== undefined) urlContextNodes.push({ urlContext: structuredClone(urlContext) });
  }

  const deduplicated = deduplicateFunctionDeclarations(functionDeclarations);
  const hasFunction = deduplicated.length > 0;

  if (
    hasFunction ||
    googleSearchNodes.length > 0 ||
    codeExecutionNodes.length > 0 ||
    urlContextNodes.length > 0
  ) {
    const items: Json[] = [];

    if (hasFunction) items.push({ functionDeclarations: deduplicated });
    items.push(...googleSearchNodes, ...codeExecutionNodes, ...urlContextNodes);
    set(out, "request.tools", items);
  }
};

/** `ConvertOpenAIRequestToAntigravity`. */
export const convertOpenAIRequestToAntigravity = (
  modelName: string,
  raw: Json,
  _stream: boolean,
): Json => {
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
  const result = attachDefaultSafetySettings(compatible, "request.safetySettings");
  const refusal = drops.err(result);

  if (refusal !== undefined) throw refusal;

  return result;
};

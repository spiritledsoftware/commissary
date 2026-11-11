/**
 * OpenAI Chat Completions client -> Gemini provider: request conversion.
 *
 * Go source: internal/translator/gemini/openai/chat-completions/gemini_openai_request.go
 * (ConvertOpenAIRequestToGemini and helpers).
 *
 * Known differences: tool-result contents are embedded as the JSON text of the OpenAI `content` value (compact
 * `JSON.stringify`; Go keeps the client's raw formatting), and unparsable `function.arguments` become `{}` where Go
 * would write malformed JSON.
 */
import {
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
import { countSendableGeminiParts, UserTurnDrops } from "../../common/parts.ts";
import { normalizeOpenAIFileData } from "../../common/file-data.ts";
import { attachDefaultSafetySettings } from "../common/safety.ts";
import { geminiReplaySignatureOrBypass } from "../common/signature.ts";
import { renameKey } from "../gemini/gemini.ts";
import { systemReminderText } from "../../common/claude-messages.ts";
import { sanitizeFunctionName } from "../util/claude.ts";
import { cleanJsonSchemaForGeminiJsonSchema } from "../util/json-schema.ts";

const GEMINI_FUNCTION_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const textPart = (text: string): JsonObject => ({ text });

const inlineDataPart = (mimeType: string, data: string): JsonObject => ({
  inlineData: { mime_type: mimeType, data },
});

const contentNode = (role: string, parts: Json[]): JsonObject => ({ role, parts });

const toolCallThoughtSignature = (toolCall: Json): string => {
  for (const path of [
    "extra_content.google.thought_signature",
    "function.extra_content.google.thought_signature",
    "thoughtSignature",
    "thought_signature",
  ]) {
    const signature = get(toolCall, path);

    if (signature !== undefined) return geminiReplaySignatureOrBypass(asString(signature));
  }

  return GEMINI_FUNCTION_THOUGHT_SIGNATURE;
};

/** `openAIInputAudioMimeType`. */
const inputAudioMimeType = (format: string): string => {
  switch (format) {
    case "":
    case "wav":
      return "audio/wav";
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
    default:
      return `audio/${format}`;
  }
};

const demotedSystemText = (text: string, isDemoted: boolean): string =>
  !isDemoted || text.trim() === "" ? text : systemReminderText(text);

const isNumber = (value: Json | undefined): value is number => typeof value === "number";

/** `applyOpenAIResponseFormatToGemini`. */
const applyResponseFormat = (out: Json, request: Json): void => {
  const responseFormat = get(request, "response_format");

  if (responseFormat === undefined) return;

  switch (asString(get(responseFormat, "type")).trim().toLowerCase()) {
    case "json_object":
      set(out, "generationConfig.responseMimeType", "application/json");
      break;
    case "json_schema": {
      set(out, "generationConfig.responseMimeType", "application/json");
      del(out, "generationConfig.responseSchema");
      const schema = get(responseFormat, "json_schema.schema");

      if (schema !== undefined) set(out, "generationConfig.responseJsonSchema", schema);
      break;
    }

    default:
      break;
  }
};

export const convertOpenAIRequestToGemini = (
  modelName: string,
  request: Json,
  _stream: boolean,
): Json => {
  const drops = new UserTurnDrops();
  const out: JsonObject = { contents: [], model: modelName };

  const generationConfig = get(request, "generationConfig");

  if (generationConfig !== undefined) out["generationConfig"] = generationConfig;

  const reasoningEffort = get(request, "reasoning_effort");

  if (reasoningEffort !== undefined) {
    const effort = asString(reasoningEffort).trim().toLowerCase();

    if (effort !== "") {
      if (effort === "auto") set(out, "generationConfig.thinkingConfig.thinkingBudget", -1);
      else set(out, "generationConfig.thinkingConfig.thinkingLevel", effort);
    }
  }

  const temperature = get(request, "temperature");

  if (isNumber(temperature)) set(out, "generationConfig.temperature", temperature);
  const topP = get(request, "top_p");

  if (isNumber(topP)) set(out, "generationConfig.topP", topP);
  const topK = get(request, "top_k");

  if (isNumber(topK)) set(out, "generationConfig.topK", topK);

  const maxTokens = get(request, "max_tokens");
  const maxCompletionTokens = get(request, "max_completion_tokens");

  if (isNumber(maxTokens)) set(out, "generationConfig.maxOutputTokens", maxTokens);
  else if (isNumber(maxCompletionTokens))
    set(out, "generationConfig.maxOutputTokens", maxCompletionTokens);

  const n = get(request, "n");

  if (isNumber(n) && Math.trunc(n) > 1) set(out, "generationConfig.candidateCount", Math.trunc(n));

  applyResponseFormat(out, request);

  const modalities = get(request, "modalities");

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
        default:
          break;
      }
    }

    if (responseModalities.length > 0)
      set(out, "generationConfig.responseModalities", responseModalities);
  }

  const imageConfig = get(request, "image_config");

  if (isJsonObject(imageConfig)) {
    const aspectRatio = imageConfig["aspect_ratio"];

    if (typeof aspectRatio === "string")
      set(out, "generationConfig.imageConfig.aspectRatio", aspectRatio);
    const imageSize = imageConfig["image_size"];

    if (typeof imageSize === "string")
      set(out, "generationConfig.imageConfig.imageSize", imageSize);
  }

  // messages -> systemInstruction + contents
  const messages = get(request, "messages");

  if (isJsonArray(messages)) {
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
        if (typeof content === "string") {
          systemParts.push(textPart(content));
        } else if (isJsonObject(content) && asString(content["type"]) === "text") {
          systemParts.push(textPart(asString(content["text"])));
        } else if (isJsonArray(content)) {
          for (const item of content) systemParts.push(textPart(asString(get(item, "text"))));
        }
      } else if (role === "user" || role === "system" || role === "developer") {
        hasEncounteredConversation = true;
        const isDemoted = role === "system" || role === "developer";
        const partItems: Json[] = [];

        if (typeof content === "string") {
          partItems.push(textPart(demotedSystemText(content, isDemoted)));
        } else if (isJsonObject(content) && asString(content["type"]) === "text") {
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
                const audioData = asString(get(item, "input_audio.data"));

                if (audioData !== "") {
                  partItems.push(
                    inlineDataPart(
                      inputAudioMimeType(asString(get(item, "input_audio.format"))),
                      audioData,
                    ),
                  );
                } else {
                  drops.drop("input_audio");
                }

                break;
              }

              default:
                break;
            }
          }
        }

        drops.endTurn(countSendableGeminiParts(partItems));

        if (partItems.length > 0) contentItems.push(contentNode("user", partItems));
      } else if (role === "assistant") {
        hasEncounteredConversation = true;
        const partItems: Json[] = [];
        const reasoningContent = get(m, "reasoning_content");

        if (typeof reasoningContent === "string" && reasoningContent !== "") {
          partItems.push({ text: reasoningContent, thought: true });
        }

        if (typeof content === "string" && content !== "") {
          partItems.push(textPart(content));
        } else if (isJsonArray(content)) {
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
                    const payload = rest.slice(semicolon + 1);

                    if (payload.length > 7) partItems.push(inlineDataPart(mime, payload.slice(7)));
                  }
                }

                break;
              }

              default:
                break;
            }
          }
        }

        const toolCallsValue = get(m, "tool_calls");

        if (isJsonArray(toolCallsValue)) {
          const toolCalls: Array<{ id: string; name: string }> = [];

          for (const tc of toolCallsValue) {
            if (asString(get(tc, "type")) !== "function") continue;
            const functionName = sanitizeFunctionName(asString(get(tc, "function.name")));

            if (functionName === "") continue;
            const args = tryParseJson(asString(get(tc, "function.arguments")));
            partItems.push({
              functionCall: { name: functionName, args: args === undefined ? {} : args },
              thoughtSignature: toolCallThoughtSignature(tc),
            });
            toolCalls.push({ id: asString(get(tc, "id")), name: functionName });
          }

          if (partItems.length > 0) contentItems.push(contentNode("model", partItems));

          // Tool responses scoped to this assistant turn.
          const turnToolResponses = new Map<string, string>();

          for (let j = i + 1; j < messages.length; j++) {
            // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
            const next = messages[j] as Json;
            const nextRole = asString(get(next, "role"));

            if (nextRole === "assistant") break;

            if (nextRole === "tool") {
              const callId = asString(get(next, "tool_call_id"));

              if (callId !== "") {
                const c = get(next, "content");
                turnToolResponses.set(callId, c === undefined ? "" : JSON.stringify(c));
              }
            }
          }

          const responseParts: Json[] = [];

          for (const call of toolCalls) {
            let response = turnToolResponses.get(call.id) ?? "";

            if (response === "") response = "{}";
            responseParts.push({
              functionResponse: { name: call.name, response: { result: response } },
            });
          }

          if (responseParts.length > 0) contentItems.push(contentNode("user", responseParts));
        } else if (partItems.length > 0) {
          contentItems.push(contentNode("model", partItems));
        }
      }
    }

    if (systemParts.length > 0) out["systemInstruction"] = contentNode("user", systemParts);
    const last = contentItems[contentItems.length - 1];

    if (last !== undefined && asString(get(last, "role")) === "model") contentItems.pop();

    if (contentItems.length > 0) out["contents"] = contentItems;
  }

  // tools -> functionDeclarations + googleSearch/codeExecution/urlContext passthrough
  const allowedToolNames = new Set<string>();
  let isAllowedTools = false;
  let allowedMode = "auto";
  const toolChoiceValue = get(request, "tool_choice");

  if (isJsonObject(toolChoiceValue) && asString(toolChoiceValue["type"]) === "allowed_tools") {
    isAllowedTools = true;
    let toolList = get(toolChoiceValue, "allowed_tools.tools");

    if (!isJsonArray(toolList) || toolList.length === 0) toolList = get(toolChoiceValue, "tools");

    for (const t of isJsonArray(toolList) ? toolList : []) {
      let fnName = asString(get(t, "function.name")).trim();

      if (fnName === "") fnName = asString(get(t, "name")).trim();

      if (fnName !== "") allowedToolNames.add(fnName);
    }

    let modeVal = asString(get(toolChoiceValue, "allowed_tools.mode")).trim().toLowerCase();

    if (modeVal === "") modeVal = asString(get(toolChoiceValue, "mode")).trim().toLowerCase();

    if (modeVal !== "") allowedMode = modeVal;
  }

  const declaredOriginalToSanitized = new Map<string, string>();
  const sanitizedCounts = new Map<string, number>();
  const functionDeclarations: JsonObject[] = [];
  let hasStrictTool = false;
  const tools = get(request, "tools");

  if (isJsonArray(tools) && tools.length > 0) {
    const googleSearchNodes: Json[] = [];
    const codeExecutionNodes: Json[] = [];
    const urlContextNodes: Json[] = [];

    for (const t of tools) {
      if (asString(get(t, "type")) === "function") {
        const fn = get(t, "function");

        if (isJsonObject(fn)) {
          const originalName = asString(fn["name"]);

          if (isAllowedTools && !allowedToolNames.has(originalName)) continue;
          const sanitizedName = sanitizeFunctionName(originalName);
          sanitizedCounts.set(sanitizedName, (sanitizedCounts.get(sanitizedName) ?? 0) + 1);
          declaredOriginalToSanitized.set(originalName, sanitizedName);
          const fnCopy: JsonObject = structuredClone(fn);

          if (exists(fnCopy, "parameters")) renameKey(fnCopy, "parameters", "parametersJsonSchema");
          else fnCopy["parametersJsonSchema"] = { type: "object", properties: {} };

          if (typeof fn["name"] !== "string" || sanitizedName !== originalName)
            fnCopy["name"] = sanitizedName;
          const parameters = fnCopy["parametersJsonSchema"];

          if (parameters !== undefined)
            fnCopy["parametersJsonSchema"] = cleanJsonSchemaForGeminiJsonSchema(parameters);
          let strict = fnCopy["strict"];

          if (strict === undefined) strict = fn["strict"];

          if (strict === undefined) strict = get(t, "strict");

          if (strict !== undefined) {
            if (strict === true) hasStrictTool = true;

            if (exists(fnCopy, "strict")) delete fnCopy["strict"];
          }

          functionDeclarations.push(fnCopy);
        }
      }

      const googleSearch = get(t, "google_search");

      if (googleSearch !== undefined) googleSearchNodes.push({ googleSearch });
      const codeExecution = get(t, "code_execution");

      if (codeExecution !== undefined) codeExecutionNodes.push({ codeExecution });
      const urlContext = get(t, "url_context");

      if (urlContext !== undefined) urlContextNodes.push({ urlContext });
    }

    if (
      functionDeclarations.length > 0 ||
      googleSearchNodes.length > 0 ||
      codeExecutionNodes.length > 0 ||
      urlContextNodes.length > 0
    ) {
      const toolItems: Json[] = [];

      if (functionDeclarations.length > 0) toolItems.push({ functionDeclarations });
      toolItems.push(...googleSearchNodes, ...codeExecutionNodes, ...urlContextNodes);
      out["tools"] = toolItems;

      // Gemini rejects built-in tools combined with functionDeclarations unless server-side tool invocations are
      // declared (CLIProxyAPI 45501610).
      if (
        functionDeclarations.length > 0 &&
        (googleSearchNodes.length > 0 ||
          codeExecutionNodes.length > 0 ||
          urlContextNodes.length > 0)
      )
        set(out, "toolConfig.includeServerSideToolInvocations", true);
    }
  }

  const hasSanitizedCollision = [...sanitizedCounts.values()].some((count) => count > 1);

  // tool_choice mapping
  if (hasSanitizedCollision) {
    set(out, "toolConfig.functionCallingConfig.mode", "NONE");
  } else if (isAllowedTools) {
    if (functionDeclarations.length === 0) {
      set(out, "toolConfig.functionCallingConfig.mode", "NONE");
    } else if (allowedMode === "required" || allowedMode === "any") {
      set(out, "toolConfig.functionCallingConfig.mode", "ANY");
      set(
        out,
        "toolConfig.functionCallingConfig.allowedFunctionNames",
        functionDeclarations.map((fn) => asString(fn["name"])),
      );
    } else if (hasStrictTool) {
      set(out, "toolConfig.functionCallingConfig.mode", "VALIDATED");
    } else {
      set(out, "toolConfig.functionCallingConfig.mode", "AUTO");
    }
  } else if (toolChoiceValue !== undefined && toolChoiceValue !== null) {
    let toolChoiceType = "";

    if (typeof toolChoiceValue === "string") toolChoiceType = toolChoiceValue.trim().toLowerCase();
    else if (isJsonObject(toolChoiceValue))
      toolChoiceType = asString(toolChoiceValue["type"]).trim().toLowerCase();

    switch (toolChoiceType) {
      case "auto":
        set(out, "toolConfig.functionCallingConfig.mode", hasStrictTool ? "VALIDATED" : "AUTO");
        break;
      case "none":
        set(out, "toolConfig.functionCallingConfig.mode", "NONE");
        break;
      case "required":
      case "any":
        set(out, "toolConfig.functionCallingConfig.mode", "ANY");
        break;
      case "function":
      case "tool": {
        let fnName = asString(get(toolChoiceValue, "function.name")).trim();

        if (fnName === "") fnName = asString(get(toolChoiceValue, "name")).trim();
        const sanitized = declaredOriginalToSanitized.get(fnName);

        if (sanitized !== undefined && sanitizedCounts.get(sanitized) === 1) {
          set(out, "toolConfig.functionCallingConfig.mode", "ANY");
          set(out, "toolConfig.functionCallingConfig.allowedFunctionNames", [sanitized]);
        } else {
          set(out, "toolConfig.functionCallingConfig.mode", "NONE");
        }

        break;
      }

      default:
        set(out, "toolConfig.functionCallingConfig.mode", "NONE");
    }
  } else if (hasStrictTool && functionDeclarations.length > 0) {
    set(out, "toolConfig.functionCallingConfig.mode", "VALIDATED");
  }

  // Gemini cannot disable parallel calls while keeping tools enabled: fail closed.
  if (get(request, "parallel_tool_calls") === false) {
    set(out, "toolConfig.functionCallingConfig.mode", "NONE");
    del(out, "toolConfig.functionCallingConfig.allowedFunctionNames");
  }

  const result = attachDefaultSafetySettings(out, "safetySettings");
  const error = drops.err(result);

  if (error !== undefined) throw error;

  return result;
};

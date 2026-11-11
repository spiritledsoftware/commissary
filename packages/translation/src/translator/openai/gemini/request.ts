/**
 * Gemini client -> OpenAI Chat Completions provider (request).
 *
 * Go source: internal/translator/openai/gemini/openai_gemini_request.go.
 */
import { createHash } from "node:crypto";
import {
  asBool,
  asFloat,
  asInt,
  cloneJson,
  get,
  type Json,
  type JsonObject,
} from "@commissary/json";
import { convertBudgetToLevel } from "../../../thinking/convert.ts";
import {
  geminiPartFunctionCall,
  geminiPartFunctionResponse,
  normalizeGeminiTurnRole,
} from "../../common/gemini-parts.ts";
import { normalizeJsonSchemaNumericConstraints } from "../../common/schema.ts";
import { getStr, isArr, isObj, raw, str } from "../common/read.ts";

/** `IsGeminiThoughtPart` (common/gemini.go). */
export const isGeminiThoughtPart = (part: Json | undefined): boolean =>
  asBool(get(part, "thought"));

const deterministicToolCallId = (
  kind: string,
  msgIdx: number,
  partIdx: number,
  name: string,
  payload: string,
): string =>
  `call_${createHash("sha256").update(`${kind}|${msgIdx}|${partIdx}|${name}|${payload}`).digest("hex").slice(0, 24)}`;

const explicitGeminiToolId = (node: Json | undefined): string => {
  const id = getStr(node, "id").trim();

  if (id !== "") return id;
  const callId = getStr(node, "call_id").trim();

  if (callId !== "") return callId;

  return getStr(node, "callId").trim();
};

const openAIInputAudioFormatFromMime = (mimeType: string): string => {
  switch (mimeType.trim().toLowerCase()) {
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/flac":
      return "flac";
    case "audio/opus":
    case "audio/ogg":
      return "opus";
    case "audio/pcm":
    case "audio/l16":
      return "pcm16";
    default:
      return "mp3";
  }
};

const openAIFileNameFromMime = (mimeType: string): string => {
  const mime = mimeType.trim().toLowerCase();

  switch (mime) {
    case "application/pdf":
      return "document.pdf";
    case "text/plain":
      return "document.txt";
    case "text/csv":
      return "document.csv";
    case "application/json":
      return "document.json";
    case "application/xml":
    case "text/xml":
      return "document.xml";
    default:
      return mime.startsWith("video/") ? "video" : "document";
  }
};

const firstNonEmpty = (node: Json | undefined, ...paths: string[]): string => {
  for (const path of paths) {
    const value = getStr(node, path);

    if (value !== "") return value;
  }

  return "";
};

const openAIContentPartFromGeminiInlineData = (part: Json): JsonObject | undefined => {
  const inlineData = get(part, "inlineData") ?? get(part, "inline_data");

  if (inlineData === undefined) return undefined;
  let mimeType = firstNonEmpty(inlineData, "mimeType", "mime_type");

  if (mimeType === "") mimeType = "application/octet-stream";
  const data = getStr(inlineData, "data");

  if (data === "") return undefined;
  const dataUrl = `data:${mimeType};base64,${data}`;
  const lower = mimeType.toLowerCase();

  if (lower.startsWith("image/")) return { type: "image_url", image_url: { url: dataUrl } };

  if (lower.startsWith("audio/")) {
    return {
      type: "input_audio",
      input_audio: { data, format: openAIInputAudioFormatFromMime(mimeType) },
    };
  }

  if (lower.startsWith("video/")) return { type: "video_url", video_url: { url: dataUrl } };

  return { type: "file", file: { filename: openAIFileNameFromMime(mimeType), file_data: data } };
};

const openAIContentPartFromGeminiFileData = (part: Json): JsonObject | undefined => {
  const fileData = get(part, "fileData") ?? get(part, "file_data");

  if (fileData === undefined) return undefined;
  const fileUri = firstNonEmpty(fileData, "fileUri", "file_uri");

  if (fileUri === "") return undefined;
  const mimeType = firstNonEmpty(fileData, "mimeType", "mime_type");
  const lower = mimeType.toLowerCase();

  if (lower.startsWith("image/")) return { type: "image_url", image_url: { url: fileUri } };

  if (lower.startsWith("video/")) return { type: "video_url", video_url: { url: fileUri } };

  if (lower.startsWith("application/") || lower.startsWith("text/")) {
    return {
      type: "file",
      file: { filename: openAIFileNameFromMime(mimeType), file_url: fileUri },
    };
  }

  let fileInfo = `File: ${fileUri}`;

  if (mimeType !== "") fileInfo += ` (Type: ${mimeType})`;

  return { type: "text", text: fileInfo };
};

/** `ConvertGeminiRequestToOpenAI`. */
export const convertGeminiRequestToOpenAI = (
  modelName: string,
  root: Json,
  stream: boolean,
): Json => {
  const out: JsonObject = { model: modelName, messages: [] };

  const genConfig = get(root, "generationConfig");

  if (genConfig !== undefined) {
    const temp = get(genConfig, "temperature");

    if (temp !== undefined) out.temperature = asFloat(temp);
    const maxTokens = get(genConfig, "maxOutputTokens");

    if (maxTokens !== undefined) out.max_tokens = asInt(maxTokens);
    const topP = get(genConfig, "topP");

    if (topP !== undefined) out.top_p = asFloat(topP);
    const topK = get(genConfig, "topK");

    if (topK !== undefined) out.top_k = asInt(topK);

    const stopSequences = get(genConfig, "stopSequences");

    if (isArr(stopSequences)) {
      const stops = stopSequences.map((value) => str(value));

      if (stops.length > 0) out.stop = stops;
    }

    const candidateCount = get(genConfig, "candidateCount");

    if (candidateCount !== undefined) out.n = asInt(candidateCount);

    const responseModalities = get(genConfig, "responseModalities");

    if (isArr(responseModalities)) {
      const modalities: string[] = [];

      for (const value of responseModalities) {
        const modality = str(value).trim().toLowerCase();

        if (modality === "text" || modality === "image" || modality === "audio")
          modalities.push(modality);
      }

      if (modalities.length > 0) out.modalities = modalities;
    }

    // Always convert so models that are not in the registry (allowCompat) still get a reasoning effort.
    // The Google Python SDK sends snake_case fields (thinking_level/thinking_budget).
    const thinkingConfig = get(genConfig, "thinkingConfig");

    if (isObj(thinkingConfig)) {
      const thinkingLevel =
        get(thinkingConfig, "thinkingLevel") ?? get(thinkingConfig, "thinking_level");

      if (thinkingLevel !== undefined) {
        const effort = str(thinkingLevel).trim().toLowerCase();

        if (effort !== "") out.reasoning_effort = effort;
      } else {
        const thinkingBudget =
          get(thinkingConfig, "thinkingBudget") ?? get(thinkingConfig, "thinking_budget");

        if (thinkingBudget !== undefined) {
          const effort = convertBudgetToLevel(asInt(thinkingBudget));

          if (effort !== undefined) out.reasoning_effort = effort;
        }
      }
    }
  }

  out.stream = stream;
  const serviceTier = get(root, "service_tier");

  if (typeof serviceTier === "string") out.service_tier = serviceTier;

  const messageItems: Json[] = [];
  const toolCallIdsByName = new Map<string, string[]>();

  // Gemini may provide `systemInstruction` or `system_instruction`.
  const systemInstruction = get(root, "systemInstruction") ?? get(root, "system_instruction");

  if (systemInstruction !== undefined) {
    const parts = get(systemInstruction, "parts");
    const contentItems: Json[] = [];

    if (isArr(parts)) {
      for (const part of parts) {
        if (isGeminiThoughtPart(part)) continue;
        const text = get(part, "text");

        if (text !== undefined) contentItems.push({ type: "text", text: str(text) });
        const inline = openAIContentPartFromGeminiInlineData(part);

        if (inline !== undefined) contentItems.push(inline);
        const file = openAIContentPartFromGeminiFileData(part);

        if (file !== undefined) contentItems.push(file);
      }
    }

    if (contentItems.length > 0) messageItems.push({ role: "system", content: contentItems });
  }

  const contents = get(root, "contents");

  if (isArr(contents)) {
    let msgIdx = 0;
    let previousRole = "";

    for (const content of contents) {
      const parts = get(content, "parts");
      const role = normalizeGeminiTurnRole(getStr(content, "role"), parts, previousRole);
      previousRole = role;

      const msg: JsonObject = { role, content: "" };
      let text = "";
      const contentItems: Json[] = [];
      let onlyTextContent = true;
      const toolCallItems: Json[] = [];
      let droppedThought = false;
      let hasFunctionResponse = false;

      if (isArr(parts)) {
        let partIdx = 0;

        for (const part of parts) {
          const currentPartIdx = partIdx;
          partIdx++;

          if (isGeminiThoughtPart(part)) {
            droppedThought = true;
            continue;
          }

          const textValue = get(part, "text");

          if (textValue !== undefined) {
            const formatted = str(textValue);
            text += formatted;
            contentItems.push({ type: "text", text: formatted });
          }

          const inline = openAIContentPartFromGeminiInlineData(part);

          if (inline !== undefined) {
            onlyTextContent = false;
            contentItems.push(inline);
          }

          const file = openAIContentPartFromGeminiFileData(part);

          if (file !== undefined) {
            onlyTextContent = false;
            contentItems.push(file);
          }

          const functionCall = geminiPartFunctionCall(part);

          if (functionCall !== undefined) {
            const funcName = getStr(functionCall, "name");
            const args = get(functionCall, "args");
            const argsRaw = args !== undefined ? raw(args) : "";
            let toolCallId = explicitGeminiToolId(functionCall);

            if (toolCallId === "")
              toolCallId = deterministicToolCallId(
                "call",
                msgIdx,
                currentPartIdx,
                funcName,
                argsRaw,
              );
            const queue = toolCallIdsByName.get(funcName) ?? [];
            queue.push(toolCallId);
            toolCallIdsByName.set(funcName, queue);
            toolCallItems.push({
              id: toolCallId,
              type: "function",
              function: { name: funcName, arguments: argsRaw !== "" ? argsRaw : "{}" },
            });
          }

          const functionResponse = geminiPartFunctionResponse(part);

          if (functionResponse !== undefined) {
            const funcName = getStr(functionResponse, "name");
            const toolMsg: JsonObject = { role: "tool", tool_call_id: "", content: "" };
            let responseRaw = "";
            const response = get(functionResponse, "response");

            if (response !== undefined) {
              const contentField = get(response, "content");
              responseRaw = contentField !== undefined ? raw(contentField) : raw(response);
              toolMsg.content = responseRaw;
            }

            const explicitId = explicitGeminiToolId(functionResponse);
            const queue = toolCallIdsByName.get(funcName);

            if (explicitId !== "") {
              toolMsg.tool_call_id = explicitId;

              if (queue !== undefined && queue.length > 0) {
                const i = queue.indexOf(explicitId);

                if (i >= 0) queue.splice(i, 1);
              }
            } else if (queue !== undefined && queue.length > 0) {
              // SAFETY: the branch condition checked queue.length > 0, so shift() returns an id.
              toolMsg.tool_call_id = queue.shift() as string;
            } else {
              toolMsg.tool_call_id = deterministicToolCallId(
                "response",
                msgIdx,
                currentPartIdx,
                funcName,
                responseRaw,
              );
            }

            messageItems.push(toolMsg);
            hasFunctionResponse = true;
          }
        }
      }

      if (contentItems.length > 0) msg.content = onlyTextContent ? text : contentItems;

      if (toolCallItems.length > 0) msg.tool_calls = toolCallItems;

      if (
        (droppedThought || hasFunctionResponse) &&
        contentItems.length === 0 &&
        toolCallItems.length === 0
      ) {
        msgIdx++;
        continue;
      }

      messageItems.push(msg);
      msgIdx++;
    }
  }

  if (messageItems.length > 0) out.messages = messageItems;

  const tools = get(root, "tools");

  if (isArr(tools)) {
    const toolItems: Json[] = [];

    for (const tool of tools) {
      const functionDeclarations = get(tool, "functionDeclarations");

      if (!isArr(functionDeclarations)) continue;

      for (const funcDecl of functionDeclarations) {
        const fn: JsonObject = {
          name: getStr(funcDecl, "name"),
          description: getStr(funcDecl, "description"),
        };

        const parameters = get(funcDecl, "parameters") ?? get(funcDecl, "parametersJsonSchema");

        if (parameters !== undefined)
          fn.parameters = cloneJson(normalizeJsonSchemaNumericConstraints(parameters));
        toolItems.push({ type: "function", function: fn });
      }
    }

    if (toolItems.length > 0) out.tools = toolItems;
  }

  const toolConfig = get(root, "toolConfig");

  if (toolConfig !== undefined) {
    const functionCallingConfig = get(toolConfig, "functionCallingConfig");

    if (functionCallingConfig !== undefined) {
      const mode = getStr(functionCallingConfig, "mode");
      const allowedNames = get(functionCallingConfig, "allowedFunctionNames");

      switch (mode) {
        case "NONE":
          out.tool_choice = "none";
          break;
        case "AUTO":
          out.tool_choice = "auto";
          break;
        case "ANY":
          if (isArr(allowedNames) && allowedNames.length === 1) {
            out.tool_choice = { type: "function", function: { name: str(allowedNames[0]) } };
          } else {
            out.tool_choice = "required";
          }

          break;
      }
    }
  }

  return out;
};

/**
 * OpenAI Responses client -> OpenAI Chat Completions provider (request).
 *
 * Go source: internal/translator/openai/openai/responses/openai_openai-responses_request.go.
 */
import { asBool, cloneJson, get, type Json, type JsonObject } from "@commissary/json";
import { alignOpenAIToolCallMessages } from "../../common/openai-tools.ts";
import { getStr, isArr, isObj, raw, str } from "../../common/read.ts";
import {
  extractResponsesCallID,
  normalizeResponsesToolCallOutputs,
} from "../../../common/responses.ts";
import { UnsupportedPartError, UserTurnDrops } from "../../../common/parts.ts";
import { ResponsesToolIndex, responsesToolOutputText } from "./tools.ts";

const REASONING_UNAVAILABLE = "[reasoning unavailable]";

export const isUsableResponsesReasoning = (reasoning: string): boolean => {
  const t = reasoning.trim();

  return t !== "" && t !== REASONING_UNAVAILABLE;
};

export const combineOpenAIResponsesReasoning = (existing: string, incoming: string): string => {
  const existingTrimmed = existing.trim();
  const incomingTrimmed = incoming.trim();

  if (existingTrimmed === "") return incoming;

  if (incomingTrimmed === "") return existing;

  if (existingTrimmed === REASONING_UNAVAILABLE) return incoming;

  if (incomingTrimmed === REASONING_UNAVAILABLE || existingTrimmed === incomingTrimmed)
    return existing;

  return `${existing}\n\n${incoming}`;
};

/** `collectOpenAIResponsesReasoningContent`. */
const collectOpenAIResponsesReasoningContent = (item: Json): string => {
  let text = "";
  const summary = get(item, "summary");

  if (isArr(summary)) {
    for (const summaryItem of summary) {
      if (getStr(summaryItem, "type") !== "summary_text") continue;
      text += getStr(summaryItem, "text");
    }
  }

  return text.length === 0 ? REASONING_UNAVAILABLE : text;
};

/** `normalizeChatImageDetail`: `ok` is false when the value is not a string. */
interface ChatImageDetail {
  detail: string;
  ok: boolean;
}

const normalizeChatImageDetail = (detail: Json | undefined): ChatImageDetail => {
  if (detail === undefined) return { detail: "", ok: true };

  if (typeof detail !== "string") return { detail: "", ok: false };
  const normalized = detail.trim().toLowerCase();

  switch (normalized) {
    case "auto":
    case "low":
    case "high":
      return { detail: normalized, ok: true };
    case "original":
      // Chat Completions does not support Codex's original detail value.
      return { detail: "high", ok: true };
    default:
      return { detail: "", ok: true };
  }
};

/** `responsesInputFileToChatPart`: needs a file id or inline bytes (Chat Completions has no bare url field). */
const responsesInputFileToChatPart = (contentItem: Json): JsonObject | undefined => {
  const fileId = getStr(contentItem, "file_id");
  const fileData = getStr(contentItem, "file_data");

  if (fileId === "" && fileData === "") return undefined;
  const file: JsonObject = {};

  if (fileId !== "") file.file_id = fileId;

  if (fileData !== "") file.file_data = fileData;
  const filename = getStr(contentItem, "filename");

  if (filename !== "") file.filename = filename;

  return { type: "file", file };
};

/** `responsesInputAudioToChatPart`. */
const responsesInputAudioToChatPart = (contentItem: Json): JsonObject | undefined => {
  const audio = get(contentItem, "input_audio");
  let data = getStr(audio, "data");

  if (data === "") data = getStr(contentItem, "data");

  if (data === "") return undefined;
  let format = getStr(audio, "format");

  if (format === "") format = getStr(contentItem, "format");
  const inputAudio: JsonObject = { data };

  if (format !== "") inputAudio.format = format;

  return { type: "input_audio", input_audio: inputAudio };
};

const chatToolOutputImageFields = (
  item: Json,
): { imageUrl: string; detail: string } | undefined => {
  let imageUrlValue: Json | undefined;
  let detailValue: Json | undefined;

  switch (getStr(item, "type")) {
    case "image_url":
      imageUrlValue = get(item, "image_url.url");
      detailValue = get(item, "image_url.detail");
      break;
    case "input_image":
      imageUrlValue = get(item, "image_url");
      detailValue = get(item, "detail");
      break;
    default:
      return undefined;
  }

  if (typeof imageUrlValue !== "string") return undefined;
  const imageUrl = imageUrlValue.trim();

  if (imageUrl === "") return undefined;
  const detail = normalizeChatImageDetail(detailValue);

  if (!detail.ok) return undefined;

  return { imageUrl, detail: detail.detail };
};

const chatToolOutputFallbackPart = (item: Json): JsonObject => {
  let text = raw(item);

  if (typeof item === "string" || text === "") text = str(item);

  return { type: "text", text };
};

/**
 * `chatToolMediaMode`: where a tool output's files and images go. A tool message with an awaiting call relays them
 * in a following user message (`relayToolFiles`); a standalone output, already a user message, keeps them inline
 * (`standaloneToolOutput`). Go's third mode, `inlineToolAttachments`, belongs to its Copilot provider (7ae771fc),
 * which Commissary does not have.
 */
type ChatToolMediaMode = "relayToolFiles" | "standaloneToolOutput";

/** `chatToolOutputContentPart`. */
const chatToolOutputContentPart = (item: Json): JsonObject => {
  switch (getStr(item, "type")) {
    case "text":
    case "input_text":
    case "output_text":
      return { type: "text", text: getStr(item, "text") };
    case "image_url":
    case "input_image": {
      const fields = chatToolOutputImageFields(item);

      if (fields === undefined) return chatToolOutputFallbackPart(item);
      const imageUrl: JsonObject = { url: fields.imageUrl };

      if (fields.detail !== "") imageUrl.detail = fields.detail;

      return { type: "image_url", image_url: imageUrl };
    }

    case "input_file":
    case "file":
      return chatToolOutputFilePart(item) ?? chatToolOutputFallbackPart(item);
    default:
      return chatToolOutputFallbackPart(item);
  }
};

/** `chatToolOutputFilePart`: a `file` part may nest its fields under `file`. */
const chatToolOutputFilePart = (item: Json): JsonObject | undefined => {
  const nested = get(item, "file");

  if (getStr(item, "type") === "file" && isObj(nested)) return responsesInputFileToChatPart(nested);

  return responsesInputFileToChatPart(item);
};

/** `isChatToolOutputPartObject`: a single content part given as the whole output. */
const isChatToolOutputPartObject = (content: Json | undefined): boolean => {
  if (!isObj(content)) return false;

  switch (getStr(content, "type").trim().toLowerCase()) {
    case "input_text":
    case "output_text":
    case "image_url":
    case "input_image":
    case "input_file":
    case "file":
    case "input_audio":
    case "audio":
    case "input_video":
    case "video":
      return true;
    case "text":
      return typeof get(content, "text") === "string";
    default:
      return false;
  }
};

/** What `inspectChatToolOutputParts` finds in a tool output's content parts. */
interface ChatToolOutputParts {
  items: Json[];
  hasImage: boolean;
  hasFile: boolean;
  invalidTextOrImage: boolean;
  /** The first image part without a usable URL, or "". */
  badImageType: string;
  /** The first file part Chat Completions cannot take, or the first audio/video part, or "". */
  unsupportedType: string;
}

/** `inspectChatToolOutputParts` (replaces `hasChatToolOutputImagePart`, f08cb931). */
const inspectChatToolOutputParts = (content: Json | undefined): ChatToolOutputParts => {
  const parts: ChatToolOutputParts = {
    items: [],
    hasImage: false,
    hasFile: false,
    invalidTextOrImage: false,
    badImageType: "",
    unsupportedType: "",
  };

  if (isArr(content)) parts.items = content;
  else if (content !== undefined && isChatToolOutputPartObject(content)) parts.items = [content];
  else return parts;

  for (const item of parts.items) {
    const typeName = get(item, "type");

    if (typeof typeName !== "string") continue;

    switch (typeName) {
      case "text":
      case "input_text":
      case "output_text":
        if (typeof get(item, "text") !== "string") parts.invalidTextOrImage = true;
        break;
      case "image_url":
      case "input_image":
        if (chatToolOutputImageFields(item) === undefined) {
          parts.invalidTextOrImage = true;

          if (parts.badImageType === "") parts.badImageType = typeName;
        } else {
          parts.hasImage = true;
        }

        break;
      case "input_file":
      case "file":
        if (chatToolOutputFilePart(item) !== undefined) parts.hasFile = true;
        else if (parts.unsupportedType === "") parts.unsupportedType = typeName;
        break;
      case "input_audio":
      case "audio":
      case "input_video":
      case "video":
        if (parts.unsupportedType === "") parts.unsupportedType = typeName;
        break;
    }
  }

  return parts;
};

const tryParse = (text: string): Json | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * `setFunctionCallOutputContentDoc` (mutates `toolMessage`): returns the file and image parts to relay in a
 * following user message, or the unsupported part's type. Files, single-object media and audio/video in tool
 * outputs are handled since f08cb931 (before, they went upstream as raw JSON text).
 */
const setFunctionCallOutputContent = (
  toolMessage: JsonObject,
  output: Json,
  mode: ChatToolMediaMode,
): ChatToolOutputResult => {
  let structured: Json | undefined = output;

  if (typeof output === "string") {
    structured = tryParse(output);

    if (structured === undefined) {
      toolMessage.content = output;

      return {};
    }
  }

  const { items, hasImage, hasFile, invalidTextOrImage, badImageType, unsupportedType } =
    inspectChatToolOutputParts(structured);

  if (unsupportedType !== "") return { unsupportedType };

  if (hasFile || (isObj(structured) && hasImage)) {
    if (badImageType !== "") return { unsupportedType: badImageType };
    const toolItems: JsonObject[] = [];
    const userMediaItems: JsonObject[] = [];
    const textParts: string[] = [];

    for (const item of items) {
      switch (getStr(item, "type")) {
        case "input_file":
        case "file": {
          const filePart = chatToolOutputFilePart(item);

          if (filePart !== undefined)
            (mode === "relayToolFiles" ? userMediaItems : toolItems).push(filePart);
          break;
        }

        case "image_url":
        case "input_image":
          if (chatToolOutputImageFields(item) !== undefined)
            (mode === "relayToolFiles" ? userMediaItems : toolItems).push(
              chatToolOutputContentPart(item),
            );
          break;
        case "text":
        case "input_text":
        case "output_text": {
          const text = get(item, "text");

          if (typeof text === "string") {
            textParts.push(text);
            toolItems.push(chatToolOutputContentPart(item));
          } else {
            const fallback = chatToolOutputFallbackPart(item);
            textParts.push(str(fallback.text));
            toolItems.push(fallback);
          }

          break;
        }

        default: {
          const fallback = chatToolOutputFallbackPart(item);
          textParts.push(str(fallback.text));
          toolItems.push(fallback);
        }
      }
    }

    if (mode === "relayToolFiles") {
      toolMessage.content =
        textParts.length === 0
          ? "Attached media from tool output follows in the user message."
          : textParts.join("\n");

      return { fileParts: userMediaItems };
    }

    if (toolItems.length > 0) toolMessage.content = toolItems;

    return {};
  }

  if (isObj(structured) && badImageType !== "") return { unsupportedType: badImageType };

  if (hasImage && !invalidTextOrImage) {
    const contentItems = items.map(chatToolOutputContentPart);

    if (contentItems.length > 0) toolMessage.content = contentItems;

    return {};
  }

  toolMessage.content = str(output);

  return {};
};

/** `setCustomToolCallOutputContentDoc` (mutates `toolMessage`). */
const setCustomToolCallOutputContent = (
  toolMessage: JsonObject,
  output: Json,
  mode: ChatToolMediaMode,
): ChatToolOutputResult => {
  let structured: Json | undefined = output;

  if (typeof output === "string") {
    const parsed = tryParse(output);

    if (parsed !== undefined) structured = parsed;
  }

  const { hasImage, hasFile, invalidTextOrImage, badImageType, unsupportedType } =
    inspectChatToolOutputParts(structured);

  if (unsupportedType !== "") return { unsupportedType };

  if (
    hasFile ||
    (isObj(structured) && (hasImage || badImageType !== "")) ||
    (hasImage && !invalidTextOrImage)
  )
    return setFunctionCallOutputContent(toolMessage, output, mode);
  toolMessage.content = responsesToolOutputText(output);

  return {};
};

/**
 * What a tool output's content setter reports: the parts to relay in a following user message, or the type of a
 * part Chat Completions cannot take (Go's `([][]byte, error)`; the error is built once the body is known).
 */
interface ChatToolOutputResult {
  fileParts?: JsonObject[];
  unsupportedType?: string;
}

type ChatToolOutputContentSetter = (
  message: JsonObject,
  output: Json,
  mode: ChatToolMediaMode,
) => ChatToolOutputResult;

/** `convertResponsesTextFormatToChatResponseFormat`. */
const convertResponsesTextFormatToChatResponseFormat = (
  textFormat: Json,
): JsonObject | undefined => {
  const formatType = getStr(textFormat, "type");

  switch (formatType) {
    case "text":
    case "json_object":
      return { type: formatType };
    case "json_schema": {
      const jsonSchema: JsonObject = {};

      for (const field of ["name", "description", "strict"]) {
        const value = get(textFormat, field);

        if (value !== undefined) jsonSchema[field] = cloneJson(value);
      }

      const schema = get(textFormat, "schema");

      if (schema !== undefined) jsonSchema.schema = cloneJson(schema);

      return { type: "json_schema", json_schema: jsonSchema };
    }

    default:
      return undefined;
  }
};

/** `convertResponsesToolChoiceWithIndex`. */
export const convertResponsesToolChoice = (
  toolChoice: Json,
  toolIndex: ResponsesToolIndex,
): Json => {
  if (!isObj(toolChoice)) return cloneJson(toolChoice);
  const choiceType = getStr(toolChoice, "type");

  if (choiceType === "shell") {
    const name = toolIndex.shellName();

    if (name !== "") return { type: "function", function: { name } };
  }

  if (choiceType === "tool_search") {
    const name = toolIndex.toolSearchName();

    if (name !== "") return { type: "function", function: { name } };
  }

  if (choiceType !== "function" && choiceType !== "custom") return cloneJson(toolChoice);

  let name = getStr(toolChoice, "function.name");

  if (name === "") name = getStr(toolChoice, "custom.name");

  if (name === "") name = getStr(toolChoice, "name");

  if (name === "") return cloneJson(toolChoice);

  let namespace = getStr(toolChoice, "namespace").trim();

  if (namespace === "") namespace = getStr(toolChoice, "function.namespace").trim();

  if (namespace === "") namespace = getStr(toolChoice, "custom.namespace").trim();
  name =
    namespace !== "" ? toolIndex.namespaceName(namespace, name) : toolIndex.canonicalName(name);

  return { type: "function", function: { name } };
};

/**
 * `appendStandaloneResponsesToolOutputAsUser`: orphan tool outputs become user text instead of tool messages.
 */
const appendStandaloneResponsesToolOutputAsUser = (
  output: Json | undefined,
  setContent: ChatToolOutputContentSetter,
  appendMessage: (message: JsonObject) => void,
): string | undefined => {
  const userMessage: JsonObject = { role: "user", content: "" };

  if (output !== undefined) {
    const { unsupportedType } = setContent(userMessage, output, "standaloneToolOutput");

    if (unsupportedType !== undefined) return unsupportedType;
  }

  const content = userMessage.content;

  if (content === undefined) return undefined;

  if (typeof content === "string" && content.trim() === "") return undefined;

  if (isArr(content) && content.length === 0) return undefined;
  appendMessage(userMessage);

  return undefined;
};

/** `convertOpenAIResponsesRequestToOpenAIChatCompletions`. */
export const convertOpenAIResponsesRequestToOpenAIChatCompletions = (
  modelName: string,
  root: Json,
  stream: boolean,
): Json => {
  const drops = new UserTurnDrops();
  // The first unsupported part in a tool output (f08cb931); reported after the user-turn drops.
  let toolOutputErrType: string | undefined;
  const out: JsonObject = { model: modelName, messages: [], stream };
  const toolIndex = new ResponsesToolIndex(root);
  const messages: JsonObject[] = [];

  const appendMessage = (message: JsonObject): void => {
    messages.push(message);
  };

  const textFormat = get(root, "text.format");

  if (textFormat !== undefined) {
    const responseFormat = convertResponsesTextFormatToChatResponseFormat(textFormat);

    if (responseFormat !== undefined) out.response_format = responseFormat;
  }

  const maxTokens = get(root, "max_output_tokens");

  if (maxTokens !== undefined) out.max_tokens = cloneJson(maxTokens);

  const instructions = get(root, "instructions");

  if (instructions !== undefined) appendMessage({ role: "system", content: str(instructions) });

  const duplicateOutputIds = new Set<string>();

  const input = get(root, "input");

  if (isArr(input)) {
    const rawInputArray = toolIndex.toolSearchHistory(toolIndex.shellHistory(input));
    const explicitOutputCounts = new Map<string, number>();
    let missingIdOutputsCount = 0;

    for (const item of rawInputArray) {
      const itemType = getStr(item, "type");

      if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
        const id = extractResponsesCallID(item);

        if (id !== "") explicitOutputCounts.set(id, (explicitOutputCounts.get(id) ?? 0) + 1);
        else missingIdOutputsCount++;
      }
    }

    const unclaimedCalls = new Set<string>();

    for (const item of rawInputArray) {
      const itemType = getStr(item, "type");

      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const id = extractResponsesCallID(item);

        if (id !== "" && (explicitOutputCounts.get(id) ?? 0) === 0) unclaimedCalls.add(id);
      }
    }

    const inputItems = normalizeResponsesToolCallOutputs(rawInputArray);

    if (missingIdOutputsCount > 1 || (missingIdOutputsCount > 0 && unclaimedCalls.size > 1)) {
      inputItems.forEach((item, idx) => {
        const itemType = getStr(item, "type");

        if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
          if (idx < rawInputArray.length && extractResponsesCallID(rawInputArray[idx]) === "") {
            // SAFETY: itemType was read from `item` and is a *_output type, which only object items carry.
            const copy = structuredClone(item) as JsonObject;
            delete copy.call_id;
            delete copy.tool_call_id;
            delete copy.callId;
            inputItems[idx] = copy;
          }
        }
      });
    }

    let hasReasoningInSession = false;

    const isActiveEffort = (effort: string): boolean =>
      effort !== "" && effort !== "none" && effort !== "0" && effort !== "false";

    const reasoningEffort = get(root, "reasoning.effort");
    const reasoningEffortFlat = get(root, "reasoning_effort");
    const reasoningObj = get(root, "reasoning");

    if (reasoningEffort !== undefined) {
      hasReasoningInSession = isActiveEffort(str(reasoningEffort).trim().toLowerCase());
    } else if (reasoningEffortFlat !== undefined) {
      hasReasoningInSession = isActiveEffort(str(reasoningEffortFlat).trim().toLowerCase());
    } else if (reasoningObj !== undefined) {
      const reasoningRaw = str(reasoningObj).trim().toLowerCase();
      hasReasoningInSession =
        reasoningRaw !== "" &&
        reasoningRaw !== "none" &&
        reasoningRaw !== "false" &&
        reasoningRaw !== "{}";
    }

    if (!hasReasoningInSession) {
      for (const item of rawInputArray) {
        if (getStr(item, "type") === "reasoning" || get(item, "reasoning_content") !== undefined) {
          hasReasoningInSession = true;
          break;
        }
      }
    }

    let pendingToolCalls: Json[] = [];
    let pendingToolCallIds: string[] = [];
    let pendingReasoningContent = "";
    let latestReasoningContent = "";
    const awaitingToolOutputs = new Set<string>();
    const outputCounts = new Map<string, number>();
    let mergeableAssistantIndex = -1;
    let pendingToolFileParts: JsonObject[] = [];

    const fallbackToolReasoning = (): string => {
      if (latestReasoningContent !== "") return latestReasoningContent;

      return hasReasoningInSession ? REASONING_UNAVAILABLE : "";
    };

    const takePendingReasoningContent = (): string => {
      const reasoningContent = pendingReasoningContent;
      pendingReasoningContent = "";

      return reasoningContent;
    };

    const flushPendingToolCalls = (): void => {
      if (pendingToolCalls.length === 0) return;
      const reasoningContent = takePendingReasoningContent();
      let mergedIntoAssistant = false;

      if (mergeableAssistantIndex >= 0 && mergeableAssistantIndex === messages.length - 1) {
        // SAFETY: mergeableAssistantIndex === messages.length - 1 was checked, and it is >= 0.
        const assistantMessage = messages[mergeableAssistantIndex] as JsonObject;

        if (
          getStr(assistantMessage, "role") === "assistant" &&
          assistantMessage.tool_calls === undefined
        ) {
          assistantMessage.tool_calls = pendingToolCalls;

          const combined = combineOpenAIResponsesReasoning(
            getStr(assistantMessage, "reasoning_content"),
            reasoningContent,
          );

          if (combined !== "") {
            assistantMessage.reasoning_content = combined;

            if (isUsableResponsesReasoning(combined)) latestReasoningContent = combined;
          } else {
            const fallback = fallbackToolReasoning();

            if (fallback !== "") assistantMessage.reasoning_content = fallback;
          }

          mergedIntoAssistant = true;
        }
      }

      if (!mergedIntoAssistant) {
        const assistantMessage: JsonObject = { role: "assistant", tool_calls: pendingToolCalls };

        if (reasoningContent !== "") {
          assistantMessage.reasoning_content = reasoningContent;

          if (isUsableResponsesReasoning(reasoningContent))
            latestReasoningContent = reasoningContent;
        } else {
          const fallback = fallbackToolReasoning();

          if (fallback !== "") assistantMessage.reasoning_content = fallback;
        }

        appendMessage(assistantMessage);
      }

      for (const id of pendingToolCallIds) {
        const t = id.trim();

        if (t !== "") awaitingToolOutputs.add(t);
      }

      pendingToolCalls = [];
      pendingToolCallIds = [];
      mergeableAssistantIndex = -1;
    };

    const appendRegularMessage = (message: JsonObject): number => {
      appendMessage(message);

      return messages.length - 1;
    };

    /** `flushPendingToolFileParts`: relayed tool output files and media, after every awaited tool output. */
    const flushPendingToolFileParts = (): void => {
      if (pendingToolFileParts.length === 0) return;
      appendRegularMessage({ role: "user", content: pendingToolFileParts });
      pendingToolFileParts = [];
    };

    const appendPendingReasoningMessage = (): void => {
      const reasoningContent = takePendingReasoningContent();

      if (reasoningContent === "") return;

      if (isUsableResponsesReasoning(reasoningContent)) latestReasoningContent = reasoningContent;
      appendRegularMessage({ role: "assistant", content: "", reasoning_content: reasoningContent });
    };

    const recordOutputCount = (callId: string): void => {
      if (callId === "") return;
      const count = (outputCounts.get(callId) ?? 0) + 1;
      outputCounts.set(callId, count);

      if (count > 1) duplicateOutputIds.add(callId);
    };

    const pushToolCall = (item: Json, name: string, argumentsText: string | undefined): void => {
      const callId = extractResponsesCallID(item);
      pendingToolCalls.push({
        function: { arguments: argumentsText ?? "", name },
        id: callId,
        type: "function",
      });

      if (callId !== "") pendingToolCallIds.push(callId);
    };

    const emitToolOutput = (item: Json, setContent: ChatToolOutputContentSetter): void => {
      mergeableAssistantIndex = -1;
      const callId = extractResponsesCallID(item);
      recordOutputCount(callId);
      const output = get(item, "output");

      if (!awaitingToolOutputs.has(callId)) {
        // Orphan outputs (empty call_id or no matching assistant tool_calls) must not become tool messages.
        const unsupportedType = appendStandaloneResponsesToolOutputAsUser(
          output,
          setContent,
          (message) => {
            appendRegularMessage(message);
          },
        );

        toolOutputErrType ??= unsupportedType;
      } else {
        const toolMessage: JsonObject = { role: "tool", tool_call_id: callId, content: "" };
        awaitingToolOutputs.delete(callId);

        if (output !== undefined) {
          const { fileParts, unsupportedType } = setContent(toolMessage, output, "relayToolFiles");
          toolOutputErrType ??= unsupportedType;

          if (fileParts !== undefined) pendingToolFileParts.push(...fileParts);
        }

        appendMessage(toolMessage);

        // Relayed files follow once every awaited output is in, keeping tool messages paired with their calls.
        if (awaitingToolOutputs.size === 0) flushPendingToolFileParts();
      }
    };

    for (const item of inputItems) {
      let itemType = getStr(item, "type");

      if (itemType === "" && getStr(item, "role") !== "") itemType = "message";

      if (itemType !== "function_call" && itemType !== "custom_tool_call") flushPendingToolCalls();

      if (itemType !== "function_call_output" && itemType !== "custom_tool_call_output")
        flushPendingToolFileParts();

      switch (itemType) {
        case "message":
        case "": {
          const role = getStr(item, "role");
          // Chat Completions supports developer messages: keep their role and position so mid-session instructions
          // retain their authority (CLIProxyAPI 00b76771). Only real user turns take part in the unsupported-content
          // refusal.
          const isUserTurn = role === "user";
          mergeableAssistantIndex = -1;

          if (role !== "assistant") {
            appendPendingReasoningMessage();
            latestReasoningContent = "";
          }

          const message: JsonObject = { role, content: [] };

          const content = get(item, "content");

          if (isArr(content)) {
            const contentItems: Json[] = [];
            let turnSendable = 0;

            for (const contentItem of content) {
              let contentType = getStr(contentItem, "type");

              if (contentType === "") contentType = "input_text";

              switch (contentType) {
                case "input_text":
                case "output_text": {
                  const text = getStr(contentItem, "text");
                  contentItems.push({ type: "text", text });

                  if (text !== "") turnSendable++;
                  break;
                }

                case "input_video":
                case "video_url": {
                  const videoUrlPart: JsonObject = {};
                  const videoUrl = get(contentItem, "video_url");

                  if (isObj(videoUrl)) Object.assign(videoUrlPart, cloneJson(videoUrl));
                  else if (videoUrl !== undefined) videoUrlPart.url = cloneJson(videoUrl);
                  const processing = get(contentItem, "processing");

                  if (processing !== undefined) videoUrlPart.processing = cloneJson(processing);
                  // Malformed video parts are preserved for upstream validation.
                  contentItems.push({ type: "video_url", video_url: videoUrlPart });
                  turnSendable++;
                  break;
                }

                case "input_image": {
                  const imageUrl: JsonObject = { url: getStr(contentItem, "image_url") };
                  const detail = normalizeChatImageDetail(get(contentItem, "detail"));

                  if (detail.ok && detail.detail !== "") imageUrl.detail = detail.detail;
                  contentItems.push({ type: "image_url", image_url: imageUrl });
                  turnSendable++;
                  break;
                }

                case "input_file": {
                  const part = responsesInputFileToChatPart(contentItem);

                  if (part !== undefined) {
                    contentItems.push(part);
                    turnSendable++;
                  } else if (isUserTurn) {
                    // Chat Completions takes a file id or inline bytes only.
                    drops.drop(contentType);
                  }

                  break;
                }

                case "input_audio": {
                  const part = responsesInputAudioToChatPart(contentItem);

                  if (part !== undefined) {
                    contentItems.push(part);
                    turnSendable++;
                  } else if (isUserTurn) {
                    drops.drop(contentType);
                  }

                  break;
                }
              }
            }

            if (isUserTurn) drops.endTurn(turnSendable);

            if (contentItems.length > 0) message.content = contentItems;
          } else if (typeof content === "string") {
            message.content = content;
          }

          if (role === "assistant") {
            const reasoningContent = combineOpenAIResponsesReasoning(
              takePendingReasoningContent(),
              getStr(item, "reasoning_content"),
            );

            if (reasoningContent !== "") {
              message.reasoning_content = reasoningContent;

              if (isUsableResponsesReasoning(reasoningContent))
                latestReasoningContent = reasoningContent;
            }
          }

          const messageIndex = appendRegularMessage(message);

          if (role === "assistant") mergeableAssistantIndex = messageIndex;
          break;
        }

        case "reasoning": {
          const reasoningContent = collectOpenAIResponsesReasoningContent(item);
          pendingReasoningContent = combineOpenAIResponsesReasoning(
            pendingReasoningContent,
            reasoningContent,
          );

          if (isUsableResponsesReasoning(reasoningContent))
            latestReasoningContent = reasoningContent;
          break;
        }

        case "function_call": {
          const rc = getStr(item, "reasoning_content");
          pendingReasoningContent = combineOpenAIResponsesReasoning(pendingReasoningContent, rc);

          if (isUsableResponsesReasoning(rc)) latestReasoningContent = rc;
          // Consecutive function calls are buffered and emitted as one assistant message.
          let functionName = "";

          if (get(item, "name") !== undefined) {
            functionName = getStr(item, "name");
            const namespace = getStr(item, "namespace").trim();
            functionName =
              namespace !== ""
                ? toolIndex.namespaceName(namespace, functionName)
                : toolIndex.canonicalName(functionName);
          }

          // Omitted or blank arguments become a valid empty object (Go 927ed398).
          const args = get(item, "arguments");
          const argsText = args !== undefined ? str(args) : "";
          pushToolCall(item, functionName, argsText.trim() !== "" ? argsText : "{}");
          break;
        }

        case "function_call_output":
          emitToolOutput(item, setFunctionCallOutputContent);
          break;
        case "custom_tool_call": {
          const rc = getStr(item, "reasoning_content");
          pendingReasoningContent = combineOpenAIResponsesReasoning(pendingReasoningContent, rc);

          if (isUsableResponsesReasoning(rc)) latestReasoningContent = rc;
          // Codex freeform tool call replay: wrap the raw input in the {"input": string} function shape.
          let functionName = getStr(item, "name");
          const namespace = getStr(item, "namespace");
          functionName =
            namespace !== ""
              ? toolIndex.namespaceName(namespace, functionName)
              : toolIndex.canonicalName(functionName);
          const wrappedArgs = `{"input":${JSON.stringify(getStr(item, "input"))}}`;
          pushToolCall(item, functionName, wrappedArgs);
          break;
        }

        case "custom_tool_call_output":
          emitToolOutput(item, setCustomToolCallOutputContent);
          break;
        default:
          mergeableAssistantIndex = -1;
      }
    }

    flushPendingToolCalls();
    flushPendingToolFileParts();
    appendPendingReasoningMessage();
  } else if (typeof input === "string") {
    appendMessage({ role: "user", content: input });
  }

  if (messages.length > 0) {
    out.messages = alignOpenAIToolCallMessages(messages, [...duplicateOutputIds]);
  }

  // Codex Desktop (Responses Lite) delivers tools through "additional_tools" input items: merge both sources.
  const chatTools = toolIndex.chatTools();

  if (chatTools.length > 0) {
    out.tools = chatTools;
    const parallelToolCalls = get(root, "parallel_tool_calls");

    if (parallelToolCalls !== undefined) out.parallel_tool_calls = asBool(parallelToolCalls);
    const toolChoice = get(root, "tool_choice");

    if (toolChoice !== undefined)
      out.tool_choice = convertResponsesToolChoice(toolChoice, toolIndex);
  }

  const reasoningEffort = get(root, "reasoning.effort");

  if (reasoningEffort !== undefined) {
    const effort = str(reasoningEffort).trim().toLowerCase();

    if (effort !== "") out.reasoning_effort = effort;
  }

  const err = drops.err(out);

  if (err !== undefined) throw err;

  if (toolOutputErrType !== undefined) throw new UnsupportedPartError(toolOutputErrType, out);

  return out;
};

/**
 * Claude Messages client -> OpenAI Chat Completions provider (request).
 *
 * Go source: internal/translator/openai/claude/openai_claude_request.go.
 */
import {
  asFloat,
  asInt,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";
import { claudeOutputEffort } from "../../../thinking/claude-effort-directive.ts";
import { convertBudgetToLevel } from "../../../thinking/convert.ts";
import {
  parseLevelSuffix,
  parseNumericSuffix,
  parseSpecialSuffix,
  parseSuffix,
} from "../../../thinking/suffix.ts";
import { getThinkingText } from "../../../thinking/text.ts";
import { alignOpenAIToolCallMessages } from "../common/openai-tools.ts";
import { getStr, isArr, isObj, present, raw, str } from "../common/read.ts";
import {
  alignClaudeToolResults,
  claudeMessageSystemReminderText,
  isClaudeCodeAttributionSystemText,
} from "../../common/claude-messages.ts";
import {
  hasUnsupportedUnicodePropertyEscape,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_VALUE_KEYWORDS,
} from "../../common/schema.ts";
import { compatibleSignatureForProvider } from "../../../signature/provider.ts";
import { UserTurnDrops } from "../../common/parts.ts";
import { inlineToolAdditionDefinitions } from "../../common/claude-tool-addition.ts";

/** `toolResultImagePlaceholder`: keeps the OpenAI tool message non-empty for image-only tool results. */
const TOOL_RESULT_IMAGE_PLACEHOLDER =
  "[Tool returned image content; the images follow in the next user message.]";

/** `toolResultImageRelayNotice`: labels the user message that carries relayed tool images. */
const TOOL_RESULT_IMAGE_RELAY_NOTICE = "Images returned by the preceding tool call(s):";

/** `normalizeObjectSchemaProperties`; mutates and returns `schema` (callers pass a private copy). */
export const normalizeObjectSchemaProperties = (schema: Json): Json => {
  if (typeof schema === "boolean") {
    // Strict OpenAPI 3.0 validators reject boolean subschemas: `true` becomes `{}`, `false` is preserved.
    return schema ? {} : schema;
  }

  if (isJsonArray(schema)) {
    for (const [i, item] of schema.entries()) schema[i] = normalizeObjectSchemaProperties(item);

    return schema;
  }

  if (!isJsonObject(schema)) return schema;
  const value = schema;

  if (value.type === "object" && !Object.hasOwn(value, "properties")) value.properties = {};

  if (typeof value.pattern === "string" && hasUnsupportedUnicodePropertyEscape(value.pattern))
    delete value.pattern;

  const patternProps = value.patternProperties;

  if (isJsonObject(patternProps)) {
    for (const [patternKey, subSchema] of Object.entries(patternProps)) {
      if (hasUnsupportedUnicodePropertyEscape(patternKey)) delete patternProps[patternKey];
      else patternProps[patternKey] = normalizeObjectSchemaProperties(subSchema);
    }
  }

  for (const mapKey of SCHEMA_MAP_KEYWORDS) {
    if (mapKey === "patternProperties") continue;
    const subMap = value[mapKey];

    if (isJsonObject(subMap)) {
      for (const [subKey, subSchema] of Object.entries(subMap))
        subMap[subKey] = normalizeObjectSchemaProperties(subSchema);
    }
  }

  for (const valKey of SCHEMA_VALUE_KEYWORDS) {
    if (!Object.hasOwn(value, valKey)) continue;
    const sub = value[valKey];

    if (typeof sub === "boolean") {
      // Boolean `additionalProperties` is required by OpenAI structured outputs and stays as is.
      if (valKey !== "additionalProperties" && sub) value[valKey] = {};
    } else if (isJsonObject(sub)) {
      value[valKey] = normalizeObjectSchemaProperties(sub);
    } else if (isJsonArray(sub)) {
      for (const [i, item] of sub.entries()) sub[i] = normalizeObjectSchemaProperties(item);
    }
  }

  return value;
};

const shouldMapClaudeThinkingToGptReasoning = (
  part: Json,
  preserveThinkingBlocks: boolean,
): boolean => {
  if (preserveThinkingBlocks) return true;
  const signature = get(part, "signature");

  if (signature === undefined || str(signature).trim() === "") return false;

  return compatibleSignatureForProvider("gpt", str(signature)) !== undefined;
};

/** `convertClaudeContentPart`. */
export const convertClaudeContentPart = (part: Json): JsonObject | undefined => {
  const partType = getStr(part, "type");

  switch (partType) {
    case "text": {
      const text = getStr(part, "text");

      if (text.trim() === "" || isClaudeCodeAttributionSystemText(text)) return undefined;

      return { type: "text", text };
    }

    case "image": {
      let imageUrl = "";
      const source = get(part, "source");

      if (source !== undefined) {
        const sourceType = getStr(source, "type");

        if (sourceType === "base64") {
          let mediaType = getStr(source, "media_type");

          if (mediaType === "") mediaType = "application/octet-stream";
          const data = getStr(source, "data");

          if (data !== "") imageUrl = `data:${mediaType};base64,${data}`;
        } else if (sourceType === "url") {
          imageUrl = getStr(source, "url");
        }
      }

      if (imageUrl === "") imageUrl = getStr(part, "url");

      if (imageUrl === "") return undefined;

      return { type: "image_url", image_url: { url: imageUrl } };
    }

    case "document":
    case "container_upload":
      return convertClaudeFilePartToOpenAI(part);
    default:
      return undefined;
  }
};

const decodeBase64 = (text: string): Uint8Array | undefined => {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);

    return out;
  } catch {
    return undefined;
  }
};

/** Emits an OpenAI file part for inline base64 bytes; a file id carries none and stays unconverted. */
const convertClaudeFilePartToOpenAI = (part: Json): JsonObject | undefined => {
  const source = get(part, "source");
  let mimeType = getStr(source, "media_type");
  let data: Uint8Array | undefined;

  if (getStr(source, "type") === "base64") {
    // Go uses StdEncoding (padding required); atob is more lenient, which only matters for malformed input.
    const encoded = getStr(source, "data").trim();

    if (encoded.length % 4 !== 0) return undefined;
    data = decodeBase64(encoded);

    if (data === undefined) return undefined;
  }

  if (data === undefined || data.length === 0) return undefined;

  if (mimeType === "") mimeType = "application/octet-stream";
  let binary = "";

  for (const byte of data) binary += String.fromCharCode(byte);

  return {
    type: "file",
    file: {
      filename: getStr(part, "filename"),
      file_data: `data:${mimeType};base64,${btoa(binary)}`,
    },
  };
};

interface ToolResultContent {
  text: string;
  images: JsonObject[];
}

/** `convertClaudeToolResultContent`: the text for the tool message plus images to relay in a user message. */
const convertClaudeToolResultContent = (content: Json | undefined): ToolResultContent => {
  if (content === undefined) return { text: "", images: [] };

  if (typeof content === "string") return { text: content, images: [] };

  if (isArr(content)) {
    const parts: string[] = [];
    const images: JsonObject[] = [];

    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (isObj(item) && item.type === "text") {
        parts.push(str(item.text));
      } else if (isObj(item) && item.type === "image") {
        const contentItem = convertClaudeContentPart(item);

        if (contentItem !== undefined) images.push(contentItem);
        else parts.push(raw(item));
      } else if (isObj(item) && typeof item.text === "string") {
        parts.push(item.text);
      } else {
        parts.push(raw(item));
      }
    }

    const joined = parts.join("\n\n");

    if (joined.trim() === "") {
      if (images.length > 0) return { text: TOOL_RESULT_IMAGE_PLACEHOLDER, images };

      return { text: raw(content), images: [] };
    }

    return { text: joined, images };
  }

  if (isObj(content)) {
    if (content.type === "image") {
      const contentItem = convertClaudeContentPart(content);

      if (contentItem !== undefined)
        return { text: TOOL_RESULT_IMAGE_PLACEHOLDER, images: [contentItem] };
    }

    if (typeof content.text === "string") return { text: content.text, images: [] };

    return { text: raw(content), images: [] };
  }

  return { text: raw(content), images: [] };
};

const convertClaudeToolToOpenAI = (tool: Json): Json => {
  const fn: JsonObject = {
    name: getStr(tool, "name"),
    description: getStr(tool, "description"),
  };

  const inputSchema = get(tool, "input_schema");

  if (present(inputSchema)) {
    fn.parameters = normalizeObjectSchemaProperties(cloneJson(inputSchema));
  } else {
    fn.parameters = { type: "object", properties: {} };
  }

  return { type: "function", function: fn };
};

const convertClaudeRequestToOpenAIImpl = (
  modelName: string,
  root: Json,
  stream: boolean,
  preserveThinkingBlocks: boolean,
): Json => {
  const drops = new UserTurnDrops();
  const out: JsonObject = { model: modelName, messages: [] };

  const maxTokens = get(root, "max_tokens");

  if (maxTokens !== undefined) out.max_tokens = asInt(maxTokens);

  const temp = get(root, "temperature");
  const topP = get(root, "top_p");

  if (temp !== undefined) out.temperature = asFloat(temp);
  else if (topP !== undefined) out.top_p = asFloat(topP);

  const stopSequences = get(root, "stop_sequences");

  if (isArr(stopSequences)) {
    const stops = stopSequences.map((value) => str(value));

    if (stops.length > 0) out.stop = stops;
  }

  out.stream = stream;

  const thinkingConfig = get(root, "thinking");

  if (isObj(thinkingConfig)) {
    const thinkingType = thinkingConfig.type;

    if (thinkingType !== undefined) {
      const effortOutput = get(root, "output_config.effort");

      switch (str(thinkingType)) {
        case "enabled": {
          const budgetTokens = thinkingConfig.budget_tokens;

          if (budgetTokens !== undefined) {
            const effort = convertBudgetToLevel(asInt(budgetTokens));

            if (effort !== undefined && effort !== "") out.reasoning_effort = effort;
          } else if (typeof effortOutput === "string" && effortOutput.trim() !== "") {
            // Some Claude-compatible clients pair manual thinking with output_config.effort.
            out.reasoning_effort = effortOutput.trim().toLowerCase();
          } else {
            const effort = convertBudgetToLevel(-1);

            if (effort !== undefined && effort !== "") out.reasoning_effort = effort;
          }

          break;
        }

        case "adaptive":
        case "auto": {
          const effort = typeof effortOutput === "string" ? effortOutput.trim().toLowerCase() : "";
          out.reasoning_effort = effort !== "" ? effort : "xhigh";
          break;
        }

        case "disabled": {
          const effort = convertBudgetToLevel(0);

          if (effort !== undefined && effort !== "") out.reasoning_effort = effort;
          break;
        }
      }
    }
  } else if (thinkingConfig === undefined) {
    // Claude output_config.effort is independent of thinking activation: keep it when thinking is omitted.
    const effort = claudeOutputEffort(root);

    if (effort !== "") out.reasoning_effort = effort;
  }

  const reasoningActive = isClaudeRequestReasoningActive(
    out.reasoning_effort,
    modelName,
    getStr(root, "model"),
  );

  let messageItems: Json[] = [];

  const systemContentItems: Json[] = [];

  const appendSystemContent = (content: Json | undefined): void => {
    if (content === undefined) return;

    if (typeof content === "string") {
      if (content === "" || isClaudeCodeAttributionSystemText(content)) return;
      systemContentItems.push({ type: "text", text: content });

      return;
    }

    if (isArr(content)) {
      for (const item of content) {
        const contentItem = convertClaudeContentPart(item);

        if (contentItem !== undefined) systemContentItems.push(contentItem);
      }
    }
  };

  appendSystemContent(get(root, "system"));

  if (systemContentItems.length > 0)
    messageItems.push({ role: "system", content: systemContentItems });

  const messages = get(root, "messages");

  if (isArr(messages)) {
    let pendingToolUseIds: string[] = [];
    let pendingSystemReminders: Json[] = [];
    const toolNameById = new Map<string, string>();

    for (const message of messages) {
      const role = getStr(message, "role");
      let contentResult = get(message, "content");

      if (role === "system") {
        const reminderText = claudeMessageSystemReminderText(contentResult);

        if (reminderText !== undefined) {
          const msgJson: Json = { role: "user", content: [{ type: "text", text: reminderText }] };

          if (pendingToolUseIds.length > 0) pendingSystemReminders.push(msgJson);
          else messageItems.push(msgJson);
        }

        continue;
      }

      if (isArr(contentResult)) {
        if (role === "user" && pendingToolUseIds.length > 0) {
          contentResult = alignClaudeToolResults(contentResult, pendingToolUseIds);
        }

        const precedingToolCallsPending = pendingToolUseIds.length > 0;
        pendingToolUseIds = [];

        let contentItems: Json[] = [];
        const reasoningParts: string[] = [];
        const toolCalls: Json[] = [];
        const toolResults: Json[] = [];
        const relayedToolImages: Json[] = [];

        for (const part of contentResult) {
          const partType = getStr(part, "type");

          switch (partType) {
            case "thinking": {
              // Only assistant thinking maps to reasoning_content (prevents injection through other roles).
              if (role === "assistant") {
                if (!shouldMapClaudeThinkingToGptReasoning(part, preserveThinkingBlocks)) break;
                const thinkingText = getThinkingText(part);

                if (thinkingText.trim() !== "") reasoningParts.push(thinkingText);
              }

              break;
            }

            case "redacted_thinking":
              // Never mapped to reasoning_content.
              break;
            case "text":
            case "image":
            case "document":
            case "container_upload": {
              const contentItem = convertClaudeContentPart(part);

              if (contentItem !== undefined) contentItems.push(contentItem);
              else if (role === "user" && partType !== "text") drops.drop(partType);
              break;
            }

            case "tool_use": {
              // Only assistant tool_use maps to tool_calls (prevents injection through other roles).
              if (role === "assistant") {
                const toolUseId = getStr(part, "id");
                const toolName = getStr(part, "name");

                if (toolUseId !== "") {
                  pendingToolUseIds.push(toolUseId);

                  if (toolName !== "") toolNameById.set(toolUseId, toolName);
                }

                const input = get(part, "input");
                toolCalls.push({
                  function: { arguments: input !== undefined ? raw(input) : "{}", name: toolName },
                  id: toolUseId,
                  type: "function",
                });
              }

              break;
            }

            case "tool_result": {
              const toolUseId = getStr(part, "tool_use_id");
              const result: JsonObject = { role: "tool", tool_call_id: toolUseId, content: "" };
              const toolName = toolNameById.get(toolUseId) ?? "";

              if (toolName !== "") result.name = toolName;
              const converted = convertClaudeToolResultContent(get(part, "content"));
              result.content = converted.text;
              relayedToolImages.push(...converted.images);
              toolResults.push(result);
              break;
            }
          }
        }

        const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join("\n\n") : "";
        const hasContent = contentItems.length > 0;
        const hasReasoning = reasoningContent !== "";
        const hasToolCalls = toolCalls.length > 0;
        const hasToolResults = toolResults.length > 0;

        if (role === "user") drops.endTurn(contentItems.length + toolResults.length);

        if (precedingToolCallsPending && !hasToolResults && pendingSystemReminders.length > 0) {
          messageItems.push(...pendingSystemReminders);
          pendingSystemReminders = [];
        }

        // Tool messages must immediately follow the assistant message with tool_calls.
        messageItems.push(...toolResults);

        if (relayedToolImages.length > 0) {
          const relayItems: Json[] = [
            { type: "text", text: TOOL_RESULT_IMAGE_RELAY_NOTICE },
            ...relayedToolImages,
          ];

          if (role === "user" && hasContent) {
            contentItems = [...relayItems, ...contentItems];
          } else {
            messageItems.push({ role: "user", content: relayItems });
          }
        }

        if (pendingSystemReminders.length > 0) {
          messageItems.push(...pendingSystemReminders);
          pendingSystemReminders = [];
        }

        if (role === "assistant") {
          if (hasContent || hasReasoning || hasToolCalls) {
            const msgJson: JsonObject = {
              role: "assistant",
              content: hasContent ? contentItems : "",
            };

            if (hasReasoning) {
              msgJson.reasoning_content = reasoningContent;
            } else if (hasToolCalls && preserveThinkingBlocks && reasoningActive) {
              // Tool-call turn without replayable thinking text: compat thinking upstreams (DeepSeek, Moonshot/Kimi)
              // require reasoning_content on it while reasoning is active.
              msgJson.reasoning_content = REASONING_CONTENT_PLACEHOLDER;
            }

            if (hasToolCalls) msgJson.tool_calls = toolCalls;
            messageItems.push(msgJson);
          }
        } else if (hasContent) {
          messageItems.push({ role, content: contentItems });
        }
      } else if (typeof contentResult === "string") {
        messageItems.push({ role, content: contentResult });
      }
    }

    if (pendingSystemReminders.length > 0) messageItems.push(...pendingSystemReminders);
  }

  if (messageItems.length > 0) {
    messageItems = alignOpenAIToolCallMessages(messageItems);
    out.messages = messageItems;
  }

  const tools = get(root, "tools");

  // A tool a `tool_addition` block introduces mid-conversation joins the tools (upstream 12d97cfe).
  const midConversationToolDefs = inlineToolAdditionDefinitions(root).filter(
    (definition) => getStr(definition, "name") !== "",
  );

  const toolItems: Json[] = [];
  const toolIndexByName = new Map<string, number>();

  if (isArr(tools)) {
    for (const tool of tools) {
      const name = getStr(tool, "name");

      if (name !== "") toolIndexByName.set(name, toolItems.length);
      toolItems.push(convertClaudeToolToOpenAI(tool));
    }
  }

  for (const definition of midConversationToolDefs) {
    const name = getStr(definition, "name");
    const converted = convertClaudeToolToOpenAI(definition);
    const index = toolIndexByName.get(name);

    if (index === undefined) {
      toolIndexByName.set(name, toolItems.length);
      toolItems.push(converted);
    } else {
      toolItems[index] = converted;
    }
  }

  if (toolItems.length > 0) out.tools = toolItems;

  const toolChoice = get(root, "tool_choice");

  if (present(toolChoice)) {
    let choiceType = getStr(toolChoice, "type");

    if (choiceType === "" && typeof toolChoice === "string") choiceType = toolChoice;

    switch (choiceType) {
      case "auto":
        out.tool_choice = "auto";
        break;
      case "any":
        out.tool_choice = "required";
        break;
      case "none":
        out.tool_choice = "none";
        break;
      case "tool": {
        const toolName = getStr(toolChoice, "name");
        out.tool_choice =
          toolName !== "" ? { type: "function", function: { name: toolName } } : "none";
        break;
      }

      default:
        // Fail closed: unrecognised tool_choice values must not turn into permission.
        out.tool_choice = "none";
    }

    if (get(toolChoice, "disable_parallel_tool_use") === true) out.parallel_tool_calls = false;
  }

  const user = get(root, "user");

  if (user !== undefined) out.user = str(user);

  const err = drops.err(out);

  if (err !== undefined) throw err;

  return out;
};

/** `isThinkingSuffixActive`: whether a `model(suffix)` turns reasoning on (`[active, recognised]`). */
const thinkingSuffixActive = (model: string): readonly [boolean, boolean] => {
  const suffix = parseSuffix(model.trim());

  if (!suffix.hasSuffix) return [false, false];
  const mode = parseSpecialSuffix(suffix.rawSuffix);

  if (mode !== undefined) return [mode !== "none", true];
  const budget = parseNumericSuffix(suffix.rawSuffix);

  if (budget !== undefined) return [budget > 0, true];
  const level = parseLevelSuffix(suffix.rawSuffix);

  if (level !== undefined) return [level !== "none", true];

  return [false, false];
};

/** The `reasoning_content` the compat translator and the thinking reconciliation put on tool-call turns without thinking. */
export const REASONING_CONTENT_PLACEHOLDER = " ";

/** Whether a canonical `reasoning_effort` turns reasoning on (anything but empty, `none`, `0` or `false`). */
export const isReasoningEffortActive = (effort: Json | undefined): boolean => {
  if (typeof effort !== "string") return false;
  const resolved = effort.trim().toLowerCase();

  return resolved !== "" && resolved !== "none" && resolved !== "0" && resolved !== "false";
};

/** `isClaudeRequestReasoningActive`: model suffixes win over the body, then the translated `reasoning_effort`. */
const isClaudeRequestReasoningActive = (
  effort: Json | undefined,
  modelName: string,
  payloadModel: string,
): boolean => {
  for (const model of [modelName, payloadModel]) {
    const [active, recognised] = thinkingSuffixActive(model);

    if (recognised) return active;
  }

  return isReasoningEffortActive(effort);
};

/** `ConvertClaudeRequestToOpenAI`. */
export const convertClaudeRequestToOpenAI = (
  modelName: string,
  body: Json,
  stream: boolean,
): Json => convertClaudeRequestToOpenAIImpl(modelName, body, stream, false);

/** `ConvertClaudeRequestToOpenAIWithCompat`: preserves assistant thinking text for compatibility endpoints. */
export const convertClaudeRequestToOpenAIWithCompat = (
  modelName: string,
  body: Json,
  stream: boolean,
): Json => convertClaudeRequestToOpenAIImpl(modelName, body, stream, true);

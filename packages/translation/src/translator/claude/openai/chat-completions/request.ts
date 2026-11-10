/**
 * OpenAI Chat Completions client -> Claude Messages provider (request).
 *
 * Go source: internal/translator/claude/openai/chat-completions/claude_openai_request.go.
 */
import { asFloat, asInt, get, type Json, type JsonObject } from "@commissary/json";
import {
  convertLevelToBudget,
  hasLevel,
  mapToClaudeEffort,
  applyTranslatedSummaryToClaude,
} from "../../../../thinking/index.ts";
import { lookupModelInfo } from "../../../model-info.ts";
import {
  attachCacheControl,
  attachMessageCacheControl,
  attachToolMessageCacheControl,
  moveBlankPartCacheControl,
} from "../../../common/cache-control.ts";
import { ClaudeMessageAccumulator } from "../../../common/claude-messages.ts";
import { buildClaudeStructuredOutputInstruction } from "../../../common/claude-system.ts";
import { deriveClaudeUserID } from "../../../common/claude-user-id.ts";
import {
  defaultClaudeMaxTokensForModel,
  normalizeClaudeToolInputSchema,
  sanitizeClaudeFunctionName,
} from "../../../common/claude-util.ts";
import { generateClaudeToolCallId } from "../../../common/request.ts";
import { sanitizeClaudeToolId } from "../../../common/tool-names.ts";
import { exists, isArr, isObj, str, toArray, trimmed } from "../../../common/gjson.ts";
import { UserTurnDrops } from "../../../common/parts.ts";

/** The first value that exists and is not JSON null (a client sending `"max_tokens": null` omitted it). */
const firstExisting = (...values: Array<Json | undefined>): Json | undefined =>
  values.find((value) => value !== undefined && value !== null);

/** An empty or whitespace-only text part: Anthropic answers 400 to it. */
const isBlankText = (value: string): boolean => value.trim() === "";

/** `ConvertOpenAIRequestToClaude`. */
export const convertOpenAIRequestToClaude = (
  modelName: string,
  input: Json,
  stream: boolean,
): Json => convertRequest(modelName, input, stream, false);

/** `ConvertOpenAIRequestToClaudeWithCompat`: assistant reasoning becomes an unsigned thinking block. */
export const convertOpenAIRequestToClaudeWithCompat = (
  modelName: string,
  input: Json,
  stream: boolean,
): Json => convertRequest(modelName, input, stream, true);

const convertRequest = (
  modelName: string,
  root: Json,
  stream: boolean,
  preserveEmptyThinkingBlocks: boolean,
): Json => {
  const drops = new UserTurnDrops();
  const userId = deriveClaudeUserID(root);

  const out: JsonObject = {
    model: "",
    max_tokens: defaultClaudeMaxTokensForModel(modelName),
    messages: [],
    metadata: { user_id: userId },
  };

  const reasoning = get(root, "reasoning_effort");

  if (exists(reasoning)) {
    let effort = str(reasoning).trim().toLowerCase();

    if (effort !== "") {
      const mi = lookupModelInfo(modelName, "claude");
      const supportsAdaptive = (mi?.thinking?.levels?.length ?? 0) > 0;
      const supportsMax = supportsAdaptive && hasLevel(mi?.thinking?.levels, "max");

      if (supportsAdaptive) {
        switch (effort) {
          case "none":
            out.thinking = { type: "disabled" };
            break;
          case "auto":
            out.thinking = { type: "adaptive" };
            break;
          default: {
            // A level the model advertises is sent as is; others are mapped to the nearest Claude effort.
            const mapped = hasLevel(mi?.thinking?.levels, effort)
              ? undefined
              : mapToClaudeEffort(effort, supportsMax);

            if (mapped !== undefined) effort = mapped;
            out.thinking = { type: "adaptive" };
            out.output_config = { effort };
          }
        }
      } else {
        const budget = convertLevelToBudget(effort);

        if (budget !== undefined) {
          if (budget === 0) out.thinking = { type: "disabled" };
          else if (budget === -1) out.thinking = { type: "enabled" };
          else if (budget > 0) out.thinking = { type: "enabled", budget_tokens: budget };
        }
      }
    }
  }

  out.model = modelName;

  const maxTokens = firstExisting(get(root, "max_tokens"), get(root, "max_completion_tokens"));

  if (exists(maxTokens)) out.max_tokens = asInt(maxTokens);

  const topP = get(root, "top_p");

  if (exists(topP)) out.top_p = asFloat(topP);

  const stop = get(root, "stop");

  if (exists(stop)) {
    if (isArr(stop)) {
      const sequences = stop.map(str);

      if (sequences.length > 0) out.stop_sequences = sequences;
    } else {
      out.stop_sequences = [str(stop)];
    }
  }

  out.stream = stream;

  const systemBlocks: JsonObject[] = [];
  let messageBlocks: JsonObject[] = [];

  const messages = get(root, "messages");

  if (isArr(messages)) {
    const lastToolMessage = new Map<string, Json>();

    for (const message of messages) {
      if (str(get(message, "role")) === "tool") {
        const rawId = str(get(message, "tool_call_id"));

        if (rawId !== "") lastToolMessage.set(rawId, message);
      }
    }

    const emittedToolResults = new Set<string>();
    const accumulator = new ClaudeMessageAccumulator();

    for (const message of messages) {
      const role = str(get(message, "role"));
      const content = get(message, "content");

      switch (role) {
        case "system":
        case "developer": {
          const systemStart = systemBlocks.length;

          if (typeof content === "string" && !isBlankText(content)) {
            systemBlocks.push(attachCacheControl({ type: "text", text: content }, message));
          } else if (isArr(content)) {
            for (const part of content) {
              if (str(get(part, "type")) === "text") {
                const text = str(get(part, "text"));

                if (isBlankText(text)) {
                  moveBlankPartCacheControl(systemBlocks, systemStart, part);
                  continue;
                }

                systemBlocks.push(attachCacheControl({ type: "text", text }, part));
              }
            }

            if (exists(get(message, "cache_control")) && systemBlocks.length > systemStart) {
              // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
              const last = systemBlocks[systemBlocks.length - 1] as JsonObject;

              if (last.cache_control === undefined) attachCacheControl(last, message);
            }
          }

          break;
        }

        case "user":
        case "assistant": {
          const contentBlocks: JsonObject[] = [];

          if (preserveEmptyThinkingBlocks && role === "assistant") {
            const reasoningContent = get(message, "reasoning_content");

            if (typeof reasoningContent === "string" && reasoningContent.trim() !== "") {
              contentBlocks.push({ type: "thinking", thinking: reasoningContent, signature: "" });
            }
          }

          if (typeof content === "string" && !isBlankText(content)) {
            contentBlocks.push({ type: "text", text: content });
          } else if (isArr(content)) {
            for (const part of content) {
              const claudePart = convertContentPart(part);

              if (claudePart !== undefined) {
                contentBlocks.push(claudePart);
              } else {
                const partType = str(get(part, "type"));

                if (partType === "text") moveBlankPartCacheControl(contentBlocks, 0, part);
                else if (role === "user" && (partType === "file" || partType === "input_audio"))
                  drops.drop(partType);
              }
            }
          }

          if (role === "user") drops.endTurn(contentBlocks.length);

          const toolCalls = get(message, "tool_calls");

          if (isArr(toolCalls) && role === "assistant") {
            for (const toolCall of toolCalls) {
              if (str(get(toolCall, "type")) !== "function") continue;
              let toolCallId = str(get(toolCall, "id"));

              if (toolCallId === "") toolCallId = generateClaudeToolCallId();
              toolCallId = sanitizeClaudeToolId(toolCallId);
              const fn = get(toolCall, "function");

              const toolUse: JsonObject = {
                type: "tool_use",
                id: toolCallId,
                name: sanitizeClaudeFunctionName(str(get(fn, "name"))),
                input: toolInput(get(fn, "arguments")),
              };

              contentBlocks.push(toolUse);
            }
          }

          const msg: JsonObject = { role, content: contentBlocks };
          attachMessageCacheControl(msg, message);
          accumulator.append(msg);
          break;
        }

        case "tool": {
          const rawId = str(get(message, "tool_call_id"));
          const toolCallId = sanitizeClaudeToolId(rawId);

          if (rawId !== "") {
            if (emittedToolResults.has(rawId)) break;
            emittedToolResults.add(rawId);
          }

          const target = rawId !== "" ? (lastToolMessage.get(rawId) ?? message) : message;

          const msg: JsonObject = {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: toolResultContent(get(target, "content")),
              },
            ],
          };

          attachToolMessageCacheControl(msg, target);
          accumulator.append(msg);
          break;
        }
      }
    }

    messageBlocks = accumulator.messages();
  }

  const formatInstruction = buildClaudeStructuredOutputInstruction(get(root, "response_format"));

  if (formatInstruction !== "") systemBlocks.push({ type: "text", text: formatInstruction });

  if (messageBlocks.length === 0 && systemBlocks.length > 0) {
    messageBlocks.push({ role: "user", content: [{ type: "text", text: "" }] });
  }

  if (systemBlocks.length > 0) out.system = systemBlocks;

  if (messageBlocks.length > 0) out.messages = messageBlocks;

  // Tools mapping
  const allowedToolNames = new Set<string>();
  let isAllowedTools = false;
  let allowedMode = "auto";
  const toolChoice = get(root, "tool_choice");

  if (isObj(toolChoice) && str(toolChoice.type) === "allowed_tools") {
    isAllowedTools = true;
    let toolList = toArray(get(toolChoice, "allowed_tools.tools"));

    if (toolList.length === 0) toolList = toArray(get(toolChoice, "tools"));

    for (const tool of toolList) {
      let fnName = trimmed(get(tool, "function.name"));

      if (fnName === "") fnName = trimmed(get(tool, "name"));

      if (fnName !== "") {
        allowedToolNames.add(fnName);
        allowedToolNames.add(sanitizeClaudeFunctionName(fnName));
      }
    }

    let mode = trimmed(get(toolChoice, "allowed_tools.mode")).toLowerCase();

    if (mode === "") mode = trimmed(get(toolChoice, "mode")).toLowerCase();

    if (mode !== "") allowedMode = mode;
  }

  const anthropicTools: JsonObject[] = [];
  const tools = get(root, "tools");

  if (isArr(tools) && tools.length > 0) {
    for (const tool of tools) {
      if (str(get(tool, "type")) !== "function") continue;
      const fn = get(tool, "function");
      const fnName = str(get(fn, "name"));
      const sanitized = sanitizeClaudeFunctionName(fnName);

      if (isAllowedTools && !allowedToolNames.has(fnName) && !allowedToolNames.has(sanitized))
        continue;

      const anthropicTool: JsonObject = {
        name: sanitized,
        description: str(get(fn, "description")),
      };

      const parameters = get(fn, "parameters") ?? get(fn, "parametersJsonSchema");
      anthropicTool.input_schema = normalizeClaudeToolInputSchema(parameters);
      attachCacheControl(anthropicTool, tool);

      if (anthropicTool.cache_control === undefined) attachCacheControl(anthropicTool, fn);
      const strict = get(fn, "strict") ?? get(tool, "strict");

      if (strict === true) anthropicTool.strict = true;
      else if (strict === false) anthropicTool.strict = false;
      anthropicTools.push(anthropicTool);
    }

    if (anthropicTools.length > 0) out.tools = anthropicTools;
    else delete out.tools;
  }

  if (isAllowedTools) {
    if (anthropicTools.length === 0) out.tool_choice = { type: "none" };
    else if (allowedMode === "required") out.tool_choice = { type: "any" };
    else out.tool_choice = { type: "auto" };
  } else if (exists(toolChoice) && toolChoice !== null) {
    if (typeof toolChoice === "string") {
      if (toolChoice === "none") out.tool_choice = { type: "none" };
      else if (toolChoice === "auto") out.tool_choice = { type: "auto" };
      else if (toolChoice === "required") out.tool_choice = { type: "any" };
    } else if (isObj(toolChoice) || isArr(toolChoice)) {
      switch (str(get(toolChoice, "type"))) {
        case "none":
          out.tool_choice = { type: "none" };
          break;
        case "auto":
          out.tool_choice = { type: "auto" };
          break;
        case "required":
        case "any":
          out.tool_choice = { type: "any" };
          break;
        case "function": {
          let functionName = str(get(toolChoice, "function.name"));

          if (functionName === "") functionName = str(get(toolChoice, "name"));
          out.tool_choice =
            functionName !== ""
              ? { type: "tool", name: sanitizeClaudeFunctionName(functionName) }
              : { type: "none" };
        }
      }
    }
  }

  if (get(root, "parallel_tool_calls") === false) {
    const choice = out.tool_choice;

    if (choice !== undefined) {
      if (str(get(choice, "type")) !== "none")
        // SAFETY: every `out.tool_choice` assignment above stores an object literal like { type: "auto" }.
        (choice as JsonObject).disable_parallel_tool_use = true;
    } else if (out.tools !== undefined) {
      out.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
  }

  const result =
    applyTranslatedSummaryToClaude(out, root, "openai", modelName, lookupModelInfo) ?? out;

  const refusal = drops.err(result);

  if (refusal !== undefined) throw refusal;

  return result;
};

const toolInput = (args: Json | undefined): Json => {
  if (!exists(args)) return {};
  const text = str(args);

  if (text === "") return {};

  try {
    // SAFETY: JSON.parse can only produce JSON values, which is exactly what Json models.
    const parsed = JSON.parse(text) as Json;

    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const convertContentPartRaw = (part: Json | undefined): JsonObject | undefined => {
  switch (str(get(part, "type"))) {
    case "text": {
      const text = str(get(part, "text"));

      return isBlankText(text) ? undefined : { type: "text", text };
    }

    case "image_url":
      return convertImageURL(str(get(part, "image_url.url")));
    case "file": {
      const fileData = str(get(part, "file.file_data"));

      if (fileData.startsWith("data:")) {
        const semicolon = fileData.indexOf(";");
        const comma = fileData.indexOf(",");

        if (semicolon !== -1 && comma !== -1 && comma > semicolon) {
          const mediaType = fileData.slice(0, semicolon).replace(/^data:/u, "");

          return {
            type: "document",
            source: { type: "base64", media_type: mediaType, data: fileData.slice(comma + 1) },
          };
        }
      }
    }
  }

  return undefined;
};

const convertContentPart = (part: Json | undefined): JsonObject | undefined => {
  const claudePart = convertContentPartRaw(part);

  return claudePart === undefined ? undefined : attachCacheControl(claudePart, part);
};

const convertImageURL = (imageURL: string): JsonObject | undefined => {
  if (imageURL === "") return undefined;

  if (imageURL.startsWith("data:")) {
    const comma = imageURL.indexOf(",");

    if (comma === -1) return undefined;
    const head = imageURL.slice(0, comma);
    let mediaType = head.split(";", 1)[0]?.replace(/^data:/u, "") ?? "";

    if (mediaType === "") mediaType = "application/octet-stream";

    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: imageURL.slice(comma + 1) },
    };
  }

  return { type: "image", source: { type: "url", url: imageURL } };
};

/** `convertOpenAIToolResultContent`: a string, or an array of Claude parts. */
const toolResultContent = (content: Json | undefined): Json => {
  if (!exists(content)) return "";

  if (typeof content === "string") return content;

  if (isArr(content)) {
    const parts: JsonObject[] = [];
    let droppedBlankText = false;

    for (const part of content) {
      if (typeof part === "string") {
        if (isBlankText(part)) droppedBlankText = true;
        else parts.push({ type: "text", text: part });
        continue;
      }

      const claudePart = convertContentPartRaw(part);

      if (claudePart !== undefined) parts.push(claudePart);
      else if (str(get(part, "type")) === "text") droppedBlankText = true;
    }

    if (parts.length > 0 || content.length === 0) return parts;

    if (droppedBlankText) return "";

    return JSON.stringify(content);
  }

  if (isObj(content)) {
    const claudePart = convertContentPartRaw(content);

    return claudePart !== undefined ? [claudePart] : JSON.stringify(content);
  }

  return JSON.stringify(content);
};

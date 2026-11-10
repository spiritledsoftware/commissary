/**
 * Claude Messages client -> Gemini provider: request conversion.
 *
 * Go source: internal/translator/gemini/claude/gemini_claude_request.go (ConvertClaudeRequestToGemini,
 * ConvertClaudeRequestToGeminiWithCompat).
 */
import {
  asString,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import {
  mergeAdjacentGeminiContents,
  reorderGeminiUserParts,
  setGeminiFunctionResponseResult,
} from "../common/contents.ts";
import { countSendableGeminiParts, UserTurnDrops } from "../../common/parts.ts";
import { attachDefaultSafetySettings } from "../common/safety.ts";
import { geminiReplaySignatureOrBypass } from "../common/signature.ts";
import {
  alignClaudeToolResults,
  claudeMessageSystemReminderText,
  isClaudeCodeAttributionSystemText,
} from "../../common/claude-messages.ts";
import { convertClaudeToolResultContent, sanitizeFunctionName } from "../util/claude.ts";
import { cleanJsonSchemaForGeminiJsonSchema } from "../util/json-schema.ts";
import { lookupModelInfo } from "../../model-info.ts";

const GEMINI_CLAUDE_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const textPart = (text: string): JsonObject => ({ text });

const geminiContentWithParts = (role: string, parts: Json[]): JsonObject => ({ role, parts });

const inlinePart = (mimeType: string, data: string): JsonObject => ({
  inline_data: { mime_type: mimeType, data },
});

const claudeBase64InlineData = (source: Json | undefined): JsonObject | undefined => {
  if (asString(get(source, "type")) !== "base64") return undefined;
  const mimeType = asString(get(source, "media_type"));
  const data = asString(get(source, "data"));

  return mimeType === "" || data === "" ? undefined : inlinePart(mimeType, data);
};

const toolNameFromClaudeToolUseId = (toolUseId: string): string => {
  const parts = toolUseId.split("-");

  return parts.length <= 1 ? "" : parts.slice(0, -1).join("-");
};

const isNumber = (value: Json | undefined): value is number => typeof value === "number";

const convert = (modelName: string, request: Json, preserveEmptyThinkingBlocks: boolean): Json => {
  const drops = new UserTurnDrops();
  const out: JsonObject = { contents: [], model: modelName };

  // system instruction
  const system = get(request, "system");

  if (isJsonArray(system)) {
    const systemParts: Json[] = [];

    for (const item of system) {
      if (asString(get(item, "type")) !== "text") continue;
      const text = get(item, "text");

      if (typeof text !== "string" || isClaudeCodeAttributionSystemText(text)) continue;
      systemParts.push(textPart(text));
    }

    if (systemParts.length > 0) out["systemInstruction"] = { role: "user", parts: systemParts };
  } else if (typeof system === "string" && !isClaudeCodeAttributionSystemText(system)) {
    out["systemInstruction"] = { parts: [textPart(system)] };
  }

  // contents
  const messages = get(request, "messages");

  if (isJsonArray(messages)) {
    const contentItems: Json[] = [];
    const toolNameById = new Map<string, string>();
    let pendingToolUseIds: string[] = [];

    for (const message of messages) {
      const roleValue = get(message, "role");

      if (typeof roleValue !== "string") continue;
      const originalRole = roleValue;
      let precedingToolUseIds: string[] = [];

      if (originalRole !== "system" && originalRole !== "developer") {
        precedingToolUseIds = pendingToolUseIds;
        pendingToolUseIds = [];
      }

      let role = originalRole;

      if (role === "assistant") role = "model";
      else if (role === "system" || role === "developer") role = "user";

      const partItems: Json[] = [];
      let content = get(message, "content");

      if (originalRole === "system" || originalRole === "developer") {
        const reminder = claudeMessageSystemReminderText(content);

        if (reminder !== undefined) {
          partItems.push(textPart(reminder));
          contentItems.push(geminiContentWithParts(role, partItems));
        }

        continue;
      }

      if (isJsonArray(content)) {
        if (originalRole === "user") content = alignClaudeToolResults(content, precedingToolUseIds);

        for (const block of content) {
          switch (asString(get(block, "type"))) {
            case "text": {
              const text = asString(get(block, "text"));

              if (text === "") break;
              partItems.push(textPart(text));
              break;
            }

            case "thinking": {
              if (!preserveEmptyThinkingBlocks) break;
              partItems.push({
                text: asString(get(block, "thinking")),
                thought: true,
                thoughtSignature: geminiReplaySignatureOrBypass(asString(get(block, "signature"))),
              });
              break;
            }

            case "tool_use": {
              let functionName = asString(get(block, "name"));
              const toolUseId = asString(get(block, "id"));

              if (toolUseId !== "" && functionName !== "")
                toolNameById.set(toolUseId, functionName);
              functionName = sanitizeFunctionName(functionName);
              // `input.String()` of a string value is the text itself, which is accepted when it is a JSON object.
              const rawInput = get(block, "input");
              const input = typeof rawInput === "string" ? tryParseJson(rawInput) : rawInput;

              if (isJsonObject(input)) {
                const functionCall: JsonObject = { name: functionName, args: input };

                if (toolUseId !== "") functionCall["id"] = toolUseId;
                partItems.push({ thoughtSignature: GEMINI_CLAUDE_THOUGHT_SIGNATURE, functionCall });

                if (originalRole === "assistant") pendingToolUseIds.push(toolUseId);
              }

              break;
            }

            case "tool_result": {
              const toolCallId = asString(get(block, "tool_use_id"));

              if (toolCallId === "") break;
              let funcName = toolNameById.get(toolCallId) ?? "";

              if (funcName === "") funcName = toolNameFromClaudeToolUseId(toolCallId);

              if (funcName === "") funcName = toolCallId;
              funcName = sanitizeFunctionName(funcName);
              const toolResult = convertClaudeToolResultContent(get(block, "content"));

              const part: JsonObject = {
                functionResponse: { name: "", response: { result: "" }, id: toolCallId },
              };

              // SAFETY: `part` was built just above with `functionResponse` set to an object literal.
              (part["functionResponse"] as JsonObject)["name"] = funcName;

              if (toolResult.resultIsRaw) {
                setGeminiFunctionResponseResult(
                  part,
                  "functionResponse.response.result",
                  toolResult.result,
                );
              } else {
                // SAFETY: `part.functionResponse.response` is the `{ result: "" }` object literal built above.
                ((part["functionResponse"] as JsonObject)["response"] as JsonObject)["result"] =
                  toolResult.result;
              }

              partItems.push(part);

              for (const image of toolResult.images)
                partItems.push(inlinePart(image.mimeType, image.data));
              break;
            }

            case "image":
            case "document":
            case "container_upload": {
              const part = claudeBase64InlineData(get(block, "source"));

              if (part !== undefined) partItems.push(part);
              else if (originalRole === "user") drops.drop(asString(get(block, "type")));
              break;
            }

            default:
              break;
          }
        }

        const parts = role === "user" ? reorderGeminiUserParts(partItems) : partItems;

        if (originalRole === "user") drops.endTurn(countSendableGeminiParts(parts));

        if (parts.length > 0) contentItems.push(geminiContentWithParts(role, parts));
      } else if (typeof content === "string") {
        contentItems.push(geminiContentWithParts(role, [textPart(content)]));
      }
    }

    // Strip a trailing model turn with unanswered function calls.
    const last = contentItems[contentItems.length - 1];

    if (last !== undefined && asString(get(last, "role")) === "model") {
      const parts = get(last, "parts");

      if (isJsonArray(parts) && parts.some((part) => exists(part, "functionCall")))
        contentItems.pop();
    }

    out["contents"] = mergeAdjacentGeminiContents(contentItems);
  }

  // tools
  const toolItems: Json[] = [];
  let hasStrictTool = false;
  const tools = get(request, "tools");

  if (isJsonArray(tools)) {
    for (const tool of tools) {
      if (get(tool, "strict") === true) hasStrictTool = true;
      const inputSchema = get(tool, "input_schema");

      if (!isJsonObject(inputSchema) || !isJsonObject(tool)) continue;
      const copy: JsonObject = { ...tool };
      delete copy["input_schema"];
      copy["parametersJsonSchema"] = cleanJsonSchemaForGeminiJsonSchema(inputSchema);

      for (const key of [
        "strict",
        "input_examples",
        "type",
        "cache_control",
        "defer_loading",
        "eager_input_streaming",
      ]) {
        delete copy[key];
      }

      const originalName = asString(get(tool, "name"));
      const sanitizedName = sanitizeFunctionName(originalName);

      if (typeof get(tool, "name") !== "string" || sanitizedName !== originalName)
        copy["name"] = sanitizedName;
      toolItems.push(copy);
    }

    if (toolItems.length > 0) out["tools"] = [{ functionDeclarations: toolItems }];
  }

  // tool_choice
  const toolChoice = get(request, "tool_choice");
  const callingConfig: JsonObject = {};

  if (toolChoice !== undefined && toolChoice !== null) {
    let type = "";
    let name = "";

    if (isJsonObject(toolChoice)) {
      type = asString(toolChoice["type"]);
      name = asString(toolChoice["name"]);
    } else if (typeof toolChoice === "string") {
      type = toolChoice;
    }

    switch (type) {
      case "auto":
        callingConfig["mode"] = hasStrictTool ? "VALIDATED" : "AUTO";
        break;
      case "none":
        callingConfig["mode"] = "NONE";
        break;
      case "any":
        callingConfig["mode"] = "ANY";
        break;
      case "tool":
        callingConfig["mode"] = "ANY";

        if (name !== "") callingConfig["allowedFunctionNames"] = [sanitizeFunctionName(name)];
        break;
      default:
        break;
    }
  } else if (hasStrictTool && toolItems.length > 0) {
    callingConfig["mode"] = "VALIDATED";
  }

  if (Object.keys(callingConfig).length > 0)
    out["toolConfig"] = { functionCallingConfig: callingConfig };

  // Anthropic thinking -> Gemini thinking config (ApplyThinking validates against model capabilities).
  const generationConfig: JsonObject = {};
  const thinkingConfig: JsonObject = {};
  const thinking = get(request, "thinking");

  if (isJsonObject(thinking)) {
    switch (asString(thinking["type"])) {
      case "enabled": {
        const budget = thinking["budget_tokens"];

        if (isNumber(budget)) thinkingConfig["thinkingBudget"] = Math.trunc(budget);
        break;
      }

      case "adaptive":
      case "auto": {
        const effortValue = get(request, "output_config.effort");
        const effort = typeof effortValue === "string" ? effortValue.trim().toLowerCase() : "";

        if (effort !== "") {
          thinkingConfig["thinkingLevel"] = effort;
        } else {
          const maxBudget = lookupModelInfo(modelName, "gemini")?.thinking?.max ?? 0;

          if (maxBudget > 0) thinkingConfig["thinkingBudget"] = maxBudget;
          else thinkingConfig["thinkingLevel"] = "high";
        }

        break;
      }

      default:
        break;
    }
  }

  if (Object.keys(thinkingConfig).length > 0) generationConfig["thinkingConfig"] = thinkingConfig;
  const temperature = get(request, "temperature");

  if (isNumber(temperature)) generationConfig["temperature"] = temperature;
  const topP = get(request, "top_p");

  if (isNumber(topP)) generationConfig["topP"] = topP;
  const topK = get(request, "top_k");

  if (isNumber(topK)) generationConfig["topK"] = topK;

  if (Object.keys(generationConfig).length > 0) out["generationConfig"] = generationConfig;

  const result = attachDefaultSafetySettings(out, "safetySettings");
  const error = drops.err(result);

  if (error !== undefined) throw error;

  return result;
};

/** `ConvertClaudeRequestToGemini`. */
export const convertClaudeRequestToGemini = (model: string, body: Json, _stream: boolean): Json =>
  convert(model, body, false);

/** `ConvertClaudeRequestToGeminiWithCompat`: keeps assistant thinking blocks for compatibility endpoints. */
export const convertClaudeRequestToGeminiWithCompat = (
  model: string,
  body: Json,
  _stream: boolean,
): Json => convert(model, body, true);

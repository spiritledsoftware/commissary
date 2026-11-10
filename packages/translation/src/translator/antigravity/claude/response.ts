/**
 * Antigravity provider -> Claude Messages client (response).
 *
 * Go source: internal/translator/antigravity/claude/antigravity_claude_response.go. Thinking signatures are cached for
 * later turns (`signature/cache.ts`); Gemini signatures travel as carrier envelopes (`carrier.ts`). Tool arguments are
 * cleaned against the client's schemas (202b8b8c, e1fb2521, `../../common/claude-tool-args.ts`); safety and filter
 * finishReasons end as a refusal (24b04548).
 */
import {
  asBool,
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { bytesToBinaryString, decodeBase64Std } from "../../../signature/base64.ts";
import { cacheSignature, getModelGroup } from "../../../signature/cache.ts";
import { signatureProviderFromModelName } from "../../../signature/provider.ts";
import { sseEventLines, claudeInputTokensJson } from "../../common/bytes.ts";
import {
  claudeToolIsParameterless,
  cleanClaudeToolArgumentsWithTranslated,
} from "../../common/claude-tool-args.ts";
import { geminiClaudeToolUseID } from "../../common/claude-util.ts";
import { sanitizeClaudeToolId } from "../../common/tool-names.ts";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import {
  disambiguatedToolNameMap,
  type NameMap,
  restoreSanitizedToolName,
} from "../../common/tool-names.ts";
import { CarrierDirection, CarrierKind, encodeGeminiClaudeCarrierSignature } from "./carrier.ts";
import {
  antigravityGroundingMetadata,
  antigravityTextContent,
  appendClaudeWebSearchStreamBlocks,
  appendWebSearchBufferedText,
  buildClaudeWebSearchContent,
  newClaudeWebSearchToolUseId,
  shouldTranslateWebSearchGrounding,
} from "./web-search.ts";

/** `decodeSignature`: `R...` (two base64 layers) to `E...` (Anthropic format); `""` when undecodable. */
const decodeSignature = (signature: string): string => {
  if (signature === "") return signature;

  if (signature.startsWith("R")) {
    const decoded = decodeBase64Std(signature);

    return decoded === undefined ? "" : bytesToBinaryString(decoded);
  }

  return signature;
};

/** `formatClaudeSignatureValue`: provider-native opaque values without CPA cache prefixes. */
const formatClaudeSignatureValue = (modelName: string, signature: string): string =>
  getModelGroup(modelName) === "claude" ? decodeSignature(signature) : signature;

/** `formatGeminiClaudeCarrierValue`. */
const formatCarrierValue = (
  modelName: string,
  signature: string,
  direction: string,
  targetKind: string,
): string =>
  signatureProviderFromModelName(modelName) === "gemini"
    ? encodeGeminiClaudeCarrierSignature(signature, direction, targetKind)
    : formatClaudeSignatureValue(modelName, signature);

interface Params {
  hasFirstResponse: boolean;
  /** 0=none, 1=content, 2=thinking, 3=function. */
  responseType: number;
  responseIndex: number;
  hasFinishReason: boolean;
  finishReason: string;
  hasUsageMetadata: boolean;
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  totalTokenCount: number;
  cachedTokenCount: number;
  hasSentFinalEvents: boolean;
  hasToolUse: boolean;
  hasContent: boolean;
  hasSemanticContent: boolean;
  lastSemanticKind: string;
  hasWebSearchTool: boolean;
  webSearchRequests: number;
  webSearchTextBuffer: string;
  currentThinkingText: string;
  currentThinkingSigned: boolean;
  toolNameMap: NameMap;
  /** Client-facing name of the open tool_use block. */
  currentToolName: string;
  /** Whether the open tool_use block was declared parameterless. */
  currentToolIsParameterless: boolean;
  /** Whether cleaned input JSON was already emitted for the open tool_use block. */
  currentToolInputEmitted: boolean;
  /** Whether an empty `{}` input_json_delta is deferred until the tool_use block completes. */
  currentToolPendingEmpty: boolean;
}

let toolUseIdCounter = 0;

/** `antigravityClaudeToolUseID`. */
const claudeToolUseId = (modelName: string, functionCall: Json, fallback: string): string => {
  if (signatureProviderFromModelName(modelName) === "gemini") {
    const args = get(functionCall, "args");

    const stable = geminiClaudeToolUseID(
      asString(get(functionCall, "id")),
      asString(get(functionCall, "name")),
      args === undefined ? "" : JSON.stringify(args),
    );

    if (stable !== "") return stable;
  }

  return sanitizeClaudeToolId(fallback);
};

/** `resolveAntigravityClaudeStopReason`: safety, filter and malformed finishReasons end as a refusal. */
const resolveStopReason = (finishReason: string, hasToolUse: boolean): string => {
  if (hasToolUse) return "tool_use";

  switch (finishReason.trim().toUpperCase()) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "BLOCKLIST":
    case "IMAGE_SAFETY":
    case "MALFORMED_RESPONSE":
    case "MALFORMED_FUNCTION_CALL":
      return "refusal";
    default:
      return "end_turn";
  }
};

const stop = (index: number): string => `{"type":"content_block_stop","index":${index}}`;

const deltaEvent = (index: number, delta: JsonObject): string =>
  JSON.stringify({ type: "content_block_delta", index, delta });

/** `appendFinalEvents`. */
const appendFinalEvents = (params: Params, force: boolean): string => {
  if (params.hasSentFinalEvents) return "";

  if (!params.hasUsageMetadata && !force) return "";

  if (!params.hasContent) return "";
  let output = "";

  if (
    params.responseType === 3 &&
    params.currentToolPendingEmpty &&
    !params.currentToolInputEmitted
  ) {
    output += sseEventLines(
      "content_block_delta",
      deltaEvent(params.responseIndex, { type: "input_json_delta", partial_json: "{}" }),
      3,
    );
    params.currentToolInputEmitted = true;
    params.currentToolPendingEmpty = false;
  }

  if (params.responseType !== 0) {
    output += sseEventLines("content_block_stop", stop(params.responseIndex), 3);
    params.responseType = 0;
  }

  let usageOutputTokens = params.candidatesTokenCount + params.thoughtsTokenCount;

  if (usageOutputTokens === 0 && params.totalTokenCount > 0) {
    // promptTokenCount excludes the cache for input_tokens while totalTokenCount includes it: add it back (912a038b).
    usageOutputTokens = Math.max(
      params.totalTokenCount - (params.promptTokenCount + params.cachedTokenCount),
      0,
    );
  }

  const usage: JsonObject = {
    input_tokens: params.promptTokenCount,
    output_tokens: usageOutputTokens,
  };

  const delta: JsonObject = {
    type: "message_delta",
    delta: {
      stop_reason: resolveStopReason(params.finishReason, params.hasToolUse),
      stop_sequence: null,
    },
    usage,
  };

  if (params.webSearchRequests > 0)
    usage["server_tool_use"] = { web_search_requests: params.webSearchRequests };

  if (params.cachedTokenCount > 0) usage["cache_read_input_tokens"] = params.cachedTokenCount;
  output += sseEventLines("message_delta", JSON.stringify(delta), 3);
  params.hasSentFinalEvents = true;

  return output;
};

const paramsOf = (context: ResponseContext): Params => {
  if (context.state.value === undefined) {
    const fresh: Params = {
      hasFirstResponse: false,
      responseType: 0,
      responseIndex: 0,
      hasFinishReason: false,
      finishReason: "",
      hasUsageMetadata: false,
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
      cachedTokenCount: 0,
      hasSentFinalEvents: false,
      hasToolUse: false,
      hasContent: false,
      hasSemanticContent: false,
      lastSemanticKind: "",
      hasWebSearchTool: false,
      webSearchRequests: 0,
      webSearchTextBuffer: "",
      currentThinkingText: "",
      currentThinkingSigned: false,
      toolNameMap: disambiguatedToolNameMap(context.originalRequest),
      currentToolName: "",
      currentToolIsParameterless: false,
      currentToolInputEmitted: false,
      currentToolPendingEmpty: false,
    };

    context.state.value = fresh;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  return context.state.value as Params;
};

/** `ConvertAntigravityResponseToClaude`. */
export const convertAntigravityResponseToClaude = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const params = paramsOf(context);
  const modelName = asString(get(context.translatedRequest, "model"));

  if (line === "[DONE]") {
    let output = "";

    if (params.hasFirstResponse && !params.hasContent) {
      output += sseEventLines(
        "content_block_start",
        `{"type":"content_block_start","index":${params.responseIndex},"content_block":{"type":"text","text":""}}`,
        3,
      );
      params.responseType = 1;
      params.hasContent = true;
    }

    if (params.hasContent) {
      output += appendFinalEvents(params, true);
      output += sseEventLines("message_stop", `{"type":"message_stop"}`, 3);

      return [output];
    }

    return [];
  }

  const raw = tryParseJson(line);
  let output = "";

  const appendEvent = (event: string, payload: string): void => {
    output += sseEventLines(event, payload, 3);
  };

  const webSearchStreamMode = shouldTranslateWebSearchGrounding(
    context.originalRequest,
    context.translatedRequest,
  );

  const appendThinkingSignature = (
    signature: string,
    direction: string,
    targetKind: string,
  ): void => {
    if (signature === "" || params.responseType !== 2) return;

    if (params.currentThinkingText.length > 0) {
      cacheSignature(modelName, params.currentThinkingText, signature);
      params.currentThinkingText = "";
    }

    appendEvent(
      "content_block_delta",
      deltaEvent(params.responseIndex, {
        type: "signature_delta",
        signature: formatCarrierValue(modelName, signature, direction, targetKind),
      }),
    );
    params.currentThinkingSigned = true;
    params.hasContent = true;
  };

  /** Emits the deferred empty `{}` input once the tool_use block completes without other input (e1fb2521). */
  const flushPendingToolInput = (): void => {
    if (
      params.responseType === 3 &&
      params.currentToolPendingEmpty &&
      !params.currentToolInputEmitted
    ) {
      appendEvent(
        "content_block_delta",
        deltaEvent(params.responseIndex, { type: "input_json_delta", partial_json: "{}" }),
      );
      params.currentToolInputEmitted = true;
      params.currentToolPendingEmpty = false;
    }
  };

  const closeCurrentBlock = (): void => {
    if (params.responseType === 0) return;
    flushPendingToolInput();
    appendEvent("content_block_stop", stop(params.responseIndex));
    params.responseIndex++;
    params.responseType = 0;
    params.currentThinkingSigned = false;
  };

  const startEmptyThinkingBlock = (): void => {
    appendEvent(
      "content_block_start",
      `{"type":"content_block_start","index":${params.responseIndex},"content_block":{"type":"thinking","thinking":""}}`,
    );
    params.responseType = 2;
    params.currentThinkingSigned = false;
    params.hasContent = true;
  };

  const appendCarrierSignature = (
    signature: string,
    direction: string,
    targetKind: string,
  ): void => {
    if (signature === "" || params.responseType !== 2) return;
    appendEvent(
      "content_block_delta",
      deltaEvent(params.responseIndex, {
        type: "signature_delta",
        signature: formatCarrierValue(modelName, signature, direction, targetKind),
      }),
    );
    params.currentThinkingSigned = true;
    params.hasContent = true;
  };

  const appendPartSignature = (
    signature: string,
    direction: string,
    targetKind: string,
  ): boolean => {
    if (signature === "") return false;

    if (params.responseType === 2 && !params.currentThinkingSigned) {
      appendThinkingSignature(signature, direction, targetKind);

      return false;
    }

    if (direction === CarrierDirection.Previous && targetKind === CarrierKind.Text) {
      cacheSignature(modelName, "", signature);

      return false;
    }

    closeCurrentBlock();
    startEmptyThinkingBlock();
    appendCarrierSignature(signature, direction, targetKind);

    return true;
  };

  if (!params.hasFirstResponse) {
    const message: JsonObject = {
      id: "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };

    const promptTokens = get(raw, "response.cpaUsageMetadata.promptTokenCount");

    if (promptTokens !== undefined) set(message, "usage.input_tokens", asInt(promptTokens));
    const candidateTokens = get(raw, "response.cpaUsageMetadata.candidatesTokenCount");

    if (candidateTokens !== undefined && !webSearchStreamMode)
      set(message, "usage.output_tokens", asInt(candidateTokens));
    const modelVersion = get(raw, "response.modelVersion");

    if (modelVersion !== undefined) message["model"] = asString(modelVersion);
    const responseId = get(raw, "response.responseId");

    if (responseId !== undefined) message["id"] = asString(responseId);
    appendEvent("message_start", JSON.stringify({ type: "message_start", message }));
    params.hasFirstResponse = true;
  }

  let handledWebSearchGrounding = false;

  if (webSearchStreamMode && !params.hasWebSearchTool) {
    const grounding = antigravityGroundingMetadata(raw);

    if (grounding !== undefined) {
      const toolUseId = newClaudeWebSearchToolUseId();
      const textContent = params.webSearchTextBuffer + antigravityTextContent(raw);
      params.webSearchTextBuffer = "";
      params.responseIndex = appendClaudeWebSearchStreamBlocks(
        appendEvent,
        params.responseIndex,
        toolUseId,
        textContent,
        grounding,
      );
      params.hasWebSearchTool = true;
      params.webSearchRequests = 1;
      params.hasContent = true;
      params.responseType = 0;
      handledWebSearchGrounding = true;
    }
  }

  const parts = get(raw, "response.candidates.0.content.parts");

  if (
    isJsonArray(parts) &&
    webSearchStreamMode &&
    !params.hasWebSearchTool &&
    !handledWebSearchGrounding
  ) {
    params.webSearchTextBuffer += appendWebSearchBufferedText(parts);
  } else if (isJsonArray(parts) && !handledWebSearchGrounding) {
    for (const part of parts) {
      const text = get(part, "text");
      const functionCall = get(part, "functionCall");

      const thoughtSignatureResult =
        get(part, "thoughtSignature") ?? get(part, "thought_signature");

      const thoughtSignature = asString(thoughtSignatureResult);

      const hasThoughtSignature =
        thoughtSignatureResult !== undefined &&
        thoughtSignature !== "" &&
        functionCall === undefined;

      if (hasThoughtSignature && (text === undefined || asString(text) === "")) {
        let direction: string = CarrierDirection.Next;
        let targetKind: string = CarrierKind.Any;

        if (params.hasSemanticContent) {
          direction = CarrierDirection.Previous;
          targetKind = params.lastSemanticKind;
        }

        appendPartSignature(thoughtSignature, direction, targetKind);
        continue;
      }

      if (text !== undefined) {
        const partText = asString(text);

        if (asBool(get(part, "thought"))) {
          if (partText !== "") {
            params.hasSemanticContent = true;
            params.lastSemanticKind = CarrierKind.Text;

            if (params.responseType === 2 && params.currentThinkingSigned) closeCurrentBlock();

            if (params.responseType === 2) {
              params.currentThinkingText += partText;
              appendEvent(
                "content_block_delta",
                deltaEvent(params.responseIndex, { type: "thinking_delta", thinking: partText }),
              );
              params.hasContent = true;
            } else {
              if (params.responseType !== 0) {
                flushPendingToolInput();
                appendEvent("content_block_stop", stop(params.responseIndex));
                params.responseIndex++;
              }

              appendEvent(
                "content_block_start",
                `{"type":"content_block_start","index":${params.responseIndex},"content_block":{"type":"thinking","thinking":""}}`,
              );
              params.currentThinkingSigned = false;
              appendEvent(
                "content_block_delta",
                deltaEvent(params.responseIndex, { type: "thinking_delta", thinking: partText }),
              );
              params.responseType = 2;
              params.hasContent = true;
              params.currentThinkingText = partText;
            }
          }

          if (hasThoughtSignature)
            appendThinkingSignature(
              thoughtSignature,
              CarrierDirection.Standalone,
              CarrierKind.Text,
            );
        } else {
          let signatureTargetsVisibleText = false;

          if (hasThoughtSignature) {
            signatureTargetsVisibleText = appendPartSignature(
              thoughtSignature,
              CarrierDirection.Next,
              CarrierKind.Text,
            );
          }

          if (params.responseType === 1) {
            appendEvent(
              "content_block_delta",
              deltaEvent(params.responseIndex, { type: "text_delta", text: partText }),
            );
            params.hasContent = true;
          } else if (partText !== "") {
            if (params.responseType !== 0) {
              flushPendingToolInput();
              appendEvent("content_block_stop", stop(params.responseIndex));
              params.responseIndex++;
            }

            appendEvent(
              "content_block_start",
              `{"type":"content_block_start","index":${params.responseIndex},"content_block":{"type":"text","text":""}}`,
            );
            appendEvent(
              "content_block_delta",
              deltaEvent(params.responseIndex, { type: "text_delta", text: partText }),
            );
            params.responseType = 1;
            params.hasContent = true;
          }

          if (partText !== "") {
            params.hasSemanticContent = true;
            params.lastSemanticKind = CarrierKind.Text;

            if (signatureTargetsVisibleText) closeCurrentBlock();
          }
        }
      } else if (functionCall !== undefined) {
        const toolSignature = thoughtSignature;

        if (getModelGroup(modelName) !== "claude")
          appendPartSignature(toolSignature, CarrierDirection.Next, CarrierKind.Function);
        params.hasToolUse = true;

        const fcName = restoreSanitizedToolName(
          params.toolNameMap,
          asString(get(functionCall, "name")),
        );

        const cleaned = (toolName: string): string =>
          cleanClaudeToolArgumentsWithTranslated(
            JSON.stringify(get(functionCall, "args")),
            toolName,
            context.originalRequest,
            context.translatedRequest,
          );

        const args = get(functionCall, "args");

        // A continuation part (no name) extends the open tool_use block instead of starting a new one.
        if (params.responseType === 3 && fcName === "" && params.currentToolName !== "") {
          if (args !== undefined) {
            let partialJson = cleaned(params.currentToolName);

            if (params.currentToolIsParameterless) {
              if (params.currentToolInputEmitted) {
                partialJson = "";
              } else {
                params.currentToolInputEmitted = true;
                params.currentToolPendingEmpty = false;
              }
            } else if (partialJson === "{}") {
              if (!params.currentToolInputEmitted) params.currentToolPendingEmpty = true;
              partialJson = "";
            } else if (partialJson !== "") {
              params.currentToolInputEmitted = true;
              params.currentToolPendingEmpty = false;
            }

            if (partialJson !== "" || !params.currentToolPendingEmpty) {
              appendEvent(
                "content_block_delta",
                deltaEvent(params.responseIndex, {
                  type: "input_json_delta",
                  partial_json: partialJson,
                }),
              );
            }
          }

          params.hasContent = true;
          params.hasSemanticContent = true;
          params.lastSemanticKind = CarrierKind.Function;
          continue;
        }

        // Close an existing function call block first, then any other block.
        if (params.responseType === 3) {
          flushPendingToolInput();
          appendEvent("content_block_stop", stop(params.responseIndex));
          params.responseIndex++;
          params.responseType = 0;
        }

        if (params.responseType !== 0) {
          flushPendingToolInput();
          appendEvent("content_block_stop", stop(params.responseIndex));
          params.responseIndex++;
        }

        params.currentToolName = fcName;
        params.currentToolIsParameterless = claudeToolIsParameterless(
          fcName,
          context.originalRequest,
        );
        params.currentToolInputEmitted = false;
        params.currentToolPendingEmpty = false;
        toolUseIdCounter++;
        const fallbackId = `${fcName}-${Date.now()}000000-${toolUseIdCounter}`;

        const contentBlock: JsonObject = {
          type: "tool_use",
          id: claudeToolUseId(modelName, functionCall, fallbackId),
          name: fcName,
          input: {},
        };

        if (getModelGroup(modelName) === "claude" && toolSignature !== "") {
          contentBlock["signature"] = formatClaudeSignatureValue(modelName, toolSignature);
        }

        appendEvent(
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: params.responseIndex,
            content_block: contentBlock,
          }),
        );

        if (args !== undefined) {
          let partialJson = cleaned(fcName);

          if (params.currentToolIsParameterless) {
            if (params.currentToolInputEmitted) partialJson = "";
            else params.currentToolInputEmitted = true;
          } else if (partialJson === "{}") {
            params.currentToolPendingEmpty = true;
            partialJson = "";
          } else if (partialJson !== "") {
            params.currentToolInputEmitted = true;
          }

          if (partialJson !== "" || !params.currentToolPendingEmpty) {
            appendEvent(
              "content_block_delta",
              deltaEvent(params.responseIndex, {
                type: "input_json_delta",
                partial_json: partialJson,
              }),
            );
          }
        }

        params.responseType = 3;
        params.hasContent = true;
        params.hasSemanticContent = true;
        params.lastSemanticKind = CarrierKind.Function;
      }
    }
  }

  const finishReason = get(raw, "response.candidates.0.finishReason");

  if (finishReason !== undefined) {
    // A trailing chunk with an empty finishReason keeps the one already recorded (24b04548).
    params.hasFinishReason = true;
    const trimmed = asString(finishReason).trim();

    if (trimmed !== "") {
      params.finishReason = trimmed;
      flushPendingToolInput();
    }
  }

  const usage = get(raw, "response.usageMetadata");

  if (usage !== undefined) {
    params.hasUsageMetadata = true;
    const rawPromptTokenCount = asInt(get(usage, "promptTokenCount"));
    params.cachedTokenCount = asInt(get(usage, "cachedContentTokenCount"));
    params.promptTokenCount = Math.max(rawPromptTokenCount - params.cachedTokenCount, 0);
    params.candidatesTokenCount = asInt(get(usage, "candidatesTokenCount"));
    params.thoughtsTokenCount = asInt(get(usage, "thoughtsTokenCount"));
    params.totalTokenCount = asInt(get(usage, "totalTokenCount"));

    if (params.candidatesTokenCount === 0 && params.totalTokenCount > 0) {
      // totalTokenCount includes the cached part of promptTokenCount: use the raw prompt count (912a038b).
      params.candidatesTokenCount = Math.max(
        params.totalTokenCount - rawPromptTokenCount - params.thoughtsTokenCount,
        0,
      );
    }
  }

  if (
    webSearchStreamMode &&
    !params.hasWebSearchTool &&
    params.hasFinishReason &&
    params.webSearchTextBuffer.length > 0
  ) {
    const text = params.webSearchTextBuffer;
    params.webSearchTextBuffer = "";

    if (text !== "") {
      appendEvent(
        "content_block_start",
        `{"type":"content_block_start","index":${params.responseIndex},"content_block":{"type":"text","text":""}}`,
      );
      appendEvent(
        "content_block_delta",
        deltaEvent(params.responseIndex, { type: "text_delta", text }),
      );
      params.responseType = 1;
      params.hasContent = true;
    }
  }

  if (params.hasUsageMetadata && params.hasFinishReason) output += appendFinalEvents(params, false);

  return [output];
};

/** `ConvertAntigravityResponseToClaudeNonStream`. */
export const convertAntigravityResponseToClaudeNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const toolNameMap = disambiguatedToolNameMap(context.originalRequest);
  const modelName = asString(get(context.translatedRequest, "model"));
  const root = tryParseJson(body);

  const promptTokens = asInt(get(root, "response.usageMetadata.promptTokenCount"));
  const candidateTokens = asInt(get(root, "response.usageMetadata.candidatesTokenCount"));
  const thoughtTokens = asInt(get(root, "response.usageMetadata.thoughtsTokenCount"));
  const totalTokens = asInt(get(root, "response.usageMetadata.totalTokenCount"));
  const cachedTokens = asInt(get(root, "response.usageMetadata.cachedContentTokenCount"));
  let outputTokens = candidateTokens + thoughtTokens;

  if (outputTokens === 0 && totalTokens > 0) outputTokens = Math.max(totalTokens - promptTokens, 0);

  const responseJson: JsonObject = {
    id: asString(get(root, "response.responseId")),
    type: "message",
    role: "assistant",
    model: asString(get(root, "response.modelVersion")),
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: promptTokens, output_tokens: outputTokens },
  };

  // SAFETY: `responseJson` was built just above with `usage` set to an object literal.
  const usage = responseJson["usage"] as JsonObject;

  if (cachedTokens > 0) usage["cache_read_input_tokens"] = cachedTokens;

  if (shouldTranslateWebSearchGrounding(context.originalRequest, context.translatedRequest)) {
    const grounding = antigravityGroundingMetadata(root);

    if (grounding !== undefined) {
      responseJson["content"] = buildClaudeWebSearchContent(
        newClaudeWebSearchToolUseId(),
        antigravityTextContent(root),
        grounding,
      );
      responseJson["stop_reason"] = resolveStopReason(
        asString(get(root, "response.candidates.0.finishReason")),
        false,
      );
      usage["server_tool_use"] = { web_search_requests: 1 };

      return JSON.stringify(responseJson);
    }
  }

  const blocks: Json[] = [];
  const parts = get(root, "response.candidates.0.content.parts");
  let text = "";
  let thinking = "";
  let thinkingSignature = "";
  let thinkingDirection: string = CarrierDirection.Standalone;
  let thinkingTargetKind: string = CarrierKind.Text;
  let toolIdCounter = 0;
  let hasToolCall = false;
  let hasSemanticContent = false;
  let lastSemanticKind: string = CarrierKind.Any;

  const flushText = (): void => {
    if (text === "") return;
    blocks.push({ type: "text", text });
    text = "";
  };

  const flushThinking = (): void => {
    if (thinking === "" && thinkingSignature === "") return;
    const block: JsonObject = { type: "thinking", thinking };

    if (thinkingSignature !== "") {
      block["signature"] = formatCarrierValue(
        modelName,
        thinkingSignature,
        thinkingDirection,
        thinkingTargetKind,
      );
    }

    blocks.push(block);
    thinking = "";
    thinkingSignature = "";
    thinkingDirection = CarrierDirection.Standalone;
    thinkingTargetKind = CarrierKind.Text;
  };

  const appendSignatureCarrier = (
    signature: string,
    direction: string,
    targetKind: string,
  ): void => {
    if (signature === "") return;
    blocks.push({
      type: "thinking",
      thinking: "",
      signature: formatCarrierValue(modelName, signature, direction, targetKind),
    });
  };

  if (isJsonArray(parts)) {
    for (const part of parts) {
      const signature = asString(get(part, "thoughtSignature") ?? get(part, "thought_signature"));

      const functionCall = get(part, "functionCall");

      if (functionCall !== undefined) {
        let signatureAttachedToThought = false;
        const isClaudeTarget = getModelGroup(modelName) === "claude";

        if (
          !isClaudeTarget &&
          signature !== "" &&
          thinking.length > 0 &&
          thinkingSignature === ""
        ) {
          thinkingSignature = signature;
          thinkingDirection = CarrierDirection.Next;
          thinkingTargetKind = CarrierKind.Function;
          signatureAttachedToThought = true;
        }

        flushThinking();
        flushText();
        hasToolCall = true;
        const name = restoreSanitizedToolName(toolNameMap, asString(get(functionCall, "name")));
        toolIdCounter++;

        if (!isClaudeTarget && signature !== "" && !signatureAttachedToThought) {
          appendSignatureCarrier(signature, CarrierDirection.Next, CarrierKind.Function);
        }

        const toolBlock: JsonObject = {
          type: "tool_use",
          id: claudeToolUseId(modelName, functionCall, `tool_${toolIdCounter}`),
          name,
          input: {},
        };

        if (isClaudeTarget && signature !== "")
          toolBlock["signature"] = formatClaudeSignatureValue(modelName, signature);
        const args = get(functionCall, "args");

        if (
          args !== undefined &&
          typeof args === "object" &&
          args !== null &&
          !Array.isArray(args)
        ) {
          const cleaned = tryParseJson(
            cleanClaudeToolArgumentsWithTranslated(
              JSON.stringify(args),
              name,
              context.originalRequest,
              context.translatedRequest,
            ),
          );

          toolBlock["input"] = isJsonObject(cleaned) ? cleaned : args;
        }

        blocks.push(toolBlock);
        hasSemanticContent = true;
        lastSemanticKind = CarrierKind.Function;
        continue;
      }

      const textValue = get(part, "text");
      const partText = textValue === undefined ? "" : asString(textValue);

      if (asBool(get(part, "thought"))) {
        flushText();

        if (thinkingSignature !== "") flushThinking();

        if (partText !== "") {
          thinking += partText;
          hasSemanticContent = true;
          lastSemanticKind = CarrierKind.Text;
        }

        if (signature !== "") {
          if (thinking.length > 0) {
            thinkingSignature = signature;
            thinkingDirection = CarrierDirection.Standalone;
            thinkingTargetKind = CarrierKind.Text;
            flushThinking();
          } else if (hasSemanticContent && lastSemanticKind === CarrierKind.Text) {
            cacheSignature(modelName, "", signature);
          } else if (hasSemanticContent) {
            appendSignatureCarrier(signature, CarrierDirection.Previous, lastSemanticKind);
          } else {
            appendSignatureCarrier(signature, CarrierDirection.Next, CarrierKind.Any);
          }
        }

        continue;
      }

      let visibleSignatureCarrier = false;

      if (signature !== "") {
        if (thinking.length > 0 && thinkingSignature === "") {
          thinkingSignature = signature;
          thinkingDirection = CarrierDirection.Next;
          thinkingTargetKind = CarrierKind.Text;
          flushThinking();
        } else {
          flushThinking();
          flushText();

          if (partText !== "") {
            appendSignatureCarrier(signature, CarrierDirection.Next, CarrierKind.Text);
            visibleSignatureCarrier = true;
          } else if (hasSemanticContent && lastSemanticKind === CarrierKind.Text) {
            cacheSignature(modelName, "", signature);
          } else if (hasSemanticContent) {
            appendSignatureCarrier(signature, CarrierDirection.Previous, lastSemanticKind);
          } else {
            appendSignatureCarrier(signature, CarrierDirection.Next, CarrierKind.Any);
          }
        }
      }

      if (partText !== "") {
        flushThinking();
        text += partText;
        hasSemanticContent = true;
        lastSemanticKind = CarrierKind.Text;

        if (visibleSignatureCarrier) flushText();
      }
    }
  }

  flushThinking();
  flushText();

  if (blocks.length > 0) responseJson["content"] = blocks;

  responseJson["stop_reason"] = resolveStopReason(
    asString(get(root, "response.candidates.0.finishReason")),
    hasToolCall,
  );

  if (
    promptTokens === 0 &&
    outputTokens === 0 &&
    get(root, "response.usageMetadata") === undefined
  ) {
    delete responseJson["usage"];
  }

  return JSON.stringify(responseJson);
};

export const antigravityToClaudeResponse: ResponseTransform = {
  stream: convertAntigravityResponseToClaude,
  nonStream: convertAntigravityResponseToClaudeNonStream,
  tokenCount: claudeInputTokensJson,
};

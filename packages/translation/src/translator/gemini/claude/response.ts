/**
 * Gemini provider -> Claude Messages client: streaming and non-streaming response conversion.
 *
 * Go source: internal/translator/gemini/claude/gemini_claude_response.go (ConvertGeminiResponseToClaude,
 * ConvertGeminiResponseToClaudeNonStream, ClaudeTokenCount) and init.go. Tool arguments are cleaned against the client's
 * schemas (202b8b8c, e1fb2521, `../../common/claude-tool-args.ts`); MALFORMED_FUNCTION_CALL without a tool call is an
 * `api_error` the client retries (7f2f17d7).
 */
import {
  asBool,
  asInt,
  asString,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import { ToolInputTracker } from "../../common/claude-tool-input.ts";
import {
  cleanClaudeToolArgumentsWithTranslated,
  claudeToolIsParameterless,
  mapClaudeToolName,
} from "../../common/claude-tool-args.ts";
import {
  restoreSanitizedToolName,
  sanitizeClaudeToolId,
  sanitizedToolNameMap,
  toolNameMapFromClaudeRequest,
  type NameMap,
} from "../../common/tool-names.ts";

/** Go `Params`. */
interface Params {
  hasFirstResponse: boolean;
  /** 0=none, 1=content, 2=thinking, 3=function */
  responseType: number;
  responseIndex: number;
  hasContent: boolean;
  toolNameMap: NameMap;
  sanitizedNameMap: NameMap;
  sawToolCall: boolean;
  hasFinalEvents: boolean;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** The input_json_delta bookkeeping of the open tool_use block. */
  tool: ToolInputTracker;
}

/** Process-wide tool_use id counter, shared by the stream and non-stream conversions (58257007). */
let toolUseIdCounter = 0;

const MALFORMED_FUNCTION_CALL_ERROR = {
  type: "error",
  error: { type: "api_error", message: "Gemini response finished with MALFORMED_FUNCTION_CALL" },
} as const;

/** `isGeminiMalformedFunctionCall`: a malformed call that produced no tool call is retryable, not a refusal. */
const isMalformedFunctionCall = (finishReason: string, sawToolCall: boolean): boolean =>
  finishReason === "MALFORMED_FUNCTION_CALL" && !sawToolCall;

export const resolveGeminiClaudeStopReason = (
  finishReason: string,
  sawToolCall: boolean,
): string => {
  if (sawToolCall) return "tool_use";

  switch (finishReason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "BLOCKLIST":
    case "IMAGE_SAFETY":
    case "MALFORMED_RESPONSE":
      return "refusal";
    default:
      return "end_turn";
  }
};

/** `AppendSSEEventString(out, event, payload, 3)`. */
const event = (name: string, payload: Json): string =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n\n`;

const blockStart = (index: number, block: JsonObject): string =>
  event("content_block_start", { type: "content_block_start", index, content_block: block });

const blockStop = (index: number): string =>
  event("content_block_stop", { type: "content_block_stop", index });

const blockDelta = (index: number, delta: JsonObject): string =>
  event("content_block_delta", { type: "content_block_delta", index, delta });

const messageDelta = (p: Params, stopReason: string): string => {
  const usage: JsonObject = { input_tokens: p.inputTokens, output_tokens: p.outputTokens };

  if (p.cachedTokens > 0) usage["cache_read_input_tokens"] = p.cachedTokens;

  return event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  });
};

const partSignature = (part: Json): string => {
  let sig = get(part, "thoughtSignature");

  if (sig === undefined) sig = get(part, "thought_signature");

  return sig !== undefined && asString(sig) !== "" ? asString(sig) : "";
};

export const convertGeminiResponseToClaude = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const state = context.state;

  if (state.value === undefined) {
    state.value = {
      hasFirstResponse: false,
      responseType: 0,
      responseIndex: 0,
      hasContent: false,
      toolNameMap: toolNameMapFromClaudeRequest(context.originalRequest),
      sanitizedNameMap: sanitizedToolNameMap(context.originalRequest),
      sawToolCall: false,
      hasFinalEvents: false,
      finishReason: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      tool: new ToolInputTracker(),
    } satisfies Params;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const p = state.value as Params;
  let output = "";

  /** Emits the deferred empty `{}` input once the tool_use block completes without other input (e1fb2521). */
  const flushPendingToolInput = (): void => {
    const deferred = p.responseType === 3 ? p.tool.flush() : undefined;

    if (deferred !== undefined)
      output += blockDelta(p.responseIndex, { type: "input_json_delta", partial_json: deferred });
  };

  if (line === "[DONE]") {
    if (isMalformedFunctionCall(p.finishReason, p.sawToolCall)) {
      if (p.responseType !== 0) {
        flushPendingToolInput();
        output += blockStop(p.responseIndex);
        p.responseType = 0;
      }

      if (!p.hasFinalEvents) {
        output += event("error", MALFORMED_FUNCTION_CALL_ERROR);
        p.hasFinalEvents = true;
      }

      return output === "" ? [] : [output];
    }

    if (p.hasFirstResponse && !p.hasContent) {
      output += blockStart(p.responseIndex, { type: "text", text: "" });
      p.responseType = 1;
      p.hasContent = true;
    }

    if (p.hasContent) {
      if (p.responseType !== 0) {
        flushPendingToolInput();
        output += blockStop(p.responseIndex);
        p.responseType = 0;
      }

      if (!p.hasFinalEvents) {
        output += messageDelta(p, resolveGeminiClaudeStopReason(p.finishReason, p.sawToolCall));
        p.hasFinalEvents = true;
      }

      output += event("message_stop", { type: "message_stop" });

      return [output];
    }

    return [];
  }

  // Everything after the error event of a malformed call is dropped.
  if (isMalformedFunctionCall(p.finishReason, p.sawToolCall) && p.hasFinalEvents) return [];

  const root = tryParseJson(line);

  const appendSignatureDelta = (signature: string): void => {
    if (signature === "" || p.responseType !== 2) return;
    output += blockDelta(p.responseIndex, { type: "signature_delta", signature });
    p.hasContent = true;
  };

  const appendCarrierThinkingBlock = (signature: string): void => {
    if (signature === "") return;

    if (p.responseType !== 0) {
      flushPendingToolInput();
      output += blockStop(p.responseIndex);
      p.responseIndex++;
      p.responseType = 0;
    }

    output += blockStart(p.responseIndex, { type: "thinking", thinking: "" });
    output += blockDelta(p.responseIndex, { type: "signature_delta", signature });
    output += blockStop(p.responseIndex);
    p.responseIndex++;
    p.responseType = 0;
    p.hasContent = true;
  };

  if (!p.hasFirstResponse) {
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

    const modelVersion = get(root, "modelVersion");

    if (modelVersion !== undefined) message["model"] = asString(modelVersion);
    const responseId = get(root, "responseId");

    if (responseId !== undefined) message["id"] = asString(responseId);
    output += event("message_start", { type: "message_start", message });
    p.hasFirstResponse = true;
  }

  const parts = get(root, "candidates.0.content.parts");

  if (isJsonArray(parts)) {
    for (const part of parts) {
      const partText = get(part, "text");
      const functionCall = get(part, "functionCall");
      const partSig = partSignature(part);
      const hasThoughtSignature = partSig !== "";
      const isThought = asBool(get(part, "thought"));
      const textEmpty = partText === undefined || asString(partText) === "";

      if (hasThoughtSignature && textEmpty && functionCall === undefined) {
        if (p.responseType === 2) appendSignatureDelta(partSig);
        else appendCarrierThinkingBlock(partSig);
        continue;
      }

      if (isThought) {
        if (hasThoughtSignature && textEmpty) {
          if (p.responseType === 2) appendSignatureDelta(partSig);
          else appendCarrierThinkingBlock(partSig);
          continue;
        }

        const text = asString(partText);

        if (p.responseType === 2) {
          output += blockDelta(p.responseIndex, { type: "thinking_delta", thinking: text });
          p.hasContent = true;
        } else {
          if (p.responseType !== 0) {
            flushPendingToolInput();
            output += blockStop(p.responseIndex);
            p.responseIndex++;
          }

          output += blockStart(p.responseIndex, { type: "thinking", thinking: "" });
          output += blockDelta(p.responseIndex, { type: "thinking_delta", thinking: text });
          p.responseType = 2;
          p.hasContent = true;
        }

        if (hasThoughtSignature) appendSignatureDelta(partSig);
        continue;
      }

      if (functionCall !== undefined) {
        p.sawToolCall = true;

        const upstreamToolName = restoreSanitizedToolName(
          p.sanitizedNameMap,
          asString(get(functionCall, "name")),
        );

        const clientToolName = mapClaudeToolName(
          p.toolNameMap,
          context.originalRequest,
          upstreamToolName,
        );

        const args = get(functionCall, "args");

        const cleaned = (toolName: string): string =>
          cleanClaudeToolArgumentsWithTranslated(
            JSON.stringify(args),
            toolName,
            context.originalRequest,
            context.translatedRequest,
          );

        if (p.responseType === 3 && upstreamToolName === "") {
          if (args !== undefined) {
            const partialJson = p.tool.next(cleaned(p.tool.name));

            if (partialJson !== undefined) {
              output += blockDelta(p.responseIndex, {
                type: "input_json_delta",
                partial_json: partialJson,
              });
            }
          }

          if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);
          continue;
        }

        if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);

        if (p.responseType === 3) {
          flushPendingToolInput();
          output += blockStop(p.responseIndex);
          p.responseIndex++;
          p.responseType = 0;
        }

        if (p.responseType !== 0) {
          flushPendingToolInput();
          output += blockStop(p.responseIndex);
          p.responseIndex++;
        }

        p.tool.begin(
          clientToolName,
          claudeToolIsParameterless(clientToolName, context.originalRequest),
        );
        toolUseIdCounter++;
        output += blockStart(p.responseIndex, {
          type: "tool_use",
          id: sanitizeClaudeToolId(`${upstreamToolName}-${toolUseIdCounter}`),
          name: clientToolName,
          input: {},
        });

        if (args !== undefined) {
          const partialJson = p.tool.next(cleaned(clientToolName));

          if (partialJson !== undefined) {
            output += blockDelta(p.responseIndex, {
              type: "input_json_delta",
              partial_json: partialJson,
            });
          }
        }

        p.responseType = 3;
        p.hasContent = true;
        continue;
      }

      if (partText !== undefined) {
        const text = asString(partText);

        if (hasThoughtSignature && text === "") {
          if (p.responseType === 2) appendSignatureDelta(partSig);
          else appendCarrierThinkingBlock(partSig);
          continue;
        }

        if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);

        if (p.responseType === 1) {
          output += blockDelta(p.responseIndex, { type: "text_delta", text });
          p.hasContent = true;
        } else {
          if (p.responseType !== 0) {
            flushPendingToolInput();
            output += blockStop(p.responseIndex);
            p.responseIndex++;
          }

          output += blockStart(p.responseIndex, { type: "text", text: "" });
          output += blockDelta(p.responseIndex, { type: "text_delta", text });
          p.responseType = 1;
          p.hasContent = true;
        }

        continue;
      }

      if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);
    }
  }

  const finish = get(root, "candidates.0.finishReason");

  if (finish !== undefined && asString(finish) !== "") {
    p.finishReason = asString(finish);
    flushPendingToolInput();
  }

  const usage = get(root, "usageMetadata");

  if (usage !== undefined) {
    const cachedTokens = asInt(get(usage, "cachedContentTokenCount"));
    const promptTokens = Math.max(0, asInt(get(usage, "promptTokenCount")) - cachedTokens);

    let outputTokens =
      asInt(get(usage, "candidatesTokenCount")) + asInt(get(usage, "thoughtsTokenCount"));

    if (outputTokens === 0 && asInt(get(usage, "totalTokenCount")) > 0) {
      outputTokens = Math.max(
        0,
        asInt(get(usage, "totalTokenCount")) - asInt(get(usage, "promptTokenCount")),
      );
    }

    p.inputTokens = promptTokens;
    p.outputTokens = outputTokens;
    p.cachedTokens = cachedTokens;
  }

  if (isMalformedFunctionCall(p.finishReason, p.sawToolCall) && !p.hasFinalEvents) {
    if (p.responseType !== 0) {
      flushPendingToolInput();
      output += blockStop(p.responseIndex);
      p.responseType = 0;
    }

    output += event("error", MALFORMED_FUNCTION_CALL_ERROR);
    p.hasFinalEvents = true;

    return [output];
  }

  if (usage !== undefined && line.includes('"finishReason"') && !p.hasFinalEvents) {
    if (!p.hasContent && p.hasFirstResponse) {
      output += blockStart(p.responseIndex, { type: "text", text: "" });
      p.responseType = 1;
      p.hasContent = true;
    }

    if (p.hasContent) {
      if (p.responseType !== 0) {
        flushPendingToolInput();
        output += blockStop(p.responseIndex);
        p.responseType = 0;
      }

      output += messageDelta(p, resolveGeminiClaudeStopReason(p.finishReason, p.sawToolCall));
      p.hasFinalEvents = true;
    }
  }

  return [output];
};

export const convertGeminiResponseToClaudeNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const toolNameMap = toolNameMapFromClaudeRequest(context.originalRequest);
  const sanitizedNameMap = sanitizedToolNameMap(context.originalRequest);

  const cachedTokens = asInt(get(root, "usageMetadata.cachedContentTokenCount"));

  const inputTokens = Math.max(
    0,
    asInt(get(root, "usageMetadata.promptTokenCount")) - cachedTokens,
  );

  const outputTokens =
    asInt(get(root, "usageMetadata.candidatesTokenCount")) +
    asInt(get(root, "usageMetadata.thoughtsTokenCount"));

  const usage: JsonObject = { input_tokens: inputTokens, output_tokens: outputTokens };

  if (cachedTokens > 0) usage["cache_read_input_tokens"] = cachedTokens;

  const out: JsonObject = {
    id: asString(get(root, "responseId")),
    type: "message",
    role: "assistant",
    model: asString(get(root, "modelVersion")),
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage,
  };

  const parts = get(root, "candidates.0.content.parts");
  let text = "";
  let thinking = "";
  let thinkingSignature = "";
  let hasToolCall = false;
  const blocks: Json[] = [];

  const flushText = (): void => {
    if (text === "") return;
    blocks.push({ type: "text", text });
    text = "";
  };

  const flushThinking = (): void => {
    if (thinking === "" && thinkingSignature === "") return;
    const block: JsonObject = { type: "thinking", thinking };

    if (thinkingSignature !== "") block["signature"] = thinkingSignature;
    blocks.push(block);
    thinking = "";
    thinkingSignature = "";
  };

  const appendCarrierThinkingBlock = (signature: string): void => {
    if (signature !== "") blocks.push({ type: "thinking", thinking: "", signature });
  };

  if (isJsonArray(parts)) {
    for (const part of parts) {
      const partSig = partSignature(part);
      const partText = get(part, "text");
      const functionCall = get(part, "functionCall");
      const isThought = asBool(get(part, "thought"));
      const hasText = partText !== undefined && asString(partText) !== "";

      if (isThought) {
        flushText();

        if (partSig !== "") thinkingSignature = partSig;

        if (hasText) thinking += asString(partText);
        continue;
      }

      if (!hasText && functionCall === undefined) {
        if (thinking !== "" && partSig !== "") {
          thinkingSignature = partSig;
          continue;
        }

        if (partSig !== "") {
          flushThinking();
          flushText();
          appendCarrierThinkingBlock(partSig);
        }

        continue;
      }

      flushThinking();

      if (functionCall !== undefined) {
        flushText();

        if (partSig !== "") appendCarrierThinkingBlock(partSig);
        hasToolCall = true;

        const upstreamToolName = restoreSanitizedToolName(
          sanitizedNameMap,
          asString(get(functionCall, "name")),
        );

        const clientToolName = mapClaudeToolName(
          toolNameMap,
          context.originalRequest,
          upstreamToolName,
        );

        toolUseIdCounter++;
        const args = get(functionCall, "args");
        let input: Json = {};

        if (isJsonObject(args)) {
          const cleaned = tryParseJson(
            cleanClaudeToolArgumentsWithTranslated(
              JSON.stringify(args),
              clientToolName,
              context.originalRequest,
              context.translatedRequest,
            ),
          );

          input = isJsonObject(cleaned) ? cleaned : args;
        }

        blocks.push({
          type: "tool_use",
          id: sanitizeClaudeToolId(`${upstreamToolName}-${toolUseIdCounter}`),
          name: clientToolName,
          input,
        });
        continue;
      }

      if (hasText) {
        if (partSig !== "") {
          flushText();
          appendCarrierThinkingBlock(partSig);
        }

        text += asString(partText);
        continue;
      }
    }
  }

  flushThinking();
  flushText();

  if (blocks.length > 0) out["content"] = blocks;

  const finish = get(root, "candidates.0.finishReason");
  const finishReason = finish === undefined ? "" : asString(finish);

  if (isMalformedFunctionCall(finishReason, hasToolCall))
    return JSON.stringify(MALFORMED_FUNCTION_CALL_ERROR);
  out["stop_reason"] = resolveGeminiClaudeStopReason(finishReason, hasToolCall);

  if (inputTokens === 0 && outputTokens === 0 && !exists(root, "usageMetadata"))
    delete out["usage"];

  return JSON.stringify(out);
};

export const claudeTokenCount = (count: number): string => `{"input_tokens":${count}}`;

export const geminiToClaudeResponse: ResponseTransform = {
  stream: convertGeminiResponseToClaude,
  nonStream: convertGeminiResponseToClaudeNonStream,
  tokenCount: claudeTokenCount,
};

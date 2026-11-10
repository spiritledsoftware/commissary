/**
 * OpenAI Chat Completions provider -> Claude Messages client (response).
 *
 * Go source: internal/translator/openai/claude/openai_claude_response.go (upstream c449529e, 9a7db8e3, 6044c5d1,
 * 69637a66).
 */
import { asInt, get, type Json, type JsonObject } from "@commissary/json";
import { sseEvent } from "../../../sse.ts";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import { getStr, isArr, isObj, present, str } from "../common/read.ts";
import {
  fixJson,
  mapToolName,
  type NameMap,
  sanitizeClaudeToolId,
  toolNameMapFromClaudeRequest,
} from "../../common/tool-names.ts";

interface InterleavedContentChunk {
  readonly type: "text" | "thinking";
  text: string;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  /** Whether content_block_start has already been sent for this tool index. */
  startEmitted: boolean;
}

/** Port of `ConvertOpenAIResponseToAnthropicParams`. */
export interface ClaudeStreamParams {
  messageId: string;
  model: string;
  createdAt: number;
  toolNameMap: NameMap;
  toolNameMapResolved: boolean;
  /** True once at least one tool_use content_block_start has been emitted on the wire. */
  sawToolCall: boolean;
  contentAccumulatorLength: number;
  toolCallsAccumulator: Map<number, ToolCallAccumulator> | undefined;
  textContentBlockStarted: boolean;
  thinkingContentBlockStarted: boolean;
  finishReason: string;
  contentBlocksStopped: boolean;
  messageDeltaSent: boolean;
  messageStarted: boolean;
  messageStopSent: boolean;
  toolCallBlockIndexes: Map<number, number>;
  /** Chunk-local tool_calls array position -> accumulator key, when the upstream omits `tool_calls[].index`. */
  omittedToolCallIndexes: Map<number, number>;
  textContentBlockIndex: number;
  thinkingContentBlockIndex: number;
  nextContentBlockIndex: number;
  openToolCallIndex: number;
  interleavedContentChunks: InterleavedContentChunk[];
  usageInputTokens: number;
  usageOutputTokens: number;
  usageCachedTokens: number;
  usageCacheWriteTokens: number;
}

const newParams = (): ClaudeStreamParams => ({
  messageId: "",
  model: "",
  createdAt: 0,
  toolNameMap: undefined,
  toolNameMapResolved: false,
  sawToolCall: false,
  contentAccumulatorLength: 0,
  toolCallsAccumulator: undefined,
  textContentBlockStarted: false,
  thinkingContentBlockStarted: false,
  finishReason: "",
  contentBlocksStopped: false,
  messageDeltaSent: false,
  messageStarted: false,
  messageStopSent: false,
  toolCallBlockIndexes: new Map(),
  omittedToolCallIndexes: new Map(),
  textContentBlockIndex: -1,
  thinkingContentBlockIndex: -1,
  nextContentBlockIndex: 0,
  openToolCallIndex: -1,
  interleavedContentChunks: [],
  usageInputTokens: 0,
  usageOutputTokens: 0,
  usageCachedTokens: 0,
  usageCacheWriteTokens: 0,
});

const ev = (event: string, payload: Json): string => sseEvent(event, JSON.stringify(payload));

/** `collectOpenAIReasoningTexts`. */
const collectOpenAIReasoningTexts = (node: Json | undefined): string[] => {
  if (node === undefined) return [];

  if (isArr(node)) return node.flatMap(collectOpenAIReasoningTexts);

  if (typeof node === "string") return node !== "" ? [node] : [];

  if (isObj(node)) {
    const text = node.text;

    if (text !== undefined) {
      const textStr = str(text);

      if (textStr !== "") return [textStr];
    }
  }

  return [];
};

const collectOpenAIObjectReasoningTexts = (obj: Json | undefined): string[] => {
  if (obj === undefined) return [];

  for (const path of ["reasoning_content", "reasoning", "reasoning_details"]) {
    const texts = collectOpenAIReasoningTexts(get(obj, path));

    if (texts.length > 0) return texts;
  }

  return [];
};

/** `mapOpenAIFinishReasonToAnthropic`. */
const mapOpenAIFinishReasonToAnthropic = (reason: string): string => {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    case "function_call":
      return "tool_use";
    default:
      return "end_turn";
  }
};

/** `mapOpenAINonStreamFinishReasonToAnthropic`: tool calls win unless the output was cut off or filtered. */
const mapOpenAINonStreamFinishReasonToAnthropic = (
  openAIReason: string,
  hasToolCall: boolean,
): string =>
  hasToolCall && openAIReason !== "length" && openAIReason !== "content_filter"
    ? "tool_use"
    : mapOpenAIFinishReasonToAnthropic(openAIReason);

interface OpenAIUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

/** `extractOpenAIUsage`: prompt tokens exclude cache reads/writes. */
const extractOpenAIUsage = (usage: Json | undefined): OpenAIUsage => {
  if (!present(usage))
    return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  let inputTokens = asInt(get(usage, "prompt_tokens"));
  const outputTokens = asInt(get(usage, "completion_tokens"));
  const cachedTokens = asInt(get(usage, "prompt_tokens_details.cached_tokens"));
  let cacheWriteTokens = asInt(get(usage, "prompt_tokens_details.cache_write_tokens"));

  if (cacheWriteTokens <= 0)
    cacheWriteTokens = asInt(get(usage, "prompt_tokens_details.cache_creation_tokens"));
  let deduct = 0;

  if (cachedTokens > 0) deduct += cachedTokens;

  if (cacheWriteTokens > 0) deduct += cacheWriteTokens;

  if (deduct > 0) inputTokens = inputTokens >= deduct ? inputTokens - deduct : 0;

  if (inputTokens < 0) inputTokens = 0;

  return { inputTokens, outputTokens, cachedTokens, cacheWriteTokens };
};

/** `extractOpenAIContentPartThinkingText`: the text of a typed `thinking`/`reasoning` content part. */
const extractOpenAIContentPartThinkingText = (part: Json): string => {
  for (const field of ["thinking", "reasoning", "reasoning_content", "text"]) {
    const texts = collectOpenAIReasoningTexts(get(part, field));

    if (texts.length > 0) return texts.join("");
  }

  return "";
};

const hasValidToolCallArguments = (param: ClaudeStreamParams): boolean => {
  if (param.toolCallsAccumulator === undefined || param.toolCallsAccumulator.size === 0)
    return true;

  for (const acc of param.toolCallsAccumulator.values()) {
    if (!acc.startEmitted && acc.name === "" && acc.id === "" && acc.arguments.length === 0)
      continue;

    if (acc.arguments.length === 0) continue;
    const argsStr = acc.arguments.trim();

    if (argsStr === "") return false;

    if (argsStr === "{}") continue;

    try {
      if (!isObj(JSON.parse(fixJson(argsStr)))) return false;
    } catch {
      return false;
    }
  }

  return true;
};

const effectiveOpenAIFinishReason = (param: ClaudeStreamParams): string => {
  if (param.finishReason === "length" || param.finishReason === "content_filter")
    return param.finishReason;

  if (param.sawToolCall) return hasValidToolCallArguments(param) ? "tool_calls" : "length";

  return param.finishReason;
};

const terminalOpenAIFinishReason = (param: ClaudeStreamParams): string =>
  effectiveOpenAIFinishReason(param) || "stop";

const toolContentBlockIndex = (param: ClaudeStreamParams, openAIToolIndex: number): number => {
  const existing = param.toolCallBlockIndexes.get(openAIToolIndex);

  if (existing !== undefined) return existing;
  const idx = param.nextContentBlockIndex;
  param.nextContentBlockIndex++;
  param.toolCallBlockIndexes.set(openAIToolIndex, idx);

  return idx;
};

const stopThinkingContentBlock = (param: ClaudeStreamParams, results: string[]): void => {
  if (!param.thinkingContentBlockStarted) return;
  results.push(
    ev("content_block_stop", {
      type: "content_block_stop",
      index: param.thinkingContentBlockIndex,
    }),
  );
  param.thinkingContentBlockStarted = false;
  param.thinkingContentBlockIndex = -1;
};

const stopTextContentBlock = (param: ClaudeStreamParams, results: string[]): void => {
  if (!param.textContentBlockStarted) return;
  results.push(
    ev("content_block_stop", { type: "content_block_stop", index: param.textContentBlockIndex }),
  );
  param.textContentBlockStarted = false;
  param.textContentBlockIndex = -1;
};

const emitMessageStopIfNeeded = (param: ClaudeStreamParams, results: string[]): void => {
  if (param.messageStopSent) return;
  results.push(ev("message_stop", { type: "message_stop" }));
  param.messageStopSent = true;
};

const emitToolUseStart = (
  param: ClaudeStreamParams,
  openAIToolIndex: number,
  accumulator: ToolCallAccumulator,
  results: string[],
): void => {
  stopThinkingContentBlock(param, results);
  stopTextContentBlock(param, results);
  const blockIndex = toolContentBlockIndex(param, openAIToolIndex);
  results.push(
    ev("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: sanitizeClaudeToolId(accumulator.id),
        name: accumulator.name,
        input: {},
      },
    }),
  );
  accumulator.startEmitted = true;
  param.sawToolCall = true;
  param.openToolCallIndex = openAIToolIndex;
};

/**
 * `emitBelatedToolUseStart`: finalizes a tool_use block that never received a mid-stream start. Some providers leave
 * `function.name` empty for the whole stream; the call is kept as `tool_<index>` instead of being dropped.
 */
const emitBelatedToolUseStart = (
  param: ClaudeStreamParams,
  openAIToolIndex: number,
  accumulator: ToolCallAccumulator | undefined,
  results: string[],
): boolean => {
  if (accumulator === undefined) return false;

  if (accumulator.startEmitted) return true;

  if (accumulator.name === "" && accumulator.id === "" && accumulator.arguments.length === 0)
    return false;

  if (accumulator.name === "") accumulator.name = `tool_${openAIToolIndex}`;
  emitToolUseStart(param, openAIToolIndex, accumulator, results);

  return true;
};

const finalizeSingleToolCall = (
  param: ClaudeStreamParams,
  openAIToolIndex: number,
  results: string[],
): void => {
  const accumulator = param.toolCallsAccumulator?.get(openAIToolIndex);

  if (accumulator === undefined) return;

  if (
    !accumulator.startEmitted &&
    !emitBelatedToolUseStart(param, openAIToolIndex, accumulator, results)
  )
    return;
  const blockIndex = toolContentBlockIndex(param, openAIToolIndex);

  if (accumulator.arguments.length > 0) {
    results.push(
      ev("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: fixJson(accumulator.arguments) },
      }),
    );
  }

  results.push(ev("content_block_stop", { type: "content_block_stop", index: blockIndex }));
  param.toolCallBlockIndexes.delete(openAIToolIndex);
  param.openToolCallIndex = -1;
};

const emitBufferedInterleavedContent = (param: ClaudeStreamParams, results: string[]): void => {
  if (param.interleavedContentChunks.length === 0) return;

  for (const chunk of param.interleavedContentChunks) {
    if (chunk.text === "") continue;
    const idx = param.nextContentBlockIndex;
    param.nextContentBlockIndex++;

    if (chunk.type === "thinking") {
      results.push(
        ev("content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: { type: "thinking", thinking: "" },
        }),
        ev("content_block_delta", {
          type: "content_block_delta",
          index: idx,
          delta: { type: "thinking_delta", thinking: chunk.text },
        }),
        ev("content_block_stop", { type: "content_block_stop", index: idx }),
      );
    } else {
      results.push(
        ev("content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: { type: "text", text: "" },
        }),
        ev("content_block_delta", {
          type: "content_block_delta",
          index: idx,
          delta: { type: "text_delta", text: chunk.text },
        }),
        ev("content_block_stop", { type: "content_block_stop", index: idx }),
      );
    }
  }

  param.interleavedContentChunks = [];
};

const finalizeOpenAIAnthropicContentBlocks = (
  param: ClaudeStreamParams,
  results: string[],
): void => {
  stopThinkingContentBlock(param, results);
  stopTextContentBlock(param, results);

  if (param.contentBlocksStopped) return;

  if (param.openToolCallIndex !== -1)
    finalizeSingleToolCall(param, param.openToolCallIndex, results);
  const indexes = [...(param.toolCallsAccumulator?.keys() ?? [])].sort((a, b) => a - b);

  for (const index of indexes) {
    const accumulator = param.toolCallsAccumulator?.get(index);

    if (accumulator === undefined || accumulator.startEmitted) continue;
    finalizeSingleToolCall(param, index, results);
  }

  param.contentBlocksStopped = true;
  emitBufferedInterleavedContent(param, results);
};

const emitAnthropicMessageDelta = (
  param: ClaudeStreamParams,
  results: string[],
  usage: OpenAIUsage,
): void => {
  if (param.messageDeltaSent) return;

  const usageOut: JsonObject = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };

  if (usage.cachedTokens > 0) usageOut.cache_read_input_tokens = usage.cachedTokens;

  if (usage.cacheWriteTokens > 0) usageOut.cache_creation_input_tokens = usage.cacheWriteTokens;
  results.push(
    ev("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapOpenAIFinishReasonToAnthropic(terminalOpenAIFinishReason(param)),
        stop_sequence: null,
      },
      usage: usageOut,
    }),
  );
  param.messageDeltaSent = true;
};

const cachedUsage = (param: ClaudeStreamParams): OpenAIUsage => ({
  inputTokens: param.usageInputTokens,
  outputTokens: param.usageOutputTokens,
  cachedTokens: param.usageCachedTokens,
  cacheWriteTokens: param.usageCacheWriteTokens,
});

/** `emitStreamingThinkingDelta`. Anthropic rejects whitespace-only thinking blocks, so whitespace may only extend an open one. */
const emitStreamingThinkingDelta = (
  param: ClaudeStreamParams,
  reasoningText: string,
  results: string[],
): void => {
  if (reasoningText === "") return;

  if (param.openToolCallIndex !== -1) {
    const last = param.interleavedContentChunks[param.interleavedContentChunks.length - 1];

    if (last !== undefined && last.type === "thinking") last.text += reasoningText;
    else if (reasoningText.trim() !== "")
      param.interleavedContentChunks.push({ type: "thinking", text: reasoningText });

    return;
  }

  if (!param.thinkingContentBlockStarted && reasoningText.trim() === "") return;
  stopTextContentBlock(param, results);

  if (!param.thinkingContentBlockStarted) {
    if (param.thinkingContentBlockIndex === -1) {
      param.thinkingContentBlockIndex = param.nextContentBlockIndex;
      param.nextContentBlockIndex++;
    }

    results.push(
      ev("content_block_start", {
        type: "content_block_start",
        index: param.thinkingContentBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
    param.thinkingContentBlockStarted = true;
  }

  results.push(
    ev("content_block_delta", {
      type: "content_block_delta",
      index: param.thinkingContentBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningText },
    }),
  );
};

/** `emitStreamingTextDelta`. */
const emitStreamingTextDelta = (
  param: ClaudeStreamParams,
  text: string,
  results: string[],
): void => {
  if (text === "") return;

  if (param.openToolCallIndex !== -1) {
    // A tool call block is open on the wire: buffer the text so content blocks stay strictly sequential.
    const last = param.interleavedContentChunks[param.interleavedContentChunks.length - 1];

    if (last !== undefined && last.type === "text") last.text += text;
    else param.interleavedContentChunks.push({ type: "text", text });
    param.contentAccumulatorLength += text.length;

    return;
  }

  if (!param.textContentBlockStarted) {
    stopThinkingContentBlock(param, results);

    if (param.textContentBlockIndex === -1) {
      param.textContentBlockIndex = param.nextContentBlockIndex;
      param.nextContentBlockIndex++;
    }

    results.push(
      ev("content_block_start", {
        type: "content_block_start",
        index: param.textContentBlockIndex,
        content_block: { type: "text", text: "" },
      }),
    );
    param.textContentBlockStarted = true;
  }

  results.push(
    ev("content_block_delta", {
      type: "content_block_delta",
      index: param.textContentBlockIndex,
      delta: { type: "text_delta", text },
    }),
  );
  param.contentAccumulatorLength += text.length;
};

const toolUseBlockFor = (toolCall: Json, toolNameMap: NameMap): Json => ({
  type: "tool_use",
  id: sanitizeClaudeToolId(getStr(toolCall, "id")),
  name: mapToolName(toolNameMap, getStr(toolCall, "function.name")),
  input: toolUseInput(getStr(toolCall, "function.arguments")),
});

/** `appendOpenAINonStreamingMessageContent`: a string or typed-part `message.content` -> Claude content blocks. */
const appendOpenAINonStreamingMessageContent = (
  contentResult: Json | undefined,
  toolNameMap: NameMap,
  blocks: Json[],
): boolean => {
  let hasToolCall = false;

  if (contentResult === undefined) return hasToolCall;

  if (isArr(contentResult)) {
    let text = "";
    let thinking = "";

    const flushText = (): void => {
      if (text.length === 0) return;
      blocks.push({ type: "text", text });
      text = "";
    };

    const flushThinking = (): void => {
      if (thinking.length === 0) return;
      blocks.push({ type: "thinking", thinking });
      thinking = "";
    };

    for (const item of contentResult) {
      switch (getStr(item, "type")) {
        case "text": {
          const partText = getStr(item, "text");

          if (partText !== "") {
            flushThinking();
            text += partText;
          }

          break;
        }

        case "tool_calls": {
          flushThinking();
          flushText();
          const toolCalls = get(item, "tool_calls");

          if (isArr(toolCalls)) {
            for (const toolCall of toolCalls) {
              hasToolCall = true;
              blocks.push(toolUseBlockFor(toolCall, toolNameMap));
            }
          }

          break;
        }

        case "reasoning":
        case "thinking": {
          const thinkingText = extractOpenAIContentPartThinkingText(item);

          // Whitespace may only extend an open thinking block (Anthropic rejects blank ones).
          if (thinking.length > 0 || thinkingText.trim() !== "") {
            flushText();
            thinking += thinkingText;
          }

          break;
        }

        default:
          flushThinking();
          flushText();
      }
    }

    flushThinking();
    flushText();
  } else if (typeof contentResult === "string" && contentResult !== "") {
    blocks.push({ type: "text", text: contentResult });
  }

  return hasToolCall;
};

/** `convertOpenAIStreamingChunkToAnthropic`. */
const convertOpenAIStreamingChunkToAnthropic = (
  rootJson: Json,
  param: ClaudeStreamParams,
): string[] => {
  const root = rootJson;
  const results: string[] = [];

  if (param.messageId === "") param.messageId = getStr(root, "id");

  if (param.model === "") param.model = getStr(root, "model");

  if (param.createdAt === 0) param.createdAt = asInt(get(root, "created"));

  const delta = get(root, "choices.0.delta");

  if (delta !== undefined) {
    if (!param.messageStarted) {
      results.push(
        ev("message_start", {
          type: "message_start",
          message: {
            id: param.messageId,
            type: "message",
            role: "assistant",
            model: param.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      param.messageStarted = true;
    }

    for (const reasoningText of collectOpenAIObjectReasoningTexts(delta))
      emitStreamingThinkingDelta(param, reasoningText, results);

    const content = get(delta, "content");

    if (isArr(content)) {
      for (const part of content) {
        if (typeof part === "string") {
          emitStreamingTextDelta(param, part, results);
          continue;
        }

        switch (getStr(part, "type")) {
          case "thinking":
          case "reasoning":
            emitStreamingThinkingDelta(param, extractOpenAIContentPartThinkingText(part), results);
            break;
          case "text":
            emitStreamingTextDelta(param, getStr(part, "text"), results);
            break;
          default:
            // Unknown parts pass through as their raw JSON text (gjson `String()`).
            emitStreamingTextDelta(param, part === null ? "" : JSON.stringify(part), results);
        }
      }
    } else if (typeof content === "string") {
      emitStreamingTextDelta(param, content, results);
    }

    const toolCalls = get(delta, "tool_calls");

    if (isArr(toolCalls)) {
      if (param.toolCallsAccumulator === undefined) param.toolCallsAccumulator = new Map();
      toolCalls.forEach((toolCall, arrayIndex) => {
        const idValue = get(toolCall, "id");
        const incomingId = typeof idValue === "string" ? idValue : "";
        const indexValue = get(toolCall, "index");
        let index: number;

        if (indexValue !== undefined) {
          index = asInt(indexValue);
        } else {
          // The upstream omits tool_calls[].index: a new id at the same array position starts a new call.
          index = param.omittedToolCallIndexes.get(arrayIndex) ?? arrayIndex;
          const existing = param.toolCallsAccumulator?.get(index);

          if (
            existing !== undefined &&
            incomingId !== "" &&
            existing.id !== "" &&
            existing.id !== incomingId
          ) {
            let nextIndex = index + 1;

            for (const key of param.toolCallsAccumulator?.keys() ?? [])
              if (key >= nextIndex) nextIndex = key + 1;
            index = nextIndex;
            param.omittedToolCallIndexes.set(arrayIndex, index);
          }
        }

        let accumulator = param.toolCallsAccumulator?.get(index);

        if (accumulator === undefined) {
          accumulator = { id: "", name: "", arguments: "", startEmitted: false };
          param.toolCallsAccumulator?.set(index, accumulator);
        }

        // Only accept JSON-string, non-empty ids so malformed upstream fields cannot overwrite a valid id.
        if (incomingId !== "" && !accumulator.startEmitted) accumulator.id = incomingId;

        const fn = get(toolCall, "function");

        if (fn !== undefined) {
          // The name is only recorded until content_block_start has been emitted (it must not drift afterwards).
          if (!accumulator.startEmitted) {
            const name = get(fn, "name");

            if (typeof name === "string" && name !== "")
              accumulator.name = mapToolName(param.toolNameMap, name);
          }

          const args = get(fn, "arguments");

          if (args !== undefined) {
            const argsText = str(args);

            if (argsText !== "") accumulator.arguments += argsText;
          }
        }

        // Re-check on every chunk: some upstreams split function.name and id across separate deltas.
        if (
          !accumulator.startEmitted &&
          accumulator.name !== "" &&
          accumulator.id !== "" &&
          !param.contentBlocksStopped
        ) {
          if (param.openToolCallIndex === -1) emitToolUseStart(param, index, accumulator, results);
        }
      });
    }
  }

  const finishReason = get(root, "choices.0.finish_reason");

  if (finishReason !== undefined && str(finishReason) !== "") {
    const reason = str(finishReason);

    if (reason === "length") param.finishReason = "length";
    else if (reason === "content_filter") param.finishReason = "content_filter";
    else if (param.sawToolCall)
      param.finishReason = hasValidToolCallArguments(param) ? "tool_calls" : "length";
    else if (reason === "tool_calls") param.finishReason = "stop";
    else param.finishReason = reason;
    finalizeOpenAIAnthropicContentBlocks(param, results);
  }

  const usage = get(root, "usage");
  const hasUsage = present(usage);

  if (hasUsage) {
    const extracted = extractOpenAIUsage(usage);
    param.usageInputTokens = extracted.inputTokens;
    param.usageOutputTokens = extracted.outputTokens;
    param.usageCachedTokens = extracted.cachedTokens;
    param.usageCacheWriteTokens = extracted.cacheWriteTokens;
  }

  const isTrailingUsageChunk =
    hasUsage &&
    get(root, "choices.0") === undefined &&
    (param.finishReason !== "" ||
      param.sawToolCall ||
      param.textContentBlockStarted ||
      param.thinkingContentBlockStarted ||
      param.contentAccumulatorLength > 0 ||
      param.interleavedContentChunks.length > 0);

  // A chunk with finish_reason and preliminary usage must not end the message: the authoritative counts (such as
  // cached_tokens) can arrive in the trailing usage-only chunk, and [DONE] closes a stream without one.
  if (!param.messageDeltaSent && isTrailingUsageChunk) {
    finalizeOpenAIAnthropicContentBlocks(param, results);
    emitAnthropicMessageDelta(param, results, cachedUsage(param));
    emitMessageStopIfNeeded(param, results);
  }

  return results;
};

/** `convertOpenAIDoneToAnthropic`. */
const convertOpenAIDoneToAnthropic = (param: ClaudeStreamParams): string[] => {
  const results: string[] = [];
  finalizeOpenAIAnthropicContentBlocks(param, results);

  if (!param.messageDeltaSent) emitAnthropicMessageDelta(param, results, cachedUsage(param));
  emitMessageStopIfNeeded(param, results);

  return results;
};

const toolUseInput = (argumentsText: string): Json => {
  const argsStr = fixJson(argumentsText);

  if (argsStr !== "") {
    try {
      const parsed = JSON.parse(argsStr);

      if (isObj(parsed)) return parsed;
    } catch {
      // Invalid arguments become an empty input object.
    }
  }

  return {};
};

const usageOut = (usage: OpenAIUsage): JsonObject => {
  const out: JsonObject = { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens };

  if (usage.cachedTokens > 0) out.cache_read_input_tokens = usage.cachedTokens;

  if (usage.cacheWriteTokens > 0) out.cache_creation_input_tokens = usage.cacheWriteTokens;

  return out;
};

/** `convertOpenAINonStreamingToAnthropic`: a whole non-stream body delivered through the stream entry point. */
const convertOpenAINonStreamingToAnthropic = (root: Json): string[] => {
  const out: JsonObject = {
    id: getStr(root, "id"),
    type: "message",
    role: "assistant",
    model: getStr(root, "model"),
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  const choices = get(root, "choices");

  if (isArr(choices) && choices.length > 0) {
    // SAFETY: the enclosing condition checks choices.length > 0.
    const choice = choices[0] as Json;
    const contentBlocks: Json[] = [];

    for (const reasoningText of collectOpenAIObjectReasoningTexts(get(choice, "message"))) {
      if (reasoningText.trim() === "") continue;
      contentBlocks.push({ type: "thinking", thinking: reasoningText });
    }

    let hasToolCall = appendOpenAINonStreamingMessageContent(
      get(choice, "message.content"),
      undefined,
      contentBlocks,
    );

    const toolCalls = get(choice, "message.tool_calls");

    if (isArr(toolCalls)) {
      for (const toolCall of toolCalls) {
        hasToolCall = true;
        contentBlocks.push({
          type: "tool_use",
          id: sanitizeClaudeToolId(getStr(toolCall, "id")),
          name: getStr(toolCall, "function.name"),
          input: toolUseInput(getStr(toolCall, "function.arguments")),
        });
      }
    }

    if (contentBlocks.length > 0) out.content = contentBlocks;
    const finishReason = get(choice, "finish_reason");

    if (finishReason !== undefined || hasToolCall)
      out.stop_reason = mapOpenAINonStreamFinishReasonToAnthropic(
        finishReason === undefined ? "" : str(finishReason),
        hasToolCall,
      );
  }

  const usage = get(root, "usage");

  if (usage !== undefined) out.usage = usageOut(extractOpenAIUsage(usage));

  return [JSON.stringify(out)];
};

const isFalseOrMissing = (value: Json | undefined): boolean =>
  value === undefined || value === false;

/** `ConvertOpenAIResponseToClaude`: one upstream SSE line -> Claude SSE events. */
export const convertOpenAIResponseToClaude = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const state = context.state;

  if (state.value === undefined) state.value = newParams();
  // SAFETY: this translator is the only writer of `state.value` and initialises it to a ClaudeStreamParams before this read.
  const param = state.value as ClaudeStreamParams;

  if (!line.startsWith("data:")) return [];
  const payload = line.slice(5).trim();

  if (!param.toolNameMapResolved) {
    param.toolNameMap = toolNameMapFromClaudeRequest(context.originalRequest);
    param.toolNameMapResolved = true;
  }

  if (payload === "[DONE]") return convertOpenAIDoneToAnthropic(param);

  let root: Json;

  try {
    root = JSON.parse(payload);
  } catch {
    // gjson tolerates invalid JSON by returning empty results; nothing is emitted for an unusable chunk.
    root = {};
  }

  if (isFalseOrMissing(get(context.originalRequest, "stream")))
    return convertOpenAINonStreamingToAnthropic(root);

  return convertOpenAIStreamingChunkToAnthropic(root, param);
};

/** `ConvertOpenAIResponseToClaudeNonStream`. */
export const convertOpenAIResponseToClaudeNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  let root: Json;

  try {
    root = JSON.parse(body);
  } catch {
    root = {};
  }

  const toolNameMap = toolNameMapFromClaudeRequest(context.originalRequest);

  const out: JsonObject = {
    id: getStr(root, "id"),
    type: "message",
    role: "assistant",
    model: getStr(root, "model"),
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  let hasToolCall = false;
  let finishReason = "";
  const blocks: Json[] = [];

  const choices = get(root, "choices");

  if (isArr(choices) && choices.length > 0) {
    // SAFETY: the enclosing condition checks choices.length > 0.
    const choice = choices[0] as Json;
    finishReason = str(get(choice, "finish_reason"));

    const message = get(choice, "message");

    if (message !== undefined) {
      for (const reasoningText of collectOpenAIObjectReasoningTexts(message)) {
        if (reasoningText.trim() === "") continue;
        blocks.push({ type: "thinking", thinking: reasoningText });
      }

      if (appendOpenAINonStreamingMessageContent(get(message, "content"), toolNameMap, blocks))
        hasToolCall = true;
      const toolCalls = get(message, "tool_calls");

      if (isArr(toolCalls)) {
        for (const toolCall of toolCalls) {
          hasToolCall = true;
          blocks.push(toolUseBlockFor(toolCall, toolNameMap));
        }
      }
    }
  }

  if (blocks.length > 0) out.content = blocks;
  const respUsage = get(root, "usage");

  if (respUsage !== undefined) out.usage = usageOut(extractOpenAIUsage(respUsage));

  out.stop_reason = mapOpenAINonStreamFinishReasonToAnthropic(finishReason, hasToolCall);

  return JSON.stringify(out);
};

/** `ClaudeTokenCount`. */
export const claudeTokenCount = (count: number): string => `{"input_tokens":${count}}`;

export const openAIToClaudeResponse: ResponseTransform = {
  stream: convertOpenAIResponseToClaude,
  nonStream: convertOpenAIResponseToClaudeNonStream,
  tokenCount: claudeTokenCount,
};

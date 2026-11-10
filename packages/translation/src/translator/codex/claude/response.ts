/**
 * Codex (Responses) stream/non-stream response -> Claude Messages.
 *
 * Go source: internal/translator/codex/claude/codex_claude_response.go (ConvertCodexResponseToClaude,
 * ...NonStream, ClaudeTokenCount) and codex_claude_response_web_search.go. The per-request state mirrors
 * `ConvertCodexResponseToClaudeParams`. One call returns the concatenation of all SSE events for one upstream line.
 * Commentary-phase messages (commits 376015c3, 531721bf) are relayed as thinking blocks signed with the internal
 * commentary marker, which `codex/claude/request.ts` restores on replay.
 */
import {
  asInt,
  asString,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { claudeInputTokensJson, sseEventLines } from "../../common/bytes.ts";
import { sanitizeClaudeToolId } from "../../common/tool-names.ts";
import { CODEX_COMMENTARY_SIGNATURE_MARKER } from "../../../signature/claude-messages.ts";
import type { ResponseContext } from "../../registry.ts";
import { buildOriginalToShortMap, shortenCodexCallIdIfNeeded } from "./request.ts";

interface CodexFunctionCallStream {
  callId: string;
  name: string;
  blockIndex: number;
  argumentsText: string;
  emittedArgumentsLength: number;
  hasReceivedArgumentsDelta: boolean;
  emitInitialEmptyDelta: boolean;
  started: boolean;
  done: boolean;
  closed: boolean;
}

/** Go `ConvertCodexResponseToClaudeParams`. */
export interface ConvertCodexResponseToClaudeParams {
  hasEmittedToolUse: boolean;
  blockIndex: number;
  hasTextDelta: boolean;
  textBlockOpen: boolean;
  thinkingBlockOpen: boolean;
  thinkingSignature: string;
  thinkingSummarySeen: boolean;
  /** A commentary-phase message item is open: its text streams as a thinking block. */
  commentaryMessageOpen: boolean;
  webSearchToolUseIds: Set<string>;
  webSearchToolResultIds: Set<string>;
  lastWebSearchToolUseId: string;
  functionCalls: Map<string, CodexFunctionCallStream>;
  functionCallQueue: CodexFunctionCallStream[];
  activeFunctionCall: CodexFunctionCallStream | undefined;
  lastFunctionCall: CodexFunctionCallStream | undefined;
  deferredStreamEvents: string[];
}

const newParams = (): ConvertCodexResponseToClaudeParams => ({
  hasEmittedToolUse: false,
  blockIndex: 0,
  hasTextDelta: false,
  textBlockOpen: false,
  thinkingBlockOpen: false,
  thinkingSignature: "",
  thinkingSummarySeen: false,
  commentaryMessageOpen: false,
  webSearchToolUseIds: new Set(),
  webSearchToolResultIds: new Set(),
  lastWebSearchToolUseId: "",
  functionCalls: new Map(),
  functionCallQueue: [],
  activeFunctionCall: undefined,
  lastFunctionCall: undefined,
  deferredStreamEvents: [],
});

/** Separator between consecutive reasoning summary parts inside the one thinking block of a reasoning item. */
const SUMMARY_PART_SEPARATOR = "\n\n";

const event = (name: string, payload: Json): string =>
  sseEventLines(name, JSON.stringify(payload), 2);

// ---------------------------------------------------------------------------------------------------------------
// Text and thinking blocks
// ---------------------------------------------------------------------------------------------------------------

const startTextBlock = (p: ConvertCodexResponseToClaudeParams): string => {
  if (p.textBlockOpen) return "";
  p.textBlockOpen = true;

  return event("content_block_start", {
    type: "content_block_start",
    index: p.blockIndex,
    content_block: { type: "text", text: "" },
  });
};

const stopTextBlock = (p: ConvertCodexResponseToClaudeParams): string => {
  if (!p.textBlockOpen) return "";
  const out = event("content_block_stop", { type: "content_block_stop", index: p.blockIndex });
  p.textBlockOpen = false;
  p.blockIndex++;

  return out;
};

const startThinkingBlock = (p: ConvertCodexResponseToClaudeParams): string => {
  if (p.thinkingBlockOpen) return "";
  p.thinkingBlockOpen = true;

  return event("content_block_start", {
    type: "content_block_start",
    index: p.blockIndex,
    content_block: { type: "thinking", thinking: "" },
  });
};

const appendThinkingDelta = (p: ConvertCodexResponseToClaudeParams, text: string): string =>
  text === ""
    ? ""
    : event("content_block_delta", {
        type: "content_block_delta",
        index: p.blockIndex,
        delta: { type: "thinking_delta", thinking: text },
      });

const finalizeThinkingBlock = (p: ConvertCodexResponseToClaudeParams): string => {
  if (!p.thinkingBlockOpen) return "";
  let out = "";

  // A commentary block carries the internal marker, never a pending reasoning signature.
  let signature = "";

  if (p.commentaryMessageOpen) signature = CODEX_COMMENTARY_SIGNATURE_MARKER;
  else if (p.thinkingSignature !== "") {
    signature = p.thinkingSignature;
    p.thinkingSignature = "";
  }

  if (signature !== "") {
    out += event("content_block_delta", {
      type: "content_block_delta",
      index: p.blockIndex,
      delta: { type: "signature_delta", signature },
    });
  }

  out += event("content_block_stop", { type: "content_block_stop", index: p.blockIndex });
  p.blockIndex++;
  p.thinkingBlockOpen = false;

  return out;
};

/** `finalizeCodexCommentaryBlock`: closes the thinking block that carries a commentary message. */
const finalizeCommentaryBlock = (p: ConvertCodexResponseToClaudeParams): string =>
  p.commentaryMessageOpen && p.thinkingBlockOpen ? finalizeThinkingBlock(p) : "";

const finalizeSignatureOnlyThinkingBlock = (p: ConvertCodexResponseToClaudeParams): string => {
  if (p.thinkingSignature === "") return "";

  return startThinkingBlock(p) + finalizeThinkingBlock(p);
};

// ---------------------------------------------------------------------------------------------------------------
// Function calls
// ---------------------------------------------------------------------------------------------------------------

const uniqueKey = (keys: string[], key: string): string[] => {
  if (key === "" || keys.includes(key)) return keys;
  keys.push(key);

  return keys;
};

const functionCallKeys = (root: Json | undefined, item: Json | undefined): string[] => {
  const keys: string[] = [];
  const outputIndex = get(root, "output_index");

  if (outputIndex !== undefined) uniqueKey(keys, `output:${JSON.stringify(outputIndex)}`);
  const itemCallId = asString(get(item, "call_id"));

  if (itemCallId !== "") uniqueKey(keys, `call:${itemCallId}`);
  const rootCallId = asString(get(root, "call_id"));

  if (rootCallId !== "") uniqueKey(keys, `call:${rootCallId}`);
  const itemId = asString(get(item, "id"));

  if (itemId !== "") uniqueKey(keys, `item:${itemId}`);
  const eventItemId = asString(get(root, "item_id"));

  if (eventItemId !== "") uniqueKey(keys, `item:${eventItemId}`);

  return keys;
};

const functionCallForKeys = (p: ConvertCodexResponseToClaudeParams, keys: readonly string[]) => {
  for (const key of keys) {
    const call = p.functionCalls.get(key);

    if (call !== undefined) return call;
  }

  return undefined;
};

const functionCallForEvent = (
  p: ConvertCodexResponseToClaudeParams,
  root: Json | undefined,
  item: Json | undefined,
) => {
  const keys = functionCallKeys(root, item);

  return keys.length > 0 ? functionCallForKeys(p, keys) : p.lastFunctionCall;
};

const addAliases = (
  p: ConvertCodexResponseToClaudeParams,
  call: CodexFunctionCallStream,
  keys: readonly string[],
) => {
  for (const key of keys) p.functionCalls.set(key, call);
};

const recordFunctionCall = (
  p: ConvertCodexResponseToClaudeParams,
  root: Json | undefined,
  item: Json | undefined,
): CodexFunctionCallStream => {
  const keys = functionCallKeys(root, item);
  let call = functionCallForKeys(p, keys);

  if (call === undefined) {
    call = newCall();
    p.functionCallQueue.push(call);
  }

  addAliases(p, call, keys);
  p.lastFunctionCall = call;

  return call;
};

const newCall = (): CodexFunctionCallStream => ({
  callId: "",
  name: "",
  blockIndex: -1,
  argumentsText: "",
  emittedArgumentsLength: 0,
  hasReceivedArgumentsDelta: false,
  emitInitialEmptyDelta: false,
  started: false,
  done: false,
  closed: false,
});

const updateFunctionCallIdentity = (
  p: ConvertCodexResponseToClaudeParams,
  call: CodexFunctionCallStream,
  root: Json | undefined,
  item: Json | undefined,
): void => {
  const callId = asString(get(item, "call_id"));

  if (callId !== "") call.callId = callId;
  const name = asString(get(item, "name"));

  if (name !== "") call.name = name;
  addAliases(p, call, functionCallKeys(root, item));
};

const updateFunctionCallArguments = (
  call: CodexFunctionCallStream,
  args: string,
  delta: boolean,
): void => {
  if (args === "") return;

  if (delta) {
    call.argumentsText += args;
    call.hasReceivedArgumentsDelta = true;

    return;
  }

  if (!call.hasReceivedArgumentsDelta) {
    call.argumentsText = args;

    return;
  }

  if (args.startsWith(call.argumentsText)) call.argumentsText = args;
};

/** `buildReverseMapFromClaudeOriginalShortToOriginal`. */
const reverseNames = (original: Json | undefined): Map<string, string> => {
  const reverse = new Map<string, string>();

  for (const [name, short] of buildOriginalToShortMap(original)) reverse.set(short, name);

  return reverse;
};

const resolveToolUseName = (original: Json | undefined, name: string): string =>
  reverseNames(original).get(name) ?? name;

const appendFunctionCallStart = (
  original: Json | undefined,
  callId: string,
  name: string,
  blockIndex: number,
) =>
  event("content_block_start", {
    type: "content_block_start",
    index: blockIndex,
    content_block: {
      type: "tool_use",
      id: shortenCodexCallIdIfNeeded(sanitizeClaudeToolId(callId)),
      name: resolveToolUseName(original, name),
      input: {},
    },
  });

const appendFunctionCallArgumentDelta = (partialJson: string, blockIndex: number) =>
  event("content_block_delta", {
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });

const appendFunctionCallBufferedArguments = (
  p: ConvertCodexResponseToClaudeParams,
  call: CodexFunctionCallStream | undefined,
): string => {
  if (call === undefined || p.activeFunctionCall !== call || !call.started || call.closed)
    return "";

  if (call.emittedArgumentsLength >= call.argumentsText.length) return "";

  const out = appendFunctionCallArgumentDelta(
    call.argumentsText.slice(call.emittedArgumentsLength),
    call.blockIndex,
  );

  call.emittedArgumentsLength = call.argumentsText.length;

  return out;
};

const appendFunctionCallQueue = (
  p: ConvertCodexResponseToClaudeParams,
  original: Json | undefined,
): string => {
  let out = "";

  for (;;) {
    const active = p.activeFunctionCall;

    if (active !== undefined) {
      out += appendFunctionCallBufferedArguments(p, active);

      if (!active.done) return out;
      out += event("content_block_stop", { type: "content_block_stop", index: active.blockIndex });

      if (p.blockIndex <= active.blockIndex) p.blockIndex = active.blockIndex + 1;
      active.closed = true;
      p.activeFunctionCall = undefined;
      const at = p.functionCallQueue.indexOf(active);

      if (at >= 0) p.functionCallQueue.splice(at, 1);
    }

    // SAFETY: the first loop condition checks the queue is non-empty, so index 0 exists.
    while (
      p.functionCallQueue.length > 0 &&
      (p.functionCallQueue[0] as CodexFunctionCallStream).closed
    ) {
      p.functionCallQueue.shift();
    }

    const call = p.functionCallQueue[0];

    if (call === undefined) return out;

    if (call.name === "") return out;
    call.blockIndex = p.blockIndex;
    out += appendFunctionCallStart(original, call.callId, call.name, call.blockIndex);

    if (call.emitInitialEmptyDelta) out += appendFunctionCallArgumentDelta("", call.blockIndex);
    call.started = true;
    p.activeFunctionCall = call;
    p.hasEmittedToolUse = true;
    out += appendFunctionCallBufferedArguments(p, call);
  }
};

const appendFunctionCallsFromTerminal = (
  p: ConvertCodexResponseToClaudeParams,
  original: Json | undefined,
  responseData: Json | undefined,
): string => {
  const output = get(responseData, "output");

  if (isJsonArray(output)) {
    output.forEach((item, index) => {
      if (asString(get(item, "type")) !== "function_call") return;
      const keys = functionCallKeys(undefined, item);
      const itemOutputIndex = get(item, "output_index");

      if (itemOutputIndex !== undefined)
        uniqueKey(keys, `output:${JSON.stringify(itemOutputIndex)}`);
      uniqueKey(keys, `output:${index}`);
      let call = functionCallForKeys(p, keys);

      if (call === undefined) {
        call = newCall();
        p.functionCallQueue.push(call);
      }

      addAliases(p, call, keys);
      updateFunctionCallIdentity(p, call, undefined, item);
      updateFunctionCallArguments(call, asString(get(item, "arguments")), false);
      call.done = true;
    });
  }

  const queued: CodexFunctionCallStream[] = [];

  for (const call of p.functionCallQueue) {
    if (call.closed) continue;

    if (call.name === "") {
      call.closed = true;
      continue;
    }

    call.done = true;
    queued.push(call);
  }

  p.functionCallQueue = queued;
  const out = appendFunctionCallQueue(p, original);
  p.functionCalls.clear();
  p.functionCallQueue = [];
  p.activeFunctionCall = undefined;
  p.lastFunctionCall = undefined;

  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------------------------------------------

const firstTrimmed = (
  root: Json | undefined,
  item: Json | undefined,
  paths: readonly string[],
): string => {
  for (const path of paths) {
    const fromItem = asString(get(item, path)).trim();

    if (fromItem !== "") return fromItem;
    const fromRoot = asString(get(root, path)).trim();

    if (fromRoot !== "") return fromRoot;
  }

  return "";
};

const webSearchToolUseId = (
  p: ConvertCodexResponseToClaudeParams,
  root: Json | undefined,
  item: Json | undefined,
) => {
  const first = firstTrimmed(root, item, ["id", "output_item_id", "call_id"]);

  if (first !== "") return first;

  if (p.lastWebSearchToolUseId !== "") return p.lastWebSearchToolUseId;
  const second = firstTrimmed(root, item, ["item_id"]);

  if (second !== "") return second;
  const id = `web_search_${p.blockIndex}`;
  p.lastWebSearchToolUseId = id;

  return id;
};

const webSearchQuery = (root: Json | undefined, item: Json | undefined): string =>
  firstTrimmed(root, item, ["action.query", "query", "input.query"]);

/** `codexWebSearchResultContent`: `undefined` when there is no results array. */
const webSearchResultContent = (
  root: Json | undefined,
  item: Json | undefined,
): Json[] | undefined => {
  let results: Json[] | undefined;

  for (const candidate of [
    get(item, "results"),
    get(root, "results"),
    get(item, "action.sources"),
    get(root, "action.sources"),
  ]) {
    if (isJsonArray(candidate)) {
      results = candidate;
      break;
    }
  }

  if (results === undefined) return undefined;
  const blocks: Json[] = [];

  for (const result of results) {
    const url = asString(get(result, "url")).trim();

    if (url === "") continue;
    const title = asString(get(result, "title")).trim();
    blocks.push({
      type: "web_search_result",
      title: title === "" ? url : title,
      url,
      page_age: null,
    });
  }

  return blocks;
};

const appendWebSearchServerToolUse = (
  p: ConvertCodexResponseToClaudeParams,
  root: Json | undefined,
  item: Json | undefined,
): string => {
  const toolUseId = webSearchToolUseId(p, root, item);

  if (toolUseId === "") return "";
  const query = webSearchQuery(root, item);
  const alreadyStarted = p.webSearchToolUseIds.has(toolUseId);

  if (alreadyStarted && query === "") return "";
  let out = "";

  if (!alreadyStarted) {
    out += stopTextBlock(p);
    out += finalizeThinkingBlock(p);
    out += event("content_block_start", {
      type: "content_block_start",
      index: p.blockIndex,
      content_block: { type: "server_tool_use", id: toolUseId, name: "web_search", input: {} },
    });
  }

  if (query !== "") {
    out += event("content_block_delta", {
      type: "content_block_delta",
      index: p.blockIndex,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
    });
  }

  if (!alreadyStarted) {
    out += event("content_block_stop", { type: "content_block_stop", index: p.blockIndex });
    p.webSearchToolUseIds.add(toolUseId);
    p.blockIndex++;
  }

  return out;
};

const appendWebSearchToolResult = (
  p: ConvertCodexResponseToClaudeParams,
  root: Json | undefined,
  item: Json | undefined,
): string => {
  const toolUseId = webSearchToolUseId(p, root, item);

  if (toolUseId === "") return "";
  let out = appendWebSearchServerToolUse(p, root, item);

  if (p.webSearchToolResultIds.has(toolUseId)) return out;
  const content = webSearchResultContent(root, item);

  // Go tests `len(content) == 0` on the raw JSON, which is never empty when a results array exists.
  if (
    webSearchQuery(root, item) === "" &&
    content === undefined &&
    get(item, "action") === undefined
  )
    return out;
  const block: JsonObject = { type: "web_search_tool_result", tool_use_id: toolUseId, content: [] };

  if (content !== undefined && content.length > 0) block["content"] = content;
  out += event("content_block_start", {
    type: "content_block_start",
    index: p.blockIndex,
    content_block: block,
  });
  out += event("content_block_stop", { type: "content_block_stop", index: p.blockIndex });
  p.webSearchToolResultIds.add(toolUseId);
  p.blockIndex++;

  if (toolUseId === p.lastWebSearchToolUseId) p.lastWebSearchToolUseId = "";

  return out;
};

const appendWebSearchNonStreamBlocks = (
  blocks: Json[],
  item: Json | undefined,
  seen: Set<string>,
): void => {
  const id = asString(get(item, "id")).trim();

  if (id === "" || seen.has(id)) return;
  const query = webSearchQuery(undefined, item);
  const resultContent = webSearchResultContent(undefined, item);

  if (query === "" && resultContent === undefined) return;
  const use: JsonObject = { type: "server_tool_use", id, name: "web_search", input: {} };

  if (query !== "") use["input"] = { query };
  blocks.push(use);
  const result: JsonObject = { type: "web_search_tool_result", tool_use_id: id, content: [] };

  if (resultContent !== undefined) result["content"] = resultContent;
  blocks.push(result);
  seen.add(id);
};

// ---------------------------------------------------------------------------------------------------------------
// Usage and stop reasons
// ---------------------------------------------------------------------------------------------------------------

/** `extractResponsesUsage`: [input (minus cached/cache-write), output, cached, cache write]. */
const extractResponsesUsage = (
  usage: Json | undefined,
): readonly [number, number, number, number] => {
  if (usage === undefined || usage === null) return [0, 0, 0, 0];
  let inputTokens = asInt(get(usage, "input_tokens"));
  const outputTokens = asInt(get(usage, "output_tokens"));
  const cachedTokens = asInt(get(usage, "input_tokens_details.cached_tokens"));
  let cacheWriteTokens = asInt(get(usage, "input_tokens_details.cache_write_tokens"));

  if (cacheWriteTokens <= 0)
    cacheWriteTokens = asInt(get(usage, "input_tokens_details.cache_creation_tokens"));
  let deduct = 0;

  if (cachedTokens > 0) deduct += cachedTokens;

  if (cacheWriteTokens > 0) deduct += cacheWriteTokens;

  if (deduct > 0) inputTokens = inputTokens >= deduct ? inputTokens - deduct : 0;

  if (inputTokens < 0) inputTokens = 0;

  return [inputTokens, outputTokens, cachedTokens, cacheWriteTokens];
};

/** `setClaudeReasoningUsage`: `usage.output_tokens_details.thinking_tokens`, capped by the output tokens. */
const setReasoningUsage = (out: Json, usage: Json | undefined): Json => {
  const detail = get(usage, "output_tokens_details.reasoning_tokens");

  if (typeof detail !== "number" || detail < 0) return out;
  const outputTokens = Math.max(0, asInt(get(usage, "output_tokens")));
  const tokens = detail >= outputTokens ? outputTokens : Math.trunc(detail);

  return set(out, "usage.output_tokens_details.thinking_tokens", tokens);
};

const stopSequenceOf = (responseData: Json | undefined): Json | undefined =>
  get(responseData, "stop_sequence");

const setStopSequence = (out: Json, path: string, responseData: Json | undefined): Json => {
  const stopSequence = stopSequenceOf(responseData);

  return stopSequence !== undefined && asString(stopSequence) !== ""
    ? set(out, path, stopSequence)
    : out;
};

const codexStopReason = (responseData: Json | undefined): string => {
  const stopReason = get(responseData, "stop_reason");

  if (stopReason !== undefined && asString(stopReason) !== "") {
    if (asString(stopReason) === "stop" && asString(stopSequenceOf(responseData)) !== "")
      return "stop_sequence";

    return asString(stopReason);
  }

  const reason = get(responseData, "incomplete_details.reason");

  if (reason !== undefined && asString(reason) !== "") return asString(reason);

  return asString(stopSequenceOf(responseData)) !== "" ? "stop_sequence" : "";
};

const mapStopReasonToClaude = (stopReason: string, hasToolCall: boolean): string => {
  if (hasToolCall) return "tool_use";

  switch (stopReason) {
    case "":
    case "stop":
    case "completed":
      return "end_turn";
    case "max_tokens":
    case "max_output_tokens":
      return "max_tokens";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case "refusal":
    case "model_context_window_exceeded":
      return stopReason;
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------------------------------------------

const streamErrorToClaudeError = (root: Json | undefined): string => {
  let errType = asString(get(root, "error.type")).trim();

  if (errType === "") errType = asString(get(root, "error_type")).trim();

  if (errType === "") errType = "api_error";
  const code = asString(get(root, "error.code")).trim();
  let message = asString(get(root, "error.message")).trim();

  if (message === "") message = asString(get(root, "message")).trim();

  if (message === "") message = code;

  if (message === "") message = errType;

  if (code === "cyber_policy" || errType === "invalid_request") errType = "invalid_request_error";

  return event("error", { type: "error", error: { type: errType, message } });
};

const shouldDeferStreamEvent = (type: string, root: Json | undefined): boolean => {
  switch (type) {
    case "error":
    case "response.completed":
    case "response.incomplete":
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done":
      return false;
    case "response.output_item.added":
    case "response.output_item.done":
      return asString(get(root, "item.type")) !== "function_call";
    default:
      return true;
  }
};

const appendDeferredStreamEvents = (
  context: ResponseContext,
  p: ConvertCodexResponseToClaudeParams,
): string => {
  if (p.deferredStreamEvents.length === 0) return "";
  const events = p.deferredStreamEvents;
  p.deferredStreamEvents = [];
  let out = "";

  for (const deferred of events) out += convertCodexResponseToClaude(context, deferred).join("");

  return out;
};

/** `ConvertCodexResponseToClaude`. */
export const convertCodexResponseToClaude = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  if (context.state.value === undefined) context.state.value = newParams();
  // SAFETY: this translator is the only writer of `state.value` and initialises it to a ConvertCodexResponseToClaudeParams before this read.
  const p = context.state.value as ConvertCodexResponseToClaudeParams;

  if (!line.startsWith("data:")) return [];
  const root = tryParseJson(line.slice(5).trim());
  const original = context.originalRequest;
  const type = asString(get(root, "type"));

  if (p.activeFunctionCall !== undefined && shouldDeferStreamEvent(type, root)) {
    p.deferredStreamEvents.push(line);

    return [];
  }

  let out = "";

  switch (type) {
    case "error":
      out += streamErrorToClaudeError(root);
      break;
    case "response.created":
      out += event("message_start", {
        type: "message_start",
        message: {
          id: asString(get(root, "response.id")),
          type: "message",
          role: "assistant",
          model: asString(get(root, "response.model")),
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [],
          stop_reason: null,
        },
      });
      break;
    case "response.reasoning_summary_part.added":
      out += stopTextBlock(p);
      out += finalizeCommentaryBlock(p);
      p.commentaryMessageOpen = false;

      // One thinking block spans the whole reasoning item; only output_item.done carries the final signature.
      if (p.thinkingBlockOpen) out += appendThinkingDelta(p, SUMMARY_PART_SEPARATOR);
      else out += startThinkingBlock(p);
      p.thinkingSummarySeen = true;
      break;
    case "response.reasoning_summary_text.delta":
      out += stopTextBlock(p);
      out += finalizeCommentaryBlock(p);
      p.commentaryMessageOpen = false;
      out += startThinkingBlock(p);
      out += appendThinkingDelta(p, asString(get(root, "delta")));
      break;
    case "response.reasoning_summary_part.done":
      // Intentionally does not close the thinking block (see above).
      break;
    case "response.content_part.added":
      if (asString(get(root, "part.type")) === "output_text") {
        if (p.commentaryMessageOpen) out += startThinkingBlock(p);
        else out += finalizeThinkingBlock(p) + startTextBlock(p);
      } else {
        out += finalizeThinkingBlock(p);
      }

      break;
    case "response.output_text.delta":
      p.hasTextDelta = true;

      if (p.commentaryMessageOpen) {
        out += startThinkingBlock(p);
        out += appendThinkingDelta(p, asString(get(root, "delta")));
        break;
      }

      out += finalizeThinkingBlock(p);
      out += startTextBlock(p);
      out += event("content_block_delta", {
        type: "content_block_delta",
        index: p.blockIndex,
        delta: { type: "text_delta", text: asString(get(root, "delta")) },
      });
      break;
    case "response.content_part.done":
      if (asString(get(root, "part.type")) === "output_text")
        out += p.commentaryMessageOpen ? finalizeCommentaryBlock(p) : stopTextBlock(p);
      break;
    case "response.web_search_call.searching":
    case "response.web_search_call.completed":
    case "response.web_search_call.in_progress":
      // Wait for populated web_search_call items on output_item.done.
      break;
    case "response.completed":
    case "response.incomplete": {
      let template: Json = {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      };

      const responseData = get(root, "response");
      out += finalizeThinkingBlock(p);
      out += stopTextBlock(p);
      out += appendFunctionCallsFromTerminal(p, original, responseData);
      out += appendDeferredStreamEvents(context, p);
      out += finalizeThinkingBlock(p);
      out += stopTextBlock(p);
      template = set(
        template,
        "delta.stop_reason",
        mapStopReasonToClaude(codexStopReason(responseData), p.hasEmittedToolUse),
      );
      template = setStopSequence(template, "delta.stop_sequence", responseData);

      const [inputTokens, outputTokens, cachedTokens, cacheWriteTokens] = extractResponsesUsage(
        get(responseData, "usage"),
      );

      template = set(template, "usage.input_tokens", inputTokens);
      template = set(template, "usage.output_tokens", outputTokens);

      if (cachedTokens > 0) template = set(template, "usage.cache_read_input_tokens", cachedTokens);

      if (cacheWriteTokens > 0)
        template = set(template, "usage.cache_creation_input_tokens", cacheWriteTokens);
      template = setReasoningUsage(template, get(responseData, "usage"));
      out += event("message_delta", template);
      out += event("message_stop", { type: "message_stop" });
      break;
    }

    case "response.output_item.added": {
      const item = get(root, "item");

      switch (asString(get(item, "type"))) {
        case "message":
          // Each message item streams its own text; a later item's done fallback must not be skipped.
          out += finalizeThinkingBlock(p);
          out += stopTextBlock(p);
          p.hasTextDelta = false;
          p.commentaryMessageOpen = asString(get(item, "phase")) === "commentary";
          break;
        case "function_call": {
          out += finalizeThinkingBlock(p);
          out += stopTextBlock(p);
          p.commentaryMessageOpen = false;
          const call = recordFunctionCall(p, root, item);
          updateFunctionCallIdentity(p, call, root, item);

          if (call.name !== "") call.emitInitialEmptyDelta = true;
          out += appendFunctionCallQueue(p, original);
          break;
        }

        case "reasoning":
          out += stopTextBlock(p);
          // A previous reasoning item that never reported output_item.done must not leak its open block.
          out += finalizeThinkingBlock(p);
          p.commentaryMessageOpen = false;
          p.thinkingSummarySeen = false;
          // Fallback only: a pre-content snapshot, never the final value.
          p.thinkingSignature = asString(get(item, "encrypted_content"));
          break;
        case "web_search_call":
          // Defer server_tool_use until output_item.done carries action/query.
          break;
      }

      break;
    }

    case "response.output_item.done": {
      const item = get(root, "item");

      switch (asString(get(item, "type"))) {
        case "message": {
          const commentary =
            p.commentaryMessageOpen || asString(get(item, "phase")) === "commentary";

          try {
            if (p.hasTextDelta) {
              if (commentary) out += finalizeCommentaryBlock(p);

              return [out];
            }

            const content = get(item, "content");

            if (!isJsonArray(content)) return [out];
            let text = "";

            for (const part of content) {
              if (asString(get(part, "type")) !== "output_text") continue;
              const partText = asString(get(part, "text"));

              if (partText !== "") text += partText;
            }

            if (text === "") return [out];

            if (commentary) {
              // Whole on done, nothing streamed: emit it as thinking.
              out += finalizeThinkingBlock(p);
              out += stopTextBlock(p);
              p.commentaryMessageOpen = true;
              out += startThinkingBlock(p);
              out += appendThinkingDelta(p, text);
              out += finalizeCommentaryBlock(p);

              return [out];
            }

            out += finalizeThinkingBlock(p);
            out += startTextBlock(p);
            out += event("content_block_delta", {
              type: "content_block_delta",
              index: p.blockIndex,
              delta: { type: "text_delta", text },
            });
            out += stopTextBlock(p);
          } finally {
            p.commentaryMessageOpen = false;
            p.hasTextDelta = false;
          }

          break;
        }

        case "function_call": {
          out += finalizeThinkingBlock(p);
          out += stopTextBlock(p);
          let call = functionCallForEvent(p, root, item);
          call ??= recordFunctionCall(p, root, item);
          updateFunctionCallIdentity(p, call, root, item);
          updateFunctionCallArguments(call, asString(get(item, "arguments")), false);
          call.done = true;
          out += appendFunctionCallQueue(p, original);
          break;
        }

        case "reasoning": {
          out += stopTextBlock(p);
          out += finalizeCommentaryBlock(p);
          p.commentaryMessageOpen = false;
          const signature = asString(get(item, "encrypted_content"));

          if (signature !== "") p.thinkingSignature = signature;
          out += p.thinkingSummarySeen
            ? finalizeThinkingBlock(p)
            : finalizeSignatureOnlyThinkingBlock(p);
          p.thinkingSignature = "";
          p.thinkingSummarySeen = false;
          break;
        }

        case "web_search_call":
          out += appendWebSearchToolResult(p, root, item);
          break;
      }

      break;
    }

    case "response.function_call_arguments.delta": {
      let call = functionCallForEvent(p, root, undefined);
      call ??= recordFunctionCall(p, root, undefined);
      updateFunctionCallArguments(call, asString(get(root, "delta")), true);
      out += appendFunctionCallBufferedArguments(p, call);
      break;
    }

    case "response.function_call_arguments.done": {
      let call = functionCallForEvent(p, root, undefined);
      call ??= recordFunctionCall(p, root, undefined);
      updateFunctionCallArguments(call, asString(get(root, "arguments")), false);
      out += appendFunctionCallBufferedArguments(p, call);
      break;
    }
  }

  if (p.functionCallQueue.length === 0) out += appendDeferredStreamEvents(context, p);

  return [out];
};

// ---------------------------------------------------------------------------------------------------------------
// Non-stream
// ---------------------------------------------------------------------------------------------------------------

const textOfParts = (value: Json): string => {
  let text = "";

  if (isJsonArray(value)) {
    for (const part of value) {
      const t = get(part, "text");
      text += t !== undefined ? asString(t) : asString(part);
    }
  } else {
    text = asString(value);
  }

  return text;
};

/** `ConvertCodexResponseToClaudeNonStream`. */
export const convertCodexResponseToClaudeNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const type = asString(get(root, "type"));

  if (type !== "response.completed" && type !== "response.incomplete") return "";
  const responseData = get(root, "response");

  if (responseData === undefined) return "";
  const revNames = reverseNames(context.originalRequest);

  let out: Json = {
    id: "",
    type: "message",
    role: "assistant",
    model: "",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  out = set(out, "id", asString(get(responseData, "id")));
  out = set(out, "model", asString(get(responseData, "model")));

  const [inputTokens, outputTokens, cachedTokens, cacheWriteTokens] = extractResponsesUsage(
    get(responseData, "usage"),
  );

  out = set(out, "usage.input_tokens", inputTokens);
  out = set(out, "usage.output_tokens", outputTokens);

  if (cachedTokens > 0) out = set(out, "usage.cache_read_input_tokens", cachedTokens);

  if (cacheWriteTokens > 0) out = set(out, "usage.cache_creation_input_tokens", cacheWriteTokens);
  out = setReasoningUsage(out, get(responseData, "usage"));

  let hasToolCall = false;
  const webSearchSeen = new Set<string>();
  const blocks: Json[] = [];
  const output = get(responseData, "output");

  if (isJsonArray(output)) {
    for (const item of output) {
      switch (asString(get(item, "type"))) {
        case "reasoning": {
          let thinking = "";
          const signature = asString(get(item, "encrypted_content"));
          const summary = get(item, "summary");

          if (summary !== undefined) thinking += textOfParts(summary);

          if (thinking === "") {
            const content = get(item, "content");

            if (content !== undefined) thinking += textOfParts(content);
          }

          if (thinking.length > 0 || signature !== "") {
            const block: JsonObject = { type: "thinking", thinking };

            if (signature !== "") block["signature"] = signature;
            blocks.push(block);
          }

          break;
        }

        case "message": {
          const content = get(item, "content");

          if (content === undefined) break;
          // A commentary message is the model's preamble, not its answer: relay it as marked thinking.
          const commentary = asString(get(item, "phase")) === "commentary";

          const textBlock = (text: string): Json =>
            commentary
              ? {
                  type: "thinking",
                  thinking: text,
                  signature: CODEX_COMMENTARY_SIGNATURE_MARKER,
                }
              : { type: "text", text };

          if (isJsonArray(content)) {
            for (const part of content) {
              if (asString(get(part, "type")) !== "output_text") continue;
              const text = asString(get(part, "text"));

              if (text !== "") blocks.push(textBlock(text));
            }
          } else {
            const text = asString(content);

            if (text !== "") blocks.push(textBlock(text));
          }

          break;
        }

        case "web_search_call":
          appendWebSearchNonStreamBlocks(blocks, item, webSearchSeen);
          break;
        case "function_call": {
          hasToolCall = true;
          const name = asString(get(item, "name"));
          let input: Json = {};
          const argsText = asString(get(item, "arguments"));

          if (argsText !== "") {
            const parsed = tryParseJson(argsText);

            if (
              parsed !== undefined &&
              typeof parsed === "object" &&
              parsed !== null &&
              !Array.isArray(parsed)
            )
              input = parsed;
          }

          blocks.push({
            type: "tool_use",
            id: shortenCodexCallIdIfNeeded(sanitizeClaudeToolId(asString(get(item, "call_id")))),
            name: revNames.get(name) ?? name,
            input,
          });
          break;
        }
      }
    }
  }

  if (blocks.length > 0) out = set(out, "content", blocks);
  out = set(out, "stop_reason", mapStopReasonToClaude(codexStopReason(responseData), hasToolCall));
  out = setStopSequence(out, "stop_sequence", responseData);

  return JSON.stringify(out);
};

/** `ClaudeTokenCount`. */
export const claudeTokenCount = (count: number): string => claudeInputTokensJson(count);

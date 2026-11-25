/**
 * Antigravity provider -> OpenAI Chat Completions client (response).
 *
 * Go source: internal/translator/antigravity/openai/chat-completions/antigravity_openai_response.go. Stream lines are
 * JSON payloads (the executor strips `data:`); the non-stream conversion delegates to the Gemini one like Go.
 */
import {
  asBool,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import {
  convertGeminiResponseToOpenAINonStream,
  usageFields,
} from "../../gemini/openai/chat-response.ts";
import { functionCallId, isContentFilterFinishReason } from "../../common/gemini-response.ts";
import {
  disambiguatedToolNameMap,
  type NameMap,
  restoreSanitizedToolName,
} from "../../common/tool-names.ts";
import {
  functionCallEndsContinuation,
  functionCallWillContinue,
} from "../../common/gemini-parts.ts";
import { hasAntigravityResponsePayload } from "../common/payload.ts";

/** One streamed tool call (`antigravityOpenAIToolCall`). */
interface ToolCall {
  readonly index: number;
  readonly rawName: string;
  readonly upstreamId: string;
  /** Upstream announced more chunks for this call (`willContinue`). */
  readonly streaming: boolean;
  argumentsStarted: boolean;
  argumentsHasItems: boolean;
  argumentsClosed: boolean;
}

interface Params {
  unixTimestamp: number;
  functionIndex: number;
  sawResponse: boolean;
  sawToolCall: boolean;
  sawFinishReason: boolean;
  upstreamFinishReason: string;
  modelVersion: string;
  responseId: string;
  pendingUsageMetadata: Json | undefined;
  sanitizedNameMap: NameMap | null;
  activeToolCall: ToolCall | undefined;
  toolCallsById: Map<string, ToolCall>;
  toolCalls: ToolCall[];
}

const paramsOf = (context: ResponseContext): Params => {
  if (context.state.value === undefined) {
    const fresh: Params = {
      unixTimestamp: 0,
      functionIndex: 0,
      sawResponse: false,
      sawToolCall: false,
      sawFinishReason: false,
      upstreamFinishReason: "",
      modelVersion: "",
      responseId: "",
      pendingUsageMetadata: undefined,
      sanitizedNameMap: null,
      activeToolCall: undefined,
      toolCallsById: new Map(),
      toolCalls: [],
    };

    context.state.value = fresh;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  return context.state.value as Params;
};

type ResolveFinishReasonResult = { finishReason: string; nativeFinishReason: string };

/** `resolveOpenAIFinishReason`: upstream `MAX_TOKENS` is OpenAI's `length` (CLIProxyAPI 07290e18). */
const resolveFinishReason = (params: Params): ResolveFinishReasonResult => {
  let finishReason = "stop";

  if (params.sawToolCall) finishReason = "tool_calls";
  else if (params.upstreamFinishReason === "MAX_TOKENS") finishReason = "length";
  else if (isContentFilterFinishReason(params.upstreamFinishReason))
    finishReason = "content_filter";

  return {
    finishReason,
    nativeFinishReason:
      params.upstreamFinishReason !== "" ? params.upstreamFinishReason.toLowerCase() : "stop",
  };
};

const setUsage = (template: JsonObject, usage: Json): void => usageFields(usage, template);

const chunkTemplate = (params: Params, created: number): JsonObject => {
  const template: JsonObject = {
    id: "",
    object: "chat.completion.chunk",
    created,
    model: "model",
    choices: [
      {
        index: 0,
        delta: { role: null, content: null, reasoning_content: null },
        finish_reason: null,
        native_finish_reason: null,
      },
    ],
  };

  if (params.modelVersion !== "") template["model"] = params.modelVersion;

  if (params.responseId !== "") template["id"] = params.responseId;

  return template;
};

/** The first choice's delta of a template built by {@link chunkTemplate}. */
const deltaOf = (template: JsonObject): JsonObject =>
  // SAFETY: `chunkTemplate` builds `choices` as a one-element array whose choice has an object `delta`.
  ((template["choices"] as JsonObject[])[0] as JsonObject)["delta"] as JsonObject;

/**
 * `buildAntigravityOpenAITerminalChunkDoc`: the finish reason goes in a chunk of its own, with an empty delta: strict
 * Chat Completions parsers reject a delta payload beside a finish reason (CLIProxyAPI 8cd6817b).
 */
const terminalChunk = (params: Params, usage: Json | undefined): JsonObject => {
  const { finishReason, nativeFinishReason } = resolveFinishReason(params);

  const template: JsonObject = {
    id: params.responseId,
    object: "chat.completion.chunk",
    created: params.unixTimestamp,
    model: params.modelVersion !== "" ? params.modelVersion : "model",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
        native_finish_reason: nativeFinishReason,
      },
    ],
  };

  if (usage !== undefined) setUsage(template, usage);

  return template;
};

/** The members of an argument object without its braces, or undefined for anything but an object. */
const objectMembers = (args: Json | undefined): string | undefined => {
  if (!isJsonObject(args)) return undefined;
  const raw = JSON.stringify(args);

  return raw.slice(1, -1).trim();
};

/** `antigravityOpenAIStartArguments`: the opening of a call's arguments that later chunks continue. */
const startArguments = (call: ToolCall, args: Json | undefined): string => {
  const members = objectMembers(args);

  if (members === undefined) return "";
  call.argumentsStarted = true;
  call.argumentsHasItems = members !== "";

  return `{${members}`;
};

/** `antigravityOpenAIContinuationArguments`: a continuation chunk's members, joined onto the open arguments. */
const continuationArguments = (call: ToolCall, args: Json | undefined): string => {
  if (call.argumentsClosed) return "";
  const members = objectMembers(args);

  if (members === undefined) return "";

  if (!call.argumentsStarted) {
    call.argumentsStarted = true;

    if (members === "") return "{";
    call.argumentsHasItems = true;

    return `{${members}`;
  }

  if (members === "") return "";
  const prefix = call.argumentsHasItems ? "," : "";
  call.argumentsHasItems = true;

  return prefix + members;
};

/** `antigravityOpenAILateContinuationArguments`: arguments that arrive after the call closed, sent whole. */
const lateContinuationArguments = (args: Json | undefined): string => {
  const members = objectMembers(args);

  return members === undefined || members === "" ? "" : JSON.stringify(args);
};

/** `hasOpenAntigravityOpenAIToolArguments`. */
const hasOpenToolArguments = (params: Params): boolean =>
  params.toolCalls.some(
    (call) => !call.argumentsClosed && (call.argumentsStarted || call.streaming),
  );

const appendToolCallDelta = (template: JsonObject, index: number, args: string): void => {
  const delta = deltaOf(template);

  const existing = delta["tool_calls"];
  const calls: Json[] = isJsonArray(existing) ? existing : [];
  delta["tool_calls"] = calls;
  calls.push({ index, function: { arguments: args } });
};

/** `appendAntigravityOpenAIToolCallCloses`: closes every open call's arguments; true if any was closed. */
const appendToolCallCloses = (template: JsonObject, params: Params): boolean => {
  let appended = false;

  for (const call of params.toolCalls) {
    if (call.argumentsClosed || (!call.argumentsStarted && !call.streaming)) continue;
    let closing = "}";

    if (!call.argumentsStarted) {
      closing = "{}";
      call.argumentsStarted = true;
    }

    appendToolCallDelta(template, call.index, closing);
    call.argumentsClosed = true;
    appended = true;
  }

  return appended;
};

/**
 * `ConvertAntigravityResponseToOpenAI`. A call streamed over several chunks (`willContinue`) is announced once and
 * its arguments continue as deltas of the same index, closed when it ends, when text follows, or at the end of the
 * stream (CLIProxyAPI fe571afe, 4df055de). Go's `partialArgs` assembly is not ported (docs/ARCHITECTURE.md).
 */
export const convertAntigravityResponseToOpenAI = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const params = paramsOf(context);

  if (params.sanitizedNameMap === null)
    params.sanitizedNameMap = disambiguatedToolNameMap(context.originalRequest);

  if (line === "[DONE]") {
    // Never finalize a stream that produced no response at all.
    if (!params.sawResponse || params.sawFinishReason) return [];
    params.sawFinishReason = true;
    const terminal = terminalChunk(params, params.pendingUsageMetadata);

    if (hasOpenToolArguments(params)) {
      const close = chunkTemplate(params, params.unixTimestamp);

      if (appendToolCallCloses(close, params)) {
        params.activeToolCall = undefined;

        return [JSON.stringify(close), JSON.stringify(terminal)];
      }
    }

    return [JSON.stringify(terminal)];
  }

  const raw = tryParseJson(line);

  if (!params.sawResponse) params.sawResponse = hasAntigravityResponsePayload(raw);

  const modelVersion = get(raw, "response.modelVersion");

  if (modelVersion !== undefined) params.modelVersion = asString(modelVersion);
  const createTime = get(raw, "response.createTime");

  if (createTime !== undefined) {
    const ms = Date.parse(asString(createTime));

    if (!Number.isNaN(ms)) params.unixTimestamp = Math.floor(ms / 1000);
  }

  const responseId = get(raw, "response.responseId");

  if (responseId !== undefined) params.responseId = asString(responseId);

  // `tool_calls` is omitted unless the chunk carries calls (dfe0a0ef). The model and id of earlier chunks carry over.
  const template = chunkTemplate(params, params.unixTimestamp);

  if (modelVersion !== undefined) template["model"] = params.modelVersion;

  if (responseId !== undefined) template["id"] = params.responseId;
  const delta = deltaOf(template);

  // The finish reason is cached and only emitted on the final chunk.
  const finishReason = get(raw, "response.candidates.0.finishReason");

  if (finishReason !== undefined)
    params.upstreamFinishReason = asString(finishReason).toUpperCase();

  // FilterSSEUsageMetadata renames non-terminal usage to cpaUsageMetadata: retain the latest copy for [DONE].
  const usage = get(raw, "response.usageMetadata");

  if (usage === undefined) {
    const pending = get(raw, "response.cpaUsageMetadata");

    if (pending !== undefined) params.pendingUsageMetadata = structuredClone(pending);
  }

  let hasDeltaContent = false;
  let hasNonEmptyDelta = false;
  const parts = get(raw, "response.candidates.0.content.parts");

  if (isJsonArray(parts)) {
    // Text and reasoning accumulate across the chunk's parts (c5251b57).
    let textContent = "";
    let reasoningContent = "";
    let hasTextContent = false;
    let hasReasoningContent = false;
    let imageCount = 0;

    for (const part of parts) {
      const text = get(part, "text");
      const functionCall = get(part, "functionCall");
      const thoughtSignature = get(part, "thoughtSignature") ?? get(part, "thought_signature");
      const inlineData = get(part, "inlineData") ?? get(part, "inline_data");

      const hasThoughtSignature =
        thoughtSignature !== undefined && asString(thoughtSignature) !== "";

      const hasContentPayload =
        (text !== undefined && asString(text) !== "") ||
        functionCall !== undefined ||
        inlineData !== undefined;

      // Ignore an encrypted thoughtSignature but keep any actual content in the same part.
      if (hasThoughtSignature && !hasContentPayload) continue;

      if (text !== undefined) {
        const value = asString(text);

        // Text after a streamed call closes its arguments first.
        if (value !== "" && hasOpenToolArguments(params)) {
          appendToolCallCloses(template, params);
          params.activeToolCall = undefined;
        }

        if (asBool(get(part, "thought"))) {
          hasReasoningContent = true;
          reasoningContent += value;
        } else {
          hasTextContent = true;
          textContent += value;
        }

        delta["role"] = "assistant";
      } else if (functionCall !== undefined) {
        const rawName = asString(get(functionCall, "name")).trim();
        const upstreamId = asString(get(functionCall, "id")).trim();
        const args = get(functionCall, "args");
        const continues = functionCallWillContinue(functionCall);
        let active = params.activeToolCall;

        if (upstreamId !== "") active = params.toolCallsById.get(upstreamId);

        // A nameless chunk continues the active call (CLIProxyAPI 4df055de).
        if (rawName === "") {
          if (active !== undefined) {
            params.sawToolCall = true;
            let argumentDelta: string;

            if (active.argumentsClosed) argumentDelta = lateContinuationArguments(args);
            else {
              argumentDelta = continuationArguments(active, args);

              if (functionCallEndsContinuation(functionCall)) {
                if (active.argumentsStarted) argumentDelta += "}";
                else if (active.streaming) {
                  argumentDelta = "{}";
                  active.argumentsStarted = true;
                }

                active.argumentsClosed = true;
              }
            }

            if (argumentDelta !== "") {
              appendToolCallDelta(template, active.index, argumentDelta);
              delta["role"] = "assistant";
            }

            params.activeToolCall = active;
            continue;
          }

          if (args === undefined) continue;
        }

        params.sawToolCall = true;

        if (!isJsonArray(delta["tool_calls"])) delta["tool_calls"] = [];
        // Indices count calls across the whole stream, not within one chunk (80aa2b1d).
        const index = params.functionIndex;
        params.functionIndex++;
        const name = restoreSanitizedToolName(params.sanitizedNameMap, rawName);

        const call: ToolCall = {
          index,
          rawName,
          upstreamId,
          streaming: continues,
          argumentsStarted: false,
          argumentsHasItems: false,
          argumentsClosed: false,
        };

        // A call without arguments sends `{}`, never an empty string (CLIProxyAPI 28a00389).
        let argumentsText = "{}";

        if (args !== undefined) {
          if (continues) argumentsText = startArguments(call, args);
          else {
            argumentsText = asString(args);
            call.argumentsStarted = true;
            call.argumentsClosed = true;
          }
        } else if (continues) argumentsText = "";
        else {
          call.argumentsStarted = true;
          call.argumentsClosed = true;
        }

        params.activeToolCall = call;
        params.toolCalls.push(call);

        if (upstreamId !== "") params.toolCallsById.set(upstreamId, call);
        delta["role"] = "assistant";
        delta["tool_calls"].push({
          id: functionCallId(name, get(functionCall, "id")),
          index,
          type: "function",
          function: { name, arguments: argumentsText },
        });
      } else if (inlineData !== undefined) {
        if (asBool(get(part, "thought"))) continue;
        const data = asString(get(inlineData, "data"));

        if (data === "") continue;
        let mimeType = asString(get(inlineData, "mimeType"));

        if (mimeType === "") mimeType = asString(get(inlineData, "mime_type"));

        if (mimeType === "") mimeType = "image/png";

        if (!isJsonArray(delta["images"])) delta["images"] = [];
        const images = delta["images"];
        delta["role"] = "assistant";
        images.push({
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${data}` },
          index: imageCount,
        });
        imageCount++;
      }
    }

    if (hasTextContent) delta["content"] = textContent;

    if (hasReasoningContent) delta["reasoning_content"] = reasoningContent;
    const hasToolCalls = isJsonArray(delta["tool_calls"]);
    hasDeltaContent = hasTextContent || hasReasoningContent || hasToolCalls || imageCount > 0;

    hasNonEmptyDelta =
      textContent !== "" || reasoningContent !== "" || hasToolCalls || imageCount > 0;
  }

  // Only the chunk with both finishReason and usage is terminal; [DONE] synthesises one when upstream never sends it.
  const isFinalChunk =
    !params.sawFinishReason && params.upstreamFinishReason !== "" && usage !== undefined;

  if (isFinalChunk && appendToolCallCloses(template, params)) {
    hasDeltaContent = true;
    hasNonEmptyDelta = true;
    params.activeToolCall = undefined;
  }

  if (isFinalChunk) {
    params.sawFinishReason = true;
    const terminal = terminalChunk(params, usage);

    return hasNonEmptyDelta
      ? [JSON.stringify(template), JSON.stringify(terminal)]
      : [JSON.stringify(terminal)];
  }

  if (params.sawFinishReason && !hasNonEmptyDelta) return [];

  if (usage !== undefined) setUsage(template, usage);

  if (!hasDeltaContent && usage === undefined) return [];

  return [JSON.stringify(template)];
};

/** `restoreAntigravityOpenAIFunctionNames`. */
const restoreFunctionNames = (response: Json, originalRequest: Json | undefined): Json => {
  const nameMap = disambiguatedToolNameMap(originalRequest);

  if (nameMap === undefined) return response;
  const candidates = get(response, "candidates");

  if (!isJsonArray(candidates)) return response;

  for (const candidate of candidates) {
    const parts = get(candidate, "content.parts");

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      if (!isJsonObject(part)) continue;

      for (const field of ["functionCall", "functionResponse"]) {
        const nameResult = get(part, `${field}.name`);
        const name = asString(nameResult);

        if (name === "") continue;
        const restored = restoreSanitizedToolName(nameMap, name);

        if (typeof nameResult === "string" && restored === name) continue;
        set(part, `${field}.name`, restored);
      }
    }
  }

  return response;
};

/** `ConvertAntigravityResponseToOpenAINonStream`. */
export const convertAntigravityResponseToOpenAINonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const response = get(tryParseJson(body), "response");

  if (response === undefined) return "";
  const restored = restoreFunctionNames(structuredClone(response), context.originalRequest);

  return convertGeminiResponseToOpenAINonStream(context, JSON.stringify(restored));
};

export const antigravityToOpenAIResponse: ResponseTransform = {
  stream: convertAntigravityResponseToOpenAI,
  nonStream: convertAntigravityResponseToOpenAINonStream,
};

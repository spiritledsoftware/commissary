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
  isContentFilterFinishReason,
  usageFields,
} from "../../gemini/openai/chat-response.ts";
import {
  disambiguatedToolNameMap,
  type NameMap,
  restoreSanitizedToolName,
} from "../../common/tool-names.ts";
import { hasAntigravityResponsePayload } from "../common/payload.ts";

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
}

let functionCallIdCounter = 0;

/** The upstream functionCall `id` when present (da21f1e5), else a unique `name-<unix nano>-<counter>`. */
const functionCallId = (name: string, upstreamId?: Json): string => {
  const explicit = asString(upstreamId).trim();

  if (explicit !== "") return explicit;
  functionCallIdCounter++;

  return `${name}-${Date.now()}000000-${functionCallIdCounter}`;
};

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
    };

    context.state.value = fresh;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  return context.state.value as Params;
};

type ResolveFinishReasonResult = { finishReason: string; nativeFinishReason: string };

/** `resolveOpenAIFinishReason`. */
const resolveFinishReason = (params: Params): ResolveFinishReasonResult => {
  let finishReason = "stop";

  if (params.sawToolCall) finishReason = "tool_calls";
  else if (params.upstreamFinishReason === "MAX_TOKENS") finishReason = "max_tokens";
  else if (isContentFilterFinishReason(params.upstreamFinishReason))
    finishReason = "content_filter";

  return {
    finishReason,
    nativeFinishReason:
      params.upstreamFinishReason !== "" ? params.upstreamFinishReason.toLowerCase() : "stop",
  };
};

const setUsage = (template: JsonObject, usage: Json): void => usageFields(usage, template);

/** `ConvertAntigravityResponseToOpenAI`. */
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
    const { finishReason, nativeFinishReason } = resolveFinishReason(params);

    const template: JsonObject = {
      id: "",
      object: "chat.completion.chunk",
      created: params.unixTimestamp,
      model: "model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "stop" }],
    };

    if (params.modelVersion !== "") template["model"] = params.modelVersion;

    if (params.responseId !== "") template["id"] = params.responseId;

    if (params.pendingUsageMetadata !== undefined) setUsage(template, params.pendingUsageMetadata);
    // SAFETY: `template` was built just above with `choices` a one-element array of objects.
    const choice = (template["choices"] as JsonObject[])[0] as JsonObject;
    choice["finish_reason"] = finishReason;
    choice["native_finish_reason"] = nativeFinishReason;

    return [JSON.stringify(template)];
  }

  const raw = tryParseJson(line);

  if (!params.sawResponse) params.sawResponse = hasAntigravityResponsePayload(raw);

  // `tool_calls` is omitted unless the chunk carries calls (dfe0a0ef).
  const delta: JsonObject = { role: null, content: null, reasoning_content: null };

  const choice: JsonObject = { index: 0, delta, finish_reason: null, native_finish_reason: null };

  const template: JsonObject = {
    id: "",
    object: "chat.completion.chunk",
    created: 12345,
    model: "model",
    choices: [choice],
  };

  const modelVersion = get(raw, "response.modelVersion");

  if (modelVersion !== undefined) {
    params.modelVersion = asString(modelVersion);
    template["model"] = params.modelVersion;
  }

  const createTime = get(raw, "response.createTime");

  if (createTime !== undefined) {
    const ms = Date.parse(asString(createTime));

    if (!Number.isNaN(ms)) params.unixTimestamp = Math.floor(ms / 1000);
  }

  template["created"] = params.unixTimestamp;
  const responseId = get(raw, "response.responseId");

  if (responseId !== undefined) {
    params.responseId = asString(responseId);
    template["id"] = params.responseId;
  }

  // The finish reason is cached and only emitted on the final chunk.
  const finishReason = get(raw, "response.candidates.0.finishReason");

  if (finishReason !== undefined)
    params.upstreamFinishReason = asString(finishReason).toUpperCase();

  // FilterSSEUsageMetadata renames non-terminal usage to cpaUsageMetadata: retain the latest copy for [DONE].
  const usage = get(raw, "response.usageMetadata");

  if (usage === undefined) {
    const pending = get(raw, "response.cpaUsageMetadata");

    if (pending !== undefined) params.pendingUsageMetadata = structuredClone(pending);
  } else {
    setUsage(template, usage);
  }

  const parts = get(raw, "response.candidates.0.content.parts");

  if (isJsonArray(parts)) {
    // Text and reasoning accumulate across the chunk's parts (c5251b57).
    let textContent = "";
    let reasoningContent = "";
    let hasTextContent = false;
    let hasReasoningContent = false;

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
        if (asBool(get(part, "thought"))) {
          hasReasoningContent = true;
          reasoningContent += asString(text);
        } else {
          hasTextContent = true;
          textContent += asString(text);
        }

        delta["role"] = "assistant";
      } else if (functionCall !== undefined) {
        params.sawToolCall = true;
        // Indices count calls across the whole stream, not within one chunk (80aa2b1d).
        const index = params.functionIndex;
        params.functionIndex++;

        if (!isJsonArray(delta["tool_calls"])) delta["tool_calls"] = [];

        const name = restoreSanitizedToolName(
          params.sanitizedNameMap,
          asString(get(functionCall, "name")),
        );

        const call: JsonObject = {
          id: functionCallId(name, get(functionCall, "id")),
          index,
          type: "function",
          function: { name, arguments: "" },
        };

        const args = get(functionCall, "args");

        if (args !== undefined)
          // SAFETY: `call` was built just above with `function` set to an object literal.
          (call["function"] as JsonObject)["arguments"] = asString(args);
        delta["role"] = "assistant";
        // SAFETY: `delta.tool_calls` is an array: it was already one or was set to `[]` above.
        (delta["tool_calls"] as Json[]).push(call);
      } else if (inlineData !== undefined) {
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
          index: images.length,
        });
      }
    }

    if (hasTextContent) delta["content"] = textContent;

    if (hasReasoningContent) delta["reasoning_content"] = reasoningContent;
  }

  // Only the chunk with both finishReason and usage is terminal; [DONE] synthesises one when upstream never sends it.
  const isFinalChunk =
    params.upstreamFinishReason !== "" && get(raw, "response.usageMetadata") !== undefined;

  if (isFinalChunk) {
    const reasons = resolveFinishReason(params);
    choice["finish_reason"] = reasons.finishReason;
    choice["native_finish_reason"] = reasons.nativeFinishReason;
    params.sawFinishReason = true;
  }

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

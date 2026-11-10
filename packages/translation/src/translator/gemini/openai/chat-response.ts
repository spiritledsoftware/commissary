/**
 * Gemini provider -> OpenAI Chat Completions client: streaming and non-streaming response conversion.
 *
 * Go source: internal/translator/gemini/openai/chat-completions/gemini_openai_response.go
 * (ConvertGeminiResponseToOpenAI, ConvertGeminiResponseToOpenAINonStream) and init.go.
 */
import {
  asBool,
  asInt,
  asString,
  exists,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import {
  restoreSanitizedToolName,
  sanitizedToolNameMap,
  type NameMap,
} from "../../common/tool-names.ts";

interface Params {
  unixTimestamp: number;
  functionIndex: Map<number, number>;
  sawToolCall: Map<number, boolean>;
  sawFinishReason: Map<number, boolean>;
  upstreamFinishReason: Map<number, string>;
  modelVersion: string;
  responseId: string;
  pendingUsageMetadata: Json | undefined;
  sanitizedNameMap: NameMap;
}

let functionCallIdCounter = 0;

/**
 * The tool-call id: the upstream functionCall `id` when present (da21f1e5), else a unique `name-<unix nano>-<counter>`
 * (Go uses `time.Now().UnixNano()`).
 */
const functionCallId = (name: string, upstreamId?: Json): string => {
  const explicit = asString(upstreamId).trim();

  if (explicit !== "") return explicit;
  functionCallIdCounter++;

  return `${name}-${Date.now()}000000-${functionCallIdCounter}`;
};

/** Go `isGeminiContentFilterFinishReason` (3f5d3a16). */
export const isContentFilterFinishReason = (reason: string): boolean => {
  switch (reason.trim().toUpperCase()) {
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
    case "MALFORMED_RESPONSE":
    case "MALFORMED_FUNCTION_CALL":
      return true;
    default:
      return false;
  }
};

/** Go `resolveGeminiOpenAIFinishReason`. */
interface ResolvedFinishReason {
  finishReason: string;
  nativeFinishReason: string;
}

const resolveFinishReason = (upstream: string, sawToolCall: boolean): ResolvedFinishReason => ({
  finishReason: sawToolCall
    ? "tool_calls"
    : upstream === "MAX_TOKENS"
      ? "max_tokens"
      : isContentFilterFinishReason(upstream)
        ? "content_filter"
        : "stop",
  nativeFinishReason: upstream === "" ? "stop" : upstream.toLowerCase(),
});

const parseCreateTime = (value: Json | undefined): number | undefined => {
  const ms = Date.parse(asString(value));

  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
};

export const usageFields = (usage: Json, out: JsonObject): void => {
  const outUsage: JsonObject = {};
  outUsage["completion_tokens"] =
    asInt(get(usage, "candidatesTokenCount")) + asInt(get(usage, "thoughtsTokenCount"));
  const total = get(usage, "totalTokenCount");

  if (total !== undefined) outUsage["total_tokens"] = asInt(total);
  const thoughts = asInt(get(usage, "thoughtsTokenCount"));
  outUsage["prompt_tokens"] = asInt(get(usage, "promptTokenCount"));

  if (thoughts > 0) outUsage["completion_tokens_details"] = { reasoning_tokens: thoughts };
  const cached = asInt(get(usage, "cachedContentTokenCount"));

  if (cached > 0) outUsage["prompt_tokens_details"] = { cached_tokens: cached };
  out["usage"] = outUsage;
};

const inlineDataOf = (part: Json): Json | undefined =>
  get(part, "inlineData") ?? get(part, "inline_data");

const inlineImageUrl = (inlineData: Json): string | undefined => {
  const data = asString(get(inlineData, "data"));

  if (data === "") return undefined;
  let mimeType = asString(get(inlineData, "mimeType"));

  if (mimeType === "") mimeType = asString(get(inlineData, "mime_type"));

  if (mimeType === "") mimeType = "image/png";

  return `data:${mimeType};base64,${data}`;
};

const baseChunk = (): JsonObject => ({
  id: "",
  object: "chat.completion.chunk",
  created: 12345,
  model: "model",
  choices: [
    {
      index: 0,
      delta: { role: null, content: null, reasoning_content: null, tool_calls: null },
      finish_reason: null,
      native_finish_reason: null,
    },
  ],
});

export const convertGeminiResponseToOpenAI = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const state = context.state;

  if (state.value === undefined) {
    state.value = {
      unixTimestamp: 0,
      functionIndex: new Map(),
      sawToolCall: new Map(),
      sawFinishReason: new Map(),
      upstreamFinishReason: new Map(),
      modelVersion: "",
      responseId: "",
      pendingUsageMetadata: undefined,
      sanitizedNameMap: sanitizedToolNameMap(context.originalRequest),
    } satisfies Params;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const p = state.value as Params;
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line;

  if (payload === "[DONE]") {
    // A finishReason cached without a terminal chunk (usage never rode with it) is emitted now, once per candidate.
    const pending = [...p.upstreamFinishReason]
      .flatMap(([index, reason]) =>
        reason !== "" && p.sawFinishReason.get(index) !== true ? [index] : [],
      )
      .toSorted((a, b) => a - b);

    return pending.map((index) => {
      p.sawFinishReason.set(index, true);

      const { finishReason, nativeFinishReason } = resolveFinishReason(
        p.upstreamFinishReason.get(index) ?? "",
        p.sawToolCall.get(index) === true,
      );

      const chunk = baseChunk();
      chunk["created"] = p.unixTimestamp;

      if (p.modelVersion !== "") chunk["model"] = p.modelVersion;

      if (p.responseId !== "") chunk["id"] = p.responseId;

      if (p.pendingUsageMetadata !== undefined) usageFields(p.pendingUsageMetadata, chunk);
      // SAFETY: `chunk` is a fresh `baseChunk()`, whose `choices` is a one-element array of objects.
      const choice = (chunk["choices"] as JsonObject[])[0] as JsonObject;
      choice["index"] = index;
      choice["finish_reason"] = finishReason;
      choice["native_finish_reason"] = nativeFinishReason;

      return JSON.stringify(chunk);
    });
  }

  const root = tryParseJson(payload);

  const base = baseChunk();
  const modelVersion = get(root, "modelVersion");

  if (modelVersion !== undefined) p.modelVersion = asString(modelVersion);

  if (p.modelVersion !== "") base["model"] = p.modelVersion;
  const createTime = get(root, "createTime");

  if (createTime !== undefined) {
    const parsed = parseCreateTime(createTime);

    if (parsed !== undefined) p.unixTimestamp = parsed;
  }

  base["created"] = p.unixTimestamp;
  const responseId = get(root, "responseId");

  if (responseId !== undefined) p.responseId = asString(responseId);

  if (p.responseId !== "") base["id"] = p.responseId;
  const usage = get(root, "usageMetadata");

  if (usage !== undefined) {
    usageFields(usage, base);
    p.pendingUsageMetadata = undefined;
  } else {
    // The executor renames non-terminal usage to `cpaUsageMetadata`: keep it for a terminal chunk synthesised on [DONE].
    const pendingUsage = get(root, "cpaUsageMetadata");

    if (pendingUsage !== undefined) p.pendingUsageMetadata = structuredClone(pendingUsage);
  }

  const responses: string[] = [];
  const candidates = get(root, "candidates");

  if (isJsonArray(candidates)) {
    for (const candidate of candidates) {
      const template = structuredClone(base);
      // SAFETY: `template` is a clone of `baseChunk()`, whose `choices` is a one-element array of objects.
      const choice = (template["choices"] as JsonObject[])[0] as JsonObject;
      // SAFETY: `choice.delta` is the object literal from `baseChunk()`'s choice.
      const delta = choice["delta"] as JsonObject;
      const candidateIndex = asInt(get(candidate, "index"));
      choice["index"] = candidateIndex;
      const finishReason = get(candidate, "finishReason");

      if (finishReason !== undefined)
        p.upstreamFinishReason.set(candidateIndex, asString(finishReason).toUpperCase());

      let assistantRoleSet = false;

      const setAssistantRole = (): void => {
        if (assistantRoleSet) return;
        delta["role"] = "assistant";
        assistantRoleSet = true;
      };

      const parts = get(candidate, "content.parts");

      if (isJsonArray(parts)) {
        // Text and reasoning accumulate across the chunk's parts (c5251b57).
        let text = "";
        let reasoning = "";
        let hasText = false;
        let hasReasoning = false;

        for (const part of parts) {
          let partText = get(part, "text");
          const functionCall = get(part, "functionCall");
          const inlineData = inlineDataOf(part);
          let signature = get(part, "thoughtSignature");

          if (signature === undefined) signature = get(part, "thought_signature");
          const audioTranscription = get(part, "audioTranscription");

          if (audioTranscription !== undefined && partText === undefined)
            partText = get(audioTranscription, "text");

          const hasThoughtSignature = signature !== undefined && asString(signature) !== "";

          const hasTextPayload = partText !== undefined && asString(partText) !== "";

          const hasContentPayload =
            hasTextPayload || functionCall !== undefined || inlineData !== undefined;

          if (hasThoughtSignature && !hasContentPayload) continue;

          if (partText !== undefined) {
            setAssistantRole();

            if (asBool(get(part, "thought"))) {
              hasReasoning = true;
              reasoning += asString(partText);
            } else {
              hasText = true;
              text += asString(partText);
            }
          } else if (functionCall !== undefined) {
            p.sawToolCall.set(candidateIndex, true);
            // Indices count calls across the whole stream, not within one chunk (da21f1e5).
            const functionCallIndex = p.functionIndex.get(candidateIndex) ?? 0;
            p.functionIndex.set(candidateIndex, functionCallIndex + 1);
            let toolCalls = delta["tool_calls"];

            if (!isJsonArray(toolCalls)) {
              toolCalls = [];
              delta["tool_calls"] = toolCalls;
            }

            const fcName = restoreSanitizedToolName(
              p.sanitizedNameMap,
              asString(get(functionCall, "name")),
            );

            const call: JsonObject = {
              id: functionCallId(fcName, get(functionCall, "id")),
              index: functionCallIndex,
              type: "function",
              function: { name: fcName, arguments: "" },
            };

            const args = get(functionCall, "args");

            if (args !== undefined)
              // SAFETY: `call` was built just above with `function` set to an object literal.
              (call["function"] as JsonObject)["arguments"] = JSON.stringify(args);
            setAssistantRole();
            toolCalls.push(call);
          } else if (inlineData !== undefined) {
            const imageUrl = inlineImageUrl(inlineData);

            if (imageUrl === undefined) continue;
            let images = delta["images"];

            if (!isJsonArray(images)) {
              images = [];
              delta["images"] = images;
            }

            setAssistantRole();
            images.push({
              type: "image_url",
              image_url: { url: imageUrl },
              index: images.length,
            });
          }
        }

        if (hasText) delta["content"] = text;

        if (hasReasoning) delta["reasoning_content"] = reasoning;
      }

      const upstream = p.upstreamFinishReason.get(candidateIndex) ?? "";
      const sawToolCall = p.sawToolCall.get(candidateIndex) === true;

      if (upstream !== "" && exists(root, "usageMetadata")) {
        p.sawFinishReason.set(candidateIndex, true);
        const reasons = resolveFinishReason(upstream, sawToolCall);
        choice["finish_reason"] = reasons.finishReason;
        choice["native_finish_reason"] = reasons.nativeFinishReason;
      }

      responses.push(JSON.stringify(template));
    }
  } else if (usage !== undefined) {
    // A usage-only chunk carries a finishReason cached from an earlier chunk that had no usage of its own.
    const upstream = p.upstreamFinishReason.get(0) ?? "";

    if (upstream !== "" && p.sawFinishReason.get(0) !== true) {
      p.sawFinishReason.set(0, true);
      const reasons = resolveFinishReason(upstream, p.sawToolCall.get(0) === true);
      // SAFETY: `base` is a fresh `baseChunk()`, whose `choices` is a one-element array of objects.
      const choice = (base["choices"] as JsonObject[])[0] as JsonObject;
      choice["finish_reason"] = reasons.finishReason;
      choice["native_finish_reason"] = reasons.nativeFinishReason;
    }

    responses.push(JSON.stringify(base));
  }

  return responses;
};

export const convertGeminiResponseToOpenAINonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const sanitizedNameMap = sanitizedToolNameMap(context.originalRequest);

  const template: JsonObject = {
    id: "",
    object: "chat.completion",
    created: 123456,
    model: "model",
    choices: [],
  };

  const modelVersion = get(root, "modelVersion");

  if (modelVersion !== undefined) template["model"] = asString(modelVersion);
  const createTime = get(root, "createTime");
  template["created"] = (createTime === undefined ? undefined : parseCreateTime(createTime)) ?? 0;
  const responseId = get(root, "responseId");

  if (responseId !== undefined) template["id"] = asString(responseId);
  const usage = get(root, "usageMetadata");

  if (usage !== undefined) usageFields(usage, template);

  const candidates = get(root, "candidates");

  if (isJsonArray(candidates)) {
    const choices: Json[] = [];

    for (const candidate of candidates) {
      const message: JsonObject = {
        role: "assistant",
        content: null,
        reasoning_content: null,
        tool_calls: null,
      };

      const choice: JsonObject = {
        index: asInt(get(candidate, "index")),
        message,
        finish_reason: null,
        native_finish_reason: null,
      };

      const finishReason = get(candidate, "finishReason");

      if (finishReason !== undefined) {
        choice["finish_reason"] = isContentFilterFinishReason(asString(finishReason))
          ? "content_filter"
          : asString(finishReason).toLowerCase();
        choice["native_finish_reason"] = asString(finishReason).toLowerCase();
      }

      let hasFunctionCall = false;
      const parts = get(candidate, "content.parts");

      if (isJsonArray(parts)) {
        const toolCalls: Json[] = [];
        const images: Json[] = [];
        let text = "";
        let reasoning = "";
        let hasText = false;
        let hasReasoning = false;

        for (const part of parts) {
          let partText = get(part, "text");
          const functionCall = get(part, "functionCall");
          const inlineData = inlineDataOf(part);
          const audioTranscription = get(part, "audioTranscription");

          if (audioTranscription !== undefined && partText === undefined)
            partText = get(audioTranscription, "text");

          const signature = get(part, "thoughtSignature") ?? get(part, "thought_signature");

          const hasContentPayload =
            (partText !== undefined && asString(partText) !== "") ||
            functionCall !== undefined ||
            inlineData !== undefined;

          // Skip pure thoughtSignature carriers but keep any payload in the same part (c5251b57).
          if (signature !== undefined && asString(signature) !== "" && !hasContentPayload) continue;

          if (partText !== undefined) {
            if (asBool(get(part, "thought"))) {
              hasReasoning = true;
              reasoning += asString(partText);
            } else {
              hasText = true;
              text += asString(partText);
            }
          } else if (functionCall !== undefined) {
            hasFunctionCall = true;

            const fcName = restoreSanitizedToolName(
              sanitizedNameMap,
              asString(get(functionCall, "name")),
            );

            const call: JsonObject = {
              id: functionCallId(fcName, get(functionCall, "id")),
              type: "function",
              function: { name: fcName, arguments: "" },
            };

            const args = get(functionCall, "args");

            if (args !== undefined)
              // SAFETY: `call` was built just above with `function` set to an object literal.
              (call["function"] as JsonObject)["arguments"] = JSON.stringify(args);
            toolCalls.push(call);
          } else if (inlineData !== undefined) {
            const imageUrl = inlineImageUrl(inlineData);

            if (imageUrl !== undefined) {
              images.push({
                type: "image_url",
                image_url: { url: imageUrl },
                index: images.length,
              });
            }
          }
        }

        if (hasText) message["content"] = text;

        if (hasReasoning) message["reasoning_content"] = reasoning;

        if (toolCalls.length > 0) message["tool_calls"] = toolCalls;

        if (images.length > 0) message["images"] = images;
      }

      if (hasFunctionCall) {
        choice["finish_reason"] = "tool_calls";
        choice["native_finish_reason"] = "tool_calls";
      }

      choices.push(choice);
    }

    if (choices.length > 0) template["choices"] = choices;
  }

  return JSON.stringify(template);
};

export const geminiToOpenAIResponse: ResponseTransform = {
  stream: convertGeminiResponseToOpenAI,
  nonStream: convertGeminiResponseToOpenAINonStream,
};

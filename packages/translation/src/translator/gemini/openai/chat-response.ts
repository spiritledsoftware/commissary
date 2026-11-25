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
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import {
  isGeminiThoughtSignatureBypass,
  signaturePayloadWithoutProviderPrefix,
} from "../../../signature/gemini.ts";
import { functionCallId, isContentFilterFinishReason } from "../../common/gemini-response.ts";
import { restoreSanitizedToolName, type NameMap } from "../../common/tool-names.ts";
import { hasUnsupportedPartPayload } from "../common/parts.ts";
import { sanitizeFunctionName } from "../util/claude.ts";
import { parseAllowedTools } from "./chat-request.ts";

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
  /** Per candidate, the index of the last tool call a detached thought signature still belongs to. */
  lastToolCallIndex: Map<number, number>;
}

/** The part fields the OpenAI Chat translation carries; a part with any other payload is skipped. */
const SUPPORTED_PART_FIELDS = [
  "text",
  "functionCall",
  "inlineData",
  "inline_data",
  "audioTranscription",
];

/** `geminiOpenAIToolThoughtSignature`: the signature a tool call carries back to the client, bypass sentinels dropped. */
const toolThoughtSignature = (raw: Json | undefined): string => {
  const signature = asString(raw).trim();

  return isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(signature))
    ? ""
    : signature;
};

const setToolSignature = (call: JsonObject, signature: string): void => {
  call["extra_content"] = { google: { thought_signature: signature } };
};

/**
 * `geminiOpenAISanitizedToolNameMap`: sanitized name -> original name for the function tools the request translator
 * declared (after `allowed_tools` filtering; a sanitized name two originals share is left out), also reading legacy
 * top-level tools without a `type`.
 */
export const geminiOpenAISanitizedToolNameMap = (request: Json | undefined): NameMap => {
  const tools = get(request, "tools");

  if (!isJsonArray(tools)) return undefined;
  const allowed = parseAllowedTools(request);
  const sanitizedToOriginal = new Map<string, string>();
  const collided = new Set<string>();

  const record = (originalName: string): void => {
    if (originalName === "") return;

    if (allowed !== undefined && !allowed.names.has(originalName)) return;
    const sanitizedName = sanitizeFunctionName(originalName);

    if (sanitizedName === "") return;
    const existing = sanitizedToOriginal.get(sanitizedName);

    if (existing !== undefined) {
      if (existing !== originalName) collided.add(sanitizedName);

      return;
    }

    sanitizedToOriginal.set(sanitizedName, originalName);
  };

  for (const tool of tools) {
    const toolType = asString(get(tool, "type"));

    if (toolType === "function") {
      const fn = get(tool, "function");

      if (fn !== null && typeof fn === "object" && !Array.isArray(fn))
        record(asString(get(fn, "name")));
    } else if (toolType === "") {
      record(asString(get(tool, "name")).trim());
    }
  }

  const out = new Map<string, string>();

  for (const [sanitizedName, originalName] of sanitizedToOriginal) {
    if (!collided.has(sanitizedName) && sanitizedName !== originalName)
      out.set(sanitizedName, originalName);
  }

  return out.size === 0 ? undefined : out;
};

interface ResolvedFinishReason {
  finishReason: string;
  nativeFinishReason: string;
}

/** Go `resolveGeminiOpenAIFinishReason`. */
const resolveFinishReason = (upstream: string, sawToolCall: boolean): ResolvedFinishReason => ({
  finishReason: sawToolCall
    ? "tool_calls"
    : upstream === "MAX_TOKENS"
      ? "length"
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

/**
 * `buildGeminiOpenAITerminalChunkDoc`: the chunk that finishes a choice, with an empty delta (8cd6817b): strict Chat
 * Completions parsers reject a chunk that carries both a delta payload and a finish reason.
 */
const terminalChunk = (
  p: Params,
  candidateIndex: number,
  reasons: ResolvedFinishReason,
  usage: Json | undefined,
): string => {
  const chunk: JsonObject = {
    id: p.responseId,
    object: "chat.completion.chunk",
    created: p.unixTimestamp,
    model: p.modelVersion === "" ? "model" : p.modelVersion,
    choices: [
      {
        index: candidateIndex,
        delta: {},
        finish_reason: reasons.finishReason,
        native_finish_reason: reasons.nativeFinishReason,
      },
    ],
  };

  if (usage !== undefined) usageFields(usage, chunk);

  return JSON.stringify(chunk);
};

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
      sanitizedNameMap: geminiOpenAISanitizedToolNameMap(context.originalRequest),
      lastToolCallIndex: new Map(),
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

      const reasons = resolveFinishReason(
        p.upstreamFinishReason.get(index) ?? "",
        p.sawToolCall.get(index) === true,
      );

      return terminalChunk(p, index, reasons, p.pendingUsageMetadata);
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

  // Usage rides on each emitted chunk below, so a split terminal frame carries it on its last chunk only.
  if (usage !== undefined) {
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
      let sawNoopPart = false;
      let hasNonEmptyDelta = false;

      const setAssistantRole = (): void => {
        if (assistantRoleSet) return;
        delta["role"] = "assistant";
        assistantRoleSet = true;
      };

      const toolCallsArray = (): Json[] => {
        let toolCalls = delta["tool_calls"];

        if (!isJsonArray(toolCalls)) {
          toolCalls = [];
          delta["tool_calls"] = toolCalls;
        }

        return toolCalls;
      };

      // A late signature is still a tool delta, on the tool call it follows (91aca317).
      const appendToolSignature = (signature: string): void => {
        const index = p.lastToolCallIndex.get(candidateIndex);

        if (signature === "" || index === undefined) return;
        const call: JsonObject = { index };
        setToolSignature(call, signature);
        setAssistantRole();
        toolCallsArray().push(call);
      };

      const parts = get(candidate, "content.parts");

      if (isJsonArray(parts)) {
        // Text and reasoning accumulate across the chunk's parts (c5251b57).
        let text = "";
        let reasoning = "";
        let hasText = false;
        let hasReasoning = false;

        for (const part of parts) {
          if (hasUnsupportedPartPayload(part, SUPPORTED_PART_FIELDS)) {
            p.lastToolCallIndex.delete(candidateIndex);
            sawNoopPart = true;
            continue;
          }

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

          const thoughtSignature = toolThoughtSignature(signature);

          if (hasThoughtSignature && !hasContentPayload) {
            appendToolSignature(thoughtSignature);
            continue;
          }

          if (partText !== undefined) {
            if (asString(partText) !== "") p.lastToolCallIndex.delete(candidateIndex);
            setAssistantRole();

            if (asBool(get(part, "thought"))) {
              hasReasoning = true;
              reasoning += asString(partText);
            } else {
              hasText = true;
              text += asString(partText);
            }
          } else if (functionCall !== undefined) {
            const rawName = asString(get(functionCall, "name")).trim();
            const args = get(functionCall, "args");

            if (rawName === "" && args === undefined) {
              appendToolSignature(thoughtSignature);
              sawNoopPart = true;
              continue;
            }

            p.sawToolCall.set(candidateIndex, true);
            // Indices count calls across the whole stream, not within one chunk (da21f1e5).
            const functionCallIndex = p.functionIndex.get(candidateIndex) ?? 0;
            p.functionIndex.set(candidateIndex, functionCallIndex + 1);
            p.lastToolCallIndex.set(candidateIndex, functionCallIndex);
            const toolCalls = toolCallsArray();
            const fcName = restoreSanitizedToolName(p.sanitizedNameMap, rawName);

            // Omitted arguments are an empty object (dd866f6c).
            const call: JsonObject = {
              id: functionCallId(fcName, get(functionCall, "id")),
              index: functionCallIndex,
              type: "function",
              function: {
                name: fcName,
                arguments: args === undefined ? "{}" : JSON.stringify(args),
              },
            };

            if (thoughtSignature !== "") setToolSignature(call, thoughtSignature);
            setAssistantRole();
            toolCalls.push(call);
          } else if (inlineData !== undefined) {
            p.lastToolCallIndex.delete(candidateIndex);

            // Thinking draft images are not part of the answer (6684f3b5).
            if (asBool(get(part, "thought"))) {
              sawNoopPart = true;
              continue;
            }

            const imageUrl = inlineImageUrl(inlineData);

            if (imageUrl === undefined) {
              sawNoopPart = true;
              continue;
            }

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
        hasNonEmptyDelta =
          text !== "" ||
          reasoning !== "" ||
          isJsonArray(delta["tool_calls"]) ||
          isJsonArray(delta["images"]);
      }

      const upstream = p.upstreamFinishReason.get(candidateIndex) ?? "";
      const sawToolCall = p.sawToolCall.get(candidateIndex) === true;

      if (
        p.sawFinishReason.get(candidateIndex) !== true &&
        upstream !== "" &&
        usage !== undefined
      ) {
        p.sawFinishReason.set(candidateIndex, true);
        const reasons = resolveFinishReason(upstream, sawToolCall);

        // The payload goes first and the finish in a chunk of its own (8cd6817b).
        if (hasNonEmptyDelta) responses.push(JSON.stringify(template));
        responses.push(terminalChunk(p, candidateIndex, reasons, usage));
        continue;
      }

      if (p.sawFinishReason.get(candidateIndex) === true && !hasNonEmptyDelta) continue;

      if (sawNoopPart && !assistantRoleSet && usage === undefined) continue;

      if (usage !== undefined) usageFields(usage, template);
      responses.push(JSON.stringify(template));
    }
  } else if (usage !== undefined) {
    // A usage-only chunk carries a finishReason cached from an earlier chunk that had no usage of its own.
    const upstream = p.upstreamFinishReason.get(0) ?? "";

    if (upstream !== "" && p.sawFinishReason.get(0) !== true) {
      p.sawFinishReason.set(0, true);
      const reasons = resolveFinishReason(upstream, p.sawToolCall.get(0) === true);
      responses.push(terminalChunk(p, 0, reasons, usage));
    } else if (p.sawFinishReason.get(0) !== true) {
      usageFields(usage, base);
      responses.push(JSON.stringify(base));
    }
  }

  return responses;
};

export const convertGeminiResponseToOpenAINonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const sanitizedNameMap = geminiOpenAISanitizedToolNameMap(context.originalRequest);

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
        choice["finish_reason"] =
          asString(finishReason).trim().toUpperCase() === "MAX_TOKENS"
            ? "length"
            : isContentFilterFinishReason(asString(finishReason))
              ? "content_filter"
              : asString(finishReason).toLowerCase();
        choice["native_finish_reason"] = asString(finishReason).toLowerCase();
      }

      let hasFunctionCall = false;
      const parts = get(candidate, "content.parts");

      if (isJsonArray(parts)) {
        const toolCalls: JsonObject[] = [];
        // The tool call a detached signature still belongs to: text and images end it.
        let lastToolCall: JsonObject | undefined;
        const images: Json[] = [];
        let text = "";
        let reasoning = "";
        let hasText = false;
        let hasReasoning = false;

        for (const part of parts) {
          if (hasUnsupportedPartPayload(part, SUPPORTED_PART_FIELDS)) {
            lastToolCall = undefined;
            continue;
          }

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

          // A pure thoughtSignature carrier signs the tool call it follows (91aca317).
          if (signature !== undefined && asString(signature) !== "" && !hasContentPayload) {
            const detached = toolThoughtSignature(signature);

            if (detached !== "" && lastToolCall !== undefined)
              setToolSignature(lastToolCall, detached);
            continue;
          }

          if (partText !== undefined) {
            if (asString(partText) !== "") lastToolCall = undefined;

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

            const args = get(functionCall, "args");

            const call: JsonObject = {
              id: functionCallId(fcName, get(functionCall, "id")),
              type: "function",
              function: {
                name: fcName,
                arguments: args === undefined ? "{}" : JSON.stringify(args),
              },
            };

            const callSignature = toolThoughtSignature(signature);

            if (callSignature !== "") setToolSignature(call, callSignature);
            toolCalls.push(call);
            lastToolCall = call;
          } else if (inlineData !== undefined) {
            lastToolCall = undefined;

            if (asBool(get(part, "thought"))) continue;
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

/**
 * Claude Messages provider -> Gemini client (response).
 *
 * Go source: internal/translator/claude/gemini/claude_gemini_response.go.
 */
import { asInt, get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { decodeBase64Raw, decodeBase64Std, encodeBase64Std } from "../../../signature/base64.ts";
import {
  geminiReplaySignatureOrBypass,
  isGeminiThoughtSignatureBypass,
} from "../../../signature/gemini.ts";
import { exists, isObj, str } from "../../common/gjson.ts";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";

/**
 * `geminiCompatibleThoughtSignaturePart`: a thought part whose `thoughtSignature` is valid standard base64, or
 * `undefined` for a signature Gemini cannot replay. The function-call bypass sentinel is not a valid byte field of a
 * thought part, so an incompatible signature is omitted instead (CLIProxyAPI 55c05f70).
 */
const compatibleThoughtSignaturePart = (rawSignature: string): JsonObject | undefined => {
  let signature = geminiReplaySignatureOrBypass(rawSignature);

  if (isGeminiThoughtSignatureBypass(signature)) return undefined;

  if (decodeBase64Std(signature) === undefined) {
    const decoded = decodeBase64Raw(signature);

    if (decoded === undefined) return undefined;
    signature = encodeBase64Std(decoded);
  }

  return { thought: true, thoughtSignature: signature };
};

/** Go `ConvertAnthropicResponseToGeminiParams`. */
interface Params {
  model: string;
  createdAt: number;
  responseId: string;
  toolUseNames: Map<number, string>;
  toolUseArgs: Map<number, string>;
  toolUseIds: Map<number, string>;
}

const newParams = (model: string): Params => ({
  model,
  createdAt: 0,
  responseId: "",
  toolUseNames: new Map(),
  toolUseArgs: new Map(),
  toolUseIds: new Map(),
});

/** `time.Unix(sec, 0).Format(time.RFC3339Nano)` in UTC. */
const formatCreateTime = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

interface Template {
  out: JsonObject;
  parts: JsonObject[];
  candidate: JsonObject;
}

const newTemplate = (): Template => {
  const parts: JsonObject[] = [];
  const candidate: JsonObject = { content: { role: "model", parts } };

  return {
    out: {
      candidates: [candidate],
      usageMetadata: { trafficType: "PROVISIONED_THROUGHPUT" },
      modelVersion: "",
      createTime: "",
      responseId: "",
    },
    parts,
    candidate,
  };
};

const usageMetadata = (usage: Json | undefined, target: JsonObject): void => {
  const inputTokens = asInt(get(usage, "input_tokens"));
  const outputTokens = asInt(get(usage, "output_tokens"));
  target.promptTokenCount = inputTokens;
  target.candidatesTokenCount = outputTokens;
  target.totalTokenCount = inputTokens + outputTokens;
  const creation = get(usage, "cache_creation_input_tokens");

  if (exists(creation)) target.cachedContentTokenCount = asInt(creation);
  const read = get(usage, "cache_read_input_tokens");

  if (exists(read)) target.cachedContentTokenCount = asInt(creation) + asInt(read);
  const thinking = get(usage, "thinking_tokens");

  if (exists(thinking)) target.thoughtsTokenCount = asInt(thinking);
  target.trafficType = "PROVISIONED_THROUGHPUT";
};

const functionCallPart = (params: Params, idx: number): JsonObject | undefined => {
  const name = params.toolUseNames.get(idx) ?? "";
  const argsTrim = (params.toolUseArgs.get(idx) ?? "").trim();
  const toolId = params.toolUseIds.get(idx) ?? "";

  if (name === "" && argsTrim === "") return undefined;
  const functionCall: JsonObject = { name: "", args: {} };

  if (name !== "") functionCall.name = name;

  if (argsTrim !== "") functionCall.args = tryParseJson(argsTrim) ?? {};

  if (toolId !== "") functionCall.id = toolId;
  params.toolUseArgs.delete(idx);
  params.toolUseNames.delete(idx);
  params.toolUseIds.delete(idx);

  return { functionCall };
};

const recordToolUseStart = (params: Params, idx: number, block: Json | undefined): void => {
  const name = get(block, "name");

  if (exists(name)) params.toolUseNames.set(idx, str(name));
  const toolId = str(get(block, "id"));

  if (toolId !== "") params.toolUseIds.set(idx, toolId);
};

/** `ConvertClaudeResponseToGemini`. */
export const convertClaudeResponseToGemini = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const state = context.state;
  state.value ??= newParams(context.model);
  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const params = state.value as Params;

  if (!line.startsWith("data:")) return [];
  const root = tryParseJson(line.slice(5).trim());
  const eventType = str(get(root, "type"));

  const template = newTemplate();
  const { out, parts, candidate } = template;

  if (params.model !== "") out.modelVersion = params.model;

  if (params.responseId !== "") out.responseId = params.responseId;

  if (params.createdAt === 0) params.createdAt = nowSeconds();
  out.createTime = formatCreateTime(params.createdAt);

  switch (eventType) {
    case "message_start": {
      const message = get(root, "message");

      if (exists(message)) {
        params.responseId = str(get(message, "id"));
        params.model = str(get(message, "model"));
      }

      return [];
    }

    case "content_block_start": {
      const block = get(root, "content_block");

      if (exists(block)) {
        const type = str(get(block, "type"));

        if (type === "tool_use") {
          recordToolUseStart(params, asInt(get(root, "index")), block);
        } else if (type === "thinking") {
          const sig = get(block, "signature");

          if (exists(sig) && str(sig) !== "") {
            const thinkingPart = compatibleThoughtSignaturePart(str(sig));

            if (thinkingPart !== undefined) {
              parts.push(thinkingPart);

              return [JSON.stringify(out)];
            }
          }
        }
      }

      return [];
    }

    case "content_block_delta": {
      const delta = get(root, "delta");

      if (exists(delta)) {
        switch (str(get(delta, "type"))) {
          case "text_delta": {
            const text = get(delta, "text");

            if (exists(text) && str(text) !== "") parts.push({ text: str(text) });
            break;
          }

          case "thinking_delta": {
            const text = get(delta, "thinking");

            if (exists(text) && str(text) !== "") parts.push({ thought: true, text: str(text) });
            break;
          }

          case "signature_delta": {
            const sig = get(delta, "signature");

            if (exists(sig) && str(sig) !== "") {
              const thinkingPart = compatibleThoughtSignaturePart(str(sig));

              if (thinkingPart === undefined) return [];
              parts.push(thinkingPart);
            }

            break;
          }

          case "input_json_delta": {
            const idx = asInt(get(root, "index"));
            const partial = get(delta, "partial_json");
            params.toolUseArgs.set(
              idx,
              (params.toolUseArgs.get(idx) ?? "") + (exists(partial) ? str(partial) : ""),
            );

            return [];
          }
        }
      }

      return [JSON.stringify(out)];
    }

    case "content_block_stop": {
      const part = functionCallPart(params, asInt(get(root, "index")));

      if (part === undefined) return [];
      parts.push(part);
      candidate.finishReason = "STOP";

      return [JSON.stringify(out)];
    }

    case "message_delta": {
      const delta = get(root, "delta");

      if (exists(delta) && exists(get(delta, "stop_reason"))) {
        candidate.finishReason =
          str(get(delta, "stop_reason")) === "max_tokens" ? "MAX_TOKENS" : "STOP";
      }

      const usage = get(root, "usage");

      if (exists(usage))
        // SAFETY: the candidate/usageMetadata object was created as an object earlier in this function.
        usageMetadata(usage, out.usageMetadata as JsonObject);
      candidate.finishReason = "STOP";

      return [JSON.stringify(out)];
    }

    case "error": {
      const message = str(get(root, "error.message"));

      return [
        JSON.stringify({
          error: {
            code: 400,
            message: message === "" ? "Unknown error occurred" : message,
            status: "INVALID_ARGUMENT",
          },
        }),
      ];
    }

    default:
      return [];
  }
};

/** `ConvertClaudeResponseToGeminiNonStream`: aggregates the upstream event stream into one Gemini response. */
export const convertClaudeResponseToGeminiNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const candidate: JsonObject = { content: { role: "model", parts: [] }, finishReason: "STOP" };

  const out: JsonObject = {
    candidates: [candidate],
    usageMetadata: { trafficType: "PROVISIONED_THROUGHPUT" },
    modelVersion: context.model,
    createTime: "",
    responseId: "",
  };

  const params = newParams(context.model);
  const allParts: JsonObject[] = [];
  let finalUsage: JsonObject | undefined;
  let responseId = "";
  let createdAt = 0;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r+$/u, "");

    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();

    if (data === "") continue;
    const root = tryParseJson(data);

    switch (str(get(root, "type"))) {
      case "message_start": {
        const message = get(root, "message");

        if (exists(message)) {
          responseId = str(get(message, "id"));
          params.responseId = responseId;
          params.model = str(get(message, "model"));
          createdAt = nowSeconds();
          params.createdAt = createdAt;
        }

        break;
      }

      case "content_block_start": {
        const block = get(root, "content_block");

        if (!exists(block)) break;
        const type = str(get(block, "type"));

        if (type === "tool_use") recordToolUseStart(params, asInt(get(root, "index")), block);
        else if (type === "thinking") {
          const sig = get(block, "signature");

          if (exists(sig) && str(sig) !== "") {
            const thinkingPart = compatibleThoughtSignaturePart(str(sig));

            if (thinkingPart !== undefined) allParts.push(thinkingPart);
          }
        }

        break;
      }

      case "content_block_delta": {
        const delta = get(root, "delta");

        if (!exists(delta)) break;

        switch (str(get(delta, "type"))) {
          case "text_delta": {
            const text = get(delta, "text");

            if (exists(text) && str(text) !== "") allParts.push({ text: str(text) });
            break;
          }

          case "thinking_delta": {
            const text = get(delta, "thinking");

            if (exists(text) && str(text) !== "") allParts.push({ thought: true, text: str(text) });
            break;
          }

          case "signature_delta": {
            const sig = get(delta, "signature");

            if (exists(sig) && str(sig) !== "") {
              const thinkingPart = compatibleThoughtSignaturePart(str(sig));

              if (thinkingPart !== undefined) allParts.push(thinkingPart);
            }

            break;
          }

          case "input_json_delta": {
            const idx = asInt(get(root, "index"));
            const partial = get(delta, "partial_json");
            params.toolUseArgs.set(
              idx,
              (params.toolUseArgs.get(idx) ?? "") + (exists(partial) ? str(partial) : ""),
            );
            break;
          }
        }

        break;
      }

      case "content_block_stop": {
        const part = functionCallPart(params, asInt(get(root, "index")));

        if (part !== undefined) allParts.push(part);
        break;
      }

      case "message_delta": {
        const usage = get(root, "usage");

        if (exists(usage)) {
          const target: JsonObject = {};
          usageMetadata(usage, target);
          finalUsage = target;
        }

        break;
      }
    }
  }

  if (responseId !== "") out.responseId = responseId;

  if (createdAt > 0) out.createTime = formatCreateTime(createdAt);
  const consolidated = consolidateParts(allParts);

  if (consolidated.length > 0)
    // SAFETY: the candidate/usageMetadata object was created as an object earlier in this function.
    (candidate.content as JsonObject).parts = consolidated;

  if (finalUsage !== undefined) out.usageMetadata = finalUsage;

  return JSON.stringify(out);
};

/** `GeminiTokenCount`. */
export const geminiTokenCount = (count: number): string =>
  `{"totalTokens":${count},"promptTokensDetails":[{"modality":"TEXT","tokenCount":${count}}]}`;

/** Merges consecutive text parts and consecutive thinking parts. */
const consolidateParts = (parts: readonly JsonObject[]): JsonObject[] => {
  const consolidated: JsonObject[] = [];
  let text = "";
  let thought = "";
  let signature = "";
  let hasText = false;
  let hasThought = false;

  const flushText = (): void => {
    if (hasText && text.length > 0) {
      consolidated.push({ text });
      text = "";
      hasText = false;
    }
  };

  const flushThought = (): void => {
    if (hasThought && (thought.length > 0 || signature !== "")) {
      const part: JsonObject = { thought: true, text: thought };

      if (signature !== "") part.thoughtSignature = signature;
      consolidated.push(part);
      thought = "";
      signature = "";
      hasThought = false;
    }
  };

  for (const part of parts) {
    if (!isObj(part)) {
      flushText();
      flushThought();
      consolidated.push(part);
      continue;
    }

    if (part.thought === true) {
      flushText();

      if (typeof part.text === "string") {
        thought += part.text;
        hasThought = true;
      }

      if (typeof part.thoughtSignature === "string" && part.thoughtSignature !== "") {
        signature = part.thoughtSignature;
        hasThought = true;
      }
    } else if (typeof part.text === "string") {
      flushThought();
      text += part.text;
      hasText = true;
    } else {
      flushText();
      flushThought();
      consolidated.push(part);
    }
  }

  flushThought();
  flushText();

  return consolidated;
};

export const claudeToGeminiResponse: ResponseTransform = {
  stream: convertClaudeResponseToGemini,
  nonStream: convertClaudeResponseToGeminiNonStream,
  tokenCount: geminiTokenCount,
};

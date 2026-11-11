/**
 * Codex (Responses) stream/non-stream response -> Gemini generateContent.
 *
 * Go source: internal/translator/codex/gemini/codex_gemini_response.go (ConvertCodexResponseToGemini,
 * ...NonStream, GeminiTokenCount). Timestamps are formatted in UTC (Go formats in the process' local zone).
 */
import {
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
import { encodeGeminiCodexThoughtSignature } from "../../../signature/gemini-codex-carrier.ts";
import { geminiTokenCountJson } from "../../common/bytes.ts";
import type { ResponseContext } from "../../registry.ts";
import { geminiShortNameMap } from "./request.ts";

/** Go `ConvertCodexResponseToGeminiParams`. */
interface GeminiParams {
  model: string;
  createdAt: number;
  responseId: string;
  /**
   * Completed function-call chunks, queued in stream order until the next non-storage event flushes them. A queue, not
   * a single slot, so consecutive calls never overwrite each other.
   */
  storageOutputs: string[];
  hasOutputTextDelta: boolean;
  readonly lastImageById: Map<string, string>;
  /**
   * A completed reasoning item's `encrypted_content`, held until the next visible part can carry it as a Gemini
   * `thoughtSignature`, mirroring native Gemini part placement.
   */
  pendingThoughtSignature: string;
  /** Repeated reasoning done events (item id + signature) within one response stream. */
  seenReasoningSignatures: Set<string>;
  /** Whether reasoning deltas were streamed for the current (or a keyed) reasoning item, for the done-only fallback. */
  hasReasoningDelta: boolean;
  streamedReasoningItems: Set<string>;
}

/** `time.Unix(sec, 0).Format(time.RFC3339Nano)` in UTC. */
const rfc3339 = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");

const mimeTypeFromOutputFormat = (outputFormat: string): string => {
  if (outputFormat === "") return "image/png";

  if (outputFormat.includes("/")) return outputFormat;

  switch (outputFormat.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
};

const incompleteFinishReason = (reason: string): string => {
  switch (reason) {
    case "max_tokens":
    case "max_output_tokens":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return "OTHER";
  }
};

/** `buildReverseMapFromGeminiOriginal`: shortened -> original tool names. */
const reverseNames = (original: Json | undefined): Map<string, string> => {
  const reverse = new Map<string, string>();

  for (const [name, short] of geminiShortNameMap(original)) reverse.set(short, name);

  return reverse;
};

const setFunctionCallId = (functionCall: Json, item: Json | undefined): Json => {
  const callId = asString(get(item, "call_id")).trim();

  if (callId !== "") return set(functionCall, "functionCall.id", callId);
  const id = asString(get(item, "id")).trim();

  return id !== "" ? set(functionCall, "functionCall.id", id) : functionCall;
};

const inlineDataPart = (b64: string, outputFormat: string): JsonObject => ({
  inlineData: { data: b64, mimeType: mimeTypeFromOutputFormat(outputFormat) },
});

const functionCallPart = (
  item: Json | undefined,
  original: Json | undefined,
  argsFirst: boolean,
): Json => {
  const n = asString(get(item, "name"));
  const name = reverseNames(original).get(n) ?? n;

  let functionCall: Json = argsFirst
    ? { functionCall: { args: {}, name: "" } }
    : { functionCall: { name: "", args: {} } };

  functionCall = set(functionCall, "functionCall.name", name);
  const argsText = asString(get(item, "arguments"));

  if (argsText !== "") {
    const args = tryParseJson(argsText);

    if (isJsonObject(args)) functionCall = set(functionCall, "functionCall.args", args);
  }

  return setFunctionCallId(functionCall, item);
};

/** An empty thought part that carries `signature`, so a signature that met no visible part is not lost. */
const signatureCarrierPart = (signature: string): Json => ({
  thought: true,
  text: "",
  thoughtSignature: encodeGeminiCodexThoughtSignature(signature),
});

/** `extractCodexGeminiReasoningTexts`: the summary texts, then the `reasoning_text` content, of a reasoning item. */
const reasoningTexts = (item: Json | undefined): string[] => {
  const texts: string[] = [];
  const summary = get(item, "summary");

  if (isJsonArray(summary)) {
    for (const entry of summary) {
      const text = asString(get(entry, "text"));

      if (text !== "") texts.push(text);
    }
  }

  const content = get(item, "content");

  if (isJsonArray(content)) {
    for (const entry of content) {
      if (asString(get(entry, "type")) !== "reasoning_text") continue;
      const text = asString(get(entry, "text"));

      if (text !== "") texts.push(text);
    }
  } else if (typeof content === "string" && content !== "") {
    texts.push(content);
  }

  return texts;
};

const baseTemplate = (): Json => ({
  candidates: [{ content: { role: "model", parts: [] } }],
  usageMetadata: { trafficType: "PROVISIONED_THROUGHPUT" },
  modelVersion: "gemini-2.5-pro",
  createTime: "2025-08-15T02:52:03.884209Z",
  responseId: "06CeaPH7NaCU48APvNXDyA4",
});

/** `ConvertCodexResponseToGemini`. */
export const convertCodexResponseToGemini = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  if (context.state.value === undefined) {
    const initial: GeminiParams = {
      model: context.model,
      createdAt: 0,
      responseId: "",
      storageOutputs: [],
      hasOutputTextDelta: false,
      lastImageById: new Map(),
      pendingThoughtSignature: "",
      seenReasoningSignatures: new Set(),
      hasReasoningDelta: false,
      streamedReasoningItems: new Set(),
    };

    context.state.value = initial;
  }

  // SAFETY: this translator is the only writer of `state.value` and initialises it to a GeminiParams before this read.
  const params = context.state.value as GeminiParams;

  if (!line.startsWith("data:")) return [];
  const root = tryParseJson(line.slice(5).trim());
  const type = asString(get(root, "type"));
  const original = context.originalRequest;

  let template = baseTemplate();
  template = set(template, "modelVersion", params.model);
  const createdAt = get(root, "response.created_at");

  if (createdAt !== undefined) {
    params.createdAt = asInt(createdAt);
    template = set(template, "createTime", rfc3339(params.createdAt));
  }

  template = set(template, "responseId", params.responseId);

  /** Drains the queued function-call chunks ahead of `extra`, preserving stream order on every return path. */
  const flushStorageOutputs = (...extra: ReadonlyArray<string>): ReadonlyArray<string> => {
    const outputs = [...params.storageOutputs, ...extra];
    params.storageOutputs = [];

    return outputs;
  };

  /** The held reasoning signature (`""` when none), which is cleared: a signature is spent on one part. */
  const takePendingSignature = (): string => {
    const signature = params.pendingThoughtSignature;
    params.pendingThoughtSignature = "";

    return signature;
  };

  /** Puts the held reasoning signature on `part` (as the carrier) and clears it. */
  const withPendingSignature = (part: Json): Json => {
    const signature = takePendingSignature();

    return signature === ""
      ? part
      : set(part, "thoughtSignature", encodeGeminiCodexThoughtSignature(signature));
  };

  const emitImage = (itemId: string, b64: string, outputFormat: string): ReadonlyArray<string> => {
    if (b64 === "") return [];

    if (itemId !== "") {
      if (params.lastImageById.get(itemId) === b64) return [];
      params.lastImageById.set(itemId, b64);
    }

    template = set(template, "candidates.0.content.parts", [
      withPendingSignature(inlineDataPart(b64, outputFormat)),
    ]);

    return flushStorageOutputs(JSON.stringify(template));
  };

  if (type === "response.image_generation_call.partial_image") {
    return emitImage(
      asString(get(root, "item_id")),
      asString(get(root, "partial_image_b64")),
      asString(get(root, "output_format")),
    );
  }

  if (type === "response.output_item.done") {
    const item = get(root, "item");
    const itemType = asString(get(item, "type"));

    if (itemType === "reasoning") {
      const signature = asString(get(item, "encrypted_content")).trim();
      const itemId = asString(get(item, "id")).trim();
      let hadStreamedReasoning = params.hasReasoningDelta;

      if (itemId !== "" && params.streamedReasoningItems.size > 0) {
        hadStreamedReasoning = params.streamedReasoningItems.has(itemId);
      }

      params.hasReasoningDelta = false;
      const thoughtTexts = hadStreamedReasoning ? [] : reasoningTexts(item);

      if (signature === "" && thoughtTexts.length === 0) return [];

      if (signature !== "") {
        const seenKey = `${itemId}\u0000${signature}`;

        if (params.seenReasoningSignatures.has(seenKey)) return [];
        params.seenReasoningSignatures.add(seenKey);
      }

      const emittedParts: Json[] = [];

      if (params.pendingThoughtSignature !== "" && signature !== "") {
        // A previous reasoning step never got a visible carrier part; flush it as an empty thought part.
        emittedParts.push(signatureCarrierPart(takePendingSignature()));
      }

      for (const text of thoughtTexts) emittedParts.push({ thought: true, text });

      if (signature !== "") params.pendingThoughtSignature = signature;

      if (emittedParts.length === 0) return [];
      template = set(template, "candidates.0.content.parts", emittedParts);

      return flushStorageOutputs(JSON.stringify(template));
    }

    if (itemType === "image_generation_call") {
      return emitImage(
        asString(get(item, "id")),
        asString(get(item, "result")),
        asString(get(item, "output_format")),
      );
    }

    if (itemType === "function_call") {
      template = set(template, "candidates.0.content.parts", [
        withPendingSignature(functionCallPart(item, original, false)),
      ]);
      template = set(template, "candidates.0.finishReason", "STOP");
      // Held back until the next non-storage event so the finish reason can be emitted with the last call.
      params.storageOutputs.push(JSON.stringify(template));

      return [];
    }
  }

  if (type === "response.created") {
    // A new response must not inherit per-response streaming state if the caller reuses the state.
    params.storageOutputs = [];
    params.pendingThoughtSignature = "";
    params.seenReasoningSignatures = new Set();
    params.hasReasoningDelta = false;
    params.streamedReasoningItems = new Set();
    params.hasOutputTextDelta = false;
    template = set(template, "modelVersion", asString(get(root, "response.model")));
    template = set(template, "responseId", asString(get(root, "response.id")));
    params.responseId = asString(get(root, "response.id"));
  } else if (
    type === "response.output_item.added" &&
    asString(get(root, "item.type")) === "reasoning"
  ) {
    params.hasReasoningDelta = false;

    const pending = takePendingSignature();

    if (pending === "") return [];
    template = set(template, "candidates.0.content.parts", [signatureCarrierPart(pending)]);

    return flushStorageOutputs(JSON.stringify(template));
  } else if (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta"
  ) {
    params.hasReasoningDelta = true;
    const itemId = asString(get(root, "item_id")).trim();

    if (itemId !== "") params.streamedReasoningItems.add(itemId);
    const emittedParts: Json[] = [];

    const pending = takePendingSignature();

    if (pending !== "") emittedParts.push(signatureCarrierPart(pending));
    emittedParts.push({ thought: true, text: asString(get(root, "delta")) });
    template = set(template, "candidates.0.content.parts", emittedParts);
  } else if (type === "response.output_text.delta") {
    params.hasOutputTextDelta = true;
    const delta = asString(get(root, "delta"));
    // An empty text part may be discarded by clients; never spend the only copy of a signature on one.
    const part: Json = { text: delta };
    template = set(template, "candidates.0.content.parts", [
      delta !== "" ? withPendingSignature(part) : part,
    ]);
  } else if (type === "response.output_item.done") {
    const item = get(root, "item");

    if (asString(get(item, "type")) !== "message" || params.hasOutputTextDelta) return [];
    const content = get(item, "content");

    if (!isJsonArray(content)) return [];
    let wroteText = false;

    for (const part of content) {
      if (asString(get(part, "type")) !== "output_text") continue;
      const text = asString(get(part, "text"));

      if (text === "") continue;
      template = set(template, "candidates.0.content.parts.-1", withPendingSignature({ text }));
      wroteText = true;
    }

    if (!wroteText) return [];
    params.hasOutputTextDelta = true;

    return flushStorageOutputs(JSON.stringify(template));
  } else if (type === "response.completed" || type === "response.incomplete") {
    const pending = takePendingSignature();

    if (pending !== "") {
      template = set(template, "candidates.0.content.parts", [signatureCarrierPart(pending)]);
    }

    const input = asInt(get(root, "response.usage.input_tokens"));
    const output = asInt(get(root, "response.usage.output_tokens"));
    template = set(template, "usageMetadata.promptTokenCount", input);
    template = set(template, "usageMetadata.candidatesTokenCount", output);
    template = set(template, "usageMetadata.totalTokenCount", input + output);

    if (type === "response.incomplete") {
      template = set(
        template,
        "candidates.0.finishReason",
        incompleteFinishReason(asString(get(root, "response.incomplete_details.reason"))),
      );
    } else {
      // A normal completion ends the Gemini stream with STOP (Go `bdde391d`).
      template = set(template, "candidates.0.finishReason", "STOP");
    }
  } else {
    return [];
  }

  return flushStorageOutputs(JSON.stringify(template));
};

/** `ConvertCodexResponseToGeminiNonStream`. */
export const convertCodexResponseToGeminiNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const responseType = asString(get(root, "type"));

  if (responseType !== "response.completed" && responseType !== "response.incomplete") return "";
  const original = context.originalRequest;

  let template: Json = {
    candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
    usageMetadata: { trafficType: "PROVISIONED_THROUGHPUT" },
    modelVersion: "",
    createTime: "",
    responseId: "",
  };

  template = set(template, "modelVersion", context.model);
  const responseData = get(root, "response");

  if (responseData !== undefined) {
    if (responseType === "response.incomplete") {
      template = set(
        template,
        "candidates.0.finishReason",
        incompleteFinishReason(asString(get(responseData, "incomplete_details.reason"))),
      );
    }

    const id = get(responseData, "id");

    if (id !== undefined) template = set(template, "responseId", asString(id));
    const createdAt = get(responseData, "created_at");

    if (createdAt !== undefined) template = set(template, "createTime", rfc3339(asInt(createdAt)));
    const usage = get(responseData, "usage");

    if (usage !== undefined) {
      const input = asInt(get(usage, "input_tokens"));
      const output = asInt(get(usage, "output_tokens"));
      template = set(template, "usageMetadata.promptTokenCount", input);
      template = set(template, "usageMetadata.candidatesTokenCount", output);
      template = set(template, "usageMetadata.totalTokenCount", input + output);
    }

    const parts: Json[] = [];
    let pendingFunctionCalls: Json[] = [];

    const flush = () => {
      parts.push(...pendingFunctionCalls);
      pendingFunctionCalls = [];
    };

    const output = get(responseData, "output");

    if (isJsonArray(output)) {
      for (const value of output) {
        switch (asString(get(value, "type"))) {
          case "reasoning": {
            flush();
            // The summary becomes thought parts and the encrypted reasoning state a thoughtSignature on the last of
            // them, so a Gemini client can replay it next turn. With no summary text an empty thought carrier part
            // keeps the signature: dropping it would silently break replay.
            const signature = asString(get(value, "encrypted_content")).trim();
            const texts = reasoningTexts(value);

            texts.forEach((text, index) => {
              const part: Json = { text, thought: true };

              parts.push(
                index === texts.length - 1 && signature !== ""
                  ? set(part, "thoughtSignature", encodeGeminiCodexThoughtSignature(signature))
                  : part,
              );
            });

            if (texts.length === 0 && signature !== "") {
              parts.push({
                text: "",
                thought: true,
                thoughtSignature: encodeGeminiCodexThoughtSignature(signature),
              });
            }

            break;
          }

          case "message": {
            flush();
            const content = get(value, "content");

            if (isJsonArray(content)) {
              for (const item of content) {
                if (asString(get(item, "type")) !== "output_text") continue;
                const text = get(item, "text");

                if (text !== undefined) parts.push({ text: asString(text) });
              }
            }

            break;
          }

          case "image_generation_call": {
            flush();
            const b64 = asString(get(value, "result"));

            if (b64 !== "") parts.push(inlineDataPart(b64, asString(get(value, "output_format"))));
            break;
          }

          case "function_call":
            pendingFunctionCalls.push(functionCallPart(value, original, true));
            break;
        }
      }

      flush();

      if (parts.length > 0) template = set(template, "candidates.0.content.parts", parts);
    }
  }

  return JSON.stringify(template);
};

/** `GeminiTokenCount`. */
export const geminiTokenCount = (count: number): string => geminiTokenCountJson(count);

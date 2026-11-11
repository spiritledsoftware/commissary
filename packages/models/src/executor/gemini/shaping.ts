/**
 * Gemini request shaping applied between translation/thinking and the payload rules.
 *
 * Go source: internal/runtime/executor/gemini_executor.go (fixGeminiImageAspectRatio, capGeminiMaxOutputTokens),
 * internal/util/image.go (CreateWhiteImageBase64), internal/runtime/executor/helps/vertex_payload_helpers.go
 * (StripVertexOpenAIResponsesToolCallIDs), helps/gemini_interactions.go (SanitizeGeminiInteractionsUnsupportedInputIDs,
 * header helpers, SSE frame helpers).
 */
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { asInt, asString, del, exists, get, isJsonArray, type Json, set } from "@commissary/json";
import {
  compatibleGeminiSignature,
  isGeminiThoughtSignatureBypass,
  isGeminiVertexBareTinkSignature,
  signaturePayloadWithoutProviderPrefix,
} from "@commissary/translation";
import { lookupModelInfo } from "./model-info.ts";

// --- white image (fixGeminiImageAspectRatio) ---------------------------------------------------------------------------

const ASPECT_SIZES = new Map<string, readonly [number, number]>([
  ["1:1", [1024, 1024]],
  ["2:3", [832, 1248]],
  ["3:2", [1248, 832]],
  ["3:4", [864, 1184]],
  ["4:3", [1184, 864]],
  ["4:5", [896, 1152]],
  ["5:4", [1152, 896]],
  ["9:16", [768, 1344]],
  ["16:9", [1344, 768]],
  ["21:9", [1536, 672]],
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }

  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;

  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);

  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

  return out;
};

/** `CreateWhiteImageBase64`: an opaque white RGBA PNG sized for the aspect ratio (default 1024x1024). */
export const createWhiteImageBase64 = (aspectRatio: string): string => {
  const [width, height] = ASPECT_SIZES.get(aspectRatio) ?? [1024, 1024];
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rowLength = 1 + width * 4;
  const raw = new Uint8Array(rowLength * height).fill(0xff);

  for (let y = 0; y < height; y++) raw[y * rowLength] = 0; // filter type: none

  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];

  return Buffer.concat(parts).toString("base64");
};

const IMAGE_PROMPT =
  "Based on the following requirements, create an image within the uploaded picture. The new content *MUST* completely cover the entire area of the original picture, maintaining its exact proportions, and *NO* blank areas should appear.";

/** `fixGeminiImageAspectRatio`: the image-preview model needs a base image to honour `aspectRatio`. */
export const fixGeminiImageAspectRatio = (modelName: string, body: Json): Json => {
  if (modelName !== "gemini-2.5-flash-image-preview") return body;
  const aspectRatio = get(body, "generationConfig.imageConfig.aspectRatio");

  if (aspectRatio === undefined) return body;
  const contents = get(body, "contents");

  if (isJsonArray(contents) && contents.length > 0) {
    const hasInlineData = contents.some((content) => {
      const parts = get(content, "parts");

      return isJsonArray(parts) && parts.some((part) => exists(part, "inlineData"));
    });

    if (!hasInlineData) {
      const existing = get(contents[0], "parts");
      set(body, "contents.0.parts", [
        { text: IMAGE_PROMPT },
        {
          inlineData: {
            mime_type: "image/png",
            data: createWhiteImageBase64(asString(aspectRatio)),
          },
        },
        ...(isJsonArray(existing) ? existing : []),
      ]);
      set(body, "generationConfig.responseModalities", ["IMAGE", "TEXT"]);
    }
  }

  del(body, "generationConfig.imageConfig");

  return body;
};

/** `capGeminiMaxOutputTokens`: clamps `generationConfig.maxOutputTokens` to the model's output limit. */
export const capGeminiMaxOutputTokens = (body: Json, modelName: string): Json => {
  const maxOut = get(body, "generationConfig.maxOutputTokens");

  if (typeof maxOut !== "number") return body;
  const info = lookupModelInfo(modelName, "gemini");

  if (info === undefined) return body;

  const outputTokenLimit = info.outputTokenLimit ?? 0;
  const limit = outputTokenLimit > 0 ? outputTokenLimit : (info.maxCompletionTokens ?? 0);

  if (limit <= 0 || asInt(maxOut) <= limit) return body;

  return set(body, "generationConfig.maxOutputTokens", limit);
};

/** `StripVertexOpenAIResponsesToolCallIDs`: Vertex rejects OpenAI Responses call ids on function parts. */
export const stripVertexOpenAIResponsesToolCallIds = (body: Json, sourceFormat: string): Json => {
  if (sourceFormat.trim().toLowerCase() !== "openai-response") return body;
  const contents = get(body, "contents");

  if (!isJsonArray(contents)) return body;

  for (const content of contents) {
    const parts = get(content, "parts");

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      del(part, "functionCall.id");
      del(part, "functionResponse.id");
    }
  }

  return body;
};

/** The fields a `thought` step may not carry: the Interactions API takes the signature in `signature` alone. */
const THOUGHT_STEP_UNSUPPORTED_FIELDS = [
  "id",
  "content",
  "text",
  "thought_signature",
  "thoughtSignature",
] as const;

/** The thought step's signature, from `signature`, else `thought_signature`, else `thoughtSignature`. */
const thoughtStepSignature = (item: Json): string => {
  for (const key of ["signature", "thought_signature", "thoughtSignature"]) {
    const value = asString(get(item, key)).trim();

    if (value !== "") return value;
  }

  return "";
};

/**
 * `SanitizeGeminiInteractionsUnsupportedInputIDs`: `function_call` steps carry `id` (never `call_id`), every other step
 * and content part carries no `id`. A `thought` step is kept only with a replayable Gemini signature (the Interactions
 * API rejects one without, or with a foreign, corrupt or bypass-sentinel signature), normalised into `signature`.
 *
 * `allowVertexBareTink` must be true only for the Vertex AI Interactions endpoint: the public endpoint rejects a Vertex
 * bare-Tink signature, so that thought step is dropped like any other incompatible one (Go a8582fba).
 */
export const sanitizeGeminiInteractionsUnsupportedInputIds = (
  body: Json,
  allowVertexBareTink: boolean,
): Json => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return body;
  const kept: Json[] = [];

  for (const item of input) {
    if (asString(get(item, "type")) === "thought") {
      const raw = thoughtStepSignature(item);
      let normalized = compatibleGeminiSignature(raw) ?? "";

      if (!allowVertexBareTink && isGeminiVertexBareTinkSignature(normalized)) normalized = "";

      if (
        normalized === "" ||
        isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(normalized))
      ) {
        continue;
      }

      if (normalized !== asString(get(item, "signature"))) set(item, "signature", normalized);

      for (const field of THOUGHT_STEP_UNSUPPORTED_FIELDS) del(item, field);
      kept.push(item);
      continue;
    }

    if (asString(get(item, "type")) === "function_call") {
      if (!exists(item, "id") && exists(item, "call_id"))
        set(item, "id", asString(get(item, "call_id")));

      if (exists(item, "call_id")) del(item, "call_id");
    } else if (exists(item, "id")) {
      del(item, "id");
    }

    const content = get(item, "content");

    if (isJsonArray(content)) {
      for (const part of content) if (exists(part, "id")) del(part, "id");
    }

    kept.push(item);
  }

  if (kept.length !== input.length) set(body, "input", kept);

  return body;
};

/** `GeminiInteractionsAPIRevision`. */
export const GEMINI_INTERACTIONS_API_REVISION = "2026-05-20";

/** `ApplyGeminiInteractionsRequestHeaders` + `ApplyGeminiInteractionsRevisionHeader`. */
export const applyInteractionsRevisionHeaders = (
  headers: Record<string, string>,
  client: Headers,
): void => {
  const existing = Object.keys(headers).find((name) => name.toLowerCase() === "api-revision");

  if (existing === undefined) {
    const revision = client.get("api-revision") ?? "";
    headers["Api-Revision"] = revision !== "" ? revision : GEMINI_INTERACTIONS_API_REVISION;
  }
};

/** `GeminiInteractionsSSEPayload`: the JSON payload of one SSE frame (blank-line separated). */
export const interactionsSsePayload = (frame: string): string | undefined => {
  const trimmed = frame.trim();

  if (trimmed === "") return undefined;

  if (trimmed.startsWith("{")) return trimmed;
  const out: string[] = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r+$/, "");

    if (!line.trim().startsWith("data:")) continue;
    const data = line.slice(line.indexOf("data:") + 5).trim();

    if (data === "" || data === "[DONE]") continue;
    out.push(data);
  }

  return out.length === 0 ? undefined : out.join("\n");
};

/** `GeminiInteractionsSSEDone`. */
export const interactionsSseDone = (frame: string): boolean => {
  if (frame.trim() === "[DONE]") return true;
  let sawDoneEvent = false;

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r+$/, "").trim();

    if (line.toLowerCase() === "event: done") {
      sawDoneEvent = true;
      continue;
    }

    if (line.startsWith("data:") && line.slice(5).trim() === "[DONE]") return true;
  }

  return sawDoneEvent;
};

/**
 * Helpers shared by the Interactions <-> OpenAI Responses translators.
 *
 * Go sources: internal/translator/openai/interactions/responses/{interactions_openai_responses_request.go,
 * interactions_openai_responses_response.go} (helper functions).
 */
import { cloneJson, get, type Json, type JsonObject, set } from "@commissary/json";
import {
  antigravityToolNameToUpstream,
  antigravityUpstreamToolNameToClient,
} from "../../common/antigravity-tools.ts";
import { normalizeOpenAIFileData } from "../../../common/file-data.ts";
import { getStr, isArr, str } from "../../common/read.ts";
import {
  type ResponsesToolIdentity,
  qualifyResponsesNamespaceToolName,
  unwrapResponsesCustomToolInput,
} from "../../../common/responses-tools.ts";
import { isDevinOpenAIReasoningSignature } from "../../../../signature/gpt.ts";
import { DevinSignatureType } from "../../../../signature/devin-signature-type.ts";
import { isRecognizedReasoningSignature } from "../../../../signature/grok.ts";
import { firstNonEmpty, jsonStringValue } from "../chat-completions/shared.ts";

export {
  parseJsonOrUndefined as parseJson,
  firstExisting,
  firstNonEmpty,
  isAntigravityModel,
  jsonStringValue,
  ssePayloadOf,
} from "../chat-completions/shared.ts";

/** `isDevinModel`. */
export const isDevinModel = (model: string): boolean =>
  model.trim().toLowerCase().includes("devin");

/** `setJSONValue`: JSON strings holding valid JSON are inlined, other strings stay strings, missing -> default. */
export const setJsonValue = (
  out: JsonObject,
  path: string,
  value: Json | undefined,
  defaultValue: Json,
): void => {
  if (value === undefined) {
    set(out, path, cloneJson(defaultValue));

    return;
  }

  if (typeof value === "string") {
    try {
      set(out, path, JSON.parse(value));
    } catch {
      set(out, path, value);
    }

    return;
  }

  set(out, path, cloneJson(value));
};

/** `interactionsTextStep`. */
export const textStep = (stepType: string, text: string): JsonObject => ({
  type: stepType,
  content: [{ type: "text", text }],
});

/** `parseDataURL` (no base64 requirement). */
export const parseDataUrl = (value: string): { mimeType: string; data: string } | undefined => {
  if (!value.startsWith("data:")) return undefined;
  const rest = value.slice("data:".length);
  const comma = rest.indexOf(",");

  if (comma < 0) return undefined;
  const header = rest.slice(0, comma);
  const data = rest.slice(comma + 1);
  const semi = header.indexOf(";");
  let mimeType = semi >= 0 ? header.slice(0, semi) : header;

  if (mimeType === "") mimeType = "application/octet-stream";

  return { mimeType, data };
};

/** `mediaFormat`. */
export const mediaFormat = (mimeType: string): string => {
  if (mimeType === "") return "unknown";
  const slash = mimeType.indexOf("/");

  if (slash >= 0 && slash + 1 < mimeType.length) return mimeType.slice(slash + 1);

  return mimeType;
};

/** `interactionsMediaDataURL`. */
export const interactionsMediaDataUrl = (part: Json): string => {
  const url = firstNonEmpty(
    getStr(part, "image_url"),
    getStr(part, "file_data"),
    getStr(part, "url"),
  );

  if (url !== "") return url;
  const data = getStr(part, "data");

  if (data === "") return "";
  const mimeType = getStr(part, "mime_type");

  return `data:${mimeType === "" ? "application/octet-stream" : mimeType};base64,${data}`;
};

/** `interactionsContentTexts`. */
export const interactionsContentTexts = (content: Json | undefined): string[] => {
  if (typeof content === "string") return [content];
  const texts: string[] = [];

  if (isArr(content)) {
    for (const part of content) {
      const text = firstNonEmpty(getStr(part, "text"), getStr(part, "content.text"));

      if (text !== "") texts.push(text);
    }
  }

  return texts;
};

const responsesInputAudioMimeType = (format: string): string => {
  switch (format.trim().toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/opus";
    case "pcm16":
      return "audio/pcm";
    default:
      return "audio/mpeg";
  }
};

/** `responsesImagePartToInteractions`. */
const responsesImagePartToInteractions = (part: Json): JsonObject => {
  const out: JsonObject = { type: "image" };
  const imageUrl = firstNonEmpty(getStr(part, "image_url"), getStr(part, "url"));
  const parsed = parseDataUrl(imageUrl);

  if (parsed !== undefined) {
    out.mime_type = parsed.mimeType;
    out.data = parsed.data;

    return out;
  }

  const data = getStr(part, "data");

  if (data !== "") {
    out.data = data;
    const mimeType = getStr(part, "mime_type");

    if (mimeType !== "") out.mime_type = mimeType;

    return out;
  }

  if (imageUrl !== "") out.image_url = imageUrl;

  return out;
};

/** `responsesFilePartToInteractions`: a bare file id has no Interactions counterpart. */
const responsesFilePartToInteractions = (part: Json): JsonObject | undefined => {
  const filename = getStr(part, "filename");
  const fallbackMimeType = firstNonEmpty(getStr(part, "mime_type"), getStr(part, "mimeType"));
  const out: JsonObject = { type: "document" };

  if (filename !== "") out.filename = filename;
  let hasContent = false;
  const normalized = normalizeOpenAIFileData(filename, fallbackMimeType, getStr(part, "file_data"));

  if (normalized !== undefined) {
    out.mime_type = normalized.mimeType;
    out.data = normalized.data;
    hasContent = true;
  }

  const fileUrl = getStr(part, "file_url");

  if (fileUrl !== "") {
    out.file_url = fileUrl;
    hasContent = true;
  }

  return hasContent ? out : undefined;
};

/** `responsesAudioPartToInteractions`. */
const responsesAudioPartToInteractions = (part: Json): JsonObject | undefined => {
  const data = firstNonEmpty(getStr(part, "input_audio.data"), getStr(part, "data"));

  if (data === "") return undefined;
  const out: JsonObject = { type: "audio", data };
  const format = firstNonEmpty(getStr(part, "input_audio.format"), getStr(part, "format"));

  if (format !== "") out.mime_type = responsesInputAudioMimeType(format);

  return out;
};

/** `responsesContentPartToInteractions`. */
export const responsesContentPartToInteractions = (part: Json): JsonObject | undefined => {
  switch (getStr(part, "type")) {
    case "input_text":
    case "output_text":
    case "text":
      return { type: "text", text: getStr(part, "text") };
    case "input_image":
    case "output_image":
      return responsesImagePartToInteractions(part);
    case "input_file":
      return responsesFilePartToInteractions(part);
    case "input_audio":
      return responsesAudioPartToInteractions(part);
  }

  const text = get(part, "text");

  if (text !== undefined) return { type: "text", text: str(text) };

  return undefined;
};

const qualifiedItemName = (item: Json, forAntigravity: boolean): string => {
  let name = getStr(item, "name");
  const ns = getStr(item, "namespace");

  if (ns !== "" && name !== "") name = qualifyResponsesNamespaceToolName(ns, name);

  if (forAntigravity) name = antigravityToolNameToUpstream(name);

  return name;
};

/** `responsesFunctionCallToInteractions`. */
export const responsesFunctionCallToInteractions = (
  item: Json,
  forAntigravity: boolean,
): JsonObject => {
  const out: JsonObject = {
    type: "function_call",
    name: qualifiedItemName(item, forAntigravity),
    arguments: {},
  };

  const callId = firstNonEmpty(getStr(item, "call_id"), getStr(item, "id"));

  if (callId !== "") out.call_id = callId;
  setJsonValue(out, "arguments", get(item, "arguments"), {});

  return out;
};

/** `responsesCustomToolCallToInteractions`. */
export const responsesCustomToolCallToInteractions = (
  item: Json,
  forAntigravity: boolean,
): JsonObject => {
  const out: JsonObject = {
    type: "function_call",
    name: qualifiedItemName(item, forAntigravity),
    arguments: {},
  };

  const callId = firstNonEmpty(getStr(item, "call_id"), getStr(item, "id"));

  if (callId !== "") out.call_id = callId;
  const input = get(item, "input");

  if (input !== undefined) set(out, "arguments.input", str(input));
  else setJsonValue(out, "arguments", get(item, "arguments"), {});

  return out;
};

/**
 * `interactionsTypedThoughtSignature`: a `signature` typed `openai` that is Devin's list of GPT reasoning items is kept
 * verbatim; any other signature must be a recognised reasoning signature.
 */
export const interactionsTypedThoughtSignature = (step: Json | undefined): string => {
  const raw = get(step, "signature");

  if (
    typeof raw === "string" &&
    getStr(step, "signature_type") === DevinSignatureType.openai &&
    isDevinOpenAIReasoningSignature(raw)
  ) {
    return raw;
  }

  return interactionsReasoningEncryptedContent(getStr(step, "signature"));
};

/** `interactionsThoughtSignature`: the first recognised reasoning signature of a thought step. */
export const interactionsThoughtSignature = (step: Json): string => {
  const encrypted = interactionsReasoningEncryptedContent(getStr(step, "encrypted_content"));

  if (encrypted !== "") return encrypted;
  const typed = interactionsTypedThoughtSignature(step);

  if (typed !== "") return typed;

  for (const path of [
    "thought_signature",
    "thoughtSignature",
    "extra_content.google.thought_signature",
  ]) {
    const signature = interactionsReasoningEncryptedContent(getStr(step, path));

    if (signature !== "") return signature;
  }

  const content = get(step, "content");

  if (isArr(content)) {
    for (const part of content) {
      const candidate = firstNonEmpty(
        getStr(part, "signature"),
        getStr(part, "thought_signature"),
        getStr(part, "thoughtSignature"),
        getStr(part, "extra_content.google.thought_signature"),
      );

      const valid = interactionsReasoningEncryptedContent(candidate);

      if (valid !== "") return valid;
    }
  }

  return "";
};

/** `interactionsReasoningEncryptedContent`. */
export const interactionsReasoningEncryptedContent = (rawSignature: string): string => {
  const candidate = rawSignature.trim();

  if (candidate === "") return "";

  return isRecognizedReasoningSignature(candidate) ? candidate : "";
};

/** `interactionsContentPartToResponses`. */
export const interactionsContentPartToResponses = (
  part: Json,
  role: string,
): JsonObject | undefined => {
  let partType = getStr(part, "type");

  if (partType === "" && get(part, "text") !== undefined) partType = "text";

  switch (partType) {
    case "text":
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: getStr(part, "text"),
      };
    case "image": {
      const out: JsonObject = { type: role === "assistant" ? "output_image" : "input_image" };
      const imageUrl = interactionsMediaDataUrl(part);

      if (imageUrl !== "") out.image_url = imageUrl;

      return out;
    }

    case "audio":
      return {
        type: "output_text",
        text: `Audio content: inline data (Format: ${mediaFormat(getStr(part, "mime_type"))})`,
      };
    case "video":
    case "document": {
      const out: JsonObject = { type: role === "assistant" ? "output_file" : "input_file" };
      const dataUrl = interactionsMediaDataUrl(part);

      if (dataUrl !== "") out.file_data = dataUrl;
      const filename = getStr(part, "filename");

      if (filename !== "") out.filename = filename;

      return out;
    }
  }

  return undefined;
};

/** `interactionsFunctionCallToResponsesWithIdentity`. */
export const interactionsFunctionCallToResponses = (
  item: Json,
  forAntigravity: boolean,
  identities: ReadonlyMap<string, ResponsesToolIdentity> | undefined,
): JsonObject => {
  const rawName = getStr(item, "name");
  let name = rawName;
  let namespace = "";
  let isCustom = false;

  if (forAntigravity) name = antigravityUpstreamToolNameToClient(name);

  if (identities !== undefined) {
    const identity = identities.get(rawName) ?? identities.get(name);

    if (identity !== undefined) {
      name = identity.name;
      namespace = identity.namespace;
      isCustom = identity.custom;
    }
  }

  const callId = firstNonEmpty(getStr(item, "call_id"), getStr(item, "id"));

  if (isCustom) {
    const out: JsonObject = { type: "custom_tool_call", call_id: "", name: "", input: "" };

    if (callId !== "") out.call_id = callId;

    if (namespace !== "") out.namespace = namespace;
    out.name = name;
    out.input = unwrapResponsesCustomToolInput(jsonStringValue(get(item, "arguments"), "{}"));

    return out;
  }

  const out: JsonObject = { type: "function_call", call_id: "", name: "", arguments: "{}" };

  if (callId !== "") out.call_id = callId;

  if (namespace !== "") out.namespace = namespace;
  out.name = name;
  out.arguments = jsonStringValue(get(item, "arguments"), "{}");

  return out;
};

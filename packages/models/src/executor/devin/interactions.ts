/**
 * Interactions request -> Devin prompts/tools.
 *
 * Go source: internal/runtime/executor/devin_executor.go (`parseInteractionsPayload`, `extractInteractionsStepContent`,
 * `extractInteractionsStepText`, `extractFunctionResultContent`, `extractFunctionResultTarget`, `extractDevinImage`,
 * `supplementSignaturesFromOriginal`, `supplementImagesFromOriginal`, `parseSignatureBytes`, `detectSignatureType`,
 * `normalizeDevinUUID`), internal/runtime/executor/helps/devin_user_turn.go (`CheckDevinUserTurns`).
 * Signature provenance uses the full `internal/signature` port (`signature/provider.ts`, `DetectSignatureProvider`).
 */
import { randomUUID } from "node:crypto";
import {
  asFloat,
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";
import { bytesToBinaryString, detectSignatureProvider } from "@commissary/translation/signature";
import { UserRun } from "@commissary/translation";
import { uuidV5Oid } from "../helps/uuid.ts";
import {
  DEVIN_DEFAULT_MAX_TOKENS,
  type DevinImage,
  type DevinPrompt,
  type DevinTool,
  type DevinToolCall,
  newDevinPrompt,
} from "./wire.ts";
import { isCodexAppAutomationUpdate, sanitizeDevinToolDescription } from "./tools.ts";

const utf8 = new TextEncoder();

const EMPTY_TOOL_RESULT = "{}";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Go `gjson.Result.Raw` of a value (compact JSON text; strings keep their quotes). */
const raw = (value: Json | undefined): string => (value === undefined ? "" : JSON.stringify(value));

const firstNonEmpty = (...values: ReadonlyArray<string>): string =>
  values.find((value) => value.trim() !== "") ?? "";

export interface ParsedInteractions {
  readonly systemPrompt: string;
  readonly prompts: DevinPrompt[];
  readonly tools: DevinTool[];
  readonly temperature: number | undefined;
  readonly maxTokens: number;
  readonly sessionId: string;
  readonly cascadeId: string;
  readonly thinkingLevel: string;
  readonly budgetTokens: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------------------------------------------

const parseDataUrl = (
  rawUrl: string,
): { readonly mimeType: string; readonly data: string } | undefined => {
  const value = rawUrl.trim();

  if (!value.startsWith("data:")) return undefined;
  const comma = value.indexOf(",");

  if (comma < 0) return undefined;
  const mimeType = value.slice(5, comma).split(";")[0]?.trim() ?? "";

  return { mimeType: mimeType !== "" ? mimeType : "image/png", data: value.slice(comma + 1) };
};

const mimeExtension = (mime: string): string => {
  switch (mime.trim().toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
};

/** `extractDevinImage`: an inline image part (data URL, base64 `data`/`source`/`inline_data`); remote URLs are not sendable. */
const extractImage = (part: Json | undefined): DevinImage | undefined => {
  const partType = asString(get(part, "type")).trim().toLowerCase();

  if (partType !== "image" && partType !== "input_image" && partType !== "image_url")
    return undefined;
  let data = asString(get(part, "data")).trim();
  let mimeType = asString(get(part, "mime_type")).trim();

  if (data === "") {
    data = asString(get(part, "source.data")).trim();

    if (mimeType === "") mimeType = asString(get(part, "source.media_type")).trim();
  }

  if (data === "") {
    const url = firstNonEmpty(
      asString(get(part, "image_url.url")),
      asString(get(part, "image_url")),
      asString(get(part, "url")),
      asString(get(part, "uri")),
      asString(get(part, "file_uri")),
      asString(get(part, "fileUri")),
    );

    const parsed = parseDataUrl(url);

    if (parsed !== undefined) {
      data = parsed.data;

      if (mimeType === "") mimeType = parsed.mimeType;
    }
  }

  if (data === "") {
    data = asString(get(part, "inline_data.data")).trim();

    if (mimeType === "") mimeType = asString(get(part, "inline_data.mime_type")).trim();
  }

  if (data === "") return undefined;

  return { base64Data: data, mimeType: mimeType !== "" ? mimeType : "image/png" };
};

const imageHeaders = (images: ReadonlyArray<DevinImage>): string =>
  images
    .map(
      (image, index) =>
        `[Image ${index + 1}: pasted_image_${index + 1}.${mimeExtension(image.mimeType)}]`,
    )
    .join("\n");

/** Prepends `[Image n: …]` placeholders unless the text already carries them. */
const withImageHeaders = (text: string, images: ReadonlyArray<DevinImage>): string => {
  if (images.length === 0 || text.includes("[Image ")) return text;
  const header = imageHeaders(images);

  return text !== "" ? `${header}\n\n${text}` : header;
};

/** `devinUnsendableMediaType`. */
const unsendableMediaType = (part: Json | undefined): string => {
  if (asString(get(part, "text")) !== "") return "";
  const type = asString(get(part, "type")).trim().toLowerCase();

  return [
    "image",
    "input_image",
    "image_url",
    "audio",
    "input_audio",
    "video",
    "document",
    "file",
    "input_file",
  ].includes(type)
    ? type
    : "";
};

interface StepContent {
  readonly text: string;
  readonly images: DevinImage[];
  readonly droppedPart: string;
}

interface ResultContent {
  readonly text: string;
  readonly images: DevinImage[];
}

const extractStepContent = (step: Json | undefined): StepContent => {
  const content = get(step, "content");
  const textParts: string[] = [];
  const images: DevinImage[] = [];
  let droppedPart = "";

  const fromPart = (part: Json): void => {
    const image = extractImage(part);

    if (image !== undefined) {
      images.push(image);

      return;
    }

    const text = asString(get(part, "text"));

    if (text !== "") textParts.push(text);

    if (droppedPart === "") droppedPart = unsendableMediaType(part);
  };

  if (typeof content === "string") textParts.push(content);
  else if (isJsonArray(content)) content.forEach(fromPart);
  else if (get(step, "text") !== undefined) textParts.push(asString(get(step, "text")));

  return { text: withImageHeaders(textParts.join("\n"), images), images, droppedPart };
};

const extractStepText = (step: Json | undefined): string => {
  const content = get(step, "content");

  if (typeof content === "string") return content;

  if (isJsonArray(content)) {
    return content
      .map((part) => asString(get(part, "text")))
      .filter((text) => text !== "")
      .join("\n");
  }

  return asString(get(step, "text"));
};

/** `isProtocolWrapperObject`: a tool_result block / single-key envelope around `wrapperKey`. */
const isProtocolWrapper = (value: Json | undefined, wrapperKey: string): boolean => {
  if (!isJsonObject(value) || value[wrapperKey] === undefined) return false;
  const keys = Object.keys(value);

  if (asString(value["type"]).trim().toLowerCase() === "tool_result") {
    return keys.every((key) =>
      ["type", "tool_use_id", "id", "is_error", "cache_control", wrapperKey].includes(key),
    );
  }

  return keys.every((key) => key === wrapperKey || key === "cache_control");
};

const isPureTextPart = (value: JsonObject): boolean =>
  Object.keys(value).every((key) => key === "type" || key === "text" || key === "cache_control");

const extractResultTarget = (target: Json | undefined): ResultContent => {
  if (target === undefined) return { text: "", images: [] };

  if (typeof target === "string") return { text: target, images: [] };
  const image = extractImage(target);

  if (image !== undefined) return { text: "", images: [image] };

  if (isJsonObject(target)) {
    for (const key of ["content", "output", "result"]) {
      if (isProtocolWrapper(target, key)) return extractResultTarget(target[key]);
    }

    if (asString(target["type"]).trim().toLowerCase() === "text" && isPureTextPart(target)) {
      return { text: asString(target["text"]), images: [] };
    }

    return { text: raw(target), images: [] };
  }

  if (isJsonArray(target)) {
    const textParts: string[] = [];
    const images: DevinImage[] = [];
    let structured = false;

    for (const item of target) {
      const itemImage = extractImage(item);

      if (itemImage !== undefined) {
        images.push(itemImage);
        structured = true;
        continue;
      }

      if (isJsonObject(item)) {
        const wrapperKey = ["content", "output", "result"].find((key) =>
          isProtocolWrapper(item, key),
        );

        if (wrapperKey !== undefined) {
          structured = true;
          const inner = extractResultTarget(item[wrapperKey]);

          if (inner.text !== "") textParts.push(inner.text);
          images.push(...inner.images);
          continue;
        }

        if (asString(item["type"]).trim().toLowerCase() === "text") {
          if (isPureTextPart(item)) {
            structured = true;
            const text = asString(item["text"]);

            if (text !== "") textParts.push(text);
          } else if (raw(item).trim() !== "") {
            textParts.push(raw(item).trim());
          }

          continue;
        }
      }

      const rawItem = raw(item).trim();

      if (rawItem !== "") textParts.push(rawItem);
    }

    if (structured || images.length > 0) return { text: textParts.join("\n"), images };

    return { text: raw(target), images: [] };
  }

  return { text: raw(target), images: [] };
};

/** `extractFunctionResultContent`. */
const extractFunctionResultContent = (step: Json | undefined): ResultContent => {
  const target = get(step, "result") ?? get(step, "output") ?? get(step, "content");

  if (target === undefined) return { text: EMPTY_TOOL_RESULT, images: [] };
  const extracted = extractResultTarget(target);
  const text = withImageHeaders(extracted.text, extracted.images);

  return text.trim() === "" && extracted.images.length === 0
    ? { text: EMPTY_TOOL_RESULT, images: extracted.images }
    : { text, images: extracted.images };
};

// ---------------------------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------------------------

/** `DetectSignatureProvider` restricted to the families Devin distinguishes. */
const detectProvider = (signature: string): "claude" | "gpt" | "gemini" | "" => {
  switch (detectSignatureProvider(signature)) {
    case "claude":
      return "claude";
    case "gpt":
      return "gpt";
    case "gemini":
      return "gemini";
    default:
      return "";
  }
};

const detectSignatureType = (signature: string): string => {
  const s = signature.trim();

  if (s.startsWith("sealed.v1.")) return "sealed";

  if (s.startsWith("claude#")) return "anthropic";

  if (s.startsWith("gpt#")) return "openai";

  if (s.startsWith("gemini#")) return "gemini";

  switch (detectProvider(s)) {
    case "claude":
      return "anthropic";
    case "gpt":
      return "openai";
    case "gemini":
      return "gemini";
  }

  if (s.startsWith("CAQS") || s.startsWith("CAIS")) return "anthropic";

  if (s.startsWith("gAAAA")) return "openai";

  if (s.startsWith("AY")) return "gemini";

  return "sealed";
};

const decodeStdBase64 = (value: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return undefined;

  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

export interface SignatureBytes {
  readonly bytes: Uint8Array;
  readonly type: string;
}

/** `parseSignatureBytes`: the wire signature bytes and its type tag. */
export const parseSignatureBytes = (signature: string): SignatureBytes => {
  const s = signature.trim();

  if (s === "") return { bytes: new Uint8Array(0), type: "" };

  if (s.startsWith("sealed.v1.")) return { bytes: utf8.encode(s), type: "sealed" };

  if (s.startsWith("claude#"))
    return { bytes: utf8.encode(s.slice("claude#".length)), type: "anthropic" };

  if (s.startsWith("gpt#")) return { bytes: utf8.encode(s.slice("gpt#".length)), type: "openai" };

  if (s.startsWith("gemini#"))
    return { bytes: utf8.encode(s.slice("gemini#".length)), type: "gemini" };

  switch (detectProvider(s)) {
    case "claude":
      return { bytes: utf8.encode(s), type: "anthropic" };
    case "gpt":
      return { bytes: utf8.encode(s), type: "openai" };
    case "gemini":
      return { bytes: utf8.encode(s), type: "gemini" };
  }

  if (s.startsWith("AY")) return { bytes: utf8.encode(s), type: "gemini" };
  const decoded = decodeStdBase64(s);

  if (decoded !== undefined && decoded.length > 0) {
    const text = bytesToBinaryString(decoded);

    if (text.startsWith("sealed.v1.")) return { bytes: decoded, type: "sealed" };

    switch (detectProvider(text)) {
      case "claude":
        return { bytes: decoded, type: "anthropic" };
      case "gpt":
        return { bytes: decoded, type: "openai" };
      case "gemini":
        return { bytes: utf8.encode(s), type: "gemini" };
    }

    if (text.startsWith("CAQS") || text.startsWith("CAIS"))
      return { bytes: decoded, type: "anthropic" };

    if (text.startsWith("gAAAA")) return { bytes: decoded, type: "openai" };

    if (decoded[0] === 0x01) return { bytes: utf8.encode(s), type: "gemini" };
  }

  return { bytes: utf8.encode(s), type: detectSignatureType(s) };
};

// ---------------------------------------------------------------------------------------------------------------
// Supplements from the original (Claude-format) request
// ---------------------------------------------------------------------------------------------------------------

interface AssistantSignatureMeta {
  signature: Uint8Array;
  signatureType: string;
  thinking: string;
}

/** `supplementSignaturesFromOriginal`: thinking/signature blocks the translator lost, by assistant order. */
const supplementSignatures = (original: Json, prompts: DevinPrompt[]): void => {
  const messages = get(original, "messages");

  if (!isJsonArray(messages)) return;
  const assistants: AssistantSignatureMeta[] = [];

  for (const message of messages) {
    if (asString(get(message, "role")).toLowerCase() !== "assistant") continue;

    const meta: AssistantSignatureMeta = {
      signature: new Uint8Array(0),
      signatureType: "",
      thinking: "",
    };

    const content = get(message, "content");

    if (isJsonArray(content)) {
      for (const part of content) {
        if (asString(get(part, "type")) !== "thinking") continue;
        const signature = asString(get(part, "signature"));

        if (signature !== "") {
          const parsed = parseSignatureBytes(signature);

          if (parsed.bytes.length > 0) {
            meta.signature = parsed.bytes;
            meta.signatureType = parsed.type;
          }
        }

        const thinking = asString(get(part, "thinking"));

        if (thinking !== "") meta.thinking = thinking;
      }
    }

    assistants.push(meta);
  }

  let index = 0;

  for (const prompt of prompts) {
    if (prompt.source !== 2) continue;
    const original_ = assistants[index];

    if (original_ === undefined) continue;

    if (prompt.signature.length === 0 && original_.signature.length > 0) {
      prompt.signature = original_.signature;
      prompt.signatureType = original_.signatureType;
    }

    if (prompt.thinking === "" && original_.thinking !== "") prompt.thinking = original_.thinking;
    index++;
  }
};

/** `supplementImagesFromOriginal`: images of the original messages for prompts the translator left imageless. */
const supplementImages = (original: Json, prompts: DevinPrompt[]): void => {
  const messages = get(original, "messages");

  if (!isJsonArray(messages)) return;
  const userImages: DevinImage[][] = [];
  const toolImagesById = new Map<string, DevinImage[]>();

  const addTool = (id: string, images: DevinImage[]): void => {
    if (images.length > 0 && id !== "")
      toolImagesById.set(id, [...(toolImagesById.get(id) ?? []), ...images]);
  };

  for (const message of messages) {
    const role = asString(get(message, "role")).trim().toLowerCase();

    if (role === "user") {
      const images: DevinImage[] = [];
      const content = get(message, "content");

      if (isJsonArray(content)) {
        for (const part of content) {
          if (asString(get(part, "type")).trim().toLowerCase() === "tool_result") {
            const id = firstNonEmpty(asString(get(part, "tool_use_id")), asString(get(part, "id")));
            const toolImages: DevinImage[] = [];
            const toolContent = get(part, "content");

            if (isJsonArray(toolContent)) {
              for (const sub of toolContent) {
                const image = extractImage(sub);

                if (image !== undefined) toolImages.push(image);
              }
            } else {
              const image = extractImage(part);

              if (image !== undefined) toolImages.push(image);
            }

            addTool(id, toolImages);
          } else {
            const image = extractImage(part);

            if (image !== undefined) images.push(image);
          }
        }
      }

      userImages.push(images);
    } else if (role === "tool") {
      const id = firstNonEmpty(
        asString(get(message, "tool_call_id")),
        asString(get(message, "id")),
      );

      const toolImages: DevinImage[] = [];
      const content = get(message, "content");

      if (isJsonArray(content)) {
        for (const sub of content) {
          const image = extractImage(sub);

          if (image !== undefined) toolImages.push(image);
        }
      } else {
        const image = extractImage(message);

        if (image !== undefined) toolImages.push(image);
      }

      addTool(id, toolImages);
    }
  }

  const attach = (prompt: DevinPrompt, images: DevinImage[]): void => {
    prompt.images = images;
    prompt.content = withImageHeaders(prompt.content, images);
  };

  let userIndex = 0;

  for (const prompt of prompts) {
    if (prompt.source === 1) {
      if (prompt.isOrphanedTool) {
        const matched = toolImagesById.get(prompt.originalToolCallId);

        if (
          prompt.images.length === 0 &&
          prompt.originalToolCallId !== "" &&
          matched !== undefined &&
          matched.length > 0
        ) {
          attach(prompt, matched);
        }

        continue;
      }

      const images = userImages[userIndex];

      if (prompt.images.length === 0 && images !== undefined && images.length > 0)
        attach(prompt, images);
      userIndex++;
    } else if (prompt.source === 4) {
      const matched = toolImagesById.get(prompt.toolCallId);

      if (
        prompt.images.length === 0 &&
        prompt.toolCallId !== "" &&
        matched !== undefined &&
        matched.length > 0
      ) {
        attach(prompt, matched);
      }
    }
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------------------------------------------

const toolCallArguments = (value: Json | undefined): string =>
  typeof value === "string" ? value : value === undefined ? "" : raw(value);

/** `parseInteractionsPayload`. */
export const parseInteractionsPayload = (
  payload: Json,
  originalRequest: Json | undefined,
): ParsedInteractions => {
  let systemPrompt = asString(get(payload, "system_instruction")).trim();

  if (systemPrompt === "") systemPrompt = asString(get(payload, "systemInstruction")).trim();

  let temperature: number | undefined;
  let maxTokens = 0;
  let thinkingLevel = "";
  let budgetTokens = 0;
  const genConfig = get(payload, "generation_config") ?? get(payload, "generationConfig");

  if (genConfig !== undefined) {
    if (get(genConfig, "temperature") !== undefined)
      temperature = asFloat(get(genConfig, "temperature"));
    maxTokens = asInt(get(genConfig, "max_output_tokens"));
    thinkingLevel = asString(get(genConfig, "thinking_level"));
    budgetTokens = asInt(get(genConfig, "thinking_config.thinking_budget"));
  }

  if (temperature === undefined) {
    if (get(originalRequest, "temperature") !== undefined)
      temperature = asFloat(get(originalRequest, "temperature"));
    else if (get(payload, "temperature") !== undefined)
      temperature = asFloat(get(payload, "temperature"));
  }

  if (maxTokens <= 0) maxTokens = DEVIN_DEFAULT_MAX_TOKENS;

  const sessionKeys = ["session_id", "sessionId", "conversation_id", "previous_interaction_id"];
  let sessionId = firstNonEmpty(...sessionKeys.map((key) => asString(get(payload, key)))).trim();

  if (sessionId === "" && originalRequest !== undefined) {
    sessionId = firstNonEmpty(
      ...sessionKeys.map((key) => asString(get(originalRequest, key))),
    ).trim();
  }

  const cascadeId = sessionId;

  const prompts: DevinPrompt[] = [];
  const pending: string[] = [];

  const matchPending = (id: string): string | undefined => {
    let index = -1;

    if (id !== "") index = pending.indexOf(id);
    else if (pending.length > 0) index = 0;

    if (index < 0) return undefined;
    const matched = pending[index] ?? "";
    pending.splice(index, 1);

    return id !== "" ? id : matched;
  };

  const last = (): DevinPrompt | undefined => prompts[prompts.length - 1];

  const addToolResult = (id: string, step: Json): void => {
    const { text, images } = extractFunctionResultContent(step);
    const matched = matchPending(id);
    prompts.push(
      matched !== undefined
        ? newDevinPrompt({ source: 4, toolCallId: matched, content: text, images })
        : newDevinPrompt({
            source: 1,
            originalToolCallId: id,
            isOrphanedTool: true,
            content: text,
            images,
          }),
    );
  };

  const input = get(payload, "input");
  const messages = get(payload, "messages");

  if (isJsonArray(input)) {
    for (const step of input) {
      const type = asString(get(step, "type")).trim().toLowerCase();

      switch (type) {
        case "user_input": {
          const { text, images, droppedPart } = extractStepContent(step);
          prompts.push(newDevinPrompt({ source: 1, content: text, images, droppedPart }));
          break;
        }

        case "model_output": {
          const text = extractStepText(step);

          const signature = parseSignatureBytes(
            firstNonEmpty(
              asString(get(step, "signature")),
              asString(get(step, "thought_signature")),
            ),
          );

          const previous = last();

          if (previous !== undefined && previous.source === 2) {
            previous.content = previous.content !== "" ? `${previous.content}\n${text}` : text;

            if (signature.bytes.length > 0 && previous.signature.length === 0) {
              previous.signature = signature.bytes;
              previous.signatureType = signature.type;
            }
          } else {
            prompts.push(
              newDevinPrompt({
                source: 2,
                content: text,
                signature: signature.bytes,
                signatureType: signature.type,
              }),
            );
          }

          break;
        }

        case "thought": {
          const text = extractStepText(step);

          const signature = parseSignatureBytes(
            firstNonEmpty(
              asString(get(step, "signature")),
              asString(get(step, "thought_signature")),
            ),
          );

          const previous = last();

          if (previous !== undefined && previous.source === 2) {
            previous.thinking = previous.thinking !== "" ? `${previous.thinking}\n\n${text}` : text;

            if (signature.bytes.length > 0 && previous.signature.length === 0) {
              previous.signature = signature.bytes;
              previous.signatureType = signature.type;
            }
          } else {
            prompts.push(
              newDevinPrompt({
                source: 2,
                thinking: text,
                signature: signature.bytes,
                signatureType: signature.type,
              }),
            );
          }

          break;
        }

        case "function_call": {
          const id = firstNonEmpty(asString(get(step, "id")), asString(get(step, "call_id")));

          const call: DevinToolCall = {
            id,
            name: asString(get(step, "name")),
            arguments: toolCallArguments(get(step, "arguments")),
          };

          const previous = last();

          if (previous !== undefined && previous.source === 2) previous.toolCalls.push(call);
          else prompts.push(newDevinPrompt({ source: 2, toolCalls: [call] }));
          pending.push(id);
          break;
        }

        case "function_result":
          addToolResult(
            firstNonEmpty(asString(get(step, "call_id")), asString(get(step, "id"))),
            step,
          );
          break;
      }
    }
  } else if (isJsonArray(messages)) {
    // Fallback for a direct OpenAI body that was not translated.
    for (const message of messages) {
      const role = asString(get(message, "role")).trim().toLowerCase();

      switch (role) {
        case "system":
        case "developer":
          if (systemPrompt === "") systemPrompt = asString(get(message, "content"));
          break;
        case "user": {
          const { text, images, droppedPart } = extractStepContent(message);
          prompts.push(newDevinPrompt({ source: 1, content: text, images, droppedPart }));
          break;
        }

        case "assistant": {
          const text = extractStepText(message);
          const toolCalls: DevinToolCall[] = [];
          const calls = get(message, "tool_calls");

          if (isJsonArray(calls)) {
            for (const item of calls) {
              const id = firstNonEmpty(asString(get(item, "id")), asString(get(item, "call_id")));
              const name = asString(get(item, "function.name")) || asString(get(item, "name"));
              const args = get(item, "function.arguments") ?? get(item, "arguments");
              toolCalls.push({ id, name, arguments: toolCallArguments(args) });
              pending.push(id);
            }
          }

          prompts.push(newDevinPrompt({ source: 2, content: text, toolCalls }));
          break;
        }

        case "tool":
          addToolResult(
            firstNonEmpty(
              asString(get(message, "tool_call_id")),
              asString(get(message, "id")),
              asString(get(message, "call_id")),
            ),
            message,
          );
          break;
      }
    }
  }

  if (originalRequest !== undefined) {
    supplementSignatures(originalRequest, prompts);
    supplementImages(originalRequest, prompts);
  }

  const tools: DevinTool[] = [];

  const appendTool = (tool: Json): void => {
    const name = asString(get(tool, "name"));

    if (name === "" || isCodexAppAutomationUpdate("", name)) return;
    const description = sanitizeDevinToolDescription(asString(get(tool, "description")));
    const parameters = get(tool, "parameters") ?? get(tool, "parametersJsonSchema");
    tools.push({ name, description, parameters: raw(parameters) });
  };

  const toolList = get(payload, "tools");

  if (isJsonArray(toolList)) {
    for (const tool of toolList) {
      if (
        asString(get(tool, "type")) === "namespace" &&
        asString(get(tool, "name")).trim().toLowerCase() === "mcp__codex_app"
      ) {
        const children = get(tool, "tools") ?? get(tool, "children");

        if (isJsonArray(children)) {
          for (const child of children) {
            if (asString(get(child, "name")).trim().toLowerCase() !== "automation_update")
              appendTool(child);
          }
        }

        continue;
      }

      const declarations = get(tool, "function_declarations") ?? get(tool, "functionDeclarations");

      if (isJsonArray(declarations)) {
        declarations.forEach(appendTool);
        continue;
      }

      appendTool(tool);
    }
  }

  return {
    systemPrompt,
    prompts,
    tools,
    temperature,
    maxTokens,
    sessionId,
    cascadeId,
    thinkingLevel,
    budgetTokens,
  };
};

/** `normalizeDevinUUID`: a non-UUID session string becomes a deterministic UUID v5 (OID namespace). */
export const normalizeDevinUuid = (value: string): string => {
  const trimmed = value.trim();

  if (trimmed === "") return randomUUID();

  return UUID.test(trimmed) ? trimmed : uuidV5Oid(trimmed);
};

export interface CheckedUserTurns {
  readonly prompts: DevinPrompt[];
  readonly error?: ReturnType<UserRun["err"]>;
}

/** `CheckDevinUserTurns`: refuses user turns that only carried media Devin cannot send; drops emptied prompts. */
export const checkDevinUserTurns = (prompts: DevinPrompt[]): CheckedUserTurns => {
  const hasContent = (prompt: DevinPrompt): boolean =>
    prompt.content.trim() !== "" || prompt.images.length > 0;

  const run = new UserRun();

  for (const prompt of prompts) {
    if (prompt.source === 2) run.end();
    else if (prompt.source === 1 && !prompt.isOrphanedTool) {
      if (prompt.droppedPart !== "") run.drop(prompt.droppedPart);

      if (hasContent(prompt)) run.add();
    } else {
      run.add();
    }
  }

  run.end();
  const error = run.err();

  if (error !== undefined) return { prompts, error };

  const kept = prompts.filter(
    (prompt) =>
      !(
        prompt.source === 1 &&
        !prompt.isOrphanedTool &&
        prompt.droppedPart !== "" &&
        !hasContent(prompt)
      ),
  );

  return { prompts: kept };
};

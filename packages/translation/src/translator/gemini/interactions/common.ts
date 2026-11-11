/**
 * Shared helpers of the Gemini <-> Interactions translators.
 *
 * Go source: internal/translator/gemini/interactions/interactions_gemini_common.go (content/part converters, key case
 * conversion, usage mapping) and interactions_gemini_response.go (first* helpers), internal/translator/common/
 * interactions_usage.go (InteractionsUsage).
 */
import {
  asBool,
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { normalizeOpenAIFileData } from "../../common/file-data.ts";

/** `strings.TrimSpace` + first non-empty (returns the trimmed value). */
export const firstNonEmptyString = (...values: string[]): string => {
  for (const value of values) {
    const trimmed = value.trim();

    if (trimmed !== "") return trimmed;
  }

  return "";
};

/** `firstNonEmptyInteractionString`: first value that is not blank (returned untrimmed). */
export const firstNonBlankString = (...values: string[]): string =>
  values.find((value) => value.trim() !== "") ?? "";

export const firstExistingPath = (
  root: Json | undefined,
  paths: ReadonlyArray<string>,
): Json | undefined => {
  for (const path of paths) {
    const value = get(root, path);

    if (value !== undefined) return value;
  }

  return undefined;
};

// --- key case conversion ---------------------------------------------------------------------------------------------

const joinJsonPath = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

export const toCamelCase = (s: string): string => {
  const parts = s.split("_");
  let out = parts[0] ?? "";

  for (const part of parts.slice(1)) {
    if (part === "") continue;
    out += part.slice(0, 1).toUpperCase() + part.slice(1);
  }

  return out;
};

export const toSnakeCase = (s: string): string => {
  let out = "";

  for (const [i, ch] of Array.from(s).entries()) {
    if (i > 0 && ch >= "A" && ch <= "Z") out += "_";
    out += ch;
  }

  return out.toLowerCase();
};

/**
 * Go copies every leaf of the source into a fresh document with sjson paths; arrays use the append path `.-1` for every
 * leaf, so an object inside an array is split into one element per key and empty containers vanish. The path engine
 * reproduces this exactly.
 */
const copyLeaves = (
  out: Json,
  path: string,
  node: Json,
  convert: (key: string) => string,
): Json => {
  if (isJsonObject(node)) {
    for (const [key, value] of Object.entries(node))
      out = copyLeaves(out, joinJsonPath(path, convert(key)), value, convert);

    return out;
  }

  if (isJsonArray(node)) {
    for (const value of node) out = copyLeaves(out, `${path}.-1`, value, convert);

    return out;
  }

  if (path === "") return out;

  try {
    return set(out, path, node);
  } catch {
    return out;
  }
};

export const convertSnakeCaseKeysToCamelCase = (raw: Json): Json =>
  copyLeaves({}, "", raw, toCamelCase);

export const convertCamelCaseKeysToSnakeCase = (raw: Json): Json =>
  copyLeaves({}, "", raw, toSnakeCase);

// --- parts -------------------------------------------------------------------------------------------------------------

export const geminiTextPartJson = (text: string, thought: boolean): JsonObject =>
  thought ? { text, thought: true } : { text };

export const geminiInlineDataPartJson = (inline: Json | undefined): JsonObject | undefined => {
  let mimeType = asString(get(inline, "mimeType"));

  if (mimeType === "") mimeType = asString(get(inline, "mime_type"));
  const data = asString(get(inline, "data"));

  return mimeType === "" || data === "" ? undefined : { inlineData: { mimeType, data } };
};

export const geminiFileDataPartJson = (fileData: Json | undefined): JsonObject | undefined => {
  let mimeType = asString(get(fileData, "mimeType"));

  if (mimeType === "") mimeType = asString(get(fileData, "mime_type"));
  let fileUri = asString(get(fileData, "fileUri"));

  if (fileUri === "") fileUri = asString(get(fileData, "file_uri"));

  return mimeType === "" || fileUri === "" ? undefined : { fileData: { mimeType, fileUri } };
};

export const geminiInlineDataPartFromDataUrl = (dataUrl: string): JsonObject | undefined => {
  if (!dataUrl.startsWith("data:")) return undefined;
  const payload = dataUrl.slice(5);
  const semicolon = payload.indexOf(";");

  if (semicolon < 0) return undefined;
  const rest = payload.slice(semicolon + 1);

  if (!rest.startsWith("base64,")) return undefined;

  return geminiInlineDataPartJson({ mime_type: payload.slice(0, semicolon), data: rest.slice(7) });
};

export const interactionsInputAudioMimeType = (format: string): string => {
  switch (format.trim().toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
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

/** `geminiInteractionsMediaType`. */
export const geminiInteractionsMediaType = (mimeType: string): string => {
  const lower = mimeType.toLowerCase();

  if (lower.startsWith("image/")) return "image";

  if (lower.startsWith("audio/")) return "audio";

  if (lower.startsWith("video/")) return "video";

  return "document";
};

export const geminiInlineDataToInteractionsContent = (
  mimeType: string,
  data: string,
): JsonObject => ({
  type: geminiInteractionsMediaType(mimeType),
  mime_type: mimeType,
  data,
});

/** `geminiFileDataToInteractionsContent`: references the file by uri; `undefined` without a uri. */
export const geminiFileDataToInteractionsContent = (
  fileData: Json | undefined,
): JsonObject | undefined => {
  let fileUri = asString(get(fileData, "fileUri")).trim();

  if (fileUri === "") fileUri = asString(get(fileData, "file_uri")).trim();

  if (fileUri === "") return undefined;
  let mimeType = asString(get(fileData, "mimeType"));

  if (mimeType === "") mimeType = asString(get(fileData, "mime_type"));
  const item: JsonObject = { type: geminiInteractionsMediaType(mimeType), uri: fileUri };

  if (mimeType !== "") item["mime_type"] = mimeType;

  return item;
};

/** `geminiPartFileData`: the fileData object of a Gemini part in either spelling. */
export const geminiPartFileData = (part: Json | undefined): Json | undefined =>
  get(part, "fileData") ?? get(part, "file_data");

/** `geminiPartToInteractionsContent`. */
export const geminiPartToInteractionsContent = (part: Json): JsonObject | undefined => {
  const text = get(part, "text");

  if (text !== undefined) return { type: "text", text: asString(text) };
  const inline = get(part, "inlineData");

  if (inline !== undefined) {
    let mimeType = asString(get(inline, "mimeType"));

    if (mimeType === "") mimeType = asString(get(inline, "mime_type"));

    return geminiInlineDataToInteractionsContent(mimeType, asString(get(inline, "data")));
  }

  const snake = get(part, "inline_data");

  if (snake !== undefined) {
    return geminiInlineDataToInteractionsContent(
      asString(get(snake, "mime_type")),
      asString(get(snake, "data")),
    );
  }

  const fileData = geminiPartFileData(part);

  if (fileData !== undefined) return geminiFileDataToInteractionsContent(fileData);

  return undefined;
};

/** `interactionsContentPartToGeminiPart`. */
export const interactionsContentPartToGeminiPart = (
  part: Json,
  thought: boolean,
): JsonObject | undefined => {
  const text = get(part, "text");

  if (text !== undefined) return geminiTextPartJson(asString(text), thought);
  const inline = get(part, "inline_data");

  if (inline !== undefined) return geminiInlineDataPartJson(inline);
  const camel = get(part, "inlineData");

  if (camel !== undefined) return geminiInlineDataPartJson(camel);
  const partType = asString(get(part, "type")).trim().toLowerCase();

  switch (partType) {
    case "image":
    case "audio":
    case "video":
    case "document": {
      const mime = get(part, "mime_type");

      if (mime !== undefined || get(part, "mimeType") !== undefined) {
        let mimeType = asString(mime);

        if (mimeType === "") mimeType = asString(get(part, "mimeType"));
        const data = asString(get(part, "data"));

        if (data !== "") return geminiInlineDataPartJson({ mime_type: mimeType, data });
      }

      const fileUri = firstNonEmptyString(
        asString(get(part, "file_uri")),
        asString(get(part, "fileUri")),
        asString(get(part, "uri")),
      );

      if (fileUri !== "") {
        let mimeType = asString(get(part, "mime_type"));

        if (mimeType === "") mimeType = asString(get(part, "mimeType"));

        return geminiFileDataPartJson({ mimeType, fileUri });
      }

      const url = get(part, "url");

      if (url !== undefined) return geminiInlineDataPartFromDataUrl(asString(url));

      return undefined;
    }

    case "image_url":
      return geminiInlineDataPartFromDataUrl(asString(get(part, "image_url.url")));
    case "input_audio": {
      const mimeType = interactionsInputAudioMimeType(asString(get(part, "input_audio.format")));

      return geminiInlineDataPartJson({
        mime_type: mimeType,
        data: asString(get(part, "input_audio.data")),
      });
    }

    case "file": {
      const file = normalizeOpenAIFileData(
        asString(get(part, "file.filename")),
        "",
        asString(get(part, "file.file_data")),
      );

      return file === undefined
        ? undefined
        : geminiInlineDataPartJson({ mime_type: file.mimeType, data: file.data });
    }

    default:
      return undefined;
  }
};

/** `interactionsThoughtSignature`. */
export const interactionsThoughtSignature = (part: Json): string => {
  for (const path of [
    "thoughtSignature",
    "thought_signature",
    "extra_content.google.thought_signature",
  ]) {
    const signature = asString(get(part, path)).trim();

    if (signature !== "") return signature;
  }

  return "";
};

export const interactionsFunctionPartId = (part: Json): string => {
  const id = get(part, "id");

  if (id !== undefined) return asString(id);
  const callId = get(part, "call_id");

  return callId === undefined ? "" : asString(callId);
};

/** `geminiThoughtStepJSON`. */
export const geminiThoughtStepJson = (sig: string, text: string): JsonObject => {
  const step: JsonObject = { type: "thought" };

  if (sig !== "") step["signature"] = sig;

  if (text !== "") step["content"] = [{ text }];

  return step;
};

/** `geminiPartToInteractionsSteps`. */
export const geminiPartToInteractionsSteps = (part: Json): JsonObject[] => {
  const sig = interactionsThoughtSignature(part);
  const fc = get(part, "functionCall");

  if (fc !== undefined) {
    const steps: JsonObject[] = [];

    if (sig !== "") steps.push(geminiThoughtStepJson(sig, ""));

    const step: JsonObject = {
      type: "function_call",
      name: asString(get(fc, "name")),
      arguments: {},
    };

    const id = get(fc, "id");
    const callId = get(fc, "call_id");

    if (id !== undefined) step["call_id"] = asString(id);
    else if (callId !== undefined) step["call_id"] = asString(callId);
    const args = get(fc, "args");

    if (args !== undefined) step["arguments"] = args;
    steps.push(step);

    return steps;
  }

  const fr = get(part, "functionResponse");

  if (fr !== undefined) {
    const step: JsonObject = {
      type: "function_result",
      name: asString(get(fr, "name")),
      result: {},
    };

    const id = get(fr, "id");
    const callId = get(fr, "call_id");

    if (id !== undefined) step["call_id"] = asString(id);
    else if (callId !== undefined) step["call_id"] = asString(callId);
    const response = get(fr, "response");

    if (response !== undefined) step["result"] = response;

    return [step];
  }

  const text = get(part, "text");

  const withSignature = (step: JsonObject): JsonObject[] =>
    sig === "" ? [step] : [step, geminiThoughtStepJson(sig, "")];

  if (text !== undefined) {
    if (asBool(get(part, "thought"))) return [geminiThoughtStepJson(sig, asString(text))];

    if (asString(text) === "") return sig === "" ? [] : [geminiThoughtStepJson(sig, "")];

    return withSignature({ type: "model_output", content: [{ text: asString(text) }] });
  }

  const inline = get(part, "inlineData");

  if (inline !== undefined) {
    let mimeType = asString(get(inline, "mimeType"));

    if (mimeType === "") mimeType = asString(get(inline, "mime_type"));

    return withSignature({
      type: "model_output",
      content: [geminiInlineDataToInteractionsContent(mimeType, asString(get(inline, "data")))],
    });
  }

  const snake = get(part, "inline_data");

  if (snake !== undefined) {
    return withSignature({
      type: "model_output",
      content: [
        geminiInlineDataToInteractionsContent(
          asString(get(snake, "mime_type")),
          asString(get(snake, "data")),
        ),
      ],
    });
  }

  return sig === "" ? [] : [geminiThoughtStepJson(sig, "")];
};

export const interactionsGeminiContent = (role: string, parts: Json[]): JsonObject => ({
  role,
  parts,
});

// --- usage -------------------------------------------------------------------------------------------------------------

/** `translatorcommon.InteractionsUsage`. */
export const interactionsUsage = (root: Json | undefined): Json | undefined =>
  firstExistingPath(root, [
    "interaction.usage",
    "usage",
    "metadata.total_usage",
    "metadata.usage",
    "interaction.metadata.total_usage",
    "interaction.metadata.usage",
  ]);

const firstUsage = (usage: Json, ...paths: string[]): Json | undefined =>
  firstExistingPath(usage, paths);

// `cpaUsageMetadata` is the spelling executors give non-terminal usage; it is read as `usageMetadata` (upstream ede07caf).
export const geminiUsageNode = (root: Json): Json | undefined =>
  get(root, "usageMetadata") ?? get(root, "usage_metadata") ?? get(root, "cpaUsageMetadata");

/** `setInteractionsUsageFromGemini`. */
export const setInteractionsUsageFromGemini = (out: Json, path: string, root: Json): Json => {
  const usage = geminiUsageNode(root);

  if (usage === undefined) return out;
  set(
    out,
    `${path}.input_tokens`,
    asInt(firstUsage(usage, "promptTokenCount", "prompt_token_count")),
  );
  set(
    out,
    `${path}.output_tokens`,
    asInt(firstUsage(usage, "candidatesTokenCount", "candidates_token_count")),
  );
  const reasoning = firstUsage(usage, "thoughtsTokenCount", "thoughts_token_count");

  if (reasoning !== undefined) set(out, `${path}.reasoning_tokens`, asInt(reasoning));
  set(
    out,
    `${path}.total_tokens`,
    asInt(firstUsage(usage, "totalTokenCount", "total_token_count")),
  );
  const cached = get(usage, "cachedContentTokenCount") ?? get(usage, "cached_content_token_count");

  if (cached !== undefined) set(out, `${path}.cached_tokens`, asInt(cached));

  return out;
};

/** `setInteractionsStreamUsageFromGemini`. */
export const setInteractionsStreamUsageFromGemini = (out: Json, path: string, root: Json): Json => {
  const usage = geminiUsageNode(root);

  if (usage === undefined) return out;
  const input = asInt(firstUsage(usage, "promptTokenCount", "prompt_token_count"));
  const output = asInt(firstUsage(usage, "candidatesTokenCount", "candidates_token_count"));
  const total = asInt(firstUsage(usage, "totalTokenCount", "total_token_count"));
  const thoughts = asInt(firstUsage(usage, "thoughtsTokenCount", "thoughts_token_count"));
  let cached = asInt(get(usage, "cachedContentTokenCount"));

  if (cached === 0) cached = asInt(get(usage, "cached_content_token_count"));
  set(out, `${path}.total_tokens`, total);
  set(out, `${path}.total_input_tokens`, input);
  set(out, `${path}.input_tokens_by_modality`, [{ modality: "text", tokens: input }]);
  set(out, `${path}.total_cached_tokens`, cached);
  set(out, `${path}.total_output_tokens`, output);
  set(out, `${path}.total_tool_use_tokens`, 0);
  set(out, `${path}.total_thought_tokens`, thoughts);

  return out;
};

/**
 * Codex image generation (OpenAI Images API compatibility).
 *
 * Go source: internal/runtime/executor/codex_openai_images.go. Models `gpt-image-*` use the direct
 * `{base}/images/{generations,edits}` endpoints; other models go through a Responses request with the
 * `image_generation` tool and the result items are converted to an Images API response. Multipart edit requests are
 * converted to JSON by the handler (`handlers/openai/images.ts`), so the executor only sees JSON bodies. 7a7d37ec adds
 * the `gpt-image-2.6*` ids; 51bde0ff keeps a configured upstream model name on the wire.
 */
import {
  asInt,
  asString,
  cloneJson,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { sseEventData } from "@commissary/translation";
import { parseSuffix } from "@commissary/translation/thinking";
import type { OutputItemCollector } from "./output.ts";

export const CODEX_IMAGE_SOURCE_FORMAT = "openai-image";

export const CODEX_DEFAULT_IMAGE_TOOL_MODEL = "gpt-image-2";

export const CODEX_IMAGES_MAIN_MODEL = "gpt-5.4-mini";

const GENERATIONS_PATH = "/v1/images/generations";

const EDITS_PATH = "/v1/images/edits";

const DIRECT_MODELS = new Set([
  "gpt-image-1.5",
  CODEX_DEFAULT_IMAGE_TOOL_MODEL,
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6",
]);

/** `codexIsImagesEndpointPath`. */
export const isImagesEndpointPath = (rawPath: string): boolean => {
  const path = rawPath.trim();

  return path.endsWith(GENERATIONS_PATH) || path.endsWith(EDITS_PATH);
};

/** `isCodexOpenAIImageRequest`. */
export const isCodexImageRequest = (sourceFormat: string, requestPath: string): boolean =>
  sourceFormat.trim().toLowerCase() === CODEX_IMAGE_SOURCE_FORMAT &&
  isImagesEndpointPath(requestPath);

/** `codexOpenAIImageBaseModel`: suffix and `provider/` prefix stripped, lower case. */
const imageBaseModel = (model: string): string => {
  let name = parseSuffix(model).modelName.trim();
  const slash = name.lastIndexOf("/");

  if (slash >= 0 && slash < name.length - 1) name = name.slice(slash + 1).trim();

  return name.toLowerCase();
};

/**
 * `codexDirectOpenAIImageRouteModel` (51bde0ff): the first of the requested model, the payload model and the resolved
 * model whose base name is a direct image model. It only decides whether the request is a direct image request.
 */
export const directImageRouteModel = (
  payload: Json,
  routeModel: string,
  requestedModel = "",
): string => {
  for (const model of [requestedModel, asString(get(payload, "model")), routeModel]) {
    const base = imageBaseModel(model);

    if (DIRECT_MODELS.has(base)) return base;
  }

  return "";
};

/**
 * `directOpenAIImageModel` (51bde0ff): the model on the wire. The resolved model wins; a configured upstream name (or
 * alias without a name) is explicit and kept verbatim, otherwise a builtin image model is normalised (legacy
 * routing prefixes and suffixes stripped).
 */
export const directImageModel = (
  payload: Json,
  routeModel: string,
  requestedModel = "",
  upstreamNames: ReadonlyArray<string> = [],
): string => {
  const route = directImageRouteModel(payload, routeModel, requestedModel);

  if (route === "") return "";
  const model = parseSuffix(routeModel).modelName.trim();

  if (model === "") return route;

  if (
    upstreamNames.some(
      (name) => parseSuffix(name).modelName.trim().toLowerCase() === model.toLowerCase(),
    )
  )
    return model;
  const base = imageBaseModel(model);

  return DIRECT_MODELS.has(base) ? base : model;
};

/** `codexDirectOpenAIImageEndpoint`. */
export const directImageEndpoint = (
  payload: Json,
  routeModel: string,
  requestPath: string,
  requestedModel = "",
): string => {
  if (directImageRouteModel(payload, routeModel, requestedModel) === "") return "";
  const path = requestPath.trim();

  if (path.endsWith(GENERATIONS_PATH)) return "/images/generations";

  if (path.endsWith(EDITS_PATH)) return "/images/edits";

  return "";
};

/** `prepareOpenAICompatImagesPayload` for JSON bodies: set `model`; `stream: true` or removed. */
export const prepareDirectImageBody = (payload: Json, model: string, stream: boolean): Json => {
  const body = cloneJson(payload);

  if (!isJsonObject(body)) return body;

  if (model.trim() !== "") body["model"] = model.trim();

  if (stream) body["stream"] = true;
  else delete body["stream"];

  return body;
};

// ---------------------------------------------------------------------------------------------------------------
// Responses-tool path
// ---------------------------------------------------------------------------------------------------------------

export interface PreparedImageRequest {
  readonly body: Json;
  readonly responseFormat: "url" | "b64_json";
  readonly streamPrefix: "image_generation" | "image_edit";
}

const normalizeResponseFormat = (value: string): "url" | "b64_json" =>
  value.trim().toLowerCase() === "url" ? "url" : "b64_json";

const toolModel = (requestModel: string, routeModel: string): string => {
  const model = requestModel.trim() !== "" ? requestModel.trim() : routeModel.trim();

  return model !== "" ? model : CODEX_DEFAULT_IMAGE_TOOL_MODEL;
};

const buildTool = (
  payload: Json,
  routeModel: string,
  action: string,
  stringFields: readonly string[],
  numberFields: readonly string[],
): JsonObject => {
  const tool: JsonObject = {
    type: "image_generation",
    action,
    model: toolModel(asString(get(payload, "model")), routeModel),
  };

  for (const field of stringFields) {
    const value = asString(get(payload, field)).trim();

    if (value !== "") tool[field] = value;
  }

  for (const field of numberFields) {
    const value = get(payload, field);

    if (typeof value === "number") tool[field] = Math.trunc(value);
  }

  return tool;
};

/** `codexBuildImagesResponsesRequest`. */
const buildImagesResponsesRequest = (
  prompt: string,
  images: readonly string[],
  tool: Json,
): Json => {
  const content: Json[] = [{ type: "input_text", text: prompt }];

  for (const image of images)
    if (image.trim() !== "") content.push({ type: "input_image", image_url: image });

  return {
    instructions: "",
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    model: CODEX_IMAGES_MAIN_MODEL,
    store: false,
    tool_choice: { type: "image_generation" },
    tools: [tool],
    input: [{ type: "message", role: "user", content }],
  };
};

/** `codexPrepareOpenAIImageRequest` (JSON bodies). Returns an error message for an unsupported path. */
export const prepareImageRequest = (
  payload: Json,
  routeModel: string,
  requestPath: string,
): PreparedImageRequest | string => {
  const path = requestPath.trim();

  if (path.endsWith(GENERATIONS_PATH)) {
    const tool = buildTool(
      payload,
      routeModel,
      "generate",
      ["size", "quality", "background", "output_format", "moderation"],
      ["output_compression", "partial_images"],
    );

    return {
      body: buildImagesResponsesRequest(asString(get(payload, "prompt")).trim(), [], tool),
      responseFormat: normalizeResponseFormat(asString(get(payload, "response_format"))),
      streamPrefix: "image_generation",
    };
  }

  if (!path.endsWith(EDITS_PATH)) return `unsupported OpenAI image endpoint path "${requestPath}"`;
  const images: string[] = [];
  const list = get(payload, "images");

  if (isJsonArray(list)) {
    for (const image of list) {
      const url = asString(get(image, "image_url")).trim();

      if (url !== "") images.push(url);
    }
  }

  const tool = buildTool(
    payload,
    routeModel,
    "edit",
    ["size", "quality", "background", "output_format", "input_fidelity", "moderation"],
    ["output_compression", "partial_images"],
  );

  const mask = asString(get(payload, "mask.image_url")).trim();

  if (mask !== "") set(tool, "input_image_mask.image_url", mask);

  return {
    body: buildImagesResponsesRequest(asString(get(payload, "prompt")).trim(), images, tool),
    responseFormat: normalizeResponseFormat(asString(get(payload, "response_format"))),
    streamPrefix: "image_edit",
  };
};

/** `prepareCodexOpenAIImageBody` tail: the executor-owned fields of the image Responses request. */
export const finishImageResponsesBody = (body: Json, mainModel: string): Json => {
  set(body, "model", mainModel);
  set(body, "stream", true);

  for (const field of [
    "previous_response_id",
    "prompt_cache_retention",
    "safety_identifier",
    "stream_options",
  ]) {
    del(body, field);
  }

  const instructions = get(body, "instructions");

  if (instructions === undefined || instructions === null) set(body, "instructions", "");

  return body;
};

export interface ImageCallResult {
  readonly result: string;
  readonly revisedPrompt: string;
  readonly outputFormat: string;
  readonly size: string;
  readonly background: string;
  readonly quality: string;
}

export interface ExtractedImages {
  readonly results: ImageCallResult[];
  readonly createdAt: number;
  readonly usage: Json | undefined;
}

const imageResultOf = (item: Json): ImageCallResult | undefined => {
  if (asString(get(item, "type")) !== "image_generation_call") return undefined;
  const result = asString(get(item, "result")).trim();

  if (result === "") return undefined;
  const field = (name: string) => asString(get(item, name)).trim();

  return {
    result,
    revisedPrompt: field("revised_prompt"),
    outputFormat: field("output_format"),
    size: field("size"),
    background: field("background"),
    quality: field("quality"),
  };
};

/** `codexExtractImageResults`: prefers `response.output`, else the collected `output_item.done` items. */
export const extractImageResults = (
  completed: Json,
  collector: OutputItemCollector,
  nowSeconds: number,
): ExtractedImages => {
  let createdAt = asInt(get(completed, "response.created_at"));

  if (createdAt <= 0) createdAt = nowSeconds;
  const results: ImageCallResult[] = [];
  const output = get(completed, "response.output");

  const append = (item: Json) => {
    const result = imageResultOf(item);

    if (result !== undefined) results.push(result);
  };

  if (isJsonArray(output) && output.length > 0) {
    for (const item of output) append(item);
  } else {
    for (const [, item] of [...collector.byIndex.entries()].toSorted((a, b) => a[0] - b[0]))
      append(item);

    for (const item of collector.fallback) append(item);
  }

  const usage = get(completed, "response.tool_usage.image_gen");

  return { results, createdAt, usage: isJsonObject(usage) ? usage : undefined };
};

/** `codexMimeTypeFromOutputFormat`. */
const mimeTypeFromOutputFormat = (outputFormat: string): string => {
  switch (outputFormat.trim().toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
};

/** `codexBuildImagesAPIResponse`: `{created, [background, output_format, quality, size, usage], data: [...]}`. */
export const buildImagesApiResponse = (
  extracted: ExtractedImages,
  responseFormat: "url" | "b64_json",
): string => {
  const first = extracted.results[0];
  const out: JsonObject = { created: extracted.createdAt };

  if (first !== undefined) {
    if (first.background !== "") out["background"] = first.background;

    if (first.outputFormat !== "") out["output_format"] = first.outputFormat;

    if (first.quality !== "") out["quality"] = first.quality;

    if (first.size !== "") out["size"] = first.size;
  }

  if (extracted.usage !== undefined) out["usage"] = extracted.usage;
  out["data"] = extracted.results.map((image) => {
    const item: JsonObject = {};

    if (image.revisedPrompt !== "") item["revised_prompt"] = image.revisedPrompt;

    if (responseFormat === "url")
      item["url"] = `data:${mimeTypeFromOutputFormat(image.outputFormat)};base64,${image.result}`;
    else item["b64_json"] = image.result;

    return item;
  });

  return JSON.stringify(out);
};

const frame = (eventName: string, data: Json): string =>
  sseEventData(eventName, JSON.stringify(data));

/** `codexBuildImagePartialFrame`: `undefined` for an empty partial image. */
export const imagePartialFrame = (
  payload: Json,
  responseFormat: "url" | "b64_json",
  streamPrefix: string,
): string | undefined => {
  const b64 = asString(get(payload, "partial_image_b64")).trim();

  if (b64 === "") return undefined;
  const eventName = `${streamPrefix.trim()}.partial_image`;

  const data: JsonObject = {
    type: eventName,
    partial_image_index: asInt(get(payload, "partial_image_index")),
  };

  if (responseFormat === "url") {
    data["url"] =
      `data:${mimeTypeFromOutputFormat(asString(get(payload, "output_format")))};base64,${b64}`;
  } else {
    data["b64_json"] = b64;
  }

  return frame(eventName, data);
};

/** `codexBuildImageCompletedFrame`. */
export const imageCompletedFrame = (
  image: ImageCallResult,
  usage: Json | undefined,
  responseFormat: "url" | "b64_json",
  streamPrefix: string,
): string => {
  const eventName = `${streamPrefix.trim()}.completed`;
  const data: JsonObject = { type: eventName };

  if (usage !== undefined) data["usage"] = usage;

  if (responseFormat === "url")
    data["url"] = `data:${mimeTypeFromOutputFormat(image.outputFormat)};base64,${image.result}`;
  else data["b64_json"] = image.result;

  return frame(eventName, data);
};

/**
 * xAI image models on the OpenAI Images API (`grok-imagine-image*` on `/v1/images/generations` and `/edits`).
 *
 * Go source: sdk/api/handlers/openai/openai_images_handlers.go (isXAIImagesModel, canonicalXAIImagesModel,
 * xaiImagesAspectRatio*, xaiImagesResolution, buildXAIImagesBaseRequest, buildXAIImagesGenerationsRequest,
 * buildXAIImagesEditRequest, collectXAIImagesFromJSON, xaiImagesEditOptionsFromJSON, mimeTypeFromOutputFormat,
 * extractXAIImagesResponse, buildImagesAPIResponseFromXAI, streamImagesWithModel).
 * The requests are converted to the xAI shape here; the executor posts them to `{chatBase}/images/*` and the answer is
 * converted back to an OpenAI Images body (or `*.completed` SSE frames: xAI has no image streaming, the Go handler
 * runs the request non-stream and replays the result).
 */
import {
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { sseEvent } from "@commissary/translation/sse";
import { ExecutionError } from "../../executor/errors.ts";

export const DEFAULT_XAI_IMAGES_MODEL = "grok-imagine-image";

const XAI_IMAGES_QUALITY_MODEL = "grok-imagine-image-quality";

const XAI_IMAGES_20_MODEL = "grok-imagine-image-2.0";

const XAI_IMAGE_MODELS = [DEFAULT_XAI_IMAGES_MODEL, XAI_IMAGES_QUALITY_MODEL, XAI_IMAGES_20_MODEL];

const DEFAULT_ASPECT_RATIO = "1:1";

const DEFAULT_RESOLUTION = "1k";

/** `imagesModelParts`: `prefix/base` split at the last slash. */
export const modelParts = (model: string): { readonly prefix: string; readonly base: string } => {
  const trimmed = model.trim();
  const index = trimmed.lastIndexOf("/");

  return index >= 0 && index < trimmed.length - 1
    ? { prefix: trimmed.slice(0, index).trim(), base: trimmed.slice(index + 1).trim() }
    : { prefix: "", base: trimmed };
};

/** `isXAIVendorAlias`: the built-in vendor prefixes. */
export const isXaiVendorAlias = (prefix: string): boolean =>
  ["xai", "x-ai", "grok"].includes(prefix.trim().toLowerCase());

/** `isXAIImagesBaseModel` over the base of `model`; the prefix is not looked at. */
export const hasXaiImageBase = (model: string): boolean =>
  XAI_IMAGE_MODELS.includes(modelParts(model).base.toLowerCase());

export const XAI_IMAGE_MODEL_NAMES: ReadonlyArray<string> = XAI_IMAGE_MODELS;

/** `canonicalXAIImagesModel`: the base model without prefix, as xAI names it. */
export const canonicalModel = (model: string): string => {
  const base = modelParts(model).base.toLowerCase();

  return base === XAI_IMAGES_QUALITY_MODEL || base === XAI_IMAGES_20_MODEL
    ? base
    : DEFAULT_XAI_IMAGES_MODEL;
};

const aspectRatio = (raw: string, fallback: string): string => {
  switch (raw.trim().toLowerCase()) {
    case "1:1":
    case "square":
      return "1:1";
    case "16:9":
    case "landscape":
      return "16:9";
    case "9:16":
    case "portrait":
      return "9:16";
    case "9:20":
      return "9:20";
    case "20:9":
      return "20:9";
    case "4:3":
      return "4:3";
    case "3:4":
      return "3:4";
    case "3:2":
      return "3:2";
    case "2:3":
      return "2:3";
    default:
      return fallback;
  }
};

const aspectRatioFromSize = (size: string, fallback: string): string => {
  switch (size.trim().toLowerCase()) {
    case "1024x1024":
    case "2048x2048":
    case "1:1":
      return "1:1";
    case "1792x1024":
    case "16:9":
      return "16:9";
    case "1024x1792":
    case "9:16":
      return "9:16";
    case "9:20":
      return "9:20";
    case "20:9":
      return "20:9";
    case "1536x1024":
    case "3:2":
      return "3:2";
    case "1024x1536":
    case "2:3":
      return "2:3";
    default:
      return fallback;
  }
};

const resolution = (raw: string, size: string, fallback: string): string => {
  const value = raw.trim().toLowerCase();

  if (value === "1k" || value === "2k") return value;

  return size.trim().toLowerCase().includes("2048") ? "2k" : fallback;
};

export const normalizeResponseFormat = (responseFormat: string): "url" | "b64_json" =>
  responseFormat.trim().toLowerCase() === "url" ? "url" : "b64_json";

interface BaseRequest {
  readonly model: string;
  readonly prompt: string;
  readonly responseFormat: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly quality: string;
  readonly n: number;
}

/** `buildXAIImagesBaseRequest`; an empty `responseFormat` stays absent (`buildXAIImagesOriginalBaseRequest`, 826bb167). */
const baseRequest = (input: BaseRequest): JsonObject => {
  const request: JsonObject = {
    model: canonicalModel(input.model),
    prompt: input.prompt.trim(),
  };

  if (input.responseFormat.trim() !== "")
    request["response_format"] = normalizeResponseFormat(input.responseFormat);

  if (input.aspectRatio !== "") request["aspect_ratio"] = input.aspectRatio;

  if (input.resolution !== "") request["resolution"] = input.resolution;

  if (input.quality.trim() !== "") request["quality"] = input.quality.trim();

  if (input.n > 0) request["n"] = input.n;

  return request;
};

const numberField = (body: Json, path: string): number => {
  const value = get(body, path);

  return typeof value === "number" ? Math.trunc(value) : 0;
};

const text = (body: Json, path: string): string => asString(get(body, path)).trim();

/**
 * `buildXAIImagesGenerationsRequest`; without `defaults` it is `buildXAIImagesGenerationsOriginalRequest`: the request
 * minus the handler's aspect ratio and resolution defaults (and, with an empty `responseFormat`, its format), the
 * baseline `default` payload rules compare against (826bb167).
 */
export const buildGenerationsRequest = (
  body: Json,
  model: string,
  responseFormat: string,
  defaults: boolean,
): JsonObject => {
  const size = text(body, "size");
  const ratio = aspectRatioFromSize(size, aspectRatio(asString(get(body, "aspect_ratio")), ""));

  return baseRequest({
    model,
    prompt: text(body, "prompt"),
    responseFormat,
    aspectRatio: ratio === "" && defaults ? DEFAULT_ASPECT_RATIO : ratio,
    resolution: resolution(
      asString(get(body, "resolution")),
      size,
      defaults ? DEFAULT_RESOLUTION : "",
    ),
    quality: text(body, "quality"),
    n: numberField(body, "n"),
  });
};

const imageRef = (url: string): JsonObject => ({ type: "image_url", url: url.trim() });

/** `collectXAIImagesFromJSON`: `image` / `images[]` as strings or `{image_url|url}` objects. */
export const collectImages = (body: Json): string[] => {
  const images: string[] = [];

  const append = (url: string) => {
    if (url.trim() !== "") images.push(url.trim());
  };

  const collect = (value: Json | undefined) => {
    if (typeof value === "string") return append(value);

    if (!isJsonObject(value)) return;
    append(asString(get(value, "image_url.url")));
    const imageUrl = value["image_url"];

    if (typeof imageUrl === "string") append(imageUrl);
    append(asString(value["url"]));
  };

  collect(get(body, "image"));
  const list = get(body, "images");

  if (isJsonArray(list)) for (const item of list) collect(item);

  return images;
};

/**
 * `buildXAIImagesEditRequest` with the options of `xaiImagesEditOptionsFromJSON`; with an empty `responseFormat` it is
 * `buildXAIImagesEditOriginalRequest` (no `response_format`).
 */
export const buildEditRequest = (
  body: Json,
  model: string,
  responseFormat: string,
  images: ReadonlyArray<string>,
): JsonObject => {
  const size = text(body, "size");

  const request = baseRequest({
    model,
    prompt: text(body, "prompt"),
    responseFormat,
    aspectRatio: aspectRatioFromSize(size, aspectRatio(asString(get(body, "aspect_ratio")), "")),
    resolution: resolution(asString(get(body, "resolution")), size, ""),
    quality: text(body, "quality"),
    n: numberField(body, "n"),
  });

  const refs = images.filter((image) => image.trim() !== "");

  const [firstRef] = refs;

  if (refs.length === 1 && firstRef !== undefined) {
    request["image"] = imageRef(firstRef);
  } else if (refs.length > 1) {
    request["images"] = refs.map(imageRef);
  }

  return request;
};

// ---------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------

/** `mimeTypeFromOutputFormat`. */
export const mimeTypeFromOutputFormat = (outputFormat: string): string => {
  if (outputFormat === "") return "image/png";

  if (outputFormat.includes("/")) return outputFormat;

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

export interface XaiImageResult {
  readonly b64Json: string;
  readonly url: string;
  readonly revisedPrompt: string;
  readonly mimeType: string;
}

export interface XaiImagesResponse {
  readonly results: ReadonlyArray<XaiImageResult>;
  readonly createdAt: number;
  readonly usage: Json | undefined;
}

const badGateway = (message: string) => new ExecutionError({ status: 502, message });

/** `extractXAIImagesResponse`; fails with a 502 for unusable upstream answers. */
export const extractImagesResponse = (
  payload: string,
  nowSeconds: number,
): XaiImagesResponse | ExecutionError => {
  const parsed = tryParseJson(payload);

  if (parsed === undefined) return badGateway("upstream returned invalid image response JSON");
  let createdAt = asInt(get(parsed, "created"));

  if (createdAt <= 0) createdAt = nowSeconds;
  const results: XaiImageResult[] = [];
  const data = get(parsed, "data");

  if (isJsonArray(data)) {
    for (const item of data) {
      const b64Json = text(item, "b64_json");
      const url = text(item, "url");
      let mimeType = text(item, "mime_type");

      if (mimeType === "") mimeType = mimeTypeFromOutputFormat(text(item, "output_format"));

      if (mimeType === "") mimeType = "image/png";

      if (b64Json === "" && url === "") continue;
      results.push({ b64Json, url, revisedPrompt: text(item, "revised_prompt"), mimeType });
    }
  }

  if (results.length === 0) return badGateway("upstream did not return image output");
  const usage = get(parsed, "usage");

  return { results, createdAt, usage: isJsonObject(usage) ? usage : undefined };
};

const imageFields = (image: XaiImageResult, responseFormat: string): JsonObject => {
  if (responseFormat === "url") {
    return {
      url:
        image.url !== ""
          ? image.url
          : `data:${mimeTypeFromOutputFormat(image.mimeType)};base64,${image.b64Json}`,
    };
  }

  return image.b64Json !== "" ? { b64_json: image.b64Json } : { url: image.url };
};

/** `buildImagesAPIResponseFromXAI`. */
export const buildImagesApiResponse = (
  payload: string,
  responseFormat: string,
  nowSeconds: number,
): string | ExecutionError => {
  const extracted = extractImagesResponse(payload, nowSeconds);

  if (extracted instanceof ExecutionError) return extracted;
  const format = normalizeResponseFormat(responseFormat);

  const out: JsonObject = {
    created: extracted.createdAt,
    data: extracted.results.map((image) => ({
      ...imageFields(image, format),
      ...(image.revisedPrompt !== "" ? { revised_prompt: image.revisedPrompt } : {}),
    })),
  };

  if (extracted.usage !== undefined) out["usage"] = extracted.usage;

  return JSON.stringify(out);
};

/** The `<prefix>.completed` SSE frames the Go handler writes for an image stream (one per image). */
export const buildImagesStreamFrames = (
  payload: string,
  responseFormat: string,
  streamPrefix: string,
  nowSeconds: number,
): string[] | ExecutionError => {
  const extracted = extractImagesResponse(payload, nowSeconds);

  if (extracted instanceof ExecutionError) return extracted;
  const format = normalizeResponseFormat(responseFormat);
  const eventName = `${streamPrefix}.completed`;

  return extracted.results.map((image) => {
    const data: JsonObject = { type: eventName, ...imageFields(image, format) };

    if (extracted.usage !== undefined) data["usage"] = extracted.usage;

    return sseEvent(eventName, JSON.stringify(data));
  });
};

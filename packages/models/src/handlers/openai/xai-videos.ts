/**
 * xAI video models on the OpenAI Videos API shapes.
 *
 * Go source: sdk/api/handlers/openai/openai_videos_handlers.go (model predicates, buildXAIVideosCreateRequest,
 * normalizeXAIVideosSeconds, xaiVideosSizeOptions, xaiVideosAspectRatio, xaiVideosResolution, xaiVideosInputImageURL,
 * collectXAIVideoReferenceImages, buildVideosCreateAPIResponseFromXAI, buildVideosFailedAPIResponse,
 * buildVideosRetrieveAPIResponseFromXAI, setOpenAIVideoErrorFromXAI, xaiVideoContentURLFromPayload, openAIVideoStatus,
 * videosCreateRequestFromForm).
 * Pure request/response conversion; routing, credential binding and HTTP live in `videos.ts`.
 */
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";
import { modelParts } from "./xai-images.ts";

export const DEFAULT_OPENAI_VIDEOS_MODEL = "sora-2";

export const DEFAULT_XAI_VIDEOS_MODEL = "grok-imagine-video";

const XAI_VIDEOS_15_MODEL = "grok-imagine-video-1.5";

const XAI_VIDEOS_15_LITE_MODEL = "grok-imagine-video-1.5-lite";

const XAI_VIDEOS_15_PREVIEW_ALIAS = "grok-imagine-video-1.5-preview";

const DEFAULT_SECONDS = "4";

const DEFAULT_SIZE = "720x1280";

const DEFAULT_RESOLUTION = "720p";

const MAX_REFERENCES = 7;

const videosModelBase = (model: string): string => modelParts(model).base.toLowerCase();

export const isXaiVideosModel = (model: string): boolean => {
  const { prefix, base } = modelParts(model);

  if (
    ![
      DEFAULT_XAI_VIDEOS_MODEL,
      XAI_VIDEOS_15_MODEL,
      XAI_VIDEOS_15_LITE_MODEL,
      XAI_VIDEOS_15_PREVIEW_ALIAS,
    ].includes(base.toLowerCase())
  ) {
    return false;
  }

  return ["", "xai", "x-ai", "grok"].includes(prefix.toLowerCase());
};

export const isSoraVideosModel = (model: string): boolean => {
  const base = videosModelBase(model);

  return base === DEFAULT_OPENAI_VIDEOS_MODEL || base.startsWith(`${DEFAULT_OPENAI_VIDEOS_MODEL}-`);
};

export const isSupportedVideosModel = (model: string): boolean =>
  isXaiVideosModel(model) || isSoraVideosModel(model);

/** `canonicalXAIVideosModel` (also `responseVideosModel`). */
export const canonicalXaiVideosModel = (model: string): string => {
  if (isSoraVideosModel(model)) return DEFAULT_XAI_VIDEOS_MODEL;
  const base = videosModelBase(model);

  if (base === XAI_VIDEOS_15_LITE_MODEL) return XAI_VIDEOS_15_LITE_MODEL;

  return base === XAI_VIDEOS_15_MODEL || base === XAI_VIDEOS_15_PREVIEW_ALIAS
    ? XAI_VIDEOS_15_MODEL
    : DEFAULT_XAI_VIDEOS_MODEL;
};

/** `routingXAIVideosModel`: the model used for credential selection (the preview alias is routed as itself). */
export const routingXaiVideosModel = (model: string): string => {
  if (isSoraVideosModel(model)) return DEFAULT_XAI_VIDEOS_MODEL;
  const base = videosModelBase(model);

  if (base === XAI_VIDEOS_15_MODEL) return XAI_VIDEOS_15_MODEL;

  if (base === XAI_VIDEOS_15_LITE_MODEL) return XAI_VIDEOS_15_LITE_MODEL;

  if (base === XAI_VIDEOS_15_PREVIEW_ALIAS) return XAI_VIDEOS_15_PREVIEW_ALIAS;

  return DEFAULT_XAI_VIDEOS_MODEL;
};

const text = (body: Json, path: string): string => asString(get(body, path)).trim();

// ---------------------------------------------------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------------------------------------------------

const normalizeSeconds = (
  raw: string,
): { readonly seconds: string; readonly duration: number } | string => {
  const trimmed = raw.trim() === "" ? DEFAULT_SECONDS : raw.trim();

  if (!/^[+-]?\d+$/.test(trimmed)) return "seconds must be an integer";
  const duration = Math.min(15, Math.max(1, Number.parseInt(trimmed, 10)));

  return { seconds: String(duration), duration };
};

const sizeOptions = (
  raw: string,
):
  | { readonly size: string; readonly aspectRatio: string; readonly resolution: string }
  | string => {
  const size = raw.trim() === "" ? DEFAULT_SIZE : raw.trim();

  switch (size) {
    case "720x1280":
    case "1024x1792":
      return { size, aspectRatio: "9:16", resolution: DEFAULT_RESOLUTION };
    case "1280x720":
    case "1792x1024":
      return { size, aspectRatio: "16:9", resolution: DEFAULT_RESOLUTION };
    default:
      return "size must be one of 720x1280, 1280x720, 1024x1792, or 1792x1024";
  }
};

const aspectRatio = (raw: string): string => {
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
    case "4:3":
      return "4:3";
    case "3:4":
      return "3:4";
    case "3:2":
      return "3:2";
    case "2:3":
      return "2:3";
    default:
      return "";
  }
};

const resolutionOf = (raw: string): string => {
  const value = raw.trim().toLowerCase();

  // 1080p is billed by grok-imagine-video-1.5-lite (c69cdd93).
  return value === "480p" || value === "720p" || value === "1080p" ? value : "";
};

const inputImageUrl = (body: Json): string | { readonly error: string } => {
  const inputRef = get(body, "input_reference");

  if (inputRef !== undefined) {
    const imageUrl = text(inputRef, "image_url");
    const fileId = text(inputRef, "file_id");

    if (imageUrl !== "" && fileId !== "")
      return { error: "input_reference must provide exactly one of image_url or file_id" };

    if (fileId !== "") {
      return {
        error:
          "input_reference.file_id is not supported for xAI video generation; use input_reference.image_url",
      };
    }

    if (imageUrl !== "") return imageUrl;
  }

  const image = get(body, "image");

  if (image !== undefined) {
    if (typeof image === "string") return image.trim();
    const url = text(image, "url");

    if (url !== "") return url;
    const nested = text(image, "image_url.url");

    if (nested !== "") return nested;
  }

  return text(body, "image_url");
};

const referenceImages = (body: Json): string[] => {
  const out: string[] = [];

  const collect = (value: Json | undefined) => {
    if (!isJsonArray(value)) return;

    for (const item of value) {
      const url =
        typeof item === "string"
          ? item
          : text(item, "url") !== ""
            ? text(item, "url")
            : text(item, "image_url.url");

      if (url.trim() !== "") out.push(url.trim());
    }
  };

  collect(get(body, "reference_images"));
  collect(get(body, "reference_image_urls"));

  return out;
};

export interface XaiVideoCreateMetadata {
  readonly model: string;
  readonly routingModel: string;
  readonly prompt: string;
  readonly seconds: string;
  readonly size: string;
  readonly createdAt: number;
}

/** `buildXAIVideosCreateRequest`; a string result is the validation error message. */
export const buildXaiVideosCreateRequest = (
  body: Json,
  model: string,
  nowSeconds: number,
): { readonly request: JsonObject; readonly meta: XaiVideoCreateMetadata } | string => {
  const prompt = text(body, "prompt");

  if (prompt === "") return "prompt is required";
  const seconds = normalizeSeconds(asString(get(body, "seconds")));

  if (typeof seconds === "string") return seconds;
  const sizes = sizeOptions(asString(get(body, "size")));

  if (typeof sizes === "string") return sizes;
  const ratio = aspectRatio(asString(get(body, "aspect_ratio"))) || sizes.aspectRatio;
  const resolution = resolutionOf(asString(get(body, "resolution"))) || sizes.resolution;
  const image = inputImageUrl(body);

  if (typeof image !== "string") return image.error;
  const references = referenceImages(body);

  if (references.length > MAX_REFERENCES)
    return `reference_images supports at most ${MAX_REFERENCES} images on xAI`;

  if (image !== "" && references.length > 0)
    return "image and reference_images cannot be combined on xAI";

  const request: JsonObject = {
    model: canonicalXaiVideosModel(model),
    prompt,
    duration: seconds.duration,
    aspect_ratio: ratio,
    resolution,
  };

  if (image !== "") request["image"] = { url: image };

  if (references.length > 0) request["reference_images"] = references.map((url) => ({ url }));

  return {
    request,
    meta: {
      model: canonicalXaiVideosModel(model),
      routingModel: routingXaiVideosModel(model),
      prompt,
      seconds: seconds.seconds,
      size: sizes.size,
      createdAt: nowSeconds,
    },
  };
};

/** `videosCreateRequestFromForm` (multipart and urlencoded bodies). */
export const videosCreateRequestFromForm = (form: FormData): JsonObject => {
  const field = (name: string): string => {
    const value = form.get(name);

    return typeof value === "string" ? value.trim() : "";
  };

  const first = (...names: string[]): string =>
    names.map(field).find((value) => value !== "") ?? "";

  const out: JsonObject = {};

  for (const name of ["model", "prompt", "seconds", "size", "aspect_ratio", "resolution"]) {
    const value = field(name);

    if (value !== "") out[name] = value;
  }

  const imageUrl = first("input_reference[image_url]", "input_reference.image_url", "image_url");
  const fileId = first("input_reference[file_id]", "input_reference.file_id", "file_id");

  if (imageUrl !== "" || fileId !== "") {
    out["input_reference"] = {
      ...(imageUrl !== "" ? { image_url: imageUrl } : {}),
      ...(fileId !== "" ? { file_id: fileId } : {}),
    };
  }

  const refs = field("reference_image_urls");

  if (refs !== "") {
    out["reference_image_urls"] = refs
      .split(",")
      .map((ref) => ref.trim())
      .filter((ref) => ref !== "");
  }

  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------

/** `openAIVideoStatus`. */
export const openAIVideoStatus = (status: string): string => {
  switch (status.trim().toLowerCase()) {
    case "queued":
    case "pending":
      return "queued";
    case "in_progress":
    case "processing":
    case "running":
      return "in_progress";
    case "completed":
    case "done":
    case "succeeded":
    case "success":
      return "completed";
    case "failed":
    case "error":
    case "expired":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return "";
  }
};

/** `videoIDFromPayload`: `request_id`, else `id`. */
export const videoIdFromPayload = (payload: Json | undefined): string => {
  const id = text(payload ?? null, "request_id");

  return id !== "" ? id : text(payload ?? null, "id");
};

/** `buildVideosCreateAPIResponseFromXAI`; a string result is a 502 message. */
export const buildVideosCreateResponse = (
  payload: Json | undefined,
  meta: XaiVideoCreateMetadata,
): string | { readonly error: string } => {
  const requestId = videoIdFromPayload(payload);

  if (requestId === "") return { error: "xAI video response did not include request_id" };
  const out: JsonObject = { object: "video", progress: 0, status: "queued" };
  out["id"] = requestId;
  out["model"] = meta.model;
  out["prompt"] = meta.prompt;
  out["seconds"] = meta.seconds;
  out["size"] = meta.size;
  out["created_at"] = meta.createdAt;
  const status = openAIVideoStatus(asString(get(payload, "status")));

  if (status !== "") out["status"] = status;
  const progress = get(payload, "progress");

  if (progress !== undefined) out["progress"] = progress;

  return JSON.stringify(out);
};

/** `buildVideosFailedAPIResponse`. */
export const buildVideosFailedResponse = (model: string, code: string, message: string): string =>
  JSON.stringify({
    object: "video",
    status: "failed",
    progress: 0,
    id: `video_${crypto.randomUUID().replaceAll("-", "")}`,
    model: model.trim() === "" ? DEFAULT_XAI_VIDEOS_MODEL : model.trim(),
    error: {
      code: code.trim() === "" ? "invalid_request_error" : code.trim(),
      message: message.trim() === "" ? "Video generation failed" : message.trim(),
    },
  });

const markFailed = (out: JsonObject): void => {
  if (out["status"] === undefined) out["status"] = "failed";

  if (out["progress"] === undefined) out["progress"] = 0;
};

/** `setOpenAIVideoErrorFromXAI`. */
const setErrorFromXai = (out: JsonObject, payload: Json | undefined): void => {
  const errorPayload = get(payload, "error");
  const code = text(payload ?? null, "code");

  if (errorPayload !== undefined) {
    markFailed(out);

    if (isJsonObject(errorPayload)) {
      const message = text(errorPayload, "message");

      if (message !== "") {
        out["error"] = {
          code:
            code !== ""
              ? code
              : text(errorPayload, "code") !== ""
                ? text(errorPayload, "code")
                : "video_generation_failed",
          message,
        };
      }

      return;
    }

    const message = asString(errorPayload).trim();

    if (message !== "")
      out["error"] = { code: code !== "" ? code : "video_generation_failed", message };

    return;
  }

  if (code !== "") {
    markFailed(out);
    out["error"] = { code, message: code };
  }
};

/** `buildVideosRetrieveAPIResponseFromXAI`. */
export const buildVideosRetrieveResponse = (
  videoId: string,
  payload: Json | undefined,
  fallbackModel: string,
): string => {
  const out: JsonObject = { object: "video", id: videoId };
  const model = text(payload ?? null, "model");
  out["model"] = model !== "" ? model : canonicalXaiVideosModel(fallbackModel);

  for (const field of [
    "created_at",
    "completed_at",
    "expires_at",
    "prompt",
    "remixed_from_video_id",
    "size",
  ]) {
    const value = get(payload, field);

    if (value !== undefined) out[field] = value;
  }

  const status = openAIVideoStatus(asString(get(payload, "status")));

  if (status !== "") out["status"] = status;
  const progress = get(payload, "progress");

  if (progress !== undefined) out["progress"] = progress;
  const seconds = get(payload, "seconds");
  const duration = get(payload, "video.duration");

  if (seconds !== undefined) out["seconds"] = seconds;
  else if (duration !== undefined) out["seconds"] = asString(duration);
  const videoUrl = text(payload ?? null, "video.url");

  if (videoUrl !== "") out["video_url"] = videoUrl;
  setErrorFromXai(out, payload);

  return JSON.stringify(out);
};

/** `xaiVideoContentURLFromPayload`. */
export const videoContentUrl = (payload: Json | undefined): string | { readonly error: string } => {
  const raw = text(payload ?? null, "video.url");

  if (raw === "") return { error: "xAI video response did not include video.url" };

  try {
    const parsed = new URL(raw);

    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "")
      return raw;
  } catch {
    // Falls through to the error below.
  }

  return { error: "xAI video response included invalid video.url" };
};

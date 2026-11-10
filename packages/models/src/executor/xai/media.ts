/**
 * xAI image, video and speech endpoints (non-streaming, bodies returned verbatim).
 *
 * Go source: internal/runtime/executor/xai_executor_media.go (executeImages, executeVideos),
 * xai_executor_speech.go (executeSpeech), xai_executor_request.go (xaiImageEndpointPath, xaiVideoEndpointPath,
 * xaiIsVideoRequest, xaiIsSpeechRequest, xaiSpeechRequestURL).
 *
 * Routing is by inbound entry protocol (`openai-image`, `openai-video`, `openai-speech`). Images and videos use the chat
 * base URL (OAuth: the CLI chat proxy), speech the official API only. Payload rules (protocol `openai`) are applied last.
 */
import { Effect } from "effect";
import { asString, cloneJson, get, type Json, tryParseJson } from "@commissary/json";
import { responseModelOf } from "../../usage/record.ts";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import { ExecutionError } from "../errors.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ExecutorResponse,
} from "../types.ts";
import { joinUrl, xaiChatBaseUrl, xaiSpeechUrl } from "./credentials.ts";
import { buildXaiHeaders } from "./headers.ts";
import { normalizeImageRefs } from "./input.ts";
import { transportError, sendUpstream } from "./transport.ts";
import { xaiSpeechStatusError, xaiStatusError } from "./errors.ts";

export const isImageRequest = (options: ExecutorOptions): boolean =>
  options.sourceFormat === EntryOnlyFormats.OpenAIImage;

export const isVideoRequest = (options: ExecutorOptions): boolean =>
  options.sourceFormat === EntryOnlyFormats.OpenAIVideo;

export const isSpeechRequest = (options: ExecutorOptions): boolean =>
  options.sourceFormat === EntryOnlyFormats.OpenAISpeech;

/** `xaiImageEndpointPath`. */
export const imageEndpointPath = (requestPath: string): string =>
  requestPath.endsWith("/images/edits") ? "/images/edits" : "/images/generations";

/** `xaiVideoEndpointPath`: `""` for anything but the three POST endpoints (poll requests). */
export const videoEndpointPath = (requestPath: string): string => {
  if (requestPath.endsWith("/videos/edits")) return "/videos/edits";

  if (requestPath.endsWith("/videos/extensions")) return "/videos/extensions";

  if (requestPath.endsWith("/videos/generations")) return "/videos/generations";

  return "";
};

/** `url.PathEscape`. */
const pathEscape = (segment: string): string =>
  encodeURIComponent(segment).replace(/%(24|26|2B|3D|3A|40)/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/** Builds the final (payload-rule applied) body: `finalize(model, protocol, original, body)`. */
export type FinalizeBody = (model: string, original: Json, body: Json) => Json;

const mediaModel = (request: ExecutorRequest): string => {
  const model = asString(get(request.payload, "model")).trim();

  return model !== "" ? model : request.model.trim();
};

const sessionOf = (options: ExecutorOptions): string | undefined => options.metadata.sessionId;

const sessionField = (options: ExecutorOptions) => {
  const sessionId = sessionOf(options);

  return sessionId !== undefined ? { sessionId } : {};
};

const publishModel = (context: ExecutionContext, text: string): void =>
  context.usage.observeResponseModel(responseModelOf(tryParseJson(text)));

export const executeImages = Effect.fnUntraced(function* (
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  finalize: FinalizeBody,
) {
  const model = mediaModel(request);
  // The baseline for `default` rules is what the client sent, not the handler's defaults (826bb167).
  const original = normalizeImageRefs(cloneJson(options.originalRequest ?? request.payload));
  const payload = finalize(model, original, normalizeImageRefs(cloneJson(request.payload)));

  const url = joinUrl(
    xaiChatBaseUrl(context.credential),
    imageEndpointPath(options.metadata.requestPath),
  );

  const headers = buildXaiHeaders({
    credential: context.credential,
    clientHeaders: options.headers,
    stream: false,
    ...sessionField(options),
  });

  const response = yield* sendUpstream(context, {
    method: "POST",
    url,
    headers,
    body: JSON.stringify(payload),
    classify: xaiStatusError,
  });

  const text = yield* response.text.pipe(Effect.mapError(transportError));
  publishModel(context, text);

  const finalizedFormat = asString(get(payload, "response_format")).trim();

  return {
    payload: text,
    headers: new Headers(response.headers),
    ...(finalizedFormat !== "" ? { finalizedResponseFormat: finalizedFormat } : {}),
  } satisfies ExecutorResponse;
});

export const executeVideos = Effect.fnUntraced(function* (
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  finalize: FinalizeBody,
) {
  const model = mediaModel(request);
  const payload = finalize(model, request.payload, normalizeImageRefs(cloneJson(request.payload)));
  const base = xaiChatBaseUrl(context.credential);
  let method: "GET" | "POST" = "POST";
  let endpoint = videoEndpointPath(options.metadata.requestPath);

  if (endpoint === "") {
    const requestId = asString(get(payload, "request_id")).trim();

    if (requestId !== "") {
      method = "GET";
      endpoint = `/videos/${pathEscape(requestId)}`;
    } else {
      endpoint = "/videos/generations";
    }
  }

  const headers = buildXaiHeaders({
    credential: context.credential,
    clientHeaders: options.headers,
    stream: false,
    ...sessionField(options),
  });

  if (method === "POST") {
    const key = (
      options.metadata.idempotencyKey ??
      options.headers.get("x-idempotency-key") ??
      ""
    ).trim();

    if (key !== "") headers["x-idempotency-key"] = key;
  }

  const response = yield* sendUpstream(context, {
    method,
    url: joinUrl(base, endpoint),
    headers,
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
    classify: xaiStatusError,
  });

  const text = yield* response.text.pipe(Effect.mapError(transportError));
  publishModel(context, text);

  return { payload: text, headers: new Headers(response.headers) } satisfies ExecutorResponse;
});

export const executeSpeech = Effect.fnUntraced(function* (
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  finalize: FinalizeBody,
) {
  const model = mediaModel(request);
  const payload = finalize(model, request.payload, cloneJson(request.payload));

  const headers = buildXaiHeaders({
    credential: context.credential,
    clientHeaders: options.headers,
    stream: false,
    ...sessionField(options),
  });

  // Official TTS returns raw audio; the media header helper asks for JSON.
  headers["accept"] = "*/*";

  const response = yield* sendUpstream(context, {
    method: "POST",
    url: xaiSpeechUrl(context.credential),
    headers,
    body: JSON.stringify(payload),
    classify: xaiSpeechStatusError,
  });

  const bytes = yield* response.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(transportError),
  );

  return { payload: "", bytes, headers: new Headers(response.headers) } satisfies ExecutorResponse;
});

export const streamingUnsupported = (what: string) =>
  new ExecutionError({ status: 400, message: `streaming not supported for ${what}` });

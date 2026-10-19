/**
 * Video generation routes: xAI-native `/v1/videos*` and the OpenAI-shaped `/openai/v1/videos*`.
 *
 * Go source: sdk/api/handlers/openai/openai_videos_handlers.go (VideosCreate, XAIVideosGenerations/Edits/Extensions,
 * XAIVideosRetrieve, VideosRetrieve, VideosContent, collectXAIVideosNative, collectXAIVideosCreate,
 * writeVideoContentFromURL), internal/api/server_routes.go. Every successful create/retrieve binds the video id to the
 * serving credential (KV, 3 h by default); retrievals are pinned to it.
 */
import { Clock, Effect, Result } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { routeServices } from "@commissary/core";
import { videoResultAuthCacheTtlMs } from "../../config/accessors.ts";
import {
  type ExecutionError,
  ExecutionError as ExecutionErrorClass,
} from "../../executor/errors.ts";
import { invalidRequestBody } from "../../http/errors.ts";
import { mergeUpstreamHeaders } from "../../http/headers.ts";
import {
  asString,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import {
  executeNonStream,
  executeNonStreamUnmetered,
  type ExecutionInput,
  type ExecutionOutput,
} from "../execute.ts";
import { currentConfig, type ClientApiServices, readRequestBody } from "../request.ts";
import { errorResponse, withNonStreamKeepAlive } from "../respond.ts";
import { loadVideoBinding, saveVideoBinding } from "./video-binding.ts";
import {
  buildVideosCreateResponse,
  buildVideosFailedResponse,
  buildVideosRetrieveResponse,
  buildXaiVideosCreateRequest,
  canonicalXaiVideosModel,
  DEFAULT_OPENAI_VIDEOS_MODEL,
  DEFAULT_XAI_VIDEOS_MODEL,
  isSupportedVideosModel,
  isXaiVideosModel,
  routingXaiVideosModel,
  videoContentUrl,
  videoIdFromPayload,
  videosCreateRequestFromForm,
} from "./xai-videos.ts";

const JSON_TYPE = "application/json";

const openAiError = (status: number, message: string) =>
  HttpServerResponse.text(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    contentType: JSON_TYPE,
  });

const invalid = (message: string, status = 400) =>
  HttpServerResponse.text(invalidRequestBody(message), { status, contentType: JSON_TYPE });

/** `writeVideosFailedError`: OpenAI-shaped routes answer validation errors with a failed video object. */
const failedVideo = (status: number, model: string, code: string, message: string) =>
  HttpServerResponse.text(buildVideosFailedResponse(model, code, message), {
    status,
    contentType: JSON_TYPE,
  });

const pathOf = (request: HttpServerRequest.HttpServerRequest): string =>
  new URL(request.originalUrl, "http://localhost").pathname;

/** Decoded path remainder after `prefix` (without a leading slash), `""` for the bare prefix. */
const remainder = (request: HttpServerRequest.HttpServerRequest, prefix: string): string => {
  const rest = pathOf(request).slice(prefix.length).replace(/^\/+/, "");

  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
};

interface VideoRun {
  readonly model: string;
  readonly body: Json;
  readonly pinnedId?: string;
}

/**
 * Runs one `openai-video` execution; the serving credential id is part of the output. Creating a video is a Request
 * and counts against free usage; polling one (`metered: false`) is not.
 */
const runVideo = (request: HttpServerRequest.HttpServerRequest, run: VideoRun, metered = true) => {
  const input: ExecutionInput = {
    entryProtocol: "openai-video",
    model: run.model,
    body: run.body,
    alt: "",
    request,
    ...(run.pinnedId !== undefined ? { pinnedId: run.pinnedId } : {}),
  };

  return metered ? executeNonStream(input) : executeNonStreamUnmetered(input);
};

const upstreamJson = (payload: string, upstream: Headers | undefined) =>
  HttpServerResponse.text(payload, {
    headers: mergeUpstreamHeaders({ "content-type": JSON_TYPE }, upstream),
  });

interface Services {
  readonly passthroughHeaders: boolean;
  readonly ttlMs: number;
  /** `requests.nonstream-keepalive-interval` (0 disables). */
  readonly keepAliveSeconds: number;
}

const services = Effect.gen(function* () {
  const config = yield* currentConfig;

  return {
    passthroughHeaders: config.requests["passthrough-headers"],
    ttlMs: videoResultAuthCacheTtlMs(config),
    keepAliveSeconds: config.requests["nonstream-keepalive-interval"],
  } satisfies Services;
});

/** Config problems surface from the execution itself (503); the handler then only needs defaults. */
const servicesOrDefault = services.pipe(
  Effect.catch(() =>
    Effect.succeed({
      passthroughHeaders: false,
      ttlMs: 3 * 60 * 60 * 1000,
      keepAliveSeconds: 0,
    } satisfies Services),
  ),
);

const bind = (output: ExecutionOutput, videoId: string, model: string, ttlMs: number) =>
  saveVideoBinding(
    videoId,
    { authId: output.credentialId, model: routingXaiVideosModel(model) },
    ttlMs,
  );

/** Retrieval of `videoId`: pinned to the creating credential and its routing model when a binding exists. */
const retrieve = (request: HttpServerRequest.HttpServerRequest, videoId: string) =>
  Effect.gen(function* () {
    const binding = yield* loadVideoBinding(videoId);

    const model =
      binding !== undefined && binding.model.trim() !== ""
        ? binding.model.trim()
        : DEFAULT_XAI_VIDEOS_MODEL;

    return {
      model,
      output: yield* runVideo(
        request,
        {
          model,
          body: { request_id: videoId },
          ...(binding !== undefined ? { pinnedId: binding.authId } : {}),
        },
        false,
      ),
    };
  });

// ---------------------------------------------------------------------------------------------------------------
// xAI-native routes
// ---------------------------------------------------------------------------------------------------------------

const nativePost = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { passthroughHeaders, ttlMs } = yield* servicesOrDefault;
  const onError = (error: ExecutionError) => errorResponse("openai", error, { passthroughHeaders });
  const read = yield* Effect.result(readRequestBody(request));

  if (Result.isFailure(read)) return invalid(read.failure.message, read.failure.status);
  const body = read.success.json;

  if (body === undefined || !isJsonObject(body)) return invalid("body must be valid JSON");
  const requested = asString(get(body, "model")).trim() || DEFAULT_XAI_VIDEOS_MODEL;

  if (!isXaiVideosModel(requested)) {
    return openAiError(
      400,
      `Model ${requested} is not supported on /v1/videos/generations, /v1/videos/edits, or /v1/videos/extensions. Use ${DEFAULT_XAI_VIDEOS_MODEL}.`,
    );
  }

  const routingModel = routingXaiVideosModel(requested);
  const payload: JsonObject = { ...body, model: canonicalXaiVideosModel(requested) };
  const result = yield* Effect.result(runVideo(request, { model: routingModel, body: payload }));

  if (Result.isFailure(result)) return onError(result.failure);
  const output = result.success;
  yield* bind(output, videoIdFromPayload(tryParseJson(output.payload)), routingModel, ttlMs);

  return upstreamJson(output.payload, output.headers);
});

const nativeRetrieve = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { passthroughHeaders, ttlMs } = yield* servicesOrDefault;
  const requestId = remainder(request, "/v1/videos").trim();

  if (requestId === "" || requestId.includes("/")) return HttpServerResponse.empty({ status: 404 });
  const result = yield* Effect.result(retrieve(request, requestId));

  if (Result.isFailure(result))
    return errorResponse("openai", result.failure, { passthroughHeaders });
  const { model, output } = result.success;
  yield* bind(output, requestId, model, ttlMs);

  return upstreamJson(output.payload, output.headers);
});

// ---------------------------------------------------------------------------------------------------------------
// OpenAI-shaped routes (/openai/v1/videos)
// ---------------------------------------------------------------------------------------------------------------

const readCreateBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const contentType =
      (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

    if (
      contentType === "multipart/form-data" ||
      contentType === "application/x-www-form-urlencoded"
    ) {
      const raw = yield* request.arrayBuffer;

      const form = yield* Effect.tryPromise({
        try: () =>
          new Request("http://localhost/", {
            method: "POST",
            headers: { "content-type": request.headers["content-type"] ?? "" },
            body: new Uint8Array(raw),
          }).formData(),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      });

      return videosCreateRequestFromForm(form);
    }

    const read = yield* readRequestBody(request).pipe(Effect.mapError((error) => error.message));

    if (read.json === undefined) return yield* Effect.fail("body must be valid JSON");

    return read.json;
  });

const soraCreate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { passthroughHeaders, ttlMs } = yield* servicesOrDefault;
  const read = yield* Effect.result(readCreateBody(request));

  if (Result.isFailure(read)) {
    return failedVideo(
      400,
      DEFAULT_XAI_VIDEOS_MODEL,
      "invalid_request_error",
      `Invalid request: ${String(read.failure)}`,
    );
  }

  const body = read.success;
  const requested = asString(get(body, "model")).trim() || DEFAULT_XAI_VIDEOS_MODEL;

  if (!isSupportedVideosModel(requested)) {
    const path = pathOf(request) || "/openai/v1/videos";

    return failedVideo(
      400,
      requested,
      "invalid_request_error",
      `Model ${requested} is not supported on ${path}. Use ${DEFAULT_OPENAI_VIDEOS_MODEL}.`,
    );
  }

  const built = buildXaiVideosCreateRequest(
    body,
    requested,
    Math.floor((yield* Clock.currentTimeMillis) / 1000),
  );

  if (typeof built === "string") {
    return failedVideo(
      400,
      canonicalXaiVideosModel(requested),
      "invalid_request_error",
      `Invalid request: ${built}`,
    );
  }

  const result = yield* Effect.result(
    runVideo(request, { model: built.meta.routingModel, body: built.request }),
  );

  if (Result.isFailure(result))
    return errorResponse("openai", result.failure, { passthroughHeaders });
  const output = result.success;
  const out = buildVideosCreateResponse(tryParseJson(output.payload), built.meta);

  if (typeof out !== "string") {
    return errorResponse("openai", new ExecutionErrorClass({ status: 502, message: out.error }), {
      passthroughHeaders,
    });
  }

  yield* bind(output, videoIdFromPayload(tryParseJson(out)), built.meta.routingModel, ttlMs);

  return upstreamJson(out, output.headers);
});

/** Headers copied from the upstream video download (`copyVideoContentHeaders`). */
const CONTENT_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified",
];

const soraContent = (
  request: HttpServerRequest.HttpServerRequest,
  videoId: string,
  passthroughHeaders: boolean,
  ttlMs: number,
) =>
  Effect.gen(function* () {
    const variant =
      (new URL(request.originalUrl, "http://localhost").searchParams.get("variant") ?? "").trim() ||
      "video";

    if (variant !== "video") {
      return openAiError(
        400,
        `Invalid request: variant "${variant}" is not available for xAI video downloads`,
      );
    }

    const result = yield* Effect.result(retrieve(request, videoId));

    if (Result.isFailure(result))
      return errorResponse("openai", result.failure, { passthroughHeaders });
    const { model, output } = result.success;
    yield* bind(output, videoId, model, ttlMs);
    const url = videoContentUrl(tryParseJson(output.payload));

    if (typeof url !== "string") {
      return errorResponse("openai", new ExecutionErrorClass({ status: 502, message: url.error }), {
        passthroughHeaders,
      });
    }

    const client = yield* HttpClient.HttpClient;

    const download = yield* Effect.result(
      client
        .execute(HttpClientRequest.get(url))
        .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
    );

    if (Result.isFailure(download)) {
      return errorResponse(
        "openai",
        new ExecutionErrorClass({ status: 502, message: "video content download failed" }),
        {
          passthroughHeaders,
        },
      );
    }

    const response = download.success;

    if (response.status < 200 || response.status >= 300) {
      const body = (yield* response.text.pipe(Effect.orElseSucceed(() => ""))).trim();

      return errorResponse(
        "openai",
        new ExecutionErrorClass({
          status: response.status,
          message: `video content download failed: ${body !== "" ? body : String(response.status)}`,
        }),
        { passthroughHeaders },
      );
    }

    const headers: Record<string, string> = {};

    for (const name of CONTENT_HEADERS) {
      const value = response.headers[name];

      if (value !== undefined && value !== "") headers[name] = value;
    }

    headers["content-type"] ??= "application/octet-stream";

    return HttpServerResponse.stream(response.stream, { status: response.status, headers });
  });

const soraGet = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { passthroughHeaders, ttlMs, keepAliveSeconds } = yield* servicesOrDefault;
  const rest = remainder(request, "/openai/v1/videos").trim();
  const wantsContent = rest.endsWith("/content");
  const videoId = (wantsContent ? rest.slice(0, -"/content".length) : rest).trim();

  if (videoId === "" || videoId.includes("/")) return HttpServerResponse.empty({ status: 404 });

  if (wantsContent) return yield* soraContent(request, videoId, passthroughHeaders, ttlMs);

  // Go keeps blank lines flowing only around the retrieval (`VideosRetrieve`); content downloads write binary bodies.
  return yield* withNonStreamKeepAlive(
    keepAliveSeconds,
    Effect.gen(function* () {
      const result = yield* Effect.result(retrieve(request, videoId));

      if (Result.isFailure(result))
        return errorResponse("openai", result.failure, { passthroughHeaders });
      const { model, output } = result.success;
      yield* bind(output, videoId, model, ttlMs);

      return upstreamJson(
        buildVideosRetrieveResponse(
          videoId,
          tryParseJson(output.payload),
          DEFAULT_OPENAI_VIDEOS_MODEL,
        ),
        output.headers,
      );
    }),
  );
});

/** Route layer; requires the {@link ClientApiServices} and `AccessPrincipal`. */
export const VideoRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const context = yield* routeServices<ClientApiServices>();
    yield* router.add("POST", "/v1/videos", Effect.provide(nativePost, context));
    yield* router.add("POST", "/v1/videos/generations", Effect.provide(nativePost, context));
    yield* router.add("POST", "/v1/videos/edits", Effect.provide(nativePost, context));
    yield* router.add("POST", "/v1/videos/extensions", Effect.provide(nativePost, context));
    yield* router.add("GET", "/v1/videos/*", Effect.provide(nativeRetrieve, context));
    yield* router.add("POST", "/openai/v1/videos", Effect.provide(soraCreate, context));
    yield* router.add("GET", "/openai/v1/videos/*", Effect.provide(soraGet, context));
  }),
);

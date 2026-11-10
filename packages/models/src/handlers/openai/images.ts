/**
 * OpenAI Images API routes for Codex image models: `POST /v1/images/generations` and `POST /v1/images/edits`
 * (entry protocol `openai-image`; the Codex executor answers with an Images API body or SSE frames).
 *
 * Go source: sdk/api/handlers/openai/openai_images_handlers.go (ImagesGenerations, ImagesEdits, imagesEditsFromJSON,
 * imagesEditsFromMultipart, buildOpenAICompatImagesJSONRequest, collectRoutedImages, streamRoutedImages,
 * collectImagesWithModel, streamOpenAICompatImages). Served here: the Codex tool models (`gpt-image-*`), models the
 * registry types as `openai-image` (OpenAI-compatible providers, `image: true` in config) and the xAI
 * `grok-imagine-image*` models (`xai-images.ts`). Multipart edits are converted to the JSON form (`images[].image_url`,
 * `mask.image_url`) before execution (Go does the same in the executor, `codexRewriteOpenAIImageEditMultipartToJSON`).
 */
import { Clock, Effect, Result, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { routeServices } from "@commissary/core";
import {
  ExecutionError,
  type ExecutionError as ExecutionErrorType,
} from "../../executor/errors.ts";
import type { Config } from "../../config/schema.ts";
import { invalidRequestBody, openAIErrorBody } from "../../http/errors.ts";
import { SSE_KEEP_ALIVE, sseEvent } from "@commissary/translation/sse";
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
import { ModelProviders } from "../model-providers.ts";
import { CODEX_DEFAULT_IMAGE_TOOL_MODEL } from "../../executor/codex/images.ts";
import {
  executeNonStream,
  executeStream,
  type ExecutionInput,
  type StreamOutput,
} from "../execute.ts";
import type { StreamFramer } from "../framing.ts";
import { currentConfig, type ClientApiServices, readRequestBody } from "../request.ts";
import { errorResponse, jsonResponse, streamResponse, withNonStreamKeepAlive } from "../respond.ts";
import {
  buildEditRequest,
  buildGenerationsRequest,
  buildImagesApiResponse as buildXaiImagesApiResponse,
  buildImagesStreamFrames,
  canonicalModel as canonicalXaiImagesModel,
  collectImages,
  hasXaiImageBase,
  isXaiVendorAlias,
  modelParts,
  normalizeResponseFormat,
  XAI_IMAGE_MODEL_NAMES,
} from "./xai-images.ts";

const CODEX_IMAGE_MODELS = [
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6",
];

/** `imagesModelBase`: text after the last `/`, lower case. */
const imagesModelBase = (model: string): string => {
  const trimmed = model.trim();
  const slash = trimmed.lastIndexOf("/");

  return (slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed)
    .trim()
    .toLowerCase();
};

const isCodexImagesToolModel = (model: string): boolean =>
  CODEX_IMAGE_MODELS.includes(imagesModelBase(model));

/** `mimeTypeFromOutputFormat`. */
const mimeTypeFromOutputFormat = (outputFormat: string): string => {
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

/** `buildImagesAPIResponseFromXAI`: an OpenAI-compatible Images answer normalised to `response_format`. */
export const buildImagesApiResponse = (
  payload: string,
  responseFormat: string,
  nowSeconds: number,
): { readonly out: string } | { readonly error: string } => {
  const parsed = tryParseJson(payload);

  if (parsed === undefined) return { error: "upstream returned invalid image response JSON" };
  const createdValue = asInt(get(parsed, "created"));
  const created = createdValue > 0 ? createdValue : nowSeconds;
  const data = get(parsed, "data");
  const format = responseFormat.trim().toLowerCase() === "url" ? "url" : "b64_json";
  const items: JsonObject[] = [];

  for (const entry of isJsonArray(data) ? data : []) {
    const b64 = asString(get(entry, "b64_json")).trim();
    const url = asString(get(entry, "url")).trim();

    if (b64 === "" && url === "") continue;
    const revised = asString(get(entry, "revised_prompt")).trim();

    const mime =
      asString(get(entry, "mime_type")).trim() ||
      mimeTypeFromOutputFormat(asString(get(entry, "output_format")).trim());

    const item: JsonObject = {};

    if (format === "url")
      item["url"] = url !== "" ? url : `data:${mimeTypeFromOutputFormat(mime)};base64,${b64}`;
    else if (b64 !== "") item["b64_json"] = b64;
    else item["url"] = url;

    if (revised !== "") item["revised_prompt"] = revised;
    items.push(item);
  }

  if (items.length === 0) return { error: "upstream did not return image output" };
  const out: JsonObject = { created, data: items };
  const usage = get(parsed, "usage");

  if (usage !== undefined && typeof usage === "object" && usage !== null && !Array.isArray(usage))
    out["usage"] = usage;

  return { out: JSON.stringify(out) };
};

const badRequest = (message: string, status = 400): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(invalidRequestBody(message), { status, contentType: "application/json" });

const unsupportedModel = (model: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(
    invalidRequestBody(
      `Model ${model} is not supported on /v1/images/generations or /v1/images/edits. Use ${[...CODEX_IMAGE_MODELS, ...XAI_IMAGE_MODEL_NAMES].join(", ")}, or a configured openai-compatibility image model.`,
    ),
    { status: 400, contentType: "application/json" },
  );

/** Image frames are complete SSE events already; errors become an `error` event. */
const imagesFramer = (): StreamFramer => ({
  chunk: (payload) => payload,
  terminalError: (error) => {
    const status = error.status > 0 ? error.status : 500;

    return sseEvent("error", openAIErrorBody(status, error.message));
  },
  closeError: () => undefined,
  done: () => "",
  emptyBody: "",
  keepAlive: SSE_KEEP_ALIVE,
});

const fileDataUrl = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  const type = file.type.trim() !== "" ? file.type.trim() : "application/octet-stream";

  return `data:${type};base64,${btoa(binary)}`;
};

const MASK_FIELD_PATHS = new Map([
  ["mask[file_id]", "mask.file_id"],
  ["mask[image_url]", "mask.image_url"],
]);

/** A form field as text: file parts count as absent. */
const formText = (entry: string | File | null): string => (typeof entry === "string" ? entry : "");

const INTEGER_FORM_FIELDS = new Set(["n", "output_compression", "partial_images"]);

/** `codexRewriteOpenAIImageEditMultipartToJSON`: form fields and uploads as the JSON edit request. */
const multipartEditToJson = async (form: FormData): Promise<JsonObject> => {
  const out: JsonObject = {};
  const images: Json[] = [];
  let mask: string | undefined;
  const files: File[] = [];

  for (const [key, value] of form.entries()) {
    const name = key.trim();

    if (typeof value !== "string") {
      if (name === "mask") mask ??= await fileDataUrl(value);
      else if (name === "image[]" || name === "image") files.push(value);
      continue;
    }

    if (name === "" || name === "model" || name === "stream") continue;

    const path = MASK_FIELD_PATHS.get(name) ?? name;

    const trimmed = value.trim();

    const parsed =
      INTEGER_FORM_FIELDS.has(name.toLowerCase()) && /^[+-]?\d+$/.test(trimmed)
        ? Number.parseInt(trimmed, 10)
        : trimmed;

    if (path.startsWith("mask.")) {
      const current = out["mask"];
      out["mask"] = {
        ...(typeof current === "object" && current !== null && !Array.isArray(current)
          ? current
          : {}),
        [path.slice(5)]: parsed,
      };
    } else {
      out[path] = parsed;
    }
  }

  if (mask !== undefined) {
    const current = out["mask"];
    out["mask"] = {
      ...(typeof current === "object" && current !== null && !Array.isArray(current)
        ? current
        : {}),
      image_url: mask,
    };
  }

  for (const file of files) images.push({ image_url: await fileDataUrl(file) });

  if (images.length > 0) out["images"] = images;

  return out;
};

/**
 * `registeredXAIImagesModel`: `model` (or its lower-cased form) when a credential of the xai provider registers it.
 * The registry is the caller's view, so a model they cannot reach is not registered.
 */
const registeredXaiImagesModel = (providers: ModelProviders["Service"], model: string) =>
  Effect.gen(function* () {
    const id = model.trim();

    if (id === "") return undefined;

    for (const candidate of [id, id.toLowerCase()]) {
      // A registry failure is the caller's 503, not an unsupported model.
      const found = yield* providers.providersFor(candidate);

      if (found.some((provider) => provider.trim().toLowerCase() === "xai")) return candidate;
    }

    return undefined;
  });

/**
 * `isXAIImagesModel`: a known Grok image model, bare, with a built-in vendor prefix (`xai/`, `x-ai/`, `grok/`) or with
 * a prefix a credential registers (45ccd9c3).
 */
const isXaiImagesModel = (providers: ModelProviders["Service"], model: string) =>
  Effect.gen(function* () {
    const { prefix } = modelParts(model);

    if (!hasXaiImageBase(model)) return false;

    if (prefix.trim() === "" || isXaiVendorAlias(prefix)) return true;

    const prefixed = `${prefix}/${canonicalXaiImagesModel(model)}`;

    return (
      (yield* registeredXaiImagesModel(providers, prefixed)) !== undefined ||
      (yield* registeredXaiImagesModel(providers, model)) !== undefined
    );
  });

/**
 * `routingXAIImagesModel` (45ccd9c3, 8a3e7622): the model credential selection uses. Deviation: Go also keeps the
 * prefix when the auth manager runs in home mode, which Commissary does not have.
 */
const routingXaiImagesModel = (
  providers: ModelProviders["Service"],
  model: string,
  force: boolean,
) =>
  Effect.gen(function* () {
    const canonical = canonicalXaiImagesModel(model);
    const { prefix } = modelParts(model);

    if (prefix === "") return canonical;
    const prefixed = `${prefix}/${canonical}`;
    const registeredPrefixed = yield* registeredXaiImagesModel(providers, prefixed);

    if (registeredPrefixed !== undefined) return registeredPrefixed;
    const registeredModel = yield* registeredXaiImagesModel(providers, model);

    if (registeredModel !== undefined) return registeredModel;

    // Built-in vendor aliases may fall back to an unprefixed credential even when prefixes are forced.
    if (force && !isXaiVendorAlias(prefix)) return prefixed;

    return (yield* registeredXaiImagesModel(providers, canonical)) === undefined
      ? prefixed
      : canonical;
  });

interface XaiImagesInput {
  readonly providers: ModelProviders["Service"];
  readonly edits: boolean;
  readonly body: Json;
  readonly model: string;
  readonly stream: boolean;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly config: Config;
  readonly onError: (error: ExecutionErrorType) => HttpServerResponse.HttpServerResponse;
}

/**
 * xAI image models: the request is converted to the xAI shape and executed non-stream; a stream request replays the
 * result as `<image_generation|image_edit>.completed` frames (xAI has no image streaming).
 */
const handleXai = (input: XaiImagesInput) =>
  Effect.gen(function* () {
    const { body, edits, model, stream, onError } = input;
    const rawResponseFormat = asString(get(body, "response_format")).trim();
    const requestedFormat = rawResponseFormat || "b64_json";
    let xaiRequest: JsonObject;
    let originalRequest: JsonObject;

    if (edits) {
      const images = collectImages(body);

      if (images.length === 0) return badRequest("image is required");
      xaiRequest = buildEditRequest(body, model, requestedFormat, images);
      originalRequest = buildEditRequest(body, model, rawResponseFormat, images);
    } else {
      xaiRequest = buildGenerationsRequest(body, model, requestedFormat, true);
      originalRequest = buildGenerationsRequest(body, model, rawResponseFormat, false);
    }

    const routingModel = yield* routingXaiImagesModel(
      input.providers,
      model,
      input.config.routing["force-model-prefix"],
    );

    const execution: ExecutionInput = {
      entryProtocol: "openai-image",
      model: routingModel,
      body: xaiRequest,
      originalRequest,
      alt: "",
      request: input.request,
      allowImageModel: true,
    };

    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    if (stream) {
      const prefix = edits ? "image_edit" : "image_generation";

      const start = executeNonStream(execution).pipe(
        Effect.flatMap((output) => {
          const frames = buildImagesStreamFrames(
            output.payload,
            normalizeResponseFormat(output.finalizedResponseFormat ?? requestedFormat),
            prefix,
            nowSeconds,
          );

          return frames instanceof ExecutionError
            ? Effect.fail(frames)
            : Effect.succeed({
                chunks: Stream.fromIterable(frames),
                headers: output.headers,
              } satisfies StreamOutput);
        }),
      );

      return yield* streamResponse(start, {
        framer: imagesFramer(),
        onError,
        keepAliveSeconds: input.config.requests.streaming["keepalive-seconds"],
      });
    }

    return yield* withNonStreamKeepAlive(
      input.config.requests["nonstream-keepalive-interval"],
      Effect.gen(function* () {
        const result = yield* Effect.result(executeNonStream(execution));

        if (Result.isFailure(result)) return onError(result.failure);

        const out = buildXaiImagesApiResponse(
          result.success.payload,
          normalizeResponseFormat(result.success.finalizedResponseFormat ?? requestedFormat),
          nowSeconds,
        );

        if (out instanceof ExecutionError) return onError(out);

        return jsonResponse(out, result.success.headers);
      }),
    );
  });

const handle = (edits: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const configResult = yield* Effect.result(currentConfig);

    if (Result.isFailure(configResult))
      return errorResponse("openai", configResult.failure, { passthroughHeaders: false });
    const config = configResult.success;

    if (config.multimedia["disable-image-generation"] === true)
      return HttpServerResponse.empty({ status: 404 });

    const onError = (error: ExecutionErrorType) =>
      errorResponse("openai", error, {
        passthroughHeaders: config.requests["passthrough-headers"],
      });

    let body: Json;
    let formModel = "";
    let formStream = false;
    const contentType = (request.headers["content-type"] ?? "").toLowerCase().trim();

    if (edits && (contentType.startsWith("multipart/form-data") || contentType === "")) {
      const raw = yield* Effect.result(request.arrayBuffer);

      if (Result.isFailure(raw)) return badRequest(raw.failure.message);

      const formResult = yield* Effect.result(
        Effect.tryPromise({
          try: async () => {
            const form = await new Request(new URL(request.url, "http://localhost"), {
              method: "POST",
              headers: { "content-type": request.headers["content-type"] ?? "" },
              body: new Uint8Array(raw.success),
            }).formData();

            formModel = formText(form.get("model")).trim();
            formStream = ["1", "t", "true"].includes(
              formText(form.get("stream")).trim().toLowerCase(),
            );

            return await multipartEditToJson(form);
          },
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }),
      );

      if (Result.isFailure(formResult)) return badRequest(formResult.failure);
      body = formResult.success;
    } else if (!edits || contentType.startsWith("application/json")) {
      const read = yield* Effect.result(readRequestBody(request));

      if (Result.isFailure(read)) return badRequest(read.failure.message, read.failure.status);

      if (read.success.json === undefined) return badRequest("body must be valid JSON");
      body = read.success.json;
    } else {
      return badRequest(`unsupported Content-Type "${contentType}"`);
    }

    let model = (formModel !== "" ? formModel : asString(get(body, "model"))).trim();

    if (model === "") model = CODEX_DEFAULT_IMAGE_TOOL_MODEL;
    const providers = yield* ModelProviders;
    const xai = yield* isXaiImagesModel(providers, model);
    let compat = false;

    if (!xai && !isCodexImagesToolModel(model)) {
      const type =
        providers.modelType === undefined
          ? undefined
          : yield* providers.modelType(model).pipe(Effect.orElseSucceed(() => undefined));

      compat = type === "openai-image";

      if (!compat) return unsupportedModel(model);
    }

    if (asString(get(body, "prompt")).trim() === "") return badRequest("prompt is required");
    const stream = formStream || get(body, "stream") === true;

    if (xai)
      return yield* handleXai({ providers, edits, body, model, stream, request, config, onError });

    // `buildOpenAICompatImagesJSONRequest`: model set, `stream: true` or removed.
    const payload: JsonObject = { ...(isJsonObject(body) ? body : {}), model };

    if (stream) payload["stream"] = true;
    else delete payload["stream"];

    const input: ExecutionInput = {
      entryProtocol: "openai-image",
      model,
      body: payload,
      alt: "",
      request,
      allowImageModel: true,
      // Free-plan Codex credentials cannot use the image tools (`WithDisallowFreeAuth`).
      ...(compat ? {} : { disallowFreeAuth: true }),
    };

    if (stream) {
      return yield* streamResponse(executeStream(input), {
        framer: imagesFramer(),
        onError,
        keepAliveSeconds: config.requests.streaming["keepalive-seconds"],
      });
    }

    return yield* withNonStreamKeepAlive(
      config.requests["nonstream-keepalive-interval"],
      Effect.gen(function* () {
        const result = yield* Effect.result(executeNonStream(input));

        if (Result.isFailure(result)) return onError(result.failure);

        if (!compat)
          return HttpServerResponse.text(result.success.payload, {
            contentType: "application/json",
          });
        const responseFormat = asString(get(body, "response_format")).trim() || "b64_json";

        const converted = buildImagesApiResponse(
          result.success.payload,
          responseFormat,
          Math.floor((yield* Clock.currentTimeMillis) / 1000),
        );

        if ("error" in converted)
          return onError(new ExecutionError({ status: 502, message: converted.error }));

        return HttpServerResponse.text(converted.out, { contentType: "application/json" });
      }),
    );
  });

/** Route layer; requires the {@link ClientApiServices} and `AccessPrincipal`. */
export const ImagesRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* routeServices<ClientApiServices>();
    yield* router.add("POST", "/v1/images/generations", Effect.provide(handle(false), services));
    yield* router.add("POST", "/v1/images/edits", Effect.provide(handle(true), services));
  }),
);

/**
 * Executor for OpenAI-compatible upstreams (`api-keys.openai-compatibility`).
 *
 * Go source: internal/runtime/executor/openai_compat_executor.go (Execute, ExecuteStream, CountTokens,
 * resolveCredentials, applyPromptCacheKey, newOpenAICompatStatusError). Per attempt: translate the client body to
 * Chat Completions -> thinking -> max-token field normalisation -> prompt cache key -> `stream_options.include_usage`
 * (stream) -> user payload rules (final semantic mutation) -> POST `{base-url}/chat/completions`.
 *
 * Images (`openai-image` source format) take the `executeImages` path below: the body is forwarded to
 * `{base-url}/images/generations|edits` (see `images.ts`).
 *
 * `CountTokens` counts locally with the model's BPE encoding (`helps/token-count.ts`).
 *
 * `/responses/compact` (non-stream) posts the Responses-format request to `{base-url}/responses/compact`.
 *
 * Text-only tool-result normalisation applies to models whose `input-modalities` exclude images
 * (`helps/openai-compat-tool-results.ts`); prompt cache keys are client-supplied, Claude Code scoped or derived from the
 * provider session (`applyPromptCacheKey`).
 */
import { modelIsCompat, translateRequestForExecutor } from "../helps/translate.ts";
import { Clock, Effect, Stream } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { del, get, isJsonObject, type Json, set, tryParseJson } from "@commissary/json";
import { sanitizeReasoningEncryptedContent } from "../codex/request.ts";
import { splitLines } from "@commissary/translation/sse";
import {
  builtinTranslators,
  makeTranslationState,
  type ResponseContext,
  type TranslatorRegistry,
} from "@commissary/translation";
import { EntryOnlyFormats, type Format, Formats } from "@commissary/translation/formats";
import { encodingForModel, getCodec } from "@commissary/translation/tokenizer";
import {
  parseOpenAIStreamUsage,
  parseOpenAIUsage,
  responseModelOf,
  ssePayloadObject,
} from "../../usage/record.ts";
import { isChatTokenEvent } from "../../usage/ttft.ts";
import { ExecutionError, headersRecord } from "../errors.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { claudeCodeExecutionScope } from "../codex/replay.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
import {
  normalizeToolResultsTextOnly,
  shouldNormalizeToolResults,
} from "../helps/openai-compat-tool-results.ts";
import { providerSessionUuid, uuidV5Oid } from "../helps/uuid.ts";
import { finalizePayload } from "../helps/payload.ts";
import {
  normalizeOpenAIMaxTokens,
  setBoolIfDifferent,
  shouldUseMaxCompletionTokens,
} from "../helps/openai-compat-models.ts";
import { openAICompatRetryAfterMs } from "../helps/retry-after.ts";
import { buildOpenAIUsageJson, countOpenAIChatTokens } from "../helps/token-count.ts";
import { resolveCompatConfig } from "../models.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import { Thinking } from "../thinking.ts";
import {
  type ExecutionContext,
  type ExecutorOptions,
  type ExecutorRequest,
  type ExecutorResponse,
  type ProviderExecutor,
  responseFormatOf,
  type StreamResult,
} from "../types.ts";
import {
  compatImageEndpointPath,
  editBodyToFormData,
  prepareCompatImagesBody,
  wantsMultipartEdit,
} from "./images.ts";
import { OpenAICompatStreamReader, TOOL_INPUT_ERROR_MESSAGE } from "./stream.ts";

const USER_AGENT = "cli-proxy-openai-compat";

const CHAT_COMPLETIONS_PATH = "/chat/completions";

const RESPONSES_COMPACT_PATH = "/responses/compact";

interface PreparedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Final business payload (after payload rules). */
  readonly body: Json;
  readonly baseModel: string;
  /** Upstream protocol of the request (`openai`, or `openai-response` for compaction). */
  readonly to: Format;
  /** Multipart form sent instead of `body` (image edits uploaded as multipart by the client). */
  readonly form?: FormData;
}

/** `fetch` failures carry no HTTP answer: the conductor treats them as transient transport errors (no cooldown). */
const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

/** `resolveCredentials`: trimmed `base_url` and `api_key` attributes. */
const credentialEndpoint = (context: ExecutionContext) => ({
  baseURL: (context.credential.attributes["base_url"] ?? "").trim(),
  providerKey: (context.credential.attributes["api_key"] ?? "").trim(),
});

/**
 * `applyPromptCacheKey`: a client-supplied `prompt_cache_key`, else (Claude callers) the Claude Code agent scope, else a
 * stable key derived from the provider session (`ProviderSessionUUID`: the execution session, then the derived session
 * identity: `ExecutionMetadata.derivedSessionId`, produced by `session-routing/identity.ts#deriveId`, absent when the
 * client sent an explicit session marker).
 */
const applyPromptCacheKey = (
  provider: string,
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  baseModel: string,
  translated: Json,
): Json => {
  const group = resolveCompatConfig(context.config, context.credential);

  if (group?.["support-prompt-cache-key"] !== true) return translated;

  for (const payload of [request.payload, options.originalRequest, translated]) {
    const value = get(payload, "prompt_cache_key");
    const key = typeof value === "string" ? value.trim() : "";

    if (key !== "")
      return get(translated, "prompt_cache_key") === key
        ? translated
        : set(translated, "prompt_cache_key", key);
  }

  const translatedModel = get(translated, "model");

  const modelName =
    (typeof translatedModel === "string" ? translatedModel.trim() : "") || baseModel;

  const from = options.sourceFormat;

  if (from.trim().toLowerCase() === "claude") {
    const scope = claudeCodeExecutionScope(request.payload, options.headers);

    if (modelName !== "" && scope !== undefined) {
      const cached = uuidV5Oid(
        ["cli-proxy-api:codex:claude-code", modelName, scope].join("\u0000"),
      );

      return get(translated, "prompt_cache_key") === cached
        ? translated
        : set(translated, "prompt_cache_key", cached);
    }
  }

  const executionId = (options.metadata.websocket?.sessionId ?? "").trim();

  const sessionId =
    executionId !== ""
      ? providerSessionUuid(provider, "execution-session", executionId)
      : providerSessionUuid(provider, "derived-session", options.metadata.derivedSessionId);

  if (sessionId === "") return translated;
  const providerName = provider.trim() || group.name.trim();

  const identity = [
    "cli-proxy-api:openai-compat:prompt-cache",
    providerName.toLowerCase(),
    modelName.toLowerCase(),
    from.trim().toLowerCase(),
    sessionId,
  ].join("\u0000");

  const key = uuidV5Oid(identity);

  return get(translated, "prompt_cache_key") === key
    ? translated
    : set(translated, "prompt_cache_key", key);
};

const responseContext = (
  request: ExecutorRequest,
  options: ExecutorOptions,
  translated: Json,
): ResponseContext => ({
  model: request.model,
  originalRequest: options.originalRequest ?? request.payload,
  translatedRequest: translated,
  state: makeTranslationState(),
});

/** Upstream request headers: JSON content type (unless multipart), key, user agent, custom headers, SSE accept. */
const upstreamHeaders = (
  context: ExecutionContext,
  options: ExecutorOptions,
  providerKey: string,
  stream: boolean,
  jsonContentType: boolean,
) => {
  const base = {
    ...(jsonContentType ? { "content-type": "application/json" } : {}),
    ...(providerKey !== "" ? { authorization: `Bearer ${providerKey}` } : {}),
    "user-agent": USER_AGENT,
  };

  applyCustomHeaders(base, context.credential, options.headers, options.metadata.sessionId);

  return stream ? { ...base, accept: "text/event-stream", "cache-control": "no-cache" } : base;
};

export interface OpenAICompatExecutorOptions {
  /** Translator registry (defaults to the built-in one). */
  readonly translators?: TranslatorRegistry;
}

/** Creates the executor for one OpenAI-compatible provider key (e.g. `openai-compatible-openrouter`). */
export const makeOpenAICompatExecutor = (
  provider: string,
  executorOptions: OpenAICompatExecutorOptions = {},
): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;
  const to = Formats.OpenAI;

  const prepare = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean,
  ) {
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const { baseURL, providerKey } = credentialEndpoint(context);

    if (baseURL === "")
      return yield* new ExecutionError({ status: 401, message: "missing provider baseURL" });
    // Go routes only the non-stream path of `responses/compact` to `/responses/compact` (the handler never streams it).
    const compact = options.alt === "responses/compact" && !stream;
    const to = compact ? Formats.OpenAIResponse : Formats.OpenAI;

    const from = options.sourceFormat;

    const rewrite = {
      headers: options.headers,
      config: context.config,
      isCompat: modelIsCompat(request),
    };

    const original = translateRequestForExecutor(
      registry,
      from,
      to,
      { format: from, model: baseModel, stream, body: options.originalRequest ?? request.payload },
      thinking.summary,
      rewrite,
    );

    const translated = translateRequestForExecutor(
      registry,
      from,
      to,
      { format: from, model: baseModel, stream, body: request.payload },
      thinking.summary,
      rewrite,
    );

    if (translated.error !== undefined) {
      return yield* new ExecutionError({
        status: translated.error.status,
        message: translated.error.message,
        requestScoped: true,
      });
    }

    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider,
      source: request.payload,
      ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });

    const requestedModel =
      options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model;

    const group = resolveCompatConfig(context.config, context.credential);

    if (shouldNormalizeToolResults(group, baseModel, requestedModel))
      body = normalizeToolResultsTextOnly(body);

    if (!compact) {
      body = normalizeOpenAIMaxTokens(
        body,
        shouldUseMaxCompletionTokens(group, baseModel, requestedModel),
      );
      body = applyPromptCacheKey(provider, context, request, options, baseModel, body);
    } else {
      body = sanitizeReasoningEncryptedContent(del(body, "stream"));
    }

    if (stream) {
      // Ask for usage in the final chunk so token statistics are captured.
      body = setBoolIfDifferent(body, "stream_options.include_usage", true);
    }

    const effort = get(body, "reasoning_effort");
    context.usage.setReasoningEffort(typeof effort === "string" ? effort : undefined);

    // User payload rules: the final semantic mutation of the business payload (AGENTS.md).
    body = finalizePayload(
      context.config,
      provider,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: original.body,
      },
      body,
    );

    const headers = upstreamHeaders(context, options, providerKey, stream, true);

    const url =
      (baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL) +
      (compact ? RESPONSES_COMPACT_PATH : CHAT_COMPLETIONS_PATH);

    return { url, headers, body, baseModel, to } satisfies PreparedRequest;
  });

  /** Images API request (`executeImages` / `executeImagesStream` preparation). */
  const prepareImages = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean,
  ) {
    const baseModel = parseSuffix(request.model).modelName;
    const { baseURL, providerKey } = credentialEndpoint(context);

    if (baseURL === "")
      return yield* new ExecutionError({ status: 401, message: "missing provider baseURL" });
    const endpoint = compatImageEndpointPath(options.metadata.requestPath);

    const requestedModel =
      options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model;

    const from = options.sourceFormat;

    const original = prepareCompatImagesBody(
      options.originalRequest ?? request.payload,
      baseModel,
      stream,
    );

    let body: Json = prepareCompatImagesBody(request.payload, baseModel, stream);
    const effort = get(body, "reasoning_effort");
    context.usage.setReasoningEffort(typeof effort === "string" ? effort : undefined);
    // User payload rules stay the final mutation of the business payload; a multipart upload is rebuilt afterwards.
    body = finalizePayload(
      context.config,
      provider,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original,
      },
      body,
    );
    const multipart = wantsMultipartEdit(endpoint, options.headers.get("content-type") ?? "");
    const headers = upstreamHeaders(context, options, providerKey, stream, !multipart);

    const url = (baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL) + endpoint;

    const form =
      multipart && isJsonObject(body) ? editBodyToFormData(body, baseModel, stream) : undefined;

    return {
      url,
      headers,
      body,
      baseModel,
      to,
      ...(form === undefined ? {} : { form }),
    } satisfies PreparedRequest;
  });

  /** Sends the request; non-2xx answers become `ExecutionError`s carrying the upstream body. */
  const send = Effect.fnUntraced(function* (
    context: ExecutionContext,
    prepared: PreparedRequest,
    // Chat streams take the effective TTFT from the first token frame (`observeTokenEvent`); an early role or empty
    // frame is only the first-packet fallback.
    ttft: "first-byte" | "token-event" = "first-byte",
  ) {
    const client = yield* HttpClient.HttpClient;

    const request = HttpClientRequest.post(prepared.url).pipe(
      prepared.form === undefined
        ? HttpClientRequest.bodyText(JSON.stringify(prepared.body), "application/json")
        : HttpClientRequest.bodyFormData(prepared.form),
      HttpClientRequest.setHeaders(prepared.headers),
    );

    const response: HttpClientResponse.HttpClientResponse = yield* client
      .execute(request)
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(transportError),
      );

    if (ttft === "token-event") context.usage.recordFirstPacket(yield* Clock.currentTimeMillis);
    else context.usage.markFirstByte(yield* Clock.currentTimeMillis);

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      const webHeaders = new Headers(response.headers);

      const retryAfterMs = openAICompatRetryAfterMs(
        response.status,
        webHeaders,
        text,
        yield* Clock.currentTimeMillis,
      );

      context.usage.fail(response.status, text);

      return yield* new ExecutionError({
        status: response.status,
        message: text,
        headers: headersRecord(webHeaders),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    return response;
  });

  /** `executeImages`: the upstream Images API answer is returned unchanged. */
  const executeImages = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepareImages(context, request, options, false);
    const response = yield* send(context, prepared);
    const text = yield* response.text.pipe(Effect.mapError(transportError));
    context.usage.observeResponseModel(responseModelOf(tryParseJson(text)));
    context.usage.publish(parseOpenAIUsage(text));

    return { payload: text, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  /** `executeImagesStream`: upstream SSE bytes are forwarded as they arrive. */
  const executeImagesStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepareImages(context, request, options, true);
    const response = yield* send(context, prepared);

    const chunks = response.stream.pipe(
      Stream.decodeText,
      Stream.mapError(transportError),
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    if (options.sourceFormat === EntryOnlyFormats.OpenAIImage)
      return yield* executeImages(context, request, options);
    const prepared = yield* prepare(context, request, options, options.stream);
    const response = yield* send(context, prepared);
    const text = yield* response.text.pipe(Effect.mapError(transportError));
    context.usage.observeResponseModel(responseModelOf(tryParseJson(text)));

    const out = registry.translateNonStream(
      responseFormatOf(options),
      prepared.to,
      responseContext(request, options, prepared.body),
      text,
    );

    if (out === undefined || out === "") {
      return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });
    }

    context.usage.publish(parseOpenAIUsage(text));

    const payload =
      responseFormatOf(options) === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out;

    return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    if (options.sourceFormat === EntryOnlyFormats.OpenAIImage)
      return yield* executeImagesStream(context, request, options);
    const prepared = yield* prepare(context, request, options, true);
    const response = yield* send(context, prepared, "token-event");
    // The reader is synchronous, so frames are timed with the fiber's Clock service (TestClock in tests).
    const clock = yield* Clock.Clock;

    const reader = new OpenAICompatStreamReader({
      registry,
      responseFormat: responseFormatOf(options),
      providerFormat: to,
      context: responseContext(request, options, prepared.body),
      onFrame: (payload) => {
        if (!context.usage.ttftObserved)
          context.usage.observeTokenEvent(
            clock.currentTimeMillisUnsafe(),
            isChatTokenEvent(payload),
          );
      },
    });

    const observe = (line: string) => {
      const usage = parseOpenAIStreamUsage(line);

      if (usage !== undefined) context.usage.publish(usage);
      context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)));
    };

    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccum(
        () => reader,
        (state, line: string) => {
          observe(line);

          return [state, [state.push(line)]] as const;
        },
        { onHalt: (state) => [state.end()] },
      ),
      Stream.takeUntil((step) => step.stop),
      Stream.flatMap((step) => {
        const emitted = Stream.fromIterable(step.chunks);

        if (step.error === undefined) return emitted;
        const error = step.error;
        context.usage.fail(
          error.status,
          step.payloadError === true ? "upstream stream returned an error payload" : error.message,
        );

        return Stream.concat(emitted, Stream.fail(error));
      }),
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  /**
   * `CountTokens`: translate to Chat Completions, thinking and payload rules (no max-token or cache-key shaping, no
   * credential needed), then count locally with the model's BPE encoding.
   */
  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const responseFormat = responseFormatOf(options);

    const rewrite = {
      headers: options.headers,
      config: context.config,
      isCompat: modelIsCompat(request),
    };

    const translate = (payload: Json) =>
      translateRequestForExecutor(
        registry,
        from,
        to,
        { format: from, model: baseModel, stream: false, body: payload },
        thinking.summary,
        rewrite,
      );

    const translated = translate(request.payload);

    if (translated.error !== undefined) {
      return yield* new ExecutionError({
        status: translated.error.status,
        message: translated.error.message,
        requestScoped: true,
      });
    }

    const original =
      options.originalRequest === undefined ? translated : translate(options.originalRequest);

    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider,
      source: request.payload,
      ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });

    body = finalizePayload(
      context.config,
      provider,
      {
        model: baseModel,
        requestedModel:
          options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: original.body,
      },
      body,
    );
    const count = countOpenAIChatTokens(getCodec(encodingForModel(baseModel)), body);

    return {
      payload: registry.translateTokenCount(responseFormat, to, count, buildOpenAIUsageJson(count)),
      headers: new Headers(),
    } satisfies ExecutorResponse;
  });

  return { identifier: provider, execute, executeStream, countTokens };
};

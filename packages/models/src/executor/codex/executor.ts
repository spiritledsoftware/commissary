/**
 * Codex (ChatGPT backend Responses API) executor, HTTP/SSE transport.
 *
 * Go source: internal/runtime/executor/codex_executor.go, codex_executor_execute.go (Execute, executeCompact),
 * codex_executor_stream.go (ExecuteStream), codex_executor_request.go (cacheHelper), codex_openai_images.go.
 * Pipeline per attempt (ARCHITECTURE.md): translate -> model rewrite -> thinking -> provider shaping -> input id
 * sanitising -> user payload rules (final barrier) -> upstream fetch -> response translation.
 *
 * The WebSocket transport (downstream WebSocket + `websockets` credential) lives in `websocket.ts` and shares `prepare`.
 *
 * Multi-agent v2 (`helps/codex-multi-agent-v2.ts`) and `is-compat` models (`helps/translate.ts`) are handled in `prepare`.
 * Stream bootstrap buffering is `stream.ts` + `bootstrap.ts`. `CountTokens` counts locally
 * (`helps/token-count.ts`).
 */
import { Clock, Effect, Semaphore, Stream } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { splitLines } from "@commissary/translation/sse";
import {
  asString,
  cloneJson,
  del,
  get,
  isJsonObject,
  type Json,
  set,
  tryParseJson,
} from "@commissary/json";
import {
  builtinTranslators,
  makeTranslationState,
  type ResponseContext,
  type TranslatorRegistry,
} from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import { encodingForCodexModel, getCodec } from "@commissary/translation/tokenizer";
import { parseOpenAIUsage, responseModelOf } from "../../usage/record.ts";
import { isResponsesTokenEvent } from "../../usage/ttft.ts";
import { ExecutionError, headersRecord } from "../errors.ts";
import {
  optimizeCodexMultiAgentV2RequestForAuth,
  restoreCodexMultiAgentV2Response,
} from "../helps/codex-multi-agent-v2.ts";
import { normalizeCodexToolSchemas } from "../helps/codex-tool-schema.ts";
import { sanitizeCodexInputItemIds } from "../helps/codex-input-ids.ts";
import {
  compactionStreamFromResponse,
  executeLocalCompaction,
  expandCompaction,
  hasResponsesCompactionTriggerRequest,
  rejectSyntheticPreviousResponseId,
} from "../helps/compaction.ts";
import { finalizePayload } from "../helps/payload.ts";
import { translateRequestForExecutor } from "../helps/translate.ts";
import { buildResponsesUsageJson, countCodexInputTokens } from "../helps/token-count.ts";
import { TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import { Thinking } from "../thinking.ts";
import { codexSessionStore, replayRequiredError } from "../websocket/session.ts";
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
  codexEmptyIncompleteStreamError,
  codexIncompleteStreamError,
  codexTerminalFailure,
  isThinkingSignatureInvalid,
  newCodexStatusError,
} from "./errors.ts";
import {
  buildCodexHeaders,
  buildCodexWebsocketHeaders,
  codexBaseUrl,
  codexUsesProviderKey,
  isNativeCodexRequest,
} from "./headers.ts";
import {
  type AutoInjection,
  injectionBaseline,
  type LiteRouteInput,
  recordAutoInjection,
  retractAutoInjectedImageGeneration,
  stripHostedImageComplexity,
  validateHostedImageGeneration,
} from "./hosted-images.ts";
import {
  buildImagesApiResponse,
  CODEX_IMAGE_SOURCE_FORMAT,
  CODEX_IMAGES_MAIN_MODEL,
  directImageEndpoint,
  directImageModel,
  extractImageResults,
  finishImageResponsesBody,
  imageCompletedFrame,
  imagePartialFrame,
  isCodexImageRequest,
  prepareDirectImageBody,
  prepareImageRequest,
} from "./images.ts";
import {
  ensureResponsesUsageDetails,
  hasMeaningfulOutputDelta,
  isTerminalEmptyIncomplete,
  OutputItemCollector,
  parseCodexUsage,
  publishCodexImageToolUsage,
  patchCodexCompletedOutput,
} from "./output.ts";
import {
  ensureImageGenerationTool,
  normalizeCodexInstructions,
  normalizeCodexOutputBudget,
  normalizeParallelToolCalls,
  promptCacheId,
  sanitizeReasoningEncryptedContent,
  setIfDifferent,
} from "./request.ts";
import {
  applyReplayCache,
  cacheReplayFromCompleted,
  type CodexReplayScope,
  type CodexReplayStore,
  defaultReplayStore,
  replayScopeFromRequest,
} from "./replay.ts";
import { modelOverrideHeaders } from "../helps/model-headers.ts";
import { configuredUpstreamNames, resolveCodexModelIsCompat } from "./compat.ts";
import { bootstrapTimeoutMs, isGrokClientHeaders } from "./bootstrap.ts";
import { CodexStreamReader } from "./stream.ts";
import {
  codexWebsocketsEnabled,
  makeCodexWebsocketExecute,
  makeCodexWebsocketStream,
} from "./websocket.ts";

export const CODEX_PROVIDER = "codex";

export interface CodexExecutorOptions {
  readonly translators?: TranslatorRegistry;
  /** Reasoning replay store (defaults to the per-isolate in-memory store, see replay.ts). */
  readonly replayStore?: CodexReplayStore;
  /** models.json `config.override_header` lookup (model registry), applied after every other header. */
  readonly modelHeaderOverrides?: (model: string) => Readonly<Record<string, string>> | undefined;
}

/** `fetch` failures carry no HTTP answer: the conductor treats them as transient transport errors (no cooldown). */
const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

export interface PreparedRequest {
  readonly url: string;
  /** Upstream request headers; for a WebSocket turn the handshake headers. */
  readonly headers: Record<string, string>;
  /** Final business payload (after payload rules). */
  readonly body: Json;
  readonly baseModel: string;
  /** Translated request before provider shaping that depends on the cache id (translator response context). */
  readonly translated: Json;
  readonly original: Json | undefined;
  readonly replayScope: CodexReplayScope;
  readonly responseFormat: string;
  readonly providerFormat: string;
  /** Prompt cache id (`session_id` header), `""` when none could be derived. */
  readonly cacheId: string;
  /** Native Codex client: the upstream output is forwarded untouched. */
  readonly nativeOutput: boolean;
  /** The collaboration namespace was renamed for the upstream: restore it in the answer. */
  readonly multiAgentV2: boolean;
}

export const makeCodexExecutor = (executorOptions: CodexExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;

  /** `applyModelHeaderOverrides`: the injected hook, else models.json `override_header` from the attempt's registry snapshot. */
  const overrides = (request: ExecutorRequest, model: string) =>
    executorOptions.modelHeaderOverrides?.(model) ??
    modelOverrideHeaders(request.modelLookup, model);

  const overrideField = (request: ExecutorRequest, model: string) => {
    const modelHeaderOverrides = overrides(request, model);

    return modelHeaderOverrides !== undefined ? { modelHeaderOverrides } : {};
  };

  /** The inputs beyond the body that decide Responses-Lite routing. */
  const liteRoute = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ): LiteRouteInput => ({
    credential: context.credential,
    headers: options.headers,
    sessionId: options.metadata.sessionId,
    overrideHeaders: overrides(request, parseSuffix(request.model).modelName),
  });

  const replayStore = executorOptions.replayStore ?? defaultReplayStore;

  const translatePair = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    to: string,
    baseModel: string,
    stream: boolean,
    summary: import("@commissary/translation").SummaryHooks,
  ) => {
    const from = options.sourceFormat;

    const rewrite = {
      headers: options.headers,
      config: context.config,
      isCompat: resolveCodexModelIsCompat(context.config, context.credential, request, baseModel),
    };

    const translated = translateRequestForExecutor(
      registry,
      from,
      to,
      { format: from, model: baseModel, stream, body: request.payload },
      summary,
      rewrite,
    );

    if (translated.error !== undefined) {
      return new ExecutionError({
        status: translated.error.status,
        message: translated.error.message,
        requestScoped: true,
      });
    }

    // The payload-rule baseline: the client payload translated without any later mutation.
    const sameSource =
      options.originalRequest === undefined || options.originalRequest === request.payload;

    const original = sameSource
      ? { ...translated, body: cloneJson(translated.body) }
      : translateRequestForExecutor(
          registry,
          from,
          to,
          { format: from, model: baseModel, stream, body: options.originalRequest },
          summary,
          rewrite,
        );

    return { translated, original };
  };

  const finalize = (
    context: ExecutionContext,
    options: ExecutorOptions,
    baseModel: string,
    requestModel: string,
    protocol: string,
    original: Json | undefined,
    body: Json,
  ): Json =>
    finalizePayload(
      context.config,
      CODEX_PROVIDER,
      {
        model: baseModel,
        requestedModel:
          options.metadata.requestedModel !== "" ? options.metadata.requestedModel : requestModel,
        protocol,
        fromProtocol: options.sourceFormat,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        ...(original !== undefined ? { original } : {}),
      },
      body,
    );

  /**
   * `expandCodexResponsesCompaction`: the capsules a local compaction minted (here or on another route) become developer
   * context before the request goes upstream; a corrupt one is a request-scoped 400. A native model forwards the other
   * `compaction` items, OpenAI's own, untouched; an `is-compat` model cannot read them and drops them
   * (`/responses/compact` goes to the operator's endpoint and keeps them).
   */
  const expandCodexCompaction = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) =>
    expandCompaction(
      request,
      options,
      resolveCodexModelIsCompat(
        context.config,
        context.credential,
        request,
        parseSuffix(request.model).modelName,
      ) &&
        options.sourceFormat === Formats.OpenAIResponse &&
        options.alt !== "responses/compact"
        ? "drop-foreign"
        : "recognized-only",
    );

  /** Responses requests (`/responses`) and compaction (`/responses/compact`, target `openai-response`). */
  const prepare = Effect.fnUntraced(function* (
    context: ExecutionContext,
    requested: ExecutorRequest,
    requestedOptions: ExecutorOptions,
    mode: {
      readonly stream: boolean;
      readonly compact: boolean;
      readonly websocket?: boolean;
      /** The summary turn of a local compaction: no hosted tool is injected for it. */
      readonly summary?: boolean;
    },
  ) {
    const { request, options } = yield* expandCodexCompaction(context, requested, requestedOptions);

    // A response a local compaction minted lives in no upstream (a 400 over HTTP, the 409 frame on a WebSocket).
    const synthetic = mode.compact
      ? undefined
      : rejectSyntheticPreviousResponseId(request.payload, options);

    if (synthetic !== undefined) return yield* synthetic;
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const to = mode.compact ? Formats.OpenAIResponse : Formats.Codex;
    const responseFormat = responseFormatOf(options);

    const pair = translatePair(
      context,
      request,
      options,
      to,
      baseModel,
      mode.stream,
      thinking.summary,
    );

    if (pair instanceof ExecutionError) return yield* pair;
    const { translated, original } = pair;

    const nativeOutput = isNativeCodexRequest(
      request.payload,
      options.headers,
      from,
      responseFormat,
    );

    const isCompat = resolveCodexModelIsCompat(
      context.config,
      context.credential,
      request,
      baseModel,
    );

    let body = yield* thinking.apply({
      // The compaction endpoint is not Codex's /responses and has no floor (Go skips it too).
      body: mode.compact ? translated.body : normalizeCodexOutputBudget(translated.body),
      model: request.model,
      from,
      to,
      provider: CODEX_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });

    body = setIfDifferent(body, "model", baseModel);

    if (mode.compact) {
      body = del(body, "stream");
    } else {
      body = setIfDifferent(body, "stream", true);

      if (mode.websocket === true) {
        // The WebSocket protocol continues a response with `previous_response_id` and honours `generate: false`.
        for (const field of ["prompt_cache_retention", "safety_identifier"])
          body = del(body, field);
      } else {
        const summaryDelivery = get(body, "stream_options.reasoning_summary_delivery");

        for (const field of [
          "previous_response_id",
          "generate",
          "prompt_cache_retention",
          "safety_identifier",
          "stream_options",
        ]) {
          body = del(body, field);
        }

        if (mode.stream && summaryDelivery !== undefined)
          body = set(body, "stream_options.reasoning_summary_delivery", summaryDelivery);
      }
    }

    body = normalizeCodexInstructions(body, nativeOutput);

    let autoInjection: AutoInjection | undefined;

    // A summary asks for text: no hosted tool is injected into it (Go `isCompactionSummary`, 61f1ad5e). A hosted tool
    // injected after `ensureImageGenerationTool` must skip it too.
    if (
      !mode.compact &&
      mode.summary !== true &&
      context.config.multimedia["disable-image-generation"] === false
    ) {
      const baseline = injectionBaseline(body);

      body = ensureImageGenerationTool(body, request.model, liteRoute(context, request, options));
      autoInjection = recordAutoInjection(baseline, body);

      if (!codexUsesProviderKey(context.credential)) body = stripHostedImageComplexity(body);
    }

    body = sanitizeReasoningEncryptedContent(body, isCompat, isCompat);
    body = normalizeParallelToolCalls(body, options.headers);
    body = normalizeCodexToolSchemas(body);

    const multiAgent = optimizeCodexMultiAgentV2RequestForAuth(
      options.headers,
      body,
      context.config,
      isCompat,
    );

    body = multiAgent.payload;

    const replayScope = mode.compact
      ? { modelName: "", sessionKey: "", requestFingerprint: "" }
      : replayScopeFromRequest({
          from,
          model: request.model,
          requestPayload: request.payload,
          headers: options.headers,
          callerScope: options.metadata.callerScope,
          body,
        });

    if (!mode.compact) yield* applyReplayCache(replayStore, replayScope, body);

    const translatedForResponse = cloneJson(body);

    // cacheHelper: prompt cache key, input id sanitising, then the payload rules as the last mutation.
    const cacheId = promptCacheId({
      from,
      model: request.model,
      payload: request.payload,
      body,
      headers: options.headers,
      callerScope: options.metadata.callerScope,
      sessionId: options.metadata.sessionId,
    });

    if (cacheId !== "") body = setIfDifferent(body, "prompt_cache_key", cacheId);
    body = sanitizeCodexInputItemIds(body);
    body = finalize(context, options, baseModel, request.model, to, original.body, body);
    body = retractAutoInjectedImageGeneration(
      body,
      autoInjection,
      request.model,
      liteRoute(context, request, options),
    );

    const effort = asString(get(body, "reasoning.effort"));
    context.usage.setReasoningEffort(effort !== "" ? effort : undefined);

    // The WebSocket transport dials with the handshake headers (no content type, beta header): built once here.
    const headers =
      mode.websocket === true
        ? buildCodexWebsocketHeaders({
            credential: context.credential,
            config: context.config,
            clientHeaders: options.headers,
            cacheId,
            nativeRequest: nativeOutput,
            body,
            baseModel,
            ...(options.metadata.sessionId !== undefined
              ? { sessionId: options.metadata.sessionId }
              : {}),
            ...overrideField(request, baseModel),
          })
        : buildCodexHeaders({
            credential: context.credential,
            config: context.config,
            clientHeaders: options.headers,
            stream: !mode.compact,
            ...(cacheId !== "" ? { sessionHeader: cacheId } : {}),
            body,
            baseModel,
            ...(options.metadata.sessionId !== undefined
              ? { sessionId: options.metadata.sessionId }
              : {}),
            routingHint: true,
            ...overrideField(request, baseModel),
          });

    // Go validates execute, stream and the WebSocket paths, not compaction.
    if (!mode.compact) {
      const hostedImageError = validateHostedImageGeneration({
        body,
        headers: new Headers(headers),
        passthrough: context.config.multimedia["disable-image-generation"] === "passthrough",
        nativeCodex: !codexUsesProviderKey(context.credential),
      });

      if (hostedImageError !== undefined) return yield* hostedImageError;
    }

    const url = `${codexBaseUrl(context.credential)}${mode.compact ? "/responses/compact" : "/responses"}`;

    return {
      url,
      headers,
      body,
      baseModel,
      translated: translatedForResponse,
      original: options.originalRequest ?? request.payload,
      replayScope,
      responseFormat,
      providerFormat: to,
      cacheId,
      nativeOutput,
      multiAgentV2: multiAgent.optimized,
    } satisfies PreparedRequest;
  });

  const websocketDeps = {
    prepare,
    replayStore,
    translateNonStream: (prepared: PreparedRequest, request: ExecutorRequest, completed: Json) => {
      const out = registry.translateNonStream(
        prepared.responseFormat,
        prepared.providerFormat,
        responseContext(prepared, request),
        JSON.stringify(completed),
      );

      return out === undefined ? "" : out;
    },
  };

  const websocketStream = makeCodexWebsocketStream(websocketDeps);
  const websocketExecute = makeCodexWebsocketExecute(websocketDeps);

  /** POSTs `body`; non-2xx answers become classified `ExecutionError`s (the replay cache is cleared when needed). */
  const send = Effect.fnUntraced(function* (
    context: ExecutionContext,
    url: string,
    headers: Record<string, string>,
    body: Json,
    replayScope?: CodexReplayScope,
    // Streams mark the effective TTFT on the first token event (usage `observeTokenEvent`), not on the headers.
    ttft: "first-byte" | "token-event" = "first-byte",
  ) {
    const client = yield* HttpClient.HttpClient;

    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
      HttpClientRequest.setHeaders(headers),
    );

    const response: HttpClientResponse.HttpClientResponse = yield* client
      .execute(httpRequest)
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(transportError),
      );

    if (ttft === "token-event") context.usage.recordFirstPacket(yield* Clock.currentTimeMillis);
    else context.usage.markFirstByte(yield* Clock.currentTimeMillis);

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));

      if (replayScope !== undefined && isThinkingSignatureInvalid(response.status, text)) {
        yield* replayStore.clear(replayScope.modelName, replayScope.sessionKey);
      }

      const error = newCodexStatusError(response.status, text, {
        modelLevelCooling: context.config.upstream.codex["model-level-cooling"],
        nowMs: yield* Clock.currentTimeMillis,
        headers: headersRecord(new Headers(response.headers)),
      });

      context.usage.fail(error.status, error.message);

      return yield* error;
    }

    return response;
  });

  const responseContext = (
    prepared: PreparedRequest,
    request: ExecutorRequest,
  ): ResponseContext => ({
    model: request.model,
    originalRequest: prepared.original,
    translatedRequest: prepared.translated,
    state: makeTranslationState(),
  });

  const failedTranslation = () =>
    new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });

  // -------------------------------------------------------------------------------------------------------------
  // Responses: non-stream (aggregates the upstream SSE until the terminal event)
  // -------------------------------------------------------------------------------------------------------------

  const executeResponses = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    summary = false,
  ) {
    const prepared = yield* prepare(context, request, options, {
      stream: false,
      compact: false,
      summary,
    });

    const response = yield* send(
      context,
      prepared.url,
      prepared.headers,
      prepared.body,
      prepared.replayScope,
    );

    const text = yield* response.text.pipe(Effect.mapError(transportError));
    const collector = new OutputItemCollector();
    let sawOutputDelta = false;
    const modelLevelCooling = context.config.upstream.codex["model-level-cooling"];

    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;

      const event = tryParseJson(
        restoreCodexMultiAgentV2Response(line.slice(5).trim(), prepared.multiAgentV2),
      );

      context.usage.observeResponseModel(responseModelOf(event));
      const eventType = asString(get(event, "type"));

      if (hasMeaningfulOutputDelta(event)) sawOutputDelta = true;

      const failure = codexTerminalFailure(event, {
        modelLevelCooling,
        nowMs: yield* Clock.currentTimeMillis,
      });

      if (failure !== undefined) {
        if (isThinkingSignatureInvalid(failure.error.status, failure.body)) {
          yield* replayStore.clear(prepared.replayScope.modelName, prepared.replayScope.sessionKey);
        }

        return yield* failure.error;
      }

      if (eventType === "response.output_item.done") {
        collector.collect(event);
        continue;
      }

      if (eventType !== "response.completed" && eventType !== "response.incomplete") continue;

      if (!isJsonObject(event)) continue;

      if (isTerminalEmptyIncomplete(event, collector.count, sawOutputDelta))
        return yield* codexEmptyIncompleteStreamError();
      const completed = cloneJson(event);

      if (isJsonObject(completed)) patchCodexCompletedOutput(completed, collector);

      if (eventType === "response.completed")
        yield* cacheReplayFromCompleted(replayStore, prepared.replayScope, completed);

      let out = registry.translateNonStream(
        prepared.responseFormat,
        prepared.providerFormat,
        responseContext(prepared, request),
        JSON.stringify(completed),
      );

      if (out === undefined || out === "") return yield* failedTranslation();
      const detail = parseCodexUsage(event);

      if (detail !== undefined) context.usage.publish(detail);
      publishCodexImageToolUsage(context.usage, prepared.body, event);

      if (prepared.responseFormat === Formats.OpenAIResponse)
        out = ensureResponsesUsageDetails(out);

      return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
    }

    const error = codexIncompleteStreamError();
    context.usage.fail(error.status, error.message);

    return yield* error;
  });

  const executeCompact = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepare(context, request, options, { stream: false, compact: true });
    const response = yield* send(context, prepared.url, prepared.headers, prepared.body);
    const text = yield* response.text.pipe(Effect.mapError(transportError));

    let out = registry.translateNonStream(
      prepared.responseFormat,
      prepared.providerFormat,
      responseContext(prepared, request),
      text,
    );

    if (out === undefined || out === "") return yield* failedTranslation();
    context.usage.publish(parseOpenAIUsage(text));

    if (prepared.responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out);

    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  // -------------------------------------------------------------------------------------------------------------
  // Responses: stream
  // -------------------------------------------------------------------------------------------------------------

  const executeResponsesStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepare(context, request, options, { stream: true, compact: false });

    const response = yield* send(
      context,
      prepared.url,
      prepared.headers,
      prepared.body,
      prepared.replayScope,
      "token-event",
    );

    const reader = new CodexStreamReader({
      registry,
      responseFormat: prepared.responseFormat,
      providerFormat: prepared.providerFormat,
      context: responseContext(prepared, request),
      usage: context.usage,
      requestBody: prepared.body,
      preserveNativeOutput: isNativeCodexRequest(
        request.payload,
        options.headers,
        options.sourceFormat,
        prepared.responseFormat,
      ),
      modelLevelCooling: context.config.upstream.codex["model-level-cooling"],
      nowMs: () => Date.now(),
      replayScope: prepared.replayScope,
      multiAgentV2: prepared.multiAgentV2,
      ...(context.config.upstream.codex["stream-bootstrap-buffering"]
        ? {
            bootstrap: {
              timeoutMs: bootstrapTimeoutMs(
                context.config.upstream.codex["stream-bootstrap-timeout"],
              ),
            },
          }
        : {}),
      grokClient: isGrokClientHeaders(options.headers),
    });

    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccumEffect(
        () => reader,
        (state, line: string) =>
          Effect.gen(function* () {
            const step = state.push(line);

            if (step.cacheCompleted !== undefined)
              yield* cacheReplayFromCompleted(
                replayStore,
                prepared.replayScope,
                step.cacheCompleted,
              );

            if (
              step.failureBody !== undefined &&
              isThinkingSignatureInvalid(step.failureBody.status, step.failureBody.body)
            ) {
              yield* replayStore.clear(
                prepared.replayScope.modelName,
                prepared.replayScope.sessionKey,
              );
            }

            return [state, [step]] as const;
          }),
        { onHalt: (state) => [state.end()] },
      ),
      Stream.takeUntil((step) => step.stop),
      Stream.flatMap((step) => {
        const emitted = Stream.fromIterable(step.chunks.filter((chunk) => chunk.length > 0));

        return step.error === undefined ? emitted : Stream.concat(emitted, Stream.fail(step.error));
      }),
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  // -------------------------------------------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------------------------------------------

  const imagePlan = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => {
    const requestPath = options.metadata.requestPath;

    const endpoint = directImageEndpoint(
      request.payload,
      request.model,
      requestPath,
      options.metadata.requestedModel,
    );

    return { requestPath, endpoint };
  };

  const configuredImageMainModel = (context: ExecutionContext): string => {
    const model = context.config.multimedia["gpt-image-2-base-model"].trim();

    return model !== "" && model.toLowerCase().startsWith("gpt-") ? model : CODEX_IMAGES_MAIN_MODEL;
  };

  const prepareDirectImage = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    endpoint: string,
    stream: boolean,
  ) => {
    const model = directImageModel(
      request.payload,
      request.model,
      options.metadata.requestedModel,
      configuredUpstreamNames(context.config, context.credential),
    );

    let body = prepareDirectImageBody(request.payload, model, stream);
    body = finalize(
      context,
      { ...options, sourceFormat: CODEX_IMAGE_SOURCE_FORMAT },
      model,
      request.model,
      "openai",
      request.payload,
      body,
    );

    const headers = buildCodexHeaders({
      credential: context.credential,
      config: context.config,
      clientHeaders: options.headers,
      stream,
      body,
      baseModel: model,
      omitClientUserAgent: true,
      ...(options.metadata.sessionId !== undefined
        ? { sessionId: options.metadata.sessionId }
        : {}),
      ...overrideField(request, model),
    });

    return { url: `${codexBaseUrl(context.credential)}${endpoint}`, headers, body, model };
  };

  const prepareToolImage = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const thinking = yield* Thinking;

    const prepared = prepareImageRequest(
      request.payload,
      request.model,
      options.metadata.requestPath,
    );

    if (typeof prepared === "string") {
      return yield* new ExecutionError({ status: 400, message: prepared, requestScoped: true });
    }

    const mainModel = configuredImageMainModel(context);
    const source = cloneJson(prepared.body);

    let body = yield* thinking.apply({
      body: prepared.body,
      model: mainModel,
      from: CODEX_IMAGE_SOURCE_FORMAT,
      to: Formats.Codex,
      provider: CODEX_PROVIDER,
      source,
    });

    body = finishImageResponsesBody(body, mainModel);

    const cacheId = promptCacheId({
      from: CODEX_IMAGE_SOURCE_FORMAT,
      model: request.model,
      payload: request.payload,
      body,
      headers: options.headers,
      callerScope: options.metadata.callerScope,
      sessionId: options.metadata.sessionId,
    });

    if (cacheId !== "") body = setIfDifferent(body, "prompt_cache_key", cacheId);
    body = sanitizeCodexInputItemIds(body);
    body = finalize(
      context,
      { ...options, sourceFormat: CODEX_IMAGE_SOURCE_FORMAT },
      mainModel,
      request.model,
      Formats.Codex,
      source,
      body,
    );

    const headers = buildCodexHeaders({
      credential: context.credential,
      config: context.config,
      clientHeaders: options.headers,
      stream: true,
      ...(cacheId !== "" ? { sessionHeader: cacheId } : {}),
      body,
      baseModel: mainModel,
      ...(options.metadata.sessionId !== undefined
        ? { sessionId: options.metadata.sessionId }
        : {}),
      ...overrideField(request, mainModel),
    });

    return { url: `${codexBaseUrl(context.credential)}/responses`, headers, body, image: prepared };
  });

  const executeImage = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const { endpoint } = imagePlan(context, request, options);

    if (endpoint !== "") {
      const direct = prepareDirectImage(context, request, options, endpoint, false);
      const response = yield* send(context, direct.url, direct.headers, direct.body);
      const text = yield* response.text.pipe(Effect.mapError(transportError));
      context.usage.publish(parseOpenAIUsage(text));

      return { payload: text, headers: new Headers(response.headers) } satisfies ExecutorResponse;
    }

    const tool = yield* prepareToolImage(context, request, options);
    const response = yield* send(context, tool.url, tool.headers, tool.body);
    const text = yield* response.text.pipe(Effect.mapError(transportError));
    const collector = new OutputItemCollector();

    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const event = tryParseJson(line.slice(5).trim());
      context.usage.observeResponseModel(responseModelOf(event));
      const eventType = asString(get(event, "type"));

      if (eventType === "response.output_item.done") collector.collect(event);
      else if (eventType === "response.completed" && event !== undefined) {
        const detail = parseCodexUsage(event);

        if (detail !== undefined) context.usage.publish(detail);
        publishCodexImageToolUsage(context.usage, tool.body, event);

        const extracted = extractImageResults(
          event,
          collector,
          Math.floor((yield* Clock.currentTimeMillis) / 1000),
        );

        if (extracted.results.length === 0) {
          return yield* new ExecutionError({
            status: 502,
            message: "upstream did not return image output",
          });
        }

        return {
          payload: buildImagesApiResponse(extracted, tool.image.responseFormat),
          headers: new Headers(response.headers),
        } satisfies ExecutorResponse;
      }
    }

    return yield* new ExecutionError({
      status: 504,
      message: "stream error: stream disconnected before completion",
    });
  });

  const executeImageStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const { endpoint } = imagePlan(context, request, options);

    if (endpoint !== "") {
      const direct = prepareDirectImage(context, request, options, endpoint, true);

      const response = yield* send(
        context,
        direct.url,
        direct.headers,
        direct.body,
        undefined,
        "token-event",
      );

      const chunks = response.stream.pipe(Stream.decodeText, Stream.mapError(transportError));

      return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
    }

    const tool = yield* prepareToolImage(context, request, options);

    const response = yield* send(
      context,
      tool.url,
      tool.headers,
      tool.body,
      undefined,
      "token-event",
    );

    const collector = new OutputItemCollector();

    const emptyChunks = (): string[] => [];

    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccumEffect(
        () => false,
        (done, line: string) =>
          Effect.gen(function* () {
            if (done || !line.startsWith("data:")) return [done, emptyChunks()] as const;
            const event = tryParseJson(line.slice(5).trim());
            context.usage.observeResponseModel(responseModelOf(event));

            if (!context.usage.ttftObserved) {
              context.usage.observeTokenEvent(
                yield* Clock.currentTimeMillis,
                isResponsesTokenEvent(line),
              );
            }

            switch (asString(get(event, "type"))) {
              case "response.output_item.done":
                collector.collect(event);
                break;
              case "response.image_generation_call.partial_image": {
                if (event === undefined) break;

                const frame = imagePartialFrame(
                  event,
                  tool.image.responseFormat,
                  tool.image.streamPrefix,
                );

                return [done, frame === undefined ? [] : [frame]] as const;
              }

              case "response.completed": {
                if (event === undefined) break;
                const detail = parseCodexUsage(event);

                if (detail !== undefined) context.usage.publish(detail);
                publishCodexImageToolUsage(context.usage, tool.body, event);

                const extracted = extractImageResults(
                  event,
                  collector,
                  Math.floor((yield* Clock.currentTimeMillis) / 1000),
                );

                if (extracted.results.length === 0) {
                  return yield* new ExecutionError({
                    status: 502,
                    message: "upstream did not return image output",
                  });
                }

                return [
                  true,
                  extracted.results.map((image) =>
                    imageCompletedFrame(
                      image,
                      extracted.usage,
                      tool.image.responseFormat,
                      tool.image.streamPrefix,
                    ),
                  ),
                ] as const;
              }
            }

            return [done, emptyChunks()] as const;
          }),
      ),
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  // -------------------------------------------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------------------------------------------

  /**
   * `shouldCompactCompatResponsesTrigger`: a `compaction_trigger` for a model the operator marked `is-compat` is compacted
   * locally (its endpoint has no native compaction); `/responses/compact` still goes to the endpoint.
   */
  const compactsLocally = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ): boolean =>
    options.sourceFormat === Formats.OpenAIResponse &&
    options.alt !== "responses/compact" &&
    hasResponsesCompactionTriggerRequest(request, options) &&
    resolveCodexModelIsCompat(
      context.config,
      context.credential,
      request,
      parseSuffix(request.model).modelName,
    );

  /**
   * `executeCodexResponsesCompaction`: the summary is one HTTP `executeResponses` (never the upstream socket, even for a
   * downstream WebSocket, and without the image tool), sealed into a capsule. The session's upstream socket is
   * invalidated afterwards: the conversation continues from the capsule on a socket dialled for it.
   */
  const executeLocalCompact = Effect.fnUntraced(function* (
    context: ExecutionContext,
    requested: ExecutorRequest,
    requestedOptions: ExecutorOptions,
  ) {
    const { request, options } = yield* expandCodexCompaction(context, requested, requestedOptions);

    const sealed = yield* executeLocalCompaction({
      request,
      options,
      summaryTurn: (summaryRequest, summaryOptions) =>
        executeResponses(context, summaryRequest, summaryOptions, true),
    });

    const sessionId = options.metadata.websocket?.sessionId;
    const session = sessionId === undefined ? undefined : codexSessionStore.peek(sessionId);

    if (session !== undefined)
      yield* Semaphore.withPermits(session.lock, 1)(codexSessionStore.invalidate(session));

    return sealed;
  });

  const execute: ProviderExecutor["execute"] = (context, request, options) => {
    if (options.alt === "responses/compact") return executeCompact(context, request, options);

    if (isCodexImageRequest(options.sourceFormat, options.metadata.requestPath))
      return executeImage(context, request, options);

    if (compactsLocally(context, request, options))
      return executeLocalCompact(context, request, options);
    const websocket = options.metadata.websocket;

    if (websocket !== undefined) {
      // CodexAutoExecutor: WebSocket only for a downstream WebSocket and a credential that enables it.
      if (codexWebsocketsEnabled(context.credential))
        return websocketExecute(context, request, options);

      if (websocket.requireUpstream) return Effect.fail(replayRequiredError());
    }

    return executeResponses(context, request, options);
  };

  const executeStream: ProviderExecutor["executeStream"] = (context, request, options) => {
    if (options.alt === "responses/compact") {
      return Effect.fail(
        new ExecutionError({
          status: 400,
          message: "streaming not supported for /responses/compact",
        }),
      );
    }

    if (isCodexImageRequest(options.sourceFormat, options.metadata.requestPath)) {
      return executeImageStream(context, request, options);
    }

    if (compactsLocally(context, request, options)) {
      return executeLocalCompact(context, request, options).pipe(
        Effect.flatMap((sealed) =>
          compactionStreamFromResponse(parseSuffix(request.model).modelName, sealed, Date.now()),
        ),
      );
    }

    const websocket = options.metadata.websocket;

    if (websocket !== undefined) {
      // CodexAutoExecutor: WebSocket only for a downstream WebSocket and a credential that enables it.
      if (codexWebsocketsEnabled(context.credential))
        return websocketStream(context, request, options);

      if (websocket.requireUpstream) return Effect.fail(replayRequiredError());
    }

    return executeResponsesStream(context, request, options);
  };

  /**
   * `CountTokens`: the request is shaped like `prepare` up to the payload rules (no replay, cache key, image tool or
   * schema normalisation), then counted locally with the model's BPE encoding.
   */
  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    requested: ExecutorRequest,
    requestedOptions: ExecutorOptions,
  ) {
    const { request, options } = yield* expandCodexCompaction(context, requested, requestedOptions);
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const to = Formats.Codex;
    const responseFormat = responseFormatOf(options);
    const pair = translatePair(context, request, options, to, baseModel, false, thinking.summary);

    if (pair instanceof ExecutionError) return yield* pair;
    const { translated, original } = pair;

    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider: CODEX_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });

    body = setIfDifferent(body, "model", baseModel);

    for (const field of [
      "previous_response_id",
      "generate",
      "prompt_cache_retention",
      "safety_identifier",
      "stream_options",
    ]) {
      body = del(body, field);
    }

    body = setIfDifferent(body, "stream", false);
    body = normalizeCodexInstructions(
      body,
      isNativeCodexRequest(request.payload, options.headers, from, responseFormat),
    );
    body = finalize(context, options, baseModel, request.model, to, original.body, body);

    const count = countCodexInputTokens(getCodec(encodingForCodexModel(baseModel)), body);

    return {
      payload: registry.translateTokenCount(
        responseFormat,
        to,
        count,
        buildResponsesUsageJson(count),
      ),
      headers: new Headers(),
    } satisfies ExecutorResponse;
  });

  return { identifier: CODEX_PROVIDER, execute, executeStream, countTokens };
};

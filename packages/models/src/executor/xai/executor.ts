/**
 * xAI (Grok) executor, HTTP/SSE transport.
 *
 * Go source: internal/runtime/executor/xai_executor.go, xai_executor_execute.go (Execute, executeCompact,
 * executeCompactionTriggerStream), xai_executor_stream.go (ExecuteStream), xai_executor_request.go
 * (prepareResponsesRequestTo, xaiResolveComposerSessionID), xai_executor_media.go / xai_executor_speech.go (see media.ts).
 * Pipeline per attempt: translate -> Thinking.apply -> model/stream fields -> tool normalisation -> reasoning replay ->
 * input normalisation -> prompt cache key -> finalizePayload (user payload rules, always last) -> headers -> fetch.
 *
 * The WebSocket transport (downstream WebSocket + `websockets` credential) lives in `websocket.ts` and shares `prepare`.
 *
 * Multi-agent v2 input rewriting is shared with Codex. The Codex `apply_patch` custom tool is bridged through the strict
 * `{"input": ...}` function (`helps/apply-patch-responses.ts`), including the folded namespace dispatcher.
 * `CountTokens` counts the prepared Responses body locally with `o200k_base`. 401 refresh/retry is done by the
 * conductor (`withCredentialRefresh`), not by the executor.
 */
import {
  APPLY_PATCH_UPSTREAM_ERROR_MESSAGE,
  ApplyPatchResponsesState,
  normalizeApplyPatchResponses,
} from "../helps/apply-patch-responses.ts";
import { rewriteCodexMultiAgentV2Input } from "../helps/codex-multi-agent-v2.ts";
import { modelIsCompat, translateRequestForExecutor } from "../helps/translate.ts";
import { Clock, Effect, Stream } from "effect";
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
import { getCodec } from "@commissary/translation/tokenizer";
import { parseOpenAIUsage, responseModelOf } from "../../usage/record.ts";
import { ExecutionError } from "../errors.ts";
import {
  ensureResponsesUsageDetails,
  OutputItemCollector,
  parseCodexUsage,
} from "../codex/output.ts";
import { codexWebsocketsEnabled } from "../codex/websocket.ts";
import { claudeCodeExecutionScope } from "../codex/replay.ts";
import { normalizeCodexInstructions, setIfDifferent } from "../codex/request.ts";
import { finalizePayload } from "../helps/payload.ts";
import { buildResponsesUsageJson, countXaiInputTokens } from "../helps/token-count.ts";
import { providerSessionUuid, uuidV5Oid } from "../helps/uuid.ts";
import { TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import { Thinking } from "../thinking.ts";
import { replayRequiredError } from "../websocket/session.ts";
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
  buildCompactionTriggerStreamChunks,
  compactionOutputItem,
  compactionResponseId,
} from "./compact.ts";
import { joinUrl, XAI_PROVIDER, xaiChatBaseUrl, xaiCompactBaseUrl } from "./credentials.ts";
import { xaiStatusError } from "./errors.ts";
import { buildXaiChatHeaders, buildXaiHeaders } from "./headers.ts";
import {
  normalizeImageRefs,
  normalizeInputCustomToolCalls,
  normalizeInputNamespaceToolCalls,
  normalizeInputReasoningItems,
  preserveOutputControls,
  sanitizeInputEncryptedContent,
} from "./input.ts";
import {
  executeImages,
  executeSpeech,
  executeVideos,
  type FinalizeBody,
  isImageRequest,
  isSpeechRequest,
  isVideoRequest,
  streamingUnsupported,
} from "./media.ts";
import {
  applyReplayCache,
  cacheReplayFromCompleted,
  clearReplayAfterCompaction,
  defaultXaiReplayStore,
  NO_REPLAY_SCOPE,
  replayScopeFromRequest,
  type XaiReplayScope,
  type XaiReplayStore,
} from "./replay.ts";
import { EventPipeline, normalizeReasoningSummaryEvent, patchCompletedOutput } from "./response.ts";
import { XaiStreamReader } from "./stream.ts";
import {
  aliasClientWebSearchFunction,
  aliasClientWebSearchInput,
  clampToolsLimit,
  ensureNativeXSearchTool,
  hasClientWebSearchFunction,
  normalizeForcedImageGenerationToolChoice,
  normalizeForcedWebSearchToolChoice,
  normalizeNamespaceToolChoice,
  normalizeToolChoiceForTools,
  pruneOrphanedToolChoice,
  resolveClientWebSearchAlias,
  toolChoiceRequiresHostedToolOnly,
} from "./tool-choice.ts";
import {
  collectClientDeclaredToolKeys,
  collectNamespaceToolRefs,
  inputHasItemType,
  normalizeTools,
  promoteAdditionalTools,
  removeInputItemsByType,
  requestHasNativeXSearch,
  totalFlattenedToolsCount,
  XAI_MAX_TOOLS,
} from "./tools.ts";
import { sendUpstream, transportError } from "./transport.ts";
import { currentXaiClientVersion } from "./version.ts";
import { XaiRequestIdMapper, xaiIdStates } from "./websocket-ids.ts";
import { makeXaiWebsocketStream } from "./websocket.ts";

export interface XaiExecutorOptions {
  readonly translators?: TranslatorRegistry;
  /** Reasoning replay store (defaults to the per-isolate in-memory store, see replay.ts). */
  readonly replayStore?: XaiReplayStore;
}

const COMPOSER_MODEL_PREFIX = "grok-composer-";

export interface PreparedRequest {
  /** Final business payload (after payload rules once `finalize` ran). */
  body: Json;
  readonly baseModel: string;
  readonly responseFormat: string;
  readonly providerFormat: string;
  /** The client's original body (translator response context). */
  readonly original: Json;
  readonly originalTranslated: Json;
  readonly pipeline: EventPipeline;
  /** Request-local apply_patch bridge (`xaiPreparedRequest.applyPatch`). */
  readonly applyPatch: ApplyPatchResponsesState;
  readonly sessionId: string;
  readonly replayScope: XaiReplayScope;
}

/** `helps.NewPayloadFinalizer`: user payload rules are the last mutation of the business payload. */
export const makeFinalize =
  (context: ExecutionContext, request: ExecutorRequest, options: ExecutorOptions) =>
  (model: string, protocol: string, original: Json | undefined, body: Json): Json =>
    finalizePayload(
      context.config,
      XAI_PROVIDER,
      {
        model,
        requestedModel:
          options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model,
        protocol,
        fromProtocol: options.sourceFormat,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        ...(original !== undefined ? { original } : {}),
      },
      body,
    );

/** `xaiResolveComposerSessionID`. */
const resolveSessionId = (
  request: ExecutorRequest,
  options: ExecutorOptions,
  baseModel: string,
): string => {
  const promptCacheKey = get(request.payload, "prompt_cache_key");

  if (
    promptCacheKey !== undefined &&
    promptCacheKey !== null &&
    asString(promptCacheKey).trim() !== ""
  ) {
    return asString(promptCacheKey).trim();
  }

  const derived = providerSessionUuid(XAI_PROVIDER, "derived-session", options.metadata.sessionId);

  if (derived !== "") return derived;

  if (!baseModel.trim().toLowerCase().startsWith(COMPOSER_MODEL_PREFIX)) return "";
  // grok-composer-* needs an isolated conversation id: the Claude Code agent scope, else a random one.
  const scope = claudeCodeExecutionScope(request.payload, options.headers);

  if (baseModel.trim() !== "" && scope !== undefined) {
    return uuidV5Oid(["cli-proxy-api:codex:claude-code", baseModel.trim(), scope].join("\u0000"));
  }

  return crypto.randomUUID();
};

const responseContext = (prepared: PreparedRequest, request: ExecutorRequest): ResponseContext => ({
  model: request.model,
  originalRequest: prepared.original,
  translatedRequest: prepared.body,
  state: makeTranslationState(),
});

const failedTranslation = () =>
  new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });

/** The sanitised gateway error of a failed apply_patch bridge (never carries upstream JSON or patch text). */
const applyPatchGatewayError = () =>
  new ExecutionError({ status: 502, message: APPLY_PATCH_UPSTREAM_ERROR_MESSAGE });

const finalizePrepared = (
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  prepared: PreparedRequest,
): void => {
  prepared.body = makeFinalize(context, request, options)(
    prepared.baseModel,
    prepared.providerFormat,
    prepared.originalTranslated,
    prepared.body,
  );
  const effort = asString(get(prepared.body, "reasoning.effort"));
  context.usage.setReasoningEffort(effort !== "" ? effort : undefined);
  context.usage.setServiceTierFromBody(prepared.body);
};

const mediaFinalize = (
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
): FinalizeBody => {
  const finalize = makeFinalize(context, request, options);

  // Payload rules target the "openai" protocol for images, videos and speech; the baseline is the client body.
  return (model, original, body) => finalize(model, "openai", original, body);
};

const incompleteStreamError = () =>
  new ExecutionError({
    status: 408,
    message:
      "xai stream error: stream disconnected before response.completed or response.incomplete",
  });

export const makeXaiExecutor = (executorOptions: XaiExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;
  const replayStore = executorOptions.replayStore ?? defaultXaiReplayStore;

  /** `prepareResponsesRequestTo`. */
  const prepare = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    mode: { readonly stream: boolean; readonly to: string; readonly websocket?: boolean },
  ) {
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const to = mode.to;
    const original = options.originalRequest ?? request.payload;

    const rewrite = {
      headers: options.headers,
      config: context.config,
      isCompat: modelIsCompat(request),
    };

    const translated = translateRequestForExecutor(
      registry,
      from,
      to,
      { format: from, model: baseModel, stream: mode.stream, body: request.payload },
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

    const originalEnvelope =
      original === request.payload
        ? { body: cloneJson(translated.body) }
        : translateRequestForExecutor(
            registry,
            from,
            to,
            { format: from, model: baseModel, stream: mode.stream, body: original },
            thinking.summary,
            rewrite,
          );

    const originalTranslated = preserveOutputControls(originalEnvelope.body, original, from);
    let body = preserveOutputControls(translated.body, request.payload, from);

    body = yield* thinking.apply({
      body,
      model: request.model,
      from,
      to: XAI_PROVIDER,
      provider: XAI_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });

    body = setIfDifferent(body, "model", baseModel);
    body = setIfDifferent(body, "stream", mode.stream);

    for (const field of [
      "previous_response_id",
      "prompt_cache_retention",
      "safety_identifier",
      "stream_options",
    ]) {
      body = del(body, field);
    }

    body = rewriteCodexMultiAgentV2Input(options.headers, body, context.config);
    const applyPatch = new ApplyPatchResponsesState(from, original, originalTranslated);

    try {
      body = normalizeApplyPatchResponses(body, original);
    } catch (error) {
      return yield* new ExecutionError({
        status: 400,
        message: error instanceof Error ? error.message : String(error),
        requestScoped: true,
      });
    }

    const willInjectXSearch = context.config.upstream.xai["inject-x-search"];

    const shouldFold =
      totalFlattenedToolsCount(body, willInjectXSearch, toolChoiceRequiresHostedToolOnly(body)) >
      XAI_MAX_TOOLS;

    const namespaceTools = collectNamespaceToolRefs(body, shouldFold);

    for (const [name, ref] of namespaceTools)
      if (ref.isDispatcher) applyPatch.addDispatcher(name, ref.namespace);
    // Collected before normalisation flattens the namespace wrappers so keys match the restored response shape.
    const clientDeclaredTools = collectClientDeclaredToolKeys(body);
    body = normalizeTools(body, shouldFold);
    body = promoteAdditionalTools(body);
    let webSearchAlias = "";

    if (hasClientWebSearchFunction(body, namespaceTools)) {
      webSearchAlias = resolveClientWebSearchAlias(body);
      body = aliasClientWebSearchFunction(body, webSearchAlias, namespaceTools);
    }

    // Drop choices that point at tools removed by the normalisation before any x_search injection.
    body = normalizeNamespaceToolChoice(body, shouldFold);
    body = pruneOrphanedToolChoice(body);
    body = normalizeForcedWebSearchToolChoice(body);
    body = normalizeForcedImageGenerationToolChoice(body);
    body = normalizeToolChoiceForTools(body);

    if (willInjectXSearch && !toolChoiceRequiresHostedToolOnly(body))
      body = ensureNativeXSearchTool(body);
    body = clampToolsLimit(body, XAI_MAX_TOOLS, namespaceTools);

    // End-to-end WebSocket requests use the upstream `previous_response_id` state: replaying encrypted reasoning as
    // input as well would duplicate the turn.
    const upstreamState =
      mode.websocket === true &&
      asString(get(request.payload, "previous_response_id")).trim() !== "";

    const replayScope = upstreamState
      ? NO_REPLAY_SCOPE
      : replayScopeFromRequest({
          from,
          model: request.model,
          requestPayload: request.payload,
          body,
          headers: options.headers,
          callerScope: options.metadata.callerScope,
        });

    yield* applyReplayCache(replayStore, replayScope, body);

    body = normalizeInputCustomToolCalls(body);
    body = normalizeInputNamespaceToolCalls(body, shouldFold);

    if (webSearchAlias !== "")
      body = aliasClientWebSearchInput(body, webSearchAlias, namespaceTools);
    body = normalizeInputReasoningItems(body);
    body = sanitizeInputEncryptedContent(body);
    body = normalizeCodexInstructions(body, false);
    // stop is supported by Chat Completions but not by xAI's Responses API.
    body = del(body, "stop");
    body = normalizeImageRefs(body);

    const sessionId = resolveSessionId(request, options, baseModel);

    if (sessionId !== "") body = setIfDifferent(body, "prompt_cache_key", sessionId);

    return {
      body,
      baseModel,
      responseFormat: responseFormatOf(options),
      providerFormat: to,
      original,
      originalTranslated,
      pipeline: new EventPipeline({
        namespaceTools,
        webSearchAlias,
        filterInternalXSearch: requestHasNativeXSearch(body),
        clientDeclaredTools,
      }),
      applyPatch,
      sessionId,
      replayScope,
    } satisfies PreparedRequest;
  });

  const chatHeaders = Effect.fnUntraced(function* (
    context: ExecutionContext,
    options: ExecutorOptions,
    prepared: PreparedRequest,
    stream: boolean,
  ) {
    return buildXaiChatHeaders({
      credential: context.credential,
      clientHeaders: options.headers,
      stream,
      convId: prepared.sessionId,
      ...(options.metadata.sessionId !== undefined
        ? { sessionId: options.metadata.sessionId }
        : {}),
      clientVersion: yield* currentXaiClientVersion,
    });
  });

  /** Opens the upstream `/responses` stream for a prepared chat request. */
  const openResponses = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    ttft: "first-byte" | "token-event" = "first-byte",
  ) {
    const prepared = yield* prepare(context, request, options, { stream: true, to: Formats.Codex });
    finalizePrepared(context, request, options, prepared);
    const headers = yield* chatHeaders(context, options, prepared, true);

    const response = yield* sendUpstream(context, {
      method: "POST",
      url: joinUrl(xaiChatBaseUrl(context.credential), "/responses"),
      headers,
      body: JSON.stringify(prepared.body),
      ttft,
      classify: xaiStatusError,
    });

    return { prepared, response };
  });

  // -------------------------------------------------------------------------------------------------------------
  // Responses: non-stream (aggregates the upstream SSE until the terminal event)
  // -------------------------------------------------------------------------------------------------------------

  const executeResponses = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const { prepared, response } = yield* openResponses(context, request, options);
    const text = yield* response.text.pipe(Effect.mapError(transportError));
    const collector = new OutputItemCollector();

    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const parsed = tryParseJson(line.slice("data:".length).trim());

      if (parsed === undefined) continue;
      const normalized = normalizeReasoningSummaryEvent(parsed);
      prepared.applyPatch.rememberDispatcherEvent(normalized);
      const restored = prepared.pipeline.process(normalized);

      if (restored === undefined) continue;
      const bridged = prepared.applyPatch.transform(restored);

      if (bridged.error !== undefined) return yield* applyPatchGatewayError();

      for (const event of bridged.events) {
        context.usage.observeResponseModel(responseModelOf(event));
        const type = asString(get(event, "type"));

        if (type === "response.output_item.done") {
          collector.collect(event);
          continue;
        }

        if (
          (type !== "response.completed" && type !== "response.incomplete") ||
          !isJsonObject(event)
        )
          continue;
        const completed = normalizeReasoningSummaryEvent(patchCompletedOutput(event, collector));

        if (type === "response.completed")
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

        if (prepared.responseFormat === Formats.OpenAIResponse)
          out = ensureResponsesUsageDetails(out);

        return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
      }
    }

    if (prepared.applyPatch.finish() !== undefined) return yield* applyPatchGatewayError();
    const error = incompleteStreamError();
    context.usage.fail(error.status, error.message);

    return yield* error;
  });

  // -------------------------------------------------------------------------------------------------------------
  // Responses: stream
  // -------------------------------------------------------------------------------------------------------------

  const executeResponsesStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const { prepared, response } = yield* openResponses(context, request, options, "token-event");

    const reader = new XaiStreamReader({
      nowMs: () => Date.now(),
      registry,
      responseFormat: prepared.responseFormat,
      providerFormat: prepared.providerFormat,
      context: responseContext(prepared, request),
      usage: context.usage,
      pipeline: prepared.pipeline,
      applyPatch: prepared.applyPatch,
    });

    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccumEffect(
        () => reader,
        (state, line: string) =>
          Effect.gen(function* () {
            const step = state.push(line);

            if (step.cacheCompleted !== undefined) {
              yield* cacheReplayFromCompleted(
                replayStore,
                prepared.replayScope,
                step.cacheCompleted,
              );
            }

            return [state, [step]] as const;
          }),
        { onHalt: (state) => [state.end()] },
      ),
      Stream.takeUntil((step) => step.error !== undefined),
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
  // Compaction
  // -------------------------------------------------------------------------------------------------------------

  /** `executeCompactRequest`: `POST /responses/compact` on the official API. */
  const compactRequest = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepare(context, request, options, {
      stream: false,
      to: Formats.OpenAIResponse,
    });

    let body = prepared.body;

    for (const field of ["stream", "tools"]) body = del(body, field);
    // Compact deletes tools after preparation, which can leave a forced hosted-tool choice behind.
    body = normalizeToolChoiceForTools(body);

    for (const field of ["max_output_tokens", "temperature", "top_p", "top_k", "stop"])
      body = del(body, field);
    body = removeInputItemsByType(body, "compaction_trigger");
    const previousResponseId = asString(get(request.payload, "previous_response_id")).trim();

    if (previousResponseId !== "") body = set(body, "previous_response_id", previousResponseId);
    prepared.body = body;
    finalizePrepared(context, request, options, prepared);

    // Official API / custom compact endpoints use standard API headers, not the chat proxy identity.
    const headers = buildXaiHeaders({
      credential: context.credential,
      clientHeaders: options.headers,
      stream: false,
      convId: prepared.sessionId,
      ...(options.metadata.sessionId !== undefined
        ? { sessionId: options.metadata.sessionId }
        : {}),
    });

    const response = yield* sendUpstream(context, {
      method: "POST",
      url: joinUrl(xaiCompactBaseUrl(context.credential), "/responses/compact"),
      headers,
      body: JSON.stringify(prepared.body),
      classify: xaiStatusError,
    });

    const text = yield* response.text.pipe(Effect.mapError(transportError));
    context.usage.observeResponseModel(responseModelOf(tryParseJson(text)));
    yield* clearReplayAfterCompaction(replayStore, prepared.replayScope);

    return { prepared, text, headers: new Headers(response.headers) };
  });

  const executeCompact = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const { prepared, text, headers } = yield* compactRequest(context, request, options);
    const usage = parseOpenAIUsage(text);
    // Compact answers pass through the apply_patch bridge as a bare response (`Bridge.TransformNonStream`).
    let bridgedText = text;

    if (prepared.applyPatch.active) {
      const parsed = tryParseJson(text);

      const bridged =
        parsed === undefined ? undefined : prepared.applyPatch.bridge.transformNonStream(parsed);

      if (bridged !== undefined && "error" in bridged) {
        context.usage.publish(usage);

        return yield* applyPatchGatewayError();
      }

      if (bridged !== undefined) bridgedText = JSON.stringify(bridged.body);
    }

    let out = registry.translateNonStream(
      prepared.responseFormat,
      prepared.providerFormat,
      responseContext(prepared, request),
      bridgedText,
    );

    if (out === undefined || out === "") {
      context.usage.publish(usage);

      return yield* failedTranslation();
    }

    context.usage.publish(usage);

    if (prepared.responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out);

    return { payload: out, headers } satisfies ExecutorResponse;
  });

  /** `executeCompactionTriggerStream`: the compact answer replayed as a synthetic Responses stream. */
  const executeCompactionTriggerStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const { prepared, text, headers } = yield* compactRequest(context, request, options);
    context.usage.publish(parseOpenAIUsage(text));
    const nowMs = yield* Clock.currentTimeMillis;

    const chunks = buildCompactionTriggerStreamChunks({
      body: prepared.body,
      baseModel: prepared.baseModel,
      requestModel: asString(get(prepared.original, "model")),
      compact: tryParseJson(text) ?? {},
      nowMs,
    });

    const out = new Headers(headers);
    out.set("content-type", "text/event-stream");

    return { headers: out, chunks: Stream.fromIterable(chunks) } satisfies StreamResult;
  });

  /**
   * `executeCompactionTriggerFromWebsocketContext`: a `compaction_trigger` on a downstream WebSocket whose credential
   * uses the upstream socket compacts the transcript recorded for that socket over HTTP `/responses/compact` and
   * re-emits the compacted state as a synthetic Responses stream. The transcript is replaced by the compacted item.
   */
  const executeCompactionTriggerFromWebsocket = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const sessionId = options.metadata.websocket?.sessionId;
    const state = sessionId === undefined ? undefined : xaiIdStates.get(sessionId);

    if (state === undefined) {
      return yield* new ExecutionError({
        status: 400,
        message: "xai websocket compaction context is unavailable",
        requestScoped: true,
      });
    }

    const mapper = new XaiRequestIdMapper(state, request.payload);
    const transcript = state.snapshotTranscriptInput();

    const withInput = (payload: Json, input: Json[]): Json => {
      const out = isJsonObject(payload) ? cloneJson(payload) : {};

      return del(set(out, "input", input), "previous_response_id");
    };

    let compactPayload: Json;

    if (transcript.length > 0) {
      compactPayload = withInput(request.payload, transcript);
    } else {
      const filtered = removeInputItemsByType(cloneJson(request.payload), "compaction_trigger");
      const input = get(filtered, "input");

      if (Array.isArray(input) && input.length > 0) {
        compactPayload = withInput(filtered, input);
      } else {
        const previous =
          mapper.upstreamPreviousId !== ""
            ? mapper.upstreamPreviousId
            : asString(get(request.payload, "previous_response_id")).trim();

        if (previous === "") {
          return yield* new ExecutionError({
            status: 400,
            message: "xai websocket compaction context is empty",
            requestScoped: true,
          });
        }

        compactPayload = set(
          removeInputItemsByType(cloneJson(request.payload), "compaction_trigger"),
          "previous_response_id",
          previous,
        );
      }
    }

    const { prepared, text, headers } = yield* compactRequest(
      context,
      { ...request, payload: compactPayload },
      options,
    );

    const missing = () =>
      new ExecutionError({
        status: 502,
        message: "xai websocket compaction response is missing compacted state",
      });

    const compact = tryParseJson(text);

    if (compact === undefined) {
      const error = new ExecutionError({
        status: 502,
        message: "xai websocket compaction returned invalid JSON",
      });

      context.usage.fail(error.status, error.message);

      return yield* error;
    }

    const first = get(compact, "output.0");
    const output = get(compact, "output");

    const valid =
      typeof get(compact, "id") === "string" &&
      asString(get(compact, "id")).trim() !== "" &&
      Array.isArray(output) &&
      output.length > 0 &&
      isJsonObject(first) &&
      typeof first["type"] === "string" &&
      first["type"].trim() === "compaction" &&
      typeof first["encrypted_content"] === "string" &&
      first["encrypted_content"].trim() !== "";

    if (!valid) {
      const error = missing();
      context.usage.fail(error.status, error.message);

      return yield* error;
    }

    context.usage.publish(parseOpenAIUsage(text));
    const nowMs = yield* Clock.currentTimeMillis;
    const responseId = compactionResponseId(compact, nowMs);
    state.replaceTranscriptWithItems(compactionOutputItem(compact, responseId));
    state.mapDownstreamToUpstream(responseId, "");

    const chunks = buildCompactionTriggerStreamChunks({
      body: prepared.body,
      baseModel: prepared.baseModel,
      requestModel: asString(get(prepared.original, "model")),
      compact,
      nowMs,
    });

    const out = new Headers(headers);
    out.set("content-type", "text/event-stream");

    return { headers: out, chunks: Stream.fromIterable(chunks) } satisfies StreamResult;
  });

  const websocketStream = makeXaiWebsocketStream({
    prepare,
    finalize: (context, request, options, prepared, body) =>
      makeFinalize(context, request, options)(
        prepared.baseModel,
        prepared.providerFormat,
        prepared.originalTranslated,
        body,
      ),
    replayStore,
    codexTarget: Formats.Codex,
  });

  // -------------------------------------------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------------------------------------------

  const execute: ProviderExecutor["execute"] = (context, request, options) => {
    if (options.alt === "responses/compact") return executeCompact(context, request, options);

    if (isImageRequest(options))
      return executeImages(context, request, options, mediaFinalize(context, request, options));

    if (isVideoRequest(options))
      return executeVideos(context, request, options, mediaFinalize(context, request, options));

    if (isSpeechRequest(options))
      return executeSpeech(context, request, options, mediaFinalize(context, request, options));

    return executeResponses(context, request, options);
  };

  const executeStream: ProviderExecutor["executeStream"] = (context, request, options) => {
    if (options.alt === "responses/compact")
      return Effect.fail(streamingUnsupported("/responses/compact"));

    if (isSpeechRequest(options)) return Effect.fail(streamingUnsupported("/audio/speech"));

    if (isImageRequest(options)) return Effect.fail(streamingUnsupported("/images"));

    if (isVideoRequest(options)) return Effect.fail(streamingUnsupported("/videos"));
    const websocket = options.metadata.websocket;

    if (inputHasItemType(request.payload, "compaction_trigger")) {
      if (websocket?.requireUpstream === true) return Effect.fail(replayRequiredError());

      // XAIAutoExecutor: only a credential that uses the upstream socket compacts the socket's recorded transcript.
      if (websocket !== undefined && codexWebsocketsEnabled(context.credential)) {
        return executeCompactionTriggerFromWebsocket(context, request, options);
      }

      return executeCompactionTriggerStream(context, request, options);
    }

    if (websocket !== undefined) {
      // XAIAutoExecutor: WebSocket only for a downstream WebSocket and a credential that enables it.
      if (codexWebsocketsEnabled(context.credential))
        return websocketStream(context, request, options);

      if (websocket.requireUpstream) return Effect.fail(replayRequiredError());
    }

    return executeResponsesStream(context, request, options);
  };

  /** `CountTokens`: the Responses request as it would be sent upstream, counted locally with `o200k_base`. */
  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepare(context, request, options, {
      stream: false,
      to: Formats.Codex,
    });

    finalizePrepared(context, request, options, prepared);
    const count = countXaiInputTokens(getCodec("o200k_base"), prepared.body);

    return {
      payload: registry.translateTokenCount(
        prepared.responseFormat,
        prepared.providerFormat,
        count,
        buildResponsesUsageJson(count),
      ),
      headers: new Headers(),
    } satisfies ExecutorResponse;
  });

  return { identifier: XAI_PROVIDER, execute, executeStream, countTokens };
};

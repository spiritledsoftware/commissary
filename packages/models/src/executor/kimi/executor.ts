/**
 * Kimi (Moonshot "Kimi Code") executor: OpenAI Chat Completions, OpenAI Responses and Anthropic Messages.
 *
 * Go source: internal/runtime/executor/kimi_executor.go (Execute, ExecuteStream, executeResponses,
 * executeResponsesStream, CountTokens), kimi_thinking_replay.go, helps/kimi_responses.go. Routing by the client's
 * protocol: Claude -> the embedded Claude executor (`executor/claude`, profile with Kimi model naming, Messages base
 * URL, no Claude Code attribution, thinking replay), OpenAI Responses -> `{base}/v1/responses` (body kept as is),
 * everything else -> `{base}/v1/chat/completions`. Order inside the Chat/Responses paths: translate -> upstream
 * model -> thinking -> shaping -> payload rules (final barrier) -> fetch.
 *
 * Multi-agent v2 / orphan delegation rewriting runs in `translateRequestForExecutor`. The `/responses` path bridges the
 * Codex `apply_patch` custom tool through the strict function (`helps/apply-patch-responses.ts`). Responses compaction
 * (`compaction_trigger` and `/responses/compact`) is compacted locally with the route's own Responses turn
 * (`helps/compaction.ts`; Go 344e0ef9, which answers 501 to `/responses/compact`). Not ported: outbound proxies. The
 * token refresh runs in the ControlPlane (credentials/refresh/kimi.ts); 401 recovery is done by the conductor.
 */
import { translateRequestForExecutor } from "../helps/translate.ts";
import { Clock, Effect, Result, Stream } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { splitLines } from "@commissary/translation/sse";
import { asString, cloneJson, get, type Json, set, tryParseJson } from "@commissary/json";
import {
  builtinTranslators,
  makeTranslationState,
  type ResponseContext,
  type TranslatorRegistry,
} from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import {
  parseOpenAIStreamUsage,
  parseOpenAIUsage,
  responseModelOf,
  ssePayloadObject,
  type UsageDetail,
} from "../../usage/record.ts";
import { makeClaudeExecutor } from "../claude/executor.ts";
import type { ThinkingReplayStore } from "../claude/thinking-replay.ts";
import { ensureResponsesUsageDetails, parseCodexUsage } from "../codex/output.ts";
import { setIfDifferent } from "../codex/request.ts";
import { ExecutionError } from "../errors.ts";
import {
  APPLY_PATCH_UPSTREAM_ERROR_MESSAGE,
  ApplyPatchResponsesState,
  normalizeApplyPatchResponses,
} from "../helps/apply-patch-responses.ts";
import {
  dispatchLocalCompaction,
  dispatchLocalCompactionStream,
  expandCompaction,
} from "../helps/compaction.ts";
import { finalizePayload } from "../helps/payload.ts";
import { TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
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
import { kimiHeaders } from "./headers.ts";
import {
  kimiChatUrl,
  kimiClaudeBaseUrl,
  kimiResponsesUrl,
  kimiToken,
  normalizeKimiUpstreamModel,
} from "./model.ts";
import {
  cacheReplay,
  clearReplay,
  makeSessionStateKimiReplayStore,
  prepareKimiReplay,
  shouldClearAfterError,
  wrapReplayStream,
} from "./replay.ts";
import {
  normalizeKimiResponsesInput,
  normalizeKimiTemperature,
  normalizeKimiTools,
  normalizeKimiToolMessageLinks,
} from "./request.ts";

export const KIMI_PROVIDER = "kimi";

export interface KimiExecutorOptions {
  readonly translators?: TranslatorRegistry;
  /** Thinking replay store for Claude-format callers (defaults to the `SessionState` Durable Object, TTL 1 h; per-isolate memory without the binding). */
  readonly replay?: ThinkingReplayStore;
}

const defaultReplay = makeSessionStateKimiReplayStore();

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

interface StepResult {
  readonly chunks: ReadonlyArray<string>;
  readonly error?: ExecutionError;
}

const badGateway = () => new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });

/** `NormalizeApplyPatchResponsesRequest` failures (a non-string history input) are request faults. */
const normalizePatchRequest = (body: Json) =>
  Effect.try({
    try: () => normalizeApplyPatchResponses(body),
    catch: (error) =>
      new ExecutionError({
        status: 400,
        message: error instanceof Error ? error.message : String(error),
        requestScoped: true,
      }),
  });

const usageOf = (text: string): UsageDetail | undefined => {
  const parsed = tryParseJson(text);
  const codex = parseCodexUsage(parsed);

  if (codex !== undefined && (codex.totalTokens > 0 || codex.inputTokens > 0)) return codex;
  const openai = parseOpenAIUsage(text);

  return openai.totalTokens > 0 || openai.inputTokens > 0 ? openai : undefined;
};

export const makeKimiExecutor = (executorOptions: KimiExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;
  const replayStore = executorOptions.replay ?? defaultReplay;

  const claude = makeClaudeExecutor({
    translators: registry,
    profile: {
      normalizeModel: normalizeKimiUpstreamModel,
      stripDefaultAttribution: true,
      upstreamCountTokens: true,
    },
  });

  /** The credential the embedded Claude executor sees: the Messages base (`ResolveKimiClaudeBaseURL`). */
  const claudeContext = (context: ExecutionContext): ExecutionContext => ({
    ...context,
    credential: {
      ...context.credential,
      attributes: {
        ...context.credential.attributes,
        base_url: kimiClaudeBaseUrl(context.credential),
      },
    },
  });

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

  const requestedModel = (request: ExecutorRequest, options: ExecutorOptions): string =>
    options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model;

  // -------------------------------------------------------------------------------------------------------------
  // Chat Completions
  // -------------------------------------------------------------------------------------------------------------

  const prepareChat = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean,
  ) {
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const to = Formats.OpenAI;

    const translate = (payload: Json) =>
      translateRequestForExecutor(
        registry,
        from,
        to,
        { format: from, model: baseModel, stream, body: payload },
        thinking.summary,
        { headers: options.headers, config: context.config },
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
      options.originalRequest === undefined || options.originalRequest === request.payload
        ? cloneJson(translated.body)
        : translate(options.originalRequest).body;

    let body = set(translated.body, "model", normalizeKimiUpstreamModel(baseModel));
    body = yield* thinking.apply({
      body,
      model: request.model,
      from,
      to: KIMI_PROVIDER,
      provider: KIMI_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });

    if (stream) body = set(body, "stream_options.include_usage", true);
    body = normalizeKimiToolMessageLinks(body);
    body = normalizeKimiTools(body);
    body = normalizeKimiTemperature(body);

    const effort =
      asString(get(body, "reasoning_effort")) || asString(get(body, "thinking.effort"));

    context.usage.setReasoningEffort(effort !== "" ? effort : undefined);
    const translatedForResponse = cloneJson(body);
    body = finalizePayload(
      context.config,
      KIMI_PROVIDER,
      {
        model: baseModel,
        requestedModel: requestedModel(request, options),
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original,
      },
      body,
    );

    return { url: kimiChatUrl(context.credential), body, translated: translatedForResponse, to };
  });

  /** POSTs `body`; non-2xx answers carry the upstream body (Go `statusErr`). */
  const post = Effect.fnUntraced(function* (
    context: ExecutionContext,
    url: string,
    body: Json,
    options: ExecutorOptions,
    stream: boolean,
  ) {
    const client = yield* HttpClient.HttpClient;

    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
      HttpClientRequest.setHeaders(
        kimiHeaders(
          context.credential,
          kimiToken(context.credential),
          stream,
          options.headers,
          options.metadata.sessionId,
        ),
      ),
    );

    const response = yield* client
      .execute(httpRequest)
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(transportError),
      );

    context.usage.markFirstByte(yield* Clock.currentTimeMillis);

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      context.usage.fail(response.status, text);

      return yield* new ExecutionError({ status: response.status, message: text });
    }

    return response;
  });

  const executeChat = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepareChat(context, request, options, false);
    const response = yield* post(context, prepared.url, prepared.body, options, false);
    const data = yield* response.text.pipe(Effect.mapError(transportError));
    context.usage.observeResponseModel(responseModelOf(tryParseJson(data)));
    const responseFormat = responseFormatOf(options);

    let out = registry.translateNonStream(
      responseFormat,
      prepared.to,
      responseContext(request, options, prepared.translated),
      data,
    );

    if (out === undefined || out === "") return yield* badGateway();
    context.usage.publish(parseOpenAIUsage(data));

    if (responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out);

    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  const executeChatStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepareChat(context, request, options, true);
    const response = yield* post(context, prepared.url, prepared.body, options, true);
    const responseFormat = responseFormatOf(options);
    const state = responseContext(request, options, prepared.translated);

    const translate = (line: string): Stream.Stream<string, ExecutionError> => {
      const chunks = registry.translateStream(responseFormat, prepared.to, state, line);
      const emitted = Stream.fromIterable(chunks);

      return state.state.toolInputError === undefined
        ? emitted
        : Stream.concat(emitted, Stream.fail(badGateway()));
    };

    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.tap((line) =>
        Effect.sync(() => {
          const usage = parseOpenAIStreamUsage(line);

          if (usage !== undefined) context.usage.publish(usage);
          context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)));
        }),
      ),
      Stream.flatMap(translate),
      Stream.concat(Stream.suspend(() => translate("data: [DONE]"))),
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  // -------------------------------------------------------------------------------------------------------------
  // Responses (client protocol openai-response)
  // -------------------------------------------------------------------------------------------------------------

  const prepareResponses = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean,
  ) {
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    let body = cloneJson(request.payload);
    body = set(body, "model", normalizeKimiUpstreamModel(baseModel));
    body = setIfDifferent(body, "stream", stream);
    body = yield* thinking.apply({
      body,
      model: request.model,
      from: options.sourceFormat,
      to: Formats.Codex,
      provider: KIMI_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });
    body = yield* normalizePatchRequest(body);
    body = normalizeKimiResponsesInput(body);
    body = normalizeKimiTools(body);
    body = normalizeKimiTemperature(body);

    const effort =
      asString(get(body, "reasoning.effort")) || asString(get(body, "thinking.effort"));

    context.usage.setReasoningEffort(effort !== "" ? effort : undefined);
    const translated = cloneJson(body);
    body = finalizePayload(
      context.config,
      KIMI_PROVIDER,
      {
        model: baseModel,
        requestedModel: requestedModel(request, options),
        protocol: Formats.OpenAIResponse,
        fromProtocol: options.sourceFormat,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: request.payload,
      },
      body,
    );

    return { url: kimiResponsesUrl(context.credential), body, translated };
  });

  /** One Responses exchange with Kimi, without any compaction handling: what the summary turn of a local compaction runs. */
  const executeResponsesTurn = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepareResponses(context, request, options, false);
    const response = yield* post(context, prepared.url, prepared.body, options, false);
    const data = yield* response.text.pipe(Effect.mapError(transportError));
    context.usage.observeResponseModel(responseModelOf(tryParseJson(data)));
    const responseFormat = responseFormatOf(options);
    // The bridge is built from the client's declarations (`NewApplyPatchResponsesState(source, original, original)`).
    const original = options.originalRequest ?? request.payload;
    const bridge = new ApplyPatchResponsesState(options.sourceFormat, original, original);
    let out = data;

    if (bridge.active) {
      const parsed = tryParseJson(data);
      const bridged = parsed === undefined ? undefined : bridge.bridge.transformNonStream(parsed);

      if (bridged === undefined || "error" in bridged) {
        return yield* new ExecutionError({
          status: 502,
          message: APPLY_PATCH_UPSTREAM_ERROR_MESSAGE,
        });
      }

      out = JSON.stringify(bridged.body);
    }

    if (responseFormat !== Formats.OpenAIResponse) {
      const translated = registry.translateNonStream(
        responseFormat,
        Formats.OpenAIResponse,
        responseContext(request, options, prepared.translated),
        out,
      );

      if (translated === undefined || translated === "") return yield* badGateway();
      out = translated;
    }

    const usage = usageOf(data);

    if (usage !== undefined) context.usage.publish(usage);

    if (responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out);

    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  const executeResponsesStreamTurn = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const prepared = yield* prepareResponses(context, request, options, true);
    const response = yield* post(context, prepared.url, prepared.body, options, true);
    const responseFormat = responseFormatOf(options);
    const state = responseContext(request, options, prepared.translated);
    const original = options.originalRequest ?? request.payload;
    const bridge = new ApplyPatchResponsesState(options.sourceFormat, original, original);
    let stopped = false;

    /** `emitTranslatedLine`: Responses clients get the line as is, others the translated chunks. */
    const emit = (line: string): StepResult => {
      if (responseFormat === Formats.OpenAIResponse) return { chunks: [`${line}\n`] };

      const chunks = [
        ...registry.translateStream(responseFormat, Formats.OpenAIResponse, state, line),
      ];

      return state.state.toolInputError === undefined
        ? { chunks }
        : { chunks, error: badGateway() };
    };

    const lines = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapEffect((line) =>
        Effect.sync((): StepResult => {
          if (stopped) return { chunks: [] };
          context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)));

          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            const type = asString(get(tryParseJson(payload), "type"));

            if (
              type === "response.completed" ||
              type === "response.incomplete" ||
              type === "response.done"
            ) {
              const usage = usageOf(payload);

              if (usage !== undefined) context.usage.publish(usage);
            }
          }

          const bridged = bridge.stream(line);
          const chunks: string[] = [];

          for (const converted of bridged.lines) {
            const step = emit(converted);
            chunks.push(...step.chunks);

            if (step.error !== undefined) return { chunks, error: step.error };
          }

          return bridged.error === undefined ? { chunks } : { chunks, error: badGateway() };
        }),
      ),
      Stream.tap((step) =>
        Effect.sync(() => {
          if (step.error !== undefined) stopped = true;
        }),
      ),
    );

    // `FinishStream`: EOF without a validated completion emits the local failure once.
    const tail = Stream.suspend(() => {
      if (stopped) return Stream.empty;
      const finished = bridge.finishStream();
      const chunks = finished.lines.flatMap((line) => emit(line).chunks);
      const emitted = Stream.fromIterable(chunks);

      return finished.error === undefined
        ? emitted
        : Stream.concat(emitted, Stream.fail(badGateway()));
    });

    const chunks = Stream.concat(
      lines.pipe(
        Stream.takeUntil((step) => step.error !== undefined),
        Stream.flatMap((step) => {
          const emitted = Stream.fromIterable(step.chunks);

          return step.error === undefined
            ? emitted
            : Stream.concat(emitted, Stream.fail(step.error));
        }),
      ),
      tail,
    ).pipe(
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  // -------------------------------------------------------------------------------------------------------------
  // Responses compaction (Go 344e0ef9)
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Capsules a local compaction minted become context and foreign `compaction` items are dropped. A
   * `compaction_trigger` or `/responses/compact` is compacted locally with Kimi's own Responses turn (Go answers 501 to
   * `/responses/compact`; here a route that compacts locally does so on both entry points).
   */
  const compactionRoute = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => ({
    request,
    options,
    turn: (turnRequest: ExecutorRequest, turnOptions: ExecutorOptions) =>
      executeResponsesTurn(context, turnRequest, turnOptions),
    streamTurn: (turnRequest: ExecutorRequest, turnOptions: ExecutorOptions) =>
      executeResponsesStreamTurn(context, turnRequest, turnOptions),
    summaryTurn: (summaryRequest: ExecutorRequest, summaryOptions: ExecutorOptions) =>
      executeResponsesTurn(context, summaryRequest, summaryOptions),
  });

  const executeResponses = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => dispatchLocalCompaction(compactionRoute(context, request, options));

  const executeResponsesStream = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => dispatchLocalCompactionStream(compactionRoute(context, request, options));

  // -------------------------------------------------------------------------------------------------------------
  // Claude Messages (embedded Claude executor)
  // -------------------------------------------------------------------------------------------------------------

  const executeClaude = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const replay = yield* prepareKimiReplay(replayStore, request, options);

    const result = yield* Effect.result(
      claude.execute(claudeContext(context), replay.request, options),
    );

    if (Result.isFailure(result)) {
      if (replay.scope.replayApplied && shouldClearAfterError(result.failure))
        yield* clearReplay(replayStore, replay.scope);

      return yield* result.failure;
    }

    const content = get(tryParseJson(result.success.payload), "content");

    if (Array.isArray(content)) yield* cacheReplay(replayStore, replay.scope, content);

    return result.success;
  });

  const executeClaudeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const replay = yield* prepareKimiReplay(replayStore, request, options);

    const result = yield* Effect.result(
      claude.executeStream(claudeContext(context), replay.request, options),
    );

    if (Result.isFailure(result)) {
      if (replay.scope.replayApplied && shouldClearAfterError(result.failure))
        yield* clearReplay(replayStore, replay.scope);

      return yield* result.failure;
    }

    return {
      headers: result.success.headers,
      chunks: wrapReplayStream(result.success.chunks, replayStore, replay.scope),
    } satisfies StreamResult;
  });

  // -------------------------------------------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------------------------------------------

  const execute: ProviderExecutor["execute"] = (context, request, options) => {
    if (options.sourceFormat === Formats.Claude) return executeClaude(context, request, options);

    if (options.sourceFormat === Formats.OpenAIResponse)
      return executeResponses(context, request, options);

    return executeChat(context, request, options);
  };

  const executeStream: ProviderExecutor["executeStream"] = (context, request, options) => {
    if (options.sourceFormat === Formats.Claude)
      return executeClaudeStream(context, request, options);

    if (options.sourceFormat === Formats.OpenAIResponse)
      return executeResponsesStream(context, request, options);

    return executeChatStream(context, request, options);
  };

  /** Anthropic `count_tokens` through the embedded Claude executor with the Messages base URL. */
  const countTokens: ProviderExecutor["countTokens"] = Effect.fnUntraced(
    function* (context, request, options) {
      // `CountTokens`: Responses payloads become context (capsules expanded, foreign compaction items dropped; the Claude
      // executor's own count does not expand) and go through the apply_patch contract first.
      if (options.sourceFormat !== Formats.OpenAIResponse)
        return yield* claude.countTokens(claudeContext(context), request, options);

      const expanded = yield* expandCompaction(request, options, "drop-foreign");

      const counted = {
        ...expanded.request,
        payload: yield* normalizePatchRequest(expanded.request.payload),
      };

      return yield* claude.countTokens(claudeContext(context), counted, expanded.options);
    },
  );

  return { identifier: KIMI_PROVIDER, execute, executeStream, countTokens };
};

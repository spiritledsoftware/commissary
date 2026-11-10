/**
 * Claude (Anthropic Messages) provider executor: OAuth tokens and provider keys, Messages and count_tokens.
 *
 * Go source: internal/runtime/executor/claude_executor.go, claude_executor_execute.go, claude_executor_stream.go,
 * claude_executor_tokens.go, claude_executor_fast_error.go. The request is built by `pipeline.ts`; this module does
 * the HTTP exchange, error classification and response translation.
 *
 * Not ported (documented in docs/ARCHITECTURE.md): the uTLS/header-order fingerprint (impossible with
 * Workers `fetch`, see README.md) and per-credential proxies. Thread continuation alias state
 * (`thread.ts`), the device-profile stabiliser (`device-profile.ts`) and `rebuild-mid-system-message`
 * (`mid-system.ts`) run inside the pipeline. Responses compaction (`responses/compact` and `compaction_trigger`) runs a
 * summary request through this executor and seals the answer into a capsule (`compaction.ts`).
 */
import { Clock, Effect, Exit, Stream } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  asInt,
  asString,
  get,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { splitLines } from "@commissary/translation/sse";
import {
  builtinTranslators,
  makeTranslationState,
  type ResponseContext,
  type TranslatorRegistry,
  isObj,
  str,
} from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import { responseModelOf } from "../../usage/record.ts";
import { ExecutionError, headersRecord } from "../errors.ts";
import {
  type ExecutionContext,
  type ExecutorOptions,
  type ExecutorRequest,
  type ExecutorResponse,
  type ProviderExecutor,
  responseFormatOf,
  type StreamResult,
} from "../types.ts";
import { claudeCreds, isAnthropicUpstreamBase } from "./credentials.ts";
import {
  buildCompactionResponse,
  buildCompactionStreamChunks,
  extractSummaryText,
  sealCompaction,
} from "../helps/compaction.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { extractTranslatedReasoningEffort, parseSuffix } from "@commissary/translation/thinking";
import {
  claudeCompactionRequested,
  claudeCompactionSourcePayload,
  claudeCompactionUsage,
  expandClaudeResponsesCompaction,
  patchClaudeCompactionStreamUsage,
  prepareClaudeCompactionSummaryPayload,
} from "./compaction.ts";
import { type ContinuityStore, makeSessionStateContinuityStore } from "./continuity.ts";
import { type DeviceProfileStore, makeSessionStateDeviceProfileStore } from "./device-profile.ts";
import { type ToolAliasStore, makeSessionStateToolAliasStore } from "./thread.ts";
import { type ClaudeUpstreamProfile, restoreResponseModel } from "./profile.ts";
import {
  restoreToolNamesInResponse,
  AliasRestoreError,
  restoreToolNamesInStreamLine,
} from "./mcp-alias.ts";
import {
  type PipelineServices,
  prepareCountTokensRequest,
  prepareLocalCountBody,
  prepareMessagesRequest,
  type PreparedClaudeRequest,
} from "./pipeline.ts";
import {
  classifyUpstreamError,
  headersIndicateUnifiedRejection,
  parseRateLimitResetMs,
} from "./ratelimit.ts";
import {
  ClaudeStreamReader,
  TOOL_INPUT_ERROR_MESSAGE,
  validateClaudeStreamingResponse,
} from "./stream.ts";
import {
  makeSessionStateReplayStore,
  replayContentIsReplayable,
  replayScopeValid,
  type ThinkingReplayStore,
} from "./thinking-replay.ts";
import { mergeUsage, parseClaudeStreamUsage, parseClaudeUsage } from "./usage.ts";
import type { UsageDetail } from "../../usage/record.ts";
import { countClaudeInputTokens } from "@commissary/translation/tokenizer";

const defaultContinuity = makeSessionStateContinuityStore();

const defaultReplay = makeSessionStateReplayStore();

const defaultDeviceProfiles = makeSessionStateDeviceProfileStore();

const defaultToolAliases = makeSessionStateToolAliasStore();

export interface ClaudeExecutorOptions {
  readonly translators?: TranslatorRegistry;
  readonly continuity?: ContinuityStore;
  readonly replay?: ThinkingReplayStore;
  readonly deviceProfiles?: DeviceProfileStore;
  readonly toolAliases?: ToolAliasStore;
  /** Injected clock for date reminders (tests). */
  readonly now?: () => Date;
  /** Delegating provider profile (Kimi embeds this executor with its own model naming). */
  readonly profile?: ClaudeUpstreamProfile;
}

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

const readError = (cause: unknown) =>
  new ExecutionError({
    status: 502,
    message: `claude executor: failed to read upstream response: ${String(cause)}`,
  });

const gatewayError = (message: string) => new ExecutionError({ status: 502, message });

const responseContext = (
  request: ExecutorRequest,
  options: ExecutorOptions,
  prepared: { readonly translatedRequest: JsonObject },
): ResponseContext => ({
  model: request.model,
  originalRequest: options.originalRequest ?? request.payload,
  translatedRequest: prepared.translatedRequest,
  state: makeTranslationState(),
});

/** Copies an error with changed flags (`ExecutionError` fields such as `message` are not enumerable). */
const copyError = (
  error: ExecutionError,
  patch: { credentialScoped?: boolean; requestScoped?: boolean },
): ExecutionError =>
  new ExecutionError({
    status: error.status,
    message: error.message,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(error.credentialScoped !== undefined ? { credentialScoped: error.credentialScoped } : {}),
    ...(error.requestScoped !== undefined ? { requestScoped: error.requestScoped } : {}),
    ...(error.terminalAuth !== undefined ? { terminalAuth: error.terminalAuth } : {}),
    ...(error.direct !== undefined ? { direct: error.direct } : {}),
    ...(error.headers !== undefined ? { headers: error.headers } : {}),
    ...(error.safeHeaders !== undefined ? { safeHeaders: error.safeHeaders } : {}),
    ...patch,
  });

/** The upstream non-2xx answer as an `ExecutionError` (Fast mode answers pass through unchanged). */
const upstreamFailure = (
  context: ExecutionContext,
  fastRequest: boolean,
  status: number,
  headers: Headers,
  body: string,
  now: number,
): ExecutionError => {
  const modelLevelCooling = context.config.upstream.claude["model-level-cooling"];
  const classified = classifyUpstreamError(status, headers, body, modelLevelCooling, now);

  if (fastRequest) {
    const direct = new Headers(headers);
    direct.delete("content-encoding");
    direct.delete("content-length");
    const credentialScoped = status === 429 && headersIndicateUnifiedRejection(headers);
    const retryAfterMs = status === 429 ? parseRateLimitResetMs(headers, now) : undefined;

    return new ExecutionError({
      status,
      message: body,
      direct: true,
      headers: headersRecord(direct),
      requestScoped: !credentialScoped,
      ...(credentialScoped ? { credentialScoped: true } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  // A rejected token (401) concerns the credential, not the request: the conductor refreshes or rotates it.
  if (status === 401 && classified.credentialScoped === undefined) {
    return copyError(classified, { credentialScoped: true });
  }

  return classified;
};

export const makeClaudeExecutor = (
  executorOptions: ClaudeExecutorOptions = {},
): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;

  const services: PipelineServices = {
    registry,
    continuity: executorOptions.continuity ?? defaultContinuity,
    replay: executorOptions.replay ?? defaultReplay,
    deviceProfiles: executorOptions.deviceProfiles ?? defaultDeviceProfiles,
    toolAliases: executorOptions.toolAliases ?? defaultToolAliases,
    now: executorOptions.now ?? (() => new Date()),
    profile: executorOptions.profile,
  };

  const profile = executorOptions.profile;

  /** Sends a prepared request; non-2xx answers become classified `ExecutionError`s. */
  const send = Effect.fnUntraced(function* (
    context: ExecutionContext,
    prepared: {
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly bodyText: string;
    },
    fastRequest: boolean,
  ) {
    const client = yield* HttpClient.HttpClient;

    const httpRequest = HttpClientRequest.post(prepared.url).pipe(
      HttpClientRequest.bodyText(prepared.bodyText, "application/json"),
      HttpClientRequest.setHeaders(prepared.headers),
    );

    const response: HttpClientResponse.HttpClientResponse = yield* client
      .execute(httpRequest)
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(transportError),
      );

    context.usage.markFirstByte(yield* Clock.currentTimeMillis);

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((value) => value),
      );

      const headers = new Headers(response.headers);
      context.usage.fail(response.status, text);

      return yield* upstreamFailure(
        context,
        fastRequest,
        response.status,
        headers,
        text,
        yield* Clock.currentTimeMillis,
      );
    }

    return response;
  });

  const finishReplay = (
    prepared: PreparedClaudeRequest,
    content: Json | undefined,
  ): Effect.Effect<void> => {
    const scope = prepared.replay;

    if (!replayScopeValid(scope) || !scope.cacheReady) return Effect.void;

    return (
      content !== undefined && replayContentIsReplayable(content)
        ? services.replay.replaceIfUnchanged(
            scope.modelFamily,
            scope.sessionKey,
            scope.snapshot,
            content,
          )
        : services.replay.deleteIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot)
    ).pipe(Effect.asVoid);
  };

  /** `commitClaudeContinuity` + `rememberClaudeOAuthToolAliases`: what a completed response records. */
  const commitContinuity = (
    prepared: PreparedClaudeRequest,
    messageId: string,
    requestId: string,
    callerScope: string,
  ): Effect.Effect<void> =>
    Effect.all([
      prepared.continuity !== undefined && messageId !== ""
        ? services.continuity.commit(prepared.continuity, messageId, requestId, prepared.promptId)
        : Effect.void,
      prepared.threadAliasKeys === undefined
        ? Effect.void
        : services.toolAliases.save(
            callerScope,
            prepared.threadAliasKeys(messageId),
            prepared.reverseMap,
          ),
    ]).pipe(Effect.asVoid);

  /** The usage record's `reasoning_effort`, read from the final body: the last effort directive wins (fb30a9e8). */
  const recordReasoningEffort = (context: ExecutionContext, body: Json): void => {
    const effort = extractTranslatedReasoningEffort(body, "claude");
    context.usage.setReasoningEffort(effort !== "" ? effort : undefined);
  };

  const executeMessages = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    compactionSummary: boolean,
  ) {
    const responseFormat = responseFormatOf(options);
    const upstreamStream = responseFormat !== Formats.Claude;

    const prepared = yield* prepareMessagesRequest({
      services,
      config: context.config,
      credential: context.credential,
      request,
      options,
      upstreamStream,
      compactionSummary,
    });

    recordReasoningEffort(context, prepared.body);

    const response = yield* send(context, prepared, prepared.fastRequest);
    let data = yield* response.text.pipe(Effect.mapError(readError));
    const requestId = response.headers["request-id"] ?? "";
    let usage: UsageDetail | undefined;
    let replayContent: Json | undefined;

    if (upstreamStream) {
      const invalid = validateClaudeStreamingResponse(data);

      if (invalid !== undefined) return yield* gatewayError(invalid);

      const reader = new ClaudeStreamReader({
        registry,
        responseFormat: Formats.Claude,
        context: responseContext(request, options, prepared),
        reverseMap: prepared.reverseMap,
        onUsage: (detail) => {
          usage = detail;
        },
        onResponseModel: (model) => context.usage.observeResponseModel(model),
      });

      const lines = data.split("\n");

      const restored = yield* Effect.try({
        try: () =>
          lines.map((line) => {
            reader.accumulator.observe(line);
            const parsed = parseClaudeStreamUsage(line);

            if (parsed !== undefined) usage = mergeUsage(usage, parsed);
            context.usage.observeResponseModel(
              responseModelOf(
                tryParseJson(line.trim().startsWith("data:") ? line.trim().slice(5).trim() : ""),
              ),
            );

            return restoreResponseModel(
              profile,
              restoreToolNamesInStreamLine(line, prepared.reverseMap),
              request.model,
            );
          }),
        catch: (error) =>
          error instanceof AliasRestoreError
            ? new ExecutionError({
                status: 500,
                message: `restore Claude OAuth tool name from streaming response: ${error.message}`,
                requestScoped: true,
              })
            : readError(error),
      });

      data = restored.join("\n");

      const message = lines
        .map((line) =>
          tryParseJson(line.trim().startsWith("data:") ? line.trim().slice(5).trim() : ""),
        )
        .find((payload) => str(get(payload, "type")) === "message_start");

      yield* commitContinuity(
        prepared,
        str(get(message, "message.id")).trim(),
        requestId,
        options.metadata.callerScope,
      );
      replayContent = reader.accumulator.content();
    } else {
      const parsed = tryParseJson(data);
      context.usage.observeResponseModel(responseModelOf(parsed));
      yield* commitContinuity(
        prepared,
        str(get(parsed, "id")).trim(),
        requestId,
        options.metadata.callerScope,
      );

      if (prepared.reverseMap.size > 0 && isObj(parsed)) {
        yield* Effect.try({
          try: () => restoreToolNamesInResponse(parsed, prepared.reverseMap),
          catch: (error) =>
            new ExecutionError({
              status: 500,
              message: `restore Claude OAuth tool name from response: ${error instanceof Error ? error.message : String(error)}`,
              requestScoped: true,
            }),
        });
        data = JSON.stringify(parsed);
      }

      data = restoreResponseModel(profile, data, request.model);
      usage = parseClaudeUsage(data);
      replayContent = get(parsed, "content");
    }

    yield* finishReplay(prepared, replayContent);

    let out = registry.translateNonStream(
      responseFormat,
      Formats.Claude,
      responseContext(request, options, prepared),
      data,
    );

    if (out === undefined || out === "") return yield* gatewayError(TOOL_INPUT_ERROR_MESSAGE);

    if (usage !== undefined) context.usage.publish(usage);

    if (responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out);

    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  /** `expandClaudeResponsesCompaction`: an unreadable capsule is a request-scoped 400. */
  const expandCompaction = (request: ExecutorRequest, options: ExecutorOptions) =>
    Effect.tryPromise({
      try: () => expandClaudeResponsesCompaction(request, options),
      catch: (error) =>
        new ExecutionError({
          status: 400,
          message: error instanceof Error ? error.message : String(error),
          requestScoped: true,
        }),
    });

  /**
   * `executeClaudeCompaction`: a non-stream summary turn through the normal Messages path (tool history kept or
   * flattened, `compactionSummary`), sealed into a capsule and returned as a `response.compaction` body.
   */
  const executeCompaction = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const baseModel = parseSuffix(request.model).modelName;

    const summaryRequest: ExecutorRequest = {
      ...request,
      payload: prepareClaudeCompactionSummaryPayload(
        claudeCompactionSourcePayload(request, options),
      ),
    };

    const summaryOptions: ExecutorOptions = {
      ...options,
      alt: "",
      stream: false,
      originalRequest: undefined,
      sourceFormat: Formats.OpenAIResponse,
      responseFormat: Formats.Claude,
    };

    const summary = yield* executeMessages(context, summaryRequest, summaryOptions, true);
    const parsed = tryParseJson(summary.payload);

    const text = yield* Effect.try({
      try: () => extractSummaryText(parsed ?? null),
      catch: (error) =>
        new ExecutionError({
          status: 500,
          message: `extract summary: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    const capsule = yield* Effect.tryPromise({
      try: () => sealCompaction(text, baseModel),
      catch: (error) =>
        new ExecutionError({ status: 500, message: `seal compaction capsule: ${String(error)}` }),
    });

    const usage = claudeCompactionUsage(parsed, summary.payload);

    const body = buildCompactionResponse(
      baseModel,
      capsule,
      usage.input,
      usage.output,
      usage.total,
      Date.now(),
    );

    set(body, "usage.input_tokens_details.cached_tokens", usage.cached);

    return { payload: JSON.stringify(body), headers: summary.headers } satisfies ExecutorResponse;
  });

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const expanded = yield* expandCompaction(request, options);

    if (claudeCompactionRequested(expanded.request, expanded.options)) {
      return yield* executeCompaction(context, expanded.request, expanded.options);
    }

    return yield* executeMessages(context, expanded.request, expanded.options, false);
  });

  /** `executeClaudeCompactionStream`: the sealed capsule and usage re-emitted as a synthetic Responses stream. */
  const executeCompactionStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const baseModel = parseSuffix(request.model).modelName;
    const summary = yield* executeCompaction(context, request, options);
    const parsed = tryParseJson(summary.payload);
    const capsule = asString(get(parsed, "output.0.encrypted_content"));

    if (asString(get(parsed, "output.0.type")) !== "compaction" || capsule === "") {
      return yield* new ExecutionError({
        status: 500,
        message: "extract summary: compaction item missing",
      });
    }

    const usage = {
      input: asInt(get(parsed, "usage.input_tokens")),
      output: asInt(get(parsed, "usage.output_tokens")),
      total: asInt(get(parsed, "usage.total_tokens")),
      cached: asInt(get(parsed, "usage.input_tokens_details.cached_tokens")),
    };

    const chunks = buildCompactionStreamChunks(
      baseModel,
      capsule,
      usage.input,
      usage.output,
      usage.total,
      Date.now(),
    ).map((chunk) => patchClaudeCompactionStreamUsage(chunk, usage));

    const headers = new Headers(summary.headers);
    headers.set("Content-Type", "text/event-stream");

    return { headers, chunks: Stream.fromIterable(chunks) } satisfies StreamResult;
  });

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const expanded = yield* expandCompaction(request, options);

    if (claudeCompactionRequested(expanded.request, expanded.options)) {
      return yield* executeCompactionStream(context, expanded.request, expanded.options);
    }

    return yield* executeMessagesStream(context, expanded.request, expanded.options);
  });

  const executeMessagesStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const responseFormat = responseFormatOf(options);

    const prepared = yield* prepareMessagesRequest({
      services,
      config: context.config,
      credential: context.credential,
      request,
      options,
      upstreamStream: true,
    });

    recordReasoningEffort(context, prepared.body);

    const response = yield* send(context, prepared, prepared.fastRequest);
    const requestId = response.headers["request-id"] ?? "";

    const reader = new ClaudeStreamReader({
      registry,
      responseFormat,
      context: responseContext(request, options, prepared),
      reverseMap: prepared.reverseMap,
      restoreLine: (line) => restoreResponseModel(profile, line, request.model),
      onUsage: (detail) => context.usage.publish(detail),
      onResponseModel: (model) => context.usage.observeResponseModel(model),
    });

    const wrap = (error: ExecutionError): ExecutionError =>
      prepared.fastRequest && !error.direct
        ? copyError(error, { requestScoped: error.credentialScoped !== true })
        : error;

    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccum(
        () => reader,
        (state, line: string) => [state, [state.push(line)]] as const,
        { onHalt: (state) => [state.end()] },
      ),
      Stream.takeUntil((step) => step.stop),
      Stream.flatMap((step) => {
        const emitted = Stream.fromIterable(step.chunks);

        if (step.error === undefined) return emitted;
        const error = wrap(step.error);
        context.usage.fail(error.status, error.message);

        return Stream.concat(emitted, Stream.fail(error));
      }),
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
      Stream.onExit((exit) =>
        Exit.isSuccess(exit) && reader.completed
          ? Effect.andThen(
              commitContinuity(prepared, reader.messageId, requestId, options.metadata.callerScope),
              finishReplay(prepared, reader.accumulator.content()),
            )
          : finishReplay(prepared, undefined),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const responseFormat = responseFormatOf(options);
    const { providerKey, baseURL } = claudeCreds(context.credential);

    const input = {
      services,
      config: context.config,
      credential: context.credential,
      request,
      options,
      upstreamStream: false,
    };

    if (
      providerKey.trim() !== "" &&
      (profile?.upstreamCountTokens === true ||
        isAnthropicUpstreamBase(baseURL === "" ? "https://api.anthropic.com" : baseURL))
    ) {
      const prepared = yield* prepareCountTokensRequest(input);
      const response = yield* send(context, prepared, false);
      const data = yield* response.text.pipe(Effect.mapError(readError));
      const count = asInt(get(tryParseJson(data), "input_tokens"));
      const out = registry.translateTokenCount(responseFormat, Formats.Claude, count, data);

      return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
    }

    const body = yield* prepareLocalCountBody(input);
    const count = countClaudeInputTokens(body);

    const out = registry.translateTokenCount(
      responseFormat,
      Formats.Claude,
      count,
      JSON.stringify({ input_tokens: count }),
    );

    return { payload: out, headers: new Headers() } satisfies ExecutorResponse;
  });

  return { identifier: "claude", execute, executeStream, countTokens };
};
